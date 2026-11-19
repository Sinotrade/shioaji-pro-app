// src/lib/us/us-history.ts — 美股歷史行情（SDK 1.8.0b1 起：snapshots／kbars／ticks）
//
// HTTP（與台股同一組端點，contract 帶 region US）：
//   - POST /api/v1/data/kbars：1 分 K，欄位與台股同（datetime／Open…）。美股的
//     時間是 UTC 的「K 棒結束時間」（台股是台北牆鐘），只有一般盤；日 K 目前回空。
//   - POST /api/v1/data/ticks：UsTicks（ts 為 UTC epoch ns，另有 session、
//     updates_last、odd_lot；bid／ask 可能是 null）。只有一般盤（含收盤競價
//     session=AfterHours）；一次最多 100000 筆。部分 sidecar 版本回台股形狀
//     （datetime 字串、沒有 session）— 兩種都接受，時間一律當 UTC。
//   - POST /api/v1/data/snapshots：每列帶 region，美股列是 UsSnapshot。
// 美股行情只有 BC 有；IDC 回空。
//
// 舊版 SDK（1.8.0 以前）或回應形狀不對（4xx、欄位缺）時記下「這個 sidecar
// 沒有美股歷史」，之後不再打（換 sidecar 才重試）；面板維持原本只用即時逐筆
// 的行為。5xx／逾時只讓這一次失敗，不自動重試。
//
// 圖表時間模型與台股一致：牆鐘當 UTC 編碼（台股是台北牆鐘），美股用紐約
// 牆鐘 — 與 App 其他地方顯示美股時間（nyDateTime）一致。

import { apiPost } from '../api';
import { getApiBase } from '../runtime';
import { knownServerInfo } from '../server-info-store';
import type { ContractBase } from '../types/contract';
import type { Candle } from '../types/market';
import { wallClockToUtc } from '../utils/kbars';
import { nyDateTime, type UsTradingSession } from './us-quotes';

// ---- availability ----

const unavailableBases = new Set<string>();

/** SDK 版本字串（1.8.0-beta.1／1.8.0b1／1.7.11）→ 是否已有美股歷史 API；不明回 null */
export function sdkHasUsHistory(version: string | undefined | null): boolean | null {
    const m = /^(\d+)\.(\d+)\./.exec(String(version ?? '').trim());
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 1 || (major === 1 && minor >= 8);
}

/** 記錄與查詢用同一個正規化（URL origin：https://host:443 與 https://host 視為同一個） */
function baseKey(base: string): string {
    return originOf(base) ?? base;
}

export function usHistoryAvailable(): boolean {
    if (unavailableBases.has(baseKey(getApiBase()))) return false;
    return sdkHasUsHistory(knownServerInfo()?.version) !== false;
}

/** base 是送出請求時的 sidecar；回應晚到時目前的 base 可能已經換了 */
function markUnavailable(base: string) {
    unavailableBases.add(baseKey(base));
}

export function resetUsHistoryForTest() {
    unavailableBases.clear();
    snapshotCache.clear();
}

/** 美股歷史不可用（舊 SDK／形狀不對）時的錯誤；面板據此退回只用即時資料 */
export class UsHistoryUnavailable extends Error {
    constructor() {
        super('這個 SDK 版本沒有美股歷史行情');
        this.name = 'UsHistoryUnavailable';
    }
}

export function isUsHistoryUnavailable(e: unknown): e is UsHistoryUnavailable {
    return e instanceof UsHistoryUnavailable;
}

function usContractBody(c: Pick<ContractBase, 'code' | 'exchange'>) {
    return { security_type: 'STK', region: 'US', exchange: c.exchange, code: c.code.trim().toUpperCase() };
}

async function usPost<T>(path: string, body: unknown, parse: (raw: unknown) => T | null, opts?: { timeoutMs?: number }): Promise<T> {
    if (!usHistoryAvailable()) throw new UsHistoryUnavailable();
    // 實際送出的 sidecar：啟動閘門可能在送出前把請求改派到另一個 base，而
    // 桌面版等待原生傳輸時目前的 base 又可能已經變了 — 一律以 beforeDispatch
    // 帶來的實際 URL 的 origin 為準
    let base = getApiBase();
    let raw: unknown;
    try {
        raw = await apiPost<unknown>(path, body, { timeoutMs: opts?.timeoutMs ?? 20_000, beforeDispatch: (url) => { base = url ? originOf(url) ?? base : base; } });
    } catch (e) {
        const status = (e as { status?: unknown })?.status;
        const msg = e instanceof Error ? e.message : String(e);
        const code = typeof status === 'number' ? status : Number(/^(\d{3})( |$)/.exec(msg)?.[1]);
        // 404／405／501：這個 sidecar 沒有這個端點的美股版本 — 記下不再打。
        // 400／422 等參數錯誤（例如 kbars 區間超過 30 天）只讓這次失敗。
        if (code === 404 || code === 405 || code === 501) {
            markUnavailable(base);
            throw new UsHistoryUnavailable();
        }
        throw e;
    }
    const parsed = parse(raw);
    if (parsed === null) {
        markUnavailable(base);
        throw new UsHistoryUnavailable();
    }
    return parsed;
}

function originOf(url: string): string | null {
    try { return new URL(url).origin; } catch { return null; }
}

// ---- time ----

/** 美股時間欄位 → epoch ms（UTC）。數字依位數判斷 ns／µs／ms／s；無時區的字串當 UTC。 */
export function usTimeToMs(v: unknown): number | null {
    if (typeof v === 'number') {
        if (!Number.isFinite(v) || v <= 0) return null;
        if (v > 1e17) return Math.floor(v / 1e6);
        if (v > 1e14) return Math.floor(v / 1e3);
        if (v > 1e11) return Math.floor(v);
        return Math.floor(v * 1000);
    }
    if (typeof v !== 'string' || v.length < 10) return null;
    const s = v.trim();
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.slice(10));
    if (hasZone) {
        const ms = Date.parse(s);
        return Number.isFinite(ms) ? ms : null;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/.exec(s);
    if (!m) return null;
    const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) + Math.floor(frac);
}

/** epoch ms（UTC）→ 紐約牆鐘當 UTC 的秒數（圖表時間軸用，與台股的台北牆鐘同一套編碼） */
export function nyWallClockSec(ms: number): number {
    const { date, time } = nyDateTime(ms * 1000);
    if (!date) return NaN;
    return wallClockToUtc(`${date}T${time}`);
}

/** 現在的紐約日期（YYYY-MM-DD），往前 daysAgo 天 */
export function nyDateStr(nowMs = Date.now(), daysAgo = 0): string {
    return nyDateTime((nowMs - daysAgo * 86_400_000) * 1000).date;
}

// ---- kbars ----

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));

function column(raw: Record<string, unknown>, ...names: string[]): unknown[] | null {
    for (const n of names) {
        const v = raw[n];
        if (Array.isArray(v)) return v;
    }
    return null;
}

/**
 * 美股 kbars → Candle（time＝紐約牆鐘當 UTC 的 K 棒結束時間，與台股 1 分 K
 * 的 close-label-right 同慣例）。形狀不對回 null。
 */
export function parseUsKbars(raw: unknown): Candle[] | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const times = column(r, 'ts', 'datetime');
    const open = column(r, 'Open', 'open');
    const high = column(r, 'High', 'high');
    const low = column(r, 'Low', 'low');
    const close = column(r, 'Close', 'close');
    const volume = column(r, 'Volume', 'volume');
    if (!times || !open || !high || !low || !close || !volume) return null;
    const out: Candle[] = [];
    for (let i = 0; i < times.length; i++) {
        const ms = usTimeToMs(times[i]);
        if (ms === null) continue;
        const time = nyWallClockSec(ms);
        const c = num(close[i]);
        if (!Number.isFinite(time) || !Number.isFinite(c)) continue;
        out.push({ time, open: num(open[i]), high: num(high[i]), low: num(low[i]), close: c, volume: num(volume[i]) || 0 });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/** SDK 1.8.0b1：kbars 一次最多 30 天（超過回 400） */
export const US_KBARS_MAX_DAYS = 30;

const dayMs = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** [start, end]（YYYY-MM-DD，含兩端）切成每段最多 maxDays 天，舊到新 */
export function splitDateRange(start: string, end: string, maxDays = US_KBARS_MAX_DAYS): [string, string][] {
    const s = Date.parse(`${start}T00:00:00Z`);
    const e = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return [[start, end]];
    const out: [string, string][] = [];
    for (let a = s; a <= e; a += maxDays * dayMs) {
        out.push([isoDay(a), isoDay(Math.min(e, a + (maxDays - 1) * dayMs))]);
    }
    return out;
}

/** 美股 1 分 K；超過 30 天的區間依序分段抓再合併 */
export async function fetchUsKbars(contract: Pick<ContractBase, 'code' | 'exchange'>, start: string, end: string, opts?: { timeoutMs?: number }): Promise<Candle[]> {
    const parts: Candle[][] = [];
    for (const [a, b] of splitDateRange(start, end)) {
        parts.push(await usPost('/api/v1/data/kbars', { contract: usContractBody(contract), start: a, end: b }, parseUsKbars, opts));
    }
    if (parts.length === 1) return parts[0]!;
    const byTime = new Map<number, Candle>();
    for (const c of parts.flat()) byTime.set(c.time, c);
    return [...byTime.values()].sort((x, y) => x.time - y.time);
}

// ---- ticks ----

export interface UsHistoryTick {
    /** epoch ms（UTC） */
    ts: number;
    /** epoch µs（UTC；去重用，保留原始精度） */
    tsUs: number;
    /** 紐約時間 HH:MM:SS.ffffff */
    time: string;
    price: number;
    volume: number;
    bid: number | null;
    ask: number | null;
    /** 1 外盤／2 內盤／0 不明 */
    tickType: number;
    session: UsTradingSession | null;
    oddLot: boolean;
}

const SESSIONS: readonly UsTradingSession[] = ['Unknown', 'PreMarket', 'Regular', 'AfterHours'];
function sessionOf(v: unknown): UsTradingSession | null {
    if (typeof v === 'number') return SESSIONS[v] ?? 'Unknown';
    if (typeof v === 'string') return (SESSIONS as readonly string[]).includes(v) ? v as UsTradingSession : 'Unknown';
    return null;
}

/** 時間欄位 → epoch µs（ns 數字取整到 µs；字串取小數秒前 6 位） */
// ns 的 JSON 數字（約 1.8e18）超過 2^53，JSON.parse 時已經四捨五入到 256 ns
// 的倍數，無法還原原值；取最接近的 µs，誤差最多 ±1 µs（去重時容許這個誤差）。
function usTimeToUs(rawTime: unknown, ms: number): number {
    if (typeof rawTime === 'number' && rawTime > 1e17) return Math.round(rawTime / 1e3);
    if (typeof rawTime === 'number' && rawTime > 1e14) return Math.floor(rawTime);
    const frac = typeof rawTime === 'string' ? /\.(\d+)/.exec(rawTime)?.[1] : undefined;
    if (frac) return Math.floor(ms / 1000) * 1_000_000 + Number(frac.padEnd(6, '0').slice(0, 6));
    return ms * 1000;
}

/** 時間字串的小數秒（6 位）；數字時間用 ms 補零 */
/** epoch µs → 紐約時間 HH:MM:SS.ffffff（秒與小數都取自同一個 µs，與去重用的 tsUs 一致） */
export function nyTimeFromUs(tsUs: number): string {
    const sec = Math.floor(tsUs / 1_000_000);
    const { time } = nyDateTime(sec * 1_000_000);
    return `${time}.${String(tsUs - sec * 1_000_000).padStart(6, '0')}`;
}

/** 美股 ticks（UsTicks 或台股形狀）→ 依時間排序的列；形狀不對回 null */
export function parseUsTicks(raw: unknown): UsHistoryTick[] | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const times = column(r, 'ts', 'datetime');
    const close = column(r, 'close');
    const volume = column(r, 'volume');
    if (!times || !close || !volume) return null;
    const bid = column(r, 'bid_price') ?? [];
    const ask = column(r, 'ask_price') ?? [];
    const tickType = column(r, 'tick_type') ?? [];
    const session = column(r, 'session') ?? [];
    const oddLot = column(r, 'odd_lot') ?? [];
    const out: UsHistoryTick[] = [];
    for (let i = 0; i < times.length; i++) {
        const ms = usTimeToMs(times[i]);
        const price = num(close[i]);
        if (ms === null || !Number.isFinite(price)) continue;
        const tsUs = usTimeToUs(times[i], ms);
        const b = bid[i] === null || bid[i] === undefined ? null : num(bid[i]);
        const a = ask[i] === null || ask[i] === undefined ? null : num(ask[i]);
        out.push({
            ts: ms,
            tsUs,
            time: nyTimeFromUs(tsUs),
            price,
            volume: num(volume[i]) || 0,
            bid: b !== null && Number.isFinite(b) && b > 0 ? b : null,
            ask: a !== null && Number.isFinite(a) && a > 0 ? a : null,
            tickType: Number(tickType[i]) || 0,
            session: sessionOf(session[i]),
            oddLot: oddLot[i] === true,
        });
    }
    // 穩定排序（同一時間戳保留原順序）
    return out.map((t, i) => [t, i] as const).sort((x, y) => x[0].ts - y[0].ts || x[1] - y[1]).map(([t]) => t);
}

/** date 是美東交易日（YYYY-MM-DD）；lastCnt 給定時只取最後 N 筆 */
export function fetchUsTicks(contract: Pick<ContractBase, 'code' | 'exchange'>, date: string, opts?: { lastCnt?: number; timeoutMs?: number }): Promise<UsHistoryTick[]> {
    const body: Record<string, unknown> = { contract: usContractBody(contract), date };
    if (opts?.lastCnt) {
        body.query_type = 'LastCount';
        body.last_cnt = opts.lastCnt;
    }
    return usPost('/api/v1/data/ticks', body, parseUsTicks, opts);
}

// ---- snapshots ----

export interface UsSnapshot {
    code: string;
    exchange: string;
    /** epoch ms（UTC） */
    ts: number | null;
    /** 美東交易日 */
    tradeDate: string;
    open: number;
    high: number;
    low: number;
    close: number;
    reference: number | null;
    changePrice: number;
    changeRate: number;
    totalVolume: number;
    buyPrice: number | null;
    sellPrice: number | null;
    buyVolume: number | null;
    sellVolume: number | null;
    session: UsTradingSession | null;
    /** 最新成交（含盤前／盤後）；close 是一般盤價 */
    lastPrice: number | null;
    /** 前一交易日成交量（量比用；舊 sidecar 沒帶時 undefined） */
    yesterdayVolume?: number;
}

const optNum = (v: unknown) => (v === null || v === undefined ? null : Number.isFinite(num(v)) ? num(v) : null);

/** 一列 snapshot → UsSnapshot；不是美股列（region 缺＝台股）回 null */
export function parseUsSnapshotRow(row: unknown): UsSnapshot | null {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    if (r.region !== 'US' || typeof r.code !== 'string') return null;
    const close = num(r.close);
    if (!Number.isFinite(close)) return null;
    const tsMs = usTimeToMs(r.ts ?? r.datetime);
    return {
        code: r.code,
        exchange: String(r.exchange ?? ''),
        ts: tsMs,
        tradeDate: typeof r.trade_date === 'string' ? r.trade_date : '',
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close,
        reference: optNum(r.reference),
        changePrice: num(r.change_price) || 0,
        changeRate: num(r.change_rate) || 0,
        totalVolume: num(r.total_volume) || 0,
        buyPrice: optNum(r.buy_price),
        sellPrice: optNum(r.sell_price),
        buyVolume: optNum(r.buy_volume),
        sellVolume: optNum(r.sell_volume),
        session: sessionOf(r.session),
        lastPrice: optNum(r.last_price),
        ...(optNum(r.yesterday_volume) !== null ? { yesterdayVolume: optNum(r.yesterday_volume)! } : {}),
    };
}

/** 快照 → 自選列的價格／漲跌（與 usLive 同形狀；只在沒有即時成交時用） */
export function usSnapshotQuote(s: UsSnapshot): { last: string; close: number; chg: number; pct: number } | null {
    if (!(s.close > 0)) return null;
    return { last: String(s.close), close: s.close, chg: s.changePrice, pct: s.changeRate };
}

/** 美股 snapshots（依輸入順序；某列不是美股形狀則該位置為 null） */
export function parseUsSnapshots(raw: unknown, count: number): (UsSnapshot | null)[] | null {
    if (!Array.isArray(raw) || raw.length !== count) return null;
    const rows = raw.map(parseUsSnapshotRow);
    // 全部不是美股列：舊 SDK 把美股當台股回 — 視為不支援
    if (count > 0 && rows.every(r => r === null)) return null;
    return rows;
}

export function fetchUsSnapshots(contracts: Pick<ContractBase, 'code' | 'exchange'>[]): Promise<(UsSnapshot | null)[]> {
    if (contracts.length === 0) return Promise.resolve([]);
    return usPost('/api/v1/data/snapshots', { contracts: contracts.map(usContractBody) }, raw => parseUsSnapshots(raw, contracts.length));
}

/**
 * 單一商品的快照，報價板、五檔等同時開啟時共用一個請求；結果保留 SNAPSHOT_TTL_MS，
 * 失敗不快取（下次掛載再試）。
 */
const SNAPSHOT_TTL_MS = 15_000;
const snapshotCache = new Map<string, { at: number; promise: Promise<UsSnapshot | null> }>();

export function fetchUsSnapshotShared(contract: Pick<ContractBase, 'code' | 'exchange'>, nowMs = Date.now()): Promise<UsSnapshot | null> {
    const key = `${baseKey(getApiBase())}|${contract.exchange}|${contract.code.trim().toUpperCase()}`;
    const hit = snapshotCache.get(key);
    if (hit && nowMs - hit.at < SNAPSHOT_TTL_MS) return hit.promise;
    const promise = fetchUsSnapshots([contract]).then(rows => rows[0] ?? null);
    snapshotCache.set(key, { at: nowMs, promise });
    promise.catch(() => { if (snapshotCache.get(key)?.promise === promise) snapshotCache.delete(key); });
    if (snapshotCache.size > 200) snapshotCache.delete(snapshotCache.keys().next().value!);
    return promise;
}
