import { evaluateDaytrade, type DaytradeInput, type DaytradeResult } from './daytrade-picker';
import { STRATEGY_ENGINE_VERSIONS, type StrategyEngineVersion } from './strategy-lab-types';

/**
 * 策略引擎註冊表：每個版本綁定一個完整評估實作。
 * - journal／replay／compare 一律透過 resolveStrategyEngine 解析引擎，不直接呼叫
 *   evaluateDaytrade，因此新增引擎版本（例如 v2）只需在此表註冊一筆，
 *   舊 frame（不同 engineVersion）仍可讀取、回放並與新版本跨版本比較。
 * - 版本字串必須列入 STRATEGY_ENGINE_VERSIONS（strategy-lab-types.ts），
 *   否則 journal 拒存、replay 拒算，保證可追溯性。
 */
export interface StrategyEngine {
    version: StrategyEngineVersion;
    /** 顯示名稱，供研究面板／警告訊息使用。 */
    label: string;
    evaluate(inputs: DaytradeInput[], nowMs: number, indexChangeRate: number | undefined,
        options: { minimumRvol?: number }): DaytradeResult;
}

export const STRATEGY_ENGINES: Record<StrategyEngineVersion, StrategyEngine> = {
    'v9-daytrade-20261007-v1': {
        version: 'v9-daytrade-20261007-v1',
        label: 'V9 當沖引擎 v1（2026-10-07：自選＋排行池、日趨勢＋每分K確認、rvol 1.5 起）',
        evaluate: (inputs, nowMs, indexChangeRate, options) =>
            evaluateDaytrade(inputs, nowMs, indexChangeRate, options),
    },
};

export function resolveStrategyEngine(version: StrategyEngineVersion): StrategyEngine {
    const engine = STRATEGY_ENGINES[version];
    if (!engine) throw new Error(`Unknown strategy engineVersion: ${version}`);
    return engine;
}

/** 用於警告訊息：列出已註冊版本。 */
export function engineVersionLabel(version: StrategyEngineVersion): string {
    return STRATEGY_ENGINES[version]?.label ?? version;
}
