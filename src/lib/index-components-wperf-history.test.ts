// #330 — 群組加權漲跌與排行的時間配對：建底同快照精確配對、盤中 AS-OF
// （calculated_at ≤ T 的最後一包，限同一連線世代、持續訂閱）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    handler: null as ((raw: string) => void) | null,
    fetch: vi.fn(),
    epoch: 1,
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
    streamConnectionEpoch: () => m.epoch,
}));

const IX0001 = {
    security_type: 'IND',
    region: 'TW',
    exchange: 'TSE',
    code: 'IX0001',
    target_code: null,
} as const;
const WPERF = { kind: 'group_metric', metric: 'weighted_performance' } as const;
const BOOT_AT = '2026-10-20T09:05:00+08:00';

function snapshot() {
    return {
        contract: { code: 'IX0001' },
        date: '2026-10-20',
        time: '09:05:00',
        calculated_at: BOOT_AT,
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
        projection: WPERF,
        date: '2026-10-20',
        time: calculatedAt.slice(11, 19),
        calculated_at: calculatedAt,
        market_phase: 'continuous_trading',
        simtrade: false,
        groups: [{ category: '24', name: '半導體業', item_count: 96, value }],
    });
}

async function setup() {
    const ic = await import('./index-components');
    const release = ic.retainIndexComponents(IX0001, WPERF);
    await vi.waitFor(() =>
        expect(ic.getIcBootstrapStatus('IX0001').status).toBe('ready'),
    );
    const at = (t: string) => ic.getIcGroupWperfAt('IX0001', '24', t);
    return { ic, release, at };
}

describe('getIcGroupWperfAt', () => {
    beforeEach(() => {
        vi.resetModules();
        m.handler = null;
        m.epoch = 1;
        m.fetch.mockReset();
        m.fetch.mockResolvedValue(snapshot());
    });

    it('時間解析保留次毫秒精度', async () => {
        const { ic } = await setup();
        const a = ic.parseCalculatedAtNs('2026-10-20T13:50:00.123001+08:00')!;
        const b = ic.parseCalculatedAtNs('2026-10-20T13:50:00.123999+08:00')!;
        expect(b - a).toBe(998_000n);
        expect(ic.parseCalculatedAtNs('2026-10-20T13:50:00+08:00')).toBe(
            ic.parseCalculatedAtNs('2026-10-20T13:50:00.000000000+08:00'),
        );
        expect(ic.parseCalculatedAtNs('2026-10-20T05:50:00Z')).toBe(
            ic.parseCalculatedAtNs('2026-10-20T13:50:00+0800'),
        );
        expect(ic.parseCalculatedAtNs('2026-10-20T13:50:00')).toBeNull();
        expect(ic.parseCalculatedAtNs('garbage')).toBeNull();
    });

    it('次毫秒差異不會被當成同一刻（AS-OF 取 ≤ T 的那包）', async () => {
        const { at } = await setup();
        m.handler!(wperfEvent('2026-10-20T13:50:00.123999+08:00', '-0.30'));
        // 早於唯一一包 → 不在涵蓋範圍
        expect(at('2026-10-20T13:50:00.123001+08:00')).toBeUndefined();
        expect(at('2026-10-20T13:50:00.123999+08:00')).toBe(-0.3);
    });

    it('建底快照：與同一快照投出的排行精確配對', async () => {
        const { at } = await setup();
        expect(at(BOOT_AT)).toBe(-1.2);
        expect(at('2026-10-20T09:05:00.000000+08:00')).toBe(-1.2);
        // 建底之後沒有 live 包 → 其餘時刻無法判定
        expect(at('2026-10-20T09:05:01+08:00')).toBeUndefined();
    });

    it('wperf 未變（沒有新包）時，多次排行更新仍取得當時有效的群組漲跌', async () => {
        const { at } = await setup();
        m.handler!(wperfEvent('2026-10-20T13:49:58+08:00', '-0.30'));
        m.handler!(wperfEvent('2026-10-20T13:50:01+08:00', '-0.24'));
        // 排行 13:50:00、13:50:05、13:50:10 更新，期間群組只變過一次
        expect(at('2026-10-20T13:50:00+08:00')).toBe(-0.3);
        expect(at('2026-10-20T13:50:05+08:00')).toBe(-0.24);
        expect(at('2026-10-20T13:50:10+08:00')).toBe(-0.24);
        // 排行早於歷史最早一包 → 無法判定（顯示「—」）
        expect(at('2026-10-20T13:49:50+08:00')).toBeUndefined();
        expect(at(undefined as unknown as string)).toBeUndefined();
    });

    it('亂序到達的舊包依時間插入，不覆蓋目前狀態', async () => {
        const { ic, at } = await setup();
        m.handler!(wperfEvent('2026-10-20T13:50:02+08:00', '-0.20'));
        m.handler!(wperfEvent('2026-10-20T13:50:00+08:00', '-0.24'));
        expect(
            ic.getIcState('IX0001', 'gm:weighted_performance')?.groups?.[0]
                ?.value,
        ).toBe(-0.2);
        expect(at('2026-10-20T13:50:01+08:00')).toBe(-0.24);
        expect(at('2026-10-20T13:50:03+08:00')).toBe(-0.2);
    });

    it('重連（連線世代改變）後清空 AS-OF 歷史，從新包重新累積', async () => {
        const { at } = await setup();
        m.handler!(wperfEvent('2026-10-20T13:50:00+08:00', '-0.24'));
        expect(at('2026-10-20T13:50:05+08:00')).toBe(-0.24);
        m.epoch = 2; // 斷線重連 — 期間可能漏包
        expect(at('2026-10-20T13:50:05+08:00')).toBeUndefined();
        m.handler!(wperfEvent('2026-10-20T13:51:00+08:00', '-0.10'));
        expect(at('2026-10-20T13:50:05+08:00')).toBeUndefined();
        expect(at('2026-10-20T13:51:03+08:00')).toBe(-0.1);
        // 未連線時一律無法判定
        m.epoch = -1;
        expect(at('2026-10-20T13:51:03+08:00')).toBeUndefined();
        // 建底同快照的精確配對不受影響
        expect(at(BOOT_AT)).toBe(-1.2);
    });

    it('wperf 投影退訂後清空歷史', async () => {
        const { ic, release, at } = await setup();
        m.handler!(wperfEvent('2026-10-20T13:50:00+08:00', '-0.24'));
        release();
        expect(at('2026-10-20T13:50:05+08:00')).toBeUndefined();
        ic.retainIndexComponents(IX0001, WPERF);
        m.handler!(wperfEvent('2026-10-20T13:52:00+08:00', '-0.05'));
        expect(at('2026-10-20T13:52:01+08:00')).toBe(-0.05);
    });

    it('歷史只保留最近 900 包；被淘汰的時段視為未涵蓋', async () => {
        const { at } = await setup();
        const base = Date.parse('2026-10-20T13:00:00+08:00');
        const iso = (i: number) => new Date(base + i * 1000).toISOString();
        for (let i = 0; i < 905; i++) m.handler!(wperfEvent(iso(i), String(i)));
        expect(at(iso(4))).toBeUndefined();
        expect(at(iso(5))).toBe(5);
        expect(at(iso(904))).toBe(904);
    });
});
