// 美股沒有快照，也不在台股行情訂閱裡保留（美股即時價走 useQuote('US:CODE')）
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractBase } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), retain: vi.fn(), subscribe: vi.fn() }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('../lib/shioaji', () => ({ fetchSnapshots: mocks.fetch }));
vi.mock('../lib/quote-ownership', () => ({ retainQuote: mocks.retain }));
vi.mock('../lib/stream', () => ({ getQuote: () => undefined, registerCodeAlias: vi.fn(), subscribeQuoteStore: mocks.subscribe }));

const tw: ContractBase = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null };
const us: ContractBase = { code: 'AAPL', security_type: 'STK', exchange: 'NASDAQ', target_code: null, region: 'US' };
const snapshot = (code: string) => ({ code, datetime: '2026-11-18 09:00:00', close: 100, change_price: 0, change_rate: 0 }) as Snapshot;
let root: ReactTestRenderer | undefined;
let value: { snapshots: Map<string, Snapshot> };
let hook: typeof import('./use-live-snapshots').useLiveSnapshots;
function Probe({ contracts }: { contracts: ContractBase[] }) { value = hook(contracts); return null; }

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.fetch.mockReset().mockImplementation(async (contracts: ContractBase[]) => contracts.map(c => snapshot(c.code)));
    mocks.retain.mockReset().mockImplementation(() => () => undefined);
    mocks.subscribe.mockReset().mockImplementation(() => () => undefined);
    hook = (await import('./use-live-snapshots')).useLiveSnapshots;
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.unstubAllGlobals(); });

it('drops US contracts from the snapshot query and the TW quote retention', async () => {
    await act(async () => { root = create(createElement(Probe, { contracts: [tw, us] })); });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]![0]).toEqual([tw]);
    expect(mocks.retain.mock.calls.every(([c]) => (c as ContractBase).region !== 'US')).toBe(true);
    expect(mocks.subscribe.mock.calls.map(([code]) => code)).toEqual(['2330']);
    expect(value.snapshots.has('AAPL')).toBe(false);
});

it('does not query at all for a US-only list', async () => {
    await act(async () => { root = create(createElement(Probe, { contracts: [us] })); });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.retain).not.toHaveBeenCalled();
});
