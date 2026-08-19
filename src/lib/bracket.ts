// src/lib/bracket.ts — bracket orders: after an entry order FILLS, an OCO
// stop-loss + take-profit trigger pair is armed automatically. Activation
// is detected via order_event deals plus a trades-polling fallback.

import { onOrderEvent } from './stream';
import { fetchTrades } from './kgi';
import { notify } from './trade';
import { addTrigger } from './trigger-engine';
import type { Action } from './types/order';

interface PendingBracket {
    orderId: string; // Trade.order.id
    seqno: string;
    code: string; // display code for triggers/quotes
    action: Action; // entry direction
    quantity: number;
    stopPrice: number | null;
    takePrice: number | null;
    accountType: 'S' | 'F';
}

const pending = new Map<string, PendingBracket>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function registerBracket(b: PendingBracket) {
    if (b.stopPrice === null && b.takePrice === null) return;
    pending.set(b.orderId, b);
    notify({
        kind: 'info',
        title: '🧷 括號單待命',
        body: `${b.code} 成交後自動掛${b.stopPrice !== null ? ` 停損@${b.stopPrice}` : ''}${b.takePrice !== null ? ` 停利@${b.takePrice}` : ''}`,
    });
    ensureWatcher();
}

function activate(b: PendingBracket, filledQty: number) {
    pending.delete(b.orderId);
    const exit: Action = b.action === 'Buy' ? 'Sell' : 'Buy';
    const group = `oco-${b.orderId.slice(0, 10)}`;
    const qty = Math.min(filledQty || b.quantity, b.quantity);
    if (b.stopPrice !== null) {
        addTrigger({
            code: b.code,
            // long: stop fires below; short: stop fires above
            condition: b.action === 'Buy' ? 'below' : 'above',
            price: b.stopPrice,
            action: exit,
            quantity: qty,
            kind: 'stop',
            group,
        });
    }
    if (b.takePrice !== null) {
        addTrigger({
            code: b.code,
            condition: b.action === 'Buy' ? 'above' : 'below',
            price: b.takePrice,
            action: exit,
            quantity: qty,
            kind: 'take',
            group,
        });
    }
    notify({
        kind: 'ok',
        title: '🧷 括號單已啟動',
        body: `${b.code} 進場成交 → OCO 停損/停利已掛`,
    });
}

async function pollPending() {
    if (pending.size === 0) return;
    const types = new Set([...pending.values()].map((b) => b.accountType));
    for (const t of types) {
        try {
            const trades = await fetchTrades(t);
            for (const b of [...pending.values()]) {
                if (b.accountType !== t) continue;
                const trade = trades.find(
                    (x) =>
                        x.order.id === b.orderId ||
                        (b.seqno && x.order.seqno === b.seqno),
                );
                if (!trade) continue;
                const st = trade.status.status;
                if (trade.status.deal_quantity > 0) {
                    activate(b, trade.status.deal_quantity);
                } else if (
                    st === 'Cancelled' ||
                    st === 'Failed' ||
                    st === 'Inactive'
                ) {
                    pending.delete(b.orderId);
                    notify({
                        kind: 'info',
                        title: '🧷 括號單取消',
                        body: `${b.code} 進場單未成交（${st}），保護單不掛`,
                    });
                }
            }
        } catch {
            // retry next round
        }
    }
}

function ensureWatcher() {
    if (pollTimer) return;
    pollTimer = setInterval(pollPending, 4000);
    // fast path: deal events over SSE
    onOrderEvent((ev) => {
        if (pending.size === 0 || ev.kind !== 'deal' || !ev.seqno) return;
        for (const b of [...pending.values()]) {
            if (b.seqno && b.seqno === ev.seqno) {
                activate(b, ev.quantity);
            }
        }
    });
}

