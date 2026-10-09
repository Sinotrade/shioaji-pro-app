// src/lib/execution/rearm.ts — 在新盤別重新啟用 (#201, contract v2): the
// quantity a lapsed trigger is watched again with. Never the lapsed order's
// quantity by default, never an old position snapshot: the order may have
// filled before it lapsed, or the position may have changed since. Positions
// are read again when the confirmation opens and matched by the full
// account (broker + account id), from a read of that account alone.

import { createAccountQuery } from '../account-query';
import { fetchPositions } from '../shioaji';
import type { PendingConfirmItem } from './pending-confirm-contract';

/** What a rearm protects: a 委託待確認 item, or a lapsed background bracket
 * (its exit: action closes the held position). */
export interface RearmSubject {
    order: Pick<PendingConfirmItem['order'], 'code' | 'action' | 'quantity' | 'quantityUnit'>;
    account: PendingConfirmItem['account'];
}

export interface PositionView {
    /** A confirmed positions answer read after the confirmation opened. */
    known: boolean;
    positions: readonly { code: string; direction: 'Buy' | 'Sell'; quantity: number;
        account?: { account_type: string; broker_id?: string; account_id: string } | null }[];
}

export interface RearmPlan {
    /** The suggested quantity; null = the user must enter it. */
    quantity: number | null;
    /** The position this order would close, when known (> 0). */
    closable: number | null;
    notes: string[];
}

const unitOf = (item: RearmSubject) =>
    item.order.quantityUnit === 'contract' ? '口' : item.order.quantityUnit === 'lot' ? '張' : '股';

/** Closable position of the item's full account, or null when not known. */
function closableOf(item: RearmSubject, view: PositionView): number | null {
    if (!view.known || !item.account.brokerId) return null;
    const closes = item.order.action === 'Sell' ? 'Buy' : 'Sell';
    return view.positions
        .filter(p => p.code === item.order.code && p.direction === closes && p.account?.account_type === item.account.accountType
            && p.account?.broker_id === item.account.brokerId && p.account?.account_id === item.account.accountId)
        .reduce((s, p) => s + p.quantity, 0);
}

/** The order closes a position in the opposite direction: suggest
 * min(original, that position). No such position: it would open one — the
 * user decides. Position unknown: the user decides. */
export function rearmPlan(item: RearmSubject, view: PositionView): RearmPlan {
    const unit = unitOf(item);
    const held = closableOf(item, view);
    if (held === null) return { quantity: null, closable: null, notes: ['持倉未確認（重新查詢中或無法比對帳戶），請到持倉核對後自行輸入數量'] };
    if (held <= 0) {
        return { quantity: null, closable: null,
            notes: [`目前沒有可平倉的部位；觸發時會新開部位，請確認後自行輸入數量（原為 ${item.order.quantity} ${unit}）`] };
    }
    if (held < item.order.quantity) {
        return { quantity: held, closable: held,
            notes: [`目前可平倉 ${held} ${unit}，比原本的 ${item.order.quantity} ${unit} 少，已改為 ${held} ${unit}`] };
    }
    return { quantity: item.order.quantity, closable: held, notes: [`目前可平倉 ${held} ${unit}`] };
}

/** Right before the decision is sent: more than the closable position is
 * refused (null = fine). Without a closable position the typed quantity
 * stands — the confirmation already says it opens / is unconfirmed. */
export function checkRearmQuantity(item: RearmSubject, quantity: number, view: PositionView): string | null {
    const held = closableOf(item, view);
    if (held === null || held <= 0 || quantity <= held) return null;
    return `目前可平倉只有 ${held} ${unitOf(item)}，不能超過；請改小數量或先核對持倉`;
}

/** This account's positions, read now on their own (not the shared
 * positions view, its throttle or its other accounts): the only basis for
 * the suggestion and the cap. */
export async function fetchAccountPositions(item: RearmSubject): Promise<PositionView> {
    const brokerId = item.account.brokerId;
    if (!brokerId) throw new Error('沒有券商代號，無法比對帳戶');
    const type = item.account.accountType === 'F' ? 'F' : 'S';
    const selector = { broker_id: brokerId, account_id: item.account.accountId };
    const rows = await createAccountQuery().read(type, selector, current => fetchPositions(type, current));
    const account = { account_type: type, broker_id: brokerId, account_id: item.account.accountId };
    return { known: true, positions: rows.map(r => ({ code: r.code, direction: r.direction, quantity: r.quantity, account })) };
}
