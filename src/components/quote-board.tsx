// src/components/quote-board.tsx — selected symbol mega display

import { Fragment, useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';
import { useBoardTier } from '../hooks/use-board-tier';
import { useSnapshotBaseline } from '../hooks/use-display-book';
import { useQuote } from '../hooks/use-stream';
import { useQuery } from '../hooks/use-query';
import { BOARD_TIERS, isRichTier, RAIL_TIERS, STOCK_TIERS } from '../lib/board-tier';
import {
    dayRangeOf,
    dirVsOpen,
    INDEX_FUTURE_SCALES,
    nightSessionOhl,
    nightWindowOf,
    STOCK_SCALES,
    withNightSession,
    withNightVolume,
} from '../lib/day-range';
import {
    CLOSE_GRACE,
    findKbarGap,
    sessionWindowFor,
    supportsSessionSplit,
    type ChartSessionMode,
} from '../lib/intraday-session';
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
import { nowWallClockUtc, wallClockToUtc } from '../lib/utils/kbars';
import { tickDecimals, tickSizeFor } from '../lib/utils/ticksize';
import {
    compactQuoteBoardFields,
    isShown,
    normalizeQuoteBoardFields,
    visibleFields,
    type IndexField,
    type QuoteBoardFields,
    type QuoteBoardFieldsConfig,
    type StockField,
} from '../lib/quote-board-fields';
import { DayRangeRail } from './day-range-rail';

// 兩個累計量取較大的（同一段夜盤的兩份資料，量只會往上加）；只有一邊有值時用那一邊
const maxDefined = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);
import { QuoteBoardSettings, type SettingsAnchor } from './quote-board-settings';
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

// 牆鐘秒換成 kbars 查詢用的日期（YYYY-MM-DD）
const wallDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export function QuoteBoard({
    contract,
    snapshot: suppliedSnapshot,
    sessionMode,
    fields: fieldsConfig,
    onFieldsChange,
}: {
    contract: ContractInfo;
    snapshot?: Snapshot;
    // 同一區塊 K 線的「全盤／僅日盤」，缺省跟 K 線一樣是全盤
    sessionMode?: ChartSessionMode;
    // 自訂欄位（面板設定，跟版面一起存）；沒有 onFieldsChange 時（彈出視窗）只在本視窗生效
    fields?: QuoteBoardFieldsConfig;
    onFieldsChange?: (next: QuoteBoardFieldsConfig | undefined) => void;
}) {
    const [localFields, setLocalFields] = useState(fieldsConfig);
    const savedFields = onFieldsChange ? fieldsConfig : localFields;
    const fields = useMemo(() => normalizeQuoteBoardFields(savedFields), [savedFields]);
    const setFields = useCallback(
        (next: QuoteBoardFields) => {
            const compact = compactQuoteBoardFields(next);
            if (onFieldsChange) onFieldsChange(compact);
            else setLocalFields(compact);
        },
        [onFieldsChange],
    );
    const [settingsAt, setSettingsAt] = useState<SettingsAnchor | null>(null);
    const closeSettings = useCallback(() => setSettingsAt(null), []);
    const quote = useQuote(contract.code, { narrow: true });
    const { snapshot } = useSnapshotBaseline(contract.code, suppliedSnapshot, contract);
    const tick = quote?.tick;
    const index = quote?.index;
    const isIndex = contract.security_type === 'IND';
    const showI = (f: IndexField) => isShown(fields.index, f);
    const showS = (f: StockField) => isShown(fields.stock, f);
    // 沒有即時報價時（收盤後重新整理、重開），家數與時間改用本機留下的收盤那筆；價格與金額仍看快照
    const recalled = useMemo(
        () => (isIndex && !index ? recalledIndexClose(contract.code, snapshot?.datetime) : undefined),
        [isIndex, index, contract.code, snapshot?.datetime],
    );
    const counts = index ?? recalled;
    // 指數沒有成交，看有沒有即時 quote_idx：沒有時現價來自快照（家數可能是讀回的收盤那筆），一樣標快照
    const snapOnly = isIndex ? !index && !!snapshot : !tick && !!snapshot;
    // 指數與個股看板都依面板大小自動降級（標題列加看板不超過面板高度 1/5）

    const close = tick
        ? Number(tick.close)
        : index
          ? Number(index.close)
          : snapshot?.close;
    // 參考價跟著報價自己推（現價減漲跌）：盤前開 App 或 App 跨夜開著時，合約已換成新交易日的參考價與漲跌停，
    // 快照或即時成交卻還是前一天的，拿新的參考價算漲跌幅、畫區間軌會對不上
    const derivedRef = tick
        ? tick.price_chg ? Number(tick.close) - Number(tick.price_chg) : NaN
        : snapshot ? snapshot.close - snapshot.change_price : NaN;
    // 沒成交商品的快照可能是 0／0，推出 0 時照用合約參考價
    const quoteRef = Number.isFinite(derivedRef) && derivedRef > 0 ? derivedRef : undefined;
    const ref = index ? Number(index.reference) : quoteRef ?? contract.reference;
    // 漲跌停跟著合約走：報價推出的參考價和合約差超過半個跳動時，兩者不是同一個交易日，不判停板、不畫區間軌
    const sameDay = quoteRef === undefined
        || Math.abs(quoteRef - contract.reference) < tickSizeFor(contract, contract.reference) / 2;
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
    // 盤前試撮還沒有成交，即時成交的開高低是 0：當成沒有值，畫面顯示空值符號而不是 0.00。
    // 只限試撮：組合商品（價差）真成交的 0 是合法價格
    const tickOhl = (v: string) => (tick?.simtrade && Number(v) === 0 ? undefined : Number(v));
    const dayOhl = {
        open: tick ? tickOhl(tick.open) : index ? Number(index.open) : snapshot?.open,
        high: tick ? tickOhl(tick.high) : index ? Number(index.high) : snapshot?.high,
        low: tick ? tickOhl(tick.low) : index ? Number(index.low) : snapshot?.low,
    };
    // 全盤的開高低（使用者指定）：K 線是全盤時，有夜盤的期貨、選擇權開盤價用交易日第一筆（前一個交易日 15:00 夜盤開盤），
    // 最高、最低也含夜盤；K 線切到僅日盤時照日盤。只有日盤時段（含 08:30 試撮、收盤後）的報價要補夜盤，
    // 夜盤時段的即時成交本來就從 15:00 算起。
    // shortcut: 日盤到 16:15 的匯率、黃金、原油期權（K 線也沒有僅日盤可選）照日盤，要補再依商品時段框夜盤
    const quoteAt = tick ? (tick.date && tick.time ? `${tick.date} ${tick.time}` : undefined) : snapshot?.datetime;
    const quoteT = quoteAt ? wallClockToUtc(quoteAt) : undefined;
    const sessionWin =
        quoteT !== undefined && supportsSessionSplit(contract) && sessionMode !== 'day'
            ? sessionWindowFor(contract.security_type, quoteT - CLOSE_GRACE)
            : undefined;
    const nightWin = sessionWin && !sessionWin.night ? nightWindowOf(sessionWin.start) : undefined;
    // App 隔夜開著時，最後一筆夜盤成交本身就是整段夜盤的開高低（含凌晨），先拿來用：
    // 08:30 試撮進來、夜盤 K 還沒抓回來時，區間軌不會先換成數字欄再換回來
    const lastNight = useRef<{ code: string; end: number; t: number; open: number; high: number; low: number; volume?: number }>(undefined);
    if (tick && sessionWin?.night && quoteT !== undefined && dayOhl.open && dayOhl.high && dayOhl.low) {
        // 夜盤時段的即時累計量從 15:00 算起，就是這段夜盤到這筆為止的量
        lastNight.current = { code: contract.code, end: sessionWin.end, t: quoteT, open: dayOhl.open, high: dayOhl.high, low: dayOhl.low, volume: tick.total_volume };
    }
    // 同一段夜盤的最後一筆；落在夜盤最後 5 分鐘內才當成整段。電腦睡眠、斷線停在半夜那筆時高低不完整，
    // 照常去抓 K，抓回來前先拿它墊著（08:30 區間軌不會先換成數字欄）
    const seen = lastNight.current;
    const sameNight = seen?.code === contract.code && seen.end === nightWin?.end ? seen : undefined;
    const liveNight = sameNight && sameNight.t >= sameNight.end - 300 ? sameNight : undefined;
    // 開盤前（08:30 試撮）抓的 K 常常還沒有 00:00 到 05:00 那段（上游跨午夜尾段晚發布，issue #18），開盤後再抓一次：
    // 每檔每天最多兩次。還缺時照收並在提示註明，不在背景反覆重抓（維護者已移除背景重查，ADR 0002 要求外層重試有上限）
    const nightKey = `${contract.code}:${nightWin?.start}`;
    const nightPhase = sessionWin && quoteT !== undefined && quoteT < sessionWin.start ? 'pre' : 'open';
    const nightQuery = useQuery(
        () =>
            retryAfter(
                // 查到交易日當天：夜盤 K 不論歸在哪個日期都抓得到（日盤的 K 會被時段框濾掉）
                () => fetchKbars(contract, wallDate(nightWin!.start), wallDate(sessionWin!.start)),
                PREVIOUS_AMOUNT_RETRY_MS,
                undefined,
                isTransientError,
            ).then((k) => {
                const ohl = nightSessionOhl(k, nightWin!);
                // 只看夜盤時段內的 K 判斷凌晨尾段有沒有缺（findKbarGap 有密度門檻，冷門合約不會誤判）
                // 不含 05:00 後的收盤定盤寬限：那幾根會被 findKbarGap 歸到當天日盤自成一組，收盤後被誤判成缺尾段
                const times = k.datetime.map(wallClockToUtc).filter((t) => t > nightWin!.start && t <= nightWin!.end);
                return ohl && { ...ohl, partial: findKbarGap(times, contract.security_type, nowWallClockUtc())?.startsWith('tail') === true };
            }),
        `night-ohl:${nightKey}:${nightPhase}`,
        nightWin !== undefined && !liveNight,
    );
    // 開盤後換新的查詢還沒回來（08:45 正忙）時，先沿用開盤前抓到的同一段夜盤，「開」與區間軌不會閃回日盤
    const fetchedNight = useRef<{ key: string; open: number; high: number; low: number; volume?: number; partial: boolean }>(undefined);
    if (nightQuery.data) fetchedNight.current = { key: nightKey, ...nightQuery.data };
    const fetched = nightQuery.data ?? (fetchedNight.current?.key === nightKey ? fetchedNight.current : undefined);
    // 抓回的 K 缺尾段時，睡眠前收到的那筆可能更完整：兩者都有就取聯集（開盤都是 15:00 那筆），高低不會往回縮
    const night = liveNight ?? (fetched && sameNight
        ? { ...fetched, high: Math.max(fetched.high, sameNight.high), low: Math.min(fetched.low, sameNight.low), volume: maxDefined(fetched.volume, sameNight.volume) }
        : fetched ?? sameNight);
    // 夜盤不完整：K 缺凌晨尾段，或只有停在半夜的那筆成交可墊
    const nightPartial = !liveNight && (fetched ? fetched.partial : !!sameNight);
    const { open, high, low } = withNightSession(dayOhl, night);
    // 「開」是哪一段的開盤：全盤補到夜盤時註明（不完整時也說）；抓失敗、夜盤沒成交時也說，免得把日盤開盤當全盤看
    const sessionNote = !nightWin
        ? undefined
        : night
          ? nightPartial
              ? '開盤為前一交易日 15:00 夜盤開盤；夜盤資料尚未齊全，高低與量可能不完整'
              : '開盤為前一交易日 15:00 夜盤開盤，高低與量含夜盤'
          : nightQuery.error
            ? '夜盤資料取得失敗，開高低與量為日盤'
            : nightQuery.updatedAt !== null ? '夜盤時段沒有成交，開高低與量為日盤' : undefined;
    // 量的提示：全盤補到夜盤（或補不到）時和「開」用同一句註記；僅日盤、沒有夜盤的商品不寫
    const volNote = sessionNote;
    // 全盤時量也加上夜盤（和開高低一致）；僅日盤、沒有夜盤的商品照舊
    const vol = withNightVolume(
        tick?.total_volume ??
            index?.vol_sum ??
            index?.volume ??
            snapshot?.total_volume,
        night,
        tick?.simtrade === true,
    );
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
    const previousQuery = useQuery(
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
    );
    const previous = previousQuery.data;
    const volumeChange = volumeChangeOf(estimate, previous);
    // 有預估量、前一交易日金額還沒抓成功也沒失敗（剛開頁、09:00 換交易日）：較昨日先佔位顯示空值，
    // lean 不在預估量與較昨日之間來回換格；抓失敗或抓完沒有資料才讓位給預估量
    // 使用者關掉較昨日時不佔位，lean 改留預估量
    const keepChange = showI('change') && (volumeChange !== undefined
        || (estimate !== undefined && previousQuery.updatedAt === null && !previousQuery.error));
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
        previous === undefined && estimate !== undefined
            ? previousQuery.loading ? '前一交易日金額取得中，失敗會自動重試'
                : previousQuery.error ? '前一交易日金額取得失敗，本交易日不再重試' : undefined
            : undefined,
        // 標快照時價格提示已寫「尚未收到即時報價」，這裡不重複
        index || snapOnly ? undefined : '本次連線尚未收到 quote_idx',
        // 讀回時這個時間只屬於家數，價格與金額來自快照
        counts?.time ? `${recalled ? '家數' : ''}更新 ${counts.time.slice(0, 8)}` : undefined,
    ]
        .filter(Boolean)
        .join('\n');
    const breadth = breadthOf(counts?.raise_count, counts?.flat_count, counts?.fall_count);
    // 家數組與比例條共用：讀回收盤那筆時照樣給比例，並註明哪天收盤時存下（窄階梯只剩比例條，沒有時間格可看）；
    // 即時與讀回都沒有時說明尚未收到，不寫比例
    const breadthGroupTitle = index
        ? breadthTitle(breadth) || undefined
        : recalled
          ? [breadthTitle(breadth), `收盤時存下的家數（${tradingDate(recalled.date)} ${recalled.time.slice(0, 8)}）`].filter(Boolean).join('\n')
          : '本次連線尚未收到 quote_idx';
    const boardRef = useRef<HTMLDivElement>(null);
    // 價格固定小數位：尾數 0 被省略時寬度會差一到三個字，造成階梯來回切換。
    // 指數固定兩位；其他商品 500 以上依跳動級距（電子期 0.05 → 2,345.10），500 以下沿用原本的兩位
    const boardPrice = (v: number | string | undefined) => {
        const n = Number(v);
        if (isIndex) return fmtPrice(v, 2);
        const decimals = tickDecimals(tickSizeFor(contract, n));
        return fmtPrice(v, Number.isFinite(n) && Math.abs(n) >= 500 ? decimals
            : contract.security_type === 'FUT' || contract.security_type === 'OPT' ? Math.max(2, decimals) : undefined);
    };
    const changeDigits = contract.security_type === 'FUT' || contract.security_type === 'OPT'
        ? Math.max(2, tickDecimals(tickSizeFor(contract, close ?? 1))) : 2;
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
    // 共用判斷（指數、興櫃不亮；跳動價位精度比較）；徽章文字由 hook 自動納入量測簽章。
    const atLimit = sameDay ? limitStateOf(contract, close) : null;
    // 日內區間軌：有漲跌停、開高低收都到齊才畫（rail、railMid、railLow 三級取代右側數字），否則照原本的數字欄。
    // 選擇權不畫：跌停墊在最小跳動、漲停是權利金加標的 10%，兩側差數十倍，+50% 會畫得比 -5% 還小
    const range =
        isIndex || !showS('rail') || contract.security_type === 'OPT' || !hasPriceLimits(contract) || !sameDay
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
    const sim = tick?.simtrade === true;
    // 指數與個股各自記收合偏好
    const { tier, toggle } = useBoardTier(
        boardRef,
        isIndex ? 'sj-index-board-mode' : 'sj-stock-board-mode',
        isIndex ? BOARD_TIERS : range ? RAIL_TIERS : STOCK_TIERS,
    );
    const richBoard = isRichTier(tier);
    // 參考價、更新時間收進漲跌與現價的滑過提示
    const timeText = (isIndex ? index?.time : tick?.time)?.slice(0, 8);
    const priceTitle = [
        sim ? '試撮揭示價，非成交價' : snapOnly ? `快照 ${snapshot?.datetime?.replace('T', ' ').slice(0, 19) ?? '時間未提供'}，尚未收到即時${isIndex ? '報價' : '成交'}` : undefined,
        timeText ? `更新 ${timeText}` : undefined,
    ].filter(Boolean).join('\n') || undefined;
    // 停板組取自合約，和報價不是同一個交易日時註明（不判斷誰新誰舊：盤前是報價舊，期貨夜盤合約沒換時是合約舊）
    const limitTitle = sameDay || !hasPriceLimits(contract) ? undefined : `漲跌停取自合約（參考 ${boardPrice(contract.reference)}），和現價不是同一個交易日`;
    // 讀屏：指數的快照說明在價格提示、讀回註記在家數組提示，標題屬性讀屏多半不念，一併放進補充文字
    const details = [
        ref ? `參考 ${boardPrice(ref)}` : undefined,
        isIndex ? [snapOnly ? priceTitle : undefined, volumeTitle].filter(Boolean).join('\n') : priceTitle,
        isIndex ? (counts ? breadthGroupTitle : undefined) : showRatio ? ratioTitle : undefined,
        sessionNote,
        limitTitle,
    ].filter(Boolean).join('，').replace(/[\n｜]+/g, '，');
    // 會畫區間軌的商品還沒有開高低（盤前、合約已換日而報價還是前一天）：wide 只在單列放得下時用，
    // 免得高窄面板盤前報價欄先長成兩列、08:30 或 09:00 再縮回
    const railPending = !isIndex && showS('rail') && !range && contract.security_type !== 'OPT' && hasPriceLimits(contract);

    // ---- 自訂欄位：依面板設定決定畫哪些格子、什麼順序（降級規則看格子的優先度 class，和順序無關） ----
    const indexCells: Partial<Record<IndexField, ReactNode>> = {
        limitUp: (
            <Stat
                key="limitUp"
                label="漲停"
                className={styles.secondary}
                valueClass={styles.limitCount[(counts?.limit_up_count ?? 0) > 0 ? 'up' : 'zero']}
            >
                {fmtInt(counts?.limit_up_count)}
            </Stat>
        ),
        raise: (
            <Stat
                key="raise"
                label="上漲"
                valueClass={counts?.raise_count === undefined ? styles.statValue : `${styles.statValue} ${panel.dirText.up}`}
            >
                {fmtInt(counts?.raise_count)}
            </Stat>
        ),
        flat: (
            <Stat key="flat" label="平盤" valueClass={styles.statValue} className={styles.secondary}>
                {fmtInt(counts?.flat_count)}
            </Stat>
        ),
        fall: (
            <Stat
                key="fall"
                label="下跌"
                valueClass={counts?.fall_count === undefined ? styles.statValue : `${styles.statValue} ${panel.dirText.down}`}
            >
                {fmtInt(counts?.fall_count)}
            </Stat>
        ),
        limitDown: (
            <Stat
                key="limitDown"
                label="跌停"
                className={styles.secondary}
                valueClass={styles.limitCount[(counts?.limit_down_count ?? 0) > 0 ? 'down' : 'zero']}
            >
                {fmtInt(counts?.limit_down_count)}
            </Stat>
        ),
        amount: (
            <Stat
                key="amount"
                label="成交金額"
                title={progress === undefined ? undefined : `已成交預估的 ${(progress * 100).toFixed(0)}%`}
                valueClass={styles.statValue}
                // 有預估量（或較昨日）可依靠時，成交金額收進它們的滑過提示；兩格都被關掉時成交金額照常顯示
                className={estimate !== undefined && (showI('estimate') || keepChange) ? styles.lowPriority : undefined}
            >
                <Compact value={amount} />
            </Stat>
        ),
        estimate: (
            <Stat
                key="estimate"
                label={actual ? '實際量' : '預估量'}
                title={volumeTitle}
                valueClass={styles.statValue}
                // lean 要留下一格量能：有較昨日（或正在抓前一交易日金額）時留較昨日（預估量收起），沒有時改留預估量
                className={estimate === undefined ? styles.lowPriority : keepChange ? styles.secondary : undefined}
            >
                <Compact value={estimate} />
            </Stat>
        ),
        change: (
            <Stat
                key="change"
                label="較昨日"
                title={volumeTitle}
                valueClass={styles.statValue}
                className={keepChange ? undefined : styles.lowPriority}
            >
                {volumeChange ?? '—'}
            </Stat>
        ),
        time: (
            <Stat key="time" label="時間" valueClass={styles.statValue} className={styles.lowPriority}>
                {counts?.time?.slice(0, 8) ?? '—'}
            </Stat>
        ),
    };
    // 收盤後實際量就是全日成交金額，兩格同一個數字：只留實際量（使用者決定）。
    // 使用者關掉預估量／實際量那格時，成交金額照常顯示，全日金額才不會整個不見
    const amountDuplicated = actual && showI('estimate');
    const indexGroups = fields.index.sections.flatMap((section) => {
        const cells = visibleFields(fields.index, section).filter((f) => f !== 'breadthBar' && !(f === 'amount' && amountDuplicated));
        if (cells.length === 0) return [];
        return section === 'breadth'
            ? [
                  <div key="breadth" className={styles.indexGroup.breadth} title={breadthGroupTitle}>
                      {cells.map((f) => indexCells[f])}
                      {showI('breadthBar') && breadth.total > 0 && (
                          <BreadthBar className={styles.breadthBar} breadth={breadth} title={breadthGroupTitle} />
                      )}
                  </div>,
              ]
            : [
                  <div key="volume" className={styles.indexGroup.volume}>
                      {cells.map((f) => indexCells[f])}
                  </div>,
              ];
    });
    // compact 的量能標籤：較昨日優先，沒有（或被關掉）時改放成交金額
    const leadChange = showI('change') ? volumeChange : undefined;
    const leadAmount = showI('amount') ? amount : undefined;

    // 個股數字欄：高低、漲跌停是上下成對的一欄；開、量、量比這類單格連續排在一起時組成一欄，
    // 第一格在上排、其餘在下排（預設就是原本的「上排開、下排量與量比」）
    const statAvailable = (f: StockField) => (f === 'ratio' ? showRatio : f === 'limits' ? hasPriceLimits(contract) : true);
    const statFields = visibleFields(fields.stock, 'stats').filter(statAvailable);
    const rowClass = (top: boolean) => (top ? styles.rowTop : styles.rowBottom);
    const singleCell = (f: StockField, top: boolean): ReactNode => {
        if (f === 'open') {
            return (
                <Fragment key={f}>
                    <span
                        className={[styles.pairLabel, styles.stockOpen, rowClass(top), sessionNote && styles.tipLabel, sessionNote && styles.tipCell].filter(Boolean).join(' ')}
                        title={sessionNote}
                    >
                        開
                    </span>
                    <span
                        className={[styles.pairValue, styles.stockOpen, rowClass(top), sessionNote && styles.tipCell].filter(Boolean).join(' ')}
                        title={sessionNote}
                    >
                        {boardPrice(open)}
                    </span>
                </Fragment>
            );
        }
        if (f === 'volume') {
            return (
                <Fragment key={f}>
                    <span
                        className={[styles.pairLabel, styles.stockVol, rowClass(top), volNote && styles.tipLabel, volNote && styles.tipCell].filter(Boolean).join(' ')}
                        title={volNote}
                    >
                        量
                    </span>
                    <span
                        className={[styles.pairValue, styles.stockVol, rowClass(top), volNote && styles.tipCell].filter(Boolean).join(' ')}
                        title={volNote}
                    >
                        {fmtInt(vol)}
                    </span>
                </Fragment>
            );
        }
        return (
            <Fragment key={f}>
                <span
                    className={`${styles.pairLabel} ${styles.stockRatio} ${rowClass(top)} ${styles.tipLabel} ${styles.tipCell}`}
                    title={ratioTitle}
                >
                    量比
                </span>
                <span className={`${styles.pairValue} ${styles.stockRatio} ${rowClass(top)} ${styles.tipCell}`} title={ratioTitle}>
                    {fmtVolumeRatio(volumeRatio)}
                </span>
            </Fragment>
        );
    };
    const statColumns: ReactNode[] = [];
    let run: StockField[] = [];
    const flushRun = () => {
        if (run.length === 0) return;
        const cols = 2 * Math.max(1, run.length - 1);
        statColumns.push(
            <div key={`run-${run.join('-')}`} className={styles.volGroup} style={{ [styles.VOL_COLS_VAR]: String(cols) } as CSSProperties}>
                {run.map((f, i) => singleCell(f, i === 0))}
            </div>,
        );
        run = [];
    };
    for (const f of statFields) {
        if (f === 'highLow') {
            flushRun();
            statColumns.push(
                <div key={f} className={styles.pairGroup}>
                    <span className={styles.pairLabel}>高</span>
                    <span className={vsOpen(high)}>{boardPrice(high)}</span>
                    <span className={styles.pairLabel}>低</span>
                    <span className={vsOpen(low)}>{boardPrice(low)}</span>
                </div>,
            );
        } else if (f === 'limits') {
            flushRun();
            statColumns.push(
                <div
                    key={f}
                    className={limitTitle ? `${styles.pairGroup} ${styles.stockLimit} ${styles.tipCell}` : `${styles.pairGroup} ${styles.stockLimit}`}
                    title={limitTitle}
                >
                    <span className={limitTitle ? `${styles.pairLabel} ${styles.tipLabel}` : styles.pairLabel}>漲停</span>
                    <span className={`${styles.pairValue} ${panel.dirText.up}`}>{boardPrice(contract.limit_up)}</span>
                    <span className={limitTitle ? `${styles.pairLabel} ${styles.tipLabel}` : styles.pairLabel}>跌停</span>
                    <span className={`${styles.pairValue} ${panel.dirText.down}`}>{boardPrice(contract.limit_down)}</span>
                </div>,
            );
        } else {
            run.push(f);
        }
    }
    flushRun();
    // 價格旁的量（compact、tight）跟著數字欄的開關：量、量比各自關得掉
    const tagVolume = showS('volume') && vol !== undefined;
    const tagRatio = showRatio && showS('ratio');

    const dir =
        chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';

    return (
        <div
            ref={boardRef}
            className={`${styles.board} ${styles.boardTiered} ${isIndex ? styles.boardIndex : styles.boardStock}${railPending ? ` ${styles.boardRailPending}` : ''} drag-handle`}
            // 看板上按右鍵直接打開自訂欄位（精簡階梯沒有齒輪按鈕時也找得到）
            onContextMenu={(e) => {
                if ((e.target as Element).closest('button')) return;
                e.preventDefault();
                setSettingsAt({ kind: 'point', x: e.clientX, y: e.clientY, doc: e.currentTarget.ownerDocument, board: e.currentTarget });
            }}
        >
            {/* 代號與名稱面板標題列已經有，看板不重複 */}
            <span
                className={priceTitle ? `${styles.bigPrice[dir]} ${styles.tipCell}` : styles.bigPrice[dir]}
                title={priceTitle}
            >
                {priceText}
            </span>
            {/* 試撮價剛好在漲跌停：窄階梯只放得下一個標籤，留「試撮」、收起停板徽章，免得看成已經鎖停 */}
            {(sim || snapOnly) && (
                <span className={sim && atLimit ? `${styles.statusBadge} ${styles.statusKeep}` : styles.statusBadge}>
                    {sim ? '試撮' : '快照'}
                </span>
            )}
            {atLimit && (
                <span className={sim ? `${styles.limitBadge[atLimit]} ${styles.limitWide}` : styles.limitBadge[atLimit]}>
                    {atLimit === 'up' ? '漲停' : '跌停'}
                </span>
            )}

            <div
                className={
                    ref ? `${styles.changeBlock} ${panel.dirText[dir]} ${styles.tipCell}` : `${styles.changeBlock} ${panel.dirText[dir]}`
                }
                title={ref ? `參考 ${boardPrice(ref)}` : undefined}
            >
                <span>{fmtSigned(chg, changeDigits)}</span>
                <span className={ref ? styles.tipLabel : undefined}>{fmtPct(pct)}</span>
                <span className={styles.srOnly} data-board-details>{details}</span>
            </div>

            {isIndex ? (
                <>
                    {(leadChange || leadAmount !== undefined) && (
                        <span className={styles.leadTag} title={volumeTitle}>
                            {/* 沒有「較昨日」標籤可依靠，加「量」字和價格漲跌幅區分 */}
                            {leadChange ? `量${leadChange}` : <Compact value={leadAmount} />}
                        </span>
                    )}
                    {showI('breadthBar') && breadth.total > 0 && (
                        <BreadthBar className={styles.breadthMini} breadth={breadth} title={breadthGroupTitle} />
                    )}
                    {indexGroups.length > 0 && <div className={styles.indexStats}>{indexGroups}</div>}
                </>
            ) : (
                fields.stock.sections.map((section) =>
                    section === 'range' ? (
                        <Fragment key="range">
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
                                    // 試撮價不是成交，碰到停板也不算鎖住：照常畫現價針
                                    locked={sim ? null : atLimit}
                                    note={sessionNote}
                                    touched={{
                                        up: limitStateOf(contract, high) === 'up',
                                        down: limitStateOf(contract, low) === 'down',
                                    }}
                                    // 數字列跟著數字欄的開關：關掉的格子在軌道下方也不顯示
                                    hide={{ edges: !showS('limits'), hl: !showS('highLow'), open: !showS('open') }}
                                />
                            )}
                            {/* 和排行榜的產業標籤一樣：點了讓產業全景下鑽到這個產業（按鈕不會觸發面板拖曳） */}
                            {range && showS('sector') && sector && contract.category && (
                                <button
                                    type="button"
                                    className={styles.sectorTag}
                                    title="跳到此類股熱力圖"
                                    onClick={() => focusSector(contract.category!)}
                                >
                                    {sector}
                                </button>
                            )}
                        </Fragment>
                    ) : (
                        <Fragment key="stats">
                            {vol !== undefined && (tagVolume || tagRatio) && (
                                <span
                                    className={tagRatio || (tagVolume && volNote) ? `${styles.stockVolTag} ${styles.tipCell}` : styles.stockVolTag}
                                    title={tagRatio ? ratioTitle : tagVolume ? volNote : undefined}
                                >
                                    {tagVolume && <>量 {fmtInt(vol)}</>}
                                    {tagRatio && (
                                        <span className={tagVolume ? styles.stockVolTagRatio : undefined}>量比 {fmtVolumeRatio(volumeRatio)}</span>
                                    )}
                                </span>
                            )}
                            {statColumns.length > 0 && <div className={styles.stockStats}>{statColumns}</div>}
                        </Fragment>
                    ),
                )
            )}
            {/* 右側工具：自訂欄位（只在完整的階梯顯示，精簡時先展開；看板上按右鍵也能打開）與展開／收合 */}
            <div className={styles.boardTools}>
                <button
                    type="button"
                    className={styles.boardSettings}
                    onClick={(e) => {
                        const el = e.currentTarget;
                        setSettingsAt((prev) => (prev ? null : { kind: 'element', el, board: boardRef.current ?? undefined }));
                    }}
                    aria-haspopup="dialog"
                    aria-expanded={settingsAt !== null}
                    aria-label="自訂報價欄位"
                    title="自訂報價欄位"
                >
                    <Settings2 size={12} aria-hidden="true" />
                </button>
                <button
                    type="button"
                    className={styles.boardToggle}
                    onClick={toggle}
                    aria-expanded={richBoard}
                    aria-label="報價統計"
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
            {settingsAt && (
                <QuoteBoardSettings
                    anchor={settingsAt}
                    fields={fields}
                    currentKind={isIndex ? 'index' : 'stock'}
                    onChange={setFields}
                    onClose={closeSettings}
                />
            )}
        </div>
    );
}
