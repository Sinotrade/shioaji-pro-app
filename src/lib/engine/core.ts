// Execution-location-independent backtest core interface. A core receives a
// complete, JSON-serializable request (universe, bars, the strategy's product,
// costs and options) and returns a JSON-serializable response. Running user
// strategy code is NOT part of a core: the caller runs the script step first
// and passes its product (a signal plan or an intent stream).
//
// Implementations: 'ts' (web / fallback, private module) and 'native' (Tauri
// Rust layer). Both must pass the shared golden conformance set; see
// conformance.ts for the comparison rules.

import { coreErrorText, type CoreErrorCode, type MessageParams } from './messages';
import type {
    BtMetrics, BtResult, BtTrade, PortfolioBarsInput, PortfolioCalendar, PortfolioExecutionConfig,
    PortfolioResult, PortfolioRiskLimits, ResearchMetrics, SignalConflictDiagnostic, SignalRule,
    SignalSeries, StrategyIntent,
} from './schema';

export const CORE_REQUEST_SCHEMA_VERSION = 'backtest-core-v1';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface CoreAsset {
    id: string;
    symbol: string;
}

export interface CoreUniverse {
    kind: 'static';
    assets: CoreAsset[];
    primaryAsset: string;
    calendar: PortfolioCalendar;
}

/**
 * Signals of one host asset, indexed by that asset's own bar rows (not the
 * portfolio calendar). `null` (indicator warm-up) and values `<= 0` are
 * inactive. When `extended` is true, `rules` holds the extended collector calls
 * and the four series only mirror the primary asset; otherwise `rules` is empty.
 */
export interface SignalVectorSet {
    longEntry: SignalSeries;
    longExit: SignalSeries;
    shortEntry: SignalSeries;
    shortExit: SignalSeries;
    extended: boolean;
    rules: SignalRule[];
}

/** Output of the vector Signal DSL script step. */
export interface SignalPlan {
    kind: 'signal-plan';
    /** Keyed by host asset id. */
    vectors: Record<string, SignalVectorSet>;
    /** Entry quantity per asset; an asset without an entry enters one lot. */
    quantities: Record<string, number>;
}

/**
 * How the script step failed at one decision. The run fails at that decision;
 * a core raises exactly what the live run raised:
 * - 'script': the callback threw its own (non-core) error. The run fails with
 *   STRATEGY_CALLBACK_FAILED `{ detail: message }` located at the primary asset.
 * - 'core': the callback raised a core error (for example `ctx.asset` of an
 *   unknown asset) or returned an invalid shape (STRATEGY_RESULT_INVALID). The
 *   run fails with STRATEGY_CALLBACK_FAILED whose `cause` is `{ code, params }`,
 *   located at `assetId` (the primary asset when null).
 * - 'rejected': the callback returned output that has no exact JSON form (a
 *   Date tag, a NaN, an undefined property, ...) and the live core rejected it.
 *   The run fails with exactly `error`. A JSON copy of such output could pass
 *   validation, so it is never recorded as intents.
 */
export type DecisionFailure =
    | { kind: 'script'; message: string }
    | { kind: 'core'; code: CoreErrorCode; params: Record<string, string | number>; assetId: string | null }
    | { kind: 'rejected'; error: CoreError };

/**
 * The intents one decision produced, or how it failed (`failure`; intents and
 * diagnostics are then empty). Intents are untrusted script output: a core
 * validates them exactly as it validates live callback output. They are the
 * exact callback output: plain JSON data, or output the live core accepted.
 */
export interface IntentDecision {
    time: number;
    intents: StrategyIntent[];
    diagnostics: SignalConflictDiagnostic[];
    failure: DecisionFailure | null;
}

/**
 * Output of a stateful / target-portfolio script step, recorded per decision
 * time. A replay is exact only while the core reproduces the state the script
 * observed; live stateful execution inside a core (embedded QuickJS) is a
 * later request kind.
 */
export interface IntentStream {
    kind: 'intent-stream';
    /** Strictly increasing times; a decision time without an entry produces no intents. */
    decisions: IntentDecision[];
}

export type StrategyProduct = SignalPlan | IntentStream;

/**
 * - 'portfolio': sequential shared-capital engine (research runs, extended
 *   Signal DSL, stateful and target-portfolio strategies).
 * - 'vector': the single-asset legacy vector engine used by the panel's
 *   multi-symbol scan for plain Signal DSL. Requires one asset, a non-extended
 *   signal plan and a quantity for that asset; lotSize, risk and
 *   liquidateAtEnd do not apply.
 */
export type CoreMode = 'portfolio' | 'vector';

export interface CoreRequest {
    schemaVersion: typeof CORE_REQUEST_SCHEMA_VERSION;
    mode: CoreMode;
    universe: CoreUniverse;
    /** Keyed by asset id; every universe asset must be present (empty arrays = never observed). */
    bars: Record<string, PortfolioBarsInput>;
    strategy: StrategyProduct;
    capital: number;
    execution: {
        defaults: PortfolioExecutionConfig;
        /** Partial per-asset overrides; an absent key uses the defaults. */
        assetOverrides: Record<string, Partial<PortfolioExecutionConfig>>;
    };
    risk: PortfolioRiskLimits;
    /** Close every open position at the final available close. */
    liquidateAtEnd: boolean;
    /** Compute research-v1 metrics for this bar interval ('1d', '5m', '1h', ...); null skips them. */
    research: { interval: string } | null;
    /**
     * Notional multiplier of the reporting views, independent of `execution`:
     * the `result` trade projection of a single-asset 'portfolio' run and the
     * research turnover of a 'vector' run use it. Callers pass the panel cost
     * multiplier (the existing worker's `CostConfig.multiplier`), which may
     * differ from the execution multiplier. Multi-asset projections use each
     * asset's effective execution multiplier; fills, PnL and every portfolio
     * number always use execution.
     */
    resultMultiplier: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** JSON form of BtMetrics: an infinite profit factor is the string 'Infinity'. */
export type BtMetricsRecord = Omit<BtMetrics, 'profitFactor'> & { profitFactor: number | 'Infinity' };

export interface BtResultRecord {
    trades: BtTrade[];
    equity: { time: number; value: number }[];
    metrics: BtMetricsRecord;
}

/**
 * A number field that can be non-finite on the wire. Only fields typed
 * JsonNumber (and `profitFactor`, which uses the string 'Infinity') may carry a
 * non-finite value; every other number in a request or result is finite.
 */
export type JsonNumber = number | NonFiniteNumber;

/**
 * JSON form of ResearchMetrics. `annualizedReturnPct` overflows to
 * `{ "__researchNumber": "Infinity" }` when a short span annualizes a gain
 * (e.g. synthetic second-level timestamps); it is never null.
 */
export type ResearchMetricsRecord = Omit<ResearchMetrics, 'annualizedReturnPct'> & {
    annualizedReturnPct: JsonNumber;
};

/** JSON form of PortfolioResult; the vector-engine projection is null when absent. */
export type PortfolioResultRecord = Omit<PortfolioResult, 'legacyResult'> & {
    legacyResult: BtResultRecord | null;
};

export interface CoreResult {
    /** Sequential portfolio result; null in 'vector' mode. */
    portfolio: PortfolioResultRecord | null;
    /** Panel / persisted trade view: trades, cumulative PnL curve and legacy metrics. */
    result: BtResultRecord;
    /** research-v1 metrics; null when `request.research` is null. */
    research: ResearchMetricsRecord | null;
}

export interface CoreErrorCause {
    code: CoreErrorCode;
    params: Record<string, string | number>;
}

/**
 * A run-level failure. `time`/`assetId` locate it (null = input level /
 * portfolio level). For STRATEGY_CALLBACK_FAILED and
 * STRATEGY_INTENTS_UNVERIFIABLE the inner failure is `cause` when it is a
 * core code; otherwise `params.detail` holds the script's own message.
 */
export interface CoreError {
    code: CoreErrorCode;
    params: Record<string, string | number>;
    time: number | null;
    assetId: string | null;
    cause: CoreErrorCause | null;
}

export type CoreResponse = { ok: true; result: CoreResult } | { ok: false; error: CoreError };

// ---------------------------------------------------------------------------
// Optimization candidate selection
// ---------------------------------------------------------------------------

export type OptimizationSearch = { kind: 'grid' } | { kind: 'random'; seed: number; count: number };

export interface CandidateOutcome {
    /** Null when the train run did not complete; the test run is then never started. */
    train: ResearchMetricsRecord | null;
    /** Null when the held-out run did not complete. */
    test: ResearchMetricsRecord | null;
}

/**
 * Pure selection of an optimization job (optimization-v2). `outcomes[i]`
 * belongs to the i-th generated candidate of `space`/`search`.
 */
export interface SelectionRequest {
    schemaVersion: 'optimization-v2';
    space: Record<string, number[]>;
    search: OptimizationSearch;
    thresholds: { minTrades: number; maxCostToGrossProfit: number };
    outcomes: CandidateOutcome[];
}

export interface CandidateSelection {
    index: number;
    params: Record<string, number>;
    eligible: boolean;
    reasons: string[];
    testWarnings: string[];
    /** Train returnPct − test returnPct; null without both runs. */
    generalizationGap: number | null;
    /** Mean absolute train-return difference to one-step neighbors; null without neighbors. */
    sensitivity: number | null;
}

export interface SelectionResult {
    /** Generated candidate order. */
    candidates: CandidateSelection[];
    /** Candidate indices, best first. */
    ranking: number[];
}

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface BacktestCore {
    readonly id: 'ts' | 'native';
    /** Implementation build identity, e.g. 'portfolio-signal-v1+ts'. Not part of results. */
    readonly version: string;
    run(request: CoreRequest): Promise<CoreResponse>;
    selectCandidates(request: SelectionRequest): Promise<SelectionResult>;
}

// ---------------------------------------------------------------------------
// Helpers shared by every implementation and caller
// ---------------------------------------------------------------------------

function errorParams(error: CoreErrorCause): MessageParams {
    return error.params;
}

/** zh-TW detail text of an error, including a nested cause. */
export function coreErrorDetail(error: CoreError | CoreErrorCause): string {
    const params: Record<string, string | number> = { ...errorParams(error) };
    if ('cause' in error && error.cause) params.detail = coreErrorDetail(error.cause);
    return coreErrorText(error.code, params);
}

/** Full user-facing message, identical to the TypeScript core's historical error text. */
export function formatCoreError(error: CoreError): string {
    return `[time=${error.time ?? 'input'}, asset=${error.assetId ?? 'portfolio'}] ${coreErrorDetail(error)}`;
}

export function btResultToRecord(result: BtResult): BtResultRecord {
    const { profitFactor, ...metrics } = result.metrics;
    return {
        trades: result.trades,
        equity: result.equity,
        metrics: { ...metrics, profitFactor: profitFactor === Infinity ? 'Infinity' : profitFactor },
    };
}

export function btResultFromRecord(record: BtResultRecord): BtResult {
    const { profitFactor, ...metrics } = record.metrics;
    return {
        trades: record.trades,
        equity: record.equity,
        metrics: { ...metrics, profitFactor: profitFactor === 'Infinity' ? Infinity : profitFactor },
    };
}

/** JSON marker of a non-finite number, identical to the research storage encoding. */
export interface NonFiniteNumber {
    __researchNumber: 'Infinity' | '-Infinity' | 'NaN';
}

export function toJsonNumber(value: number): JsonNumber {
    return Number.isFinite(value) ? value
        : { __researchNumber: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
}

export function fromJsonNumber(value: JsonNumber): number {
    if (typeof value === 'number') return value;
    const marker = value?.__researchNumber;
    if (marker === 'Infinity') return Infinity;
    if (marker === '-Infinity') return -Infinity;
    if (marker === 'NaN') return NaN;
    throw new TypeError(`invalid JSON number ${JSON.stringify(value)}`);
}

export function researchMetricsToRecord(metrics: ResearchMetrics): ResearchMetricsRecord {
    return { ...metrics, annualizedReturnPct: toJsonNumber(metrics.annualizedReturnPct) };
}

export function researchMetricsFromRecord(record: ResearchMetricsRecord): ResearchMetrics {
    return { ...record, annualizedReturnPct: fromJsonNumber(record.annualizedReturnPct) };
}

/**
 * Canonical JSON form used on both sides of a core boundary: drops `undefined`
 * properties and encodes a non-finite number as a NonFiniteNumber marker
 * instead of letting JSON turn it into null. The fields that can legitimately
 * be non-finite are typed JsonNumber (plus `profitFactor`'s 'Infinity');
 * elsewhere the marker only appears if an implementation diverges, and then
 * fails the golden comparison instead of silently becoming null.
 */
export function toJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'number' && !Number.isFinite(item) ? toJsonNumber(item) : item)) as T;
}

/** Inverse of toJsonValue's number encoding. */
export function fromJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1) {
            const marker = (item as Partial<NonFiniteNumber>).__researchNumber;
            if (marker === 'Infinity') return Infinity;
            if (marker === '-Infinity') return -Infinity;
            if (marker === 'NaN') return NaN;
        }
        return item;
    }) as T;
}
