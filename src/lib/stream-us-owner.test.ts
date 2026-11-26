// src/lib/stream-us-owner.test.ts — 美股 SSE 跟著串流擁有權：交出時關、
// 接手時替這個視窗已有的美股訂閱重新開（Codex review）

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    marks: [] as [string, string | undefined][], child: false, autoOwn: true,
    forget: vi.fn(),
    claim: null as null | (() => void), release: null as null | (() => void),
    wants: new Map<string, boolean>(),
    remote: null as null | ((keys: ReadonlySet<string>) => void),
    published: [] as unknown[], wire: null as null | ((w: unknown) => void),
    apiGet: vi.fn(),
}));
vi.mock('./shared-stream', () => ({
    createSharedStream: (options: { onOwn: () => void; onRelease: () => void; onRemoteWants?: (keys: ReadonlySet<string>) => void; onWire?: (w: unknown) => void }) => {
        m.wire = (w) => options.onWire?.(w);
        let owner = false;
        m.remote = (keys) => options.onRemoteWants?.(keys);
        m.claim = () => { owner = true; options.onOwn(); };
        m.release = () => { owner = false; options.onRelease(); };
        if (m.autoOwn) m.claim();
        return { isOwner: () => owner, publish: (w: unknown) => { m.published.push(w); }, want: (key: string, on: boolean) => { m.wants.set(key, on); } };
    },
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: vi.fn(), apiGet: m.apiGet }));
vi.mock('./server-info-store', () => ({ forgetServerInfo: m.forget, knownServerInfo: () => ({ simulation: true }) }));
vi.mock('./startup-timing', () => ({ markStage: (s: string, d?: string) => m.marks.push([s, d]) }));
vi.mock('./window-role', () => ({ isChildWindow: () => m.child }));

type Listener = (event: { data: string }) => void;
class FakeEventSource {
    static all: FakeEventSource[] = [];
    listeners = new Map<string, Listener[]>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) { FakeEventSource.all.push(this); }
    addEventListener(name: string, l: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), l]); }
    close() { this.closed = true; }
    emit(name: string, data = '{}') { for (const l of this.listeners.get(name) ?? []) l({ data }); }
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.all = [];
    m.marks = [];
    m.forget.mockClear();
    m.child = false;
    m.autoOwn = true;
    m.claim = null;
    m.release = null;
    m.wants.clear();
    m.remote = null;
    m.published = [];
    m.wire = null;
    m.apiGet.mockReset();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const usSources = () => FakeEventSource.all.filter(s => /(tick|bidask)_stk_us|us_(tick|bidask)/.test(s.url));
const openUs = () => usSources().filter(s => !s.closed);

it('closes the US SSEs when ownership moves away and re-opens them for existing holds', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    const release = stream.retainUsQuoteStreams();
    expect(openUs()).toHaveLength(2);

    m.release!();
    expect(openUs()).toHaveLength(0);
    // 非擁有者的重開計時也不會偷開
    vi.advanceTimersByTime(10_000);
    expect(openUs()).toHaveLength(0);

    m.claim!();
    expect(openUs()).toHaveLength(2);
    release();
    expect(openUs()).toHaveLength(0);
});

it('a follower holding US quotes opens nothing until it takes ownership', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    expect(usSources()).toHaveLength(0);
    m.claim!();
    expect(openUs()).toHaveLength(2);
});

it('taking ownership without US holds opens no US SSE', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.ensureStream();
    m.claim!();
    expect(usSources()).toHaveLength(0);
});

it('owner opens US SSEs for a popout-only US hold and closes them when the popout goes away', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    expect(usSources()).toHaveLength(0);
    // 主視窗自己沒有美股訂閱；只有彈出視窗有
    m.remote!(new Set(['us-quotes']));
    expect(openUs()).toHaveLength(2);
    m.remote!(new Set());
    expect(openUs()).toHaveLength(0);
});

it('a local release keeps the US SSEs open while a popout still wants them', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    const release = stream.retainUsQuoteStreams();
    m.remote!(new Set(['us-quotes']));
    release();
    expect(openUs()).toHaveLength(2);
    m.remote!(new Set());
    expect(openUs()).toHaveLength(0);
});

it('a follower announces its US hold to the owner and withdraws it on release', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.ensureStream();
    const release = stream.retainUsQuoteStreams();
    expect(m.wants.get('us-quotes')).toBe(true);
    release();
    expect(m.wants.get('us-quotes')).toBe(false);
});

it('a hold taken before the shared stream exists is announced once it is created', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.retainUsQuoteStreams();
    expect(m.wants.size).toBe(0);
    stream.ensureStream();
    expect(m.wants.get('us-quotes')).toBe(true);
});

it('signals a US tick stream reset when the US tick SSE drops and again when it reconnects', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    const resets = vi.fn();
    stream.onUsTickStreamReset(resets);
    const tickSource = () => openUs().find(s => /tick_stk_us|us_tick/.test(s.url))!;
    tickSource().onopen?.();
    expect(resets).not.toHaveBeenCalled();
    // 只有美股 bidask 斷線：成交沒有漏收，不作廢
    openUs().find(s => /bidask_stk_us|us_bidask/.test(s.url))!.onerror?.();
    expect(resets).not.toHaveBeenCalled();
    tickSource().onerror?.();
    expect(resets).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    tickSource().onopen?.();
    expect(resets).toHaveBeenCalledTimes(2);
});

it('relays the US tick stream reset to popouts over the shared wire, and a follower dispatches it locally', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    openUs().find(s => /tick_stk_us|us_tick/.test(s.url))!.onerror?.();
    const resetWire = m.published.find(w => (w as { kind: string; name?: string }).kind === 'event'
        && !/^((tick|bidask)_stk_us|us_(tick|bidask))$/.test((w as { name: string }).name) && (w as { raw: string }).raw === '');
    expect(resetWire).toBeDefined();

    // 彈出視窗（非擁有者）：收到同一則 wire 就通知自己的監聽者
    vi.resetModules();
    m.autoOwn = false;
    const follower = await import('./stream');
    follower.ensureStream();
    const resets = vi.fn();
    follower.onUsTickStreamReset(resets);
    m.wire!(resetWire);
    expect(resets).toHaveBeenCalledTimes(1);
});

// SDK 1.8.0（shioaji MR !525）改名：tick_stk_us／bidask_stk_us；1.8.0b1–b3 是 us_tick／us_bidask
const AAPL_TICK = JSON.stringify({ code: 'AAPL', exchange: 'NASDAQ', datetime: 1795033805000000, price: '231.45', volume: 100, total_volume: 5000, session: 'Regular' });

it('opens the SDK 1.8.0 US stream paths by default', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    expect(openUs().map(s => s.url).sort()).toEqual([
        'http://fixture.invalid/api/v1/stream/data/bidask_stk_us',
        'http://fixture.invalid/api/v1/stream/data/tick_stk_us',
    ]);
});

it('accepts both the new and the legacy US event names on the US streams', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    const tick = openUs().find(s => /tick_stk_us/.test(s.url))!;
    const seen = vi.fn();
    stream.onAnyTick(seen);
    tick.emit('tick_stk_us', AAPL_TICK);
    tick.emit('us_tick', AAPL_TICK);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(stream.getQuote('US:AAPL')?.tick?.close).toBe('231.45');
    const names = m.published.map(w => (w as { name?: string }).name);
    expect(names).toContain('tick_stk_us');
    expect(names).toContain('us_tick');
});

it('falls back to the legacy US paths when the sidecar answers 404, and remembers it', async () => {
    m.apiGet.mockRejectedValue(Object.assign(new Error('404 Not Found'), { status: 404 }));
    const stream = await import('./stream');
    stream.ensureStream();
    const release = stream.retainUsQuoteStreams();
    // 舊 sidecar：新路徑從沒開成功就斷
    for (const s of openUs()) s.onerror?.();
    await vi.waitFor(() => expect(openUs()).toHaveLength(2));
    expect(m.apiGet).toHaveBeenCalledWith('/api/v1/stream/data/tick_stk_us', expect.anything());
    expect(openUs().map(s => s.url).sort()).toEqual([
        'http://fixture.invalid/api/v1/stream/data/us_bidask',
        'http://fixture.invalid/api/v1/stream/data/us_tick',
    ]);
    // 之後重開（同一個 sidecar）直接走舊路徑，不再試新路徑
    release();
    m.apiGet.mockClear();
    stream.retainUsQuoteStreams();
    expect(openUs().map(s => s.url).every(u => /us_(tick|bidask)$/.test(u))).toBe(true);
    expect(m.apiGet).not.toHaveBeenCalled();
});

it('keeps the new paths when the probe does not see a 404 (sidecar down)', async () => {
    m.apiGet.mockRejectedValue(new TypeError('Failed to fetch'));
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    for (const s of openUs()) s.onerror?.();
    await Promise.resolve(); await Promise.resolve();
    expect(openUs()).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    expect(openUs().map(s => s.url).every(u => /(tick|bidask)_stk_us$/.test(u))).toBe(true);
});

it('does not probe when an opened US stream drops later', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    for (const s of openUs()) { s.onopen?.(); s.onerror?.(); }
    expect(m.apiGet).not.toHaveBeenCalled();
});

it('a follower dispatches US quotes relayed under either event name', async () => {
    m.autoOwn = false;
    const stream = await import('./stream');
    stream.ensureStream();
    const ticks = vi.fn();
    const off = stream.onAnyTick(ticks);
    m.wire!({ kind: 'event', name: 'tick_stk_us', raw: AAPL_TICK });
    m.wire!({ kind: 'event', name: 'us_tick', raw: AAPL_TICK });
    expect(ticks).toHaveBeenCalledTimes(2);
    off();
});

it('when both US path variants 404, only one immediate fallback reopen; later ones wait for the reconnect timer (Codex P1)', async () => {
    m.apiGet.mockRejectedValue(Object.assign(new Error('404 Not Found'), { status: 404 }));
    const stream = await import('./stream');
    stream.ensureStream();
    stream.retainUsQuoteStreams();
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    // 新路徑 404 → 馬上改開舊路徑（一次）
    for (const s of openUs()) s.onerror?.();
    await flush();
    expect(openUs().map(s => s.url).every(u => /us_(tick|bidask)$/.test(u))).toBe(true);
    expect(openUs()).toHaveLength(2);
    // 舊路徑也 404：不再馬上重開，等 3 秒重連
    const created = usSources().length;
    for (const s of openUs()) s.onerror?.();
    await flush();
    expect(usSources().length).toBe(created);
    expect(openUs()).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    expect(openUs()).toHaveLength(2);
    // 這次又失敗：仍然只走計時器，不會在同一個 tick 裡一直重開
    for (const s of openUs()) s.onerror?.();
    await flush();
    expect(openUs()).toHaveLength(0);
});
