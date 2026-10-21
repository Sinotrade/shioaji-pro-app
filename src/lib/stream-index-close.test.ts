// 指數報價進 store 時順手交給 rememberIndexClose（收盤那筆存本機）；自己連線與跨視窗轉送兩條路都要
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    options: null as null | { onOwn: () => void; onWire: (wire: { kind: 'event'; name: string; raw: string }) => void },
    remember: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: vi.fn(async () => ({ success: true })) }));
vi.mock('./server-info-store', () => ({ forgetServerInfo: vi.fn(), knownServerInfo: () => undefined }));
vi.mock('./index-close-quote', () => ({ rememberIndexClose: (...args: unknown[]) => (m.remember as (...a: unknown[]) => unknown)(...args) }));
vi.mock('./shared-stream', () => ({
    createSharedStream: (options: typeof m.options) => {
        m.options = options;
        return { isOwner: () => true, publish: () => undefined, close: () => undefined };
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

// Shioaji Server 1.7 送上游 QuoteIdxV1 的欄位名稱（Raise、Fall、RaiseStop…）
const raw = { Code: 'IX0001', Exchange: 'TSE', Date: '2026/10/19', Time: '13:33:00.000000', Reference: '47111.26', Open: '46844.64', High: '46844.64', Low: '46170.0', Close: '46822.08', Raise: 160, Flat: 72, Fall: 862, RaiseStop: 7, FallStop: 2 };

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    m.options = null;
    m.remember = vi.fn();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('自己連線收到 quote_idx：正規化後交給 rememberIndexClose', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    m.options!.onOwn();
    FakeEventSource.last!.emit('quote_idx', raw);
    expect(m.remember).toHaveBeenCalledTimes(1);
    expect(m.remember.mock.calls[0]![0]).toMatchObject({ code: 'IX0001', time: '13:33:00.000000', raise_count: 160, limit_up_count: 7 });
});

it('跨視窗轉送來的 quote_idx 也會交給 rememberIndexClose', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    m.options!.onWire({ kind: 'event', name: 'quote_idx', raw: JSON.stringify(raw) });
    expect(m.remember).toHaveBeenCalledTimes(1);
});

it('收盤價不是數字的壞資料不進 store，也不存', async () => {
    const stream = await import('./stream');
    stream.ensureStream();
    m.options!.onOwn();
    FakeEventSource.last!.emit('quote_idx', { ...raw, Close: 'n/a' });
    expect(m.remember).not.toHaveBeenCalled();
});
