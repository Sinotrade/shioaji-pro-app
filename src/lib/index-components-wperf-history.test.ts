// #330 — 群組加權漲跌依 calculated_at 留歷史，下鑽反推只拿與排行同刻的那包
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    handler: null as ((raw: string) => void) | null,
    fetch: vi.fn(),
}));
vi.mock('./shioaji', () => ({
    fetchIndexComponents: m.fetch,
    subscribeIndexComponents: () => Promise.resolve(),
    unsubscribeIndexComponents: () => Promise.resolve(),
}));
vi.mock('./stream', () => ({
    ensureStream: () => undefined,
    onStreamEvent: (_type: string, handler: (raw: string) => void) => {
        m.handler = handler;
        return () => undefined;
    },
}));

const IX0001 = {
    security_type: 'IND',
    region: 'TW',
    exchange: 'TSE',
    code: 'IX0001',
    target_code: null,
} as const;

function snapshot() {
    return {
        contract: { code: 'IX0001' },
        date: '2026-10-20',
        time: '09:05:00',
        calculated_at: '2026-10-20T09:05:00+08:00',
        reference_date: '2026-10-20',
        market_phase: 'continuous_trading',
        refresh_state: 'ready',
        simtrade: false,
        total_amount: 1,
        entries: [],
        groups: [
            {
                category: '24',
                name: '半導體業',
                item_count: 96,
                equal_weight_pct_chg: '-1',
                weighted_pct_chg: '-1.2',
                points: '-300',
                reference_weight_ppm: 547_111,
                total_amount: 1,
                amount_share_bps: 1,
                advance_count: 0,
                decline_count: 96,
                unchanged_count: 0,
                breadth_bps: -10_000,
            },
        ],
    };
}

function wperfEvent(calculatedAt: string, value: string) {
    return JSON.stringify({
        contract: { code: 'IX0001' },
        projection: { kind: 'group_metric', metric: 'weighted_performance' },
        date: '2026-10-20',
        time: calculatedAt.slice(11, 19),
        calculated_at: calculatedAt,
        market_phase: 'continuous_trading',
        simtrade: false,
        groups: [
            { category: '24', name: '半導體業', item_count: 96, value },
        ],
    });
}

describe('getIcGroupWperfAt', () => {
    beforeEach(() => {
        vi.resetModules();
        m.handler = null;
        m.fetch.mockReset();
        m.fetch.mockResolvedValue(snapshot());
    });

    it('建底快照與串流包都依 calculated_at 記錄；只回傳同一瞬間的值', async () => {
        const ic = await import('./index-components');
        ic.retainIndexComponents(IX0001, {
            kind: 'group_metric',
            metric: 'weighted_performance',
        });
        await vi.waitFor(() =>
            expect(ic.getIcBootstrapStatus('IX0001').status).toBe('ready'),
        );
        // 建底快照的群組漲跌（排行由同一快照投出時可對上）
        expect(
            ic.getIcGroupWperfAt('IX0001', '24', '2026-10-20T09:05:00+08:00'),
        ).toBe(-1.2);

        m.handler!(wperfEvent('2026-10-20T13:49:55.000000+08:00', '-0.30'));
        m.handler!(wperfEvent('2026-10-20T13:50:00.000000+08:00', '-0.24'));
        // 小數位數不同的同一瞬間視為同刻
        expect(
            ic.getIcGroupWperfAt('IX0001', '24', '2026-10-20T13:49:55+08:00'),
        ).toBe(-0.3);
        expect(
            ic.getIcGroupWperfAt(
                'IX0001',
                '24',
                '2026-10-20T13:50:00.000000+08:00',
            ),
        ).toBe(-0.24);
        // 差 1 秒、或排行停在更早的時刻 → 沒有同刻資料
        expect(
            ic.getIcGroupWperfAt('IX0001', '24', '2026-10-20T13:49:56+08:00'),
        ).toBeUndefined();
        expect(
            ic.getIcGroupWperfAt('IX0001', '24', '2026-10-20T09:10:00+08:00'),
        ).toBeUndefined();
        expect(ic.getIcGroupWperfAt('IX0001', '24', undefined)).toBeUndefined();
        expect(ic.getIcGroupWperfAt('IX0001', '99', '2026-10-20T13:50:00+08:00')).toBeUndefined();
    });

    it('晚到的舊包不覆蓋目前狀態，但仍記入歷史', async () => {
        const ic = await import('./index-components');
        ic.retainIndexComponents(IX0001, {
            kind: 'group_metric',
            metric: 'weighted_performance',
        });
        await vi.waitFor(() =>
            expect(ic.getIcBootstrapStatus('IX0001').status).toBe('ready'),
        );
        m.handler!(wperfEvent('2026-10-20T13:50:01+08:00', '-0.20'));
        m.handler!(wperfEvent('2026-10-20T13:50:00+08:00', '-0.24'));
        expect(
            ic.getIcState('IX0001', 'gm:weighted_performance')?.groups?.[0]
                ?.value,
        ).toBe(-0.2);
        expect(
            ic.getIcGroupWperfAt('IX0001', '24', '2026-10-20T13:50:00+08:00'),
        ).toBe(-0.24);
    });

    it('歷史只保留最近 120 包', async () => {
        const ic = await import('./index-components');
        ic.retainIndexComponents(IX0001, {
            kind: 'group_metric',
            metric: 'weighted_performance',
        });
        await vi.waitFor(() =>
            expect(ic.getIcBootstrapStatus('IX0001').status).toBe('ready'),
        );
        const base = Date.parse('2026-10-20T13:00:00+08:00');
        const iso = (i: number) =>
            new Date(base + i * 1000).toISOString();
        for (let i = 0; i < 125; i++) m.handler!(wperfEvent(iso(i), String(i)));
        expect(ic.getIcGroupWperfAt('IX0001', '24', iso(0))).toBeUndefined();
        expect(ic.getIcGroupWperfAt('IX0001', '24', iso(124))).toBe(124);
        expect(ic.getIcGroupWperfAt('IX0001', '24', iso(5))).toBe(5);
    });
});
