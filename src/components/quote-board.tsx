// src/components/quote-board.tsx — selected symbol mega display

import { useRef, type ReactNode } from 'react';
import { useBoardTier } from '../hooks/use-board-tier';
import { useDisplayBook } from '../hooks/use-display-book';
import { useQuery } from '../hooks/use-query';
import { isRichTier } from '../lib/board-tier';
import type { ContractInfo } from '../lib/types/contract';
import { amountProgress, breadthOf, breadthTitle, type Breadth } from '../lib/index-breadth';
import {
    PREVIOUS_AMOUNT_RETRY_MS,
    isTransientError,
    PREVIOUS_SESSION_LOOKBACK_DAYS,
    previousSessionAmount,
    retryAfter,
    sessionDateOf,
    shiftDate,
    volumeChangeOf,
} from '../lib/index-volume';
import { limitStateOf } from '../lib/limit-state';
import { fetchKbars } from '../lib/shioaji';
import type { Snapshot } from '../lib/types/market';
import { todayStr } from '../lib/utils/date';
import { fmtCompactInt, fmtInt, fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
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
function BreadthBar({ className, breadth }: { className: string; breadth: Breadth }) {
    return (
        <span className={className} title={breadthTitle(breadth)}>
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
    const { quote, snapshot, book } = useDisplayBook(contract.code, suppliedSnapshot, contract);
    const tick = quote?.tick;
    const index = quote?.index;
    const isIndex = contract.security_type === 'IND';
    // 指數看板依面板大小自動降級（標題列加看板不超過面板高度 1/5），非指數不啟用

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
    const amount = index?.amount_sum
        ? Number(index.amount_sum)
        : snapshot?.total_amount;
    // 預估全日成交金額（元）：盤中由 quote_idx 帶出；缺值、空字串、0 都視為沒有，畫面顯示空值符號
    const estimateRaw = Number(index?.estimate_amount_sum);
    const estimate = estimateRaw > 0 ? estimateRaw : undefined;
    // 前一交易日全日成交金額：只有指數才抓，同一商品同一交易日整個連線期間只抓一次（失敗會再重試，見 index-volume）。
    // 基準日用報價所屬交易日（不是電腦時鐘）：跨午夜或整個週末開著時，才不會變成同一天自己比自己
    // shortcut: 往回看 PREVIOUS_SESSION_LOOKBACK_DAYS（21）天，超過就不顯示比較，要補再放寬
    const session = sessionDateOf(index?.date, todayStr());
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
        isIndex,
    ).data;
    const volumeChange = volumeChangeOf(estimate, previous);
    const progress = amountProgress(amount, estimate);
    // 成交金額、已成交比例、前一交易日、更新時間：版面收起這些格子時，改放在滑過提示裡
    const volumeTitle = [
        estimate === undefined ? undefined : `預估全日 ${fmtCompactInt(estimate)}`,
        `成交金額 ${fmtCompactInt(amount)}`,
        progress === undefined ? undefined : `已成交預估的 ${(progress * 100).toFixed(0)}%`,
        // 沒有預估量時看板不會出現較昨日，這時成交金額可能就是前一交易日的快照，不列「前一交易日」免得同一個數字出現兩次
        previous === undefined || estimate === undefined ? undefined : `前一交易日 ${fmtCompactInt(previous)}`,
        index?.time ? `更新 ${index.time.slice(0, 8)}` : undefined,
    ]
        .filter(Boolean)
        .join('\n');
    const breadth = breadthOf(index?.raise_count, index?.flat_count, index?.fall_count);
    const boardRef = useRef<HTMLDivElement>(null);
    // 指數現價固定兩位小數：尾數 0 被省略時寬度會差一個字，造成階梯來回切換
    const priceText = fmtPrice(close, isIndex ? 2 : undefined);
    const contentKey = [
        priceText,
        fmtSigned(chg),
        fmtPct(pct),
        fmtCompactInt(amount),
        fmtCompactInt(estimate),
        volumeChange?.text,
        breadth.up,
        breadth.flat,
        breadth.down,
        index?.limit_up_count,
        index?.limit_down_count,
    ]
        .map((v) => String(v ?? '').length)
        .join(',');
    const { tier, toggle } = useBoardTier(boardRef, isIndex, contentKey);
    const richBoard = isRichTier(tier);
    const bid1 = book?.bids[0];
    const ask1 = book?.asks[0];

    const dir =
        chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    // 共用判斷（指數、興櫃不亮；跳動價位精度比較）
    const atLimit = limitStateOf(contract, close);

    return (
        <div
            ref={boardRef}
            className={`${styles.board}${isIndex ? ` ${styles.boardIndex}` : ''} drag-handle`}
        >
            {/* 指數的代號與名稱面板標題列已經有，看板不重複 */}
            {!isIndex && (
                <div className={styles.symbolBlock}>
                    <span className={styles.symbolCode}>{contract.code}</span>
                    <span className={styles.symbolName}>{contract.name}</span>
                </div>
            )}

            <span className={styles.bigPrice[dir]}>{priceText}</span>
            {atLimit && (
                <span className={styles.limitBadge[atLimit]}>
                    {atLimit === 'up' ? '漲停' : '跌停'}
                </span>
            )}

            <div className={`${styles.changeBlock} ${panel.dirText[dir]}`}>
                <span>{fmtSigned(chg)}</span>
                <span>{fmtPct(pct)}</span>
            </div>

            {isIndex ? (
                <>
                    {(volumeChange || amount !== undefined) && (
                        <span className={styles.leadTag} title={volumeTitle}>
                            {volumeChange ? volumeChange.text : <Compact value={amount} />}
                        </span>
                    )}
                    {breadth.total > 0 && <BreadthBar className={styles.breadthMini} breadth={breadth} />}
                    <div className={styles.indexStats}>
                        <div className={styles.indexGroup.breadth} title={breadthTitle(breadth) || undefined}>
                            <Stat
                                label="漲停"
                                className={styles.secondary}
                                valueClass={styles.limitCount[(index?.limit_up_count ?? 0) > 0 ? 'up' : 'zero']}
                            >
                                {fmtInt(index?.limit_up_count)}
                            </Stat>
                            <Stat
                                label="上漲"
                                valueClass={
                                    index?.raise_count === undefined
                                        ? styles.statValue
                                        : `${styles.statValue} ${panel.dirText.up}`
                                }
                            >
                                {fmtInt(index?.raise_count)}
                            </Stat>
                            <Stat label="平盤" valueClass={styles.statValue} className={styles.secondary}>
                                {fmtInt(index?.flat_count)}
                            </Stat>
                            <Stat
                                label="下跌"
                                valueClass={
                                    index?.fall_count === undefined
                                        ? styles.statValue
                                        : `${styles.statValue} ${panel.dirText.down}`
                                }
                            >
                                {fmtInt(index?.fall_count)}
                            </Stat>
                            <Stat
                                label="跌停"
                                className={styles.secondary}
                                valueClass={styles.limitCount[(index?.limit_down_count ?? 0) > 0 ? 'down' : 'zero']}
                            >
                                {fmtInt(index?.limit_down_count)}
                            </Stat>
                            {breadth.total > 0 && <BreadthBar className={styles.breadthBar} breadth={breadth} />}
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
                                label="預估量"
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
                                {volumeChange?.text ?? '—'}
                            </Stat>
                            <Stat label="時間" valueClass={styles.statValue} className={styles.lowPriority}>
                                {index?.time?.slice(0, 8) ?? '—'}
                            </Stat>
                        </div>
                    </div>
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
                </>
            ) : (
                <div className={styles.statGrid}>
                    <>
                        <span className={styles.statLabel}>開</span>
                        <span className={styles.statLabel}>高</span>
                        <span className={styles.statLabel}>低</span>
                        <span className={styles.statLabel}>量</span>
                        <span className={styles.statValue}>{fmtPrice(open)}</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(high)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(low)}
                        </span>
                        <span className={styles.statValue}>{fmtInt(vol)}</span>
                        <span className={styles.statLabel}>參考</span>
                        <span className={styles.statLabel}>漲停</span>
                        <span className={styles.statLabel}>跌停</span>
                        <span className={styles.statLabel}>時間</span>
                        <span className={styles.statValue}>{fmtPrice(ref)}</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(contract.limit_up)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(contract.limit_down)}
                        </span>
                        <span className={styles.statValue}>
                            {tick?.time?.slice(0, 8) ?? '—'}
                        </span>
                        <span className={styles.statLabel} title={book?.time}>委買{book?.source === 'snapshot' && '（快照）'}</span>
                        <span className={styles.statLabel}>買量</span>
                        <span className={styles.statLabel}>委賣</span>
                        <span className={styles.statLabel}>賣量</span>
                        <span className={`${styles.statValue} ${panel.dirText.up}`}>
                            {fmtPrice(bid1?.price)}
                        </span>
                        <span className={styles.statValue}>
                            {fmtInt(bid1?.vol)}
                        </span>
                        <span className={`${styles.statValue} ${panel.dirText.down}`}>
                            {fmtPrice(ask1?.price)}
                        </span>
                        <span className={styles.statValue}>
                            {fmtInt(ask1?.vol)}
                        </span>
                    </>
                </div>
            )}
        </div>
    );
}
