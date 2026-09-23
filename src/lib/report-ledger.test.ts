import { describe, expect, it, vi } from 'vitest';
import { createReportLedger, parseEventId } from './report-ledger';
import { normalizeOrderEvent } from './order-report';
import schema from './fixtures/order-callback-openapi-1.7.6.json';
import captured from './fixtures/native-simulation-event-id-1.7.6.json';

const sim = { base: 'http://127.0.0.1:21323', simulation: true };

describe('Shioaji 1.7.6 event_id wire', () => {
    it('is a required opaque string on all four live report payloads', () => {
        const variants = ['StockOrderEvent', 'StockDealEvent', 'FuturesOrderEvent', 'FuturesDealEvent'];
        for (const name of variants) {
            const entry = (schema.schemas as Record<string, { required?: string[]; properties?: Record<string, { type?: string }> }>)[`shioaji.api.api_v1.order.callback.${name}`]!;
            expect(entry.required).toContain('event_id');
            expect(entry.properties!.event_id!.type).toBe('string');
        }
        const reasons = (schema.schemas as Record<string, { enum?: string[] }>)['shioaji.api.api_v1.order.health.TradeCacheHealthReasonCode']!.enum;
        expect(reasons).toEqual(['NotSubscribed', 'NoBaseline', 'UntrackableEventId', 'SequenceGap', 'PendingReport', 'ProjectionFailed']);
    });
    it('normalizes the captured envelope and keeps the complete ID', () => {
        const reports = captured.events.map(e => normalizeOrderEvent(e)!);
        expect(reports.every(r => /^v1:(SO|SD|FO|FD):[A-Z]+STREAM:RESET1:\d+$/.test(r.eventId))).toBe(true);
        expect(new Set(reports.map(r => r.eventId)).size).toBe(reports.length);
        expect(reports.filter(r => r.kind === 'deal').map(r => (r.raw as { data: Record<string, { exchange_seq: string }> }).data).length).toBe(6);
    });
    it('treats a missing event_id as empty (history / pre-1.7.6)', () => {
        const legacy = normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: { trade_id: 'x', code: '2330', price: 1, quantity: 1 } } })!;
        expect(legacy.eventId).toBe('');
    });
});

describe('parseEventId', () => {
    it('splits a supported v1 ID at its last two colons', () => {
        expect(parseEventId('v1:FO:FSTREAM:RESET1:13')).toEqual({ stream: 'v1:FO:FSTREAM', reset: 'RESET1', sequence: 13n });
        expect(parseEventId('v1:a:b:c:d:9')).toEqual({ stream: 'v1:a:b:c', reset: 'd', sequence: 9n });
    });
    it('compares sequences beyond Number precision exactly with BigInt', () => {
        const a = parseEventId('v1:SD:S:R:9007199254740993')!;
        const b = parseEventId('v1:SD:S:R:9007199254740992')!;
        expect(a.sequence > b.sequence).toBe(true);
        expect(a.sequence - b.sequence).toBe(1n);
    });
    it.each(['', 'v2:SO:S:R:1', 'v1:SO:S:R:', 'v1:SO:S:R:1a', 'v1:SO:S::1', 'v1:5', 'SO:S:R:1'])('rejects unsupported %j', id => {
        expect(parseEventId(id)).toBeNull();
    });
});

describe('report ledger', () => {
    it('deduplicates the complete ID per environment only', () => {
        const ledger = createReportLedger();
        expect(ledger.admit(sim, 'v1:SD:S:R:1', 'deal').duplicate).toBe(false);
        expect(ledger.admit(sim, 'v1:SD:S:R:1', 'deal').duplicate).toBe(true);
        expect(ledger.admit({ base: 'http://127.0.0.1:21322', simulation: false }, 'v1:SD:S:R:1', 'deal').duplicate).toBe(false);
        // Same base restarted in the other mode is another environment.
        expect(ledger.admit({ ...sim, simulation: false }, 'v1:SD:S:R:1', 'deal').duplicate).toBe(false);
    });
    it('does not deduplicate or sequence empty historical IDs', () => {
        const ledger = createReportLedger();
        expect(ledger.admit(sim, '', 'deal')).toEqual({ duplicate: false, unsupported: false, gapOpened: false, late: false });
        expect(ledger.admit(sim, '', 'deal').duplicate).toBe(false);
    });
    it('keeps unsupported formats (dedup only) and skips sequence inference', () => {
        const ledger = createReportLedger();
        expect(ledger.admit(sim, 'opaque-2', 'order')).toMatchObject({ unsupported: true, gapOpened: false });
        expect(ledger.admit(sim, 'opaque-2', 'order').duplicate).toBe(true);
        expect(ledger.openGapCount(sim.base)).toBe(0);
    });
    it('reports a gap as possible loss, closes it when the late report arrives, and treats a baseline as unknown history', () => {
        const ledger = createReportLedger();
        const onGap = vi.fn(); ledger.onGap(onGap);
        // First observation (seq 7) is a baseline: 1..6 predate the subscription.
        expect(ledger.admit(sim, 'v1:FO:F:R:7', 'order')).toMatchObject({ gapOpened: false });
        expect(ledger.admit(sim, 'v1:FO:F:R:9', 'order')).toMatchObject({ gapOpened: true });
        expect(onGap).toHaveBeenCalledOnce();
        expect(ledger.openGapCount(sim.base)).toBe(1);
        expect(ledger.admit(sim, 'v1:FO:F:R:8', 'order')).toMatchObject({ late: true, duplicate: false });
        expect(ledger.openGapCount(sim.base)).toBe(0);
        // Older than the baseline: a late unseen report, not a duplicate/gap.
        expect(ledger.admit(sim, 'v1:FO:F:R:3', 'order')).toMatchObject({ late: true, duplicate: false, gapOpened: false });
    });
    it('splits a multi-report gap as late reports arrive out of order', () => {
        const ledger = createReportLedger();
        ledger.admit(sim, 'v1:SD:S:R:1', 'deal');
        ledger.admit(sim, 'v1:SD:S:R:5', 'deal');
        ledger.admit(sim, 'v1:SD:S:R:3', 'deal');
        expect(ledger.openGapCount(sim.base)).toBe(2);
        ledger.admit(sim, 'v1:SD:S:R:4', 'deal');
        ledger.admit(sim, 'v1:SD:S:R:2', 'deal');
        expect(ledger.openGapCount(sim.base)).toBe(0);
    });
    it('gives a new reset its own baseline and keeps late reports of the old reset separate', () => {
        const ledger = createReportLedger();
        ledger.admit(sim, 'v1:FO:F:R1:40', 'order');
        expect(ledger.admit(sim, 'v1:FO:F:R2:1', 'order').gapOpened).toBe(false);
        expect(ledger.admit(sim, 'v1:FO:F:R1:41', 'order').gapOpened).toBe(false);
        expect(ledger.admit(sim, 'v1:FO:F:R2:3', 'order').gapOpened).toBe(true);
        expect(ledger.admit(sim, 'v1:FO:F:R1:43', 'order').gapOpened).toBe(true);
        expect(ledger.openGapCount(sim.base)).toBe(2);
    });
    it('tracks streams independently (order vs deal) and reports affected kinds when taken', () => {
        const ledger = createReportLedger();
        ledger.admit(sim, 'v1:FO:F:R:1', 'order'); ledger.admit(sim, 'v1:FD:F:R:1', 'deal');
        ledger.admit(sim, 'v1:FO:F:R:2', 'order'); ledger.admit(sim, 'v1:FD:F:R:3', 'deal');
        const opened = ledger.clock();
        ledger.admit(sim, 'v1:FO:F:R:4', 'order');
        expect(ledger.takeGaps(sim.base, opened)).toEqual(new Set(['deal']));
        expect(ledger.takeGaps(sim.base)).toEqual(new Set(['order']));
        expect(ledger.openGapCount(sim.base)).toBe(0);
        // A taken gap no longer tracks; its late report is simply late.
        expect(ledger.admit(sim, 'v1:FD:F:R:2', 'deal')).toMatchObject({ late: true, gapOpened: false });
    });
    it('finds no gap in the captured 1.7.6 sequence and flags a removed report', () => {
        const all = captured.events.map(e => normalizeOrderEvent(e)!);
        const ledger = createReportLedger();
        expect(all.map(r => ledger.admit(sim, r.eventId, r.kind)).some(v => v.gapOpened || v.duplicate)).toBe(false);
        const missing = createReportLedger();
        const withoutUpdateQty = all.filter(r => r.eventId !== 'v1:FO:FSTREAM:RESET1:10');
        const verdicts = withoutUpdateQty.map(r => missing.admit(sim, r.eventId, r.kind));
        expect(verdicts.filter(v => v.gapOpened)).toHaveLength(1);
        // Replaying the whole capture again is all duplicates.
        expect(all.map(r => ledger.admit(sim, r.eventId, r.kind)).every(v => v.duplicate)).toBe(true);
    });
    it('bounds retained IDs and gap ranges', () => {
        const ledger = createReportLedger({ maxIds: 3, maxGapsPerStream: 2 });
        for (const n of [1, 3, 5, 7, 9]) ledger.admit(sim, `v1:SO:S:R:${n}`, 'order');
        expect(ledger.openGapCount(sim.base)).toBe(2);
        expect(ledger.admit(sim, 'v1:SO:S:R:1', 'order').duplicate).toBe(false);
        expect(ledger.admit(sim, 'v1:SO:S:R:9', 'order').duplicate).toBe(true);
    });
});
