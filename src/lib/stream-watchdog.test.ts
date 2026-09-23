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

it('grants one heartbeat period after a resume (late watchdog tick) before calling STALE', async () => {
    const { stream, first } = await open();
    vi.advanceTimersByTime(20_000);
    // Suspend: timers do not run for 3 minutes, then everything resumes.
    vi.setSystemTime(Date.now() + 180_000);
    vi.advanceTimersByTime(stream.WATCHDOG_TICK_MS);
    expect(stream.getStreamStatus()).toBe('live'); // grace, queued events may still arrive
    first.emit('heartbeat'); // the queued heartbeat is delivered
    vi.advanceTimersByTime(stream.HEARTBEAT_PERIOD_MS);
    expect(stream.getStreamStatus()).toBe('live');
    expect(FakeEventSource.all).toHaveLength(1);
    // Without any event, STALE follows once the grace has elapsed.
    vi.advanceTimersByTime(stream.STALE_AFTER_MS + stream.WATCHDOG_TICK_MS);
    expect(stream.getStreamStatus()).toBe('stale');
});

it('keeps escalating the retry delay while connections open but never heartbeat, and resets on a heartbeat', async () => {
    const { stream } = await open();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
        while (stream.getStreamStatus() === 'live') vi.advanceTimersByTime(1000);
        expect(stream.getStreamStatus()).toBe('stale');
        const { retryDelayMs, silentConnections } = stream.getStreamWatchdog();
        expect(silentConnections).toBe(i + 1);
        const before = FakeEventSource.all.length;
        vi.advanceTimersByTime(retryDelayMs); // covers the scheduled (previous) delay
        expect(FakeEventSource.all.length).toBe(before + 1);
        delays.push(retryDelayMs);
        FakeEventSource.all.at(-1)!.onopen!(); // opens, but the proxy buffers heartbeats
    }
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[3]).toBeGreaterThan(delays[2]!);
    expect(delays[3]).toBeGreaterThan(15_000); // beyond the normal 15 s cap
    FakeEventSource.all.at(-1)!.emit('heartbeat');
    expect(stream.getStreamWatchdog()).toMatchObject({ silentConnections: 0, retryDelayMs: 1000 });
});

it('paces the subscription replay after a reconnect (Shioaji 50 per 5 s)', async () => {
    m.post.mockResolvedValue({ success: true });
    const { stream, first } = await open();
    for (let i = 0; i < 100; i++) stream.registerSubscription({ security_type: 'STK', exchange: 'TSE', code: `C${i}`, target_code: null, quote_type: 'Tick', intraday_odd: false });
    first.onerror!();
    vi.advanceTimersByTime(1000);
    FakeEventSource.all.at(-1)!.onopen!();
    const replayed = () => m.post.mock.calls.filter(c => c[0] === '/api/v1/stream/subscribe').length;
    await vi.advanceTimersByTimeAsync(100);
    expect(replayed()).toBe(stream.REPLAY_BATCH);
    await vi.advanceTimersByTimeAsync(stream.REPLAY_WINDOW_MS);
    expect(replayed()).toBe(2 * stream.REPLAY_BATCH);
    await vi.advanceTimersByTimeAsync(stream.REPLAY_WINDOW_MS);
    expect(replayed()).toBe(100);
});

// Background tabs / occluded WebViews throttle intervals. Emulate by freezing
// timers and firing one watchdog tick every `interval` of wall time.
async function throttled(intervalMs: number, silenceMs: number) {
    const { stream, first } = await open();
    first.emit('heartbeat');
    let staleAt: number | null = null;
    const start = Date.now();
    for (let elapsed = 0; elapsed < silenceMs && staleAt === null; elapsed += intervalMs) {
        vi.setSystemTime(Date.now() + intervalMs - stream.WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(stream.WATCHDOG_TICK_MS); // exactly one (late) tick
        if (stream.getStreamStatus() === 'stale') staleAt = Date.now() - start;
    }
    return { stream, staleAt };
}
it.each([20_000, 60_000])('a timer throttled to %i ms still reaches STALE within STALE_AFTER_MS plus one interval and grace', async interval => {
    const { stream, staleAt } = await throttled(interval, 30 * 60_000);
    expect(staleAt).not.toBeNull();
    // At most one resume grace (one heartbeat period) plus one throttled interval.
    expect(staleAt!).toBeLessThanOrEqual(stream.STALE_AFTER_MS + stream.HEARTBEAT_PERIOD_MS + interval);
});

it('grants only one grace for a single resume gap, then behaves normally', async () => {
    const { stream, first } = await open();
    first.emit('heartbeat');
    vi.setSystemTime(Date.now() + 120_000); // one suspend
    vi.advanceTimersByTime(stream.WATCHDOG_TICK_MS);
    expect(stream.getStreamStatus()).toBe('live'); // grace
    // Normal 5 s ticks resume; no events -> STALE right after the grace ends.
    let waited = 0;
    while (stream.getStreamStatus() === 'live' && waited < 10 * 60_000) { vi.advanceTimersByTime(1000); waited += 1000; }
    expect(stream.getStreamStatus()).toBe('stale');
    expect(waited).toBeLessThanOrEqual(stream.HEARTBEAT_PERIOD_MS + stream.WATCHDOG_TICK_MS);
});

it('connection errors after silent connections use the normal backoff (≤ 15 s)', async () => {
    const { stream } = await open();
    for (let i = 0; i < 4; i++) { // escalate with silent connections
        while (stream.getStreamStatus() === 'live') vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(stream.getStreamWatchdog().retryDelayMs);
        FakeEventSource.all.at(-1)!.onopen!();
    }
    expect(stream.getStreamWatchdog().retryDelayMs).toBeGreaterThan(15_000);
    // The sidecar now really restarts: the connection errors.
    const before = FakeEventSource.all.length;
    FakeEventSource.all.at(-1)!.onerror!();
    vi.advanceTimersByTime(15_000);
    expect(FakeEventSource.all.length).toBe(before + 1);
    expect(stream.getStreamWatchdog().retryDelayMs).toBeLessThanOrEqual(15_000);
    FakeEventSource.all.at(-1)!.onopen!();
    FakeEventSource.all.at(-1)!.emit('heartbeat');
    expect(stream.getStreamWatchdog()).toMatchObject({ silentConnections: 0, retryDelayMs: 1000 });
});
