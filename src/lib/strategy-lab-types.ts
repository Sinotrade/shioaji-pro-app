import type { DaytradeInput, DaytradeResult } from './daytrade-picker';

export const STRATEGY_ENGINE_VERSIONS = ['v9-daytrade-20261007-v1'] as const;
export type StrategyEngineVersion = typeof STRATEGY_ENGINE_VERSIONS[number];
export const CURRENT_STRATEGY_ENGINE_VERSION: StrategyEngineVersion = 'v9-daytrade-20261007-v1';
/** 目前引擎版本（相容別名；新碼請用 CURRENT_STRATEGY_ENGINE_VERSION）。 */
export const STRATEGY_ENGINE_VERSION = CURRENT_STRATEGY_ENGINE_VERSION;

export interface StrategyDecision {
    code: string;
    kind: 'confirmed' | 'observation' | 'excluded';
    side?: 'long' | 'short';
    reasons: string[];
}

/** Immutable inputs as actually known at a recorded scan, not reconstructed quotes. */
export interface StrategyFrame {
    schemaVersion: 1;
    engineVersion: typeof STRATEGY_ENGINE_VERSION;
    id: string;
    capturedAt: number;
    sourceKey: string;
    inputs: DaytradeInput[];
    poolCodes: string[];
    warnings: string[];
    decisions: StrategyDecision[];
    indexChangeRate?: number;
    indexAsOf?: number;
}

export interface JournalSummary {
    id: string;
    capturedAt: number;
    sourceKey: string;
    poolSize: number;
    warnings: string[];
}

export interface StrategySettings {
    /** 候選版進場相對量門檻（僅在引擎相同時代表參數差異）。 */
    candidateRvol: 1.5 | 2 | 2.5;
    feeBps: number;
    taxBps: number;
    slippageBps: number;
    minFeeTwd: number;
    /** 固定版使用的引擎版本（未指定時由 compare 補為目前版本）。 */
    baselineEngineVersion?: StrategyEngineVersion;
    /** 候選版使用的引擎版本（未指定時由 compare 補為目前版本）。 */
    candidateEngineVersion?: StrategyEngineVersion;
}

/** Research assumptions, editable before comparison; not a broker fee quote. */
export const DEFAULT_STRATEGY_SETTINGS: StrategySettings = {
    candidateRvol: 2,
    feeBps: 14.25,
    taxBps: 15,
    slippageBps: 5,
    minFeeTwd: 20,
    baselineEngineVersion: CURRENT_STRATEGY_ENGINE_VERSION,
    candidateEngineVersion: CURRENT_STRATEGY_ENGINE_VERSION,
};

export interface FrameComparison {
    id: string;
    capturedAt: number;
    baseline: DaytradeResult;
    candidate: DaytradeResult;
    /** 本次比較實際使用的固定版引擎版本（可追溯）。 */
    baselineVersion: StrategyEngineVersion;
    /** 本次比較實際使用的候選版引擎版本（可追溯）。 */
    candidateVersion: StrategyEngineVersion;
    addedLong: string[];
    removedLong: string[];
    addedShort: string[];
    removedShort: string[];
}

export interface ReplayTrade {
    code: string;
    name: string;
    side: 'long' | 'short';
    signalAt: number;
    entryAt: number;
    exitAt: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    fees: number;
    tax: number;
    netPnl: number;
    returnPct: number;
    exitReason: string;
}

export interface ReplayPosition {
    code: string;
    name: string;
    side: 'long' | 'short';
    signalAt: number;
    entryAt: number;
    entryPrice: number;
    quantity: number;
}

export interface ReplayPortfolio {
    trades: ReplayTrade[];
    openPositions: ReplayPosition[];
    pendingCount: number;
    netPnl: number;
    totalCosts: number;
    winRate: number | null;
    maxRealizedDrawdown: number;
    skippedFills: number;
}

export interface StrategyComparison {
    frames: FrameComparison[];
    baseline: ReplayPortfolio;
    candidate: ReplayPortfolio;
    settings: StrategySettings;
    warnings: string[];
}
