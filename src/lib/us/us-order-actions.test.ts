import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const m = vi.hoisted(() => ({ cancel: vi.fn(), reduce: vi.fn(), place: vi.fn(), refresh: vi.fn(), rows: [] as unknown[], locked: false, sameEnv: true }));
vi.mock('../server-info-store', () => ({
    SERVER_MODE_CHANGED_MESSAGE: '確認期間伺服器或模式已變更，這筆沒有送出，請重新下單',
    captureServerMode: () => () => m.sameEnv,
}));
vi.mock('../account-store', () => ({ getAccountState: () => ({ accounts: [H] }) }));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../risk', () => ({ checkUsOrderAllowed: () => (m.locked ? '風控鎖啟動中 — 所有下單已封鎖' : null) }));
vi.mock('./us-api', () => ({
    cancelUsOrder: m.cancel, reduceUsOrderQty: m.reduce, placeUsOrder: m.place,
    usErrorText: (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3}\s+/, '') : String(e)),
}));
vi.mock('./us-trading-state', async () => {
    const real = await vi.importActual<typeof import('./us-trading-state')>('./us-trading-state');
    return { usRemaining: real.usRemaining, observeUsTrade: vi.fn(), refreshUsAccount: m.refresh, getUsTradingState: () => ({ trades: m.rows }) };
});

import { cancelUsTrade, placeReplacement, priceChangeProblem, reduceUsTrade, replacementOrder, UsCancelTooEarlyError } from './us-order-actions';
import type { AccountedUsTrade } from '../types/us';
import type { ServerModeGuard } from '../server-info-store';

const env = (same: () => boolean) => same as unknown as ServerModeGuard;

const row = (status: Partial<AccountedUsTrade['status']> = {}): AccountedUsTrade => ({
    account: H,
    contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
    order: { id: 't1', seqno: '1', ordno: 'A1', action: 'Buy', price: '173.97', quantity: '10', price_type: 'LMT', time_in_force: 'DAY' },
    status: { id: 't1', status: 'Submitted', status_code: '00', order_quantity: '10', deal_quantity: '0', cancel_quantity: '0', msg: '', deals: [], ...status },
});

beforeEach(() => {
    vi.clearAllMocks();
    m.locked = false;
    m.sameEnv = true;
    m.rows = [];
    m.refresh.mockResolvedValue(undefined);
});

describe('cancelUsTrade', () => {
    it('maps -2054 to the friendly retry message without reading back', async () => {
        m.cancel.mockRejectedValue(new Error('400 此委託不存在 -2054'));
        await expect(cancelUsTrade(row())).rejects.toBeInstanceOf(UsCancelTooEarlyError);
        await expect(cancelUsTrade(row())).rejects.toThrow('剛送出的委託稍後再刪');
        expect(m.refresh).not.toHaveBeenCalled();
    });

    it('confirms by read-back and reports shares actually cancelled (fills meanwhile excluded)', async () => {
        m.cancel.mockResolvedValue({});
        m.rows = [row()];
        m.refresh.mockImplementation(async () => { m.rows = [row({ status: 'Cancelled', deal_quantity: '2', cancel_quantity: '8' })]; });
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, cancelled: '8' });
        expect(m.refresh).toHaveBeenCalledWith(H);
    });

    it('uses the freshest row as the baseline, not the stale one passed in', async () => {
        m.cancel.mockResolvedValue({});
        // 畫面上的舊列：未成交 10；狀態裡已成交 6
        const fresh = row({ status: 'PartFilled', deal_quantity: '6' });
        m.rows = [fresh];
        m.refresh.mockImplementation(async () => { m.rows = [row({ status: 'Cancelled', deal_quantity: '6', cancel_quantity: '4' })]; });
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, cancelled: '4' });
    });

    it('does not treat Failed or Inactive as a confirmed cancel', async () => {
        m.cancel.mockResolvedValue({});
        m.rows = [row()];
        m.refresh.mockImplementation(async () => { m.rows = [row({ status: 'Failed' })]; });
        expect((await cancelUsTrade(row(), { readAttempts: 1, readDelayMs: 0 })).confirmed).toBe(false);
        m.rows = [row()];
        m.refresh.mockImplementation(async () => { m.rows = [row({ status: 'Inactive' })]; });
        expect((await cancelUsTrade(row(), { readAttempts: 1, readDelayMs: 0 })).confirmed).toBe(false);
    });

    it('rejects a read-back whose fills went backwards (older snapshot)', async () => {
        m.cancel.mockResolvedValue({});
        m.rows = [row({ status: 'PartFilled', deal_quantity: '3' })];
        m.refresh.mockImplementation(async () => { m.rows = [row({ status: 'Cancelled', deal_quantity: '1', cancel_quantity: '9' })]; });
        expect((await cancelUsTrade(row(), { readAttempts: 1, readDelayMs: 0 })).confirmed).toBe(false);
    });

    it('accepts cancel_quantity covering the remainder as evidence', async () => {
        m.cancel.mockResolvedValue({});
        m.rows = [row()];
        m.refresh.mockImplementation(async () => { m.rows = [row({ status: 'Submitted', deal_quantity: '2', cancel_quantity: '8' })]; });
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, cancelled: '8' });
    });

    it('stops reading back when the server or mode changed', async () => {
        m.cancel.mockResolvedValue({});
        m.rows = [row({ status: 'Cancelled', cancel_quantity: '10' })];
        m.sameEnv = false;
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r.confirmed).toBe(false);
        expect(m.refresh).not.toHaveBeenCalled();
    });

    it('stays unconfirmed when the order is still working after the reads', async () => {
        m.cancel.mockResolvedValue({});
        m.rows = [row()];
        const r = await cancelUsTrade(row(), { readAttempts: 2, readDelayMs: 0 });
        expect(r.confirmed).toBe(false);
        expect(m.refresh).toHaveBeenCalledTimes(2);
    });
});

describe('reduceUsTrade', () => {
    it('sends the amount to reduce and bounds it by the remainder', async () => {
        m.reduce.mockResolvedValue({ order: { id: 't1' } });
        await reduceUsTrade(row(), 4);
        expect(m.reduce).toHaveBeenCalledWith('t1', 4, H);
        await expect(reduceUsTrade(row(), 11)).rejects.toThrow('1 到 10');
    });
});

describe('price change = cancel then re-place', () => {
    it('re-places only what step 1 cancelled, same side and time in force', () => {
        expect(replacementOrder(row(), '8', '170.5')).toEqual({ action: 'Buy', price: '170.5', quantity: 8, price_type: 'LMT', time_in_force: 'DAY' });
        expect(replacementOrder(row(), '0', '170.5')).toContain('沒有取消任何股數');
        const opg = row();
        opg.order.time_in_force = 'OPG';
        expect(replacementOrder(opg, '8', '170.5')).toContain('OPG');
    });

    it('validates the new price', () => {
        expect(priceChangeProblem(row(), '173.97')).toBe('新價格和原價格相同');
        expect(priceChangeProblem(row(), '1.23456')).toContain('4 位小數');
        expect(priceChangeProblem(row({ status: 'Filled', deal_quantity: '10' }), '170')).toContain('沒有剩餘');
        expect(priceChangeProblem(row(), '170')).toBeNull();
    });

    const order = { action: 'Buy', price: '170', quantity: 8, price_type: 'LMT', time_in_force: 'DAY' } as const;

    it('step 2 still honours the kill switch', async () => {
        m.locked = true;
        await expect(placeReplacement(row(), order, env(() => true))).rejects.toThrow('風控鎖');
        expect(m.place).not.toHaveBeenCalled();
    });

    it('step 2 re-checks the kill switch right before dispatch', async () => {
        m.place.mockImplementation(async (_c, _o, _a, opts: { beforeDispatch: () => void }) => { m.locked = true; opts.beforeDispatch(); return {}; });
        await expect(placeReplacement(row(), order, env(() => true))).rejects.toThrow('風控鎖');
    });

    it('step 2 refuses when the server or mode differs from step 1', async () => {
        await expect(placeReplacement(row(), order, env(() => false))).rejects.toThrow('刪單時不同');
        expect(m.place).not.toHaveBeenCalled();
        let same = true;
        m.place.mockImplementation(async (_c, _o, _a, opts: { beforeDispatch: () => void }) => { same = false; opts.beforeDispatch(); return {}; });
        await expect(placeReplacement(row(), order, env(() => same))).rejects.toThrow('刪單時不同');
    });

    it('allows a price change on an ATC limit order', () => {
        const atc = row();
        atc.order.time_in_force = 'ATC';
        expect(priceChangeProblem(atc, '170')).toBeNull();
        expect(replacementOrder(atc, '8', '170')).toMatchObject({ time_in_force: 'ATC', quantity: 8 });
    });
});
