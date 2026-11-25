// src/lib/us/us-quotes.ts — 美股即時行情的轉接層（SDK 1.8.0b1）
//
// Python：api.subscribe(us_contract, quote_type='tick'|'bidask')，回呼
// set_on_us_tick_callback／set_on_us_bidask_callback。UsTick：price、volume、
// session、freshness；UsBidAsk：只有最佳一檔。沒有 snapshot、沒有歷史 K 線／
// ticks。
//
// HTTP（SDK beta MR !507；欄位依 shioaji 原始碼 UsTick／UsBidAsk）：
//   - 訂閱：POST /api/v1/stream/subscribe，body 為
//     {security_type:'STK', exchange:'NASDAQ', code:'AAPL', quote_type:'Tick'|'BidAsk'}，
//     exchange 是美股交易所（NASDAQ／NYSE／BATS／TXSE），不帶 intraday_odd。
//   - 推送：獨立 SSE GET /api/v1/stream/data/us_tick、/api/v1/stream/data/us_bidask
//     （事件名稱 us_tick／us_bidask）；美股事件不會出現在台股 tick／bidask 串流。
//   - Decimal 欄位是字串；datetime 是 epoch µs UTC。
//   - 停牌另見 us-halts.ts。
// 美股行情只有正式環境（BC）有；IDC／模擬環境訂閱成功也不會有資料。
//
// 轉成既有的 SseTick／SseBidAsk 形狀、code 用連動 key `US:CODE`，放進同一個
// 行情 store：自選、報價板、閃電、下單面板都用 useQuote('US:CODE') 讀。
// 數字欄位只供顯示；送單價格一律由梯形或輸入框的 decimal 字串決定。

import { usLinkKey } from '../contract-key';
import { decIsPositive, decNormalize, decSub } from './decimal';
import type { Candle, SseBidAsk, SseTick } from '../types/market';
import { wallClockToUtc } from '../utils/kbars';

/** SSE 事件名稱與獨立串流路徑 */
export const US_TICK_EVENT = 'us_tick';
export const US_BIDASK_EVENT = 'us_bidask';
export const US_STREAM_PATHS: Record<string, string> = {
    [US_TICK_EVENT]: '/api/v1/stream/data/us_tick',
    [US_BIDASK_EVENT]: '/api/v1/stream/data/us_bidask',
};
/** 美股可訂閱的 quote_type（沒有 Quote）。App 內一律叫 Tick；送出時依設定可能換成 TickFull（us-tick-wire.ts） */
export const US_QUOTE_TYPES = ['Tick', 'BidAsk'] as const;

/**
 * SDK session：0 Unknown、1 PreMarket、2 Regular、3 AfterHours、4 Overnight（Nasdaq 23x5
 * 夜盤，2026-12-06 起；SDK 1.8.0）。HTTP SSE 送名稱，舊路徑可能送數字。
 */
export type UsTradingSession = 'Unknown' | 'PreMarket' | 'Regular' | 'AfterHours' | 'Overnight';

const US_SESSIONS: readonly UsTradingSession[] = ['Unknown', 'PreMarket', 'Regular', 'AfterHours', 'Overnight'];

/**
 * session 原值 → UsTradingSession：數字（含數字字串）照 SDK 編號，名稱照原字；
 * 不認得的值一律 Unknown（不會被當成一般盤）。沒有值回 null。
 */
export function usSessionOf(v: unknown): UsTradingSession | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
        const n = Number(v);
        return Number.isInteger(n) ? US_SESSIONS[n] ?? 'Unknown' : 'Unknown';
    }
    if (typeof v === 'string') return (US_SESSIONS as readonly string[]).includes(v) ? v as UsTradingSession : 'Unknown';
    return 'Unknown';
}

/** YYYY-MM-DD 之後的第 n 個平日（n=0：本身是平日就是本身，否則下一個平日） */
export function nextUsWeekday(date: string, n = 1): string {
    let t = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(t)) return date;
    const weekend = () => { const d = new Date(t).getUTCDay(); return d === 0 || d === 6; };
    while (weekend() && n === 0) t += 86_400_000;
    for (let i = 0; i < n; i++) {
        t += 86_400_000;
        while (weekend()) t += 86_400_000;
    }
    return new Date(t).toISOString().slice(0, 10);
}

/**
 * 成交所屬的交易日：交易日 D＝[D−1 20:00, D 20:00) ET。只有夜盤 20:00 之後的成交
 * 歸下一個交易日；其他時段（含 20:00 整的盤後寬限成交）就是美東日期。
 */
export function usTradeDateOf(epochUs: number, session: UsTradingSession | null | undefined): string {
    const { date, time } = nyDateTime(epochUs);
    if (!date || session !== 'Overnight' || time < '20:00:00') return date;
    return nextUsWeekday(date, 1);
}
export type UsFreshnessStatus = 'Realtime' | 'Stale' | 'Delayed';

/** feat/198-us-quotes-v3 UsTick（只列用到的欄位） */
export interface RawUsTick {
    exchange: string;
    code: string;
    datetime: number;
    exchange_datetime?: number;
    price?: string | null;
    volume: number;
    close?: string | null;
    open?: string | null;
    high?: string | null;
    low?: string | null;
    avg_price?: string | null;
    amount?: string | null;
    total_amount?: string | null;
    total_volume?: number;
    tick_type?: number;
    chg_type?: number;
    price_chg?: string | null;
    pct_chg?: string | null;
    bid_side_total_vol?: number;
    ask_side_total_vol?: number;
    odd_lot?: boolean;
    /** 這筆有沒有更新一般盤的 close／開高低／漲跌（零股、盤前盤後成交是 false） */
    updates_last?: boolean;
    /** 目前盤前或盤後時段的最新／最高／最低（只算整股）；一般盤時是 null */
    ext_close?: string | null;
    ext_high?: string | null;
    ext_low?: string | null;
    /** 舊路徑可能是數字（0–4）；一律經 usSessionOf 讀 */
    session?: UsTradingSession | number;
    /** 交易日（SDK 有送時優先；沒送就由時間與 session 推，見 usTradeDateOf） */
    trade_date?: string | null;
    freshness?: { status?: UsFreshnessStatus; stale?: boolean; age_us?: number };
}

/** feat/198-us-quotes-v3 UsBidAsk：只有最佳一檔 */
export interface RawUsBidAsk {
    exchange: string;
    code: string;
    datetime: number;
    bid_price: string[];
    bid_volume: number[];
    ask_price: string[];
    ask_volume: number[];
    session?: UsTradingSession;
    freshness?: { status?: UsFreshnessStatus; stale?: boolean };
}

/** 美股 tick 的額外資訊（session、新鮮度、原始 decimal 價格） */
export interface UsTickMeta {
    key: string;
    price: string;
    session: UsTradingSession;
    freshness: UsFreshnessStatus | null;
    /** epoch ms */
    ts: number;
    /** epoch µs（原值，成交明細顯示用） */
    tsUs?: number;
    volume: number;
    /** SDK 的累計量（含哪些時段由 SDK 決定）；只拿前後兩筆的差判斷有沒有漏收 */
    totalVolume?: number;
    /** 1 外盤／2 內盤／0 不明 */
    tickType?: number;
    /** 這筆有沒有更新一般盤最新價（SDK 有送才有；零股、特殊條件成交、延長時段是 false） */
    updatesLast?: boolean;
    /** 零股成交（SDK 有送才有） */
    oddLot?: boolean;
}

const NY_PARTS = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** epoch µs → 紐約當地日期與時間字串（顯示用） */
export function nyDateTime(epochUs: number): { date: string; time: string } {
    const ms = Math.floor(epochUs / 1000);
    if (!Number.isFinite(ms) || ms <= 0) return { date: '', time: '' };
    const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}:${parts.second}` };
}

/**
 * epoch ms（UTC）→ 紐約牆鐘當 UTC 的秒數（圖表時間軸用，與台股的台北牆鐘
 * 同一套編碼），保留小數秒；無效時間回 NaN。美股圖表與時段框架的「現在」
 * 都用這一個轉換。
 */
export function nyWallClockSec(ms: number): number {
    if (!Number.isFinite(ms)) return NaN;
    const whole = Math.floor(ms / 1000) * 1000;
    const { date, time } = nyDateTime(whole * 1000);
    if (!date) return NaN;
    return wallClockToUtc(`${date}T${time}`) + (ms - whole) / 1000;
}

const str = (v: string | null | undefined) => (v === null || v === undefined ? '' : String(v));
/** 正的 decimal 字串照原值；null、空字串、0 都當沒有值 */
const positiveDec = (v: string | null | undefined) => (decIsPositive(str(v)) ? str(v) : '');

// ---- 參考價（漲跌基準）----
//
// 資料工程規則（cfvhub）：漲跌基準是 reference（調整後昨收 → 昨收 → 前一日
// NOCP），SDK 的 price_chg／pct_chg 也用它。盤前／盤後的成交只更新
// ext_close／ext_high／ext_low；us_tick 的 close 是最後一筆 updates_last 成交，
// 不是官方收盤，不能拿來當基準。所以延長時段的漲跌＝成交價 − reference，
// reference 取當天交易日的快照，或確定適用那天的合約檔參考價。

/**
 * 合約檔參考價（reference_date＝收盤日）是否適用 tradeDate：收盤日是 tradeDate
 * 的前一個平日（中間只隔週末）。遇到假日判定為不適用，改等快照。
 */
export function contractReferenceApplies(referenceDate: string | undefined, tradeDate: string): boolean {
    if (!referenceDate || !tradeDate || referenceDate >= tradeDate) return false;
    const start = Date.parse(`${referenceDate}T00:00:00Z`);
    const end = Date.parse(`${tradeDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 7 * 86_400_000) return false;
    for (let t = start + 86_400_000; t < end; t += 86_400_000) {
        const dow = new Date(t).getUTCDay();
        if (dow !== 0 && dow !== 6) return false;
    }
    return true;
}

/**
 * tradeDate 這個交易日的參考價：同一天的快照 reference 優先，其次是適用的合約檔
 * 參考價；都沒有回 null（不從成交價回推）。date 只在用合約檔時給。
 */
export function usReferenceFor(
    tradeDate: string,
    snap: { tradeDate: string; reference: number | null } | null | undefined,
    contract: { us_reference?: string; reference_date?: string },
): { price: string | null; date: string | null } {
    if (snap && snap.tradeDate === tradeDate && snap.reference && snap.reference > 0) return { price: String(snap.reference), date: null };
    if (contract.us_reference && decIsPositive(contract.us_reference) && contractReferenceApplies(contract.reference_date, tradeDate)) {
        return { price: contract.us_reference, date: contract.reference_date ?? null };
    }
    return { price: null, date: null };
}

/** 成交價 − 參考價（decimal 字串）與幅度（%，兩位） */
export function usChangeFrom(price: string, reference: string | null | undefined): { priceChg?: string; pctChg?: string } {
    if (!reference || !decIsPositive(reference) || !decIsPositive(price)) return {};
    const chg = decSub(price, reference);
    if (chg === null) return {};
    return { priceChg: decNormalize(chg) ?? chg, pctChg: ((Number(chg) / Number(reference)) * 100).toFixed(2) };
}

/** 已知的參考價（快照、自選清單抓到時記下），讓即時 tick 進來時就能算延長時段漲跌 */
const knownReferences = new Map<string, { date: string; price: string }>();

export function noteUsReference(key: string, tradeDate: string, price: number | string | null | undefined) {
    if (!tradeDate || price === null || price === undefined || !(Number(price) > 0)) return;
    const prev = knownReferences.get(key);
    if (prev && prev.date > tradeDate) return;
    knownReferences.set(key, { date: tradeDate, price: String(price) });
}

export function knownUsReference(key: string, tradeDate: string): string | null {
    const r = knownReferences.get(key);
    return r && r.date === tradeDate ? r.price : null;
}

/**
 * 漲跌與幅度。一般盤用 SDK 的 price_chg／pct_chg（基準就是 reference）；
 * 盤前／盤後 SDK 送的是一般盤漲跌，改以成交價 − reference 計算；不知道
 * reference 時不給漲跌（畫面顯示「—」，等快照或合約檔補上再算）。
 */
export function usTickChange(raw: Pick<RawUsTick, 'price_chg' | 'pct_chg' | 'session'>, price: string, reference: string | null): { priceChg?: string; pctChg?: string } {
    const session = usSessionOf(raw.session);
    const extended = session === 'PreMarket' || session === 'AfterHours' || session === 'Overnight';
    if (extended) return usChangeFrom(price, reference);
    return { priceChg: str(raw.price_chg) || undefined, pctChg: str(raw.pct_chg) || undefined };
}

/** us_tick → SseTick（code＝US:CODE）＋美股資訊；沒有成交價回 null */
export function normalizeUsTick(raw: RawUsTick): { tick: SseTick; meta: UsTickMeta } | null {
    // price 是這筆成交價（可含 sub-penny，例如零股或中價成交，照原值顯示）；close 是一般盤價
    const price = str(raw.price) || str(raw.close);
    if (!raw?.code || !price || !Number.isFinite(Number(price))) return null;
    const key = usLinkKey(raw.code);
    const { date, time } = nyDateTime(raw.datetime);
    const session = usSessionOf(raw.session) ?? 'Unknown';
    const tradeDate = typeof raw.trade_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trade_date)
        ? raw.trade_date
        : usTradeDateOf(raw.datetime, session);
    // 參考價跟著交易日（夜盤 20:00 後已是下一個交易日的參考價）
    const change = usTickChange(raw, price, knownUsReference(key, tradeDate));
    const tick: SseTick = {
        code: key,
        date,
        time,
        // 一般盤還沒開（盤前）時 SDK 送 null：留空，畫面顯示「—」，不拿成交價補
        open: str(raw.open),
        high: str(raw.high),
        low: str(raw.low),
        close: price,
        avg_price: str(raw.avg_price) || undefined,
        volume: Number(raw.volume) || 0,
        total_volume: Number(raw.total_volume) || 0,
        amount: str(raw.amount) || undefined,
        total_amount: str(raw.total_amount) || undefined,
        tick_type: Number(raw.tick_type) || 0,
        chg_type: raw.chg_type,
        price_chg: change.priceChg,
        pct_chg: change.pctChg,
        bid_side_total_vol: raw.bid_side_total_vol,
        ask_side_total_vol: raw.ask_side_total_vol,
        // 美股零股成交也是同一個市場：不分 store
        intraday_odd: false,
        simtrade: false,
        // 報價顯示用的一般盤與延長時段值（close 上面是這筆成交價，圖表用，不改）
        us: {
            session,
            tradeDate,
            ts: Math.floor(raw.datetime / 1000),
            regular: positiveDec(raw.close),
            regularChg: str(raw.price_chg),
            regularPct: str(raw.pct_chg),
            extClose: positiveDec(raw.ext_close),
            extHigh: positiveDec(raw.ext_high),
            extLow: positiveDec(raw.ext_low),
            ...(raw.updates_last !== undefined ? { updatesLast: raw.updates_last } : {}),
        },
    };
    return {
        tick,
        meta: {
            key,
            price,
            session,
            freshness: raw.freshness?.status ?? null,
            ts: Math.floor(raw.datetime / 1000),
            tsUs: raw.datetime,
            volume: tick.volume,
            totalVolume: tick.total_volume,
            tickType: tick.tick_type,
            ...(typeof raw.updates_last === 'boolean' ? { updatesLast: raw.updates_last } : {}),
            ...(typeof raw.odd_lot === 'boolean' ? { oddLot: raw.odd_lot } : {}),
        },
    };
}

/** us_bidask → SseBidAsk（只有最佳一檔） */
export function normalizeUsBidAsk(raw: RawUsBidAsk): SseBidAsk | null {
    if (!raw?.code) return null;
    const { date, time } = nyDateTime(raw.datetime);
    return {
        code: usLinkKey(raw.code),
        date,
        time,
        bid_price: (raw.bid_price ?? []).slice(0, 1).map(String),
        bid_volume: (raw.bid_volume ?? []).slice(0, 1).map(Number),
        ask_price: (raw.ask_price ?? []).slice(0, 1).map(String),
        ask_volume: (raw.ask_volume ?? []).slice(0, 1).map(Number),
        intraday_odd: false,
        simtrade: false,
    };
}

/** 訂閱 body：與台股同一個 flat 形狀，exchange 決定 region；不帶 intraday_odd */
export function usSubscriptionBody(
    contract: { code: string; exchange: string | null },
    quoteType: (typeof US_QUOTE_TYPES)[number] | 'TickFull',
) {
    return {
        security_type: 'STK',
        exchange: contract.exchange,
        code: contract.code.toUpperCase(),
        quote_type: quoteType,
    };
}

// ---- 逐筆通知（K 線、走勢、成交明細逐筆接收；store 會合併 tick，量會少算） ----

const lastMeta = new Map<string, UsTickMeta>();
const sessionListeners = new Map<string, Set<() => void>>();

/** 記下最新一筆並同步通知；監聽者在 callback 裡用 getUsTickMeta 讀這一筆 */
export function recordUsTick(meta: UsTickMeta) {
    lastMeta.set(meta.key, meta);
    recordUsExtendedTrade(meta);
    sessionListeners.get(meta.key)?.forEach(l => l());
}

// ---- 美股盤前／盤後成交（圖表「含盤前盤後」用） ----
//
// SDK 1.8.0 起 kbars 帶 sessions 就有盤前、盤後的歷史（回應多一個 Session 欄，
// 見 us-history fetchUsKbars）。更舊的 sidecar（≤1.8.0b3）不認 sessions、只回
// 一般盤，盤前、盤後只能用 App 開著時收到的即時逐筆 — 這裡是那時的退路：
// 把它們併成 1 分 K 留在記憶體（每個
// 商品最多留 US_EXTENDED_KEEP_DAYS 個有成交的美東日期，最多記
// US_EXTENDED_MAX_SYMBOLS 個商品，超過時丟最久沒更新的），圖表切到「含盤前盤後」
// 時和一般盤歷史接在一起畫。App 重開前的盤前盤後成交就沒有。
//
// 時間全部是紐約牆鐘當 UTC 編碼的秒數（nyWallClockSec）。

const US_H = 3600;
const US_DAY = 86400;
/** 一般盤 09:30–16:00；收盤競價（session=AfterHours）在 16:00:00–16:00:15 */
const US_OPEN = 9.5 * US_H;
const US_CLOSE = 16 * US_H;
const US_CROSS_SEC = 15;
/** 盤前 04:00 起、盤後到 20:00 */
export const US_EXTENDED_START = 4 * US_H;
export const US_EXTENDED_END = 20 * US_H;
/** 收盤後的成交（台股定盤、美股收盤競價）併進最後一根的寬限，與 intraday-session 的 CLOSE_GRACE 相同 */
const US_CLOSE_GRACE = 240;
/** 依「有成交的美東日期」計，週末、假日不佔名額 */
export const US_EXTENDED_KEEP_DAYS = 5;
/** 全域上限：超過時丟最久沒有新成交的商品（Map 依插入順序，更新時移到最後） */
export const US_EXTENDED_MAX_SYMBOLS = 100;

/** 這筆是不是一般盤 K 線的成交（Regular，或收盤競價那幾秒的 AfterHours） */
export function isUsRegularTrade(session: string | null | undefined, wallSec: number): boolean {
    if (session === 'Regular') return true;
    if (session !== 'AfterHours' || !Number.isFinite(wallSec)) return false;
    const close = Math.floor(wallSec / US_DAY) * US_DAY + US_CLOSE;
    return wallSec >= close && wallSec < close + US_CROSS_SEC;
}

/** 盤前／盤後（不含收盤競價）的成交，時間在 04:00–20:00（含收盤寬限） */
export function isUsExtendedTrade(session: string | null | undefined, wallSec: number): boolean {
    if (session !== 'PreMarket' && session !== 'AfterHours') return false;
    if (!Number.isFinite(wallSec) || isUsRegularTrade(session, wallSec)) return false;
    const tod = wallSec - Math.floor(wallSec / US_DAY) * US_DAY;
    return tod >= US_EXTENDED_START && tod <= US_EXTENDED_END + US_CLOSE_GRACE;
}

/**
 * 這筆成交算不算 K 線的價格（開高低收）：伺服器的美股 1 分 K 由一般成交
 * （Tick／TICL 的定義）組成 — 一般盤是會更新最新價的成交（updates_last），
 * 盤前、盤後、夜盤是整股成交；量則另外含零股。完整成交（TickFull）多出來的
 * 零股與特殊條件成交只加量，不動價格，即時 K 棒才會和重新載入的歷史一致。
 * 舊 sidecar 不送 updates_last／odd_lot：一律算（b1 的 Tick 就是全部成交）。
 * 已知差異：延長時段的特殊條件整股成交 TickFull 沒有欄位可分辨，仍會算進價格。
 */
export function isUsTiclTrade(meta: Pick<UsTickMeta, 'session' | 'updatesLast' | 'oddLot'>): boolean {
    if (meta.updatesLast === undefined) return meta.oddLot !== true;
    if (meta.updatesLast) return true;
    if (meta.session === 'Regular') return false;
    return meta.oddLot !== true;
}

/**
 * 美股成交的 1 分 K 標籤（K 棒結束時間，close-label-right）：
 * - 一般盤 09:30–16:00：ceil，09:30:00 整的開盤成交歸 09:31（與歷史 1 分 K 相同）
 * - 收盤後：一般盤模式 CLOSE_GRACE 內都歸 16:00；含盤前盤後時只有收盤競價那
 *   幾秒歸 16:00，之後的盤後成交照 ceil
 * - 含盤前盤後：04:00:00 整歸 04:01，20:00 之後的寬限內歸 20:00
 */
export function usMinuteLabel(wallSec: number, extended = false): number {
    const d0 = Math.floor(wallSec / US_DAY) * US_DAY;
    const tod = wallSec - d0;
    const ceil = Math.ceil(wallSec / 60) * 60;
    if (tod >= US_OPEN && tod <= US_CLOSE) return Math.max(d0 + US_OPEN + 60, ceil);
    if (tod > US_CLOSE && tod <= US_CLOSE + (extended ? US_CROSS_SEC : US_CLOSE_GRACE)) {
        if (!extended || tod < US_CLOSE + US_CROSS_SEC) return d0 + US_CLOSE;
    }
    if (extended) {
        if (tod >= US_EXTENDED_START && tod <= US_EXTENDED_END) return Math.max(d0 + US_EXTENDED_START + 60, ceil);
        if (tod > US_EXTENDED_END && tod <= US_EXTENDED_END + US_CLOSE_GRACE) return d0 + US_EXTENDED_END;
    }
    return ceil;
}

/** 1 分 K 標籤是否落在一般盤（09:31–16:00） */
export function isUsRegularLabel(label: number): boolean {
    const tod = label - Math.floor(label / US_DAY) * US_DAY;
    return tod > US_OPEN && tod <= US_CLOSE;
}

type ExtendedBook = { bars: Map<number, Candle>; days: number[] /* 由舊到新 */ };
const extendedBars = new Map<string, ExtendedBook>();

function recordUsExtendedTrade(meta: UsTickMeta) {
    if (!(meta.volume > 0)) return;
    const price = Number(meta.price);
    if (!Number.isFinite(price) || price <= 0) return;
    const t = nyWallClockSec(meta.tsUs !== undefined ? meta.tsUs / 1000 : meta.ts);
    if (!isUsExtendedTrade(meta.session, t)) return;
    const label = usMinuteLabel(t, true);
    let book = extendedBars.get(meta.key);
    if (book) extendedBars.delete(meta.key);
    else book = { bars: new Map(), days: [] };
    extendedBars.set(meta.key, book); // 移到最新
    if (extendedBars.size > US_EXTENDED_MAX_SYMBOLS) {
        const oldest = extendedBars.keys().next().value;
        if (oldest !== undefined) extendedBars.delete(oldest);
    }
    const bars = book.bars;
    const bar = bars.get(label);
    // 零股、特殊條件成交只加量（見 isUsTiclTrade）；新的一根用前一根的收盤
    const priced = isUsTiclTrade(meta);
    if (bar) {
        // 收盤取最後抵達的那筆（與即時 K 棒相同）
        if (priced) {
            bar.high = Math.max(bar.high, price);
            bar.low = Math.min(bar.low, price);
            bar.close = price;
        }
        bar.volume += meta.volume;
    } else {
        let p = price;
        if (!priced) {
            let prev: Candle | undefined;
            for (const b of bars.values()) if (b.time < label && (!prev || b.time > prev.time)) prev = b;
            if (!prev) return;
            p = prev.close;
        }
        bars.set(label, { time: label, open: p, high: p, low: p, close: p, volume: meta.volume });
        // 只留最近 US_EXTENDED_KEEP_DAYS 個有成交的日期（週末、假日不算）
        const day = Math.floor(label / US_DAY);
        if (!book.days.includes(day)) {
            book.days.push(day);
            book.days.sort((a, b) => a - b);
            if (book.days.length > US_EXTENDED_KEEP_DAYS) {
                book.days.splice(0, book.days.length - US_EXTENDED_KEEP_DAYS);
                const cutoff = book.days[0]! * US_DAY;
                for (const k of bars.keys()) if (k < cutoff) bars.delete(k);
            }
        }
    }
}

/** 這個商品記到的盤前／盤後 1 分 K（依時間排序的複本） */
export function getUsExtendedBars(key: string): Candle[] {
    const book = extendedBars.get(key);
    if (!book) return [];
    return [...book.bars.values()].map(b => ({ ...b })).sort((a, b) => a.time - b.time);
}

export function getUsTickMeta(key: string): UsTickMeta | undefined {
    return lastMeta.get(key);
}

export function subscribeUsSessionTicks(key: string, listener: () => void): () => void {
    let set = sessionListeners.get(key);
    if (!set) { set = new Set(); sessionListeners.set(key, set); }
    set.add(listener);
    return () => { set!.delete(listener); };
}

export const US_SESSION_LABEL: Record<UsTradingSession, string> = {
    Unknown: '',
    PreMarket: '盤前',
    Regular: '盤中',
    AfterHours: '盤後',
    Overnight: '夜盤',
};

export function resetUsQuotesForTest() {
    knownReferences.clear();
    lastMeta.clear();
    sessionListeners.clear();
    extendedBars.clear();
}
