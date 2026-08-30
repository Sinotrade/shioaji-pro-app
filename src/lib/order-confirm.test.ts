// 可視化委託確認服務：resolve 流程、單一 pending、環境快取容錯

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./shioaji', () => ({
    fetchInfo: vi.fn(() =>
        Promise.resolve({ simulation: true }) as Promise<{
            simulation: boolean;
        }>,
    ),
}));

import {
    getPendingOrderConfirm,
    requestOrderConfirm,
    resetOrderConfirmForTest,
    resolveOrderConfirm,
    setSimulationCacheForTest,
} from './order-confirm';

const req = {
    code: 'CCFI6',
    name: '聯電期貨',
    action: 'Buy' as const,
    price: 130.5,
    quantity: 1,
    unit: '口',
};

afterEach(() => {
    resetOrderConfirmForTest();
});

describe('requestOrderConfirm', () => {
    it('確認 → resolve true，pending 清空', async () => {
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        expect(getPendingOrderConfirm()?.code).toBe('CCFI6');
        resolveOrderConfirm(true);
        await expect(promise).resolves.toBe(true);
        expect(getPendingOrderConfirm()).toBeNull();
    });

    it('取消 → resolve false', async () => {
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        resolveOrderConfirm(false);
        await expect(promise).resolves.toBe(false);
    });

    it('已有 pending 時第二筆直接 reject（不排隊）', async () => {
        const first = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        await expect(
            requestOrderConfirm({ ...req, code: '2330' }),
        ).rejects.toThrow('已有待確認的委託');
        resolveOrderConfirm(false);
        await first;
    });

    it('cold cache 下同一 tick 的第二筆也會直接 reject', async () => {
        setSimulationCacheForTest(null);
        const first = requestOrderConfirm(req);
        await expect(
            requestOrderConfirm({ ...req, code: '2330' }),
        ).rejects.toThrow('已有待確認的委託');
        resolveOrderConfirm(false);
        await expect(first).resolves.toBe(false);
    });

    it('環境快取已知時帶入 simulation flag', async () => {
        setSimulationCacheForTest(false);
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        expect(getPendingOrderConfirm()?.simulation).toBe(false);
        resolveOrderConfirm(false);
        await promise;
    });

    it('保留整批限價區間供確認視窗顯示', async () => {
        const promise = requestOrderConfirm({
            ...req,
            price: null,
            priceLabel: '128.5 ～ 132.5 限價',
        });
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        expect(getPendingOrderConfirm()?.priceLabel).toBe(
            '128.5 ～ 132.5 限價',
        );
        resolveOrderConfirm(false);
        await promise;
    });
});
