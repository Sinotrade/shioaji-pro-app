// src/lib/stock-order-conditions.ts — 本 App 送出的股票委託的信用條件與
// 現股當沖先賣旗標（PR #400 review）。
//
// 委託回報（StockOrderEvent）只帶 order_cond，不帶 daytrade_short；sw relay
// 的 place_order／update_status 回應也不回填 daytrade_short（rshioaji
// types.rs：「None for every server-sourced Trade」）。所以「這筆賣出是不是
// 現沖先賣」只能從送單當下的請求得知：送單成功後在這裡記下，委託合計
// （lib/flash-order-totals）用它判斷先賣與回補。
// 不是本 App 送的委託（其他下單軟體、別台電腦）查不到 → 呼叫端視為「條件未知」，
// 不猜成現股。
//
// 識別：帳戶＋券商序號 seqno（券商端編的，sidecar 重啟不變；Trade.order.id
// 是 sidecar 的，重啟後可能變或被重用）。送單時有委託書號 ordno 就一起存，
// 讀取時兩邊都有 ordno 而不同 → 不是同一筆，當成條件未知。
//
// 存在 localStorage，主視窗與彈出視窗共用：寫入前重讀並合併（不整包覆寫別的
// 視窗寫的紀錄），storage 事件時丟掉快取。只保留股票的今日（台北時間當日
// 00:00 起），讀與寫時都修剪，常駐視窗跨日也不會用到昨天的紀錄。
import { useSyncExternalStore } from 'react';
import { taipeiInstant, taipeiParts } from './conditional/session';
import type { Account } from './types/portfolio';

export interface StockOrderConditions {
    /** Cash／MarginTrading／ShortSelling／… */
    cond: string;
    daytradeShort: boolean;
}
interface Entry extends StockOrderConditions { at: number; ordno?: string }
type Entries = Record<string, Entry>;
type AccountRef = Pick<Account, 'broker_id' | 'account_id'> | undefined;
/** 券商識別：seqno 必要，ordno 有就核對 */
export interface BrokerOrderRef { seqno?: string; ordno?: string }

const KEY = 'sj-pro-stock-order-conds';
const keyOf = (account: AccountRef, seqno: string) => `${account?.broker_id ?? ''}:${account?.account_id ?? ''}:${seqno}`;

/** 股票的今日起點（台北時間當日 00:00，epoch 秒） */
export function stockDayStart(nowMs = Date.now()): number {
    const p = taipeiParts(nowMs);
    return taipeiInstant(p.y, p.mo, p.d, 0, 0) / 1000;
}

let cache: Entries | null = null;
let version = 0;
const listeners = new Set<() => void>();

function valid(v: unknown): v is Entry {
    const e = v as Partial<Entry> | null;
    return !!e && typeof e.cond === 'string' && typeof e.daytradeShort === 'boolean' && typeof e.at === 'number'
        && (e.ordno === undefined || typeof e.ordno === 'string');
}

/** 只留今日、格式正確的紀錄 */
function prune(raw: unknown, since: number): Entries {
    const out: Entries = {};
    if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (valid(v) && v.at >= since) out[k] = { cond: v.cond, daytradeShort: v.daytradeShort, at: v.at, ...(v.ordno ? { ordno: v.ordno } : {}) };
        }
    }
    return out;
}

function readStorage(since: number): Entries | null {
    try {
        const text = globalThis.localStorage?.getItem(KEY);
        return prune(text ? JSON.parse(text) : null, since);
    } catch {
        return null; // unreadable / unavailable: callers keep what this window has
    }
}

function current(since: number): Entries {
    cache = prune(cache ?? readStorage(since) ?? {}, since);
    return cache;
}

function changed() {
    version++;
    listeners.forEach(l => l());
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    // 另一個視窗寫入：丟掉快取，下次讀取時重讀
    window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) { cache = null; changed(); } });
}

/** 送單成功時記下這筆股票委託的條件。只是顯示用，失敗不影響送單。沒有 seqno 就不記。 */
export function noteStockOrderConditions(account: Account | undefined, ref: BrokerOrderRef, order: { order_cond?: string; daytrade_short?: boolean }, nowMs = Date.now()) {
    if (!ref.seqno) return;
    const since = stockDayStart(nowMs);
    const entry: Entry = { cond: order.order_cond ?? 'Cash', daytradeShort: order.daytrade_short === true, at: nowMs / 1000, ...(ref.ordno ? { ordno: ref.ordno } : {}) };
    const key = keyOf(account, ref.seqno);
    // merge-on-write：以 storage 現況（其他視窗剛寫的）為底，加上這個視窗的與這一筆
    const stored = readStorage(since);
    cache = { ...current(since), ...(stored ?? {}), [key]: entry };
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full or unavailable: this window still has it in memory */ }
    changed();
}

/** 本 App 送出時記下的條件；查不到、不是今日、或 ordno 對不上＝undefined（條件未知） */
export function stockOrderConditions(account: AccountRef, ref: BrokerOrderRef, nowMs = Date.now()): StockOrderConditions | undefined {
    if (!ref.seqno) return undefined;
    const e = current(stockDayStart(nowMs))[keyOf(account, ref.seqno)];
    if (!e) return undefined;
    if (e.ordno && ref.ordno && e.ordno !== ref.ordno) return undefined;
    return { cond: e.cond, daytradeShort: e.daytradeShort };
}

/** 有新紀錄時讓畫面重算 */
export function useStockOrderConditionsVersion(): number {
    return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version);
}

/** tests only: forget this window's memory (as if another window had written) */
export function resetStockOrderConditionsForTest() {
    cache = null;
    changed();
}
