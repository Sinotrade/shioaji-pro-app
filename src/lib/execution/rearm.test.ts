// 在新盤別重新啟用 (#201): the quantity comes from the current position, never
// silently from the lapsed order.
import { describe, expect, it, vi } from 'vitest';
import { mockPendingConfirmItem } from './pending-confirm-mock';

vi.mock('../trading-state', () => ({ getTradingState: () => ({}), subscribeTradingState: () => () => undefined }));
const { rearmPlan } = await import('./rearm');

const item = mockPendingConfirmItem({ state: 'expired', expiredAt: Date.now(),
    order: { ...mockPendingConfirmItem().order, action: 'Sell', quantity: 3, triggerCondition: 'below' } });
const pos = (direction: 'Buy' | 'Sell', quantity: number, accountId = '0000001') =>
    ({ code: 'TXFK6', direction, quantity, account: { account_type: 'F', broker_id: 'b', account_id: accountId } });

describe('rearmPlan', () => {
    it('a smaller position than the lapsed order: the position, and says so', () => {
        const p = rearmPlan(item, { known: true, positions: [pos('Buy', 2)] });
        expect(p.quantity).toBe(2);
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
    it('position unknown: no default, the user decides', () => {
        const p = rearmPlan(item, { known: false, positions: [] });
        expect(p.quantity).toBeNull();
        expect(p.notes.join()).toContain('持倉');
    });
});
