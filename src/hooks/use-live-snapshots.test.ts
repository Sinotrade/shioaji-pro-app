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
function Probe({ contracts }: { contracts: ContractBase[] }) { value = hook(contracts); renders++; return null; }
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
                mocks.quotes.set(c.code, { tick: { date: '2026-09-12', time: '09:00:01', close: 110, price_chg: 10, pct_chg: c === stk ? 10 : 0.1, volume: 2, total_volume: 10 }, bidask: { date: '2026-09-12', time: '09:00:01', bid_price: [109], ask_price: [111], bid_volume: [3], ask_volume: [4] } });
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
        await act(async () => { mocks.quotes.set(stk.code, { bidask: { date: '2026-09-12', time: '09:00:01', bid_price: [98], ask_price: [102], bid_volume: [8], ask_volume: [9] } }); mocks.callbacks.get(stk.code)!(); vi.advanceTimersByTime(100); });
        expect(value.snapshots.get(stk.code)).toMatchObject({ close: 100, buy_price: 98, sell_price: 102, buy_volume: 8, sell_volume: 9 });
    });
    it('does not let an older or undated cached quote overwrite a fresh snapshot', async () => {
        mocks.quotes.set(stk.code, { tick: { date: '2026-09-11', time: '13:30:00', close: 90, price_chg: -10 },
            bidask: { bid_price: [89], ask_price: [91], bid_volume: [2], ask_volume: [2] } });
        await mount([stk]);
        expect(value.snapshots.get(stk.code)).toMatchObject({ close: 100, buy_price: 99, sell_price: 101 });
        await act(async () => { mocks.quotes.set(stk.code, { tick: { close: 80 } }); mocks.callbacks.get(stk.code)!(); vi.advanceTimersByTime(100); });
        expect(value.snapshots.get(stk.code)?.close).toBe(100);
    });

});
