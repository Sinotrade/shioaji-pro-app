// index-components 純函式測試 — payload 取自 2026-08-28 對 1.7.4
// dev server 的實測樣本（wire decimal 一律字串）

import { describe, expect, it } from 'vitest';
import {
    parseIcEvent,
    projectFromSnapshot,
    projectionKey,
    type RawIndexComponentsSnapshot,
} from './index-components';
import type { IcProjection } from './types/market';

const P25: IcProjection = {
    kind: 'ranking',
    target: 'component',
    metric: 'contribution',
    order: 'positive_desc',
    limit: 25,
};

describe('projectionKey', () => {
    it('對同一投影產生穩定 key，含群組後綴', () => {
        expect(projectionKey(P25)).toBe('rk:contribution:positive_desc:25');
        expect(projectionKey({ kind: 'group_metric', metric: 'amount' })).toBe(
            'gm:amount',
        );
        expect(
            projectionKey({
                kind: 'ranking',
                target: 'component',
                metric: 'contribution',
                order: 'abs_desc',
                limit: 10,
                group: '24',
            }),
        ).toBe('rk:contribution:abs_desc:10:g24');
    });
});

describe('parseIcEvent', () => {
    it('解析 ranking 事件（實測樣本）並轉數值', () => {
        const raw = JSON.stringify({
            contract: {
                security_type: 'IND',
                region: 'TW',
                exchange: 'TSE',
                code: 'IX0001',
            },
            projection: {
                kind: 'ranking',
                target: 'component',
                metric: 'contribution',
                order: 'negative_asc',
                limit: 25,
            },
            date: '2026-08-28',
            time: '09:28:00.000000',
            calculated_at: '2026-08-28T09:28:00.000000+08:00',
            reference_date: '2026-08-28',
            market_phase: 'continuous_trading',
            simtrade: false,
            entries: [
                {
                    code: '8046',
                    category: '28',
                    value: '-5.94',
                    price: '1265.00',
                    reference: '1295.00',
                    price_chg: '-30.00',
                    pct_chg: '-2.32',
                    reference_weight_ppm: 5577,
                    price_source: 'regular',
                    trading_status: 'active',
                    data_status: 'live',
                },
            ],
        });
        const parsed = parseIcEvent(raw);
        expect(parsed?.code).toBe('IX0001');
        expect(parsed?.projKey).toBe('rk:contribution:negative_asc:25');
        expect(parsed?.state.kind).toBe('ranking');
        expect(parsed?.state.entries?.[0]).toMatchObject({
            code: '8046',
            category: '28',
            value: -5.94,
            price: 1265,
            pct_chg: -2.32,
            weight_pct: 0.5577,
        });
    });

    it('解析 group_metric 事件', () => {
        const raw = JSON.stringify({
            contract: { code: 'IX0001' },
            projection: { kind: 'group_metric', metric: 'contribution' },
            date: '2026-08-28',
            time: '09:28:01.000000',
            calculated_at: '2026-08-28T09:28:01.000000+08:00',
            market_phase: 'continuous_trading',
            simtrade: false,
            unit: 'points',
            groups: [
                { category: '1', name: '水泥工業', item_count: 7, value: '-0.32' },
            ],
        });
        const parsed = parseIcEvent(raw);
        expect(parsed?.projKey).toBe('gm:contribution');
        expect(parsed?.state.groups?.[0]).toEqual({
            category: '1',
            name: '水泥工業',
            item_count: 7,
            value: -0.32,
        });
    });
});

function snapshot(): RawIndexComponentsSnapshot {
    const entry = (
        code: string,
        category: string,
        points: string,
        pct: string,
    ) => ({
        contract: { code },
        category,
        price: '100.00',
        reference: '100.00',
        price_chg: '0.00',
        pct_chg: pct,
        points,
        reference_weight_ppm: 10_000,
        total_amount: 1_000_000,
        amount_share_bps: 10,
        price_source: 'regular',
        trading_status: 'active',
        data_status: 'live',
    });
    return {
        contract: { code: 'IX0001' },
        date: '2026-08-28',
        time: '13:30:00',
        calculated_at: '2026-08-28T13:30:00.000000+08:00',
        reference_date: '2026-08-28',
        market_phase: 'closed',
        refresh_state: 'ready',
        simtrade: false,
        total_amount: 5_000_000,
        entries: [
            entry('2330', '24', '39.75', '0.21'),
            entry('2317', '31', '-12.50', '-1.10'),
            entry('2454', '24', '8.20', '0.55'),
            entry('8046', '28', '-5.94', '-2.32'),
            entry('1101', '1', '0.00', '0.00'),
            entry('2303', '24', '-2.10', '-0.80'),
        ],
        groups: [
            {
                category: '1',
                name: '水泥工業',
                item_count: 7,
                equal_weight_pct_chg: '-0.633203',
                weighted_pct_chg: '-0.612767',
                points: '-0.68',
                reference_weight_ppm: 2379,
                total_amount: 954_214_800,
                amount_share_bps: 11,
                advance_count: 0,
                decline_count: 7,
                unchanged_count: 0,
                breadth_bps: -10_000,
            },
            {
                category: '24',
                name: '半導體業',
                item_count: 3,
                equal_weight_pct_chg: '1.2',
                weighted_pct_chg: '1.5',
                points: '45.85',
                reference_weight_ppm: 418_930,
                total_amount: 39_314_005_000,
                amount_share_bps: 453,
                advance_count: 2,
                decline_count: 1,
                unchanged_count: 0,
                breadth_bps: 3_333,
            },
        ],
    };
}

describe('projectFromSnapshot（官方查詢→串流映射）', () => {
    it('group_metric 逐指標映射', () => {
        const contribution = projectFromSnapshot(snapshot(), {
            kind: 'group_metric',
            metric: 'contribution',
        });
        expect(contribution.groups?.map((g) => g.value)).toEqual([
            -0.68, 45.85,
        ]);
        const amount = projectFromSnapshot(snapshot(), {
            kind: 'group_metric',
            metric: 'amount',
        });
        expect(amount.groups?.[1]?.value).toBe(39_314_005_000);
        const wperf = projectFromSnapshot(snapshot(), {
            kind: 'group_metric',
            metric: 'weighted_performance',
        });
        expect(wperf.groups?.[0]?.value).toBeCloseTo(-0.612767);
        const weight = projectFromSnapshot(snapshot(), {
            kind: 'group_metric',
            metric: 'weight',
        });
        expect(weight.groups?.[1]?.value).toBeCloseTo(41.893);
    });

    it('positive_desc 只留正值並降冪；0 貢獻被排除', () => {
        const state = projectFromSnapshot(snapshot(), P25);
        expect(state.entries?.map((e) => e.code)).toEqual([
            '2330',
            '2454',
        ]);
    });

    it('negative_asc 只留負值並升冪（最負在前）', () => {
        const state = projectFromSnapshot(snapshot(), {
            ...P25,
            order: 'negative_asc',
        });
        expect(state.entries?.map((e) => e.code)).toEqual([
            '2317',
            '8046',
            '2303',
        ]);
    });

    it('群組內 abs_desc 先過濾 category 再排序、截斷 limit', () => {
        const state = projectFromSnapshot(snapshot(), {
            kind: 'ranking',
            target: 'component',
            metric: 'contribution',
            order: 'abs_desc',
            limit: 2,
            group: '24',
        });
        expect(state.entries?.map((e) => e.code)).toEqual(['2330', '2454']);
        expect(state.entries?.[0]?.value).toBe(39.75);
    });

    it('amount 群組內排行：value=成交值、同值以 code 升冪 tie-break', () => {
        const state = projectFromSnapshot(snapshot(), {
            kind: 'ranking',
            target: 'component',
            metric: 'amount',
            order: 'desc',
            limit: 10,
            group: '24',
        });
        // fixture 三檔成交值相同（1,000,000）→ 官方 tie-break：code 升冪
        expect(state.entries?.map((e) => e.code)).toEqual([
            '2303',
            '2330',
            '2454',
        ]);
        expect(state.entries?.[0]?.value).toBe(1_000_000);
    });

    it('帶出 snapshot 的日切/市場階段中繼資料', () => {
        const state = projectFromSnapshot(snapshot(), P25);
        expect(state.date).toBe('2026-08-28');
        expect(state.marketPhase).toBe('closed');
        expect(state.calculatedAt).toBe('2026-08-28T13:30:00.000000+08:00');
    });
});
