import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ list: vi.fn(), info: vi.fn() }));
vi.mock('./us-api', () => ({ fetchUsContractList: m.list, fetchUsContractInfo: m.info }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};

import * as c from './us-contracts';
import { todayStr } from '../utils/date';

const rec = (code: string, exchange = 'NASDAQ') => ({ security_type: 'STK', region: 'US', exchange, code, target_code: null });

beforeEach(() => {
    store.clear();
    m.list.mockReset();
    m.info.mockReset();
    c.resetUsContractsForTest();
});

describe('US contract list', () => {
    it('marks an empty or failed list as unsupported (1.7.11 sidecar)', async () => {
        m.list.mockResolvedValueOnce({ contracts: [] });
        await c.ensureUsContracts();
        expect(c.usCatalogStatus()).toBe('unsupported');
        expect(c.searchUsCodes('A')).toEqual([]);
        c.resetUsContractsForTest();
        m.list.mockRejectedValueOnce(new Error('400 bad region'));
        await c.ensureUsContracts();
        expect(c.usCatalogStatus()).toBe('unsupported');
    });

    it('searches by code prefix, exact match first then shorter codes', async () => {
        m.list.mockResolvedValueOnce({ contracts: ['AAPL', 'AA', 'AAL', 'AAPB', 'MSFT', 'A'].map(x => rec(x)) });
        await c.ensureUsContracts();
        expect(c.usCatalogStatus()).toBe('ready');
        expect(c.searchUsCodes('aa').map(r => r.code)).toEqual(['AA', 'AAL', 'AAPB', 'AAPL']);
        expect(c.searchUsCodes('AAPL').map(r => r.code)).toEqual(['AAPL']);
        expect(c.searchUsCodes('A', 2).map(r => r.code)).toEqual(['A', 'AA']);
        expect(c.searchUsCodes('台積')).toEqual([]);
    });
});

describe('US contract info cache', () => {
    it('caches per code per day and caps concurrency at 4', async () => {
        const resolvers: (() => void)[] = [];
        m.info.mockImplementation((code: string) => new Promise(resolve => {
            resolvers.push(() => resolve({ code, exchange: 'NASDAQ', region: 'US', security_type: 'STK', name: `${code} Inc.`, reference: 173.97, reference_date: '2026-11-17' }));
        }));
        const loads = ['A', 'B', 'C', 'D', 'E', 'F'].map(code => c.loadUsInfo(code));
        await Promise.resolve();
        expect(m.info).toHaveBeenCalledTimes(c.US_INFO_CONCURRENCY);
        expect(c.usInfoLoadStats()).toEqual({ active: 4, queued: 2 });
        while (resolvers.length) { resolvers.shift()!(); await new Promise(r => setTimeout(r, 0)); }
        const all = await Promise.all(loads);
        expect(m.info).toHaveBeenCalledTimes(6);
        expect(all[0]).toMatchObject({ code: 'A', name: 'A Inc.', reference: '173.97', fetchedOn: todayStr() });
        // 同一天再查：不發請求，名稱也能同步讀到
        await c.loadUsInfo('a');
        expect(m.info).toHaveBeenCalledTimes(6);
        expect(c.usContractName('A')).toBe('A Inc.');
        expect(JSON.parse(store.get('sj-pro-us-contract-info:v1')!).A.name).toBe('A Inc.');
    });

    it('refreshes a stale (previous day) entry', async () => {
        store.set('sj-pro-us-contract-info:v1', JSON.stringify({ AAPL: { code: 'AAPL', exchange: 'NASDAQ', name: 'Old', fetchedOn: '2000-01-01' } }));
        c.resetUsContractsForTest();
        expect(c.cachedUsInfo('AAPL')).toBeUndefined();
        m.info.mockResolvedValueOnce({ code: 'AAPL', exchange: 'NASDAQ', region: 'US', security_type: 'STK', name: 'Apple Inc.', reference: '230.1' });
        await c.loadUsInfo('AAPL');
        expect(c.usContractName('AAPL')).toBe('Apple Inc.');
    });

    it('prefers a registered name source, then the list, then info', async () => {
        m.list.mockResolvedValueOnce({ contracts: [{ ...rec('MSFT'), name: 'Microsoft (list)' }, rec('NVDA')] });
        await c.ensureUsContracts();
        expect(c.usContractName('MSFT')).toBe('Microsoft (list)');
        expect(c.usContractName('NVDA')).toBeUndefined();
        const off = c.registerUsNameSource(code => (code === 'NVDA' ? 'NVIDIA' : undefined));
        expect(c.usContractName('nvda')).toBe('NVIDIA');
        off();
        expect(c.usContractName('NVDA')).toBeUndefined();
    });
});
