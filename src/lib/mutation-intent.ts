// src/lib/mutation-intent.ts — what a price/quantity change asked for, so a
// later active report for the SAME order id can confirm exactly that request.
// Display bookkeeping only: never used to decide whether to send anything.

export type MutationIntent =
    | { kind: 'price'; price: number }
    | { kind: 'qty'; quantity: number }; // reduction sent to update_qty

const intents = new Map<string, MutationIntent>();

export function noteMutationIntent(tradeId: string, intent: MutationIntent) {
    if (intents.size >= 500 && !intents.has(tradeId)) intents.delete(intents.keys().next().value!);
    intents.set(tradeId, intent);
}
export function takeMutationIntent(tradeId: string): MutationIntent | undefined {
    const intent = intents.get(tradeId);
    intents.delete(tradeId);
    return intent;
}
