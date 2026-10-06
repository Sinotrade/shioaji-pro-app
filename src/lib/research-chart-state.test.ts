import { describe, expect, it } from 'vitest';
import { chartScopeKey, quoteChangePercent, researchDataStatus, scopedResearchSource } from './research-chart-state';
import type { Candle } from './types/market';
import type { ContractBase } from './types/contract';

const time = (s: string) => Date.parse(s + 'Z') / 1000;
const bar = (s: string): Candle => ({ time: time(s), open: 100, high: 101, low: 99, close: 100, volume: 1 });
const stock: ContractBase = { code: '3016', target_code: null, exchange: 'TSE', security_type: 'STK' };
const future: ContractBase = { code: 'TXFR1', target_code: 'TXFJ6', exchange: 'TAIFEX', security_type: 'FUT' };

describe('research chart scope', () => {
    it('hides stock values immediately when switching to a future, before effect cleanup', () => {
        expect(scopedResearchSource([bar('2026-10-01T13:30:00')], chartScopeKey(stock, 5), chartScopeKey(future, 5), false)).toEqual([]);
    });
    it('separates timeframes and continuous-month rollover', () => {
        expect(chartScopeKey(future, 1)).not.toBe(chartScopeKey(future, 5));
        expect(chartScopeKey(future, 5)).not.toBe(chartScopeKey({ ...future, target_code: 'TXFK6' }, 5));
    });
    it('hides values during same-contract refresh and copies the source when ready', () => {
        const bars = [bar('2026-10-01T21:00:00')], key = chartScopeKey(future, 5);
        expect(scopedResearchSource(bars, key, key, true)).toEqual([]);
        expect(scopedResearchSource(bars, key, key, false)).toEqual(bars);
        expect(scopedResearchSource(bars, key, key, false)).not.toBe(bars);
    });
});

describe('same-quote change percentage', () => {
    it('uses TXF reference 48698, never previous stock close 169', () => {
        expect(quoteChangePercent(48440, -258)).toBeCloseTo(-0.52979588);
    });
    it('accepts an explicit index reference and zero change', () => {
        expect(quoteChangePercent(100, 5, 95)).toBeCloseTo(5 / 95 * 100);
        expect(quoteChangePercent(100, 0)).toBe(0);
    });
    it('does not invent a reference for missing or invalid quotes', () => {
        expect(quoteChangePercent(undefined, -258)).toBeUndefined();
        expect(quoteChangePercent(0, 1)).toBeUndefined();
        expect(quoteChangePercent(100, Number.NaN)).toBeUndefined();
    });
});

describe('per-session research freshness', () => {
    it('prioritizes loading over old bars', () => {
        expect(researchDataStatus([bar('2026-10-01T21:00:00')], 'FUT', time('2026-10-01T21:01:00'), true).state).toBe('loading');
    });
    it('accepts fresh bars and downgrades a three-minute gap', () => {
        const bars = [bar('2026-10-01T21:00:00')];
        expect(researchDataStatus(bars, 'FUT', time('2026-10-01T21:02:59'), false).state).toBe('fresh');
        expect(researchDataStatus(bars, 'FUT', time('2026-10-01T21:03:00'), false).state).toBe('stale');
    });
    it('requires current-session data and never accepts future labels', () => {
        expect(researchDataStatus([bar('2026-10-01T13:45:00')], 'FUT', time('2026-10-01T15:10:00'), false).state).toBe('unknown');
        expect(researchDataStatus([bar('2026-10-01T21:01:00')], 'FUT', time('2026-10-01T21:00:20'), false).state).toBe('unknown');
    });
    it('immediately gates a disconnected stream even with a fresh cached bar', () => {
        const bars = [bar('2026-10-01T21:00:00')], now = time('2026-10-01T21:00:30');
        expect(researchDataStatus(bars, 'FUT', now, false, 'live').state).toBe('fresh');
        expect(researchDataStatus(bars, 'FUT', now, false, 'down')).toMatchObject({ state: 'unknown', reason: expect.stringContaining('中斷') });
        expect(researchDataStatus(bars, 'FUT', now, false, 'connecting').state).toBe('unknown');
        expect(researchDataStatus(bars, 'STK', now, false, 'down').state).toBe('closed');
    });
    it('keeps a night session together across midnight', () => {
        expect(researchDataStatus([bar('2026-10-01T23:59:00')], 'FUT', time('2026-10-02T00:01:00'), false).state).toBe('fresh');
    });
    it('distinguishes normal breaks/stock closure from a stale feed', () => {
        for (const now of ['2026-10-01T05:01:00', '2026-10-01T14:00:00']) {
            expect(researchDataStatus([], 'FUT', time(now), false).state).toBe('closed');
        }
        expect(researchDataStatus([], 'STK', time('2026-10-01T21:00:00'), false).state).toBe('closed');
    });
    it('allows Friday overnight until Saturday 05:00, not a Saturday night session', () => {
        expect(researchDataStatus([bar('2026-10-03T00:00:00')], 'FUT', time('2026-10-03T00:01:00'), false).state).toBe('fresh');
        expect(researchDataStatus([], 'FUT', time('2026-10-03T21:00:00'), false).state).toBe('closed');
    });
});
