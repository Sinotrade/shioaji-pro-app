// 美股走 `US:CODE`：不打 region=TW 查詢，也不佔用台股裸代碼
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), us: vi.fn() }));
vi.mock('./shioaji', () => ({ resolveContract: mocks.resolve }));
vi.mock('./stream', () => ({ registerCodeAlias: vi.fn() }));
vi.mock('./tick-bands', () => ({ prefetchTickBands: vi.fn() }));
vi.mock('./us/us-contracts', () => ({ resolveUsContract: mocks.us }));

beforeEach(() => {
    vi.resetModules();
    mocks.resolve.mockReset();
    mocks.us.mockReset();
});

describe('contracts cache with US keys', () => {
    it('resolves US:CODE through US contract info and keeps the bare code for TW', async () => {
        const api = await import('./contracts-cache');
        mocks.us.mockResolvedValue({ region: 'US', code: 'T', exchange: 'NYSE', security_type: 'STK', name: 'AT&T', reference: 25 });
        const us = await api.ensureContract('US:T');
        expect(mocks.us).toHaveBeenCalledWith('T');
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(us.region).toBe('US');
        expect(api.getCachedContract('US:T')).toBe(us);
        expect(api.getCachedContract('T')).toBeUndefined();
        api.primeContract(us);
        expect(api.getCachedContract('T')).toBeUndefined();
    });
});
