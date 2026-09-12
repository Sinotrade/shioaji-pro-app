import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '../lib/types/market';
import type { ContractBase } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ cold: false, fetch: vi.fn(), quote: { bidask: undefined }, contract: (code: string) => ({ code, target_code: code === 'TXFR1' ? 'TXFI6' : null, security_type: 'FUT' as const, exchange: 'TAIFEX' as const }) }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('../lib/contracts-cache', () => ({ useContract: (code: string) => mocks.cold ? undefined : mocks.contract(code) }));
vi.mock('../lib/shioaji', () => ({ fetchSnapshots: mocks.fetch }));
vi.mock('./use-stream', () => ({ useQuote: () => mocks.quote }));
const roots: ReactTestRenderer[] = [];
let hook: typeof import('./use-display-book').useDisplayBook;
const values = new Map<string, ReturnType<typeof hook>>();
function Probe({ code, supplied, contract }: { code: string; supplied?: Snapshot; contract?: ContractBase }) { values.set(code, hook(code, supplied, contract)); return null; }
async function mount(code: string) { let root!: ReactTestRenderer; await act(async () => { root = create(createElement(Probe, { code })); }); roots.push(root); return root; }
const snap = (code: string) => ({ code, datetime: '2026-09-12 09:00:00', buy_price: 100, buy_volume: 2, sell_price: 101, sell_volume: 3 }) as Snapshot;
beforeEach(async () => { vi.resetModules(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); values.clear(); mocks.fetch.mockReset().mockImplementation(async (cs: { code: string; target_code: string | null }[]) => cs.map(c => snap(c.target_code || c.code))); hook = (await import('./use-display-book')).useDisplayBook; });
afterEach(async () => { await act(async () => { for (const r of roots.splice(0)) r.unmount(); }); vi.unstubAllGlobals(); });
it('shares one fetch for alias/physical consumers without injecting fallback into stream', async () => {
    await mount('TXFR1'); await mount('TXFI6');
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(values.get('TXFR1')!.book!.source).toBe('snapshot'); expect(values.get('TXFI6')!.book!.source).toBe('snapshot');
    expect(values.get('TXFI6')!.quote).toBe(mocks.quote); expect(mocks.quote.bidask).toBeUndefined();
});
it('waits for an existing batch instead of issuing another fetch', async () => {
    const store = await import('../lib/market-snapshot-store'); let resolve!: (v: Snapshot[]) => void;
    const pending = new Promise<Snapshot[]>(r => { resolve = r; });
    store.observeMarketSnapshots([mocks.contract('TXFI6')], pending);
    await mount('TXFI6'); expect(mocks.fetch).not.toHaveBeenCalled();
    await act(async () => { resolve([snap('TXFI6')]); await pending; });
    expect(values.get('TXFI6')!.book!.bids).toEqual([{ price: 100, vol: 2 }]); expect(mocks.fetch).not.toHaveBeenCalled();
});
it('does not display late A data after switching to B', async () => {
    let resolve!: (v: Snapshot[]) => void; mocks.fetch.mockImplementationOnce(() => new Promise<Snapshot[]>(r => { resolve = r; }));
    const root = await mount('TXFI6'); await act(async () => { root.update(createElement(Probe, { code: 'TXFJ6' })); });
    await act(async () => { resolve([snap('TXFI6')]); });
    expect(values.get('TXFJ6')!.snapshot!.code).toBe('TXFJ6');
});
it('keeps zero and negative combo L1 with a supplied contract when the contract cache is cold', async () => {
    mocks.cold = true;
    const contract = { ...mocks.contract('TXFI6/J6'), combo: { legs: [], combo_type: 'Spread' } };
    const supplied = { ...snap(contract.code), buy_price: -1, sell_price: 0 };
    let root!: ReactTestRenderer;
    await act(async () => { root = create(createElement(Probe, { code: contract.code, contract, supplied })); }); roots.push(root);
    expect(values.get(contract.code)!.book).toMatchObject({ source: 'snapshot', bids: [{ price: -1, vol: 2 }], asks: [{ price: 0, vol: 3 }] });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.quote.bidask).toBeUndefined();
    mocks.cold = false;
});
it('keeps five stream levels when a parent tick projection has a later synthetic timestamp', async () => {
    const store = await import('../lib/market-snapshot-store');
    await store.observeMarketSnapshots([mocks.contract('TXFI6')], Promise.resolve([snap('TXFI6')]));
    Object.assign(mocks.quote, { bidask: { code: 'TXFI6', date: '2026-09-12', time: '09:01:00',
        bid_price: ['100', '99', '98', '97', '96'], bid_volume: [1, 2, 3, 4, 5],
        ask_price: ['101', '102', '103', '104', '105'], ask_volume: [6, 7, 8, 9, 10] } });
    let root!: ReactTestRenderer;
    await act(async () => { root = create(createElement(Probe, { code: 'TXFI6', supplied: { ...snap('TXFI6'), datetime: '2026-09-12 09:02:00' } })); });
    roots.push(root);
    expect(values.get('TXFI6')!.book!.source).toBe('stream');
    expect(values.get('TXFI6')!.book!.bids).toHaveLength(5);
    expect(values.get('TXFI6')!.book!.asks).toHaveLength(5);
    expect(mocks.fetch).not.toHaveBeenCalled();
    Object.assign(mocks.quote, { bidask: undefined });
});
