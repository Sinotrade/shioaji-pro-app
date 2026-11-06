import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), quotes: new Map<string, unknown>(), callbacks: new Map<string, () => void>(), releases: [] as ReturnType<typeof vi.fn>[], retain: vi.fn(), alias: vi.fn() }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('../lib/shioaji', () => ({ fetchSnapshots: mocks.fetch }));
vi.mock('../lib/quote-ownership', () => ({ retainQuote: mocks.retain }));
vi.mock('../lib/stream', () => ({ getQuote: (code: string) => mocks.quotes.get(code), registerCodeAlias: mocks.alias,
    subscribeQuoteStore: (code: string, cb: () => void) => { mocks.callbacks.set(code, cb); return () => mocks.callbacks.delete(code); } }));
const stk: ContractBase = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null };
const fut: ContractBase = { code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null };
const ind: ContractBase = { code: 'IX0001', security_type: 'IND', exchange: 'TSE', target_code: null };
const snapshot = (code: string) => ({ code, datetime: '2026-09-12 09:00:00', close: 100, change_price: 0, change_rate: 0, buy_price: 99, sell_price: 101, buy_volume: 1, sell_volume: 1 }) as Snapshot;
let root: ReactTestRenderer | undefined;
let hook: typeof import('./use-live-snapshots').useLiveSnapshots;
let value: ReturnType<typeof hook>;
let renders = 0;
function Probe({ contracts, live }: { contracts: ContractBase[]; live?: ContractBase[] }) { value = hook(contracts, undefined, live); renders++; return null; }
async function mount(contracts: ContractBase[]) { await act(async () => { root = create(createElement(Probe, { contracts })); }); }
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.fetch.mockReset().mockImplementation(async (contracts: ContractBase[]) => contracts.map(c => snapshot(c.code)));
    mocks.quotes.clear(); mocks.callbacks.clear(); mocks.releases.length = 0; renders = 0;
    mocks.retain.mockReset().mockImplementation(() => { const release = vi.fn(); mocks.releases.push(release); return release; });
    hook = (await import('./use-live-snapshots')).useLiveSnapshots;
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('snapshot plus stream projection', () => {
    it('computes consistent stock/future percentage, coalesces at 100 ms, and merges bidask', async () => {
        await mount([stk, fut]); const before = renders;
        await act(async () => {
            for (const c of [stk, fut]) {
                mocks.quotes.set(c.code, { tick: { date: '2026-09-12', time: '09:00:01', close: 110, price_chg: 10, pct_chg: c === stk ? 10 : 0.1, volume: 2, total_volume: 10 }, bidask: { code: c.code, date: '2026-09-12', time: '09:00:01', bid_price: [109], ask_price: [111], bid_volume: [3], ask_volume: [4] } });
                for (let i = 0; i < 10; i++) mocks.callbacks.get(c.code)!();
            }
            vi.advanceTimersByTime(99);
        });
        expect(renders).toBe(before);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(renders).toBe(before + 1);
        for (const c of [stk, fut]) expect(value.snapshots.get(c.code)).toMatchObject({ close: 110, change_rate: 10, buy_price: 109, sell_price: 111, buy_volume: 3, sell_volume: 4 });
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });
    it('retains IND Quote ownership and computes index percentage', async () => {
        await mount([ind]);
        expect(mocks.retain).toHaveBeenCalledWith(ind, 'Quote'); expect(mocks.retain).toHaveBeenCalledTimes(1);
        await act(async () => { mocks.quotes.set(ind.code, { index: { date: '2026-09-12', time: '09:00:01', close: 102, reference: 100 } }); mocks.callbacks.get(ind.code)!(); vi.advanceTimersByTime(100); });
        expect(value.snapshots.get(ind.code)).toMatchObject({ close: 102, change_price: 2, change_rate: 2 });
    });
    it('isolates late initial snapshots and releases prior subscriptions and timers', async () => {
        let resolve!: (v: Snapshot[]) => void;
        mocks.fetch.mockImplementationOnce(() => new Promise<Snapshot[]>(r => { resolve = r; }));
        await mount([stk]); const oldReleases = [...mocks.releases];
        await act(async () => { mocks.callbacks.get(stk.code)!(); root!.update(createElement(Probe, { contracts: [fut] })); });
        expect(oldReleases.every(fn => fn.mock.calls.length === 1)).toBe(true);
        expect(mocks.callbacks.has(stk.code)).toBe(false);
        await act(async () => { resolve([snapshot(stk.code)]); vi.advanceTimersByTime(100); });
        expect(value.snapshots.has(stk.code)).toBe(false); expect(value.snapshots.has(fut.code)).toBe(true);
        await act(async () => { root!.unmount(); }); root = undefined;
        expect(mocks.releases.every(fn => fn.mock.calls.length === 1)).toBe(true); expect(mocks.callbacks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
    it('updates book-only events before the next tick', async () => {
        await mount([stk]);
        await act(async () => { mocks.quotes.set(stk.code, { bidask: { code: stk.code, date: '2026-09-12', time: '09:00:01', bid_price: [98], ask_price: [102], bid_volume: [8], ask_volume: [9] } }); mocks.callbacks.get(stk.code)!(); vi.advanceTimersByTime(100); });
        expect(value.snapshots.get(stk.code)).toMatchObject({ close: 100, buy_price: 98, sell_price: 102, buy_volume: 8, sell_volume: 9 });
    });
    it('clears an explicitly empty stream side instead of reviving snapshot price or volume', async () => {
        await mount([stk]);
        await act(async () => {
            mocks.quotes.set(stk.code, { bidask: { code: stk.code, date: '2026-09-12', time: '09:00:01', bid_price: [], bid_volume: [], ask_price: [102], ask_volume: [9] } });
            mocks.callbacks.get(stk.code)!(); vi.advanceTimersByTime(100);
        });
        expect(value.snapshots.get(stk.code)).toMatchObject({ buy_price: 0, buy_volume: 0, sell_price: 102, sell_volume: 9 });
    });
    it('does not let an older or undated cached quote overwrite a fresh snapshot', async () => {
        mocks.quotes.set(stk.code, { tick: { date: '2026-09-11', time: '13:30:00', close: 90, price_chg: -10 },
            bidask: { code: stk.code, bid_price: [89], ask_price: [91], bid_volume: [2], ask_volume: [2] } });
        await mount([stk]);
        expect(value.snapshots.get(stk.code)).toMatchObject({ close: 100, buy_price: 99, sell_price: 101 });
        await act(async () => { mocks.quotes.set(stk.code, { tick: { close: 80 } }); mocks.callbacks.get(stk.code)!(); vi.advanceTimersByTime(100); });
        expect(value.snapshots.get(stk.code)?.close).toBe(100);
    });

    describe('live window (#371)', () => {
        const opt = (code: string): ContractBase => ({ code, security_type: 'OPT', exchange: 'TAIFEX', target_code: null });
        const [a, b, c] = [opt('A'), opt('B'), opt('C')];
        const retained = () => mocks.retain.mock.calls.map(([x, type]) => `${(x as ContractBase).code}:${type}`);
        const render = (contracts: ContractBase[], live?: ContractBase[]) => act(async () => { root!.update(createElement(Probe, { contracts, live })); });
        it('queries every contract but subscribes only the window', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, b, c], live: [a] })); });
            expect(mocks.fetch).toHaveBeenCalledOnce();
            expect((mocks.fetch.mock.calls[0]![0] as ContractBase[]).map(x => x.code)).toEqual(['A', 'B', 'C']);
            expect(retained()).toEqual(['A:Tick', 'A:BidAsk']);
            expect([...value.snapshots.keys()]).toEqual(['A', 'B', 'C']);
        });
        it('moving the window swaps subscriptions and re-queries only what entered it', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, b, c], live: [a, b] })); });
            const first = [...mocks.releases]; mocks.fetch.mockClear(); mocks.retain.mockClear();
            await render([a, b, c], [b, c]);
            expect(first.every(fn => fn.mock.calls.length === 1)).toBe(true);
            expect(retained()).toEqual(['B:Tick', 'B:BidAsk', 'C:Tick', 'C:BidAsk']);
            expect(mocks.fetch).toHaveBeenCalledOnce();
            expect((mocks.fetch.mock.calls[0]![0] as ContractBase[]).map(x => x.code)).toEqual(['C']);
        });
        it('shows the fresher entered snapshot, and a later full refresh wins over it', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, c], live: [a] })); });
            mocks.fetch.mockImplementationOnce(async () => [{ ...snapshot('C'), datetime: '2026-09-12 10:00:00', total_volume: 77 }]);
            await render([a, c], [c]);
            expect(value.snapshots.get('C')).toMatchObject({ total_volume: 77 });
            mocks.fetch.mockImplementationOnce(async () => [snapshot('A'), { ...snapshot('C'), datetime: '2026-09-12 11:00:00', total_volume: 88 }]);
            await act(async () => { vi.advanceTimersByTime(2000); await value.refresh(); });
            expect(value.snapshots.get('C')).toMatchObject({ total_volume: 88 });
        });
        it('an older entered response arriving late does not replace a newer one', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, c], live: [a] })); });
            const pending: ((rows: Snapshot[]) => void)[] = [];
            mocks.fetch.mockImplementation(() => new Promise<Snapshot[]>(r => { pending.push(r); }));
            await render([a, c], [c]);
            await render([a, c], [a]);
            await render([a, c], [c]);
            expect(pending).toHaveLength(3); // C, A back in, C again
            await act(async () => { pending[2]!([{ ...snapshot('C'), datetime: '2026-09-12 10:00:00.123900', total_volume: 30 }]); });
            await act(async () => { pending[0]!([{ ...snapshot('C'), datetime: '2026-09-12 10:00:00.123100', total_volume: 20 }]); });
            expect(value.snapshots.get('C')).toMatchObject({ total_volume: 30 });
        });
        it('a full refresh wins a tie with an entered snapshot', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, c], live: [a] })); });
            mocks.fetch.mockImplementationOnce(async () => [{ ...snapshot('C'), datetime: '2026-09-12 10:00:00.123900', total_volume: 30 }]);
            await render([a, c], [c]);
            mocks.fetch.mockImplementationOnce(async () => [snapshot('A'), { ...snapshot('C'), datetime: '2026-09-12 10:00:00.123999', total_volume: 40 }]);
            await act(async () => { vi.advanceTimersByTime(2000); await value.refresh(); });
            expect(value.snapshots.get('C')).toMatchObject({ total_volume: 40 });
        });
        it('a catch-up wins a tie with the full snapshot it arrived after', async () => {
            mocks.fetch.mockImplementationOnce(async () => [snapshot('A'), { ...snapshot('C'), datetime: '2026-09-12 10:00:00.123100', total_volume: 20 }]);
            await act(async () => { root = create(createElement(Probe, { contracts: [a, c], live: [a] })); });
            mocks.fetch.mockImplementationOnce(async () => [{ ...snapshot('C'), datetime: '2026-09-12 10:00:00.123900', total_volume: 30 }]);
            await render([a, c], [c]);
            expect(value.snapshots.get('C')).toMatchObject({ total_volume: 30 });
        });
        it('a window that starts empty relies on the full query when it first fills', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, c], live: [] })); });
            expect(mocks.retain).not.toHaveBeenCalled();
            mocks.fetch.mockClear();
            await render([a, c], [c]);
            expect(mocks.fetch).not.toHaveBeenCalled();
            expect(retained()).toEqual(['C:Tick', 'C:BidAsk']);
        });
        it('keeps the full snapshot when the entered query fails', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, c], live: [a] })); });
            mocks.fetch.mockImplementationOnce(async () => { throw new Error('down'); });
            await render([a, c], [c]);
            expect(value.snapshots.get('C')).toMatchObject({ close: 100 });
            expect(value.error).toBeNull();
        });
        it('a new contract set relies on its full query, without an extra entered query', async () => {
            await act(async () => { root = create(createElement(Probe, { contracts: [a, b], live: [a] })); });
            mocks.fetch.mockClear();
            await render([b, c], [c]);
            expect(mocks.fetch).toHaveBeenCalledOnce();
            expect((mocks.fetch.mock.calls[0]![0] as ContractBase[]).map(x => x.code)).toEqual(['B', 'C']);
        });
        it('without a window keeps subscribing everything and never re-queries', async () => {
            await mount([a, b]); mocks.fetch.mockClear();
            await render([a, b]);
            expect(mocks.fetch).not.toHaveBeenCalled();
            expect(retained()).toEqual(['A:Tick', 'A:BidAsk', 'B:Tick', 'B:BidAsk']);
        });
    });
});
