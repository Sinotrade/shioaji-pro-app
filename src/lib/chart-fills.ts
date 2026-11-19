import { scopedFlashRows } from './flash-account';
import { CLOSE_GRACE, isDaySessionTick, sessionWindowFor, supportsSessionSplit, type SessionContractLike } from './intraday-session';
import { stockQtyUnit } from './odd-lot';
import type { ContractBase } from './types/contract';
import type { Candle } from './types/market';
import type { AccountedTrade, Deal } from './types/order';
import type { Account } from './types/portfolio';

export interface ChartFill {
    id: string;
    time: number; // K-bar label, Taiwan wall-clock encoded as UTC seconds（unplaced：本來該落的 K 棒 label）
    ts: number; // original fill Unix seconds
    price: number;
    quantity: number;
    unit: '張' | '股' | '口';
    action: 'Buy' | 'Sell';
    code: string; // 成交本身的合約代碼（換月日可能是上一個月份）
    account: Account; // 這筆成交所屬的範圍帳戶
}

/** 連續月別名換月當天：cutoff（Unix 秒）之前的成交屬於 previous，之後才屬於現在的 target_code。 */
export interface FillRollover {
    previous: string;
    cutoff: number;
}

export interface FillScope {
    trades: readonly AccountedTrade[];
    contract: ContractBase;
    account: Account | undefined;
    /** 全部帳戶模式：有給就取代 account，範圍是這些帳戶的聯集（空陣列 = 沒有範圍） */
    accounts?: readonly Account[];
    rollover?: FillRollover | null;
}

export interface ChartFillsInput extends FillScope {
    bars: readonly Candle[];
    minutes: number;
    dayOnly: boolean;
}

const TAIPEI_OFFSET = 8 * 3600;
// 期貨月份字母（同 realized-name.ts）；不從那裡匯入，以免把行情、合約快取等有副作用的模組帶進這個純邏輯檔
const MONTH_CODES = 'ABCDEFGHIJKL';
const HOUR = 3600;
const DAY = 86400;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** 彙整用的整數價格鍵：不靠跳動級距表（避免查詢、避免級距未載入時把不同價合併）；超出安全整數就退回原值單獨成組。 */
export function priceKey(price: number): string {
    const scaled = Math.round(price * 1e6);
    return Number.isSafeInteger(scaled) ? String(scaled) : `p:${price}`;
}

// 成交價文字：最少 min 位小數（圖表的價格位數）、最多 max 位（預設 8，不截掉實際成交價的小數）。
// 格式器依位數快取：每次成交回報都會重組標籤，帶選項的 toLocaleString 每次重建格式器、慢約 70 倍
const priceFormats = new Map<string, Intl.NumberFormat>();
export function fillPriceText(price: number, min: number, max = 8): string {
    const lo = Math.max(0, Math.min(8, Math.trunc(min) || 0));
    const hi = Math.max(lo, Math.min(8, Math.trunc(max) || 0));
    const key = `${lo}:${hi}`;
    let format = priceFormats.get(key);
    if (!format) priceFormats.set(key, format = new Intl.NumberFormat('en-US', { minimumFractionDigits: lo, maximumFractionDigits: hi }));
    return format.format(price);
}
/** 圖表價格位數（0～8）；位數函式回傳非數字時當 0 */
export const fillDecimals = (decimals: ((price: number) => number) | undefined, price: number) =>
    Math.max(0, Math.min(8, Math.trunc(decimals?.(price) ?? 0) || 0));

export function resolvedCode(contract: ContractBase): string | null {
    // An unresolved continuous alias cannot identify the traded expiry.
    if ((contract.security_type === 'FUT' || contract.security_type === 'OPT')
        && /R[12]$/.test(contract.code) && !nonempty(contract.target_code)) return null;
    const code = contract.target_code || contract.code;
    return nonempty(code) ? code : null;
}

// Futures/options reports from the live order stream carry exchange 'TIM' while REST
// rows and the contract cache say 'TAIFEX'; the projected trade keeps whatever the
// last report said. Their codes already pin month and strike, so only stocks also
// need the exchange to match.
function sameMarket(a: ContractBase, b: ContractBase) {
    return a.security_type === b.security_type
        && (a.security_type === 'FUT' || a.security_type === 'OPT' || a.exchange === b.exchange);
}

// Real 1-minute kbars end at the session close (stocks 13:30, futures day 13:45, night 05:00):
// the closing-auction print at 13:30:00.x would be labelled 13:31, a bar that never exists.
// Same rule as intraday-session (isDaySessionLabel): prints within CLOSE_GRACE after the close
// belong to the session's last bar. Anything later (after-hours lots) stays unmatched.
// Futures/options whose day session runs to 16:15 (FX, gold, oil) close at 16:15 and 05:00 instead.
function closeLabel(contract: ContractBase, label: number) {
    const secType = contract.security_type;
    if (!secType) return label;
    const t = label - CLOSE_GRACE;
    let end = sessionWindowFor(secType, t).end;
    if ((secType === 'FUT' || secType === 'OPT') && !supportsSessionSplit(contract as SessionContractLike)) {
        const d0 = Math.floor(t / DAY) * DAY;
        const tod = t - d0;
        end = tod <= 5 * HOUR ? d0 + 5 * HOUR : tod <= 16.25 * HOUR ? d0 + 16.25 * HOUR : d0 + DAY + 5 * HOUR;
    }
    return label > end && label <= end + CLOSE_GRACE ? end : label;
}

// 連續月別名（TXFR1／TXFR2）換月前後的月份。previous：別名換月前指向的合約（target 前 1 個月）；
// near：到期決定換月的近月（R1 就是 previous，R2 是 target 前 2 個月）。其他格式回 null。
export function rolloverCodes(contract: ContractBase): { previous: string; near: string } | null {
    const alias = contract.security_type === 'FUT' ? /R([12])$/.exec(contract.code) : null;
    const target = /^([A-Z0-9]+)([A-L])(\d)$/.exec(contract.target_code ?? '');
    if (!alias || !target) return null;
    const [, root, letter = '', year] = target;
    const back = (months: number) => {
        const month = MONTH_CODES.indexOf(letter) - months;
        // 跨年：年個位數減 1（0 變 9）
        return month < 0 ? `${root}${MONTH_CODES[month + 12]}${(Number(year) + 9) % 10}` : `${root}${MONTH_CODES[month]}${year}`;
    };
    return { previous: back(1), near: back(alias[1] === '1' ? 1 : 2) };
}

// 帳戶、市場、商品都對得上的委託（chartFills 與 missingDeals 共用），連同所屬帳戶、成交合約與可收的成交時間 [from, until)。
// 全部帳戶模式：每筆委託只歸給第一個對得上的帳戶，accounts 重複也不會收兩次。
// 換月當天：現在的 target 只收 cutoff 之後的成交，上一個月份只收之前的；其他月份照舊略過。
function scopedTrades({ trades, contract, account, accounts, rollover }: FillScope) {
    const code = resolvedCode(contract);
    const owners = accounts ?? (account ? [account] : []);
    if (!code) return [];
    return trades.flatMap(trade => {
        const owner = owners.find(candidate => scopedFlashRows([trade], candidate).length > 0);
        if (!owner) return [];
        const own = sameMarket(trade.contract, contract) ? resolvedCode(trade.contract) : null;
        if (own === code) return [{ trade, owner, code: own, from: rollover ? rollover.cutoff : -Infinity, until: Infinity }];
        if (rollover && own === rollover.previous) return [{ trade, owner, code: own, from: -Infinity, until: rollover.cutoff }];
        return [];
    });
}

function scopedFor(input: FillScope, cache?: ProjectionCache) {
    if (!cache) return scopedTrades(input);
    const { trades, contract, account, accounts, rollover } = input;
    const previous = cache.scope;
    if (previous && previous.trades === trades && previous.contract === contract && previous.account === account
        && previous.accounts === accounts && previous.rollover === rollover) return previous.rows;
    const rows = scopedTrades(input);
    cache.scope = { trades, contract, account, accounts, rollover, rows };
    return rows;
}

/**
 * 對得上的委託裡，有任一筆成交數量（deal_quantity）不等於成交明細加總：明細還沒讀齊或對不上。
 * 股票整股、零股、期貨的 deal_quantity 與 deals 單位相同；以整筆委託比對，不看換月 cutoff。
 */
export function missingDeals(input: FillScope, cache?: ProjectionCache): boolean {
    return scopedFor(input, cache).some(({ trade: { status } }) => {
        const deals = Array.isArray(status.deals) ? status.deals : [];
        // 成交數量不是數字就無從比對，不算缺漏（不能因為一筆欄位缺漏就把整張圖的成交藏起來）
        return Number.isFinite(status.deal_quantity) && status.deal_quantity !== deals.reduce((sum, deal) => sum + deal.quantity, 0);
    });
}

/** Read-only projection of actual deals onto bars already loaded by the chart. */
export function chartFills(input: ChartFillsInput): ChartFill[] {
    return projectChartFills(input).fills;
}

type Scoped = ReturnType<typeof scopedTrades>[number];

// 一筆成交跟 K 棒無關的部分：新棒、換歷史都不必重算。落點（落在哪根）每次依目前的 K 棒判斷
interface DealRow {
    id: string;
    deal: Deal;
    /** 依 1 分 K label 聚合的那根（歷史 K 棒） */
    history: number;
    /** 依成交時間直接分桶的那根（即時 K 棒還沒重讀歷史前） */
    live: number;
    /** 晚於最後一根時當成等待新棒（盤中、期貨、日 K），不放進無對應 */
    waits: boolean;
    /** 上次交出的成交物件與它是否落在 K 棒上：落點沒變就沿用（分組與明細列都不必重做） */
    fill: ChartFill | null;
    placed: boolean;
}
// 一張委託已掃過的成交。同一序號出現兩筆也都留著：去重要等落點判斷完（還在等新棒的那筆不算數），跟逐筆版一樣
interface TradeRows {
    deals: readonly Deal[];
    scanned: number;
    ownerKey: string;
    owner: Account;
    code: string;
    from: number;
    until: number;
    action: ChartFill['action'];
    unit: ChartFill['unit'];
    rows: DealRow[];
    /** 掃過的序號（同一張委託裡識別碼只差序號，用短字串判斷重複） */
    seqs: Set<string>;
    /** 有同一個序號的兩筆：投影時要逐筆去重 */
    repeats: boolean;
}

const sameDeal = (a: Deal | undefined, b: Deal | undefined) =>
    !!a && !!b && a.seq === b.seq && a.ts === b.ts && a.price === b.price && a.quantity === b.quantity;

// 掃 deals[from..] 加進 rows（成交逐筆的時間、識別碼只在第一次看到時算）
function scanDeals(entry: TradeRows, deals: readonly Deal[], { contract, minutes, dayOnly }: ChartFillsInput, orderId: string): void {
    const bucketSeconds = minutes * 60;
    const futures = contract.security_type === 'FUT' || contract.security_type === 'OPT';
    for (let i = entry.scanned; i < deals.length; i += 1) {
        const deal = deals[i]!;
        if (!nonempty(deal.seq) || !positive(deal.price) || !positive(deal.quantity)
            || !Number.isSafeInteger(deal.quantity) || !positive(deal.ts) || deal.ts < entry.from || deal.ts >= entry.until) continue;
        const local = deal.ts + TAIPEI_OFFSET;
        if (dayOnly && !isDaySessionTick(contract.security_type, local)) continue;
        // Bars are labelled by minute end and N-minute/daily bars are built from those 1-minute
        // labels (utils/kbars aggregate): so 23:59:xx (label 00:00) joins the next day's bar.
        // A bar built from live ticks (candle-chart) buckets the raw tick time instead, so until
        // the history is reloaded the same print can sit in that bar; take whichever one exists.
        const label = closeLabel(contract, Math.floor(local / 60) * 60 + 60);
        // Sequence numbers are per order. Include the full account and
        // resolved contract so switching scope never reuses a fill's ID.
        const owner = entry.owner;
        const id = JSON.stringify([owner.account_type, owner.broker_id, owner.account_id,
            contract.security_type, contract.exchange, entry.code, orderId, deal.seq]);
        if (entry.seqs.has(deal.seq)) entry.repeats = true;
        else entry.seqs.add(deal.seq);
        entry.rows.push({
            id, deal, fill: null, placed: false,
            history: minutes >= 1440 ? Math.floor(label / DAY) * DAY : Math.ceil(label / bucketSeconds) * bucketSeconds,
            live: minutes >= 1440 ? Math.floor(local / DAY) * DAY : Math.floor(local / bucketSeconds) * bucketSeconds + bucketSeconds,
            // 股票的盤後定價、盤後零股不會有分 K；期貨、選擇權沒有盤後時段，日 K 當天那根一定會開出來
            waits: futures || minutes >= 1440 || isDaySessionTick(contract.security_type, local),
        });
    }
    entry.deals = deals;
    entry.scanned = deals.length;
}

// 投影快取（每張圖自己一份，跟著圖卸載釋放；每個情境＝合約、週期、僅日盤、帳戶範圍一筆）：每張委託記住掃過的成交。
// 交易狀態只換掉有變動的委託；彈出視窗收到的整份複本內容沒變也照樣沿用；成交只往後加時只掃新的那幾筆。
// 結果和上次完全相同（同一批成交物件）時直接交回上次的陣列，下游的分組與明細都不必重做。
interface ProjectionContext {
    trades: Map<string, TradeRows>;
    flat: ChartFill[];
    flatUnplaced: ChartFill[];
    result: { fills: ChartFill[]; unplaced: ChartFill[] };
}
export interface ProjectionCache {
    contexts: Map<string, ProjectionContext>;
    scope?: FillScope & { rows: Scoped[] };
}
/** 一張圖的投影快取：記最近 CACHE_CONTEXTS 個情境（切週期再切回來不必重掃） */
export const createProjectionCache = (): ProjectionCache => ({ contexts: new Map() });
const CACHE_CONTEXTS = 3;
const barTimes = new WeakMap<readonly Candle[], { length: number; first: number; lastBar: number; times: Set<number>; last: number }>();

function sameList(a: readonly ChartFill[], b: readonly ChartFill[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * fills：落在已載入 K 棒上的成交。unplaced：通過全部篩選（帳戶、商品、換月、僅日盤、欄位有效），只差找不到 K 棒
 * （例如盤後定價在分 K、停牌缺棒）；time 是本來該落的 K 棒 label。K 棒還在載入（bars 為空）時兩者都是空的；
 * 成交晚於最後一根 K 棒、之後還會開出那根（盤中、期貨、日 K）時當成等待新棒，兩邊都不放，免得即時 K 棒開出前閃一下。
 */
export function projectChartFills(input: ChartFillsInput, cache: ProjectionCache = createProjectionCache()): { fills: ChartFill[]; unplaced: ChartFill[] } {
    const { contract, bars, minutes, dayOnly, account, accounts } = input;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || bars.length === 0) return { fills: [], unplaced: [] };
    // K 棒陣列會原地加新棒：長度與頭尾變了才重建時間表
    let derived = barTimes.get(bars);
    if (!derived || derived.length !== bars.length || derived.first !== bars[0]!.time || derived.lastBar !== bars[bars.length - 1]!.time) {
        barTimes.set(bars, derived = { length: bars.length, first: bars[0]!.time, lastBar: bars[bars.length - 1]!.time,
            times: new Set(bars.map(bar => bar.time)), last: bars.reduce((max, bar) => Math.max(max, bar.time), -Infinity) });
    }
    const { times, last } = derived;
    const session = contract as Partial<SessionContractLike>;
    const owners = accounts ?? (account ? [account] : []);
    const contextKey = [minutes, dayOnly, contract.security_type, contract.exchange, contract.code, contract.target_code,
        session.underlying_kind, session.root, session.category, ...owners.map(o => `${o.account_type}:${o.broker_id}:${o.account_id}`)].join('|');
    const { contexts } = cache;
    const previous = contexts.get(contextKey);
    const tradesNow = new Map<string, TradeRows>();
    const flat: ChartFill[] = [];
    const flatUnplaced: ChartFill[] = [];
    // 逐筆去重只發生在同一張委託（帳戶、合約、委託編號）之內：同序號兩筆、或同一張委託在 trades 出現兩次。
    // 跟逐筆版一樣，先判斷落點、還在等新棒的不算數，真的交出去時才記下識別碼
    const seenByKey = new Map<string, Set<string>>();
    const waiting = (row: DealRow) => row.waits && row.history > last && !times.has(row.history) && !times.has(row.live);
    for (const { trade, owner, code, from, until } of scopedFor(input, cache)) {
        const action = trade.order.action;
        if (!nonempty(trade.order.id) || (action !== 'Buy' && action !== 'Sell')) continue;
        const ownerKey = `${owner.account_type}:${owner.broker_id}:${owner.account_id}`;
        const key = `${ownerKey}|${code}|${trade.order.id}`;
        const deals = Array.isArray(trade.status.deals) ? trade.status.deals : [];
        const unit = contract.security_type === 'FUT' || contract.security_type === 'OPT' ? '口' : stockQtyUnit(trade.order.order_lot);
        const duplicate = tradesNow.has(key);
        let entry = duplicate ? undefined : previous?.trades.get(key);
        if (entry && (entry.ownerKey !== ownerKey || entry.code !== code || entry.from !== from || entry.until !== until
            || entry.action !== action || entry.unit !== unit || entry.owner !== owner)) entry = undefined;
        if (entry && entry.deals !== deals) {
            // 內容沒變（彈出視窗的複本）或只往後加：沿用已掃過的；其他改動整張重掃
            const prefix = Math.min(entry.scanned, deals.length);
            let same = deals.length >= entry.scanned;
            for (let i = 0; same && i < prefix; i += 1) same = sameDeal(entry.deals[i], deals[i]);
            if (!same) entry = undefined;
        }
        if (!entry) entry = { deals, scanned: 0, ownerKey, owner, code, from, until, action, unit, rows: [], seqs: new Set(), repeats: false };
        if (entry.scanned !== deals.length || entry.deals !== deals) scanDeals(entry, deals, input, trade.order.id);
        if (!duplicate) tradesNow.set(key, entry);
        let seen = seenByKey.get(key);
        if (!seen && (entry.repeats || duplicate)) {
            seen = new Set();
            // 第一次出現的那張沒有重複序號（有的話早就建了），它交出去的就是不在等新棒的全部
            if (duplicate) for (const row of tradesNow.get(key)!.rows) if (!waiting(row)) seen.add(row.id);
            seenByKey.set(key, seen);
        }
        for (const row of entry.rows) {
            const placed = times.has(row.history) ? row.history : times.has(row.live) ? row.live : null;
            if (placed === null && row.history > last && row.waits) continue;
            if (seen) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
            }
            const time = placed ?? row.history;
            if (!row.fill || row.fill.time !== time || row.placed !== (placed !== null)) {
                const { deal } = row;
                row.fill = { id: row.id, time, ts: deal.ts, price: deal.price, quantity: deal.quantity, unit: entry.unit, action: entry.action, code, account: entry.owner };
                row.placed = placed !== null;
            }
            (placed === null ? flatUnplaced : flat).push(row.fill);
        }
    }
    let result: ProjectionContext['result'];
    if (previous && sameList(flat, previous.flat) && sameList(flatUnplaced, previous.flatUnplaced)) result = previous.result;
    else {
        const order = (a: ChartFill, b: ChartFill) => a.time - b.time || a.ts - b.ts || a.id.localeCompare(b.id);
        result = { fills: [...flat].sort(order), unplaced: [...flatUnplaced].sort(order) };
    }
    contexts.delete(contextKey);
    contexts.set(contextKey, { trades: tradesNow, flat, flatUnplaced, result });
    if (contexts.size > CACHE_CONTEXTS) contexts.delete(contexts.keys().next().value!);
    return result;
}
