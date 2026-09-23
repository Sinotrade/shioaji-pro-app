import { describe, expect, it } from 'vitest';
import { EventLedger, parseEventId, streamMarket } from './bracket-event-ledger';
import fixture from './fixtures/native-simulation-bracket-reports-1.7.6.json';

const ids = (fixture as unknown as { data: Record<string, { event_id: string }> }[]).map(f => Object.values(f.data)[0]!.event_id);

describe('event_id parsing (Shioaji 1.7.6)', () => {
    it('splits at the last two colons and keeps the stream prefix intact', () => {
        expect(parseEventId('v1:SO:C6U5mMWBd:BOKZbRr:123')).toEqual({ stream: 'v1:SO:C6U5mMWBd', reset: 'BOKZbRr', sequence: 123n });
        expect(streamMarket('v1:FD:abc')).toBe('futures');
        expect(streamMarket('v1:SO:abc')).toBe('stock');
    });

    it('compares sequences beyond Number precision with BigInt', () => {
        expect(parseEventId('v1:FD:x:r:18446744073709551617')?.sequence).toBe(18446744073709551617n);
    });

    it('rejects unsupported or empty formats instead of guessing', () => {
        for (const bad of ['', 'v2:SO:x:r:1', 'v1:SO:x:r:abc', 'v1:1', 'v1::1', 'plain']) expect(parseEventId(bad)).toBeNull();
    });

    it('parses every de-identified 1.7.6 simulation report id', () => {
        for (const id of ids) expect(parseEventId(id)).not.toBeNull();
    });
});

describe('EventLedger', () => {
    it('drops a repeated delivery of the same full id, per environment', () => {
        const ledger = new EventLedger();
        expect(ledger.observe('A', 'v1:FD:s:r:4').kind).toBe('new');
        expect(ledger.observe('A', 'v1:FD:s:r:4').kind).toBe('duplicate');
        expect(ledger.observe('B', 'v1:FD:s:r:4').kind).toBe('new');
    });

    it('reports a gap as possibly missing, and accepts the late report as new (not duplicate)', () => {
        const ledger = new EventLedger();
        ledger.observe('A', 'v1:FD:s:r:123');
        const gap = ledger.observe('A', 'v1:FD:s:r:125');
        expect(gap).toEqual({ kind: 'new', gap: { stream: 'v1:FD:s', reset: 'r', expected: 124n, received: 125n } });
        expect(ledger.observe('A', 'v1:FD:s:r:124')).toEqual({ kind: 'new', gap: null });
        expect(ledger.observe('A', 'v1:FD:s:r:124').kind).toBe('duplicate');
    });

    it('baselines each stream and reset separately', () => {
        const ledger = new EventLedger();
        ledger.observe('A', 'v1:FD:s:r1:10');
        expect(ledger.observe('A', 'v1:FO:s:r1:50')).toEqual({ kind: 'new', gap: null }); // other stream
        expect(ledger.observe('A', 'v1:FD:s:r2:1')).toEqual({ kind: 'new', gap: null }); // new reset
        expect(ledger.observe('A', 'v1:FD:s:r1:11')).toEqual({ kind: 'new', gap: null }); // old reset continues
    });

    it('keeps untrackable reports (empty/unsupported id) without sequence inference', () => {
        const ledger = new EventLedger();
        expect(ledger.observe('A', '').kind).toBe('untrackable');
        expect(ledger.observe('A', 'legacy-id').kind).toBe('untrackable');
        expect(ledger.observe('A', 'legacy-id').kind).toBe('duplicate');
    });

    it('sees no gap in the captured contiguous simulation sequence', () => {
        const ledger = new EventLedger();
        const verdicts = ids.map(id => ledger.observe('sim', id));
        expect(verdicts.every(v => v.kind === 'new' && v.gap === null)).toBe(true);
    });
});
