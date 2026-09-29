// Public data schema of the backtest core (research-v1). Every type in this
// file is plain JSON data: no functions, class instances, Maps or undefined
// values. Implementations (TypeScript in the web layer, Rust in the native
// layer) exchange and persist exactly these shapes.
//
// Absence rules, shared by every type in src/lib/engine:
// - An optional property (`name?: T`) is omitted when absent. It is never
//   `null` and never an explicit `undefined`.
// - A nullable property (`name: T | null`) is always present; `null` carries
//   the meaning documented on that property.
// - Series values use `null` for "no value at this index" (indicator warm-up,
//   missing or suspended bars). A series shorter than its bars behaves as if
//   the missing trailing values were `null`.
// - Money and prices are IEEE-754 doubles. Quantities, lot sizes, times and
//   indices are integers. Times are Unix seconds.
//
// This file only describes data. The computation rules live in each core
// implementation and are pinned by the shared golden conformance set.

// ---------------------------------------------------------------------------
// Universe, market data and execution assumptions
// ---------------------------------------------------------------------------

export type PortfolioCalendar = 'union' | 'intersection';

/** Per-asset simulated execution assumptions. */
export interface PortfolioExecutionConfig {
    /** Notional multiplier per quantity unit (e.g. 1000 shares per lot, 200 per TXF contract). */
    multiplier: number;
    /** Minimum integer order unit; targets are rounded down to whole lots. */
    lotSize: number;
    /** Fee rate on notional per side (0.001425 = 0.1425%). */
    feePct: number;
    /** Fixed fee per quantity unit per side. */
    feePerUnit: number;
    /** Tax rate on sell-side notional. */
    taxSellPct: number;
    /** Tax rate on notional of both sides. */
    taxBothPct: number;
    /** Adverse slippage in ticks per side. */
    slippageTicks: number;
    /** Price of one tick. */
    tickSize: number;
}

export interface StrategyAsset {
    id: string;
    symbol: string;
    execution?: Partial<PortfolioExecutionConfig>;
}

export interface UniverseSpec {
    kind: 'static';
    assets: StrategyAsset[];
    primaryAsset: string;
    calendar: PortfolioCalendar;
}

/**
 * One asset's bars on its own clock. A row is executable only when every
 * OHLCV value is non-null and `availability[i]` is not `false`. Missing or
 * suspended rows stay on the calendar but can never fill an order.
 * `availability` omitted means every complete row is available.
 */
export interface PortfolioBarsInput {
    time: number[];
    open: (number | null)[];
    high: (number | null)[];
    low: (number | null)[];
    close: (number | null)[];
    volume: (number | null)[];
    availability?: boolean[];
}

/** Portfolio clock: `sourceIndices[asset][i]` is the row of that asset's bars at `time[i]`, null when unavailable. */
export interface AlignedPortfolioData {
    time: number[];
    availability: Record<string, boolean[]>;
    sourceIndices: Record<string, (number | null)[]>;
}

export interface PortfolioRiskLimits {
    maxGrossLeverage: number;
    maxNetLeverage: number;
}

// ---------------------------------------------------------------------------
// Strategy products: intents and signal rules
// ---------------------------------------------------------------------------

/** A limit is valid for the next available open/bar only. */
export type OrderModel = { type: 'market' } | { type: 'limit'; price: number };

interface IntentBase {
    assetId: string;
    tag?: string;
    order?: OrderModel;
}

export interface EntryIntent extends IntentBase {
    kind: 'entry';
    side: 'long' | 'short';
    /** Omitted: one lot. */
    quantity?: number;
}

export interface ExitIntent extends IntentBase {
    kind: 'exit';
}

/** At most one of `quantity` and `fraction`; neither means the whole position. */
export interface ReduceIntent extends IntentBase {
    kind: 'reduce';
    quantity?: number;
    fraction?: number;
}

export interface TargetQuantityIntent extends IntentBase {
    kind: 'targetQuantity';
    quantity: number;
    /** Signal adapter only: preserve legacy exit followed by re-entry. */
    closeFirst?: boolean;
}

export interface TargetWeightIntent extends IntentBase {
    kind: 'targetWeight';
    weight: number;
}

export type StrategyIntent =
    | EntryIntent
    | ExitIntent
    | ReduceIntent
    | TargetQuantityIntent
    | TargetWeightIntent;

export type SignalName = 'longEntry' | 'longExit' | 'shortEntry' | 'shortExit';

/** Signal value per source bar: active when `> 0`; `null` is warm-up / no value (inactive). */
export type SignalSeries = (number | null)[];

export type SignalSize = { kind: 'quantity' | 'weight' | 'percent'; value: number };

/** One extended Signal DSL collector call. */
export interface SignalRule {
    /** Empty string means the vector's host asset. */
    assetId: string;
    name: SignalName;
    series: SignalSeries;
    size?: SignalSize;
    pyramiding?: number;
    order?: OrderModel;
    tag?: string;
}

// ---------------------------------------------------------------------------
// Portfolio result (research-v1 portfolio record)
// ---------------------------------------------------------------------------

export interface PortfolioPosition {
    assetId: string;
    side: 'long' | 'short' | 'flat';
    quantity: number;
    weight: number;
    avgPrice: number;
    realizedGrossPnl: number;
    unrealizedPnl: number;
    returnPct: number;
    barsHeld: number;
}

/** One asset's view at a calendar time; OHLCV are null when the bar is unavailable. */
export interface PortfolioBar {
    time: number;
    available: boolean;
    sourceIndex: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
}

export interface NormalizedIntent {
    assetId: string;
    targetQuantity: number;
    sourceKind: StrategyIntent['kind'];
    intent: StrategyIntent;
    tag?: string;
    closeFirst?: boolean;
}

export interface PlannedOrder extends NormalizedIntent {
    decisionTime: number;
}

export interface PortfolioFill {
    assetId: string;
    symbol: string;
    decisionTime: number;
    time: number;
    side: 'buy' | 'sell';
    quantity: number;
    price: number;
    /** Fees plus taxes; slippage is already in `price`. */
    cost: number;
    reason: 'intent' | 'eod';
    tag?: string;
}

export interface TagAttribution {
    /** Entry tag owns its open lot's PnL and closing costs, including EOD exits. */
    tag: string;
    fills: number;
    turnover: number;
    totalCost: number;
    realizedGrossPnl: number;
    unrealizedGrossPnl: number;
    totalPnl: number;
}

export interface AssetAttribution {
    assetId: string;
    realizedGrossPnl: number;
    unrealizedGrossPnl: number;
    totalCost: number;
    totalPnl: number;
    turnover: number;
    fills: number;
}

export interface PortfolioEquityPoint {
    time: number;
    value: number;
    cash: number;
    positions: Record<string, number>;
}

export interface SignalConflictDiagnostic {
    kind: 'signal-conflict';
    time: number;
    assetId: string;
    signals: SignalName[];
    /** Decision order (close, then entry), not a promise of a funded next-open fill. */
    selectedSignals: SignalName[];
}

export interface LotRoundingDiagnostic {
    kind: 'lot-rounding';
    time: number | null;
    assetId: string;
    intentKind: StrategyIntent['kind'];
    /** Signed target, except Reduce which records its positive change amount. */
    requestedQuantity: number;
    roundedQuantity: number;
    lotSize: number;
}

export type PortfolioDiagnostic = SignalConflictDiagnostic | LotRoundingDiagnostic;
export type PortfolioDiagnosticKind = PortfolioDiagnostic['kind'];

export type RiskReason = 'missing-price' | 'nonpositive-equity' | 'gross-leverage' | 'net-leverage' |
    'unavailable-bar' | 'invalid-fill-price' | 'limit-not-reached';

export interface PortfolioRejection {
    time: number;
    phase: 'decision' | 'open' | 'eod';
    status: 'rejected' | 'deferred';
    assetIds: string[];
    intents: StrategyIntent[];
    /** `message` is rendered from the shared message table (see messages.ts). */
    reason: { code: RiskReason; message: string };
    /** Null means valuation prevented normalization; raw intents remain above. */
    plannedBatch: PlannedOrder[] | null;
}

export interface PortfolioMetrics {
    initialCapital: number;
    finalEquity: number;
    totalPnl: number;
    returnPct: number;
    totalCost: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    exposure: number;
}

export interface PortfolioResult {
    calendar: AlignedPortfolioData;
    fills: PortfolioFill[];
    positions: Record<string, PortfolioPosition>;
    equity: PortfolioEquityPoint[];
    attribution: Record<string, AssetAttribution>;
    tagAttribution: Record<string, TagAttribution>;
    rejections: PortfolioRejection[];
    diagnostics: PortfolioDiagnostic[];
    /** In-memory only: re-runs the vector engine for its schema/arithmetic.
     * Omitted when portfolio constraints reject/defer an order. */
    legacyResult?: BtResult;
    metrics: PortfolioMetrics;
}

// ---------------------------------------------------------------------------
// Vector (legacy panel) result and research-v1 metrics
// ---------------------------------------------------------------------------

export interface CostConfig {
    /** Entry quantity per trade (lots/contracts). */
    qty: number;
    multiplier: number;
    feePct: number;
    feePerUnit: number;
    taxSellPct: number;
    taxBothPct: number;
    slippageTicks: number;
    tickSize: number;
    capital: number;
}

export interface BtTrade {
    /** Present for portfolio trades; legacy single-asset results keep their shape. */
    assetId?: string;
    symbol?: string;
    side: 'long' | 'short';
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    qty: number;
    /** Net of cost. */
    pnl: number;
    /** Relative to entry notional. */
    pnlPct: number;
    /** Fees plus taxes; slippage is already in prices and pnl. */
    cost: number;
    bars: number;
    reason: 'signal' | 'reverse' | 'eod';
}

export interface BtMetrics {
    trades: number;
    wins: number;
    winRate: number;
    totalPnl: number;
    returnPct: number;
    /** In memory `Infinity` when there is profit and no loss; see BtMetricsRecord for JSON. */
    profitFactor: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    avgWin: number;
    avgLoss: number;
    expectancy: number;
    totalCost: number;
    exposure: number;
}

export interface BtResult {
    trades: BtTrade[];
    /** Cumulative marked PnL (not equity) per bar. */
    equity: { time: number; value: number }[];
    metrics: BtMetrics;
}

export const RESULT_SCHEMA_VERSION = 'research-v1';

/** In-memory research-v1 metrics; the JSON form is ResearchMetricsRecord (core.ts). */
export interface ResearchMetrics {
    schemaVersion: typeof RESULT_SCHEMA_VERSION;
    returnPct: number;
    /** In memory `Infinity` when a short span overflows the annualization; see ResearchMetricsRecord for JSON. */
    annualizedReturnPct: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    winRate: number;
    profitFactor: number | 'Infinity';
    expectancy: number;
    sharpe: number;
    sortino: number;
    trades: number;
    averageHoldingBars: number;
    exposure: number;
    totalCost: number;
    /** Null when there is no positive gross profit. */
    costToGrossProfit: number | null;
    turnover: number;
    long: { trades: number; pnl: number; wins: number };
    short: { trades: number; pnl: number; wins: number };
    /** Null when no benchmark close is available. */
    buyAndHoldReturnPct: number | null;
}
