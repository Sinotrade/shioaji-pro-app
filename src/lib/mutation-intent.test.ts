import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A popout records the intent in its own module; the main window (which owns
// trading-state) must receive it over the same-base BroadcastChannel.
const m = vi.hoisted(() => ({ base: 'http://fixture.invalid' }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
type Handler = (event: { data: unknown }) => void;
class FakeChannel {
    static all: FakeChannel[] = [];
    handlers: Handler[] = [];
    posted: unknown[] = [];
    constructor(public name: string) { FakeChannel.all.push(this); }
    addEventListener(_: string, handler: Handler) { this.handlers.push(handler); }
    postMessage(data: unknown) { this.posted.push(data); for (const peer of FakeChannel.all) if (peer !== this && peer.name === this.name) peer.handlers.forEach(h => h({ data })); }
    close() {}
}
beforeEach(() => { m.base = 'http://fixture.invalid'; vi.resetModules(); FakeChannel.all = []; vi.stubGlobal('BroadcastChannel', FakeChannel); });
afterEach(() => vi.unstubAllGlobals());

it('delivers a popout intent to the main window, keyed by order id', async () => {
    const main = await import('./mutation-intent');
    vi.resetModules();
    const popout = await import('./mutation-intent');
    expect(FakeChannel.all.map(c => c.name)).toEqual(['sj-mutation-intent:http://fixture.invalid', 'sj-mutation-intent:http://fixture.invalid']);
    popout.noteMutationIntent('fx04', { kind: 'qty', quantity: 1 });
    expect(main.takeMutationIntent('fx04')).toEqual({ kind: 'qty', quantity: 1 });
    expect(main.takeMutationIntent('fx04')).toBeUndefined(); // taken once
    expect(popout.takeMutationIntent('fx04')).toEqual({ kind: 'qty', quantity: 1 }); // sender keeps its own copy
});

it('ignores malformed broadcast intents', async () => {
    const main = await import('./mutation-intent');
    const channel = FakeChannel.all[0]!;
    for (const data of [null, { base: 'http://fixture.invalid', tradeId: 'x' }, { tradeId: 'x', intent: { kind: 'price', price: 'NaN' } }, { tradeId: '', intent: { kind: 'qty', quantity: 1 } }, { tradeId: 'x', intent: { kind: 'cancel' } }]) {
        channel.handlers.forEach(h => h({ data }));
    }
    expect(main.takeMutationIntent('x')).toBeUndefined();
});

it('drops an intent broadcast for another API base', async () => {
    const main = await import('./mutation-intent');
    FakeChannel.all[0]!.handlers.forEach(h => h({ data: { base: 'http://other.invalid', tradeId: 'x', intent: { kind: 'qty', quantity: 1 } } }));
    FakeChannel.all[0]!.handlers.forEach(h => h({ data: { tradeId: 'y', intent: { kind: 'qty', quantity: 1 } } }));
    expect(main.takeMutationIntent('x')).toBeUndefined();
    expect(main.takeMutationIntent('y')).toBeUndefined();
});

it('expires and bounds intents that are never taken (popout-local copies)', async () => {
    vi.useFakeTimers();
    try {
        const popout = await import('./mutation-intent');
        for (let i = 0; i < 500; i++) popout.noteMutationIntent(`id${i}`, { kind: 'price', price: i });
        expect(popout.pendingIntentCount()).toBeLessThanOrEqual(200);
        vi.advanceTimersByTime(popout.INTENT_TTL_MS + 1);
        expect(popout.pendingIntentCount()).toBe(0);
        popout.noteMutationIntent('late', { kind: 'price', price: 1 });
        vi.advanceTimersByTime(popout.INTENT_TTL_MS + 1);
        expect(popout.takeMutationIntent('late')).toBeUndefined();
    } finally { vi.useRealTimers(); }
});
