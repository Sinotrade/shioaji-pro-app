// #204 盤中零股行情：intraday_odd 的 tick／五檔進獨立 store，永遠不和整股
// 混在一起；跨視窗（shared stream）轉送與重連重播也包含零股。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    owner: true,
    published: [] as { kind: string; name?: string; raw?: string }[],
    options: null as null | { onOwn: () => void; onWire: (wire: { kind: 'event'; name: string; raw: string }) => void },
    post: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: (...args: unknown[]) => (m.post as (...a: unknown[]) => unknown)(...args) }));
vi.mock('./server-info-store', () => ({ knownServerInfo: () => undefined }));
vi.mock('./shared-stream', () => ({
    createSharedStream: (options: typeof m.options) => {
        m.options = options;
        return { isOwner: () => m.owner, publish: (w: (typeof m.published)[number]) => m.published.push(w), close: () => undefined };
    },
}));

type Listener = (event: { data: string }) => void;
class FakeEventSource {
    static last: FakeEventSource | null = null;
    listeners = new Map<string, Listener[]>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { FakeEventSource.last = this; }
    addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
    close() {}
    emit(name: string, data: unknown) { for (const l of this.listeners.get(name) ?? []) l({ data: JSON.stringify(data) }); }
}

const tick = (close: number, volume: number, odd: boolean) => ({ code: '2330', date: '2026/09/30', time: '11:02:25.000000', close: String(close), volume, simtrade: false, intraday_odd: odd });
const bidask = (bid: number, vol: number, odd: boolean) => ({ code: '2330', date: '2026/09/30', time: '11:02:25.000000', bid_price: [String(bid)], bid_volume: [vol], ask_price: [String(bid + 5)], ask_volume: [vol], intraday_odd: odd });

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    m.owner = true; m.published = []; m.options = null;
    m.post = vi.fn(async () => ({ success: true }));
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function owner() {
    const stream = await import('./stream');
    stream.ensureStream();
    m.options!.onOwn();
    return { stream, source: FakeEventSource.last! };
}

it('keeps 盤中零股 ticks and books in their own store and notifies only their listeners', async () => {
    const { stream, source } = await owner();
    const regular = vi.fn(); const odd = vi.fn(); const tape = vi.fn(); const oddTape = vi.fn();
    stream.subscribeQuoteStore('2330', regular);
    stream.subscribeQuoteStore('2330', odd, true);
    stream.onAnyTick(tape); stream.onOddLotTick(oddTape);
    source.emit('tick_stk', tick(2495, 3, false));
    source.emit('bidask_stk', bidask(2495, 591, false));
    source.emit('tick_stk', tick(2500, 125, true));
    source.emit('bidask_stk', bidask(2495, 104264, true));
    await vi.advanceTimersByTimeAsync(60);
    expect(stream.getQuote('2330')?.tick).toMatchObject({ close: '2495', volume: 3 });
    expect(stream.getQuote('2330')?.bidask?.bid_volume).toEqual([591]);
    expect(stream.getQuote('2330', true)?.tick).toMatchObject({ close: '2500', volume: 125 });
    expect(stream.getQuote('2330', true)?.bidask?.bid_volume).toEqual([104264]);
    expect(regular).toHaveBeenCalledTimes(1); expect(odd).toHaveBeenCalledTimes(1);
    // odd trades never reach the regular-lot tape (tick tape / whole-lot triggers)
    expect(tape.mock.calls.map(c => c[0].close)).toEqual(['2495']);
    expect(oddTape.mock.calls.map(c => c[0].close)).toEqual(['2500']);
    // an odd-only update wakes only odd-lot consumers
    source.emit('bidask_stk', bidask(2490, 5000, true));
    await vi.advanceTimersByTimeAsync(60);
    expect(regular).toHaveBeenCalledTimes(1); expect(odd).toHaveBeenCalledTimes(2);
    expect(stream.getQuote('2330')?.bidask?.bid_price).toEqual(['2495']);
});

it('forwards odd-lot events to other windows and a follower files them in its odd-lot store', async () => {
    const { source } = await owner();
    source.emit('tick_stk', tick(2500, 125, true));
    expect(m.published.some(w => w.name === 'tick_stk' && JSON.parse(w.raw!).intraday_odd === true)).toBe(true);

    vi.resetModules();
    m.owner = false;
    const follower = await import('./stream');
    follower.ensureStream();
    m.options!.onWire({ kind: 'event', name: 'tick_stk', raw: JSON.stringify(tick(2500, 125, true)) });
    m.options!.onWire({ kind: 'event', name: 'bidask_stk', raw: JSON.stringify(bidask(2495, 104264, true)) });
    expect(follower.getQuote('2330')).toBeUndefined();
    expect(follower.getQuote('2330', true)?.tick?.close).toBe('2500');
    expect(follower.getQuote('2330', true)?.bidask?.bid_volume).toEqual([104264]);
});

it('registers odd-lot subscriptions separately and replays both after a reconnect', async () => {
    const { stream, source } = await owner();
    const body = (odd: boolean, quote_type: string) => ({ security_type: 'STK', exchange: 'TSE', code: '2330', target_code: null, quote_type, intraday_odd: odd });
    for (const type of ['Tick', 'BidAsk']) { stream.registerSubscription(body(false, type)); stream.registerSubscription(body(true, type)); }
    expect(stream.getSubscriptionCount()).toBe(4);
    stream.unregisterSubscription('2330', 'BidAsk', true);
    expect(stream.getRegisteredSubscriptions()).toEqual([body(false, 'Tick'), body(true, 'Tick'), body(false, 'BidAsk')]);
    source.onopen!(); // first open after taking ownership replays once
    await vi.advanceTimersByTimeAsync(0);
    m.post.mockClear();
    source.onerror!(); // drop → reconnect → replay
    await vi.advanceTimersByTimeAsync(1000);
    FakeEventSource.last!.onopen!();
    await vi.advanceTimersByTimeAsync(0);
    const replayed = m.post.mock.calls.filter(c => c[0] === '/api/v1/stream/subscribe').map(c => c[1]);
    expect(replayed).toEqual([body(false, 'Tick'), body(true, 'Tick'), body(false, 'BidAsk')]);
});
