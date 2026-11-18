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

import { cancelUsTrade, mergeMonotonic, placeReplacement, priceChangeProblem, reduceUsTrade, replacementOrder, UsCancelTooEarlyError } from './us-order-actions';
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
    /** 伺服器狀態：刪單送出前回讀看到 pre，送出後回讀看到 post */
    function server(pre: AccountedUsTrade, post: AccountedUsTrade) {
        let sent = false;
        m.cancel.mockImplementation(async () => { sent = true; return {}; });
        m.refresh.mockImplementation(async () => { m.rows = [sent ? post : pre]; });
    }

    it('maps -2054 to the friendly retry message', async () => {
        m.rows = [row()];
        m.cancel.mockRejectedValue(new Error('400 此委託不存在 -2054'));
        await expect(cancelUsTrade(row())).rejects.toBeInstanceOf(UsCancelTooEarlyError);
        await expect(cancelUsTrade(row())).rejects.toThrow('剛送出的委託稍後再刪');
    });

    it('confirms by read-back and reports shares actually cancelled (fills meanwhile excluded)', async () => {
        server(row(), row({ status: 'Cancelled', deal_quantity: '2', cancel_quantity: '8' }));
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, cancelled: '8' });
        expect(m.refresh).toHaveBeenCalledWith(H);
    });

    it('reads the order back from the server before cancelling (another terminal reduced it)', async () => {
        // App 畫面：未成交 10；伺服器：別的終端機已減量 6 → 只剩 4
        m.rows = [row()];
        server(row({ cancel_quantity: '6' }), row({ status: 'Cancelled', cancel_quantity: '10' }));
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, cancelled: '4' });
        expect(m.refresh.mock.invocationCallOrder[0]).toBeLessThan(m.cancel.mock.invocationCallOrder[0]!);
    });

    it('merges a stale pre-cancel read-back monotonically with the locally known row', async () => {
        // 本機：回報已投影取消 6；伺服器回讀較舊：取消 0。刪剩下 4 → 最多重下 4
        m.rows = [row({ cancel_quantity: '6' })];
        server(row({ cancel_quantity: '0' }), row({ status: 'Cancelled', cancel_quantity: '10' }));
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, cancelled: '4' });
        const step2 = replacementOrder(row(), r.cancelled!, '170');
        expect(typeof step2 === 'string' ? 0 : step2.quantity).toBeLessThanOrEqual(4);
    });

    it('never regresses a terminal local status or lower fills in the baseline', () => {
        const merged = mergeMonotonic(
            row({ status: 'Cancelled', deal_quantity: '5', cancel_quantity: '5' }),
            row({ status: 'Submitted', deal_quantity: '3', cancel_quantity: '0', order_quantity: '9' }),
        );
        expect(merged.status).toMatchObject({ status: 'Cancelled', deal_quantity: '5', cancel_quantity: '5', order_quantity: '9' });
    });

    it('does not cancel when the pre-cancel read-back fails', async () => {
        m.refresh.mockRejectedValue(new Error('503'));
        await expect(cancelUsTrade(row())).rejects.toThrow('未刪單');
        expect(m.cancel).not.toHaveBeenCalled();
    });

    it('reports fully filled before cancel, with nothing to re-place', async () => {
        server(row(), row({ status: 'Filled', deal_quantity: '10' }));
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r).toMatchObject({ confirmed: true, filled: true, cancelled: '0' });
        // 回讀時已全部成交：不送刪單
        server(row({ status: 'Filled', deal_quantity: '10' }), row({ status: 'Filled', deal_quantity: '10' }));
        m.cancel.mockClear();
        expect(await cancelUsTrade(row(), { readDelayMs: 0 })).toMatchObject({ filled: true });
        expect(m.cancel).not.toHaveBeenCalled();
    });

    it.each([
        ['Failed', { status: 'Failed' }],
        ['Inactive without cancel', { status: 'Inactive' }],
        ['Cancelled with nothing cancelled', { status: 'Cancelled', deal_quantity: '0', cancel_quantity: '0' }],
        ['PendingSubmit with cancel_quantity', { status: 'PendingSubmit', cancel_quantity: '10' }],
        ['Submitted with cancel_quantity', { status: 'Submitted', deal_quantity: '2', cancel_quantity: '8' }],
    ] as const)('does not confirm on %s', async (_name, post) => {
        server(row(), row(post as Partial<AccountedUsTrade['status']>));
        expect((await cancelUsTrade(row(), { readAttempts: 1, readDelayMs: 0 })).confirmed).toBe(false);
    });

    it('requires deal + cancel to cover the larger of the baseline and read-back order quantity', async () => {
        const shrunk = row({ status: 'Cancelled', cancel_quantity: '6' });
        shrunk.order = { ...shrunk.order, quantity: '6' };
        server(row(), shrunk);
        expect((await cancelUsTrade(row(), { readAttempts: 1, readDelayMs: 0 })).confirmed).toBe(false);
    });

    it('rejects a read-back whose fills went backwards (older snapshot)', async () => {
        server(row({ status: 'PartFilled', deal_quantity: '3' }), row({ status: 'Cancelled', deal_quantity: '1', cancel_quantity: '9' }));
        expect((await cancelUsTrade(row(), { readAttempts: 1, readDelayMs: 0 })).confirmed).toBe(false);
    });

    it('stops reading back when the server or mode changed', async () => {
        server(row(), row({ status: 'Cancelled', cancel_quantity: '10' }));
        m.cancel.mockImplementation(async () => { m.sameEnv = false; return {}; });
        const r = await cancelUsTrade(row(), { readDelayMs: 0 });
        expect(r.confirmed).toBe(false);
        expect(m.refresh).toHaveBeenCalledTimes(1);
    });

    it('stays unconfirmed when the order is still working after the reads', async () => {
        server(row(), row());
        const r = await cancelUsTrade(row(), { readAttempts: 2, readDelayMs: 0 });
        expect(r.confirmed).toBe(false);
        expect(m.refresh).toHaveBeenCalledTimes(3);
    });
});

describe('reduceUsTrade', () => {
    it('sends the amount to reduce and bounds it by the remainder', async () => {
        m.reduce.mockResolvedValue({ order: { id: 't1' } });
        await reduceUsTrade(row(), 4);
        expect(m.reduce).toHaveBeenCalledWith('t1', 4, H);
        await expect(reduceUsTrade(row(), 11)).rejects.toThrow('1 到 10');
    });

    it('maps the HTTP 400 -2054 rejection to the retry-later message', async () => {
        m.reduce.mockRejectedValue(Object.assign(new Error('400 此委託不存在 (-2054)'), { status: 400 }));
        await expect(reduceUsTrade(row(), 1)).rejects.toBeInstanceOf(UsCancelTooEarlyError);
    });

    it('refuses to reduce an order with nothing left', async () => {
        await expect(reduceUsTrade(row({ status: 'Filled', deal_quantity: '10' }), 1)).rejects.toThrow('1 到 0');
        expect(m.reduce).not.toHaveBeenCalledWith('t1', 1, H);
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
