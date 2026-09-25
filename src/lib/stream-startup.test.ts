// src/lib/stream-startup.test.ts — first connection of a page: a failing
// first attempt retries after 250 ms (not the 1 s → 2 s backoff) a few
// times, then normal backoff; each step is recorded for startup timing (#142)

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ marks: [] as [string, string | undefined][], child: false }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: vi.fn() }));
vi.mock('./server-info-store', () => ({ knownServerInfo: () => ({ simulation: true }) }));
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
    emit(name: string) { for (const l of this.listeners.get(name) ?? []) l({ data: '{}' }); }
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.all = [];
    m.marks = [];
    m.child = false;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const last = () => FakeEventSource.all.at(-1)!;

it('first attempts that fail retry after 250 ms, and opening is recorded', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    last().onerror!();
    vi.advanceTimersByTime(249);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2); // was 1000 ms
    last().onerror!();
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.all).toHaveLength(3); // was a further 2000 ms
    last().onopen!();
    last().emit('heartbeat');
    expect(stream.getStreamStatus()).toBe('live');
    const page = expect.stringMatching(/^page=\S+/);
    expect(m.marks.map(([s]) => s)).toEqual(['stream-connect', 'stream-error', 'stream-error', 'stream-open', 'stream-heartbeat']);
    expect(m.marks[0]![1]).toEqual(page);
    expect(m.marks[1]![1]).toMatch(/^page=\S+ failure=1 retry=250ms$/);
    expect(m.marks[2]![1]).toMatch(/^page=\S+ failure=2 retry=250ms$/);
    expect(m.marks[3]![1]).toMatch(/^page=\S+ failures=2 after=\d+ms$/);
});

it('after the fast retries the normal backoff applies unchanged', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    for (let i = 0; i < stream.STARTUP_FAST_RETRIES; i++) {
        last().onerror!();
        vi.advanceTimersByTime(stream.STARTUP_RETRY_MS);
    }
    const n = FakeEventSource.all.length;
    last().onerror!(); // 4th failure: 1 s backoff
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.all).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(n + 1);
    last().onerror!(); // then 2 s
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.all).toHaveLength(n + 1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(n + 2);
});

it('a drop right after opening (page still starting) also retries fast', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    last().onopen!();
    last().onerror!();
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(m.marks.find(([s]) => s === 'stream-error')![1]).toMatch(/failure=1 after open retry=250ms$/);
    expect(stream.streamOpenedAt()).not.toBeNull();
});

it('once the page\'s stream has opened and startup is over, outages use the normal backoff', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    last().onopen!();
    vi.spyOn(performance, 'now').mockReturnValue(stream.STARTUP_WINDOW_MS + 1);
    last().onerror!();
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(m.marks.filter(([s]) => s === 'stream-error')).toEqual([]);
});

it('child windows record nothing', async () => {
    m.child = true;
    const stream = await import('./stream');
    stream.ensureStream();
    last().onerror!();
    vi.advanceTimersByTime(250);
    last().onopen!();
    expect(m.marks).toEqual([]);
});

it('a held stream connects only on release (or when the hold expires)', async () => {
    const stream = await import('./stream');
    stream.holdStream();
    stream.ensureStream(); // the dashboard mounts
    expect(FakeEventSource.all).toHaveLength(0);
    stream.releaseStream('server confirmed');
    expect(FakeEventSource.all).toHaveLength(1);
    expect(m.marks[0]![1]).toMatch(/server confirmed$/);
});

it('a hold nobody releases expires and connects anyway', async () => {
    const stream = await import('./stream');
    stream.holdStream();
    stream.ensureStream();
    vi.advanceTimersByTime(stream.STREAM_HOLD_MAX_MS);
    expect(FakeEventSource.all).toHaveLength(1);
});

it('a hold after the stream started is a no-op', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    stream.holdStream();
    stream.releaseStream();
    expect(FakeEventSource.all).toHaveLength(1);
});
