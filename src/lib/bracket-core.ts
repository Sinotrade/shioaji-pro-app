// src/lib/bracket-core.ts — pure state transitions for bracket (停損停利)
// protection plans (#102). No I/O: the runtime in bracket.ts feeds it
// de-duplicated order/deal reports, cache-only Trade lookups and explicit
// reconciliation results.
//
// Invariants:
// - a plan is bound to ONE environment (API base) and ONE account for life;
//   reports/trades from another account never count;
// - fills accumulate per fill identity (`<orderId>:<exchange_seq>`), so
//   the same fill seen through SSE and through the Trade cache counts once;
//   an event without exchange_seq is only keyed by its full event_id and
//   flagged, because it cannot be matched against the cache;
// - an order missing from the cache is never treated as filled/cancelled;
// - anything that could hide a report (disconnect, sequence gap, cache
//   health not Healthy, no baseline continuity, reload, unmatched metadata)
//   adds an issue — protection
//   is shown as NOT confirmed until an explicit reconciliation clears it;
// - fills after an exit was dispatched, or an exit that did not fully fill,
//   become explicit unprotected quantity. Nothing here resends orders.

import type { OrderEventReport } from './order-report';
import { reportBody } from './portfolio-projection';
import type { Action, Trade } from './types/order';

export interface AccountRef {
    account_type: 'S' | 'F';
    broker_id: string;
    account_id: string;
}

export const accountRefKey = (a: AccountRef) => `${a.account_type}:${a.broker_id}:${a.account_id}`;

export type BracketIssueCode =
    | 'disconnect' // SSE dropped while the plan was live
    | 'gap' // event_id sequence gap on this market's stream
    | 'untrackable' // report without a supported event_id
    | 'cache-degraded' // trade_cache_health Degraded
    | 'not-subscribed' // trade_cache_health NotSubscribed
    | 'reload' // app restarted while the plan was live
    | 'lookup-failed' // cache/refresh lookup failed or trade not found
    | 'no-baseline' // cache-only read without an authoritative, continuous baseline
    | 'report-mismatch' // report for this order with wrong account/code/action or no fill identity
    | 'overfill'; // fills exceed the entry quantity

export interface BracketIssue {
    code: BracketIssueCode;
    detail: string;
    at: number;
}

export type ExitStatus =
    | 'sending' // dispatch in flight
    | 'working' // broker accepted, waiting for fills
    | 'filled' // exit fills cover its quantity
    | 'incomplete' // exit ended (cancel/fail) with unfilled quantity
    | 'not-sent' // refused before any broker request
    | 'unknown'; // request outcome unknown — never auto-resent

export interface BracketExit {
    status: ExitStatus;
    kind: 'stop' | 'take';
    quantity: number; // requested exit quantity
    filled: number;
    fills: Record<string, number>;
    orderId?: string;
    detail?: string;
    acknowledged?: boolean; // user confirmed an unknown outcome by hand
    at: number;
}

export interface BracketPlan {
    id: string;
    env: string;
    account: AccountRef;
    market: 'stock' | 'futures';
    orderId: string;
    seqno: string;
    quoteCode: string; // quote-stream code (e.g. TXFR1 alias)
    orderCode: string; // tradable code reported by the broker (e.g. TXFJ6)
    securityType: 'STK' | 'FUT' | 'OPT';
    exchange: string;
    action: Action; // entry direction
    quantity: number; // entry quantity (lots / contracts)
    stopPrice: number | null;
    takePrice: number | null;
    group: string; // OCO group id of the protection triggers
    fills: Record<string, number>;
    filled: number;
    entryClosed: boolean;
    exit: BracketExit | null;
    issues: BracketIssue[];
    dismissed?: boolean;
    createdAt: number;
    updatedAt: number;
}

export type BracketPhase = 'waiting' | 'protected' | 'exiting' | 'done' | 'closed';

export function bracketPhase(p: BracketPlan): BracketPhase {
    if (p.exit) {
        if (p.exit.status === 'sending' || p.exit.status === 'working') return 'exiting';
        return 'done';
    }
    if (p.filled > 0) return 'protected';
    return p.entryClosed ? 'closed' : 'waiting';
}

/** Live = still needs reports: waiting for fills, protecting, or exiting. */
export function isLive(p: BracketPlan): boolean {
    const phase = bracketPhase(p);
    return phase === 'waiting' || phase === 'protected' || phase === 'exiting'
        || (phase === 'done' && p.exit?.status === 'unknown' && !p.exit.acknowledged);
}

/** Quantity the OCO triggers should hold right now. */
export function protectionQuantity(p: BracketPlan): number {
    if (p.exit) return 0;
    return Math.min(p.filled, p.quantity);
}

/** Filled entry quantity no longer covered: late fills after an exit was
 * dispatched, a capped/refused exit, or an exit that ended unfilled. An
 * `unknown` exit counts as covering its quantity but is flagged separately. */
export function unprotectedQuantity(p: BracketPlan): number {
    if (!p.exit) return 0;
    const counted = p.exit.status === 'not-sent' ? 0
        : p.exit.status === 'incomplete' ? p.exit.filled : p.exit.quantity;
    return Math.max(0, Math.min(p.filled, p.quantity) - counted);
}

export function needsAttention(p: BracketPlan): boolean {
    return p.issues.length > 0 || unprotectedQuantity(p) > 0
        || (p.exit !== null && (['incomplete', 'not-sent'].includes(p.exit.status)
            || (p.exit.status === 'unknown' && !p.exit.acknowledged)));
}

export function addIssue(p: BracketPlan, code: BracketIssueCode, detail: string, now: number): BracketPlan {
    if (p.issues.some(i => i.code === code)) return p;
    return { ...p, issues: [...p.issues, { code, detail, at: now }], updatedAt: now };
}

export interface FillEvidence {
    orderId: string;
    key: string; // fill identity
    quantity: number;
    flagged?: BracketIssueCode; // counted but could not be fully verified
}

const text = (v: unknown) => typeof v === 'string' ? v : '';

function reportAccountMatches(report: OrderEventReport, account: AccountRef): boolean | null {
    const body = reportBody(report);
    if (report.kind === 'deal') {
        const broker = text(body?.broker_id);
        const id = text(body?.account_id);
        if (!broker || !id) return null;
        return broker === account.broker_id && id === account.account_id;
    }
    const ref = body?.order && typeof body.order === 'object' ? (body.order as Record<string, unknown>).account : undefined;
    const r = ref && typeof ref === 'object' ? ref as Record<string, unknown> : undefined;
    if (!text(r?.broker_id) || !text(r?.account_id)) return null;
    return r?.broker_id === account.broker_id && r?.account_id === account.account_id;
}

function reportCode(report: OrderEventReport): string {
    const body = reportBody(report);
    if (report.kind === 'deal') {
        return report.market === 'futures' ? (text(body?.full_code) || text(body?.code)) : text(body?.code);
    }
    const c = body?.contract && typeof body.contract === 'object' ? body.contract as Record<string, unknown> : undefined;
    return report.market === 'futures' ? (text(c?.full_code) || text(c?.code)) : text(c?.code);
}

export type DealMatch =
    | { kind: 'fill'; fill: FillEvidence }
    | { kind: 'mismatch'; detail: string }
    | { kind: 'unrelated' };

/** Classify a deal report against an order this plan tracks. */
export function matchDeal(report: OrderEventReport, orderId: string, account: AccountRef,
    market: BracketPlan['market'], orderCode: string, action: Action): DealMatch {
    if (report.kind !== 'deal' || report.market !== market || report.tradeId !== orderId) return { kind: 'unrelated' };
    const accountOk = reportAccountMatches(report, account);
    if (accountOk === false) return { kind: 'unrelated' }; // same id, other account
    if (accountOk === null) return { kind: 'mismatch', detail: '成交回報缺少帳戶欄位，未計入保護量' };
    if (reportCode(report) !== orderCode) return { kind: 'mismatch', detail: `成交回報商品 ${reportCode(report) || '（空）'} 與委託 ${orderCode} 不符，未計入` };
    if (report.action !== action) return { kind: 'mismatch', detail: '成交回報買賣別與委託不符，未計入' };
    if (!Number.isSafeInteger(report.quantity) || report.quantity <= 0) return { kind: 'mismatch', detail: '成交回報數量無效，未計入' };
    const seq = text(reportBody(report)?.exchange_seq);
    if (seq) return { kind: 'fill', fill: { orderId, key: `${orderId}:${seq}`, quantity: report.quantity } };
    if (report.eventId) {
        return { kind: 'fill', fill: { orderId, key: `event:${report.eventId}`, quantity: report.quantity, flagged: 'report-mismatch' } };
    }
    return { kind: 'mismatch', detail: '成交回報沒有成交序號與事件 ID，無法去重，未計入' };
}

/** Fills recorded on a Trade from `/order/trades` (cache-only or refreshed). */
export function fillsFromTrade(trade: Trade): FillEvidence[] {
    return (trade.status.deals ?? [])
        .filter(d => typeof d.seq === 'string' && d.seq && Number.isSafeInteger(d.quantity) && d.quantity > 0)
        .map(d => ({ orderId: trade.order.id, key: `${trade.order.id}:${d.seq}`, quantity: d.quantity }));
}

export function tradeMatchesPlan(trade: Trade, p: Pick<BracketPlan, 'account' | 'orderId' | 'orderCode' | 'action'>): boolean {
    if (trade.order.id !== p.orderId) return false;
    const a = trade.order.account;
    if (a && (a.broker_id !== p.account.broker_id || a.account_id !== p.account.account_id)) return false;
    if ((trade.contract.target_code || trade.contract.code) !== p.orderCode) return false;
    return trade.order.action === p.action;
}

/** Accumulate one entry fill. Idempotent by fill identity. */
export function applyEntryFill(p: BracketPlan, fill: FillEvidence, now: number): BracketPlan {
    if (fill.orderId !== p.orderId || p.fills[fill.key] !== undefined) return p;
    let next: BracketPlan = { ...p, fills: { ...p.fills, [fill.key]: fill.quantity },
        filled: p.filled + fill.quantity, updatedAt: now };
    if (fill.flagged) next = addIssue(next, fill.flagged, '成交回報缺少成交序號，僅以事件 ID 去重；請對帳確認', now);
    if (next.filled > next.quantity) next = addIssue(next, 'overfill', `成交累計 ${next.filled} 超過委託量 ${next.quantity}，保護量以委託量為上限`, now);
    // Protection is only extended while no exit has started; after that a
    // late fill shows up in unprotectedQuantity().
    return next;
}

/** Entry order report: terminal operations close the entry. */
export function applyEntryOrderReport(p: BracketPlan, report: OrderEventReport, now: number): BracketPlan {
    if (report.kind !== 'order' || report.id !== p.orderId || report.market !== p.market) return p;
    if (reportAccountMatches(report, p.account) === false) return p;
    if ((report.opType === 'New' && report.failed) || (report.opType === 'Cancel' && !report.failed)) {
        return p.entryClosed ? p : { ...p, entryClosed: true, updatedAt: now };
    }
    return p;
}

export function applyEntryTrade(p: BracketPlan, trade: Trade, now: number): BracketPlan {
    let next = p;
    for (const fill of fillsFromTrade(trade)) next = applyEntryFill(next, fill, now);
    const listed = fillsFromTrade(trade).reduce((s, f) => s + f.quantity, 0);
    if (trade.status.deal_quantity > listed) {
        next = addIssue(next, 'lookup-failed', `委託顯示成交 ${trade.status.deal_quantity}，但成交明細只有 ${listed}；請對帳`, now);
    }
    if (['Cancelled', 'Failed', 'Filled', 'Inactive'].includes(trade.status.status) && !next.entryClosed) {
        next = { ...next, entryClosed: true, updatedAt: now };
    }
    return next;
}

/** Exit fills (from the exit order id). Idempotent by fill identity. */
export function applyExitFill<E extends BracketExit>(exit: E, fill: FillEvidence, now: number): E {
    if (exit.orderId !== fill.orderId || exit.fills[fill.key] !== undefined) return exit;
    const filled = exit.filled + fill.quantity;
    const status: ExitStatus = filled >= exit.quantity ? 'filled' : exit.status;
    return { ...exit, fills: { ...exit.fills, [fill.key]: fill.quantity }, filled, status, at: now };
}

/** Exit order report: a failed New or a successful Cancel ends the exit. */
export function applyExitOrderReport<E extends BracketExit>(exit: E, report: OrderEventReport, account: AccountRef, now: number): E {
    if (report.kind !== 'order' || report.id !== exit.orderId) return exit;
    if (reportAccountMatches(report, account) === false) return exit;
    const ended = (report.opType === 'New' && report.failed) || (report.opType === 'Cancel' && !report.failed);
    if (!ended || exit.status === 'filled' || exit.status === 'incomplete') return exit;
    if (exit.filled >= exit.quantity) return { ...exit, status: 'filled', at: now };
    return { ...exit, status: 'incomplete', at: now,
        detail: report.failed ? (report.opMsg || '出場委託失敗') : `出場委託已結束，未成交 ${exit.quantity - exit.filled}` };
}
