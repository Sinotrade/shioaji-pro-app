// Observe successful request responses for display metadata (e.g. futures grid
// tags missing from SSE). This never sends a broker request or authorizes an order.
import { getApiBase } from './runtime';
import type { Trade } from './types/order';
import type { Account } from './types/portfolio';
export interface TradeObservation { trade: Trade; account?: Account }
const listeners = new Set<(value: TradeObservation) => void>();
function emit(value: TradeObservation) {
    // A display consumer must never turn an accepted broker response into a
    // failed order promise (which could invite an unsafe retry).
    for (const listener of listeners) {
        try { listener(value); } catch { /* a later event/manual reconciliation can recover the view */ }
    }
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-trade-responses:${getApiBase()}`) : null;
channel?.addEventListener('message', event => {
    if (event.data?.trade?.order?.id && event.data.trade.status) emit(event.data);
});
export function observeTradeResponse(trade: Trade, account?: Account): Trade {
    const observation = { trade, account };
    emit(observation);
    try { channel?.postMessage(observation); } catch { /* closed WebView/HMR transport cannot fail an order */ }
    return trade;
}
export function onTradeResponse(listener: (value: TradeObservation) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
import.meta.hot?.dispose(() => channel?.close());
