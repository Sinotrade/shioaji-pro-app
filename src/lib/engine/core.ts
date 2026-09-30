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
    SignalSeries, StrategyIntent, TickBand,
} from './schema';

export const CORE_REQUEST_SCHEMA_VERSION = 'backtest-core-v2';

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
 * Strategy source run by the core's own script step (backtest-spec-v2.1 §8):
 * a Signal DSL source becomes a signal plan (entry quantity `quantity` for
 * every asset); a stateful / target-portfolio source runs at every decision.
 * Cores that cannot execute ECMAScript reject it.
 */
export interface SourceStrategy {
    kind: 'source';
    authoringStyle: 'signal' | 'stateful' | 'target-portfolio';
    source: string;
    params: Record<string, number>;
    quantity: number;
}

export type CoreStrategy = StrategyProduct | SourceStrategy;

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
    strategy: CoreStrategy;
    capital: number;
    execution: {
        defaults: PortfolioExecutionConfig;
        /** Partial per-asset overrides; an absent key uses the defaults. */
        assetOverrides: Record<string, Partial<PortfolioExecutionConfig>>;
    };
    risk: PortfolioRiskLimits;
    /** Close every open position at the final available close. */
    liquidateAtEnd: boolean;
    /**
     * Compute research metrics for this bar interval ('1d', '5m', '1h', ...);
     * null skips them. `periodsPerYear` annualizes Sharpe / Sortino (CHANGE-9:
     * the caller derives it from the session calendar, spec §4.9).
     */
    research: { interval: string; periodsPerYear: number } | null;
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

/**
 * Run identity (CHANGE-6): SHA-256 hex of the RFC 8785 canonical JSON of the
 * request as given, of each asset's bars, and of the strategy source (null
 * unless the strategy is a source). `engineVersion` is the behaviour version.
 */
export interface RunIdentity {
    engineVersion: string;
    requestHash: string;
    dataHashes: Record<string, string>;
    sourceHash: string | null;
}

export interface CoreResult {
    /** Sequential portfolio result; null in 'vector' mode. */
    portfolio: PortfolioResultRecord | null;
    /** Panel / persisted trade view: trades, cumulative PnL curve and legacy metrics. */
    result: BtResultRecord;
    /** Research metrics; null when `request.research` is null. */
    research: ResearchMetricsRecord | null;
    identity: RunIdentity;
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
// Data preparation (L1, backtest-spec-v2.1 §4)
// ---------------------------------------------------------------------------

/** Trading sessions in Taiwan wall-clock 'HH:MM'; close < open is an overnight session. */
export interface SessionCalendar {
    name: string;
    /**
     * `closeGrace`: minutes after a day session's close whose bars still
     * belong to the close (merged into the close label), e.g. 3 for TWSE
     * indices whose official close is published at 13:31–13:33.
     */
    sessions: { open: string; close: string; closeGrace?: number }[];
    /** Weekday dates that are not trading days. */
    holidays: string[];
    /** Weekend dates that are trading days (make-up days). */
    extraTradingDays: string[];
}

export interface InstrumentMeta {
    securityType: 'STK' | 'FUT' | 'OPT' | 'IND';
    code: string;
    root?: string;
    specKind?: string;
    underlyingKind?: string;
    underlyingCode?: string;
    isWarrant?: boolean;
    multiplier?: number;
    tick?: number;
    tickLadder?: TickBand[];
    priceLimitPct?: number | null;
    /**
     * Reference price of derived daily limits when no `daily` entry supplies
     * one: stocks always use the previous trading day's last close;
     * 'previous-close' opts other instruments (futures without settlement
     * data) into the same rule.
     */
    limitReference?: 'previous-close';
}

export interface PrepareRequest {
    schemaVersion: 'backtest-prepare-v1';
    minutes: 1 | 5 | 15 | 30 | 60 | 1440;
    /** Taiwan dates 'YYYY-MM-DD', inclusive. */
    range: { from: string; to: string };
    minBars: number;
    costSettings: { discount: number; futuresFee: number; slippageTicks: number };
    assets: {
        id: string;
        symbol: string;
        instrument: InstrumentMeta;
        calendar: SessionCalendar;
        /** 'YYYY-MM-DD HH:MM[:SS]' Taiwan time, close-label-right minutes. */
        minuteBars: { datetime: string; open: number | null; high: number | null; low: number | null;
            close: number | null; volume: number | null }[];
        daily?: { tradingDay: string; referencePrice?: number; limitUp?: number; limitDown?: number }[];
    }[];
}

/**
 * out-of-session: minutes outside every session were dropped.
 * trading-day-assumed: night-session minutes after the last day session in
 * the data; their trading day is unknown (the next weekday may be a holiday),
 * so they are left out of the bars until a later day session is in the data.
 */
export interface PrepareDiagnostic {
    kind: 'out-of-session' | 'trading-day-assumed';
    assetId: string;
    count: number;
}

export type PrepareResponse =
    | { ok: true; bars: Record<string, PortfolioBarsInput>; execution: Record<string, PortfolioExecutionConfig>;
        periodsPerYear: number; diagnostics: PrepareDiagnostic[] }
    | { ok: false; error: { code: 'DATA_TOO_FEW_BARS' | 'DATA_NO_BARS' | 'DATA_INVALID'; params: Record<string, string | number> } };

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
    /** L1 data preparation (spec §4); optional for cores that receive prepared bars only. */
    prepare?(request: PrepareRequest): Promise<PrepareResponse>;
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
