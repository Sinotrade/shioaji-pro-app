import type { ContractBase } from './types/contract';

type Lot = 'Common' | 'IntradayOdd' | 'Odd';
type Scope = 'ticket' | 'grid' | 'flash' | 'chart';
const KEY = 'sj-pro-order-lot-preferences';

/** 各下單面板按商品代碼記住單位；不保存數量，也不改其他已開面板的單位。 */
export function loadOrderLotPreference<T extends Lot>(
    scope: Scope, contract: ContractBase, supported: readonly T[], fallback: T,
): T {
    if (contract.security_type !== 'STK') return fallback;
    try {
        const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}')?.[scope]?.[contract.code];
        return supported.includes(saved) ? saved : fallback;
    } catch {
        return fallback;
    }
}

export function saveOrderLotPreference(scope: Scope, contract: ContractBase, lot: Lot): void {
    if (contract.security_type !== 'STK') return;
    try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}');
        const all = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const entries = all[scope] && typeof all[scope] === 'object' && !Array.isArray(all[scope]) ? all[scope] : {};
        globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...all, [scope]: { ...entries, [contract.code]: lot } }));
    } catch { /* quota / private mode: the panel still keeps its in-memory preference */ }
}

export const TICKET_LOTS = ['Common', 'IntradayOdd', 'Odd'] as const;
export const QUICK_ORDER_LOTS = ['Common', 'IntradayOdd'] as const;
