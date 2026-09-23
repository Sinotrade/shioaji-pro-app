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

// Taken by the window that owns trading state when the mutation settles.
// Other windows (the sender itself, other popouts) never take theirs, so
// entries expire and the map is bounded.
export const INTENT_TTL_MS = 120_000;
const MAX_INTENTS = 200;
const intents = new Map<string, { intent: MutationIntent; at: number }>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-mutation-intent:${getApiBase()}`) : null;

function prune(now: number) {
    for (const [id, entry] of intents) if (now - entry.at > INTENT_TTL_MS) intents.delete(id);
    while (intents.size > MAX_INTENTS) intents.delete(intents.keys().next().value!);
}
function store(tradeId: string, intent: MutationIntent) {
    const now = Date.now();
    intents.delete(tradeId);
    intents.set(tradeId, { intent, at: now });
    prune(now);
}
function valid(intent: unknown): intent is MutationIntent {
    const value = intent as Partial<Record<string, unknown>> | null;
    return !!value && ((value.kind === 'price' && typeof value.price === 'number' && Number.isFinite(value.price))
        || (value.kind === 'qty' && typeof value.quantity === 'number' && Number.isFinite(value.quantity)));
}
channel?.addEventListener('message', event => {
    const data = event.data as { base?: unknown; tradeId?: unknown; intent?: unknown } | null;
    // Same channel name implies the same base; check it anyway so a message
    // for another server can never confirm this one's order.
    if (data?.base !== getApiBase()) return;
    if (typeof data.tradeId === 'string' && data.tradeId && valid(data.intent)) store(data.tradeId, data.intent);
});

export function noteMutationIntent(tradeId: string, intent: MutationIntent) {
    store(tradeId, intent);
    try { channel?.postMessage({ base: getApiBase(), tradeId, intent }); } catch { /* closed window */ }
}
export function takeMutationIntent(tradeId: string): MutationIntent | undefined {
    const entry = intents.get(tradeId);
    intents.delete(tradeId);
    if (!entry || Date.now() - entry.at > INTENT_TTL_MS) return undefined;
    return entry.intent;
}
export function pendingIntentCount() { prune(Date.now()); return intents.size; }
import.meta.hot?.dispose(() => channel?.close());
