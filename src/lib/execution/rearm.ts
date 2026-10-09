// src/lib/execution/rearm.ts — 在新盤別重新啟用 (#201, contract v2): the
// quantity a lapsed trigger is watched again with. Never the lapsed order's
// quantity by default when the position says otherwise: the order may have
// filled before it lapsed, or the position may have changed since.

import { useSyncExternalStore } from 'react';
import { getTradingState, subscribeTradingState } from '../trading-state';
import type { PendingConfirmItem } from './pending-confirm-contract';

export interface PositionView {
    /** The positions query has a confirmed answer (not loading, not stale). */
    known: boolean;
    positions: readonly { code: string; direction: 'Buy' | 'Sell'; quantity: number;
        account?: { account_type: string; account_id: string } | null }[];
}

export interface RearmPlan {
    /** The suggested quantity; null = the user must enter it. */
    quantity: number | null;
    notes: string[];
}

/** The order closes a position in the opposite direction: suggest
 * min(original, that position). No such position: it would open one — the
 * user decides. Position unknown: the user decides. */
export function rearmPlan(item: PendingConfirmItem, view: PositionView): RearmPlan {
    const unit = item.order.quantityUnit === 'contract' ? '口' : item.order.quantityUnit === 'lot' ? '張' : '股';
    if (!view.known) return { quantity: null, notes: ['持倉未確認，請到持倉核對後自行輸入數量'] };
    const closes = item.order.action === 'Sell' ? 'Buy' : 'Sell';
    const held = view.positions
        .filter(p => p.code === item.order.code && p.direction === closes
            && p.account?.account_type === item.account.accountType && p.account?.account_id === item.account.accountId)
        .reduce((s, p) => s + p.quantity, 0);
    if (held <= 0) {
        return { quantity: null,
            notes: [`目前沒有可平倉的部位；觸發時會新開部位，請確認後自行輸入數量（原為 ${item.order.quantity} ${unit}）`] };
    }
    if (held < item.order.quantity) {
        return { quantity: held, notes: [`目前可平倉 ${held} ${unit}，比原本的 ${item.order.quantity} ${unit} 少，已改為 ${held} ${unit}`] };
    }
    return { quantity: item.order.quantity, notes: [`目前可平倉 ${held} ${unit}`] };
}

function currentView(): PositionView {
    const s = getTradingState();
    const q = s.queries?.positions;
    const known = !!q && q.updatedAt !== null && !q.needsReconcile && !q.error;
    return { known, positions: s.positions as PositionView['positions'] };
}

export function useRearmPlan(item: PendingConfirmItem): RearmPlan {
    const state = useSyncExternalStore(subscribeTradingState, getTradingState);
    void state; // re-plan whenever the positions change
    return rearmPlan(item, currentView());
}
