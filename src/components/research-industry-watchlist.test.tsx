import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
import type { QuoteState } from '../lib/stream';
import type { Snapshot } from '../lib/types/market';
import { ResearchIndustryWatchlist, ResearchIndustryWatchlistView } from './research-industry-watchlist';

const mocks = vi.hoisted(() => ({
    contracts: new Map<string, ContractInfo>(), quotes: new Map<string, QuoteState>(), snapshots: new Map<string, Snapshot>(),
    ensureContract: vi.fn(), ensureStream: vi.fn(), retainContractQuotes: vi.fn(), request: vi.fn(),
    subscribeQuoteStore: vi.fn(() => () => undefined), subscribeMarketSnapshots: vi.fn(() => () => undefined),
}));
vi.mock('../lib/contracts-cache', () => ({ useContract: (code: string) => mocks.contracts.get(code), ensureContract: mocks.ensureContract }));
vi.mock('../lib/stream', () => ({ getQuote: (code: string) => mocks.quotes.get(code), subscribeQuoteStore: mocks.subscribeQuoteStore, ensureStream: mocks.ensureStream }));
vi.mock('../lib/market-snapshot-store', () => ({ getMarketSnapshot: (contract: ContractInfo) => mocks.snapshots.get(contract.code), subscribeMarketSnapshots: mocks.subscribeMarketSnapshots }));
vi.mock('../lib/quote-ownership', () => ({ retainContractQuotes: mocks.retainContractQuotes }));
vi.mock('../lib/shioaji', () => ({ resolveContract: mocks.request, getSnapshots: mocks.request, getKBars: mocks.request, subscribe: mocks.request }));
vi.mock('./research-industry-watchlist.css', () => ({ root: '', toolbar: '', control: '', note: '', body: '', group: '', heading: '', row: { normal: '', selected: 'selected' }, identity: '', code: '', name: '', numbers: '', price: { up: 'up', down: 'down', flat: 'flat' }, source: '', empty: '' }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); mocks.contracts.clear(); mocks.quotes.clear(); mocks.snapshots.clear(); });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
const rows = () => renderer!.root.findAllByType('button').filter(button => button.props['data-stock-code']);
const noNetwork = () => { expect(mocks.ensureContract).not.toHaveBeenCalled(); expect(mocks.ensureStream).not.toHaveBeenCalled(); expect(mocks.retainContractQuotes).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); };

it('mounts all 49 stocks as local observers with missing values and no network/subscription ownership', async () => {
    const pick = vi.fn();
    await act(async () => { renderer = create(<ResearchIndustryWatchlist onPick={pick} />); });
    expect(rows()).toHaveLength(49);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain('全部 17 產業'); expect(text).toContain('49/49'); expect(text).toContain('合約未載入'); expect(text).toContain('非最新龍頭排行／買進推薦');
    expect(text).not.toContain('0.00%'); expect(text).not.toContain('0.00'); expect(pick).not.toHaveBeenCalled(); noNetwork();
});
it('filters industry/search locally and clicks exactly one symbol through the existing picker', async () => {
    const pick = vi.fn();
    await act(async () => { renderer = create(<ResearchIndustryWatchlist onPick={pick} selectedCode='2330' />); });
    await act(async () => renderer!.root.findByType('select').props.onChange({ target: { value: '晶圓代工' } }));
    expect(rows().map(row => row.props['data-stock-code'])).toEqual(['2330', '2303', '5347']);
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: '台積' } }));
    expect(rows()).toHaveLength(1); expect(rows()[0]!.props['aria-pressed']).toBe(true);
    await act(async () => rows()[0]!.props.onClick());
    expect(pick).toHaveBeenCalledTimes(1); expect(pick).toHaveBeenCalledWith('2330'); noNetwork();
    await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'not-found' } }));
    expect(rows()).toHaveLength(0); expect(JSON.stringify(renderer!.toJSON())).toContain('沒有符合的觀察股票'); noNetwork();
});
it('shows only valid loaded values, with timestamp/source and explicit snapshot/unloaded distinction', async () => {
    mocks.contracts.set('2330', { code: '2330', security_type: 'STK', exchange: 'TSE', region: 'TW', reference: 100 } as ContractInfo);
    mocks.quotes.set('2330', { tick: { code: '2330', close: '105', price_chg: '5', date: '2026-10-02', time: '13:29:59' } } as QuoteState);
    mocks.contracts.set('2303', { code: '2303', security_type: 'STK', exchange: 'TSE', region: 'TW', reference: 40 } as ContractInfo);
    mocks.snapshots.set('2303', { code: '2303', exchange: 'TSE', close: 41, change_price: 1, change_rate: 2.5, datetime: '2026-10-02T13:30:00' } as Snapshot);
    mocks.contracts.set('5347', { code: '5347', security_type: 'STK', exchange: 'OTC', region: 'TW', reference: 100 } as ContractInfo);
    await act(async () => { renderer = create(<ResearchIndustryWatchlist onPick={vi.fn()} />); });
    const tsmc = rows().find(row => row.props['data-stock-code'] === '2330')!;
    expect(tsmc.findAllByType('span').some(span => span.children.includes('105.00'))).toBe(true); expect(tsmc.props.title).toContain('2026-10-02 13:29:59');
    expect(JSON.stringify(renderer!.toJSON())).toContain('+5.00% · 已載入逐筆'); expect(JSON.stringify(renderer!.toJSON())).toContain('+2.50% · 已載入快照');
    const world = rows().find(row => row.props['data-stock-code'] === '5347')!; expect(world.props.title).toContain('未載入');
    noNetwork();
});
it('provides an entirely pure fixture view without even observing live stores', async () => {
    await act(async () => { renderer = create(<ResearchIndustryWatchlistView onPick={vi.fn()} selectedCode='2330' />); });
    expect(rows()).toHaveLength(49); expect(mocks.subscribeQuoteStore).not.toHaveBeenCalled(); expect(mocks.subscribeMarketSnapshots).not.toHaveBeenCalled();
    expect(rows().find(row => row.props['data-stock-code'] === '2330')!.props['aria-pressed']).toBe(true); noNetwork();
});
