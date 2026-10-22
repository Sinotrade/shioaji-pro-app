import { afterEach, describe, expect, it, vi } from 'vitest';

const pending: { code: string; resolve: () => void }[] = [];
let active = 0;
let peak = 0;

vi.mock('./shioaji', () => ({
    fetchContracts: vi.fn(),
    fetchWarrantUnderlyings: vi.fn(),
    fetchContractInfo: vi.fn(
        (code: string) =>
            new Promise((resolve) => {
                active += 1;
                peak = Math.max(peak, active);
                pending.push({
                    code,
                    resolve: () => {
                        active -= 1;
                        resolve({ code, name: `N${code}`, category: '24' });
                    },
                });
            }),
    ),
}));

const { DETAIL_CONCURRENCY, loadStockDetails } = await import('./stock-index');

afterEach(() => {
    pending.length = 0;
    active = 0;
    peak = 0;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadStockDetails', () => {
    it('caps concurrent contract-info requests and still loads every code', async () => {
        const codes = Array.from({ length: 40 }, (_, i) => String(1000 + i));
        const done = loadStockDetails(codes);
        await flush();
        expect(pending.length).toBe(DETAIL_CONCURRENCY);
        while (pending.length > 0) {
            pending.shift()!.resolve();
            await flush();
        }
        const details = await done;
        expect(details).toHaveLength(40);
        expect(peak).toBe(DETAIL_CONCURRENCY);
    });
});
