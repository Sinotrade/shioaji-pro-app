import { describe, expect, it, vi } from 'vitest';
import {
    CancelUnconfirmedError,
    findOrderRow,
    isConfirmedCancellation,
    requiredCancelQuantity,
    verifyCancellation,
    type CancelVerificationDeps,
} from './cancel-verification';
import type { Trade, TradeCacheHealth } from './types/order';

const account = { account_type: 'F', broker_id: 'fixture-broker', account_id: 'fixture-account' };
const other = { ...account, account_id: 'other-account' };

function row(status: Partial<Trade['status']> = {}, order: Partial<Trade['order']> = {}): Trade {
    return {
        contract: { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
        order: { id: 'order-1', seqno: 'seq-1', ordno: 'ord-1', action: 'Buy', price: 45000, quantity: 1, account, ...order },
        // 1.7.6 HTTP rows report status.order_quantity 0 (see fixture below).
        status: { id: 'order-1', status: 'Submitted', status_code: '00', msg: '', order_quantity: 0,
            deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [], ...status },
    } as Trade;
}
const healthy: TradeCacheHealth = { state: 'Healthy', reasons: [] };
const degraded: TradeCacheHealth = { state: 'Degraded', reasons: [{ event_type: 'FuturesOrder', reason: 'SequenceGap' }] };

function deps(reads: { cache: () => Promise<Trade[]>; refresh: () => Promise<Trade[]> }, extra: Partial<CancelVerificationDeps> = {}) {
    const readTrades = vi.fn((refresh: boolean) => refresh ? reads.refresh() : reads.cache());
    const readHealth = vi.fn(async () => healthy);
    let clock = 0;
    return {
        readTrades,
        readHealth,
        value: {
            readTrades, readHealth,
            // Fake clock: each sleep advances it, so the window is honoured.
            sleep: async (ms: number) => { clock += ms; },
            now: () => clock,
            scope: `test-${Math.random()}`,
            ...extra,
        } satisfies CancelVerificationDeps,
    };
}
const calls = (fn: ReturnType<typeof vi.fn>, refresh: boolean) => fn.mock.calls.filter(c => c[0] === refresh).length;

describe('cancel confirmation rule', () => {
    it('requires the remaining quantity from order.quantity, never status.order_quantity', () => {
        expect(requiredCancelQuantity(row({ order_quantity: 0 }, { quantity: 3 }))).toBe(3);
        expect(requiredCancelQuantity(row({ deal_quantity: 1 }, { quantity: 3 }))).toBe(2);
    });
    it('accepts Cancelled only when cumulative cancel_quantity covers the remainder', () => {
        const before = row({ deal_quantity: 1 }, { quantity: 3 });
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', deal_quantity: 1, cancel_quantity: 2 }, { quantity: 3 }))).toBe(true);
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', deal_quantity: 1, cancel_quantity: 1 }, { quantity: 3 }))).toBe(false);
        expect(isConfirmedCancellation(before, row({ status: 'Submitted', deal_quantity: 1, cancel_quantity: 2 }, { quantity: 3 }))).toBe(false);
        // A read-back behind the local fill count is not evidence.
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', deal_quantity: 0, cancel_quantity: 3 }, { quantity: 3 }))).toBe(false);
        expect(isConfirmedCancellation(before, null)).toBe(false);
    });
    it('counts fills that raced the cancel: Cancelled with nothing left is confirmed', () => {
        const before = row({}, { quantity: 5 });
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', deal_quantity: 2, cancel_quantity: 3 }, { quantity: 5 }))).toBe(true);
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', deal_quantity: 2, cancel_quantity: 2 }, { quantity: 5 }))).toBe(false);
    });
    it('matches id and account; a row of another account or a duplicate id is not this order', () => {
        expect(findOrderRow([row()], 'order-1', account)).not.toBeNull();
        expect(findOrderRow([row({}, { account: other })], 'order-1', account)).toBeNull();
        expect(findOrderRow([row({}, { account: undefined })], 'order-1', account)).not.toBeNull(); // account-scoped read
        expect(findOrderRow([row(), row()], 'order-1', account)).toBeNull();
        expect(findOrderRow([row({}, { id: 'order-2' })], 'order-1', account)).toBeNull();
    });
});

describe('verifyCancellation', () => {
    it('keeps Submitted with cancel_quantity 0 unconfirmed (#120) and reads refresh:true exactly once', async () => {
        const d = deps({ cache: async () => [row()], refresh: async () => [row()] });
        const error = await verifyCancellation(row(), account, d.value).catch(e => e);
        expect(error).toBeInstanceOf(CancelUnconfirmedError);
        expect(error).toMatchObject({ code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true, reconcileRequired: true,
            details: { observedStatus: 'Submitted', observedCancelQuantity: 0, missing: false, refreshed: true } });
        expect(error).not.toHaveProperty('mutationNotStarted');
        expect(calls(d.readTrades, false)).toBe(11); // 0..3000ms every 300ms
        expect(calls(d.readTrades, true)).toBe(1);
        expect(d.readHealth).toHaveBeenCalledTimes(1);
    });

    it('confirms from the cache once the Cancel is projected, without an authoritative read', async () => {
        const cancelled = row({ status: 'Cancelled', cancel_quantity: 1 });
        const cache = vi.fn().mockResolvedValueOnce([row()]).mockResolvedValueOnce([row()]).mockResolvedValue([cancelled]);
        const d = deps({ cache, refresh: async () => [] });
        await expect(verifyCancellation(row(), account, d.value)).resolves.toEqual({ trade: cancelled, source: 'cache', cacheReads: 3 });
        expect(calls(d.readTrades, true)).toBe(0);
        expect(d.readHealth).not.toHaveBeenCalled();
    });

    it('confirms a cancellation after a partial fill (remaining 2 of 3)', async () => {
        const before = row({ status: 'PartFilled', deal_quantity: 1 }, { quantity: 3 });
        const cancelled = row({ status: 'Cancelled', deal_quantity: 1, cancel_quantity: 2 }, { quantity: 3 });
        const d = deps({ cache: async () => [cancelled], refresh: async () => [] });
        await expect(verifyCancellation(before, account, d.value)).resolves.toMatchObject({ trade: cancelled, source: 'cache' });
    });

    it('with a Degraded cache does exactly one refresh:true, which may confirm', async () => {
        const cancelled = row({ status: 'Cancelled', cancel_quantity: 1 });
        const d = deps({ cache: async () => [row()], refresh: async () => [cancelled] });
        d.readHealth.mockResolvedValue(degraded);
        await expect(verifyCancellation(row(), account, d.value)).resolves.toMatchObject({ trade: cancelled, source: 'refresh' });
        expect(calls(d.readTrades, true)).toBe(1);
    });

    it('with a Degraded cache and no confirmation still reads refresh:true only once', async () => {
        const d = deps({ cache: async () => [row()], refresh: async () => [row()] });
        d.readHealth.mockResolvedValue(degraded);
        const error = await verifyCancellation(row(), account, d.value).catch(e => e);
        expect(error).toMatchObject({ code: 'CANCEL_UNCONFIRMED', details: { health: degraded } });
        expect(error.message).toContain('Degraded');
        expect(calls(d.readTrades, true)).toBe(1);
    });

    it('treats read failures as unconfirmed, never as cancelled', async () => {
        const d = deps({ cache: async () => { throw new Error('503 Service Unavailable'); }, refresh: async () => { throw new Error('offline'); } });
        d.readHealth.mockRejectedValue(new Error('404'));
        const error = await verifyCancellation(row(), account, d.value).catch(e => e);
        expect(error).toMatchObject({ code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true,
            details: { observedStatus: null, health: null, readError: 'offline', refreshed: true } });
        expect(calls(d.readTrades, true)).toBe(1);
    });

    it('never treats an order missing from the cache as cancelled nor fabricates a Cancelled trade', async () => {
        const d = deps({ cache: async () => [], refresh: async () => [row({}, { id: 'unrelated' })] });
        const error = await verifyCancellation(row(), account, d.value).catch(e => e);
        expect(error).toMatchObject({ code: 'CANCEL_UNCONFIRMED', details: { missing: true, observedStatus: null } });
        expect(error.message).toContain('找不到');
        expect(error).not.toHaveProperty('trade');
    });

    it('ignores a Cancelled row that belongs to another account', async () => {
        const foreign = row({ status: 'Cancelled', cancel_quantity: 1 }, { account: other });
        const d = deps({ cache: async () => [foreign], refresh: async () => [foreign] });
        await expect(verifyCancellation(row(), account, d.value)).rejects.toMatchObject({ details: { missing: true } });
    });

    it('stops reading as soon as the server or account is gone', async () => {
        let switched = false;
        const cache = vi.fn(async () => { switched = true; return [row()]; });
        const d = deps({ cache, refresh: async () => [] }, { guard: () => { if (switched) throw new Error('刪單後伺服器已切換'); } });
        const error = await verifyCancellation(row(), account, d.value).catch(e => e);
        expect(error).toMatchObject({ code: 'CANCEL_UNCONFIRMED', details: { readError: '刪單後伺服器已切換' } });
        expect(cache).toHaveBeenCalledTimes(1);
        expect(calls(d.readTrades, true)).toBe(0);
    });

    it('without a continuous cache baseline skips cache reads and health, then reads refresh:true once', async () => {
        let local = false;
        const cancelled = row({ status: 'Cancelled', cancel_quantity: 1 });
        const d = deps({ cache: async () => [cancelled], refresh: async () => [cancelled] },
            { cacheTrusted: () => false, locallyCancelled: () => local });
        const sleep = d.value.sleep;
        let sleeps = 0;
        d.value.sleep = async ms => { sleeps += 1; if (sleeps === 2) local = true; await sleep(ms); };
        await expect(verifyCancellation(row(), account, d.value)).resolves.toMatchObject({ source: 'refresh' });
        expect(calls(d.readTrades, false)).toBe(0);
        expect(d.readHealth).not.toHaveBeenCalled();
        expect(calls(d.readTrades, true)).toBe(1);
        expect(sleeps).toBe(2); // waited for the local Cancel report, not the whole window
    });

    it('uses a later cancel\'s authoritative read as a free check before its own single refresh', async () => {
        const scope = `authoritative-${Math.random()}`;
        let clock = 0;
        const both = [row({ status: 'Cancelled', cancel_quantity: 1 }, { id: 'a' }), row({ status: 'Cancelled', cancel_quantity: 1 }, { id: 'b' })];
        const readTrades = vi.fn(async (refresh: boolean) => refresh ? both : [row({}, { id: 'a' }), row({}, { id: 'b' })]);
        const shared = { readTrades, readHealth: async () => healthy, scope, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
        const first = verifyCancellation(row({}, { id: 'a' }), account, shared);
        const second = verifyCancellation(row({}, { id: 'b' }), account, shared);
        await expect(first).resolves.toMatchObject({ source: 'refresh' });
        await expect(second).resolves.toMatchObject({ source: 'refresh' });
        expect(calls(readTrades, true)).toBe(1);
    });
    it('30 unconfirmed parallel cancels cost at most one refresh:true per account', async () => {
        const scope = `batch-${Math.random()}`;
        let clock = 0;
        const readTrades = vi.fn(async (_refresh: boolean) => Array.from({ length: 30 }, (_, i) => row({}, { id: `o${i}` })));
        const shared = { readTrades, readHealth: async () => healthy, scope, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
        const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => verifyCancellation(row({}, { id: `o${i}` }), account, shared)));
        expect(results.every(r => r.status === 'rejected' && (r.reason as { code?: string }).code === 'CANCEL_UNCONFIRMED')).toBe(true);
        expect(calls(readTrades, true)).toBe(1);
        // A second account in the same round gets its own single read.
        const readOther = vi.fn(async (_refresh: boolean) => [row({}, { id: 'x', account: other })]);
        await verifyCancellation(row({}, { id: 'x', account: other }), other, { ...shared, readTrades: readOther }).catch(() => undefined);
        expect(calls(readOther, true)).toBe(1);
    });
    it('does not reuse an authoritative read that started before its own cancel returned', async () => {
        const scope = `stale-${Math.random()}`;
        let clock = 0;
        const readTrades = vi.fn(async (_refresh: boolean) => [row({}, { id: 'a' }), row({}, { id: 'b' })]);
        const shared = { readTrades, readHealth: async () => healthy, scope, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
        await verifyCancellation(row({}, { id: 'a' }), account, shared).catch(() => undefined);
        clock += 10; // a later cancel, sent after the first round's refresh
        await verifyCancellation(row({}, { id: 'b' }), account, shared).catch(() => undefined);
        expect(calls(readTrades, true)).toBe(2);
    });
    it('treats an order Filled before the cancel as nothing left (known result)', async () => {
        const filled = row({ status: 'Filled', deal_quantity: 1, cancel_quantity: 0 });
        const d = deps({ cache: async () => [filled], refresh: async () => [] });
        await expect(verifyCancellation(row(), account, d.value)).resolves.toMatchObject({ trade: { status: { status: 'Filled' } }, source: 'cache' });
        expect(isConfirmedCancellation(row(), row({ status: 'Filled', deal_quantity: 0, cancel_quantity: 0 }))).toBe(false);
    });
    it('uses the larger of local and read-back order quantity', () => {
        const before = row({}, { quantity: 2 });
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', cancel_quantity: 2 }, { quantity: 3 }))).toBe(false);
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', cancel_quantity: 1 }, { quantity: 1 }))).toBe(false);
        expect(isConfirmedCancellation(before, row({ status: 'Cancelled', cancel_quantity: 2 }, { quantity: 1 }))).toBe(true);
    });
    it('never joins a read started before its own cancel returned, but shares later polling rounds', async () => {
        let clock = 0;
        const rounds: number[] = [];
        const readTrades = vi.fn(async () => {
            rounds.push(clock);
            return clock < 600 ? [row({}, { id: 'a' }), row({}, { id: 'b' })]
                : [row({ status: 'Cancelled', cancel_quantity: 1 }, { id: 'a' }), row({ status: 'Cancelled', cancel_quantity: 1 }, { id: 'b' })];
        });
        const shared = { readTrades, readHealth: async () => healthy, scope: `poll-${Math.random()}`, now: () => clock,
            sleep: async (ms: number) => { await Promise.resolve(); clock = Math.max(clock, ms * Math.ceil((clock + 1) / ms)); } };
        const first = verifyCancellation(row({}, { id: 'a' }), account, shared);
        const second = verifyCancellation(row({}, { id: 'b' }), account, shared); // returned after a's first read began
        await expect(first).resolves.toMatchObject({ source: 'cache' });
        await expect(second).resolves.toMatchObject({ source: 'cache' });
        expect(rounds[0]).toBe(0); expect(rounds[1]).toBe(0); // first round: two separate reads
        expect(readTrades.mock.calls.length).toBeLessThan(6); // later rounds shared
    });
});

describe('1.7.6 simulation read-back fixture (de-identified, regression only)', async () => {
    const fixture = (await import('./fixtures/native-simulation-cancel-readback-1.7.6.json')).default as unknown as Record<string, Trade>;
    const fxAccount = { account_type: 'F', broker_id: 'fixture', account_id: 'fixture' };
    it('never confirms from the HTTP cancel response, which is still Submitted with cancel_quantity 0', () => {
        expect(fixture.cancelResponse!.status).toMatchObject({ status: 'Submitted', cancel_quantity: 0, order_quantity: 0 });
        expect(isConfirmedCancellation(fixture.cacheBefore!, fixture.cancelResponse!)).toBe(false);
        expect(isConfirmedCancellation(fixture.cacheBefore!, fixture.cacheCancelled!)).toBe(true);
    });
    it('confirms reduce-then-cancel by the cumulative cancel_quantity (order.quantity 2, status.order_quantity 0)', () => {
        const before = fixture.reducedBefore!;
        expect(before.status).toMatchObject({ cancel_quantity: 1, order_quantity: 0 });
        expect(requiredCancelQuantity(before)).toBe(2);
        expect(isConfirmedCancellation(before, fixture.reducedCancelResponse!)).toBe(false);
        expect(isConfirmedCancellation(before, fixture.reducedCancelled!)).toBe(true);
    });
    it('confirms from the cache read that follows the projected Cancel', async () => {
        const cache = vi.fn().mockResolvedValueOnce([fixture.cancelResponse]).mockResolvedValue([fixture.cacheCancelled]);
        const d = deps({ cache, refresh: async () => [] });
        await expect(verifyCancellation(fixture.cacheBefore!, fxAccount, d.value)).resolves
            .toMatchObject({ source: 'cache', cacheReads: 2, trade: { status: { status: 'Cancelled', cancel_quantity: 1 } } });
    });
});
