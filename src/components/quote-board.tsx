// src/components/quote-board.tsx — selected symbol mega display

import { useMemo, useRef, type ReactNode } from 'react';
import { useBoardTier } from '../hooks/use-board-tier';
import { useDisplayBook } from '../hooks/use-display-book';
import { useQuery } from '../hooks/use-query';
import { BOARD_TIERS, isRichTier, RAIL_TIERS, STOCK_TIERS } from '../lib/board-tier';
import { dayRangeOf, dirVsOpen, INDEX_FUTURE_SCALES, STOCK_SCALES } from '../lib/day-range';
import type { ContractInfo } from '../lib/types/contract';
import { amountProgress, breadthOf, breadthTitle, type Breadth } from '../lib/index-breadth';
import {
    PREVIOUS_AMOUNT_RETRY_MS,
    isTransientError,
    PREVIOUS_SESSION_LOOKBACK_DAYS,
    fullDayAmount,
    previousSessionAmount,
    retryAfter,
    sessionDateOf,
    shiftDate,
    tradingDate,
    volumeChangeOf,
} from '../lib/index-volume';
import { recalledIndexClose } from '../lib/index-close-quote';
import { hasPriceLimits, limitStateOf } from '../lib/limit-state';
import { getMarketSnapshot } from '../lib/market-snapshot-store';
import { focusSector } from '../lib/sector-sync';
import { fetchKbars, fetchSnapshots } from '../lib/shioaji';
import { SECTOR_LABELS } from '../lib/stock-index';
import {
    fmtVolumeRatio,
    RATIO_SNAPSHOT_RETRY_MS,
    ratioSnapshotStale,
    volumeRatioOf,
    volumeRatioTitle,
} from '../lib/volume-ratio';
import type { Snapshot } from '../lib/types/market';
import { todayStr } from '../lib/utils/date';
import { fmtCompactInt, fmtInt, fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import { tickDecimals, tickSizeFor } from '../lib/utils/ticksize';
import { DayRangeRail } from './day-range-rail';
import * as panel from './panel.css';
import * as styles from './quote-board.css';

// fmtCompactInt 的結果（如 5668.1億）拆成數字與單位，單位縮小淡化
function Compact({ value }: { value: number | undefined }) {
    const text = fmtCompactInt(value);
    const m = /^(.*?)([萬億])$/.exec(text);
    return m ? (
        <>
            {m[1]}
            <span className={styles.unit}>{m[2]}</span>
        </>
    ) : (
        <>{text}</>
    );
}

// 指數統計區的一格：標籤在上、數值在下，同一條置中軸
function Stat({
    label,
    title,
    valueClass,
    className,
    children,
}: {
    label: string;
    title?: string;
    valueClass: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={[styles.stat, title && styles.tipCell, className].filter(Boolean).join(' ')}
            title={title}
        >
            <span className={title ? `${styles.statLabel} ${styles.tipLabel}` : styles.statLabel}>
                {label}
            </span>
            <span className={valueClass}>{children}</span>
        </div>
    );
}

// 上漲／平盤／下跌家數比例條（統計區與窄面板底邊共用）
function BreadthBar({ className, breadth, title }: { className: string; breadth: Breadth; title: string | undefined }) {
    return (
        <span className={className} title={title}>
            {(['up', 'flat', 'down'] as const).map(
                (k) =>
                    breadth[k] > 0 && (
                        <span
                            key={k}
                            className={styles.breadthSeg[k]}
                            style={{ flexGrow: breadth[k] }}
                        />
                    ),
            )}
        </span>
    );
}

export function QuoteBoard({
    contract,
    snapshot: suppliedSnapshot,
}: {
    contract: ContractInfo;
    snapshot?: Snapshot;
}) {
    const { quote, snapshot } = useDisplayBook(contract.code, suppliedSnapshot, contract);
    const tick = quote?.tick;
    const index = quote?.index;
    const isIndex = contract.security_type === 'IND';
    // 沒有即時報價時（收盤後重新整理、重開），家數與時間改用本機留下的收盤那筆；價格與金額仍看快照
    const recalled = useMemo(
        () => (isIndex && !index ? recalledIndexClose(contract.code, snapshot?.datetime) : undefined),
        [isIndex, index, contract.code, snapshot?.datetime],
    );
    const counts = index ?? recalled;
    // 指數與個股看板都依面板大小自動降級（標題列加看板不超過面板高度 1/5）

    const close = tick
        ? Number(tick.close)
        : index
          ? Number(index.close)
          : snapshot?.close;
    const ref = index ? Number(index.reference) : contract.reference;
    const chg = tick?.price_chg
        ? Number(tick.price_chg)
        : index
          ? Number(index.close) - Number(index.reference)
        : snapshot?.change_price;
    // NEVER use tick.pct_chg — its unit differs between stk (％×100) and
    // fop (％) streams; derive from the price change and reference instead
    const pct =
        chg !== undefined && ref
            ? (chg / ref) * 100
            : snapshot?.change_rate;
    const open = tick
        ? Number(tick.open)
        : index
          ? Number(index.open)
          : snapshot?.open;
    const high = tick
        ? Number(tick.high)
        : index
          ? Number(index.high)
          : snapshot?.high;
    const low = tick
        ? Number(tick.low)
        : index
          ? Number(index.low)
          : snapshot?.low;
    const vol =
        tick?.total_volume ??
        index?.vol_sum ??
        index?.volume ??
        snapshot?.total_volume;
    // 指數看板看成交金額（元，換算成億）；amount_sum 為空字串時退回快照
    const liveAmount = index?.amount_sum ? Number(index.amount_sum) : undefined;
    const amount = liveAmount ?? snapshot?.total_amount;
    // 比較的基準交易日：有即時報價看報價日期，沒有時跟著快照日期（收盤後、半夜、週末重開也比得出較昨日），
    // 都沒有才退回電腦日期。不看電腦時鐘：跨午夜或整個週末開著時，才不會變成同一天自己比自己
    const session = sessionDateOf(index?.date ?? snapshot?.datetime, todayStr());
    // 預估全日成交金額（元）：盤中由 quote_idx 帶出；缺值、空字串、0 都視為沒有，畫面顯示空值符號
    // 收盤後沒有預估量時改用實際全日金額（標「實際量」），較昨日才有值。
    // 收盤判斷跟著金額的來源走：即時金額看 quote_idx 的時間；退回快照金額時看快照的日期與時間，
    // 免得收盤那筆沒帶金額時，把開頁當下的舊快照金額當成全日實際量
    const { value: estimate, actual } = fullDayAmount(
        Number(index?.estimate_amount_sum),
        amount,
        index && liveAmount !== undefined
            ? { date: index.date, time: index.time }
            : { date: snapshot?.datetime, time: snapshot?.datetime?.slice(11) },
        session,
    );
    // 前一交易日全日成交金額：只有指數才抓，同一商品同一交易日整個連線期間只抓一次（失敗會再重試，見 index-volume）。
    // 報價或快照到了才抓，免得先用電腦日期抓一次、快照到了換基準日又抓一次
    // shortcut: 往回看 PREVIOUS_SESSION_LOOKBACK_DAYS（21）天，超過就不顯示比較，要補再放寬
    const previous = useQuery(
        () =>
            retryAfter(
                () =>
                    fetchKbars(
                        contract,
                        shiftDate(session, -PREVIOUS_SESSION_LOOKBACK_DAYS),
                        shiftDate(session, -1),
                    ),
                PREVIOUS_AMOUNT_RETRY_MS,
                undefined,
                isTransientError,
            ).then((k) => previousSessionAmount(k, session)),
        `index-prev-amount:${contract.code}:${session}`,
        isIndex && (index !== undefined || snapshot !== undefined),
    ).data;
    const volumeChange = volumeChangeOf(estimate, previous);
    // 實際量時已成交就是 100%，不再列進度
    const progress = actual ? undefined : amountProgress(amount, estimate);
    // 成交金額、已成交比例、前一交易日、更新時間：版面收起這些格子時，改放在滑過提示裡
    const volumeTitle = [
        estimate === undefined ? undefined : `${actual ? '全日實際' : '預估全日'} ${fmtCompactInt(estimate)}`,
        // 實際量時上一行的全日實際就是成交金額，不重複列
        actual ? undefined : `成交金額 ${fmtCompactInt(amount)}`,
        progress === undefined ? undefined : `已成交預估的 ${(progress * 100).toFixed(0)}%`,
        // estimate 為 undefined（盤前、盤中沒有預估量）時看板不會出現較昨日，這時成交金額可能就是前一交易日的快照，
        // 不列「前一交易日」免得同一個數字出現兩次
        previous === undefined || estimate === undefined ? undefined : `前一交易日 ${fmtCompactInt(previous)}`,
        // 讀回時這個時間只屬於家數，價格與金額來自快照
        counts?.time ? `${recalled ? '家數' : ''}更新 ${counts.time.slice(0, 8)}` : undefined,
    ]
        .filter(Boolean)
        .join('\n');
    const breadth = breadthOf(counts?.raise_count, counts?.flat_count, counts?.fall_count);
    // 家數組與比例條共用：讀回收盤那筆時註明哪天收盤時存下（窄階梯只剩比例條，沒有時間格可看）
    const breadthGroupTitle = recalled
        ? [breadthTitle(breadth), `收盤時存下的家數（${tradingDate(recalled.date)} ${recalled.time.slice(0, 8)}）`].filter(Boolean).join('\n')
        : breadthTitle(breadth) || undefined;
    const boardRef = useRef<HTMLDivElement>(null);
    // 價格固定小數位：尾數 0 被省略時寬度會差一到三個字，造成階梯來回切換。
    // 指數固定兩位；其他商品 500 以上依跳動級距（電子期 0.05 → 2,345.10），500 以下沿用原本的兩位
    const boardPrice = (v: number | string | undefined) => {
        const n = Number(v);
        if (isIndex) return fmtPrice(v, 2);
        return fmtPrice(v, Number.isFinite(n) && Math.abs(n) >= 500 ? tickDecimals(tickSizeFor(contract, n)) : undefined);
    };
    const priceText = boardPrice(close);
    // 量比：今日累計成交量（即時）÷ 昨日全日成交量（快照），算法放在滑過提示。
    // 只給個股（含 ETF）：期貨、選擇權夜盤開始後今日量只算夜盤，拿去比昨日全日量會失真
    const showRatio = contract.security_type === 'STK';
    // 快照裡的昨日成交量不會自己更新：跨日開著、週末後盤前才開 App 時快照還是上一個交易日的，
    // 即時成交的日期和快照對不上就不算量比（寧可留空也不除到錯的那一天），並在當天第一筆真成交後重抓快照。
    // 不在試撮時抓：盤前伺服器可能還回前一天的快照，太早抓會把當天唯一一次機會用掉。
    // 抓完以 store 裡的快照為準：回來的還是上一個交易日（伺服器還沒翻日）就當失敗，退避後再抓
    const ratioStale = showRatio && ratioSnapshotStale(tick?.date, snapshot?.datetime);
    useQuery(
        () =>
            retryAfter(
                async () => {
                    await fetchSnapshots([contract]);
                    if (ratioSnapshotStale(tick?.date, getMarketSnapshot(contract)?.datetime)) {
                        throw new Error('snapshot not rolled');
                    }
                },
                RATIO_SNAPSHOT_RETRY_MS,
                undefined,
                isTransientError,
            ),
        `ratio-snapshot:${contract.code}:${tradingDate(tick?.date)}`,
        ratioStale && !!tick && !tick.simtrade && Number(tick.volume) > 0,
    );
    const volumeRatio = ratioStale ? undefined : volumeRatioOf(vol, snapshot?.yesterday_volume);
    const ratioTitle = volumeRatioTitle(vol, snapshot?.yesterday_volume, ratioStale);
    // 共用判斷（指數、興櫃不亮；跳動價位精度比較）；徽章會占寬度，列入 contentKey
    const atLimit = limitStateOf(contract, close);
    // 日內區間軌：有漲跌停、開高低收都到齊才畫（rail、railMid、railLow 三級取代右側數字），否則照原本的數字欄。
    // 選擇權不畫：跌停墊在最小跳動、漲停是權利金加標的 10%，兩側差數十倍，+50% 會畫得比 -5% 還小
    const range =
        isIndex || contract.security_type === 'OPT' || !hasPriceLimits(contract)
            ? undefined
            : dayRangeOf({
                  reference: ref,
                  limitUp: Number(contract.limit_up),
                  limitDown: Number(contract.limit_down),
                  open,
                  high,
                  low,
                  close,
              });
    // 指數期（台指期等）：尺從 ±2.5% 起跳，數字列兩端放距低、距高點數；個股期照個股
    const isIndexFuture = contract.security_type === 'FUT' && contract.underlying_kind === 'I';
    const fmtPoints = (v: number) => fmtPrice(v, tickDecimals(tickSizeFor(contract, close ?? v)));
    // 高、低跟開盤價比上色（使用者指定）：軌道數字列和數字欄同一套，縮窄切換時顏色不會變
    const vsOpen = (v: number | undefined) => {
        const d = dirVsOpen(v, open);
        return d ? `${styles.pairValue} ${panel.dirText[d]}` : styles.pairValue;
    };
    // 產業分類只有上市櫃個股有；「其他」與查不到的不顯示
    const sectorName =
        contract.security_type === 'STK' && contract.category
            ? SECTOR_LABELS[contract.category.padStart(2, '0')]
            : undefined;
    const sector = sectorName === '其他' ? undefined : sectorName;
    const contentKey = [
        priceText,
        fmtSigned(chg),
        fmtPct(pct),
        fmtCompactInt(amount),
        fmtCompactInt(estimate),
        volumeChange,
        breadth.up,
        breadth.flat,
        breadth.down,
        counts?.limit_up_count,
        counts?.limit_down_count,
        boardPrice(high),
        boardPrice(low),
        boardPrice(open),
        fmtInt(vol),
        fmtVolumeRatio(volumeRatio),
        atLimit,
        sector,
        range && isIndexFuture ? fmtPoints(range.close - range.low) : undefined,
        range && isIndexFuture ? fmtPoints(range.high - range.close) : undefined,
    ]
        .map((v) => String(v ?? '').length)
        .join(',');
    // 指數與個股各自記收合偏好
    const { tier, toggle } = useBoardTier(
        boardRef,
        true,
        contentKey,
        isIndex ? 'sj-index-board-mode' : 'sj-stock-board-mode',
        isIndex ? BOARD_TIERS : range ? RAIL_TIERS : STOCK_TIERS,
    );
    const richBoard = isRichTier(tier);
    // 參考價、更新時間收進漲跌與現價的滑過提示
    const timeText = (isIndex ? index?.time : tick?.time)?.slice(0, 8);

    const dir =
        chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';

    return (
        <div
            ref={boardRef}
            className={`${styles.board} ${styles.boardTiered} ${isIndex ? styles.boardIndex : styles.boardStock} drag-handle`}
        >
            {/* 代號與名稱面板標題列已經有，看板不重複 */}
            <span
                className={timeText ? `${styles.bigPrice[dir]} ${styles.tipCell}` : styles.bigPrice[dir]}
                title={timeText ? `更新 ${timeText}` : undefined}
            >
                {priceText}
            </span>
            {atLimit && (
                <span className={styles.limitBadge[atLimit]}>
                    {atLimit === 'up' ? '漲停' : '跌停'}
                </span>
            )}

            <div
                className={
                    ref ? `${styles.changeBlock} ${panel.dirText[dir]} ${styles.tipCell}` : `${styles.changeBlock} ${panel.dirText[dir]}`
                }
                title={ref ? `參考 ${boardPrice(ref)}` : undefined}
            >
                <span>{fmtSigned(chg)}</span>
                <span className={ref ? styles.tipLabel : undefined}>{fmtPct(pct)}</span>
            </div>

            {isIndex ? (
                <>
                    {(volumeChange || amount !== undefined) && (
                        <span className={styles.leadTag} title={volumeTitle}>
                            {/* 沒有「較昨日」標籤可依靠，加「量」字和價格漲跌幅區分 */}
                            {volumeChange ? `量${volumeChange}` : <Compact value={amount} />}
                        </span>
                    )}
                    {breadth.total > 0 && <BreadthBar className={styles.breadthMini} breadth={breadth} title={breadthGroupTitle} />}
                    <div className={styles.indexStats}>
                        <div className={styles.indexGroup.breadth} title={breadthGroupTitle}>
                            <Stat
                                label="漲停"
                                className={styles.secondary}
                                valueClass={styles.limitCount[(counts?.limit_up_count ?? 0) > 0 ? 'up' : 'zero']}
                            >
                                {fmtInt(counts?.limit_up_count)}
                            </Stat>
                            <Stat
                                label="上漲"
                                valueClass={
                                    counts?.raise_count === undefined
                                        ? styles.statValue
                                        : `${styles.statValue} ${panel.dirText.up}`
                                }
                            >
                                {fmtInt(counts?.raise_count)}
                            </Stat>
                            <Stat label="平盤" valueClass={styles.statValue} className={styles.secondary}>
                                {fmtInt(counts?.flat_count)}
                            </Stat>
                            <Stat
                                label="下跌"
                                valueClass={
                                    counts?.fall_count === undefined
                                        ? styles.statValue
                                        : `${styles.statValue} ${panel.dirText.down}`
                                }
                            >
                                {fmtInt(counts?.fall_count)}
                            </Stat>
                            <Stat
                                label="跌停"
                                className={styles.secondary}
                                valueClass={styles.limitCount[(counts?.limit_down_count ?? 0) > 0 ? 'down' : 'zero']}
                            >
                                {fmtInt(counts?.limit_down_count)}
                            </Stat>
                            {breadth.total > 0 && <BreadthBar className={styles.breadthBar} breadth={breadth} title={breadthGroupTitle} />}
                        </div>
                        <div className={styles.indexGroup.volume}>
                            <Stat
                                label="成交金額"
                                title={progress === undefined ? undefined : `已成交預估的 ${(progress * 100).toFixed(0)}%`}
                                valueClass={styles.statValue}
                                className={estimate === undefined ? undefined : styles.lowPriority}
                            >
                                <Compact value={amount} />
                            </Stat>
                            <Stat
                                label={actual ? '實際量' : '預估量'}
                                title={volumeTitle}
                                valueClass={styles.statValue}
                                // lean 要留下一格量能：有較昨日時留較昨日（預估量收起），沒有時改留預估量
                                className={
                                    estimate === undefined
                                        ? styles.lowPriority
                                        : volumeChange
                                          ? styles.secondary
                                          : undefined
                                }
                            >
                                <Compact value={estimate} />
                            </Stat>
                            <Stat
                                label="較昨日"
                                title={volumeTitle}
                                valueClass={styles.statValue}
                                className={volumeChange ? undefined : styles.lowPriority}
                            >
                                {volumeChange ?? '—'}
                            </Stat>
                            <Stat label="時間" valueClass={styles.statValue} className={styles.lowPriority}>
                                {counts?.time?.slice(0, 8) ?? '—'}
                            </Stat>
                        </div>
                    </div>
                </>
            ) : (
                <>
                    {/* 軌道在 rail、railMid、railLow 顯示、產業分類只在 rail 顯示（CSS 依 data-tier 切換）；
                        平常也留在畫面上，階梯量測時才量得到它們需要的寬度 */}
                    {range && (
                        <DayRangeRail
                            className={styles.railSlot}
                            range={range}
                            fmt={boardPrice}
                            fmtPoints={fmtPoints}
                            scales={isIndexFuture ? INDEX_FUTURE_SCALES : STOCK_SCALES}
                            edges={isIndexFuture ? 'distance' : 'limits'}
                            locked={atLimit}
                            touched={{
                                up: limitStateOf(contract, high) === 'up',
                                down: limitStateOf(contract, low) === 'down',
                            }}
                        />
                    )}
                    {/* 和排行榜的產業標籤一樣：點了讓產業全景下鑽到這個產業（按鈕不會觸發面板拖曳） */}
                    {range && sector && contract.category && (
                        <button
                            type="button"
                            className={styles.sectorTag}
                            title="跳到此類股熱力圖"
                            onClick={() => focusSector(contract.category!)}
                        >
                            {sector}
                        </button>
                    )}
                    {vol !== undefined && (
                        <span
                            className={showRatio ? `${styles.stockVolTag} ${styles.tipCell}` : styles.stockVolTag}
                            title={showRatio ? ratioTitle : undefined}
                        >
                            量 {fmtInt(vol)}
                            {showRatio && (
                                <span className={styles.stockVolTagRatio}>量比 {fmtVolumeRatio(volumeRatio)}</span>
                            )}
                        </span>
                    )}
                    <div className={styles.stockStats}>
                        <div className={styles.pairGroup}>
                            <span className={styles.pairLabel}>高</span>
                            <span className={vsOpen(high)}>{boardPrice(high)}</span>
                            <span className={styles.pairLabel}>低</span>
                            <span className={vsOpen(low)}>{boardPrice(low)}</span>
                        </div>
                        <div className={styles.volGroup}>
                            <span className={`${styles.pairLabel} ${styles.stockOpen}`}>開</span>
                            <span className={`${styles.pairValue} ${styles.stockOpen}`}>{boardPrice(open)}</span>
                            <span className={`${styles.pairLabel} ${styles.stockVol}`}>量</span>
                            <span className={`${styles.pairValue} ${styles.stockVol}`}>{fmtInt(vol)}</span>
                            {showRatio && (
                                <>
                                    <span
                                        className={`${styles.pairLabel} ${styles.stockRatio} ${styles.tipLabel} ${styles.tipCell}`}
                                        title={ratioTitle}
                                    >
                                        量比
                                    </span>
                                    <span
                                        className={`${styles.pairValue} ${styles.stockRatio} ${styles.tipCell}`}
                                        title={ratioTitle}
                                    >
                                        {fmtVolumeRatio(volumeRatio)}
                                    </span>
                                </>
                            )}
                        </div>
                        {/* 興櫃、權證、組合商品等沒有有效漲跌停的商品不顯示停板組 */}
                        {hasPriceLimits(contract) && (
                            <div className={`${styles.pairGroup} ${styles.stockLimit}`}>
                                <span className={styles.pairLabel}>漲停</span>
                                <span className={`${styles.pairValue} ${panel.dirText.up}`}>
                                    {boardPrice(contract.limit_up)}
                                </span>
                                <span className={styles.pairLabel}>跌停</span>
                                <span className={`${styles.pairValue} ${panel.dirText.down}`}>
                                    {boardPrice(contract.limit_down)}
                                </span>
                            </div>
                        )}
                    </div>
                </>
            )}
            <button
                type="button"
                className={styles.boardToggle}
                onClick={toggle}
                aria-expanded={richBoard}
                aria-label={richBoard ? '收合統計' : '展開統計'}
                title={richBoard ? '收合統計' : '展開統計'}
            >
                <svg viewBox="0 0 10 10" width="12" height="12" aria-hidden="true">
                    <polyline
                        points="2,4 5,7 8,4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>
        </div>
    );
}
