// src/lib/execution/model.ts — execution-location-independent order
// program model (#201). One model expresses a price trigger (1 level with a
// touch entry), a bracket (1 level: entry + OCO touch exits) and a cycling
// grid (N levels with limit entries and take-profit exits). The executor —
// the native Rust core on desktop, the TypeScript reference core elsewhere —
// only understands levels, legs, slots and rules; it never needs to know the
// word "grid".
//
// Everything here is plain JSON (no Date, Map, class or undefined-vs-null
// ambiguity in required fields) so that a state written by one executor can
// be read by the other, and so the shared conformance scenarios
// (./scenarios/*.json) are the single behavioural specification.
//
// Determinism: the core never reads a clock or a random source. Time comes
// from events (`ts`, epoch milliseconds); ids and idempotency keys come from
// counters stored in the state. Replaying the same events on the same state
// yields the same state and the same intents — the Rust journal recovery
// relies on this.

export const EXECUTION_SCHEMA_VERSION = 'execution-v1';

export type Env = 'simulation' | 'production';
export type Side = 'Buy' | 'Sell';
export type Market = 'stock' | 'futures';

export interface AccountKey {
    accountType: 'S' | 'F';
    brokerId: string;
    accountId: string;
}

export interface ContractKey {
    market: Market;
    /** Quote-stream code ticks arrive with (may be a continuous alias, e.g. TXFR1). */
    quoteCode: string;
    /** Tradable code orders are sent with and deals report (e.g. TXFJ6). */
    orderCode: string;
    securityType: 'STK' | 'FUT' | 'OPT';
}

/** Immutable after creation (#201 environment isolation). A program only
 * runs, and an intent is only emitted, while the connected server matches
 * `env` AND `serverId` exactly. */
export interface Binding {
    env: Env;
    /** Server identity (desktop: API base of the local sidecar). */
    serverId: string;
    account: AccountKey;
    contract: ContractKey;
}

export interface OrderSpec {
    priceType: 'MKT' | 'LMT';
    timeInForce?: 'ROD' | 'IOC' | 'FOK';
    /** Futures position effect (bracket/grid exits use Cover). */
    octype?: 'Auto' | 'New' | 'Cover' | 'DayTrade';
    stockCond?: 'Cash' | 'MarginTrading' | 'ShortSelling';
    stockLot?: 'Common' | 'IntradayOdd' | 'Odd' | 'Fixing';
    /** Stock day-trade short (當沖賣) flag. */
    daytradeShort?: boolean;
}

export type TouchCondition = 'below' | 'above'; // fire when last <= / >= price

/** Prices are compared as fixed-point integers (1e-4 units, rounded at the
 * boundary) so a trigger computed as 0.1 + 0.2 still equals a 0.3 quote. JSON
 * stays numeric; both cores use exactly this conversion. */
export const PRICE_SCALE = 10_000;

/** How a level opens its position. */
export type EntryRule =
    /** Virtual level: watch price, send `order` when it touches (觸價). */
    | { type: 'touch'; condition: TouchCondition; price: number; order: OrderSpec }
    /** Resting limit order at `price`; submitted once price is on the
     * non-marketable side (buy: last > price, sell: last < price). */
    | { type: 'limit'; price: number; order: OrderSpec }
    /** Entry order placed outside the program (bracket entry sent by the
     * order ticket); the program only tracks its reports. */
    | { type: 'external'; orderId: string; seqno?: string; ordno?: string };

/** A touch leg of an exit (stop or take). Fires a market-style order. */
export interface TouchLeg {
    price: number;
    condition: TouchCondition;
}

/** How a level closes what its entry filled. */
export type ExitSpec =
    /** Grid: a resting limit exit at `price` for every entry fill. */
    | { type: 'takeProfit'; price: number; order: OrderSpec }
    /** Bracket: OCO pair of touch legs protecting the filled quantity. */
    | { type: 'oco'; stop: TouchLeg | null; take: TouchLeg | null; order: OrderSpec };

export type LegName = 'entry' | 'stop' | 'take' | 'tp';

/** Cancel request tracking for a working order (stop / bound break). A
 * program is not stopped until every cancel is confirmed or the order ended
 * otherwise. A failed attempt is retried (new key per attempt) on the next
 * tick / reconnect; an unknown one only once CANCEL_UNKNOWN_RETRY_MS passed
 * without a report settling it; at most MAX_CANCEL_ATTEMPTS attempts. Results
 * and Cancel reports name the attempt (`key` / `cancelKey`); a stale attempt's
 * answer never changes the current one. */
export interface CancelState {
    key: string;
    status: 'pendingSubmit' | 'requested' | 'confirmed' | 'failed' | 'unknown';
    attempts: number;
    detail: string | null;
    /** ts the current attempt was emitted. An `unknown` or `requested`
     * attempt may still be in flight: it is only retried after
     * CANCEL_UNKNOWN_RETRY_MS, unless a report / reconcile settles it first. */
    sentAt: number;
    /** Attempt keys that may still be answered (sent, not yet settled by a
     * notSent result or a keyed failure). An unkeyed Cancel failure is
     * attributed to the current attempt only when it is the sole one here. */
    outstanding: string[];
}

export type SlotStatus =
    | 'pendingSubmit' // intent journaled and emitted, no result yet
    | 'working' // broker accepted
    | 'filled' // fills cover the quantity
    | 'ended' // cancelled / failed with the rest unfilled
    | 'notSent' // refused before any broker request
    | 'unknown'; // outcome unknown — never resent; only reconcile/ack clears

/** One order the program asked for (or tracks). */
export interface OrderSlot {
    /** Immutable emission generation; absent only in legacy/external slots. */
    submitVersion?: number;
    /** The broker listing reuses this raw id for multiple stable orders. */
    cancelAmbiguous?: boolean;
    seqno?: string; ordno?: string;
    /** Idempotency key; the only identity reconciliation may use. */
    key: string;
    role: 'entry' | 'exit';
    leg: LegName;
    cycle: number;
    qty: number;
    status: SlotStatus;
    orderId: string | null;
    filled: number;
    /** fill identity → quantity (`<orderId>:<exchange_seq>` or `event:<id>`). */
    fills: Record<string, number>;
    /** fill identity → exchange ts, pairs an event-only fill with its seq row. */
    fillTs: Record<string, number>;
    detail: string | null;
    acknowledged: boolean;
    cancel: CancelState | null;
    /** Quantity the broker cancelled (UpdateQty reductions + Cancel):
     * max(listing's cumulative, sum of report deltas) — never their sum (a
     * report may already be in the listing). The order still works
     * `qty - filled - cancelled`. */
    cancelled?: number;
    /** report id → quantity it cancelled (dedupe). */
    cancels?: Record<string, number>;
    /** Cumulative cancelled quantity of the latest listing (authoritative
     * floor); `cancelled = max(listedCancelled, sum(cancels))`. */
    listedCancelled?: number;
    /** A listing had rows with this slot's tag that could not be bound to it
     * (duplicate / mismatching): the order may exist. Set by the reconcile
     * that saw it; never concluded never-accepted. */
    tagAmbiguous?: boolean;
    /** The trade id is from an earlier epoch (another connection / trading
     * day): it no longer identifies the order. Nothing matches it (reports,
     * listings, cancels) until a listing of the current epoch rebinds the
     * slot by its tag (an ended slot never is). */
    unconfirmed?: boolean;
    /** Trading epoch of the last strictly verified listing. Terminal fill evidence
     * may extend this ledger after reconnect, never across a trading-day boundary. */
    evidenceEpoch?: number;
}

export type RestoreReason = 'restart' | 'disconnect' | 'env' | 'resume' | 'unknownNotSent'
    /** An external (bracket) entry still open across an epoch boundary: the
     * user confirms how much it filled before any exit counts on it. */
    | 'unknownEntryAcrossDay' | 'unknownEntryAfterReconnect';

export type LevelPhase =
    | 'idle' // waiting to enter (touch watching / limit not yet submitted)
    | 'working' // entry order active, nothing held
    | 'holding' // position held, exit armed (touch) or about to be placed
    | 'exiting' // exit order active
    | 'needsConfirm' // #144: user must send / cancel / keep
    | 'unknown' // an order outcome is unknown; level frozen
    | 'done' // finished (no further cycle)
    | 'disabled'; // refused / acknowledged unknown / user disabled

export interface PendingConfirm {
    leg: LegName;
    price: number | null;
    ts: number;
    reason: RestoreReason;
}

export interface Level {
    id: string;
    side: Side; // entry side; exits use the opposite side
    qty: number;
    entry: EntryRule;
    exit: ExitSpec | null;
    phase: LevelPhase;
    /** Set when the next tick must decide between normal firing and
     * needsConfirm (#144). */
    check: RestoreReason | null;
    /** Legs kept after needsConfirm: fire only after price is seen on the
     * non-trigger side and crosses again. */
    recross: LegName[];
    pending: PendingConfirm | null;
    /** External entry identity/remainder confirmation, independent of an exit decision. */
    entryPending?: PendingConfirm | null;
    orders: OrderSlot[];
    /** Entry filled minus exit filled in the current cycle. */
    position: number;
    /** Entry quantity filled in the current cycle. */
    entryFilled: number;
    /** Entry fills that arrived after the exit was dispatched (bracket). */
    unprotected: number;
    cycles: number;
    detail: string | null;
}

// ---- generators & policies (parameters; levels are materialised) ----

export type Spacing =
    | { type: 'pct'; value: number }
    | { type: 'ticks'; value: number }
    | { type: 'abs'; value: number }
    | { type: 'atr'; n: number; k: number; timeframe: string };

export type PriceAnchor =
    | { type: 'fixed'; price: number }
    | { type: 'last' }
    | { type: 'positionCost' }
    | { type: 'indicator'; ref: string };

export type LevelGenerator =
    | { type: 'ladder'; anchor: PriceAnchor; spacing: Spacing; count: number; direction: 'down' | 'up';
        qty: number; takeProfit: Spacing; order: OrderSpec; exitOrder: OrderSpec }
    | { type: 'range'; upper: number; lower: number; count: number; spacingKind: 'arith' | 'geom';
        mode: 'long' | 'short' | 'neutral'; qty: number; order: OrderSpec; exitOrder: OrderSpec }
    | { type: 'proportional'; base: PriceAnchor; upPct: number; downPct: number; tradePct: number;
        coreMin: number; maxHold: number }
    | { type: 'dca'; first: OrderSpec; steps: number; stepPct: number; stepScale: number; volumeScale: number };

export interface CyclePolicy {
    /** After a level's exit fully fills, return to idle and enter again. */
    rearmAfterExit: boolean;
    maxCycles: number | null;
    /** 'immediate': every entry fill places an equal exit at once. */
    partialFill: 'immediate';
}

export type BreakAction = 'none' | 'pause' | 'stop';

export interface Bounds {
    upper: number | null;
    lower: number | null;
    onBreakUpper: BreakAction;
    onBreakLower: BreakAction;
}

export interface SessionPolicy {
    /** Resume rule: price already past a touch leg on the first tick after a
     * restore → needsConfirm (#144). The only rule defined for v1. */
    resumeRule: 'confirm';
    /** Protection could not evaluate longer than this → restore check. */
    longDisconnectMs: number;
    /** No tick nor heartbeat longer than this → restore check. */
    silentStallMs: number;
}

export interface RiskLimits {
    /** Max entry orders resting at once (others stay virtual). */
    maxWorkingEntries: number | null;
}

/** Strategy hook placeholder: event → condition → action. Parsed and kept,
 * NOT evaluated by the v1 core — a program with hooks is refused at create
 * time until an evaluator exists. */
export interface StrategyHook {
    on: { type: 'barClose'; timeframe: string } | { type: 'tick' } | { type: 'time'; at: string } | { type: 'fill' } | { type: 'programStart' };
    when: { type: 'expr'; expr: string };
    then: { type: 'arm' } | { type: 'pause' } | { type: 'resume' } | { type: 'stopAndFlatten' }
        | { type: 'shiftLevels'; ticks: number } | { type: 'regenerate' } | { type: 'setEntryEnabled'; enabled: boolean }
        | { type: 'scaleQty'; factor: number };
    hysteresisBars: number | null;
}

export type ProgramKind = 'trigger' | 'bracket' | 'grid' | 'custom';
export type ProgramStatus = 'running' | 'paused' | 'stopping' | 'stopped';
/** Why a running program is not sending right now (not a user state). */
export type ProgramHold = 'envMismatch' | 'disconnected' | 'unknownEnv' | null;

export interface ProgramIssue {
    code: string;
    detail: string;
    ts: number;
}

export interface OrderProgram {
    id: string;
    /** UI classification only; the core never branches on it. */
    kind: ProgramKind;
    binding: Binding;
    /** +1 on every accepted user command; commands carry the version they
     * were issued against and are refused when stale. */
    version: number;
    status: ProgramStatus;
    /** Removed ledger retains strict evidence, with no active authority. */
    observationOnly?: boolean;
    pauseReason: string | null;
    hold: ProgramHold;
    /** First leg that fires cancels every other level's legs (OCO across
     * levels, e.g. a manual stop + take pair). */
    ocoLevels: boolean;
    levels: Level[];
    generator: LevelGenerator | null;
    cycle: CyclePolicy;
    bounds: Bounds;
    session: SessionPolicy;
    risk: RiskLimits;
    hooks: StrategyHook[];
    /** Next intent sequence number (part of every idempotency key). */
    intentSeq: number;
    issues: ProgramIssue[];
    createdAt: number;
    updatedAt: number;
}

// ---- engine-level state ----

export interface ConnectionState {
    live: boolean;
    env: Env | null;
    serverId: string | null;
    /** ts the connection stopped being able to evaluate (null while live). */
    downSince: number | null;
    /** Environment last evaluated (a different one on resume = 'env' restore). */
    lastEvalEnv: Env | null;
    lastEvalServerId: string | null;
    /** Accounts whose first listing of the current trade-id epoch has not been
     * applied yet: reports are taken, nothing is placed or cancelled. */
    awaitingEpochListing?: AccountKey[];
}

export interface BufferedDeal {
    deal: DealEvent;
    ts: number;
}

export interface BufferedOrder {
    order: OrderEvent;
    ts: number;
}

export interface EngineState {
    schema: typeof EXECUTION_SCHEMA_VERSION;
    conn: ConnectionState;
    /** ts of the last tick or heartbeat seen while evaluating. */
    lastActivity: number | null;
    /** Latest trade price per quote code since the connection last changed. */
    lastPrices: Record<string, number>;
    /** Deals whose order id is not yet known (report raced the response). */
    orphanDeals: BufferedDeal[];
    /** Order reports (e.g. New failed) whose order id is not yet known. */
    orphanOrders: BufferedOrder[];
    programs: OrderProgram[];
    /** Trade-id epoch (see core.ts epochMark) of the last `epoch` event. */
    epochMark?: number;
    /** Number of `epoch` events: the current epoch. An input stamped with
     * another one (a late place response, a listing requested before the
     * boundary) never confirms an id. */
    epochSeq?: number;
}

// ---- events in ----

/** Every market / order / deal / result event names the environment it came
 * from. The executor routes and matches strictly by it — never by "whatever
 * is connected now" — so a late simulation tick can never drive production. */
export interface Source { env: Env; serverId: string }

/** `price` is the latest trade. A coalesced tick (the native engine merges
 * ticks that arrived while it was busy) also carries `low` / `high`: the
 * range of real (non-simtrade) trade prices since the previous tick, so a
 * crossing inside the burst is never lost. Absent = just `price`. */
export interface TickEvent extends Source {
    type: 'tick'; ts: number; code: string; price: number; simtrade?: boolean;
    low?: number; high?: number;
}
export interface HeartbeatEvent extends Source { type: 'heartbeat'; ts: number }
export interface ConnectionEvent { type: 'connection'; ts: number; live: boolean; env: Env | null; serverId: string | null }
export interface IntentResultEvent extends Source {
    seqno?: string; ordno?: string;
    type: 'intentResult'; ts: number; key: string;
    outcome: 'accepted' | 'notSent' | 'unknown';
    orderId?: string; detail?: string;
    /** Epoch the request was sent in (`EngineState.epochSeq`). */
    epoch?: number;
}
export interface OrderEvent extends Source {
    /** Original order facts, separate from the operation's cancelled delta.
     * Required for external entries; older engine-owned reports may omit them. */
    action?: Side;
    originalQty?: number;
    seqno?: string; ordno?: string;
    type: 'order'; ts: number; orderId: string;
    op: 'New' | 'Cancel' | 'UpdatePrice' | 'UpdateQty';
    failed: boolean; detail?: string;
    /** Cancel reports: the cancel intent key (attempt) this report answers.
     * Without it, a Cancel failure counts for the current attempt only when
     * that is the only outstanding one; otherwise the cancel becomes
     * `unknown` (retried after the timeout unless settled). */
    cancelKey?: string;
    /** Quantity THIS report cancelled (Cancel, UpdateQty — the broker
     * reports it per operation, e.g. reduce 1 then cancel the last 1 = two
     * reports of 1). Summed into the slot's `cancelled`; the order ends once
     * `filled + cancelled >= qty`. A successful Cancel that leaves quantity
     * working did not end the order (the cancel is retried after the timeout). */
    cancelQty?: number;
    /** Report identity (event id) so a repeated report is counted once. */
    reportId?: string;
    /** The order's account and contract as reported: an id is only an
     * identity within (account, contract) — stock and futures sequences are
     * independent and can produce the same id. */
    account?: { brokerId: string; accountId: string } | null;
    code?: string;
    securityType?: string;
    /** Exchange time of the operation (epoch seconds, `status.exchange_ts`):
     * which trade-id epoch the report belongs to. */
    exchTs?: number;
}
export interface DealEvent extends Source {
    seqno?: string; ordno?: string;
    type: 'deal'; ts: number; orderId: string;
    eventId: string | null; seq: string | null;
    account: { brokerId: string; accountId: string } | null;
    code: string; action: Side; qty: number; price: number;
    /** The order's security type as reported (stock and futures ids repeat). */
    securityType?: string;
    /** Exchange fill time (epoch s) used to pair event-only fills. */
    fillTs?: number;
}
export interface ReconciledOrder {
    cancelAmbiguous?: boolean;
    seqno?: string; ordno?: string;
    intentKey: string | null;
    orderId: string;
    status: 'working' | 'filled' | 'ended';
    qty: number;
    deals: { seq: string; qty: number; price: number; ts?: number }[];
    /** Cumulative cancelled quantity of the order at the broker. */
    cancelled?: number;
    /** A report of this order was applied after the listing was requested:
     * the row may only add (fills, cumulative cancels, a final status), it
     * never revives the order nor downgrades anything. */
    stale?: boolean;
    /** The row's security type (scopes its id: stock and futures repeat). */
    securityType?: string;
}
export interface ReconcileEvent {
    type: 'reconcile'; ts: number;
    account: AccountKey; env: Env; serverId: string;
    orders: ReconciledOrder[];
    /** The listing covers every order of the account today: an unknown
     * intent whose key is absent was never accepted. */
    complete: boolean;
    /** Unknown submits (by key) the evidence shows were never accepted;
     * concluded even when `complete` is false (per-slot decision: a slot that
     * became unknown after the listing was requested is never concluded). */
    notSent?: string[];
    /** Slots (by key) whose tag rows are duplicated / mismatching in this
     * listing: flagged `tagAmbiguous` for good. */
    ambiguous?: string[];
    /** Epoch the listing was requested in: from another epoch it is
     * ignored (its ids may name other orders now). */
    epoch?: number;
}
/** The executor (re)started from persisted state. */
export interface RestoreEvent { type: 'restore'; ts: number }
/** A new trade-id epoch on a connection: ids bound before no longer
 * identify orders. */
export interface EpochEvent extends Source { type: 'epoch'; ts: number }

export type UserCommand =
    | { op: 'create'; program: OrderProgram }
    | { op: 'pause'; programId: string; version: number }
    | { op: 'resume'; programId: string; version: number }
    | { op: 'stop'; programId: string; version: number }
    | { op: 'remove'; programId: string; version: number }
    | { op: 'resolvePending'; programId: string; version: number; levelId: string;
        choice: 'send' | 'cancel' | 'keep'; allowUnpast?: boolean }
    | { op: 'ackUnknown'; programId: string; version: number; levelId: string }
    /** The user's answer for an external entry open across an epoch
     * (`unknownEntryAcrossDay`): how much of it filled in total. */
    | { op: 'confirmEntry'; programId: string; version: number; levelId: string; filled: number;
        /** The user confirms nothing of the entry still works (all filled or
         * the rest cancelled): required to end it. */
        noRemainder: boolean };

export interface CommandEvent { type: 'command'; ts: number; id: string; command: UserCommand }

export type ExecEvent =
    | TickEvent | HeartbeatEvent | ConnectionEvent | IntentResultEvent | OrderEvent
    | DealEvent | ReconcileEvent | RestoreEvent | EpochEvent | CommandEvent;

// ---- intents out ----

export interface PlaceIntent {
    kind: 'place';
    /** Idempotency key, globally unique: `<env>/<encodeURIComponent(serverId)>/
     * <programId>/<levelId>/<leg>/<cycle>/<seq>` (see intentKey in core.ts). */
    key: string;
    programId: string;
    levelId: string;
    version: number;
    role: 'entry' | 'exit';
    leg: LegName;
    env: Env;
    serverId: string;
    account: AccountKey;
    orderCode: string;
    action: Side;
    qty: number;
    price: number | null; // null for MKT
    order: OrderSpec;
}

export interface CancelIntent {
    kind: 'cancel';
    key: string;
    programId: string;
    levelId: string;
    version: number;
    env: Env;
    serverId: string;
    account: AccountKey;
    orderId: string;
}

export type OrderIntent = PlaceIntent | CancelIntent;

export interface Notice {
    code: string;
    programId: string | null;
    levelId: string | null;
    detail: string;
}

export interface StepResult {
    state: EngineState;
    intents: OrderIntent[];
    notices: Notice[];
}
