// 台股庫存明細／沖銷明細：欄位對照 SDK 1.8、快取 id 的防呆、日期格式
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ posDetail: vi.fn(), pnl: vi.fn(), pnlDetail: vi.fn() }));
// fetchProfitLossDetailOf 的行為：查當天列表 → pick → 用找回的 id 查明細（鎖另見 profit-loss-cache-lock.test）
vi.mock('./shioaji', () => ({
    fetchPositionDetail: m.posDetail,
    fetchProfitLossDetailOf: async (market: string, account: unknown, day: string, pick: (rows: unknown[]) => { id: number } | undefined) => {
        const row = pick(await m.pnl(market, account, day));
        return row ? { row, detail: await m.pnlDetail(market, account, row.id) } : null;
    },
}));

import {
    fetchTwPositionDetail,
    fetchTwProfitDetail,
    normalizePositionDetail,
    normalizeProfitDetail,
    sameRealizedRow,
    TW_PNL_DETAIL_MISMATCH,
    TW_POSITION_DETAIL_MISMATCH,
    twCondLabel,
    twIsoDate,
} from './tw-account-detail';
import type { Account } from './types/portfolio';

const S = { account_type: 'S', broker_id: '9A95', account_id: '0000001', signed: true, person_id: '', username: '' } as Account;
const F = { ...S, account_type: 'F', broker_id: 'F002' } as Account;

// SDK 1.8 StockPositionDetail／FuturePositionDetail 的 JSON（src/api/api_v1/portf/position_detail.rs）
const stockLot = (over: Record<string, unknown> = {}) => ({
    date: '2026-11-03', code: '2330', quantity: 2, price: 1000, last_price: 1100, dseq: 'AA1', direction: 'Buy', pnl: 199000,
    currency: 'TWD', fee: 1425, cond: 'Cash', ex_dividends: 0, interest: 0, margintrading_amt: 0, collateral: 0, ...over,
});
const futLot = (over: Record<string, unknown> = {}) => ({
    date: '20261103', code: 'TXFL6', quantity: 1, price: 23000, last_price: 22900, dseq: 'BB1', direction: 'Sell', pnl: 20000,
    currency: 'TWD', fee: 60, entry_quantity: 2, ...over,
});

beforeEach(() => { Object.values(m).forEach(f => f.mockReset()); });

it('normalizes dates from YYYYMMDD and YYYY-MM-DD', () => {
    expect(twIsoDate('20261020')).toBe('2026-10-20');
    expect(twIsoDate('2026-11-16')).toBe('2026-11-16');
    expect(twIsoDate(' 2026-11-16 ')).toBe('2026-11-16');
    expect(twIsoDate('')).toBe('');
});

it('maps stock and futures position detail fields as the SDK returns them', () => {
    const [s] = normalizePositionDetail('S', [stockLot({ cond: 'MarginTrading', margintrading_amt: 1200000 })]);
    expect(s).toMatchObject({ market: 'S', date: '2026-11-03', code: '2330', quantity: 2, price: 1000, last_price: 1100, pnl: 199000, fee: 1425, cond: 'MarginTrading', margintrading_amt: 1200000 });
    const [f] = normalizePositionDetail('F', [futLot()]);
    expect(f).toMatchObject({ market: 'F', date: '2026-11-03', code: 'TXFL6', quantity: 1, entry_quantity: 2, direction: 'Sell', price: 23000, pnl: 20000, fee: 60 });
    expect(normalizePositionDetail('S', null)).toEqual([]);
});

it('maps stock and futures profit detail fields as the SDK returns them', () => {
    const [s] = normalizeProfitDetail('S', [{ date: '2026-11-03', code: '2330', quantity: 1500, dseq: 'X', fee: 20, tax: 0, currency: 'TWD', price: 1000, cost: 1500020, rep_margintrading_amt: 0, rep_collateral: 0, rep_margin: 0, shortselling_fee: 0, ex_dividend_amt: 0, interest: 3, trade_type: 'DayTrade', cond: 'Cash' }]);
    expect(s).toMatchObject({ market: 'S', quantity: 1500, price: 1000, cost: 1500020, fee: 20, tax: 0, interest: 3, trade_type: 'DayTrade' });
    const [f] = normalizeProfitDetail('F', [{ date: '20261120', code: 'MXFL6', quantity: 1, dseq: 'Y', fee: 25.5, tax: 93, currency: 'TWD', direction: 'Buy', entry_date: '20261118', entry_quantity: 2, entry_seqno: 'E1', entry_price: 23000, cover_price: 23100, pnl: 5000 }]);
    expect(f).toMatchObject({ market: 'F', date: '2026-11-20', entry_date: '2026-11-18', quantity: 1, entry_quantity: 2, entry_price: 23000, cover_price: 23100, pnl: 5000, fee: 25.5, tax: 93, direction: 'Buy' });
});

it('position detail sends the row id and rejects lots of another row (stale sidecar cache)', async () => {
    m.posDetail.mockResolvedValue([stockLot()]);
    await expect(fetchTwPositionDetail(S, 'S', { id: 4, code: '2330', direction: 'Buy', cond: 'Cash' })).resolves.toHaveLength(1);
    expect(m.posDetail).toHaveBeenCalledWith('S', S, 4);
    // 代碼不同
    await expect(fetchTwPositionDetail(S, 'S', { id: 4, code: '2317', direction: 'Buy', cond: 'Cash' })).rejects.toThrow(TW_POSITION_DETAIL_MISMATCH);
    // 同代碼、不同交易條件（現股 vs 融資）
    await expect(fetchTwPositionDetail(S, 'S', { id: 4, code: '2330', direction: 'Buy', cond: 'MarginTrading' })).rejects.toThrow(TW_POSITION_DETAIL_MISMATCH);
    m.posDetail.mockResolvedValue([futLot()]);
    await expect(fetchTwPositionDetail(F, 'F', { id: 0, code: 'TXFL6', direction: 'Buy' })).rejects.toThrow(TW_POSITION_DETAIL_MISMATCH);
    await expect(fetchTwPositionDetail(F, 'F', { id: 0, code: 'TXFL6', direction: 'Sell' })).resolves.toHaveLength(1);
    // 券商代碼前後空白、全形不影響比對
    m.posDetail.mockResolvedValue([futLot({ code: 'TXFL6  ' })]);
    await expect(fetchTwPositionDetail(F, 'F', { id: 0, code: 'TXFL6', direction: 'Sell' })).resolves.toHaveLength(1);
});

const stockRow = { id: 7, code: '2330', quantity: 1500, pnl: 4321, date: '2026-11-20', dseq: 'D1', price: 1010, pr_ratio: 0.01, pnl_pct: 1, cond: 'Cash', seqno: 'S1' };
const futRow = { id: 2, code: 'MXFK6', quantity: 1, pnl: -14850, date: '20261020', entry_price: 46681, cover_price: 46384, tax: 93, fee: 25, direction: 'Buy' as const };

it('matches realized rows by content, not by the cache id', () => {
    expect(sameRealizedRow(stockRow, { ...stockRow, id: 0 })).toBe(true);
    expect(sameRealizedRow(stockRow, { ...stockRow, dseq: 'D2' })).toBe(false);
    expect(sameRealizedRow(futRow, { ...futRow, id: 9, date: '2026-10-20' })).toBe(true);
    expect(sameRealizedRow(futRow, { ...futRow, direction: 'Sell' })).toBe(false);
    expect(sameRealizedRow(futRow, stockRow)).toBe(false);
});

it('profit detail re-queries that day first, then asks with the refreshed id (stock in shares)', async () => {
    m.pnl.mockResolvedValue([{ ...stockRow, id: 0, dseq: 'OTHER' }, { ...stockRow, id: 1 }]);
    m.pnlDetail.mockResolvedValue([{ date: '2026-11-03', code: '2330', quantity: 1500, price: 1000, cost: 1500020, fee: 20, tax: 0 }]);
    const rows = await fetchTwProfitDetail(S, 'S', stockRow);
    expect(m.pnl).toHaveBeenCalledWith('S', S, '2026-11-20');
    expect(m.pnlDetail).toHaveBeenCalledWith('S', S, 1);
    expect(rows[0]).toMatchObject({ market: 'S', quantity: 1500, cost: 1500020 });
});

it('futures profit detail converts the YYYYMMDD row date for the re-query', async () => {
    m.pnl.mockResolvedValue([{ ...futRow, id: 5 }]);
    m.pnlDetail.mockResolvedValue([{ date: '20261020', code: 'MXFK6', quantity: 1, direction: 'Buy', entry_date: '20261019', entry_price: 46681, cover_price: 46384, pnl: -14850, fee: 25, tax: 93 }]);
    await fetchTwProfitDetail(F, 'F', futRow);
    expect(m.pnl).toHaveBeenCalledWith('F', F, '2026-10-20');
    expect(m.pnlDetail).toHaveBeenCalledWith('F', F, 5);
});

it('profit detail refuses when the row is gone or the detail is for another symbol', async () => {
    m.pnl.mockResolvedValue([]);
    await expect(fetchTwProfitDetail(S, 'S', stockRow)).rejects.toThrow(TW_PNL_DETAIL_MISMATCH);
    expect(m.pnlDetail).not.toHaveBeenCalled();
    m.pnl.mockResolvedValue([stockRow]);
    m.pnlDetail.mockResolvedValue([{ code: '2317', quantity: 1000 }]);
    await expect(fetchTwProfitDetail(S, 'S', stockRow)).rejects.toThrow(TW_PNL_DETAIL_MISMATCH);
});

it('labels stock order conditions', () => {
    expect(twCondLabel('Cash')).toBe('現股');
    expect(twCondLabel('MarginTrading')).toBe('融資');
    expect(twCondLabel('ShortSelling')).toBe('融券');
    expect(twCondLabel('SBLShort')).toBe('借券');
});

it('futures closing detail keeps only the selected direction and day (r6 filters by code and date only)', async () => {
    m.pnl.mockResolvedValue([{ ...futRow, id: 5 }]);
    const close = (direction: string, pnl: number, date = '20261020') => ({ date, code: 'MXFK6', quantity: 1, direction, entry_date: '20261019', entry_price: 46681, cover_price: 46384, pnl, fee: 25, tax: 93 });
    m.pnlDetail.mockResolvedValue([close('Buy', -14850), close('Sell', 9000), close('Buy', 100, '20261021')]);
    const rows = await fetchTwProfitDetail(F, 'F', futRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'Buy', pnl: -14850 });
});
