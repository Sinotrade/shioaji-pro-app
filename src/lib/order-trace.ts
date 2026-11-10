// src/lib/order-trace.ts — debug-only trace of cancel/update order mutations (#244).
// Compiled in only when the build sets VITE_DEBUG_ORDER_TRACE=1: Vite replaces
// the env read with a literal, so every function below returns immediately and
// the minifier drops the bodies. Never records an identity number: account
// fields are booleans / shape only and server text is masked.
import type { Trade } from './types/order';
import type { OrderEventReport } from './order-report';
import { currentWindowLabel, isChildWindow } from './window-role';
import { maskIdentifiers } from './trade-mutations';

export const ORDER_TRACE_ENABLED: boolean = import.meta.env.VITE_DEBUG_ORDER_TRACE === '1';

export type OrderTraceEntry = 'flash cell' | 'flash 全刪' | 'flash 買全刪' | 'flash 賣全刪' | 'orders tab' | 'other';
export type OrderTraceKind = 'cancel' | 'cancel_verified' | 'update_price' | 'update_qty' | 'report';

export interface OrderTraceRecord {
    ts: string;
    /** WebView that recorded it: a popout's records reach the main window's diagnostics too. */
    window?: string;
    kind: OrderTraceKind;
    entry: OrderTraceEntry;
    trade_id: string;
    seqno?: string; ordno?: string; code?: string; action?: string; price?: number; qty?: number; status?: string;
    custom_field_present?: boolean;
    account?: { broker_id_present: boolean; account_id_tail: string; account_type: string; person_id_present: boolean; person_id_length: number };
    reconcile?: { ran: boolean; found_same_trade?: boolean; resolved_trade_id_changed?: boolean; person_id_present_after?: boolean };
    endpoint?: string;
    transport?: string;
    http_status?: number;
    error?: string;
    error_flags?: string[];
    summary?: string;
    /** kind 'report': the active report (Cancel / UpdatePrice / UpdateQty) as received. */
    report?: { op_type: string; op_code: string; op_msg: string; cancel_quantity: number; order_quantity: number;
        /** a mutation of this order was running in this window when it arrived */
        app_mutation_in_flight: boolean; app_mutation_ms_ago: number | null };
}

const MAX = 50;
const records: OrderTraceRecord[] = [];
const pendingEntry = new Map<string, OrderTraceEntry>();
// trade id → running mutations in this window, and when the last one began
const inFlight = new Map<string, number>();
const lastBegun = new Map<string, number>();

function windowName(): string {
    try { return currentWindowLabel() ?? (isChildWindow() ? 'popout' : 'main'); } catch { return 'unknown'; }
}
function keep(record: OrderTraceRecord) {
    records.push(record);
    if (records.length > MAX) records.splice(0, records.length - MAX);
}
// #244 QA: a cancel clicked in a popout flash panel was traced only in that
// window, so the main window's 複製診斷資訊 never showed it. Every window
// shares its finished records with the others.
const CHANNEL = 'sj-order-trace';
let channel: BroadcastChannel | null | undefined;
function traceChannel(): BroadcastChannel | null {
    if (channel !== undefined) return channel;
    channel = null;
    try {
        if (ORDER_TRACE_ENABLED && typeof BroadcastChannel === 'function') {
            channel = new BroadcastChannel(CHANNEL);
            channel.addEventListener('message', (event: MessageEvent) => {
                const record = (event.data as { record?: OrderTraceRecord } | null)?.record;
                if (record && typeof record === 'object' && typeof record.trade_id === 'string') keep(record);
            });
        }
    } catch { channel = null; }
    return channel;
}
// listen from the start (enabled builds only): a popout's first refused
// mutation leaves no report behind, so waiting for local activity loses it
if (ORDER_TRACE_ENABLED) traceChannel();
function share(record: OrderTraceRecord) {
    try { traceChannel()?.postMessage({ record }); } catch { /* best effort */ }
}

/** Same policy as the cancel notification (maskIdentifiers): national ID /
 *  ARC shapes and 7+ digit runs (account numbers) become ***. */
export function maskTraceText(text: string): string {
    return maskIdentifiers(text);
}

/** Callers that know their UI entry point tag the trade ids before cancelling. */
export function noteOrderTraceEntry(tradeIds: string[], entry: OrderTraceEntry) {
    if (!ORDER_TRACE_ENABLED) return;
    for (const id of tradeIds) pendingEntry.set(id, entry);
}

export function beginOrderTrace(kind: OrderTraceKind, tradeId: string): OrderTraceRecord | null {
    if (!ORDER_TRACE_ENABLED) return null;
    const entry = pendingEntry.get(tradeId) ?? 'other';
    pendingEntry.delete(tradeId);
    traceChannel();
    const record: OrderTraceRecord = { ts: new Date().toISOString(), window: windowName(), kind, entry, trade_id: tradeId };
    keep(record);
    inFlight.set(tradeId, (inFlight.get(tradeId) ?? 0) + 1);
    lastBegun.set(tradeId, Date.now());
    return record;
}

type AccountLike = { broker_id?: string; account_id?: string; account_type?: string; person_id?: string } | undefined | null;
export function accountShape(account: AccountLike): OrderTraceRecord['account'] {
    return {
        broker_id_present: !!account?.broker_id,
        account_id_tail: (account?.account_id ?? '').slice(-2),
        account_type: account?.account_type ?? '',
        person_id_present: !!account?.person_id,
        person_id_length: account?.person_id?.length ?? 0,
    };
}

export function traceTrade(record: OrderTraceRecord | null, trade: Trade, account: AccountLike) {
    if (!ORDER_TRACE_ENABLED || !record) return;
    const order = trade.order as Trade['order'] & { custom_field?: string };
    Object.assign(record, {
        seqno: order.seqno, ordno: order.ordno, code: trade.contract.target_code || trade.contract.code,
        action: order.action, price: order.price, qty: order.quantity, status: trade.status?.status,
        custom_field_present: !!order.custom_field, account: accountShape(account),
    });
}

export function traceSet(record: OrderTraceRecord | null, patch: Partial<OrderTraceRecord>) {
    if (!ORDER_TRACE_ENABLED || !record) return;
    Object.assign(record, patch);
}

/** Wraps an onResponse hook so the HTTP status is recorded. */
export function traceResponse(record: OrderTraceRecord | null, onResponse?: (res: Response) => void) {
    if (!ORDER_TRACE_ENABLED || !record) return onResponse;
    return (res: Response) => { record.http_status = res.status; onResponse?.(res); };
}

export async function finishOrderTrace<T>(record: OrderTraceRecord | null, pending: Promise<T>): Promise<T> {
    if (!ORDER_TRACE_ENABLED || !record) return pending;
    try {
        const value = await pending;
        const status = (value as { status?: { status?: string } } | null)?.status?.status;
        record.summary = `ok${status ? ` (${status})` : ''}`;
        emitTrace(record);
        return value;
    } catch (error) {
        const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
        if (typeof e.status === 'number') record.http_status ??= e.status;
        record.error = maskTraceText(error instanceof Error ? error.message : String(error));
        record.error_flags = ['mutationNotStarted', 'mutationOutcomeUnknown', 'tradingGateRejected', 'orderNotConnected']
            .filter(key => e[key] === true);
        if (typeof e.errorCode === 'string') record.error_flags.push(`errorCode=${maskTraceText(e.errorCode)}`);
        record.summary = e.mutationNotStarted === true ? 'not sent' : e.mutationOutcomeUnknown === true ? 'sent, outcome unknown' : 'failed';
        emitTrace(record);
        throw error;
    }
}

function settle(tradeId: string) {
    const n = (inFlight.get(tradeId) ?? 1) - 1;
    if (n > 0) inFlight.set(tradeId, n); else inFlight.delete(tradeId);
}

function emitTrace(record: OrderTraceRecord) {
    if (record.kind !== 'report') settle(record.trade_id);
    share(record);
    try { console.info('[order-trace]', JSON.stringify(record)); } catch { /* console unavailable */ }
}

/** An active Cancel / UpdatePrice / UpdateQty report: shows whether an order
 *  was changed by this App (a mutation was running here) or by someone else
 *  (another window's record, iLeader, the exchange, a native engine). */
export function noteOrderReport(report: OrderEventReport) {
    if (!ORDER_TRACE_ENABLED || report.kind !== 'order' || !['Cancel', 'UpdatePrice', 'UpdateQty'].includes(report.opType)) return;
    traceChannel();
    const begun = lastBegun.get(report.id);
    const record: OrderTraceRecord = { ts: new Date().toISOString(), window: windowName(), kind: 'report', entry: 'other', trade_id: report.id,
        seqno: report.seqno, ordno: report.ordno, code: report.code, action: report.action, price: report.price, qty: report.quantity,
        report: { op_type: report.opType, op_code: report.opCode, op_msg: maskTraceText(report.opMsg ?? ''),
            cancel_quantity: report.cancelQuantity, order_quantity: report.orderQuantity,
            app_mutation_in_flight: inFlight.has(report.id), app_mutation_ms_ago: begun === undefined ? null : Date.now() - begun } };
    keep(record);
    emitTrace(record);
}

export function getOrderTrace(): readonly OrderTraceRecord[] {
    return ORDER_TRACE_ENABLED ? records.slice() : [];
}

/** The 「Order trace」 section of the copied diagnostics; empty when disabled. */
export function orderTraceDiagnostics(): string {
    if (!ORDER_TRACE_ENABLED) return '';
    return `--- Order trace (last ${records.length}) ---\n${records.map(r => JSON.stringify(r)).join('\n') || '(none)'}`;
}

/** Test hook only. */
export function resetOrderTraceForTest() { records.length = 0; pendingEntry.clear(); inFlight.clear(); lastBegun.clear(); }
