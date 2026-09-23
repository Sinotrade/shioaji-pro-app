// src/lib/bracket-reports.ts — one de-duplicated order/deal report feed for
// protection tracking (trigger exits + bracket entries, #102).
//
// Every SSE report goes through ONE EventLedger so both consumers agree on
// what is a repeated delivery (same full event_id in this environment).
// Recent reports are kept per order id (bounded) because a deal can arrive
// before the HTTP response that tells us the order id, and before an entry
// registered from another window reaches the main window.

import { EventLedger, type EventVerdict } from './bracket-event-ledger';
import type { OrderEventReport } from './order-report';
import { getApiBase } from './runtime';
import { onOrderEvent } from './stream';

export type TrackedListener = (report: OrderEventReport, verdict: EventVerdict, env: string) => void;

const ledger = new EventLedger();
const listeners = new Set<TrackedListener>();
const recent = new Map<string, { at: number; reports: OrderEventReport[] }>();
const RECENT_ORDERS = 2000;
const RECENT_MS = 30 * 60 * 1000;
let stop: (() => void) | null = null;

function orderIdOf(report: OrderEventReport): string {
    return report.kind === 'deal' ? report.tradeId : report.id;
}

function remember(env: string, report: OrderEventReport, now: number) {
    const id = orderIdOf(report);
    if (!id) return;
    const key = `${env}\u0000${id}`;
    const entry = recent.get(key) ?? { at: now, reports: [] };
    entry.at = now;
    if (entry.reports.length < 200) entry.reports.push(report);
    recent.delete(key);
    recent.set(key, entry);
    while (recent.size > RECENT_ORDERS) {
        const oldest = recent.keys().next().value;
        if (oldest === undefined) break;
        recent.delete(oldest);
    }
}

/** Reports already received for an order in this environment (oldest first). */
export function recentReportsFor(env: string, orderId: string, now = Date.now()): OrderEventReport[] {
    const entry = recent.get(`${env}\u0000${orderId}`);
    if (!entry || now - entry.at > RECENT_MS) return [];
    return entry.reports.slice();
}

export function ingestReport(report: OrderEventReport, now = Date.now()) {
    const env = getApiBase();
    const verdict = ledger.observe(env, report.eventId);
    if (verdict.kind === 'duplicate') return;
    remember(env, report, now);
    for (const listener of listeners) {
        try { listener(report, verdict, env); } catch { /* one consumer cannot break another */ }
    }
}

export function onTrackedReport(listener: TrackedListener): () => void {
    listeners.add(listener);
    if (!stop) stop = onOrderEvent(report => ingestReport(report));
    return () => { listeners.delete(listener); };
}

import.meta.hot?.dispose(() => { stop?.(); stop = null; });
