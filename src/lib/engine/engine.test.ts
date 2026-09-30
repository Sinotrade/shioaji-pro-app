import { describe, expect, it } from 'vitest';
import {
    btResultFromRecord, btResultToRecord, formatCoreError, fromJsonNumber, fromJsonValue, researchMetricsFromRecord,
    researchMetricsToRecord, toJsonNumber, toJsonValue, type BacktestCore, type CoreResponse, type ResearchMetricsRecord,
} from './core';
import { checkGoldenCase, compareGoldenValue, type GoldenRunCase } from './conformance';
import {
    CORE_ERROR_CODES, CORE_MESSAGE_TABLE, coreErrorText, REJECTION_MESSAGE_KEYS, rejectionReason, riskReasonLabel,
} from './messages';

describe('backtest core message table', () => {
    it('renders every placeholder from params and keeps literal braces', () => {
        const params = { label: 'capital', min: 0.01, max: 1e13, assetId: 'A', symbol: 'AAA', field: 'open', index: 1,
            detail: 'd', asset: 'X', kind: 'entry', name: 'longEntry', problem: 'order-invalid', n: -1, mode: 'vector', time: 5, leverage: '1.2345', limit: 1 };
        for (const code of CORE_ERROR_CODES) expect(coreErrorText(code, params)).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
        for (const key of REJECTION_MESSAGE_KEYS) expect(rejectionReason(key, params).message).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
        expect(coreErrorText('STRATEGY_RESULT_INVALID')).toBe('strategy 必須回傳 intent 陣列、{ intents, diagnostics } 或 undefined');
        expect(coreErrorText('VALUE_OUT_OF_RANGE_INTEGER', { label: 'lotSize', min: 1, max: 1e6 }))
            .toBe('lotSize 必須在 [1, 1000000] 且為整數');
        expect(rejectionReason('RISK_GROSS_LEVERAGE', { leverage: (1.5).toFixed(4), limit: 1 }))
            .toEqual({ code: 'gross-leverage', message: '共享資金風控失敗: gross leverage 1.5000 > 1' });
        expect(riskReasonLabel('limit-not-reached')).toBe('限價未觸及');
        expect(Object.keys(CORE_MESSAGE_TABLE.riskReasonLabels).sort()).toEqual([...new Set(
            Object.values(CORE_MESSAGE_TABLE.rejections).map(entry => entry.reason))].sort());
    });

    it('formats located errors and nested causes like the historical core text', () => {
        expect(formatCoreError({ code: 'STRATEGY_CALLBACK_FAILED', params: {}, time: 3, assetId: 'A',
            cause: { code: 'INTENT_DUPLICATE_ASSET', params: { assetId: 'A' } } }))
            .toBe('[time=3, asset=A] strategy callback 失敗: 同商品、同週期只能有一個 intent: A');
        expect(formatCoreError({ code: 'STRATEGY_CALLBACK_FAILED', params: { detail: 'boom' }, time: 1, assetId: null, cause: null }))
            .toBe('[time=1, asset=portfolio] strategy callback 失敗: boom');
        expect(formatCoreError({ code: 'PRIMARY_ASSET_MISSING', params: {}, time: null, assetId: null, cause: null }))
            .toBe('[time=input, asset=portfolio] primaryAsset 必須存在於 universe');
    });
});

describe('backtest core JSON records', () => {
    it('encodes infinite profit factors and other non-finite numbers without loss', () => {
        const result = { trades: [], equity: [], metrics: { trades: 1, wins: 1, winRate: 1, totalPnl: 1, returnPct: 0.1,
            profitFactor: Infinity, maxDrawdown: 0, maxDrawdownPct: 0, avgWin: 1, avgLoss: 0, expectancy: 1,
            totalCost: 0, exposure: 1 } };
        const record = btResultToRecord(result);
        expect(record.metrics.profitFactor).toBe('Infinity');
        expect(btResultFromRecord(record)).toEqual(result);
        const encoded = toJsonValue({ a: Infinity, b: -Infinity, c: NaN, d: undefined, e: [1, undefined] });
        expect(encoded).toEqual({ a: { __researchNumber: 'Infinity' }, b: { __researchNumber: '-Infinity' },
            c: { __researchNumber: 'NaN' }, e: [1, null] });
        expect(fromJsonValue(encoded)).toEqual({ a: Infinity, b: -Infinity, c: NaN, e: [1, null] });
    });

    it('types research annualizedReturnPct as a JSON number that may carry the Infinity marker', () => {
        const metrics = { schemaVersion: 'research-v1' as const, returnPct: 0.1, annualizedReturnPct: Infinity,
            maxDrawdown: 0, maxDrawdownPct: 0, winRate: 1, profitFactor: 'Infinity' as const, expectancy: 1, sharpe: 0,
            sortino: 0, trades: 1, averageHoldingBars: 1, exposure: 1, totalCost: 0, costToGrossProfit: 0, turnover: 1,
            long: { trades: 1, pnl: 1, wins: 1 }, short: { trades: 0, pnl: 0, wins: 0 }, buyAndHoldReturnPct: null };
        const record: ResearchMetricsRecord = researchMetricsToRecord(metrics);
        expect(record.annualizedReturnPct).toEqual({ __researchNumber: 'Infinity' });
        // The wire form equals the canonical JSON encoding and decodes back without loss.
        expect(toJsonValue(metrics)).toEqual(record);
        expect(JSON.parse(JSON.stringify(record))).toEqual(record);
        expect(researchMetricsFromRecord(JSON.parse(JSON.stringify(record)))).toEqual(metrics);
        expect(researchMetricsToRecord({ ...metrics, annualizedReturnPct: 0.25 }).annualizedReturnPct).toBe(0.25);
        expect([Infinity, -Infinity, NaN, 1.5].map(value => fromJsonNumber(toJsonNumber(value)))).toEqual([Infinity, -Infinity, NaN, 1.5]);
        expect(() => fromJsonNumber({ __researchNumber: 'big' } as never)).toThrow(TypeError);
    });
});

describe('golden comparison rules', () => {
    it('compares discrete values exactly, money to 9 and ratios to 12 decimals', () => {
        expect(compareGoldenValue({ time: 1, quantity: 2 }, { time: 1, quantity: 2 })).toEqual([]);
        expect(compareGoldenValue({ quantity: 2 + 1e-12 }, { quantity: 2 })).toMatchObject([{ rule: 'exact', path: '$.quantity' }]);
        expect(compareGoldenValue({ price: 10 + 4e-10 }, { price: 10 })).toEqual([]);
        expect(compareGoldenValue({ price: 10 + 6e-10 }, { price: 10 })).toMatchObject([{ rule: 'decimals-9' }]);
        expect(compareGoldenValue({ returnPct: 0.1 + 4e-13 }, { returnPct: 0.1 })).toEqual([]);
        expect(compareGoldenValue({ returnPct: 0.1 + 6e-13 }, { returnPct: 0.1 })).toMatchObject([{ rule: 'decimals-12' }]);
        expect(compareGoldenValue({ positions: { A: 1 + 1e-12 } }, { positions: { A: 1 } })).toMatchObject([{ rule: 'exact' }]);
        expect(compareGoldenValue({ attribution: { A: { turnover: 1 + 1e-10 } } }, { attribution: { A: { turnover: 1 } } }))
            .toMatchObject([{ rule: 'decimals-12', path: '$.attribution.A.turnover' }]);
    });

    it('treats missing keys, extra keys, nulls, lengths and strings as exact', () => {
        expect(compareGoldenValue({ a: 1 }, { a: 1, tag: 'x' })).toMatchObject([{ rule: 'keys' }]);
        expect(compareGoldenValue({ a: null }, { a: 0 })).toMatchObject([{ rule: 'type' }]);
        expect(compareGoldenValue([1, 2], [1])).toMatchObject([{ rule: 'length' }]);
        expect(compareGoldenValue({ message: 'a' }, { message: 'b' })).toMatchObject([{ rule: 'exact' }]);
    });

    it('runs any BacktestCore against a golden case through a JSON boundary', async () => {
        const expected: CoreResponse = { ok: false, error: { code: 'INTERNAL', params: { detail: 'x' }, time: null,
            assetId: null, cause: null } };
        const core: BacktestCore = { id: 'native', version: 'test', run: async () => ({ ...expected, extra: undefined }) as never,
            selectCandidates: async () => ({ candidates: [], ranking: [] }) };
        const testCase = { kind: 'run', id: 'x', title: 'x', categories: ['validation'], provenance: { kind: 'derived',
            source: 'test', handChecked: [], verification: 'unverified', note: null }, request: {} as never, expected } as GoldenRunCase;
        expect(await checkGoldenCase(core, testCase)).toEqual({ id: 'x', passed: true, mismatches: [] });
    });
});
