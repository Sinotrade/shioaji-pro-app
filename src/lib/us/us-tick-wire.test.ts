// 美股逐筆訂閱：預設 Tick（TICL）；設定選「完整成交」時 1.8.0b2／1.8.0 起訂 TickFull，
// 舊 sidecar（b1）拒收時退回 Tick；切換設定即時改訂；同一個商品不可同時有 Tick 與 TickFull；
// 台股不受影響。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    post: vi.fn(),
    version: undefined as string | undefined,
    base: 'http://sidecar-a.invalid',
}));
vi.mock('../api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(), shouldProxyAgentHarnessMutation: () => false }));
vi.mock('../server-info-store', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../server-info-store')>()),
    knownServerInfo: () => (m.version === undefined ? undefined : { version: m.version, simulation: true }),
}));
vi.mock('../runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../runtime')>()),
    getApiBase: () => m.base,
    getStreamBase: () => m.base,
}));

const aapl = { code: 'AAPL', security_type: 'STK' as const, exchange: 'NASDAQ' as const, region: 'US' as const, target_code: null };
const msft = { ...aapl, code: 'MSFT' };
const tsmc = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };
const usBody = (code: string, quote_type: string) => ({ security_type: 'STK', exchange: 'NASDAQ', code, quote_type });
const calls = (path: string) => m.post.mock.calls.filter(c => c[0] === `/api/v1/stream/${path}`).map(c => c[1] as Record<string, unknown>);
const b1Reject = (_path: string, body: Record<string, unknown>) =>
    body.quote_type === 'TickFull' ? Promise.reject(Object.assign(new Error('400 parse http data failed'), { status: 400 })) : Promise.resolve({ success: true, message: '' });

const DETAIL_KEY = 'sj-pro-us-tick-detail';
const storage = new Map<string, string>();
/** 使用者在設定選了「完整成交」（模組載入時讀 localStorage） */
const chooseFull = () => storage.set(DETAIL_KEY, 'TickFull');

beforeEach(() => {
    vi.resetModules();
    storage.clear();
    const session = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
        removeItem: (k: string) => void session.delete(k),
    });
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
    });
    m.post.mockReset();
    m.post.mockResolvedValue({ success: true, message: '' });
    m.version = undefined;
    m.base = 'http://sidecar-a.invalid';
});
afterEach(() => vi.unstubAllGlobals());

describe('sdkSupportsUsTickFull', () => {
    it('is true from 1.8.0b2 / 1.8.0 on, false for b1 and older, null when unknown', async () => {
        const { sdkSupportsUsTickFull } = await import('./us-tick-wire');
        for (const v of ['1.8.0-beta.2', '1.8.0b2', 'v1.8.0b3', '1.8.0-rc.1', '1.8.0', '1.8.1', '1.9.0', '2.0.0']) expect(sdkSupportsUsTickFull(v)).toBe(true);
        for (const v of ['1.8.0-beta.1', '1.8.0b1', '1.8.0-alpha.5', '1.7.11', '1.5.5']) expect(sdkSupportsUsTickFull(v)).toBe(false);
        for (const v of [undefined, '', 'dev', 'unknown']) expect(sdkSupportsUsTickFull(v)).toBeNull();
    });
});

describe('default: 一般成交 (Tick / TICL)', () => {
    it('subscribes US Tick as Tick on a 1.8.0 sidecar by default, never TickFull', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const { getUsTickDetail } = await import('./us-tick-prefs');
        expect(getUsTickDetail()).toBe('Tick');
        await subscribeQuote(aapl, 'Tick');
        await subscribeQuote(aapl, 'BidAsk');
        await unsubscribeQuote(aapl, 'Tick');
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'Tick'), usBody('AAPL', 'BidAsk')]);
        expect(calls('unsubscribe')).toEqual([usBody('AAPL', 'Tick'), usBody('AAPL', 'TickFull')]); // 關閉兩種都退（冪等）
    });

    it('unknown version: Tick directly, no TickFull probe', async () => {
        const { subscribeQuote } = await import('../shioaji');
        await subscribeQuote(aapl, 'Tick');
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'Tick')]);
    });

    it('an extended-session TICL tick feeds the same SseTick.us fields the session view reads', async () => {
        const { normalizeUsTick } = await import('./us-quotes');
        const out = normalizeUsTick({
            exchange: 'NASDAQ', code: 'AAPL', datetime: Date.UTC(2026, 10, 24, 22, 5) * 1000,
            price: '231.5', volume: 100, close: '230', high: '232', low: '228',
            updates_last: false, session: 3, ext_close: '231.5', ext_high: '231.9', ext_low: '229.8',
            total_volume: 1000,
        });
        expect(out?.tick.close).toBe('231.5');
        expect(out?.tick.us).toMatchObject({
            session: 'AfterHours', regular: '230', extClose: '231.5', extHigh: '231.9', extLow: '229.8', updatesLast: false,
        });
    });
});

describe('US Tick subscription wire (完整成交 chosen)', () => {
    beforeEach(chooseFull);

    it('subscribes US Tick as TickFull (BidAsk unchanged) on a 1.8.0 sidecar; Taiwan stays Tick', async () => {
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        await subscribeQuote(aapl, 'Tick');
        await subscribeQuote(aapl, 'BidAsk');
        await subscribeQuote(tsmc, 'Tick');
        const subs = calls('subscribe');
        expect(subs[0]).toEqual(usBody('AAPL', 'TickFull'));
        expect(subs[1]).toEqual(usBody('AAPL', 'BidAsk'));
        expect(subs[2]).toMatchObject({ code: '2330', quote_type: 'Tick', intraday_odd: false });
        expect(subs.filter(b => b.code === 'AAPL' && b.quote_type === 'Tick')).toEqual([]);
    });

    it('known b1 sidecar: subscribes Tick directly, never sends TickFull', async () => {
        m.version = '1.8.0-beta.1';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        await subscribeQuote(aapl, 'Tick');
        await unsubscribeQuote(aapl, 'Tick');
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'Tick')]);
        expect(calls('unsubscribe')).toEqual([usBody('AAPL', 'Tick')]);
    });

    it('unknown version: falls back to Tick when the sidecar rejects TickFull with 4xx, and remembers it', async () => {
        m.post.mockImplementation(b1Reject);
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        await subscribeQuote(aapl, 'Tick');
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'TickFull'), usBody('AAPL', 'Tick')]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        // the next symbol goes straight to Tick — no second failed TickFull
        await subscribeQuote(msft, 'Tick');
        expect(calls('subscribe').slice(2)).toEqual([usBody('MSFT', 'Tick')]);
        // unsubscribe uses what was actually subscribed
        await unsubscribeQuote(aapl, 'Tick');
        expect(calls('unsubscribe')).toEqual([usBody('AAPL', 'Tick')]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toBeUndefined();
    });

    it('the remembered rejection is per sidecar: a different base tries TickFull again', async () => {
        m.post.mockImplementation(b1Reject);
        const { subscribeQuote } = await import('../shioaji');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockReset(); m.post.mockResolvedValue({ success: true, message: '' });
        m.base = 'http://sidecar-b.invalid';
        await subscribeQuote(msft, 'Tick');
        expect(calls('subscribe')).toEqual([usBody('MSFT', 'TickFull')]);
    });

    it('does not fall back on a non-4xx failure (no Tick + TickFull pair)', async () => {
        m.post.mockRejectedValue(new Error('503 Service Unavailable'));
        const { subscribeQuote } = await import('../shioaji');
        await expect(subscribeQuote(aapl, 'Tick')).rejects.toThrow('503');
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'TickFull')]);
    });

    it('orphan unsubscribe (nothing registered, version unknown) retries as Tick only when TickFull is rejected', async () => {
        m.post.mockImplementation(b1Reject);
        const { unsubscribeQuote } = await import('../shioaji');
        await unsubscribeQuote(aapl, 'Tick');
        expect(calls('unsubscribe')).toEqual([usBody('AAPL', 'TickFull'), usBody('AAPL', 'Tick')]);
    });

    it('a registered TickFull unsubscribe that fails is not retried as Tick', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockRejectedValueOnce(new Error('400 bad'));
        await expect(unsubscribeQuote(aapl, 'Tick')).rejects.toThrow('400');
        expect(calls('unsubscribe')).toEqual([usBody('AAPL', 'TickFull')]);
    });
});

describe('shared quote ownership: watchlist, chart and popout consumers share one feed', () => {
    beforeEach(chooseFull);
    it('several retains of the same US Tick send one TickFull subscribe; the last release unsubscribes both kinds once', async () => {
        m.version = '1.8.0';
        vi.stubGlobal('BroadcastChannel', undefined);
        const { retainQuote } = await import('../quote-ownership');
        const watchlist = retainQuote(aapl, 'Tick');
        const chart = retainQuote(aapl, 'Tick');
        const board = retainQuote({ ...aapl }, 'Tick');
        await vi.waitFor(() => expect(calls('subscribe')).toHaveLength(1));
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'TickFull')]);
        watchlist(); chart();
        await new Promise(r => setTimeout(r, 20));
        expect(calls('unsubscribe')).toEqual([]);
        board();
        await vi.waitFor(() => expect(calls('unsubscribe')).toHaveLength(2), { timeout: 4000 });
        expect(calls('unsubscribe')).toEqual([usBody('AAPL', 'TickFull'), usBody('AAPL', 'Tick')]);
        expect(calls('subscribe')).toHaveLength(1);
    });
});

describe('reconnect replay', () => {
    beforeEach(chooseFull);
    class FakeEventSource {
        static last: FakeEventSource | null = null;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public url: string) { FakeEventSource.last = this; }
        addEventListener() {}
        close() {}
    }

    async function ownedStream() {
        vi.stubGlobal('EventSource', FakeEventSource);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
        vi.stubGlobal('BroadcastChannel', undefined);
        const stream = await import('../stream');
        return stream;
    }

    it('replays a TickFull subscription unchanged on the same capable sidecar (no Tick added)', async () => {
        m.version = '1.8.0';
        const stream = await ownedStream();
        stream.registerSubscriptionRaw('US:AAPL', 'Tick', usBody('AAPL', 'TickFull'));
        stream.registerSubscriptionRaw('US:AAPL', 'BidAsk', usBody('AAPL', 'BidAsk'));
        await stream.replayRegisteredSubscriptionsForTest();
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'TickFull'), usBody('AAPL', 'BidAsk')]);
        expect(calls('unsubscribe')).toEqual([]);
    });

    it('a sidecar restarted as b1: drops the TickFull, subscribes Tick, and re-registers Tick', async () => {
        m.version = undefined;
        m.post.mockImplementation(b1Reject);
        const stream = await ownedStream();
        stream.registerSubscriptionRaw('US:AAPL', 'Tick', usBody('AAPL', 'TickFull'));
        await stream.replayRegisteredSubscriptionsForTest();
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'TickFull'), usBody('AAPL', 'Tick')]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        // next replay goes straight to Tick
        m.post.mockClear();
        await stream.replayRegisteredSubscriptionsForTest();
        expect(calls('subscribe')).toEqual([usBody('AAPL', 'Tick')]);
        expect(calls('unsubscribe')).toEqual([]);
    });

    it('a sidecar upgraded to 1.8.0: unsubscribes the old Tick before subscribing TickFull', async () => {
        m.version = '1.8.0';
        const stream = await ownedStream();
        stream.registerSubscriptionRaw('US:AAPL', 'Tick', usBody('AAPL', 'Tick'));
        await stream.replayRegisteredSubscriptionsForTest();
        expect(m.post.mock.calls.map(c => [c[0], (c[1] as { quote_type: string }).quote_type])).toEqual([
            ['/api/v1/stream/unsubscribe', 'Tick'],
            ['/api/v1/stream/subscribe', 'TickFull'],
        ]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'TickFull'));
    });

    it('Taiwan bodies replay unchanged', async () => {
        m.version = '1.8.0';
        const stream = await ownedStream();
        const tw = { security_type: 'STK', exchange: 'TSE', code: '2330', target_code: null, quote_type: 'Tick', intraday_odd: false };
        stream.registerSubscription(tw);
        await stream.replayRegisteredSubscriptionsForTest();
        expect(calls('subscribe')).toEqual([tw]);
        expect(calls('unsubscribe')).toEqual([]);
    });
});

describe('switching 美股成交資料 re-subscribes live', () => {
    const kinds = () => m.post.mock.calls.map(c => [String(c[0]).replace('/api/v1/stream/', ''), (c[1] as { code: string }).code, (c[1] as { quote_type: string }).quote_type]);

    it('Tick → TickFull: each subscribed US symbol drops Tick then subscribes TickFull; BidAsk and Taiwan untouched', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        await subscribeQuote(aapl, 'BidAsk');
        await subscribeQuote(msft, 'Tick');
        await subscribeQuote(tsmc, 'Tick');
        m.post.mockClear();
        prefs.setUsTickDetail('TickFull');
        expect(storage.get(DETAIL_KEY)).toBe('TickFull');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([
            ['unsubscribe', 'AAPL', 'Tick'], ['subscribe', 'AAPL', 'TickFull'],
            ['unsubscribe', 'MSFT', 'Tick'], ['subscribe', 'MSFT', 'TickFull'],
        ]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'TickFull'));
        // unsubscribe after the switch uses the new kind
        m.post.mockClear();
        await unsubscribeQuote(aapl, 'Tick');
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'TickFull'], ['unsubscribe', 'AAPL', 'Tick']]);
        // and back: TickFull → Tick
        m.post.mockClear();
        prefs.setUsTickDetail('Tick');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'MSFT', 'TickFull'], ['subscribe', 'MSFT', 'Tick']]);
        expect(stream.getRegisteredSubscription('US:MSFT', 'Tick')).toEqual(usBody('MSFT', 'Tick'));
    });

    it('a failed unsubscribe of the old kind keeps it and does not subscribe the new one (retried later)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        m.post.mockRejectedValueOnce(new Error('503 Service Unavailable'));
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'Tick']]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        // 5 秒後重試：這次退掉 Tick 再訂 TickFull
        // （只靠重試計時器，不手動呼叫 resubscribeUsTicks）
        m.post.mockClear();
        await vi.advanceTimersByTimeAsync(4999);
        expect(m.post).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'Tick'], ['subscribe', 'AAPL', 'TickFull']]));
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'TickFull'));
        vi.useRealTimers();
    });

    it('old kind dropped but new kind failed: switching back still re-subscribes (no silent gap)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        m.post.mockImplementation((path: string, body: Record<string, unknown>) =>
            path.endsWith('/subscribe') && body.quote_type === 'TickFull'
                ? Promise.reject(new Error('503 Service Unavailable'))
                : Promise.resolve({ success: true, message: '' }));
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'Tick'], ['subscribe', 'AAPL', 'TickFull']]);
        // 切回一般成交（在重試之前）：Tick 已經不在了，要補訂（先冪等地退掉可能在的 TickFull）
        m.post.mockClear();
        prefs.setUsTickDetail('Tick');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'TickFull'], ['subscribe', 'AAPL', 'Tick']]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        // 補上之後重試計時器那一輪什麼都不用做
        m.post.mockClear();
        await vi.advanceTimersByTimeAsync(5000);
        await stream.resubscribeUsTicks();
        expect(m.post).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('known b1 sidecar: choosing TickFull sends nothing (stays on Tick)', async () => {
        m.version = '1.8.0-beta.1';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        expect(m.post).not.toHaveBeenCalled();
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
    });

    it('unknown version that rejects TickFull: falls back to Tick, never both kinds at once', async () => {
        m.post.mockImplementation(b1Reject);
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([
            ['unsubscribe', 'AAPL', 'Tick'], ['subscribe', 'AAPL', 'TickFull'], ['subscribe', 'AAPL', 'Tick'],
        ]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        // remembered: the next switch pass is a no-op
        m.post.mockClear();
        await stream.resubscribeUsTicks();
        expect(m.post).not.toHaveBeenCalled();
    });
});

describe('per-symbol serialization of US tick ops (deferred responses)', () => {
    function deferred() {
        let resolve!: (v: unknown) => void;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
    }
    const kinds = () => m.post.mock.calls.map(c => [String(c[0]).replace('/api/v1/stream/', ''), (c[1] as { quote_type: string }).quote_type]);
    /** 依送出順序模擬 sidecar 上實際訂著的種類；回傳過程中最多同時幾種 */
    const simulate = () => {
        const active = new Set<string>();
        let max = 0;
        for (const [path, kind] of kinds()) {
            if (path === 'subscribe') active.add(kind!); else active.delete(kind!);
            max = Math.max(max, active.size);
        }
        return { active: [...active], max };
    };
    const ok = { success: true, message: '' };

    it('toggle back + reconnect replay while the TickFull subscribe is in flight: never Tick and TickFull together', async () => {
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        const full = deferred();
        m.post.mockImplementation((path: string, body: Record<string, unknown>) =>
            path.endsWith('/subscribe') && body.quote_type === 'TickFull' ? full.promise : Promise.resolve(ok));
        prefs.setUsTickDetail('TickFull');
        await vi.waitFor(() => expect(kinds()).toEqual([['unsubscribe', 'Tick'], ['subscribe', 'TickFull']]));
        // TickFull 還沒回應：切回一般成交，同時 SSE 重連重播
        prefs.setUsTickDetail('Tick');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        // 重播不等這個在飛的商品（不拖住整批），也不對它送任何東西；留給 5 秒後的重播
        await stream.replayRegisteredSubscriptionsForTest();
        expect(kinds()).toHaveLength(2);
        full.resolve(ok);
        await stream.resubscribeUsTicks();
        await vi.advanceTimersByTimeAsync(5000);
        await stream.replayRegisteredSubscriptionsForTest();
        vi.useRealTimers();
        const { active, max } = simulate();
        expect(max).toBe(1);
        expect(active).toEqual(['Tick']);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
    });

    it('last consumer closes while the TickFull subscribe is in flight: unsubscribes TickFull afterwards, nothing orphaned', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        const wire = await import('./us-tick-wire');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        const full = deferred();
        m.post.mockImplementation((path: string, body: Record<string, unknown>) =>
            path.endsWith('/subscribe') && body.quote_type === 'TickFull' ? full.promise : Promise.resolve(ok));
        prefs.setUsTickDetail('TickFull');
        await vi.waitFor(() => expect(kinds()).toEqual([['unsubscribe', 'Tick'], ['subscribe', 'TickFull']]));
        // 舊的已退：重新整理後要退的是在飛的 TickFull
        expect(wire.rememberedUsTickWire(m.base, 'US:AAPL')).toBe('TickFull');
        const closing = unsubscribeQuote(aapl, 'Tick');
        await new Promise(r => setTimeout(r, 10));
        // 退訂排在改訂之後：還沒送出（不會拿舊的 Tick 去退）
        expect(kinds()).toHaveLength(2);
        full.resolve(ok);
        await closing;
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'Tick'], ['subscribe', 'TickFull'], ['unsubscribe', 'TickFull'], ['unsubscribe', 'Tick']]);
        expect(simulate().active).toEqual([]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toBeUndefined();
        expect(wire.rememberedUsTickWire(m.base, 'US:AAPL')).toBeUndefined();
        expect(sessionStorage.getItem(`sj-us-tick-wire:${m.base}`)).toBe('{}');
    });
});

describe('uncertain outcomes, stalled requests and reconcile (Codex rounds 3-4)', () => {
    const ok = { success: true, message: '' };
    const kinds = () => m.post.mock.calls.map(c => [String(c[0]).replace('/api/v1/stream/', ''), (c[1] as { code: string }).code, (c[1] as { quote_type: string }).quote_type]);
    /** sidecar 端模擬：送出的請求都當作已生效（回應遺失／逾時也算） */
    const activeOf = (code: string) => {
        const active = new Set<string>();
        let max = 0;
        for (const [path, c, kind] of kinds()) {
            if (c !== code) continue;
            if (path === 'subscribe') active.add(kind!); else active.delete(kind!);
            max = Math.max(max, active.size);
        }
        return { active: [...active].sort(), max };
    };
    const lostFullResponse = (path: string, body: Record<string, unknown>) =>
        path.endsWith('/subscribe') && body.quote_type === 'TickFull'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : Promise.resolve(ok);
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('TickFull accepted but response lost, then switching back: removes TickFull before Tick', async () => {
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockImplementation(lostFullResponse);
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(true);
        prefs.setUsTickDetail('Tick');
        await stream.resubscribeUsTicks();
        expect(kinds().slice(-2)).toEqual([['unsubscribe', 'AAPL', 'TickFull'], ['subscribe', 'AAPL', 'Tick']]);
        expect(activeOf('AAPL')).toEqual({ active: ['Tick'], max: 1 });
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(false);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
    });

    it('TickFull accepted but response lost, then the last consumer closes: both kinds are unsubscribed, nothing orphaned', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockImplementation(lostFullResponse);
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        await unsubscribeQuote(aapl, 'Tick');
        expect(activeOf('AAPL').active).toEqual([]);
        expect(kinds().slice(-2).map(k => k[2]).sort()).toEqual(['Tick', 'TickFull']);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toBeUndefined();
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(false);
        expect(sessionStorage.getItem(`sj-us-tick-wire:${m.base}`)).toBe('{}');
    });

    it('a stalled response times out: other symbols replay meanwhile, then close removes both kinds', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        await subscribeQuote(msft, 'Tick');
        await subscribeQuote(tsmc, 'Tick');
        m.post.mockClear();
        m.post.mockImplementation((path: string, body: Record<string, unknown>) =>
            path.endsWith('/subscribe') && body.code === 'AAPL' && body.quote_type === 'TickFull'
                ? new Promise(() => undefined) // 永遠不回應
                : Promise.resolve(ok));
        prefs.setUsTickDetail('TickFull');
        await vi.waitFor(() => expect(kinds()).toContainEqual(['subscribe', 'AAPL', 'TickFull']));
        // 重連重播：AAPL 卡住不拖住其他商品
        await stream.replayRegisteredSubscriptionsForTest();
        expect(kinds()).toContainEqual(['subscribe', 'MSFT', 'TickFull']);
        expect(kinds()).toContainEqual(['subscribe', '2330', 'Tick']);
        // 最後一個消費者關閉：排在卡住的改訂之後，逾時後照樣能退
        const closing = unsubscribeQuote(aapl, 'Tick');
        await vi.advanceTimersByTimeAsync(stream.STREAM_REQUEST_TIMEOUT_MS);
        await closing;
        expect(activeOf('AAPL').active).toEqual([]);
        expect(activeOf('MSFT')).toEqual({ active: ['TickFull'], max: 1 });
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toBeUndefined();
    });

    it('the reconcile flag is per server: a flag set on sidecar A is not applied on sidecar B', async () => {
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockImplementation(lostFullResponse);
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        const a = m.base;
        expect(stream.needsUsTickReconcile('US:AAPL:Tick', a)).toBe(true);
        m.base = 'http://sidecar-b.invalid';
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(false);
        m.post.mockClear();
        m.post.mockResolvedValue(ok);
        // B：registry 已是 TickFull、沒有對帳旗標 → 不動（B 由重連重播整批訂）
        await stream.resubscribeUsTicks();
        expect(m.post).not.toHaveBeenCalled();
        expect(stream.needsUsTickReconcile('US:AAPL:Tick', a)).toBe(true);
    });

    it('round 4 #1: a timed-out unsubscribe of the old kind still lets switching back restore it', async () => {
        m.version = '1.8.0';
        const { subscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockClear();
        m.post.mockImplementation((path: string) =>
            path.endsWith('/unsubscribe') ? new Promise(() => undefined) : Promise.resolve(ok));
        prefs.setUsTickDetail('TickFull');
        const pass = stream.resubscribeUsTicks();
        await vi.advanceTimersByTimeAsync(stream.STREAM_REQUEST_TIMEOUT_MS);
        await pass;
        // 退訂結果不明（可能已退掉）、沒有送 TickFull
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'Tick']]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(true);
        // 切回一般成交（在 5 秒對帳之前）：不可跳過，要把 Tick 補訂回來
        m.post.mockClear();
        m.post.mockResolvedValue(ok);
        prefs.setUsTickDetail('Tick');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'TickFull'], ['subscribe', 'AAPL', 'Tick']]);
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(false);
    });

    it('round 4 #2: a 429 on the other kind is not "removed": the new kind is not subscribed, close keeps the entry', async () => {
        m.version = '1.8.0';
        const { subscribeQuote, unsubscribeQuote } = await import('../shioaji');
        const stream = await import('../stream');
        const prefs = await import('./us-tick-prefs');
        await subscribeQuote(aapl, 'Tick');
        m.post.mockImplementation(lostFullResponse);
        prefs.setUsTickDetail('TickFull');
        await stream.resubscribeUsTicks();
        // 切回：退 TickFull 被 429 → 不可訂 Tick（否則兩種並存）
        m.post.mockClear();
        const tooMany = (path: string, body: Record<string, unknown>) =>
            path.endsWith('/unsubscribe') && body.quote_type === 'TickFull'
                ? Promise.reject(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))
                : Promise.resolve(ok);
        m.post.mockImplementation(tooMany);
        prefs.setUsTickDetail('Tick');
        await stream.resubscribeUsTicks();
        expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'TickFull']]);
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(true);
        // 關閉：TickFull 退不掉 → 整筆留著（registry、旗標），呼叫端之後重試
        m.post.mockClear();
        await expect(unsubscribeQuote(aapl, 'Tick')).rejects.toThrow('429');
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toBeDefined();
        // 5 秒後對帳：429 解除 → 退 TickFull、訂 Tick
        m.post.mockClear();
        m.post.mockResolvedValue(ok);
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() => expect(kinds()).toEqual([['unsubscribe', 'AAPL', 'TickFull'], ['subscribe', 'AAPL', 'Tick']]));
    });

    it('round 4 #3: an initial subscribe that times out stays registered, and closing the consumer unsubscribes it', async () => {
        m.version = '1.8.0';
        vi.stubGlobal('BroadcastChannel', undefined);
        const { retainQuote, RELEASE_GRACE_MS } = await import('../quote-ownership');
        const stream = await import('../stream');
        m.post.mockImplementation((path: string) =>
            path.endsWith('/subscribe') ? new Promise(() => undefined) : Promise.resolve(ok));
        const release = retainQuote(aapl, 'Tick');
        await vi.waitFor(() => expect(kinds()).toEqual([['subscribe', 'AAPL', 'Tick']]));
        await vi.advanceTimersByTimeAsync(stream.STREAM_REQUEST_TIMEOUT_MS);
        // 結果不明：登記留著（關閉／對帳都找得到）
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toEqual(usBody('AAPL', 'Tick'));
        expect(stream.needsUsTickReconcile('US:AAPL:Tick')).toBe(true);
        release();
        await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS);
        await vi.waitFor(() => expect(kinds().filter(k => k[0] === 'unsubscribe').map(k => k[2]).sort()).toEqual(['Tick', 'TickFull']));
        expect(activeOf('AAPL').active).toEqual([]);
        expect(stream.getRegisteredSubscription('US:AAPL', 'Tick')).toBeUndefined();
        // 之後的對帳不會再把它訂回來
        const before = m.post.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.post.mock.calls.length).toBe(before);
    });
});
