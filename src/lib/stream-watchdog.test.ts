import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Real stream.ts with a fake EventSource: the heartbeat watchdog must mark a
// silent-but-open connection STALE, close it and reconnect — and never issue
// any accounting request itself (#75).
const m = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: m.post }));
vi.mock('./server-info-store', () => ({ knownServerInfo: () => ({ simulation: true }) }));

type Listener = (event: { data: string }) => void;
class FakeEventSource {
    static all: FakeEventSource[] = [];
    listeners = new Map<string, Listener[]>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) { FakeEventSource.all.push(this); }
    addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
    close() { this.closed = true; }
    emit(name: string, data: unknown = {}) { if (!this.closed) for (const l of this.listeners.get(name) ?? []) l({ data: JSON.stringify(data) }); }
}
const fetchMock = vi.fn(async (_url: string) => ({ ok: false }));

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeEventSource.all = [];
    m.post.mockReset(); fetchMock.mockClear();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function open() {
    const stream = await import('./stream');
    const statuses: string[] = [];
    stream.subscribeStatusStore(() => statuses.push(stream.getStreamStatus()));
    stream.ensureStream();
    const first = FakeEventSource.all[0]!;
    first.onopen!();
    return { stream, statuses, first };
}

it('marks a silent open stream STALE after two heartbeat periods plus slack, closes it and reconnects', async () => {
    const { stream, statuses, first } = await open();
    expect(stream.getStreamStatus()).toBe('live');
    vi.advanceTimersByTime(stream.STALE_AFTER_MS - 5000);
    expect(stream.getStreamStatus()).toBe('live');
    vi.advanceTimersByTime(10_000);
    expect(stream.getStreamStatus()).toBe('stale');
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1000); // existing backoff
    const second = FakeEventSource.all.at(-1)!;
    expect(second).not.toBe(first);
    expect(stream.getStreamStatus()).toBe('stale'); // stays STALE until the reconnect opens
    second.onopen!();
    expect(stream.getStreamStatus()).toBe('live');
    expect(statuses).toEqual(['live', 'stale', 'live']);
});

it('keeps LIVE while heartbeats or other events keep arriving', async () => {
    const { stream, first } = await open();
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(30_000); first.emit('heartbeat'); }
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(50_000); first.emit('tick_stk', { code: '2330', close: '1' }); }
    expect(stream.getStreamStatus()).toBe('live');
    expect(FakeEventSource.all).toHaveLength(1);
});

it('never queries trades, positions or any accounting route itself', async () => {
    const { stream } = await open();
    vi.advanceTimersByTime(10 * 60_000);
    expect(stream.getStreamStatus()).not.toBe('live');
    expect(m.post.mock.calls.filter(c => /order|portfolio/.test(String(c[0])))).toEqual([]);
    expect(fetchMock.mock.calls.every(c => String(c[0]).endsWith('/api/v1/health'))).toBe(true);
});
