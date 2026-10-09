// 在新盤別重新啟用 (#201): the quantity comes from a fresh position read of
// the same account (broker + account id), never silently from the lapsed
// order or an old snapshot.
import { describe, expect, it, vi } from 'vitest';
import { mockPendingConfirmItem } from './pending-confirm-mock';

vi.mock('../trading-state', () => ({ getTradingState: () => ({}), subscribeTradingState: () => () => undefined,
    refreshTradingState: async () => undefined }));
const { checkRearmQuantity, rearmPlan } = await import('./rearm');

const item = mockPendingConfirmItem({ state: 'expired', expiredAt: Date.now(),
    account: { accountType: 'F', accountId: '0000001', brokerId: 'F002000' },
    order: { ...mockPendingConfirmItem().order, action: 'Sell', quantity: 3, triggerCondition: 'below' } });
const pos = (direction: 'Buy' | 'Sell', quantity: number, accountId = '0000001', brokerId = 'F002000') =>
    ({ code: 'TXFK6', direction, quantity, account: { account_type: 'F', broker_id: brokerId, account_id: accountId } });

describe('rearmPlan', () => {
    it('a smaller position than the lapsed order: the position, and says so', () => {
        const p = rearmPlan(item, { known: true, positions: [pos('Buy', 2)] });
        expect(p.quantity).toBe(2);
        expect(p.closable).toBe(2);
        expect(p.notes.join()).toContain('2 口');
    });
    it('a position as large: the original quantity', () => {
        expect(rearmPlan(item, { known: true, positions: [pos('Buy', 5)] }).quantity).toBe(3);
    });
    it('no position to close: no default, the user decides (it would open one)', () => {
        const p = rearmPlan(item, { known: true, positions: [pos('Buy', 4, 'other')] });
        expect(p.quantity).toBeNull();
        expect(p.notes.join()).toContain('新開部位');
    });
    it('the same account id at another broker is another account', () => {
        expect(rearmPlan(item, { known: true, positions: [pos('Buy', 4, '0000001', 'F009999')] }).quantity).toBeNull();
    });
    it('position unknown, or an item without its broker: no default, the user decides', () => {
        const p = rearmPlan(item, { known: false, positions: [] });
        expect(p.quantity).toBeNull();
        expect(p.notes.join()).toContain('持倉');
        const noBroker = { ...item, account: { accountType: 'F' as const, accountId: '0000001', brokerId: null } };
        expect(rearmPlan(noBroker, { known: true, positions: [pos('Buy', 4)] }).quantity).toBeNull();
    });
});

describe('checkRearmQuantity (right before sending the decision)', () => {
    it('refuses more than the closable position, allows up to it', () => {
        const view = { known: true, positions: [pos('Buy', 2)] };
        expect(checkRearmQuantity(item, 3, view)).toContain('2 口');
        expect(checkRearmQuantity(item, 2, view)).toBeNull();
    });
    it('no closable position or unknown: the typed quantity stands (shown as opening / unconfirmed)', () => {
        expect(checkRearmQuantity(item, 3, { known: true, positions: [] })).toBeNull();
        expect(checkRearmQuantity(item, 3, { known: false, positions: [] })).toBeNull();
    });
});
