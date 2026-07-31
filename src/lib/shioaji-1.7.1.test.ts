import { describe, expect, it } from 'vitest';
import {
    parseCalculatedIndexEvent,
    parseIndexContributionEvent,
    parseIndustryContributionEvent,
    parseScannerMessage,
    scannerSignalKey,
} from './market-pulse';
import { scannerSubscriptionBody } from './shioaji';
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

    it('parses live stock contribution points and ranking', () => {
        const event = parseIndexContributionEvent(
            '{"ranking":"abs10","code":"IX0043","date":"2026/07/31","time":"08:45:46.000000","entries":[{"code":"5274","price":14515,"reference":13205,"price_chg":1310,"pct_chg":9.920484664899659,"points":1.85}],"simtrade":true}',
        );
        expect(event.ranking).toBe('abs10');
        expect(event.entries[0]).toMatchObject({ code: '5274', points: 1.85 });
        expect(event.simtrade).toBe(true);
    });

    it('parses positive and negative industry heatmap values', () => {
        const event = parseIndustryContributionEvent(
            '{"code":"IX0001","date":"2026/07/31","time":"08:45:46.000000","entries":[{"category":"24","points":1340.4},{"category":"37","points":-0.46}],"simtrade":true,"index_close":42158.86,"index_price_chg":2225.56}',
        );
        expect(event.entries.map(({ category, points }) => [category, points])).toEqual([
            ['24', 1340.4],
            ['37', -0.46],
        ]);
        expect(event.simtrade).toBe(true);
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
