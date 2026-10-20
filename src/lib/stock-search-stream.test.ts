import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StreamWire } from './shared-stream';
import type { StockMeta } from './stock-index';
import type { SseBidAsk, SseTick } from './types/market';

interface FollowerOptions {
    onOwn: () => void;
    onWire: (wire: StreamWire) => void;
}
const m = vi.hoisted(() => ({
    options: null as FollowerOptions | null,
    io: vi.fn(() => { throw new Error('Search/store isolation must not perform IO'); }),
    eventSource: vi.fn(() => { throw new Error('A follower must not open EventSource'); }),
    shared: vi.fn(), publish: vi.fn(),
}));
vi.mock('./runtime', () => ({ isTauri: false, getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: m.io }));
vi.mock('./shioaji', () => ({ fetchContracts: m.io, fetchContractInfo: m.io, fetchWarrantUnderlyings: m.io }));
vi.mock('./utils/date', () => ({ todayStr: () => '2026-10-18' }));
vi.mock('./server-info-store', () => ({ forgetServerInfo: vi.fn(), knownServerInfo: () => undefined }));
vi.mock('./shared-stream', () => ({
    createSharedStream: (options: FollowerOptions) => {
        m.shared();
        m.options = options;
        // Never invoke onOwn: this exercises the real follower dispatch and stores only.
        return { isOwner: () => false, publish: m.publish, close: () => undefined };
    },
}));

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    m.options = null;
    vi.stubGlobal('fetch', m.io);
    vi.stubGlobal('EventSource', m.eventSource);
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it.each([
    { tickEvent: 'tick_stk', bookEvent: 'bidask_stk', codes: ['2330', '2317'] },
    { tickEvent: 'tick_fop', bookEvent: 'bidask_fop', codes: ['TXFJ6', 'MXFJ6'] },
])('$tickEvent/$bookEvent 與搜尋交錯時逐筆完整，真 store 即時更新且只合併 React 通知', async ({ tickEvent, bookEvent, codes }) => {
    const stream = await import('./stream');
    const { searchStocks } = await import('./stock-index');
    stream.ensureStream();
    expect(m.shared).toHaveBeenCalledOnce();
    expect(stream.isStreamOwner()).toBe(false);
    expect(m.options).not.toBeNull();
    const dispatch = (name: string, data: SseTick | SseBidAsk) => m.options!.onWire({ kind: 'event', name, raw: JSON.stringify(data) });
    const ticks = vi.fn();
    const books = vi.fn();
    const notifications = codes.map(() => vi.fn());
    const detach = [stream.onAnyTick(ticks), stream.onAnyBidAsk(books),
        ...codes.map((code, index) => stream.subscribeQuoteStore(code, notifications[index]!))];
    try {
        // Synthetic search load, not current market listings or a latency benchmark.
        const catalog: StockMeta[] = Array.from({ length: 3155 }, (_, index) => ({
            code: String(1000 + index), name: `合成台灣商品${index}`, category: '', exchange: 'TSE',
            aliases: [`合成公開名稱${index}`, `合成別名${index}`],
        }));
        const queries = ['台', '2330', '臺灣', '００９８１', '合成別名', 'NO_MATCH_XXX'];
        const expected = queries.map(query => searchStocks(catalog, query, 8));
        const search = (iteration: number) => {
            const index = iteration % queries.length;
            const before = codes.map(code => stream.getQuote(code));
            const result = searchStocks(catalog, queries[index]!, 8);
            expect(result).toHaveLength(expected[index]!.length);
            result.forEach((row, position) => expect(row).toBe(expected[index]![position]));
            codes.forEach((code, position) => expect(stream.getQuote(code)).toBe(before[position]));
        };
        const expectedTicks: SseTick[] = [];
        const expectedBooks: SseBidAsk[] = [];
        const counts = new Map(codes.map(code => [code, 0]));
        for (let index = 0; index < 120; index++) {
            const code = codes[index % codes.length]!;
            const count = counts.get(code)! + 1;
            counts.set(code, count);
            const price = String(1000 + index);
            const tick: SseTick = { code, date: '2026-10-18', time: `09:00:00.${String(index).padStart(6, '0')}`,
                open: '1000', high: price, low: '1000', close: price, volume: 1, total_volume: count,
                tick_type: 1, simtrade: false };
            const book: SseBidAsk = { code, date: tick.date, time: tick.time, bid_price: [price], bid_volume: [count],
                ask_price: [String(1001 + index)], ask_volume: [count + 1] };
            search(index);
            dispatch(tickEvent, tick);
            const tickReference = stream.getQuote(code)!.tick;
            search(index + 1);
            dispatch(bookEvent, book);
            expectedTicks.push(tick);
            expectedBooks.push(book);
            expect(stream.getQuote(code)).toMatchObject({ tick, bidask: book, seq: count * 2, flashSeq: count });
            expect(stream.getQuote(code)!.tick).toBe(tickReference);
        }
        expect(ticks.mock.calls.map(([value]) => value)).toEqual(expectedTicks);
        expect(books.mock.calls.map(([value]) => value)).toEqual(expectedBooks);
        expect(ticks).toHaveBeenCalledTimes(120);
        expect(books).toHaveBeenCalledTimes(120);
        codes.forEach(code => expect(stream.getQuote(code)).toMatchObject({ seq: 120, flashSeq: 60 }));
        notifications.forEach(listener => expect(listener).not.toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(49);
        notifications.forEach(listener => expect(listener).not.toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(1);
        notifications.forEach(listener => expect(listener).toHaveBeenCalledTimes(1));

        // A later batch still reaches the changed code without waking the other code.
        dispatch(bookEvent, { ...expectedBooks[0]!, bid_price: ['2000'] });
        search(0);
        expect(stream.getQuote(codes[0]!)?.seq).toBe(121);
        expect(stream.getQuote(codes[0]!)?.flashSeq).toBe(60);
        await vi.advanceTimersByTimeAsync(50);
        expect(notifications[0]).toHaveBeenCalledTimes(2);
        expect(notifications[1]).toHaveBeenCalledTimes(1);
        expect(books).toHaveBeenCalledTimes(121);
        expect(stream.getRegisteredSubscriptions()).toEqual([]);
        expect(m.io).not.toHaveBeenCalled();
        expect(m.eventSource).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
    } finally {
        detach.forEach(release => release());
    }
});
