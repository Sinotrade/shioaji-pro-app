import { describe, expect, it } from 'vitest';
import {
    applyEntryFill,
    applyEntryOrderReport,
    applyEntryTrade,
    applyExitFill,
    applyExitOrderReport,
    bracketPhase,
    matchDeal,
    protectionQuantity,
    unprotectedQuantity,
    type AccountRef,
    type BracketExit,
    type BracketPlan,
} from './bracket-core';
import { normalizeOrderEvent, type OrderEventReport } from './order-report';
import fixture from './fixtures/native-simulation-bracket-reports-1.7.6.json';
import type { Trade } from './types/order';

const reports = (fixture as unknown[]).map(f => normalizeOrderEvent(f)!);
const F: AccountRef = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F' };
const S: AccountRef = { account_type: 'S', broker_id: 'fixture-broker-S', account_id: 'fixture-account-S' };
const OTHER_F: AccountRef = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F2' };

function plan(over: Partial<BracketPlan> = {}): BracketPlan {
    return {
        id: 'p', env: 'sim', account: F, market: 'futures', orderId: 'fixture-f1', seqno: 'fixture-f1',
        quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 2,
        stopPrice: 48000, takePrice: 48600, group: 'g', fills: {}, filled: 0, entryClosed: false, exit: null,
        issues: [], createdAt: 0, updatedAt: 0, ...over,
    };
}

function feed(p: BracketPlan, list: OrderEventReport[]): BracketPlan {
    for (const r of list) {
        if (r.kind === 'order') { p = applyEntryOrderReport(p, r, 1); continue; }
        const m = matchDeal(r, p.orderId, p.account, p.market, p.orderCode, p.action);
        if (m.kind === 'fill') p = applyEntryFill(p, m.fill, 1);
    }
    return p;
}

function withBody(r: OrderEventReport, patch: Record<string, unknown>): OrderEventReport {
    const raw = r.raw as { state: string; data: Record<string, Record<string, unknown>> };
    return normalizeOrderEvent({ ...raw, data: { [raw.state]: { ...raw.data[raw.state], ...patch } } })!;
}

describe('bracket entry accumulation on real 1.7.6 simulation wire (de-identified)', () => {
    it('accumulates two partial futures fills (deal arrives before its New report)', () => {
        expect(reports[0]!.kind).toBe('deal'); // captured order: deal first
        const p = feed(plan(), reports.slice(0, 3));
        expect(p.filled).toBe(2);
        expect(Object.keys(p.fills)).toEqual(['fixture-f1:000001', 'fixture-f1:000002']);
        expect(protectionQuantity(p)).toBe(2);
        expect(bracketPhase(p)).toBe('protected');
    });

    it('protects the first partial fill immediately, then grows with the second', () => {
        const first = feed(plan(), [reports[0]!]);
        expect(protectionQuantity(first)).toBe(1);
        expect(protectionQuantity(feed(first, [reports[2]!]))).toBe(2);
    });

    it('counts a re-delivered or out-of-order fill once (fill identity, not arrival order)', () => {
        const once = feed(plan(), [reports[2]!, reports[0]!]);
        const twice = feed(once, [reports[0]!, reports[2]!]);
        expect(twice.filled).toBe(2);
        expect(twice).toBe(once);
    });

    it('ignores the other order of the same account (exit order fills are not entry fills)', () => {
        const p = feed(plan(), reports.slice(3, 6)); // fixture-f2 Cover order + its fills
        expect(p.filled).toBe(0);
    });

    it('keeps two accounts with the same product and order id isolated', () => {
        const other = plan({ id: 'q', account: OTHER_F });
        expect(feed(other, reports.slice(0, 3)).filled).toBe(0);
        const foreign = withBody(reports[0]!, { account_id: 'fixture-account-F2', exchange_seq: '000009', event_id: 'v1:FD:x:r:99' });
        expect(feed(plan(), [foreign]).filled).toBe(0);
        expect(feed(other, [foreign]).filled).toBe(1);
    });

    it('refuses to count a deal without account fields, product or side match', () => {
        const noAccount = withBody(reports[0]!, { account_id: '', broker_id: '' });
        expect(matchDeal(noAccount, 'fixture-f1', F, 'futures', 'TXFJ6', 'Buy').kind).toBe('mismatch');
        const otherCode = withBody(reports[0]!, { code: 'TXFK6' });
        expect(matchDeal(otherCode, 'fixture-f1', F, 'futures', 'TXFJ6', 'Buy').kind).toBe('mismatch');
        expect(matchDeal(reports[0]!, 'fixture-f1', F, 'futures', 'TXFJ6', 'Sell').kind).toBe('mismatch');
    });

    it('falls back to the full event_id only when exchange_seq is missing, and flags it', () => {
        const noSeq = withBody(reports[0]!, { exchange_seq: '' });
        const m = matchDeal(noSeq, 'fixture-f1', F, 'futures', 'TXFJ6', 'Buy');
        expect(m).toMatchObject({ kind: 'fill', fill: { key: `event:${reports[0]!.eventId}`, flagged: 'report-mismatch' } });
        const p = feed(plan(), [noSeq]);
        expect(p.filled).toBe(1);
        expect(p.issues.map(i => i.code)).toContain('report-mismatch');
        const neither = withBody(reports[0]!, { exchange_seq: '', event_id: '' });
        expect(matchDeal(neither, 'fixture-f1', F, 'futures', 'TXFJ6', 'Buy').kind).toBe('mismatch');
    });

    it('stock Common Cash fill in lots on the stock stream', () => {
        const p = feed(plan({ account: S, market: 'stock', orderId: 'fixture-s1', orderCode: '2890', quantity: 1,
            securityType: 'STK', exchange: 'TSE' }), reports.slice(6, 8));
        expect(p.filled).toBe(1);
        expect(protectionQuantity(p)).toBe(1);
    });

    it('closes the entry on Cancel / failed New but still counts late fills', () => {
        const cancel = withBody(reports[1]!, { operation: { op_type: 'Cancel', op_code: '00', op_msg: '' }, event_id: 'v1:FO:x:r:77' });
        let p = applyEntryOrderReport(plan(), cancel, 1);
        expect(bracketPhase(p)).toBe('closed');
        p = feed(p, [reports[0]!]);
        expect(bracketPhase(p)).toBe('protected');
        expect(protectionQuantity(p)).toBe(1);
    });

    it('merges fills from a cache-only Trade lookup with SSE fills without double counting', () => {
        const sse = feed(plan(), [reports[0]!]);
        const trade = { contract: { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
            order: { id: 'fixture-f1', seqno: 'fixture-f1', ordno: 'o', action: 'Buy', price: 0, quantity: 2 },
            status: { id: 'fixture-f1', status: 'Filled', status_code: '00', order_quantity: 2, deal_quantity: 2, cancel_quantity: 0,
                modified_price: 0, msg: '', deals: [{ seq: '000001', price: 1, quantity: 1, ts: 1 }, { seq: '000002', price: 1, quantity: 1, ts: 2 }] } } as unknown as Trade;
        const merged = applyEntryTrade(sse, trade, 2);
        expect(merged.filled).toBe(2);
        expect(merged.entryClosed).toBe(true);
    });

    it('flags an overfill and caps protection at the entry quantity', () => {
        let p = plan({ quantity: 1 });
        p = feed(p, reports.slice(0, 3));
        expect(p.filled).toBe(2);
        expect(protectionQuantity(p)).toBe(1);
        expect(p.issues.map(i => i.code)).toContain('overfill');
    });
});

describe('exit outcome and unprotected quantity', () => {
    const exit = (over: Partial<BracketExit> = {}): BracketExit => ({ status: 'working', kind: 'stop', quantity: 2, filled: 0,
        fills: {}, orderId: 'fixture-f2', at: 0, ...over });

    it('accumulates exit fills to filled, idempotently', () => {
        const [, , , , d1, d2] = reports;
        const m1 = matchDeal(d1!, 'fixture-f2', F, 'futures', 'TXFJ6', 'Sell');
        const m2 = matchDeal(d2!, 'fixture-f2', F, 'futures', 'TXFJ6', 'Sell');
        if (m1.kind !== 'fill' || m2.kind !== 'fill') throw new Error('fixture');
        let e = applyExitFill(exit(), m1.fill, 1);
        e = applyExitFill(e, m1.fill, 1);
        expect(e).toMatchObject({ filled: 1, status: 'working' });
        expect(applyExitFill(e, m2.fill, 2)).toMatchObject({ filled: 2, status: 'filled' });
    });

    it('marks an exit that ended unfilled as incomplete → explicit unprotected quantity', () => {
        const cancel = withBody(reports[3]!, { operation: { op_type: 'Cancel', op_code: '00', op_msg: '' } });
        const e = applyExitOrderReport(exit({ filled: 1 }), cancel, F, 3);
        expect(e.status).toBe('incomplete');
        const p = plan({ filled: 2, exit: e });
        expect(unprotectedQuantity(p)).toBe(1);
    });

    it('treats a refused exit as fully unprotected, and fills after an exit as unprotected', () => {
        expect(unprotectedQuantity(plan({ filled: 2, exit: exit({ status: 'not-sent', quantity: 0 }) }))).toBe(2);
        // exit covered 1, a late second entry fill is not protected
        expect(unprotectedQuantity(plan({ filled: 2, exit: exit({ quantity: 1 }) }))).toBe(1);
        // unknown outcome is not counted as unprotected, but is a separate attention state
        expect(unprotectedQuantity(plan({ filled: 2, exit: exit({ status: 'unknown' }) }))).toBe(0);
    });
});
