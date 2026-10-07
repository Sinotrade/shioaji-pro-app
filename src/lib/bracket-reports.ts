// src/lib/bracket-reports.ts — order/deal report feed for protection tracking
// (trigger exits + bracket entries, #102).
//
// Delivery dedup and sequence-gap tracking are NOT done here: stream.ts
// admits every report through the shared report ledger (report-ledger.ts,
// #128) and drops repeated deliveries before fan-out; gaps are observed with
// `reportLedger.onGap`. This module only keeps recent reports per order id
// (bounded), because a deal can arrive before the HTTP response that tells
// us the order id, or before an entry registered from another window
// reaches the main window, and flags reports whose event_id cannot be
// tracked (empty / unsupported, e.g. pre-1.7.6 servers).

import { externalIdentity } from './broker-identity';
import { currentReportContext } from './protection-context';
import type { OrderEventReport } from './order-report';
import { parseEventId } from './report-ledger';
import { getApiBase } from './runtime';
import { onOrderEvent } from './stream';

export interface TrackedReportInfo {
    /** No supported v1 event_id: sequence continuity cannot be judged. */
    untrackable: boolean;
    context: string | null;
}

export type TrackedListener = (report: OrderEventReport, info: TrackedReportInfo, base: string) => void;

const listeners = new Set<TrackedListener>();
const recent = new Map<string, { at: number; reports: { report: OrderEventReport; context: string | null }[] }>();
const RECENT_ORDERS = 2000;
const RECENT_MS = 30 * 60 * 1000;
let stop: (() => void) | null = null;

function orderIdOf(report: OrderEventReport): string {
    return report.kind === 'deal' ? report.tradeId : report.id;
}

function remember(base: string, report: OrderEventReport, now: number) {
    const id = orderIdOf(report);
    if (!id) return;
    const key = `${base}\u0000${id}`;
    const entry = recent.get(key) ?? { at: now, reports: [] };
    entry.at = now;
    if (entry.reports.length < 200) entry.reports.push({ report, context: currentReportContext() });
    recent.delete(key);
    recent.set(key, entry);
    while (recent.size > RECENT_ORDERS) {
        const oldest = recent.keys().next().value;
        if (oldest === undefined) break;
        recent.delete(oldest);
    }
}

/** Reports already received for an order on this API base (oldest first). */
export function recentReportsFor(base: string, orderId: string, now = Date.now(),
    identity?: { orderId: string; seqno?: string; ordno?: string }): OrderEventReport[] {
    const context = currentReportContext();
    if (!context) return [];
    const entries = identity ? [...recent.entries()].filter(([key]) => key.startsWith(`${base}\u0000`)).map(([,entry]) => entry)
        : [recent.get(`${base}\u0000${orderId}`)];
    return entries.flatMap(entry => !entry || now - entry.at > RECENT_MS ? []
        : entry.reports.filter(r => r.context === context && (!identity || externalIdentity({ ...identity, confirmed: false },
            { orderId: orderIdOf(r.report), seqno: r.report.seqno, ordno: r.report.ordno, confirmed: false }) === 'same')).map(r => r.report));
}

/** Reports reaching here were already de-duplicated by stream.ts. */
export function ingestReport(report: OrderEventReport, now = Date.now()) {
    const base = getApiBase();
    remember(base, report, now);
    const info = { untrackable: !parseEventId(report.eventId), context: currentReportContext() };
    for (const listener of listeners) {
        try { listener(report, info, base); } catch { /* one consumer cannot break another */ }
    }
}

export function onTrackedReport(listener: TrackedListener): () => void {
    listeners.add(listener);
    if (!stop) stop = onOrderEvent(report => ingestReport(report));
    return () => { listeners.delete(listener); };
}

import.meta.hot?.dispose(() => { stop?.(); stop = null; });
