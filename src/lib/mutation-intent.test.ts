import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A popout records the intent in its own module; the main window (which owns
// trading-state) must receive it over the same-base BroadcastChannel.
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid' }));
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
beforeEach(() => { vi.resetModules(); FakeChannel.all = []; vi.stubGlobal('BroadcastChannel', FakeChannel); });
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
    for (const data of [null, { tradeId: 'x' }, { tradeId: 'x', intent: { kind: 'price', price: 'NaN' } }, { tradeId: '', intent: { kind: 'qty', quantity: 1 } }, { tradeId: 'x', intent: { kind: 'cancel' } }]) {
        channel.handlers.forEach(h => h({ data }));
    }
    expect(main.takeMutationIntent('x')).toBeUndefined();
});
