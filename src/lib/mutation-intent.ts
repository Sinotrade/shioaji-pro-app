// src/lib/mutation-intent.ts — what a price/quantity change asked for, so a
// later active report for the SAME order id can confirm exactly that request.
// Display bookkeeping only: never used to decide whether to send anything.
//
// A popout sends its own changes, but the main window owns the shared trading
// state, so intents are mirrored to every window of the same API base.
import { getApiBase } from './runtime';

export type MutationIntent =
    | { kind: 'price'; price: number }
    | { kind: 'qty'; quantity: number }; // reduction sent to update_qty

const intents = new Map<string, MutationIntent>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-mutation-intent:${getApiBase()}`) : null;

function store(tradeId: string, intent: MutationIntent) {
    if (intents.size >= 500 && !intents.has(tradeId)) intents.delete(intents.keys().next().value!);
    intents.set(tradeId, intent);
}
function valid(intent: unknown): intent is MutationIntent {
    const value = intent as Partial<Record<string, unknown>> | null;
    return !!value && ((value.kind === 'price' && typeof value.price === 'number' && Number.isFinite(value.price))
        || (value.kind === 'qty' && typeof value.quantity === 'number' && Number.isFinite(value.quantity)));
}
channel?.addEventListener('message', event => {
    const data = event.data as { tradeId?: unknown; intent?: unknown } | null;
    if (typeof data?.tradeId === 'string' && data.tradeId && valid(data.intent)) store(data.tradeId, data.intent);
});

export function noteMutationIntent(tradeId: string, intent: MutationIntent) {
    store(tradeId, intent);
    try { channel?.postMessage({ tradeId, intent }); } catch { /* closed window */ }
}
export function takeMutationIntent(tradeId: string): MutationIntent | undefined {
    const intent = intents.get(tradeId);
    intents.delete(tradeId);
    return intent;
}
import.meta.hot?.dispose(() => channel?.close());
