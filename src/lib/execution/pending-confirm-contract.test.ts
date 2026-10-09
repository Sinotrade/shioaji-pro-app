// src/lib/execution/pending-confirm-contract.test.ts — wire validation of the
// App ↔ background engine 待確認 contract (#201 ③).

import { describe, expect, it } from 'vitest';
import {
    PENDING_CONFIRM_CHANGED_EVENT,
    PENDING_CONFIRM_COMMAND,
    PENDING_CONFIRM_CONTRACT_VERSION,
    parsePendingConfirmSnapshot,
    parseResolvePendingResult,
    resolutionAllowed,
} from './pending-confirm-contract';

const wireItem = (over: Record<string, unknown> = {}) => ({
    id: 'k-1',
    revision: 3,
    state: 'needsConfirm',
    owner: { kind: 'trigger', id: 't-1', leg: 'stop' },
    order: {
        code: 'TXFK6', name: '台指期 11', action: 'Sell', quantity: 1, quantityUnit: 'contract',
        priceType: 'MKT', price: null, orderType: 'IOC', triggerPrice: 17860,
    },
    account: { accountType: 'F', accountId: '0000001' },
    env: 'http://127.0.0.1:1|simulation',
    tag: 'AB12CD',
    submittedAt: 1_760_000_000_000,
    session: { tradingDay: '2026-10-08', period: 'day' },
    listingChecks: 3,
    lastCheckedAt: 1_760_000_010_000,
    expiredAt: null,
    ...over,
});

describe('pending confirm contract', () => {
    it('names the Tauri commands and event the backend implements', () => {
        expect(PENDING_CONFIRM_COMMAND).toEqual({
            list: 'execution_list_pending_confirm',
            resolve: 'execution_resolve_pending',
        });
        expect(PENDING_CONFIRM_CHANGED_EVENT).toBe('execution://pending-confirm-changed');
        expect(PENDING_CONFIRM_CONTRACT_VERSION).toBe(2);
    });

    it('accepts a well-formed snapshot', () => {
        const snap = parsePendingConfirmSnapshot({ version: 1, runId: 'r', sequence: 1, uncleanShutdown: true, items: [wireItem()] });
        expect(snap.uncleanShutdown).toBe(true);
        expect(snap.items[0]!.order.priceType).toBe('MKT');
        expect(snap.items[0]!.owner).toEqual({ kind: 'trigger', id: 't-1', leg: 'stop' });
    });

    it.each([
        ['wrong version', { version: 3, runId: 'r', sequence: 1, uncleanShutdown: false, items: [] }],
        ['missing items', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false }],
        ['unknown state', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ state: 'retry' })] }],
        ['bad quantity', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ order: { ...wireItem().order, quantity: 0 } })] }],
        ['LMT without price', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ order: { ...wireItem().order, priceType: 'LMT', price: null } })] }],
        ['LMT with zero price', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ order: { ...wireItem().order, priceType: 'LMT', price: 0 } })] }],
        ['MKT carrying a price', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ order: { ...wireItem().order, price: 17850 } })] }],
        ['unknown quantity unit', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ order: { ...wireItem().order, quantityUnit: 'board' } })] }],
        ['missing runId', { version: 1, sequence: 1, uncleanShutdown: false, items: [] }],
        ['negative sequence', { version: 1, runId: 'r', sequence: -1, uncleanShutdown: false, items: [] }],
        ['impossible trading day', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ session: { tradingDay: '2026-99-99', period: 'day' } })] }],
        ['unrenderable time', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ submittedAt: 1e100 })] }],
        ['bad action', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ order: { ...wireItem().order, action: 'buy' } })] }],
        ['bad session', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ session: { tradingDay: '10/08', period: 'day' } })] }],
        ['expired without time', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem({ state: 'expired', expiredAt: null })] }],
        ['duplicate id', { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem(), wireItem()] }],
        ['not an object', null],
    ])('rejects %s (fail closed, never silently drops an item)', (_name, raw) => {
        expect(() => parsePendingConfirmSnapshot(raw)).toThrow();
    });

    it('only lets each state take its own resolutions', () => {
        expect(resolutionAllowed('needsConfirm', 'confirmedSent')).toBe(true);
        expect(resolutionAllowed('needsConfirm', 'confirmedNotSent')).toBe(true);
        expect(resolutionAllowed('needsConfirm', 'acknowledgeExpired')).toBe(false);
        expect(resolutionAllowed('expired', 'acknowledgeExpired')).toBe(true);
        expect(resolutionAllowed('expired', 'confirmedSent')).toBe(false);
        expect(resolutionAllowed('expired', 'confirmedNotSent')).toBe(false);
    });

    it('parses resolve results, including a refusal with the fresh snapshot', () => {
        const snapshot = { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [] };
        expect(parseResolvePendingResult({ ok: true, snapshot }).ok).toBe(true);
        const refused = parseResolvePendingResult({ ok: false, reason: 'stale', snapshot });
        expect(refused).toMatchObject({ ok: false, reason: 'stale' });
        expect(() => parseResolvePendingResult({ ok: false, reason: 'resend', snapshot })).toThrow();
    });
});

describe('contract v2: rearm in the new session', () => {
    it('reads v2 snapshots with the trigger condition, and still reads v1', () => {
        expect(PENDING_CONFIRM_CONTRACT_VERSION).toBe(2);
        const v2 = parsePendingConfirmSnapshot({ version: 2, runId: 'r', sequence: 1, uncleanShutdown: false,
            items: [wireItem({ order: { ...wireItem().order, triggerCondition: 'below' } })] });
        expect(v2.items[0]!.order.triggerCondition).toBe('below');
        const withBroker = parsePendingConfirmSnapshot({ version: 2, runId: 'r', sequence: 1, uncleanShutdown: false,
            items: [wireItem({ account: { accountType: 'F', accountId: '0000001', brokerId: 'F002000' } })] });
        expect(withBroker.items[0]!.account.brokerId).toBe('F002000');
        expect(v2.items[0]!.account.brokerId).toBeNull();
        const v1 = parsePendingConfirmSnapshot({ version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [wireItem()] });
        expect(v1.version).toBe(1);
        expect(v1.items[0]!.order.triggerCondition).toBeNull();
        expect(() => parsePendingConfirmSnapshot({ version: 3, runId: 'r', sequence: 1, uncleanShutdown: false, items: [] })).toThrow();
        expect(() => parsePendingConfirmSnapshot({ version: 2, runId: 'r', sequence: 1, uncleanShutdown: false,
            items: [wireItem({ order: { ...wireItem().order, triggerCondition: 'sideways' } })] })).toThrow();
    });

    it('only an expired item can be rearmed, and new refusals are understood', () => {
        expect(resolutionAllowed('expired', 'rearmInNewSession')).toBe(true);
        expect(resolutionAllowed('needsConfirm', 'rearmInNewSession')).toBe(false);
        const snapshot = { version: 2, runId: 'r', sequence: 1, uncleanShutdown: false, items: [] };
        for (const reason of ['notEnabled', 'invalidRequest', 'rearmFailed']) {
            expect(parseResolvePendingResult({ ok: false, reason, snapshot })).toMatchObject({ ok: false, reason });
        }
    });
});
