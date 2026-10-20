import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./api', () => ({ apiGet: m.get, apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(), shouldProxyAgentHarnessMutation: vi.fn() }));

beforeEach(() => { vi.resetModules(); m.get.mockReset().mockResolvedValue([]); });

describe('search contract reads forward transport cancellation without changing endpoints', () => {
    it('forwards the same signal to Base and Info of direct stock resolution', async () => {
        m.get.mockResolvedValueOnce({ code: '2330', security_type: 'STK', exchange: 'TSE' })
            .mockResolvedValueOnce({ code: '2330', security_type: 'STK', name: '台積電' });
        const { resolveContract } = await import('./shioaji');
        const controller = new AbortController();
        expect((await resolveContract('2330', undefined, { signal: controller.signal })).name).toBe('台積電');
        expect(m.get).toHaveBeenNthCalledWith(1, '/api/v1/data/contracts/2330?region=TW', { signal: controller.signal });
        expect(m.get).toHaveBeenNthCalledWith(2, '/api/v1/data/contracts/2330/info?security_type=STK&region=TW', { signal: controller.signal });
    });

    it('does not begin Info after an aborted Base eventually completes', async () => {
        let finish!: (value: object) => void;
        m.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const { resolveContract } = await import('./shioaji');
        const controller = new AbortController();
        const pending = resolveContract('2330', undefined, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        finish({ code: '2330', security_type: 'STK', exchange: 'TSE' });
        await rejected;
        expect(m.get).toHaveBeenCalledTimes(1);
    });

    it('forwards the signal to all batch catalog, root and related-product reads', async () => {
        const api = await import('./shioaji');
        const controller = new AbortController();
        const opts = { signal: controller.signal };
        await api.fetchContracts('STK', undefined, undefined, opts);
        await api.fetchWarrantUnderlyings(opts);
        await api.fetchFuturesRoots(opts);
        await api.fetchFutures({ underlyingCode: '2330' }, opts);
        await api.fetchOptionRoots(opts);
        await api.fetchOptions('CDA', {}, opts);
        await api.fetchWarrants('2330', { expiryFrom: '2026-10-17' }, opts);
        expect(m.get.mock.calls).toEqual([
            ['/api/v1/data/contracts?security_type=STK&region=TW', opts],
            ['/api/v1/data/contracts/warrants/underlyings?region=TW&include_name=true', opts],
            ['/api/v1/data/contracts/futures/roots?region=TW', opts],
            ['/api/v1/data/contracts/futures?underlying_code=2330&region=TW', opts],
            ['/api/v1/data/contracts/options/roots?region=TW', opts],
            ['/api/v1/data/contracts/options?root=CDA&region=TW', opts],
            ['/api/v1/data/contracts/warrants?underlying_code=2330&expiry_from=2026-10-17&region=TW', opts],
        ]);
    });
});
