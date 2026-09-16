import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

beforeEach(() => {
    vi.resetModules();
    storage.clear();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    });
});

describe('daily-loss risk gate', () => {
    it('fails closed while broker P&L is unknown, then enforces the limit', async () => {
        const risk = await import('./risk');
        risk.setRiskSettings({
            enabled: true,
            maxQty: 1,
            maxDailyLoss: 5_000,
            confirmManualOrders: true,
        });

        expect(risk.getDailyPnl()).toBeNull();
        expect(risk.checkOrderAllowed(1)).toContain('尚未');

        risk.reportDailyPnl(-4_999);
        expect(risk.checkOrderAllowed(1)).toBeNull();

        risk.reportDailyPnl(-5_000);
        expect(risk.checkOrderAllowed(1)).toContain('已達上限');
    });

    it('turns non-finite P&L back into unknown', async () => {
        const risk = await import('./risk');
        risk.setRiskSettings({ enabled: true, maxDailyLoss: 5_000 });
        risk.reportDailyPnl(Number.NaN);
        expect(risk.getDailyPnl()).toBeNull();
        expect(risk.checkOrderAllowed(1)).toContain('尚未');
    });
});
