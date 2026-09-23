import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import captured from './fixtures/native-simulation-event-id-1.7.6.json';
import type { OrderEventReport } from './order-report';

// Drives the real stream.ts order_event handler (not a copied helper): the
// SSE frame is parsed, admitted through the event_id ledger and fanned out.
const m = vi.hoisted(() => ({ base: 'http://fixture.invalid', simulation: true as boolean | undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base, getStreamBase: () => m.base }));
vi.mock('./api', () => ({ apiPost: vi.fn() }));
vi.mock('./server-info-store', () => ({ knownServerInfo: () => (m.simulation === undefined ? undefined : { simulation: m.simulation }) }));

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

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    m.base = 'http://fixture.invalid'; m.simulation = true;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function connect() {
    const stream = await import('./stream');
    const seen: OrderEventReport[] = [];
    stream.onOrderEvent(r => seen.push(r));
    stream.ensureStream();
    return { seen, source: FakeEventSource.last! };
}

it('fans out each captured 1.7.6 report once and drops a redelivered event_id', async () => {
    const { seen, source } = await connect();
    for (const frame of captured.events) source.emit('order_event', frame);
    for (const frame of captured.events) source.emit('order_event', frame);
    expect(seen).toHaveLength(captured.events.length);
    expect(seen.map(r => r.eventId)).toEqual(captured.events.map(e => (e.data as unknown as Record<string, { event_id: string }>)[e.state]!.event_id));
});

it('keeps reports with an empty (historical/pre-1.7.6) event_id', async () => {
    const { seen, source } = await connect();
    const frame = { state: 'StockDeal', data: { StockDeal: { event_id: '', trade_id: 'x', code: '2330', price: 1, quantity: 1, exchange_seq: '1' } } };
    source.emit('order_event', frame); source.emit('order_event', frame);
    expect(seen).toHaveLength(2);
});

it('does not treat the same event_id from another environment as a duplicate', async () => {
    const { seen, source } = await connect();
    const frame = captured.events[0]!;
    source.emit('order_event', frame);
    m.simulation = false; // same base restarted in production mode
    source.emit('order_event', frame);
    m.base = 'http://other.invalid';
    source.emit('order_event', frame);
    expect(seen).toHaveLength(3);
});
