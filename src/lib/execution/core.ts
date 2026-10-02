// src/lib/execution/core.ts — TypeScript reference executor for the order
// program model (#201). Pure: `step(state, event)` returns the next state,
// the order intents to send and user-facing notices. No I/O, no clock, no
// randomness. The native Rust core implements the same rules and both are
// checked against ./scenarios/*.json (see ./conformance.ts).
//
// Rules (shared with the Rust core — change both, and the scenarios):
// - Environment isolation: a program only fires / submits while the
//   connection is live AND its env + serverId equal the binding. Otherwise it
//   is held ('disconnected' | 'unknownEnv' | 'envMismatch') and emits nothing.
// - Every intent is recorded as a `pendingSubmit` slot BEFORE it is returned.
//   The Rust executor sends it at once and journals asynchronously (ticks are
//   never written); a crash can lose the newest records, so recovery relies
//   on deterministic keys / tags, reconcile before live, and holding every
//   order of a program that may have sent unrecorded orders (an unclean
//   shutdown) as `unknown` until listings settle it.
// - `restore` (executor restarted from persisted state) turns every
//   `pendingSubmit` slot into `unknown`: never resent, only a reconcile
//   (matched by idempotency key) or a user acknowledgement clears it.
// - #144: after restore / env switch back / long disconnect / silent stall /
//   user resume, the first tick decides for touch legs: already past →
//   `needsConfirm` (send / cancel / keep); keep = fire only after recross.
// - Fills are deduplicated by `<orderId>:<exchange_seq>`; an event-only fill
//   (`event:<eventId>`) and a seq row with the same qty and exchange ts are
//   the same fill. Fills whose account / code / side do not match are not
//   counted (issue raised).
// - Brackets: the OCO fires once per cycle for min(entryFilled, qty); entry
//   fills after that are `unprotected`, never auto-covered.
// - Grids: each entry fill places an equal take-profit exit at once
//   (partial fills included); a cycle completes when the entry is terminal and
//   the position is flat; `rearmAfterExit` returns the level to idle.
// - Sources: tick / heartbeat / order / deal / intentResult events carry the
//   env + serverId they came from. Ticks and heartbeats count only when that
//   is the live connection; reports and results only ever match programs
//   bound to that same env + serverId.
// - Prices compare as fixed-point integers (PRICE_SCALE).
// - Cancels are tracked per slot (CancelState); a stopping program becomes
//   stopped only when no order is active any more.

import {
    EXECUTION_SCHEMA_VERSION,
    type AccountKey,
    type CommandEvent,
    type ConnectionEvent,
    type DealEvent,
    type EngineState,
    type EpochEvent,
    type ExecEvent,
    type IntentResultEvent,
    type LegName,
    type Level,
    type Notice,
    type OrderEvent,
    type OrderIntent,
    type OrderProgram,
    type BreakAction,
    type OrderSlot,
    type OrderSpec,
    PRICE_SCALE,
    type ReconcileEvent,
    type RestoreReason,
    type Side,
    type Source,
    type StepResult,
    type TouchCondition,
} from './model';

export const ORPHAN_DEAL_LIMIT = 200;
export const ORPHAN_ORDER_LIMIT = 200;
export const ISSUE_LIMIT = 50;
export const MAX_CANCEL_ATTEMPTS = 3;
export const CANCEL_UNKNOWN_RETRY_MS = 30_000;

/** Globally unique idempotency key: the partition (env + server identity) is
 * part of the key itself, so a sender may dedupe across environments. */
/** Trade-id epoch boundaries, minutes after 00:00 UTC. Trade ids repeat:
 * paper ids are a per-site sequence reset at 00:00 UTC; production ids are
 * xxh32 of the broker's 6-digit seqno, which does not reset per day but
 * wraps after 999999 or resets at STS maintenance (time unknown), and stock
 * and futures counters overlap. So an id binding is trusted only within one
 * epoch and one (account, market). Conservative: 00:00 UTC, 08:30 Taipei
 * (before the day session), 14:50 Taipei (before the night session); every
 * connection is a boundary too (the executor).
 * TODO(#201): simplify once the backend confirms when the seqno wraps / resets. */
export const EPOCH_BOUNDARIES_UTC_MIN = [0, 30, 410] as const;

/** Detail of a request refused by the send-time gate because a trade-id
 * epoch boundary passed after it was created, or is within the guard band:
 * nothing was sent. */
export const EPOCH_CHANGED = 'epochChanged';

/** Guard band before every time boundary: nothing is emitted (core) and nothing
 * passes the send-time gate when the next boundary is nearer than this. An
 * order is on the wire the instant it passes the gate (written in the same
 * synchronous section), so this keeps a request clear of the boundary while it
 * travels sidecar → broker. Every boundary is outside the trading sessions. */
export const EPOCH_GUARD_BAND_MS = 4_000;

/** The first time boundary after `ts` (epoch ms). */
export function nextEpochBoundary(ts: number): number {
    const DAY = 86_400_000;
    const day = Math.floor(ts / DAY);
    for (const d of [0, 1]) {
        for (const m of EPOCH_BOUNDARIES_UTC_MIN) {
            const t = (day + d) * DAY + m * 60_000;
            if (t > ts) return t;
        }
    }
    throw new Error('a boundary every day');
}

/** `ts` is within the guard band before the next boundary. */
export function inEpochGuardBand(ts: number): boolean {
    return nextEpochBoundary(ts) - ts < EPOCH_GUARD_BAND_MS;
}

/** The epoch `ts` (epoch ms) falls in: changes at every boundary. */
export function epochMark(ts: number): number {
    const DAY = 86_400_000;
    const day = Math.floor(ts / DAY);
    const minute = Math.floor((ts - day * DAY) / 60_000);
    const passed = EPOCH_BOUNDARIES_UTC_MIN.filter(b => b <= minute).length;
    return day * EPOCH_BOUNDARIES_UTC_MIN.length + passed;
}

/** An id is only an identity within (account, market, contract): production
 * ids are xxh32 of the broker's seqno, and the stock and futures counters
 * are independent with overlapping ranges. */
function reportMatches(p: OrderProgram, account: { brokerId: string; accountId: string } | null | undefined,
    code: string | undefined, securityType: string | undefined): boolean {
    const b = p.binding;
    return (!account || (account.brokerId === b.account.brokerId && account.accountId === b.account.accountId))
        && (code === undefined || code === b.contract.orderCode || code === b.contract.quoteCode)
        && (securityType === undefined || securityType === b.contract.securityType);
}

const isExternalEntry = (lv: Level, slot: OrderSlot) => slot.role === 'entry' && lv.entry.type === 'external';

export function brokerIdentityMatches(a: { seqno?: string; ordno?: string }, b: { seqno?: string; ordno?: string }): boolean {
    const pairs = [ [a.seqno?.trim(), b.seqno?.trim()], [a.ordno?.trim(), b.ordno?.trim()] ];
    return pairs.some(([x, y]) => !!x && x === y) && pairs.every(([x, y]) => !x || !y || x === y);
}

/** A conflicting broker identifier always beats a reused trade id. Only a
 * currently confirmed legacy binding can use that id as a fallback. */
export function externalIdentity(a: { orderId: string; seqno?: string; ordno?: string; confirmed?: boolean },
    b: { orderId: string; seqno?: string; ordno?: string; confirmed?: boolean }): 'same' | 'different' | 'unknown' {
    const pairs = [[a.seqno?.trim(), b.seqno?.trim()], [a.ordno?.trim(), b.ordno?.trim()]];
    if (pairs.some(([x, y]) => !!x && !!y && x !== y)) return 'different';
    if (brokerIdentityMatches(a, b)) return 'same';
    const stableA = !!(a.seqno?.trim() || a.ordno?.trim());
    const stableB = !!(b.seqno?.trim() || b.ordno?.trim());
    if (stableA && stableB) return 'unknown';
    if (a.orderId !== b.orderId) return 'different';
    return a.confirmed !== false && b.confirmed !== false ? 'same' : 'unknown';
}

export function externalEntryPending(lv: Level) {
    return lv.entryPending ?? (unknownExternalEntry(lv.pending?.reason) ? lv.pending : null);
}

function clearEntryPending(lv: Level) {
    lv.entryPending = null;
    if (unknownExternalEntry(lv.pending?.reason)) lv.pending = null;
}

function rebindSlot(slot: OrderSlot, id: string) {
    if (slot.orderId && slot.orderId !== id) {
        const prefix = `${slot.orderId}:`;
        for (const values of [slot.fills, slot.fillTs]) {
            for (const [key, value] of Object.entries(values)) {
                if (!key.startsWith(prefix)) continue;
                delete values[key];
                values[`${id}:${key.slice(prefix.length)}`] = value;
            }
        }
    }
    slot.orderId = id;
}

const unknownExternalEntry = (reason?: string) => reason === 'unknownEntryAcrossDay' || reason === 'unknownEntryAfterReconnect';

export function intentKey(p: OrderProgram, lv: Level, leg: LegName): string {
    return `${p.binding.env}/${encodeURIComponent(p.binding.serverId)}/${p.id}/${lv.id}/${leg}/${lv.cycles}/${p.intentSeq}`;
}

export function initialState(): EngineState {
    return {
        schema: EXECUTION_SCHEMA_VERSION,
        conn: { live: false, env: null, serverId: null, downSince: null, lastEvalEnv: null, lastEvalServerId: null },
        lastActivity: null,
        lastPrices: {},
        orphanDeals: [],
        orphanOrders: [],
        programs: [],
    };
}

interface Ctx {
    s: EngineState;
    intents: OrderIntent[];
    notices: Notice[];
    ts: number;
}

const opposite = (side: Side): Side => side === 'Buy' ? 'Sell' : 'Buy';

/** Price → fixed-point integer (PRICE_SCALE units), the only form prices are compared in. */
export const fixed = (price: number): number => Math.round(price * PRICE_SCALE);

export const isPast = (condition: TouchCondition, trigger: number, price: number) =>
    (condition === 'below' && fixed(price) <= fixed(trigger)) || (condition === 'above' && fixed(price) >= fixed(trigger));

const isActive = (slot: OrderSlot) => slot.status === 'pendingSubmit' || slot.status === 'working';

function canEvaluate(s: EngineState): boolean {
    return s.conn.live && s.conn.env !== null && s.conn.serverId !== null;
}

const sameAccount = (a: AccountKey, b: AccountKey) =>
    a.accountType === b.accountType && a.brokerId === b.brokerId && a.accountId === b.accountId;

/** Nothing is placed or cancelled for an account until this epoch's first
 * listing of it has been applied (triggers meanwhile wait: a touch re-fires
 * on a later tick, exits and cancels are ensured once the listing is in). */
function awaitingListing(s: EngineState, p: OrderProgram): boolean {
    return (s.conn.awaitingEpochListing ?? []).some(a => sameAccount(a, p.binding.account));
}

function envMatches(s: EngineState, p: OrderProgram): boolean {
    return canEvaluate(s) && s.conn.env === p.binding.env && s.conn.serverId === p.binding.serverId;
}

/** The event came from the environment that is live right now. */
function fromLive(s: EngineState, e: Source): boolean {
    return canEvaluate(s) && s.conn.env === e.env && s.conn.serverId === e.serverId;
}

const boundTo = (p: OrderProgram, e: Source) => p.binding.env === e.env && p.binding.serverId === e.serverId;

function notice(ctx: Ctx, code: string, p: OrderProgram | null, levelId: string | null, detail: string) {
    ctx.notices.push({ code, programId: p?.id ?? null, levelId, detail });
}

function addIssue(ctx: Ctx, p: OrderProgram, code: string, detail: string) {
    p.issues.push({ code, detail, ts: ctx.ts });
    if (p.issues.length > ISSUE_LIMIT) p.issues.splice(0, p.issues.length - ISSUE_LIMIT);
    notice(ctx, `issue.${code}`, p, null, detail);
}

const HOLD_REASON = { disconnected: 'disconnected', unknownEnv: 'unknownEnv', envMismatch: 'envSwitched' } as const;

function updateHolds(ctx: Ctx) {
    const s = ctx.s;
    for (const p of s.programs) {
        const was = p.hold;
        p.hold = !s.conn.live ? 'disconnected'
            : s.conn.env === null || s.conn.serverId === null ? 'unknownEnv'
                : envMatches(s, p) ? null : 'envMismatch';
        if (p.hold !== was) {
            if (p.hold !== null) notice(ctx, 'held', p, null, HOLD_REASON[p.hold]);
            else notice(ctx, 'released', p, null, was ?? '');
        }
    }
}

// ---- legs ----

interface Leg { name: LegName; condition: TouchCondition; price: number }

/** Touch legs the level is watching right now. */
export function touchLegs(lv: Level): Leg[] {
    if (lv.phase === 'idle' && lv.entry.type === 'touch') {
        return [{ name: 'entry', condition: lv.entry.condition, price: lv.entry.price }];
    }
    if (lv.phase === 'holding' && lv.exit?.type === 'oco' && !exitFired(lv)) {
        const legs: Leg[] = [];
        if (lv.exit.stop) legs.push({ name: 'stop', ...lv.exit.stop });
        if (lv.exit.take) legs.push({ name: 'take', ...lv.exit.take });
        return legs;
    }
    return [];
}

/** A stop: a bracket's stop exit, or a trigger whose order and condition read
 * as a stop (sell below / buy above — the UI's stop / take split). Entries of
 * other programs and take-profit legs are not. */
function protective(p: OrderProgram, lv: Level, leg: Leg): boolean {
    if (leg.name === 'stop') return true;
    if (leg.name !== 'entry') return false;
    return p.kind === 'trigger'
        && ((lv.side === 'Sell' && leg.condition === 'below') || (lv.side === 'Buy' && leg.condition === 'above'));
}

function legOf(lv: Level, name: LegName): Leg | null {
    if (name === 'entry' && lv.entry.type === 'touch') return { name, condition: lv.entry.condition, price: lv.entry.price };
    if ((name === 'stop' || name === 'take') && lv.exit?.type === 'oco') {
        const l = lv.exit[name];
        return l ? { name, ...l } : null;
    }
    return null;
}

const cycleSlots = (lv: Level, role: 'entry' | 'exit') => lv.orders.filter(o => o.role === role && o.cycle === lv.cycles);
const exitFired = (lv: Level) => lv.exit?.type === 'oco' && cycleSlots(lv, 'exit').length > 0;

// ---- emitting ----

function emitPlace(ctx: Ctx, p: OrderProgram, lv: Level, role: 'entry' | 'exit', leg: LegName, qty: number,
    price: number | null, order: OrderSpec): boolean {
    // isolation guard: never cross environments
    if (!envMatches(ctx.s, p) || awaitingListing(ctx.s, p) || inEpochGuardBand(ctx.ts) || qty <= 0) return false;
    const key = intentKey(p, lv, leg);
    p.intentSeq += 1;
    lv.orders.push({ key, role, leg, cycle: lv.cycles, qty, status: 'pendingSubmit', orderId: null, filled: 0,
        fills: {}, fillTs: {}, detail: null, acknowledged: false, cancel: null });
    const b = p.binding;
    ctx.intents.push({ kind: 'place', key, programId: p.id, levelId: lv.id, version: p.version, role, leg,
        env: b.env, serverId: b.serverId, account: b.account, orderCode: b.contract.orderCode,
        action: role === 'entry' ? lv.side : opposite(lv.side), qty,
        price: order.priceType === 'MKT' ? null : price, order });
    p.updatedAt = ctx.ts;
    return true;
}

function emitCancel(ctx: Ctx, p: OrderProgram, lv: Level, slot: OrderSlot): boolean {
    // an id of an earlier epoch may name another order: never cancel it
    if (!envMatches(ctx.s, p) || !slot.orderId || slot.unconfirmed || awaitingListing(ctx.s, p)
        || inEpochGuardBand(ctx.ts)) return false;
    const attempts = (slot.cancel?.attempts ?? 0) + 1;
    const key = `${slot.key}/cancel/${attempts}`;
    slot.cancel = { key, status: 'pendingSubmit', attempts, detail: null, sentAt: ctx.ts,
        outstanding: [...(slot.cancel?.outstanding ?? []), key] };
    const b = p.binding;
    ctx.intents.push({ kind: 'cancel', key, programId: p.id, levelId: lv.id, version: p.version,
        env: b.env, serverId: b.serverId, account: b.account, orderId: slot.orderId });
    p.updatedAt = ctx.ts;
    return true;
}

/** Stopping program: cancel every working entry not yet asked to cancel;
 * with `retry`, also resend failed cancels, and unknown / requested ones that stayed
 * unsettled for CANCEL_UNKNOWN_RETRY_MS (bounded by MAX_CANCEL_ATTEMPTS). */
function ensureCancels(ctx: Ctx, p: OrderProgram, retry: boolean) {
    if (p.status !== 'stopping' || !envMatches(ctx.s, p)) return;
    for (const lv of p.levels) {
        for (const slot of lv.orders) {
            // no confirmed id this epoch: wait for a listing to rebind it
            if (slot.role !== 'entry' || slot.status !== 'working' || !slot.orderId || slot.unconfirmed) continue;
            const c = slot.cancel;
            if (c === null) emitCancel(ctx, p, lv, slot);
            // refused at the send-time gate (never sent): goes out as soon as
            // the id is confirmed in this epoch, not an attempt toward giving up
            else if (c.status === 'failed' && c.detail === EPOCH_CHANGED) emitCancel(ctx, p, lv, slot);
            else if (retry && c.attempts < MAX_CANCEL_ATTEMPTS && (c.status === 'failed'
                || ((c.status === 'unknown' || c.status === 'requested')
                    && ctx.ts - c.sentAt >= CANCEL_UNKNOWN_RETRY_MS))) {
                emitCancel(ctx, p, lv, slot);
            }
        }
    }
}

function cancelFailed(ctx: Ctx, p: OrderProgram, lv: Level, slot: OrderSlot, detail: string) {
    const c = slot.cancel!;
    c.status = 'failed';
    c.outstanding = c.outstanding.filter(k => k !== c.key);
    c.detail = detail;
    notice(ctx, 'cancelFailed', p, lv.id, `${slot.key}: ${detail}`);
    if (c.attempts >= MAX_CANCEL_ATTEMPTS) addIssue(ctx, p, 'cancelGaveUp', `${slot.key}: ${c.attempts} cancel attempts failed`);
}

/** Fire one touch leg (or a user 送出). */
function fire(ctx: Ctx, p: OrderProgram, lv: Level, leg: LegName, price: number): boolean {
    let sent = false;
    if (leg === 'entry') {
        if (lv.entry.type === 'touch') {
            sent = emitPlace(ctx, p, lv, 'entry', 'entry', lv.qty, lv.entry.price, lv.entry.order);
        } else if (lv.entry.type === 'limit') {
            sent = emitPlace(ctx, p, lv, 'entry', 'entry', lv.qty, lv.entry.price, lv.entry.order);
        }
    } else if (leg === 'stop' || leg === 'take') {
        if (lv.exit?.type !== 'oco') return false;
        const qty = Math.min(lv.entryFilled, lv.qty);
        const l = lv.exit[leg];
        sent = emitPlace(ctx, p, lv, 'exit', leg, qty, l?.price ?? null, lv.exit.order);
    }
    if (!sent) return false;
    notice(ctx, 'fired', p, lv.id, `${leg} @${price}`);
    if (p.ocoLevels) {
        for (const other of p.levels) {
            if (other === lv) continue;
            if (other.phase === 'idle' || other.phase === 'needsConfirm') {
                other.phase = 'done';
                other.pending = null;
                other.check = null;
                other.detail = 'ocoCancelled';
            }
        }
    }
    settle(ctx, p, lv);
    return true;
}

/** Grid: place take-profit exits for any entry quantity not yet covered. */
function ensureExits(ctx: Ctx, p: OrderProgram, lv: Level) {
    if (lv.exit?.type !== 'takeProfit') return;
    if (['unknown', 'needsConfirm', 'disabled'].includes(lv.phase)) return;
    if (p.status !== 'running' && p.status !== 'stopping') return;
    const covered = cycleSlots(lv, 'exit').filter(isActive).reduce((sum, o) => sum + Math.max(0, remaining(o)), 0);
    const uncovered = lv.position - covered;
    if (uncovered > 0) emitPlace(ctx, p, lv, 'exit', 'tp', uncovered, lv.exit.price, lv.exit.order);
}

// ---- phase ----

function completeCycle(p: OrderProgram, lv: Level) {
    lv.cycles += 1;
    lv.entryFilled = 0;
    lv.position = 0;
    // keep the just-finished cycle (display, duplicate-deal dedupe); drop older ones
    lv.orders = lv.orders.filter(o => o.cycle >= lv.cycles - 1 || isActive(o) || o.status === 'unknown');
    const again = p.cycle.rearmAfterExit && (p.cycle.maxCycles === null || lv.cycles < p.cycle.maxCycles)
        && p.status === 'running';
    lv.phase = again ? 'idle' : 'done';
}

/** Recompute a level's phase from its slots; sticky phases stay. */
function settle(ctx: Ctx, p: OrderProgram, lv: Level) {
    if (lv.phase === 'needsConfirm' || lv.phase === 'disabled' || lv.phase === 'done') return;
    if (lv.orders.some(o => o.status === 'unknown' && !o.acknowledged)) { lv.phase = 'unknown'; return; }
    const entries = cycleSlots(lv, 'entry');
    const exits = cycleSlots(lv, 'exit');
    const refused = [...entries, ...exits].find(o => o.status === 'notSent');
    if (refused) {
        lv.phase = 'disabled';
        lv.detail = refused.detail ?? 'notSent';
        return;
    }
    const entryActive = entries.some(isActive);
    const exitActive = exits.some(isActive);
    if (lv.exit?.type === 'oco' && exits.length > 0) {
        if (exitActive) lv.phase = 'exiting';
        else if (exits.every(o => o.status === 'filled')) lv.phase = 'done';
        else { lv.phase = 'disabled'; lv.detail = 'exitIncomplete'; }
        return;
    }
    if (exitActive) lv.phase = 'exiting';
    else if (lv.position > 0) lv.phase = 'holding';
    else if (entryActive) lv.phase = 'working';
    else if (lv.entryFilled > 0) completeCycle(p, lv);
    else if (entries.length > 0) {
        // entry ended with nothing filled
        if (p.status === 'stopping' || p.status === 'stopped' || lv.entry.type === 'touch') {
            lv.phase = 'done';
            lv.detail = entries[entries.length - 1]?.detail ?? 'entryEnded';
        } else if (lv.entry.type === 'external') {
            lv.phase = 'done';
            lv.detail = 'entryClosed';
        } else {
            // a grid entry cancelled from outside: freeze instead of resubmitting
            lv.phase = 'disabled';
            lv.detail = 'entryEnded';
        }
    } else lv.phase = 'idle';
    void ctx;
}

function refreshStopping(p: OrderProgram) {
    if (p.status !== 'stopping') return;
    // an unacknowledged unknown submit may be live at the broker: not stopped yet
    const busy = p.levels.some(lv => lv.orders.some(o => isActive(o) || (o.status === 'unknown' && !o.acknowledged))
        || (lv.position > 0 && lv.phase !== 'disabled'));
    if (!busy) p.status = 'stopped';
}

/** The next tick decides for touch legs (#144). */
function markRestore(p: OrderProgram, reason: RestoreReason) {
    for (const lv of p.levels) {
        if (lv.phase === 'needsConfirm') continue;
        const legs = touchLegs(lv).filter(l => !lv.recross.includes(l.name));
        if (legs.length) lv.check = reason;
    }
}

// ---- events ----

function noteActivity(ctx: Ctx, e: Source) {
    const s = ctx.s;
    if (!fromLive(s, e)) return; // a late event of another environment says nothing about this one
    if (s.lastActivity !== null) {
        const gap = ctx.ts - s.lastActivity;
        for (const p of s.programs) {
            if (envMatches(s, p) && gap > p.session.silentStallMs) markRestore(p, 'disconnect');
        }
    }
    s.lastActivity = ctx.ts;
}

function onTick(ctx: Ctx, e: Extract<ExecEvent, { type: 'tick' }>) {
    const s = ctx.s;
    noteActivity(ctx, e);
    if (e.simtrade || !Number.isFinite(e.price) || e.price <= 0 || !fromLive(s, e)) return;
    s.lastPrices[e.code] = e.price;
    // A coalesced tick carries the range of real trade prices since the last
    // one: a leg fires when any price in it touched (a 99 → 101 burst still
    // crosses a stop at 100), and a kept leg re-arms when any price in it was
    // on the other side. Limit entries use the latest price.
    const lo = Math.min(e.price, validPrice(e.low) ?? e.price);
    const hi = Math.max(e.price, validPrice(e.high) ?? e.price);
    const toward = (l: { condition: TouchCondition }) => l.condition === 'below' ? lo : hi;
    const away = (l: { condition: TouchCondition }) => l.condition === 'below' ? hi : lo;
    const touched = (l: { condition: TouchCondition; price: number }) => isPast(l.condition, l.price, toward(l));
    for (const p of s.programs) {
        if (p.binding.contract.quoteCode !== e.code || p.hold !== null) continue;
        if (p.status === 'running') checkBounds(ctx, p, lo, hi);
        if (p.status !== 'running' && p.status !== 'stopping') continue;
        const limitCandidates: Level[] = [];
        for (const lv of p.levels) {
            // entries only fire while running; protective exits also while stopping
            const legs = touchLegs(lv).filter(l => p.status === 'running' || l.name !== 'entry');
            if (legs.length) {
                if (lv.check) {
                    const reason = lv.check;
                    lv.check = null;
                    const past = legs.find(l => !lv.recross.includes(l.name) && touched(l));
                    if (past) {
                        lv.phase = 'needsConfirm';
                        lv.pending = { leg: past.name, price: toward(past), ts: ctx.ts, reason };
                        notice(ctx, 'needsConfirm', p, lv.id, `${past.name} ${reason} @${toward(past)}`);
                        continue;
                    }
                }
                for (const leg of legs) {
                    if (lv.recross.includes(leg.name)) {
                        if (isPast(leg.condition, leg.price, away(leg))) continue; // not re-armed
                        lv.recross = lv.recross.filter(x => x !== leg.name);
                        // the order inside a burst is lost: a range holding both the
                        // re-arm side and the trigger price counts as re-armed AND
                        // re-crossed only for a protective leg (a stop); any other
                        // leg re-arms and waits for a later tick
                        if (!touched(leg) || !protective(p, lv, leg)) continue;
                    }
                    if (touched(leg) && lv.phase !== 'done') { fire(ctx, p, lv, leg.name, toward(leg)); break; }
                }
            } else if (p.status === 'running' && lv.phase === 'idle' && lv.entry.type === 'limit') {
                const eligible = lv.side === 'Buy' ? fixed(e.price) > fixed(lv.entry.price) : fixed(e.price) < fixed(lv.entry.price);
                if (eligible) limitCandidates.push(lv);
            }
        }
        if (limitCandidates.length) {
            const working = p.levels.filter(lv => cycleSlots(lv, 'entry').some(isActive)).length;
            const cap = p.risk.maxWorkingEntries === null ? Infinity : Math.max(0, p.risk.maxWorkingEntries - working);
            const dist = (lv: Level) => Math.abs(fixed(e.price) - fixed(lv.entry.type === 'limit' ? lv.entry.price : e.price));
            const ordered = limitCandidates
                .map((lv, i) => ({ lv, i }))
                .sort((a, b) => dist(a.lv) - dist(b.lv) || a.i - b.i)
                .slice(0, cap === Infinity ? undefined : cap);
            for (const { lv } of ordered) fire(ctx, p, lv, 'entry', e.price);
        }
        for (const lv of p.levels) ensureExits(ctx, p, lv);
        ensureCancels(ctx, p, true);
    }
}

function validPrice(v: number | undefined): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function checkBounds(ctx: Ctx, p: OrderProgram, lo: number, hi: number) {
    const b = p.bounds;
    // every bound the range broke counts; the protective action wins
    const broken: { action: BreakAction; price: number }[] = [];
    if (b.upper !== null && fixed(hi) > fixed(b.upper)) broken.push({ action: b.onBreakUpper, price: hi });
    if (b.lower !== null && fixed(lo) < fixed(b.lower)) broken.push({ action: b.onBreakLower, price: lo });
    const pick = broken.find(x => x.action === 'stop') ?? broken.find(x => x.action === 'pause');
    const action: BreakAction = pick?.action ?? 'none';
    const price = pick?.price ?? 0;
    if (action === 'pause') {
        p.status = 'paused';
        p.pauseReason = 'boundBreak';
        notice(ctx, 'paused', p, null, `bound break @${price}`);
    } else if (action === 'stop') {
        startStop(ctx, p);
        notice(ctx, 'stopping', p, null, `bound break @${price}`);
    }
}

function onConnection(ctx: Ctx, e: ConnectionEvent) {
    const s = ctx.s;
    const before = canEvaluate(s);
    const prevEnv = s.conn.env;
    const prevServer = s.conn.serverId;
    s.conn.live = e.live;
    s.conn.env = e.live ? e.env : null;
    s.conn.serverId = e.live ? e.serverId : null;
    const now = canEvaluate(s);
    if (!now) {
        if (before || s.conn.downSince === null) s.conn.downSince = ctx.ts;
        if (before) s.lastPrices = {};
        updateHolds(ctx);
        return;
    }
    const switched = s.conn.lastEvalEnv !== null
        && (s.conn.lastEvalEnv !== s.conn.env || s.conn.lastEvalServerId !== s.conn.serverId);
    if (switched || prevEnv !== s.conn.env || prevServer !== s.conn.serverId) s.lastPrices = {};
    const downFor = s.conn.downSince === null ? 0 : ctx.ts - s.conn.downSince;
    for (const p of s.programs) {
        if (!envMatches(s, p)) continue;
        if (switched) markRestore(p, 'env');
        else if (!before && downFor > p.session.longDisconnectMs) markRestore(p, 'disconnect');
    }
    s.conn.downSince = null;
    s.conn.lastEvalEnv = s.conn.env;
    s.conn.lastEvalServerId = s.conn.serverId;
    s.lastActivity = ctx.ts;
    updateHolds(ctx);
    // exits deferred while held (grid fills seen during a disconnect) go out now,
    // and cancels a stopping program could not send / confirm are (re)sent
    for (const p of s.programs) {
        if (p.hold !== null) continue;
        for (const lv of p.levels) { ensureExits(ctx, p, lv); settle(ctx, p, lv); }
        ensureCancels(ctx, p, true);
    }
}

/** Result of a place (slot key) or cancel (cancel key), within its source environment only. */
function findSlotByKey(s: EngineState, key: string, src: Source) {
    for (const p of s.programs) {
        if (!boundTo(p, src)) continue;
        for (const lv of p.levels) {
            const slot = lv.orders.find(o => o.key === key);
            if (slot) return { p, lv, slot, cancel: false };
            const c = lv.orders.find(o => o.cancel !== null && (o.cancel.key === key || o.cancel.outstanding.includes(key)));
            if (c) return { p, lv, slot: c, cancel: true };
        }
    }
    return null;
}

/** A report only matches its own environment's programs, its own account
 * and contract, and a binding of the current epoch. */
function findSlotByOrderId(s: EngineState, orderId: string, src: Source,
    account: { brokerId: string; accountId: string } | null | undefined, code: string | undefined,
    securityType: string | undefined) {
    for (const p of s.programs) {
        if (!boundTo(p, src) || !reportMatches(p, account, code, securityType)) continue;
        for (const lv of p.levels) {
            const slot = lv.orders.find(o => !o.unconfirmed && o.orderId === orderId);
            if (slot) return { p, lv, slot };
        }
    }
    return null;
}

/** A report may be matched to a binding only when it is known to belong to the
 * current trade-id epoch: its exchange time (epoch seconds) falls in the
 * current epoch or later. An id is reused across epochs and a report can arrive
 * late — one from before the boundary naming a reused id is another order's.
 * Without an exchange time its epoch cannot be told: held, never applied to a
 * binding (the listing decides). */
function reportInEpoch(mark: number | null | undefined, exchTs: number | null | undefined): boolean {
    if (exchTs === undefined || exchTs === null || !Number.isFinite(exchTs) || exchTs <= 0) return false;
    return mark === undefined || mark === null || epochMark(Math.trunc(exchTs * 1000)) >= mark;
}

/** Apply reports that raced the order id becoming known (deals, then order
 * events) — those of the current epoch only (`reportInEpoch`). */
function drainOrphans(ctx: Ctx, p: OrderProgram, lv: Level, slot: OrderSlot) {
    const s = ctx.s;
    const mine = (e: Source & { orderId: string; account?: { brokerId: string; accountId: string } | null;
        code?: string; securityType?: string }, exchTs: number | undefined) =>
        e.orderId === slot.orderId && reportInEpoch(s.epochMark, exchTs) && boundTo(p, e)
        && reportMatches(p, e.account, e.code, e.securityType);
    const deals = s.orphanDeals.filter(d => mine(d.deal, d.deal.fillTs));
    s.orphanDeals = s.orphanDeals.filter(d => !mine(d.deal, d.deal.fillTs));
    for (const d of deals) applyDeal(ctx, p, lv, slot, d.deal);
    const orders = s.orphanOrders.filter(o => mine(o.order, o.order.exchTs));
    s.orphanOrders = s.orphanOrders.filter(o => !mine(o.order, o.order.exchTs));
    for (const o of orders) applyOrder(ctx, p, lv, slot, o.order);
}

function onIntentResult(ctx: Ctx, e: IntentResultEvent) {
    const hit = findSlotByKey(ctx.s, e.key, e);
    if (!hit) return;
    const { p, lv, slot } = hit;
    if (hit.cancel) {
        const c = slot.cancel!;
        if (c.key !== e.key) {
            // an earlier attempt: a refusal settles it, nothing else changes the current one
            if (e.outcome === 'notSent') c.outstanding = c.outstanding.filter(k => k !== e.key);
            return;
        }
        if (c.status !== 'pendingSubmit') return; // duplicate
        if (e.outcome === 'accepted') c.status = 'requested';
        // refused at the send-time gate across an epoch boundary: never sent —
        // the cancel returns to its slot until this epoch's listing rebinds the id
        else if (e.outcome === 'notSent' && e.detail === EPOCH_CHANGED) {
            c.outstanding = c.outstanding.filter(k => k !== e.key);
            c.status = 'failed';
            c.detail = EPOCH_CHANGED;
        }
        else if (e.outcome === 'notSent') cancelFailed(ctx, p, lv, slot, e.detail ?? 'notSent');
        else { c.status = 'unknown'; c.detail = e.detail ?? 'unknown'; }
        refreshStopping(p);
        return;
    }
    if (slot.status !== 'pendingSubmit') return; // duplicate or stale result
    if (e.outcome === 'accepted' && e.orderId && e.epoch !== undefined && e.epoch !== (ctx.s.epochSeq ?? 0)) {
        // sent in an earlier epoch, answered after the boundary: the id may
        // name another order by now — only this epoch's listing with the
        // slot's tag confirms (rebinds) it
        slot.orderId = e.orderId;
        slot.unconfirmed = true;
        slot.status = 'working';
        slot.detail = 'acceptedAcrossEpoch';
    } else if (e.outcome === 'accepted' && e.orderId) {
        slot.orderId = e.orderId;
        slot.status = slot.filled >= slot.qty ? 'filled' : 'working';
        drainOrphans(ctx, p, lv, slot);
    } else if (e.outcome === 'notSent') {
        slot.status = 'notSent';
        slot.detail = e.detail ?? 'notSent';
        notice(ctx, 'notSent', p, lv.id, slot.detail);
    } else {
        slot.status = 'unknown';
        slot.detail = e.detail ?? 'unknown';
        notice(ctx, 'unknown', p, lv.id, slot.detail);
    }
    ensureExits(ctx, p, lv);
    settle(ctx, p, lv);
    ensureCancels(ctx, p, false); // an entry accepted after stop must be cancelled too
    refreshStopping(p);
}

const remaining = (slot: OrderSlot) => slot.qty - slot.filled - (slot.cancelled ?? 0);

/** Record the quantity a report cancelled (once per report id). */
function noteCancelled(slot: OrderSlot, e: OrderEvent) {
    if (e.failed || e.cancelQty === undefined || !(e.cancelQty > 0)) return;
    slot.cancels = slot.cancels ?? {};
    const id = e.reportId ?? `anon:${Object.keys(slot.cancels).length}`;
    if (id in slot.cancels) return;
    slot.cancels[id] = e.cancelQty;
    refreshCancelled(slot);
}

/** Cancelled quantity = max(listing's cumulative, sum of report deltas) —
 * never their sum: a report may be one the listing already counted (their
 * timestamps cannot be ordered: a report's exchange ts can be later than
 * the listing's modified ts for the same operation). Under doubt this
 * UNDER-counts: the order still looks working, so no extra exit is placed;
 * the next listing corrects it. */
function refreshCancelled(slot: OrderSlot) {
    const reported = Object.values(slot.cancels ?? {}).reduce((a, b) => a + b, 0);
    slot.cancelled = Math.max(slot.listedCancelled ?? 0, reported);
}

/** Fills + cancels cover the order: nothing works at the broker any more. */
function closeIfCovered(slot: OrderSlot, detail: string): boolean {
    if (!isActive(slot) || !(slot.cancelled ?? 0) || remaining(slot) > 0) return false;
    slot.status = slot.filled >= slot.qty ? 'filled' : 'ended';
    if (slot.status === 'ended') slot.detail = detail;
    if (slot.cancel) { slot.cancel.status = 'confirmed'; slot.cancel.outstanding = []; }
    return true;
}

function applyOrder(ctx: Ctx, p: OrderProgram, lv: Level, slot: OrderSlot, e: OrderEvent) {
    noteCancelled(slot, e);
    if (e.op === 'Cancel') {
        if (e.failed) {
            const c = slot.cancel;
            if (!c || c.status === 'confirmed' || c.status === 'failed' || !isActive(slot)) return;
            if (e.cancelKey) {
                c.outstanding = c.outstanding.filter(k => k !== e.cancelKey); // that attempt is settled
                if (e.cancelKey === c.key) cancelFailed(ctx, p, lv, slot, e.detail ?? 'cancelFailed');
                return; // else: a stale attempt's failure
            }
            if (c.outstanding.length === 1 && c.outstanding[0] === c.key) {
                // only one attempt could have failed: the current one
                cancelFailed(ctx, p, lv, slot, e.detail ?? 'cancelFailed');
                return;
            }
            // cannot tell which attempt failed: the current one's fate is unknown
            // (never left `requested`; retried after the timeout unless settled)
            c.status = 'unknown';
            c.detail = e.detail ?? 'unkeyedCancelFailure';
            addIssue(ctx, p, 'cancelReportUnkeyed', `${slot.key}: Cancel failure without attempt key, ${c.outstanding.length} attempts outstanding`);
            return;
        }
        if (e.cancelQty !== undefined && isActive(slot) && remaining(slot) > 0) {
            // part of the order is still working at the broker: not ended;
            // the cancel is retried after the timeout
            if (slot.cancel) { slot.cancel.status = 'unknown'; slot.cancel.detail = 'partialCancel'; slot.cancel.outstanding = []; }
            addIssue(ctx, p, 'partialCancel', `${slot.key}: cancelled ${slot.cancelled ?? 0}, filled ${slot.filled} of ${slot.qty}`);
            return;
        }
        if (slot.cancel) { slot.cancel.status = 'confirmed'; slot.cancel.outstanding = []; }
    }
    // e.g. UpdateQty reduced the rest away
    if (closeIfCovered(slot, e.op === 'Cancel' ? 'cancelled' : 'reduced')) return;
    const ended = (e.op === 'New' && e.failed) || (e.op === 'Cancel' && !e.failed);
    if (!ended || !isActive(slot)) return;
    slot.status = slot.filled >= slot.qty ? 'filled' : 'ended';
    if (slot.status === 'ended') slot.detail = e.detail ?? (e.failed ? 'failed' : 'cancelled');
}

function onOrder(ctx: Ctx, e: OrderEvent) {
    const hit = reportInEpoch(ctx.s.epochMark, e.exchTs)
        ? findSlotByOrderId(ctx.s, e.orderId, e, e.account, e.code, e.securityType) : null;
    if (!hit) {
        // e.g. a New failure reported before the submit result: keep it for the binding
        ctx.s.orphanOrders.push({ order: e, ts: ctx.ts });
        if (ctx.s.orphanOrders.length > ORPHAN_ORDER_LIMIT) ctx.s.orphanOrders.splice(0, ctx.s.orphanOrders.length - ORPHAN_ORDER_LIMIT);
        return;
    }
    const { p, lv, slot } = hit;
    applyOrder(ctx, p, lv, slot, e);
    ensureExits(ctx, p, lv); // a reduced / ended exit leaves position uncovered
    settle(ctx, p, lv);
    refreshStopping(p);
}

const SAME_TS = 1e-6;
/** Port of bracket-core `mergeFill`: one identity per real fill. */
export function mergeFill(slot: OrderSlot, key: string, qty: number, ts: number | undefined):
    { added: number; conflict: boolean } | null {
    if (slot.fills[key] !== undefined) return null;
    const isEvent = (k: string) => k.startsWith('event:');
    const sameFill = (k: string) => slot.fills[k] === qty && ts !== undefined
        && slot.fillTs[k] !== undefined && Math.abs(slot.fillTs[k]! - ts) < SAME_TS;
    const counterpart = Object.keys(slot.fills).find(k => isEvent(k) !== isEvent(key) && sameFill(k));
    if (counterpart) {
        if (isEvent(key)) return null;
        delete slot.fills[counterpart];
        delete slot.fillTs[counterpart];
        slot.fills[key] = qty;
        if (ts !== undefined) slot.fillTs[key] = ts;
        return { added: 0, conflict: false };
    }
    const conflict = Object.keys(slot.fills).some(k => isEvent(k) !== isEvent(key) && slot.fills[k] === qty);
    slot.fills[key] = qty;
    if (ts !== undefined) slot.fillTs[key] = ts;
    return { added: qty, conflict };
}

function applyFill(ctx: Ctx, p: OrderProgram, lv: Level, slot: OrderSlot, key: string, qty: number, ts: number | undefined) {
    const merged = mergeFill(slot, key, qty, ts);
    if (!merged) return;
    if (merged.conflict) addIssue(ctx, p, 'fillConflict', `${slot.key}: event-only fill may duplicate a seq fill`);
    const added = merged.added;
    if (added <= 0) return;
    slot.filled += added;
    if (slot.filled >= slot.qty && (slot.status === 'working' || slot.status === 'ended')) slot.status = 'filled';
    else closeIfCovered(slot, 'reduced'); // the rest was cancelled / reduced earlier
    if (slot.role === 'entry') {
        if (slot.cycle !== lv.cycles) { addIssue(ctx, p, 'lateFill', `${slot.key}: fill after its cycle ended`); return; }
        lv.entryFilled += added;
        if (lv.entryFilled > lv.qty) addIssue(ctx, p, 'overfill', `${lv.id}: filled ${lv.entryFilled} > ${lv.qty}`);
        if (exitFired(lv)) lv.unprotected += added;
        else if (lv.exit !== null) {
            const was = lv.position;
            lv.position += added;
            // protection armed while nobody evaluated yet: first tick decides (#144)
            if (was === 0 && lv.exit.type === 'oco' && ctx.s.lastActivity === null) lv.check = 'restart';
        }
    } else {
        lv.position -= added;
    }
    notice(ctx, 'fill', p, lv.id, `${slot.key} +${added}`);
}

function applyDeal(ctx: Ctx, p: OrderProgram, lv: Level, slot: OrderSlot, d: DealEvent) {
    const b = p.binding;
    if (d.account && (d.account.brokerId !== b.account.brokerId || d.account.accountId !== b.account.accountId)) return;
    if (!d.account) { addIssue(ctx, p, 'reportMismatch', `${d.orderId}: deal without account`); return; }
    if (d.code !== b.contract.orderCode) { addIssue(ctx, p, 'reportMismatch', `${d.orderId}: code ${d.code}`); return; }
    const expected = slot.role === 'entry' ? lv.side : opposite(lv.side);
    if (d.action !== expected) { addIssue(ctx, p, 'reportMismatch', `${d.orderId}: action ${d.action}`); return; }
    if (!Number.isSafeInteger(d.qty) || d.qty <= 0) { addIssue(ctx, p, 'reportMismatch', `${d.orderId}: qty ${d.qty}`); return; }
    let key: string;
    if (d.seq) key = `${d.orderId}:${d.seq}`;
    else if (d.eventId) {
        key = `event:${d.eventId}`;
        if (slot.fills[key] === undefined) addIssue(ctx, p, 'eventOnlyFill', `${d.orderId}: deal without exchange seq`);
    } else { addIssue(ctx, p, 'reportMismatch', `${d.orderId}: deal without seq nor event id`); return; }
    applyFill(ctx, p, lv, slot, key, d.qty, d.fillTs);
}

function onDeal(ctx: Ctx, e: DealEvent) {
    const hit = reportInEpoch(ctx.s.epochMark, e.fillTs)
        ? findSlotByOrderId(ctx.s, e.orderId, e, e.account, e.code, e.securityType) : null;
    if (!hit) {
        ctx.s.orphanDeals.push({ deal: e, ts: ctx.ts });
        if (ctx.s.orphanDeals.length > ORPHAN_DEAL_LIMIT) ctx.s.orphanDeals.splice(0, ctx.s.orphanDeals.length - ORPHAN_DEAL_LIMIT);
        return;
    }
    const { p, lv, slot } = hit;
    applyDeal(ctx, p, lv, slot, e);
    ensureExits(ctx, p, lv);
    settle(ctx, p, lv);
    refreshStopping(p);
}

function onReconcile(ctx: Ctx, e: ReconcileEvent) {
    // this epoch's listing of the account is in: it may place / cancel again
    const waiting = (ctx.s.conn.awaitingEpochListing ?? []).filter(a => !sameAccount(a, e.account));
    if (waiting.length > 0) ctx.s.conn.awaitingEpochListing = waiting;
    else delete ctx.s.conn.awaitingEpochListing;
    for (const p of ctx.s.programs) {
        const b = p.binding;
        if (b.env !== e.env || b.serverId !== e.serverId || b.account.accountType !== e.account.accountType
            || b.account.brokerId !== e.account.brokerId || b.account.accountId !== e.account.accountId) continue;
        for (const lv of p.levels) {
            let touched = false;
            for (const slot of lv.orders) {
                // a listing row carries this slot's tag but cannot be bound to
                // it: the order may exist — pinned for good, never concluded
                if ((e.ambiguous ?? []).includes(slot.key) && !slot.tagAmbiguous) {
                    slot.tagAmbiguous = true;
                    addIssue(ctx, p, 'tagAmbiguous', `${slot.key}: duplicate / mismatching listing rows for its tag`);
                }
                // ended before this listing (not by a report drained just now)
                const wasEnded = slot.status === 'ended';
                const external = isExternalEntry(lv, slot);
                // The wire mapper verifies either the tag or the external
                // broker identity. A trade id alone never accepts a row.
                const rows = e.orders.filter(o => o.intentKey === slot.key
                    && (slot.unconfirmed || !slot.orderId || o.orderId === slot.orderId));
                const row = rows.length === 1 ? rows[0] : undefined;
                if (slot.unconfirmed) {
                    // bound in an earlier epoch: only this epoch's row with its
                    // tag rebinds it — an ended slot never takes part again
                    const open = isActive(slot) || (slot.status === 'unknown' && !slot.acknowledged);
                    if (!open) continue;
                    if (external && externalEntryPending(lv)?.reason === 'unknownEntryAcrossDay') continue;
                    if (row) {
                        rebindSlot(slot, row.orderId);
                        slot.unconfirmed = false;
                        if (slot.status === 'unknown') slot.status = 'working';
                        slot.detail = 'rebound';
                        if (external && externalEntryPending(lv)?.reason === 'unknownEntryAfterReconnect') {
                            clearEntryPending(lv);
                            if (lv.phase === 'needsConfirm' && !lv.pending) lv.phase = lv.position > 0 ? 'holding' : 'working';
                        }
                        drainOrphans(ctx, p, lv, slot);
                        touched = true;
                    } else if (external) {
                        if (!externalEntryPending(lv)) {
                            lv.entryPending = { leg: 'entry', price: null, ts: ctx.ts, reason: 'unknownEntryAfterReconnect' };
                            if (lv.position === 0) lv.phase = 'needsConfirm';
                            notice(ctx, 'needsConfirm', p, lv.id, 'entry unknownEntryAfterReconnect');
                            touched = true;
                        }
                        continue;
                    } else if (isActive(slot) && (e.notSent ?? []).includes(slot.key)) {
                        // absent from this epoch's listings: what became of it is
                        // unknown — the user acknowledges it
                        slot.status = 'unknown';
                        slot.detail = 'missingAfterEpoch';
                        notice(ctx, 'unknown', p, lv.id, `${slot.key} missingAfterEpoch`);
                        touched = true;
                        continue;
                    } else continue;
                }
                if (slot.status === 'pendingSubmit' && !slot.orderId && row) {
                    // the listing answered before the submit result did
                    slot.orderId = row.orderId;
                    slot.status = 'working';
                    drainOrphans(ctx, p, lv, slot);
                } else if (slot.status === 'unknown' && !slot.acknowledged) {
                    if (row) {
                        slot.orderId = row.orderId;
                        slot.status = 'working';
                        slot.detail = 'reconciled';
                        drainOrphans(ctx, p, lv, slot);
                    } else if ((e.complete || (e.notSent ?? []).includes(slot.key)) && !slot.tagAmbiguous) {
                        slot.status = 'notSent';
                        slot.detail = 'reconciledNotSent';
                        // confirmed never accepted: the user decides whether to send now
                        lv.orders = lv.orders.filter(o => o !== slot);
                        lv.phase = 'needsConfirm';
                        lv.pending = { leg: slot.leg, price: ctx.s.lastPrices[b.contract.quoteCode] ?? null, ts: ctx.ts,
                            reason: 'unknownNotSent' };
                        notice(ctx, 'needsConfirm', p, lv.id, `${slot.leg} unknownNotSent`);
                        touched = true;
                        continue;
                    } else continue;
                    touched = true;
                }
                if (!row || !slot.orderId) continue;
                // cumulative values only ever grow (a listing adds, never downgrades)
                if (row.cancelled !== undefined) {
                    slot.listedCancelled = Math.max(slot.listedCancelled ?? 0, row.cancelled);
                    refreshCancelled(slot);
                }
                // a stale row (a report of this order is newer than the listing
                // request) never revives: only a listing newer than every report may
                if (!row.stale && wasEnded && slot.status === 'ended' && !slot.acknowledged && row.status === 'working'
                    && slot.qty - slot.filled - (row.cancelled ?? 0) > 0) {
                    // the listing shows it working: the reports that ended it are
                    // taken as absorbed by the listing (kept for dedupe, count 0)
                    for (const id of Object.keys(slot.cancels ?? {})) slot.cancels![id] = 0;
                    refreshCancelled(slot);
                    // the broker still works it (e.g. a cancel that did not take
                    // effect): back to working, and a stopped program is
                    // stopping again until it is cancelled
                    slot.status = 'working';
                    slot.detail = 'reconciledWorking';
                    if (slot.cancel) { slot.cancel.status = 'unknown'; slot.cancel.detail = 'stillWorking'; slot.cancel.outstanding = []; }
                    if (lv.phase === 'done' || lv.phase === 'disabled') lv.phase = 'idle';
                    if (p.status === 'stopped') p.status = 'stopping';
                    addIssue(ctx, p, 'revived', `${slot.key}: still working at the broker`);
                }
                for (const d of row.deals) {
                    if (Number.isSafeInteger(d.qty) && d.qty > 0) {
                        applyFill(ctx, p, lv, slot, `${row.orderId}:${d.seq}`, d.qty, d.ts);
                    }
                }
                closeIfCovered(slot, 'reconciledEnded');
                if (isActive(slot) && row.status !== 'working') {
                    slot.status = slot.filled >= slot.qty ? 'filled' : 'ended';
                    if (slot.status === 'ended') slot.detail = 'reconciledEnded';
                    if (slot.cancel) { slot.cancel.status = 'confirmed'; slot.cancel.outstanding = []; }
                }
                touched = true;
            }
            if (touched) {
                if (lv.phase === 'unknown') lv.phase = 'idle';
                ensureExits(ctx, p, lv);
                settle(ctx, p, lv);
            }
        }
        ensureCancels(ctx, p, false);
        refreshStopping(p);
    }
}

/** A new trade-id epoch on (env, server): every id bound before stops
 * identifying its order (`unconfirmed`); reports buffered for such ids are
 * dropped. A slot still open is rebound by the next listing through its tag.
 * An external entry rebinds by verified broker identity within the same
 * trading epoch; across a boundary the user still confirms it (decision A). */
function onEpoch(ctx: Ctx, e: EpochEvent) {
    const s = ctx.s;
    const mark = epochMark(ctx.ts);
    const crossed = s.epochMark !== mark;
    s.epochMark = mark;
    s.epochSeq = (s.epochSeq ?? 0) + 1;
    // live for reports, but nothing goes out for an account until this
    // epoch's first listing of it has been applied
    const waiting: AccountKey[] = [];
    for (const p of s.programs) {
        if (boundTo(p, e) && !waiting.some(a => sameAccount(a, p.binding.account))) waiting.push(p.binding.account);
    }
    if (waiting.length > 0) s.conn.awaitingEpochListing = waiting;
    else delete s.conn.awaitingEpochListing;
    s.orphanDeals = s.orphanDeals.filter(d => !boundToSource(d.deal, e));
    s.orphanOrders = s.orphanOrders.filter(o => !boundToSource(o.order, e));
    for (const p of s.programs) {
        if (!boundTo(p, e)) continue;
        for (const lv of p.levels) {
            const external = lv.entry.type === 'external';
            let openEntry = false;
            for (const slot of lv.orders) {
                if (external && slot.role === 'entry') {
                    openEntry ||= crossed && isActive(slot);
                }
                if (slot.orderId) slot.unconfirmed = true;
            }
            if (openEntry) {
                lv.entryPending = { leg: 'entry', price: null, ts: ctx.ts, reason: 'unknownEntryAcrossDay' };
                if (unknownExternalEntry(lv.pending?.reason)) lv.pending = null;
                // nothing known filled: wait for the user; a known position
                // keeps its protection meanwhile (the phase stays)
                if (lv.position === 0 && lv.phase !== 'needsConfirm') lv.phase = 'needsConfirm';
                notice(ctx, 'needsConfirm', p, lv.id, 'entry unknownEntryAcrossDay');
            }
        }
    }
}

const boundToSource = (a: Source, b: Source) => a.env === b.env && a.serverId === b.serverId;

function onRestore(ctx: Ctx) {
    const s = ctx.s;
    s.conn = { ...s.conn, live: false, env: null, serverId: null, downSince: ctx.ts };
    s.lastActivity = null;
    s.lastPrices = {};
    for (const p of s.programs) {
        for (const lv of p.levels) {
            for (const slot of lv.orders) {
                if (slot.status === 'pendingSubmit') {
                    slot.status = 'unknown';
                    slot.detail = 'restart: submit outcome unknown';
                }
                // a cancel may or may not have left: resend it once live again (cancels are safe to repeat)
                if (slot.cancel?.status === 'pendingSubmit') slot.cancel.status = 'unknown';
            }
            settle(ctx, p, lv);
        }
        markRestore(p, 'restart');
    }
    updateHolds(ctx);
}

// ---- commands ----

function reject(ctx: Ctx, p: OrderProgram | null, code: string, detail: string) {
    notice(ctx, `rejected.${code}`, p, null, detail);
}

/** Most levels a program may have (the grid ticket offers 15). */
export const MAX_LEVELS = 32;

function validateProgram(p: OrderProgram): string | null {
    if (!p.id || !p.binding?.serverId || !p.binding.account?.accountId || !p.binding.contract?.orderCode) return 'invalidBinding';
    if (p.binding.env !== 'simulation' && p.binding.env !== 'production') return 'invalidBinding';
    if (!Array.isArray(p.levels) || p.levels.length === 0) return 'noLevels';
    // bounds what a crash can leave unrecorded (Rust executor's suspicion)
    if (p.levels.length > MAX_LEVELS) return 'tooManyLevels';
    if (p.hooks.length > 0) return 'hooksUnsupported';
    const ids = new Set<string>();
    for (const lv of p.levels) {
        if (!lv.id || ids.has(lv.id)) return 'duplicateLevel';
        ids.add(lv.id);
        if (!Number.isSafeInteger(lv.qty) || lv.qty <= 0) return 'invalidQty';
    }
    return null;
}

function startStop(ctx: Ctx, p: OrderProgram) {
    p.status = 'stopping';
    for (const lv of p.levels) {
        if (lv.phase === 'idle' || lv.phase === 'needsConfirm') {
            lv.phase = 'done';
            lv.pending = null;
            lv.check = null;
            lv.detail = 'stopped';
            continue;
        }
    }
    ensureCancels(ctx, p, false);
    refreshStopping(p);
}

/** Do `a` and `b` track the same external entry order: an order id within one
 * (environment, account, market, contract)? */
export function sameExternalEntry(a: OrderProgram, b: OrderProgram): boolean {
    const entries = (p: OrderProgram) =>
        p.levels.flatMap(lv => lv.entry.type === 'external' ? [{ ...lv.entry, confirmed: !lv.orders.some(o => o.role === 'entry' && o.unconfirmed) }] : []);
    const [ba, bb] = [a.binding, b.binding];
    if (ba.env !== bb.env || ba.serverId !== bb.serverId || !sameAccount(ba.account, bb.account)
        || ba.contract.market !== bb.contract.market || ba.contract.securityType !== bb.contract.securityType
        || ba.contract.orderCode !== bb.contract.orderCode) return false;
    const theirs = entries(b);
    return entries(a).some(ea => theirs.some(eb => externalIdentity(ea, eb) !== 'different'));
}

function onCommand(ctx: Ctx, e: CommandEvent) {
    const s = ctx.s;
    const c = e.command;
    if (c.op === 'create') {
        const p: OrderProgram = structuredClone(c.program);
        if (s.programs.some(x => x.id === p.id)) { reject(ctx, null, 'duplicateProgram', p.id); return; }
        const invalid = validateProgram(p);
        if (invalid) { reject(ctx, null, invalid, p.id); return; }
        // one live program per external entry order: two would each reconcile
        // the same fills and each send a full-size exit
        const other = s.programs.find(x => x.status !== 'stopped' && sameExternalEntry(x, p));
        if (other) { reject(ctx, null, 'duplicateEntry', `${p.id} (${other.id})`); return; }
        if (!canEvaluate(s)) { reject(ctx, null, 'unknownEnv', p.id); return; }
        if (s.conn.env !== p.binding.env || s.conn.serverId !== p.binding.serverId) { reject(ctx, null, 'envMismatch', p.id); return; }
        p.version = 1;
        p.status = 'running';
        p.pauseReason = null;
        p.createdAt = ctx.ts;
        p.updatedAt = ctx.ts;
        p.hold = null;
        for (const lv of p.levels) {
            if (lv.entry.type === 'external') for (const slot of lv.orders) {
                if (slot.role === 'entry' && slot.orderId) slot.unconfirmed = true;
            }
        }
        s.programs.push(p);
        // a program created now belongs to the current epoch (a new
        // partition has seen no epoch event yet)
        s.epochMark ??= epochMark(ctx.ts);
        updateHolds(ctx);
        notice(ctx, 'created', p, null, p.kind);
        return;
    }
    const p = s.programs.find(x => x.id === c.programId);
    if (!p) { reject(ctx, null, 'noProgram', c.programId); return; }
    if (c.version !== p.version) { reject(ctx, p, 'staleVersion', `${c.version} != ${p.version}`); return; }
    const accept = () => { p.version += 1; p.updatedAt = ctx.ts; };
    switch (c.op) {
        case 'pause':
            if (p.status !== 'running') { reject(ctx, p, 'notRunning', p.status); return; }
            p.status = 'paused';
            p.pauseReason = 'user';
            accept();
            return;
        case 'resume':
            if (p.status !== 'paused') { reject(ctx, p, 'notPaused', p.status); return; }
            p.status = 'running';
            p.pauseReason = null;
            markRestore(p, 'resume');
            accept();
            for (const lv of p.levels) ensureExits(ctx, p, lv);
            return;
        case 'stop':
            if (p.status === 'stopping' || p.status === 'stopped') { reject(ctx, p, 'alreadyStopped', p.status); return; }
            accept();
            startStop(ctx, p);
            return;
        case 'remove': {
            const busy = p.levels.some(lv => lv.orders.some(o => isActive(o) || (o.status === 'unknown' && !o.acknowledged))
                || lv.position > 0);
            if (busy) { reject(ctx, p, 'hasOrdersOrPosition', p.id); return; }
            s.programs = s.programs.filter(x => x !== p);
            notice(ctx, 'removed', p, null, p.id);
            return;
        }
        case 'ackUnknown': {
            const lv = p.levels.find(l => l.id === c.levelId);
            if (!lv || lv.phase !== 'unknown') { reject(ctx, p, 'notUnknown', c.levelId); return; }
            for (const slot of lv.orders) {
                if (slot.status === 'unknown') { slot.acknowledged = true; slot.status = 'ended'; }
            }
            lv.phase = 'disabled';
            lv.detail = 'unknownAcknowledged';
            accept();
            refreshStopping(p);
            return;
        }
        case 'confirmEntry': {
            // a remainder may still work: ending it here would leave its later
            // fills without an exit — the user cancels it first
            if (c.noRemainder !== true) { reject(ctx, p, 'remainderNotConfirmed', c.levelId); return; }
            const lv = p.levels.find(l => l.id === c.levelId && externalEntryPending(l));
            if (!lv) { reject(ctx, p, 'notPending', c.levelId); return; }
            const slot = [...lv.orders].reverse().find(o => o.role === 'entry' && o.cycle === lv.cycles);
            if (!slot) { reject(ctx, p, 'noEntry', c.levelId); return; }
            if (!Number.isSafeInteger(c.filled) || c.filled < slot.filled || c.filled > slot.qty) {
                reject(ctx, p, 'invalidQty', `${c.filled}`);
                return;
            }
            if (c.filled > slot.filled) applyFill(ctx, p, lv, slot, `confirmed:${ctx.ts}`, c.filled - slot.filled, undefined);
            if (isActive(slot)) slot.status = slot.filled >= slot.qty ? 'filled' : 'ended';
            slot.detail = 'confirmedAcrossDay';
            clearEntryPending(lv);
            if (lv.phase === 'needsConfirm' && !lv.pending) lv.phase = 'working';
            accept();
            ensureExits(ctx, p, lv);
            settle(ctx, p, lv);
            refreshStopping(p);
            return;
        }
        case 'resolvePending': {
            const lv = p.levels.find(l => l.id === c.levelId);
            if (lv && !lv.pending && externalEntryPending(lv)) { reject(ctx, p, 'confirmEntry', c.levelId); return; }
            if (!lv || lv.phase !== 'needsConfirm' || !lv.pending) { reject(ctx, p, 'notPending', c.levelId); return; }
            // only the user's fill quantity settles it (confirmEntry)
            if (unknownExternalEntry(lv.pending.reason)) { reject(ctx, p, 'confirmEntry', c.levelId); return; }
            const leg = lv.pending.leg;
            if (c.choice === 'keep') {
                lv.pending = null;
                lv.phase = restPhase(lv);
                if (legOf(lv, leg)) lv.recross = [...lv.recross.filter(x => x !== leg), leg];
                accept();
                return;
            }
            if (c.choice === 'cancel') {
                if (lv.exit?.type === 'oco' && leg !== 'entry') { reject(ctx, p, 'bracketCancel', lv.id); return; }
                lv.pending = null;
                lv.phase = 'done';
                lv.detail = 'cancelled';
                accept();
                refreshStopping(p);
                return;
            }
            if (!envMatches(s, p) || p.hold !== null) { reject(ctx, p, 'envMismatch', lv.id); return; }
            const last = s.lastPrices[p.binding.contract.quoteCode];
            if (last === undefined) { reject(ctx, p, 'noPrice', lv.id); return; }
            const l = legOf(lv, leg);
            if (l && !isPast(l.condition, l.price, last) && !c.allowUnpast) { reject(ctx, p, 'unpast', `${last}`); return; }
            lv.pending = null;
            lv.phase = restPhase(lv);
            accept();
            if (!fire(ctx, p, lv, leg, last)) reject(ctx, p, 'notFired', lv.id);
            return;
        }
    }
}

/** Phase a level returns to when it leaves needsConfirm. */
function restPhase(lv: Level): Level['phase'] {
    if (lv.position > 0) return 'holding';
    return 'idle';
}

// ---- entry point ----

export function step(state: EngineState, event: ExecEvent): StepResult {
    const s: EngineState = structuredClone(state);
    const ctx: Ctx = { s, intents: [], notices: [], ts: event.ts };
    switch (event.type) {
        case 'tick': onTick(ctx, event); break;
        case 'heartbeat': noteActivity(ctx, event); break;
        case 'connection': onConnection(ctx, event); break;
        case 'intentResult': onIntentResult(ctx, event); break;
        case 'order': onOrder(ctx, event); break;
        case 'deal': onDeal(ctx, event); break;
        // a listing requested in another epoch: its ids may name other
        // orders now — it confirms nothing
        case 'reconcile': if (event.epoch === undefined || event.epoch === (s.epochSeq ?? 0)) onReconcile(ctx, event); break;
        case 'restore': onRestore(ctx); break;
        case 'epoch': onEpoch(ctx, event); break;
        case 'command': onCommand(ctx, event); break;
    }
    // time advanced on the live connection: cancel retries / timeouts run for
    // every program, not only those whose symbol ticked (a halted or quiet
    // symbol must not leave a working order uncancelled)
    if ((event.type === 'tick' || event.type === 'heartbeat') && fromLive(s, event)) {
        for (const p of s.programs) if (p.hold === null) ensureCancels(ctx, p, true);
    }
    for (const p of s.programs) refreshStopping(p);
    updateHolds(ctx);
    return { state: s, intents: ctx.intents, notices: ctx.notices };
}
