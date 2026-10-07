import { evaluateDaytrade, type DaytradeInput } from './daytrade-picker';
import { STRATEGY_ENGINE_VERSION, type StrategyDecision, type StrategyFrame } from './strategy-lab-types';

interface CompletedScan {
    inputs: DaytradeInput[];
    warnings: string[];
    indexChangeRate?: number;
    indexAsOf?: number;
}

/** Recording freezes the scan; playback must never request replacement market data. */
export function recordableStrategyFrame(scan: CompletedScan, capturedAt: number, apiBase: string,
    id = crypto.randomUUID()): StrategyFrame {
    const origin = new URL(apiBase).origin;
    const sourceKey = `${origin}|TW:STK|taipei-minute-close-v1`;
    const sameDate = (stamp: number) => new Date(stamp + 8 * 3600_000).toISOString().slice(0, 10);
    const indexFresh = scan.indexAsOf !== undefined && Number.isFinite(scan.indexAsOf)
        && scan.indexAsOf <= capturedAt && capturedAt - scan.indexAsOf <= 180_000
        && sameDate(scan.indexAsOf) === sameDate(capturedAt);
    const inputs = structuredClone(scan.inputs);
    const result = evaluateDaytrade(inputs, capturedAt, indexFresh ? scan.indexChangeRate : undefined);
    const decisions: StrategyDecision[] = [
        ...[...result.long, ...result.short].map(row => ({ code: row.contract.code,
            kind: 'confirmed' as const, side: row.side, reasons: [...row.reasons] })),
        ...[...result.observationsLong, ...result.observationsShort].map(row => ({ code: row.contract.code,
            kind: 'observation' as const, side: row.side, reasons: [...row.reasons] })),
        ...result.excluded.map(row => ({ code: row.code, kind: 'excluded' as const, reasons: [...row.reasons] })),
    ];
    return {
        schemaVersion: 1, engineVersion: STRATEGY_ENGINE_VERSION, id, capturedAt, sourceKey,
        inputs, poolCodes: inputs.map(input => input.contract.code), warnings: [...scan.warnings], decisions,
        ...(indexFresh && scan.indexChangeRate !== undefined
            ? { indexChangeRate: scan.indexChangeRate, indexAsOf: scan.indexAsOf } : {}),
    };
}
