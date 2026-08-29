import { describe, expect, it } from 'vitest';
import {
    parseCalculatedIndexEvent,
    exchangeTimeDifferenceSeconds,
    futuresIndexBasis,
    parseScannerMessage,
    scannerSignalKey,
} from './market-pulse';
import { buildContributionFlow } from './contribution-flow';
import { scannerSubscriptionBody } from './shioaji';
import { sectorLabel } from './stock-index';
import type { ScannerSignalEvent } from './types/market';

describe('Shioaji 1.7.1 subscription payloads', () => {
    it('uses the preset-rule scanner wire shape', () => {
        expect(scannerSubscriptionBody('trade_price_drop', 'OTC')).toEqual({
            scanner: { kind: 'preset_rule', id: 'trade_price_drop' },
            region: 'TW',
            security_type: 'STK',
            exchange: 'OTC',
        });
    });

    it('uses the plain string wire shape for state filters', () => {
        expect(scannerSubscriptionBody('suspend', 'TSE')).toEqual({
            scanner: 'suspend',
            region: 'TW',
            security_type: 'STK',
            exchange: 'TSE',
        });
    });
});

describe('live enriched-index payloads', () => {
    it('compares calculated and official exchange timestamps to milliseconds', () => {
        expect(
            exchangeTimeDifferenceSeconds(
                '09:00:01.250000',
                '09:00:01.100000',
            ),
        ).toBeCloseTo(0.15, 6);
        expect(exchangeTimeDifferenceSeconds('bad', '09:00:01')).toBeNull();
    });

    it('calculates near-month futures premium against the calculated index', () => {
        expect(futuresIndexBasis(43_980, 43_963.17)).toBeCloseTo(16.83, 6);
        expect(futuresIndexBasis(undefined, 43_963.17)).toBeNull();
        expect(futuresIndexBasis(43_980, null)).toBeNull();
    });
    it('normalizes unpadded industry category codes', () => {
        expect(sectorLabel('5')).toBe('電機');
        expect(sectorLabel('3')).toBe('塑膠');
    });

    it('keeps the trial-auction flag on a calculated index update', () => {
        const event = parseCalculatedIndexEvent(
            '{"code":"IX0001","date":"2026/07/31","time":"08:45:46.000000","open":42158.86,"high":42158.86,"low":42158.86,"close":42158.86,"total_amount":0,"price_chg":2225.56,"pct_chg":5.57,"simtrade":true}',
        );
        expect(event).toMatchObject({
            code: 'IX0001',
            close: 42158.86,
            simtrade: true,
        });
    });

    it('normalizes the 1.7.4 string-decimal calculated index wire (live sample)', () => {
        const event = parseCalculatedIndexEvent(
            '{"code":"IX0001","date":"2026/08/28","time":"09:46:54.000000","open":"45975.23","high":"46585.87","low":"45975.23","close":"46342.59","total_amount":438959661110,"price_chg":"367.37","pct_chg":"0.8","simtrade":false}',
        );
        expect(event.close).toBe(46342.59);
        expect(event.price_chg).toBe(367.37);
        expect(event.pct_chg).toBe(0.8);
        expect(event.total_amount).toBe(438959661110);
        expect(event.simtrade).toBe(false);
    });

    it('uses industry points for flow width and preserves the residual', () => {
        const flow = buildContributionFlow(
            [
                {
                    code: '2330',
                    name: '台積電',
                    category: '24',
                    points: 12,
                    pctChg: 1.01,
                },
                {
                    code: '2454',
                    name: '聯發科',
                    category: '24',
                    points: -4,
                    pctChg: -0.66,
                },
            ],
            [
                { category: '24', name: '半導體業', points: 16 },
                { category: '24', name: '半導體業', points: -5 },
            ],
        );
        expect(flow.links).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: 'direction:up',
                    target: 'sector:up:24',
                    value: 16,
                }),
                expect.objectContaining({
                    source: 'sector:down:24',
                    target: 'stock:2454',
                    value: 4,
                }),
                expect.objectContaining({
                    source: 'sector:up:24',
                    target: 'other:up:24',
                    value: 4,
                }),
            ]),
        );
        expect(flow.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'stock:2330',
                    label: '2330 台積電',
                    points: 12,
                    pctChg: 1.01,
                }),
                expect.objectContaining({
                    id: 'direction:down',
                    label: '下跌貢獻',
                    points: 5,
                }),
            ]),
        );
        expect(flow.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'stock:2330',
                    label: '2330 台積電',
                }),
            ]),
        );
        expect(
            flow.nodes.find((node) => node.id === 'other:up:24'),
        ).not.toHaveProperty('pctChg');
    });

    it('expands only the five highest-contribution stocks under a sector', () => {
        const stocks = ['2330', '2454', '2303', '3711', '3037', '2379'].map(
            (code, index) => ({
                code,
                name: code,
                category: '24',
                points: 60 - index * 5,
                pctChg: 10,
            }),
        );
        const flow = buildContributionFlow(stocks, [
            { category: '24', name: '半導體業', points: 300 },
        ]);

        const semiconductorStocks = flow.links.filter(
            (link) =>
                link.source === 'sector:up:24' &&
                String(link.target).startsWith('stock:'),
        );
        expect(semiconductorStocks).toHaveLength(5);
        expect(semiconductorStocks.map((link) => link.target)).toContain(
            'stock:2330',
        );
        expect(semiconductorStocks.map((link) => link.target)).not.toContain(
            'stock:2379',
        );
    });
});

describe('market signal messages', () => {
    it('normalizes a rule event and creates a stable dedupe key', () => {
        const event = parseScannerMessage(
            JSON.stringify({
                scanner: 'trade_price_surge',
                region: 'TW',
                security_type: 'STK',
                exchange: 'TSE',
                quote: {
                    code: '2330',
                    date: '2026-07-31',
                    time: '09:00:01.000000',
                    close: '1040',
                },
                extra: { change_percent: '1.25' },
            }),
            123,
        ) as ScannerSignalEvent;
        expect(event.received_at).toBe(123);
        expect(scannerSignalKey(event)).toBe(
            'TSE:trade_price_surge:2330:2026-07-31:09:00:01.000000',
        );
    });

    it('recognizes scanner reconnect gap reports', () => {
        const event = parseScannerMessage(
            JSON.stringify({
                dropped_count: 7,
                first_time: '09:00:00',
                last_time: '09:00:03',
                subscriptions: [],
            }),
            456,
        );
        expect(event).toMatchObject({ dropped_count: 7, received_at: 456 });
    });

    it('normalizes plural scanner state events', () => {
        const event = parseScannerMessage(
            JSON.stringify({
                scanners: ['simtrade'],
                region: 'TW',
                security_type: 'STK',
                exchange: 'OTC',
                quote: {
                    code: '6488',
                    date: '2026-07-31',
                    time: '08:59:00.000000',
                    simtrade: true,
                },
            }),
            789,
        ) as ScannerSignalEvent;
        expect(event).toMatchObject({
            scanner: 'simtrade',
            extra: {},
            received_at: 789,
        });
    });
});
