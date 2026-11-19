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
import type { SseBidAsk, SseTick } from '../types/market';

/** SSE 事件名稱與獨立串流路徑 */
export const US_TICK_EVENT = 'us_tick';
export const US_BIDASK_EVENT = 'us_bidask';
export const US_STREAM_PATHS: Record<string, string> = {
    [US_TICK_EVENT]: '/api/v1/stream/data/us_tick',
    [US_BIDASK_EVENT]: '/api/v1/stream/data/us_bidask',
};
/** 美股可訂閱的 quote_type（沒有 Quote） */
export const US_QUOTE_TYPES = ['Tick', 'BidAsk'] as const;

export type UsTradingSession = 'Unknown' | 'PreMarket' | 'Regular' | 'AfterHours';
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
    session?: UsTradingSession;
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
    volume: number;
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

const str = (v: string | null | undefined) => (v === null || v === undefined ? '' : String(v));

/**
 * 漲跌與幅度。一般盤用 SDK 的 price_chg／pct_chg；盤前／盤後 SDK 送的是一般盤
 * 漲跌（盤前一律 0），改以最近一般盤收盤價（us_tick 的 close）計算延長時段漲跌，
 * 與美股報價慣例（Pre-Market +1.47 / +0.42%）一致。
 */
export function usTickChange(raw: Pick<RawUsTick, 'close' | 'price_chg' | 'pct_chg' | 'session'>, price: string): { priceChg?: string; pctChg?: string } {
    const extended = raw.session === 'PreMarket' || raw.session === 'AfterHours';
    const close = str(raw.close);
    if (extended && decIsPositive(close)) {
        const chg = decSub(price, close);
        if (chg !== null) {
            return { priceChg: decNormalize(chg) ?? chg, pctChg: ((Number(chg) / Number(close)) * 100).toFixed(2) };
        }
    }
    return { priceChg: str(raw.price_chg) || undefined, pctChg: str(raw.pct_chg) || undefined };
}

/**
 * 漲跌的基準價（成交價 − 漲跌）：一般盤是當日參考價，盤前／盤後是最近一般盤
 * 收盤價（見 usTickChange）。報價板的「參考」用它，才會與漲跌一致。
 */
export function usTickReference(tick: Pick<SseTick, 'close' | 'price_chg'> | undefined): string | null {
    if (!tick?.price_chg || !decIsPositive(tick.close)) return null;
    const ref = decSub(tick.close, tick.price_chg);
    return ref !== null && decIsPositive(ref) ? decNormalize(ref) ?? ref : null;
}

/** us_tick → SseTick（code＝US:CODE）＋美股資訊；沒有成交價回 null */
export function normalizeUsTick(raw: RawUsTick): { tick: SseTick; meta: UsTickMeta } | null {
    // price 是這筆成交價（可含 sub-penny，例如零股或中價成交，照原值顯示）；close 是一般盤價
    const price = str(raw.price) || str(raw.close);
    if (!raw?.code || !price || !Number.isFinite(Number(price))) return null;
    const change = usTickChange(raw, price);
    const key = usLinkKey(raw.code);
    const { date, time } = nyDateTime(raw.datetime);
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
    };
    return {
        tick,
        meta: {
            key,
            price,
            session: raw.session ?? 'Unknown',
            freshness: raw.freshness?.status ?? null,
            ts: Math.floor(raw.datetime / 1000),
            volume: tick.volume,
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
    quoteType: (typeof US_QUOTE_TYPES)[number],
) {
    return {
        security_type: 'STK',
        exchange: contract.exchange,
        code: contract.code.toUpperCase(),
        quote_type: quoteType,
    };
}

// ---- 當日 session 的逐筆（給走勢圖；只有訂閱後收到的，沒有歷史） ----

const SESSION_TICK_LIMIT = 20_000;
const sessionTicks = new Map<string, UsTickMeta[]>();
const lastMeta = new Map<string, UsTickMeta>();
const sessionListeners = new Map<string, Set<() => void>>();

export function recordUsTick(meta: UsTickMeta) {
    const prev = lastMeta.get(meta.key);
    lastMeta.set(meta.key, meta);
    let list = sessionTicks.get(meta.key);
    // 換 session（盤前→盤中→盤後）或換日就重新開始
    if (!list || (prev && (prev.session !== meta.session || nyDateTime(prev.ts * 1000).date !== nyDateTime(meta.ts * 1000).date))) {
        list = [];
        sessionTicks.set(meta.key, list);
    }
    list.push(meta);
    if (list.length > SESSION_TICK_LIMIT) list.splice(0, list.length - SESSION_TICK_LIMIT);
    sessionListeners.get(meta.key)?.forEach(l => l());
}

export function getUsSessionTicks(key: string): readonly UsTickMeta[] {
    return sessionTicks.get(key) ?? EMPTY;
}
const EMPTY: readonly UsTickMeta[] = [];

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
};

export function resetUsQuotesForTest() {
    sessionTicks.clear();
    lastMeta.clear();
    sessionListeners.clear();
}
