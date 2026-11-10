// src/lib/stock-order-conditions.ts — 本 App 送出的股票委託的信用條件與
// 現股當沖先賣旗標（PR #400 review）。
//
// 委託回報（StockOrderEvent）只帶 order_cond，不帶 daytrade_short；sw relay
// 的 place_order／update_status 回應也不回填 daytrade_short（rshioaji
// types.rs：「None for every server-sourced Trade」）。所以「這筆賣出是不是
// 現沖先賣」只能從送單當下的請求得知：送單成功拿到委託 id 後在這裡記下，
// 委託合計（lib/flash-order-totals）用它判斷先賣與回補。
// 不是本 App 送的委託（其他下單軟體、別台電腦）查不到 → 呼叫端視為「條件未知」，
// 不猜成現股。
//
// 存在 localStorage（同一個來源的彈出視窗共用），只保留本交易日。
import { useSyncExternalStore } from 'react';
import { tradingDayStart } from './futures-fifo';
import type { Account } from './types/portfolio';

export interface StockOrderConditions {
    /** Cash／MarginTrading／ShortSelling／… */
    cond: string;
    daytradeShort: boolean;
}
interface Entry extends StockOrderConditions { at: number }

const KEY = 'sj-pro-stock-order-conds';
const keyOf = (account: Pick<Account, 'broker_id' | 'account_id'> | undefined, orderId: string) =>
    `${account?.broker_id ?? ''}:${account?.account_id ?? ''}:${orderId}`;

let entries: Record<string, Entry> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, Entry> {
    if (entries) return entries;
    let parsed: unknown = null;
    try { parsed = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null'); } catch { /* unreadable: start empty */ }
    const since = tradingDayStart(Date.now() / 1000);
    const out: Record<string, Entry> = {};
    if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, Partial<Entry>>)) {
            if (v && typeof v.cond === 'string' && typeof v.daytradeShort === 'boolean' && typeof v.at === 'number' && v.at >= since) {
                out[k] = { cond: v.cond, daytradeShort: v.daytradeShort, at: v.at };
            }
        }
    }
    entries = out;
    return out;
}

function changed() {
    version++;
    listeners.forEach(l => l());
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    // 另一個視窗送的單：重新讀
    window.addEventListener('storage', e => { if (e.key === KEY) { entries = null; changed(); } });
}

/** 送單成功（拿到委託 id）時記下這筆股票委託的條件。只是顯示用，失敗不影響送單。 */
export function noteStockOrderConditions(account: Account | undefined, orderId: string, order: { order_cond?: string; daytrade_short?: boolean }) {
    if (!orderId) return;
    try {
        const all = load();
        all[keyOf(account, orderId)] = { cond: order.order_cond ?? 'Cash', daytradeShort: order.daytrade_short === true, at: Date.now() / 1000 };
        globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
    } catch { /* storage full or unavailable: this window still has it in memory */ }
    changed();
}

/** 本 App 送出時記下的條件；查不到＝不是本 App 送的（或已過交易日） */
export function stockOrderConditions(account: Pick<Account, 'broker_id' | 'account_id'> | undefined, orderId: string): StockOrderConditions | undefined {
    const e = load()[keyOf(account, orderId)];
    return e ? { cond: e.cond, daytradeShort: e.daytradeShort } : undefined;
}

/** 有新紀錄時讓畫面重算 */
export function useStockOrderConditionsVersion(): number {
    return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version);
}

/** tests only */
export function resetStockOrderConditionsForTest() {
    entries = null;
    changed();
}
