import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountedPosition } from './types/portfolio';

const mocks = vi.hoisted(() => ({
    quick: vi.fn(),
    stockExit: vi.fn(),
    ensure: vi.fn(),
}));
vi.mock('./trade', () => ({
    placeQuickOrder: mocks.quick,
    placeStockExitByShares: mocks.stockExit,
}));
vi.mock('./contracts-cache', () => ({ ensureContract: mocks.ensure }));

const { closePositionAtMarket, exitActionOf } = await import('./position-exit');

const futAccount = {
    account_type: 'F',
    person_id: 'p',
    broker_id: 'b',
    account_id: 'a',
    signed: true,
    username: 'u',
};

const future = (over: Partial<AccountedPosition> = {}): AccountedPosition =>
    ({
        id: 1,
        code: 'TXFI6',
        direction: 'Buy',
        quantity: 3,
        price: 23000,
        last_price: 23100,
        pnl: 300,
        account: futAccount,
        ...over,
    }) as AccountedPosition;

const stock = (over: Record<string, unknown> = {}): AccountedPosition =>
    ({
        id: 2,
        code: '2330',
        direction: 'Buy',
        quantity: 2000,
        price: 900,
        last_price: 910,
        pnl: 100,
        yd_quantity: 2000,
        cond: 'Cash',
        account: { ...futAccount, account_type: 'S' },
        ...over,
    }) as AccountedPosition;

beforeEach(() => {
    mocks.quick.mockReset().mockResolvedValue({});
    mocks.stockExit.mockReset().mockResolvedValue([]);
    mocks.ensure.mockReset().mockResolvedValue({ code: 'TXFI6', security_type: 'FUT' });
});

describe('平倉方向', () => {
    it('多單賣出、空單買回', () => {
        expect(exitActionOf(future({ direction: 'Buy' }))).toBe('Sell');
        expect(exitActionOf(future({ direction: 'Sell' }))).toBe('Buy');
    });
});

describe('期貨平倉', () => {
    it('以 Cover 送出反向市價單，數量等於持倉', async () => {
        const r = await closePositionAtMarket(future(), 'close');
        expect(r).toEqual({ exit: 'Sell', qty: 3 });
        expect(mocks.quick).toHaveBeenCalledWith(
            expect.anything(),
            'Sell',
            null, // 市價
            3,
            expect.objectContaining({ ocType: 'Cover', account: futAccount }),
        );
    });

    it('反手送雙倍數量、ocType 交給系統判斷', async () => {
        const r = await closePositionAtMarket(future(), 'reverse');
        expect(r.qty).toBe(6);
        expect(mocks.quick).toHaveBeenCalledWith(
            expect.anything(),
            'Sell',
            null,
            6,
            expect.objectContaining({ ocType: 'Auto' }),
        );
    });

    it('用持倉自己的帳戶，不拿目前選取帳戶補猜', async () => {
        const other = { ...futAccount, account_id: 'other' };
        await closePositionAtMarket(future({ account: other }), 'close');
        expect(mocks.quick.mock.calls[0]![4]).toMatchObject({ account: other });
    });
});

describe('股票平倉', () => {
    it('走股數平倉的路徑', async () => {
        mocks.ensure.mockResolvedValue({ code: '2330', security_type: 'STK' });
        const r = await closePositionAtMarket(stock(), 'close');
        expect(r).toEqual({ exit: 'Sell', qty: 2000 });
        expect(mocks.stockExit).toHaveBeenCalled();
        expect(mocks.quick).not.toHaveBeenCalled();
    });

    it('股票反手要另外確認交易條件，直接擋下', async () => {
        mocks.ensure.mockResolvedValue({ code: '2330', security_type: 'STK' });
        await expect(closePositionAtMarket(stock(), 'reverse')).rejects.toThrow('未送出委託');
        expect(mocks.stockExit).not.toHaveBeenCalled();
    });

    it('信用倉（非現股）也擋下 — 資券的條件猜不得', async () => {
        mocks.ensure.mockResolvedValue({ code: '2330', security_type: 'STK' });
        await expect(closePositionAtMarket(stock({ cond: 'MarginTrading' }), 'close')).rejects.toThrow(
            '未送出委託',
        );
        expect(mocks.stockExit).not.toHaveBeenCalled();
    });
});

// 這些情境的共同要求：throw 之前一張委託都不能送出，呼叫端的錯誤訊息
// 才敢說「未送出」。所以每一條都連帶驗兩個下單函式都沒被呼叫。
describe('寧可不送', () => {
    const rejects = async (p: AccountedPosition) => {
        await expect(closePositionAtMarket(p, 'close')).rejects.toThrow('未送出委託');
        expect(mocks.quick).not.toHaveBeenCalled();
        expect(mocks.stockExit).not.toHaveBeenCalled();
    };

    it('沒有帳戶歸屬', () => rejects(future({ account: undefined })));
    it('帳戶未簽署', () =>
        rejects(future({ account: { ...futAccount, signed: false } })));
    it('帳戶缺 broker_id', () =>
        rejects(future({ account: { ...futAccount, broker_id: '' } })));
    it('持倉單位與帳戶市場不符（期貨倉掛在股票帳戶）', () =>
        rejects(future({ account: { ...futAccount, account_type: 'S' } })));
    it('數量為零', () => rejects(future({ quantity: 0 })));
    it('數量不是整數', () => rejects(future({ quantity: 1.5 })));
    it('方向不明', () =>
        rejects(future({ direction: 'Long' as unknown as 'Buy' })));

    it('商品與帳戶市場不符 — 查到合約才發現，仍然不送', async () => {
        mocks.ensure.mockResolvedValue({ code: '2330', security_type: 'STK' });
        await rejects(future());
    });
});
