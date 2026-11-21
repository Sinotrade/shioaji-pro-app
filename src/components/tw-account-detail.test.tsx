// 台股庫存明細／沖銷明細畫面：欄位、單位、遮金額、暫時性錯誤、模擬環境說明、與美股同一種展開互動
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ posDetail: vi.fn(), pnlDetail: vi.fn(), priv: false, sim: false }));
vi.mock('../lib/privacy', () => ({
    usePrivacyMoney: () => m.priv,
    maskMoney: (t: string, on: boolean) => (on ? '•••••' : t),
}));
vi.mock('../lib/server-info-store', async orig => ({ ...await orig<object>(), useServerInfo: () => ({ simulation: m.sim }) }));
vi.mock('../lib/tw-account-detail', async () => {
    const real = await vi.importActual<typeof import('../lib/tw-account-detail')>('../lib/tw-account-detail');
    return { ...real, fetchTwPositionDetail: m.posDetail, fetchTwProfitDetail: m.pnlDetail };
});

import { TwPnlDetail, TwPositionDetail, TwRealizedTable } from './tw-account-detail';
import { normalizePositionDetail, normalizeProfitDetail, TW_POSITION_DETAIL_MISMATCH } from '../lib/tw-account-detail';
import type { Account } from '../lib/types/portfolio';

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view: ReactTestRenderer | undefined;
const all = () => text(view!.root);
const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };

let seq = 0;
const S = () => ({ account_type: 'S', broker_id: '9A95', account_id: `S${seq}`, signed: true, person_id: '', username: '' }) as Account;
const F = () => ({ account_type: 'F', broker_id: 'F002', account_id: `F${seq}`, signed: true, person_id: '', username: '' }) as Account;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.posDetail.mockReset(); m.pnlDetail.mockReset(); m.priv = false; m.sim = false;
    seq += 1;
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

const stockLots = normalizePositionDetail('S', [
    { date: '2026-11-03', code: '2330', quantity: 2, price: 1000, last_price: 1100, dseq: 'A', direction: 'Buy', pnl: 199000, fee: 1425, cond: 'Cash', ex_dividends: 0, interest: 0, margintrading_amt: 0, collateral: 0 },
    { date: '2026-11-04', code: '2330', quantity: 0, price: 1050, last_price: 1100, dseq: 'B', direction: 'Buy', pnl: 24000, fee: 712, cond: 'Cash', ex_dividends: 0, interest: 0, margintrading_amt: 0, collateral: 0 },
]);

it('stock lots: 張 units, 未滿 1 張 for odd lots, optional margin columns hidden when all zero', async () => {
    m.posDetail.mockResolvedValue(stockLots);
    await act(async () => { view = create(createElement(TwPositionDetail, { account: S(), market: 'S', row: { id: 0, code: '2330', direction: 'Buy', cond: 'Cash', quantity: 2500 }, version: 1 })); });
    await settle();
    expect(m.posDetail).toHaveBeenCalledWith(expect.objectContaining({ account_type: 'S' }), 'S', expect.objectContaining({ id: 0, code: '2330', cond: 'Cash' }));
    const t = all();
    expect(t).toContain('成交日條件數量成交價現價損益手續費');
    expect(t).toContain('2026-11-03現股2 張1,000');
    expect(t).toContain('+199,000');
    expect(t).toContain('1,425');
    expect(t).toContain('未滿 1 張');
    expect(t).not.toContain('融資金額');
    expect(t).toContain('以「張」計');
});

it('futures lots show remaining (original) contracts and direction; privacy masks quantities, cost and money', async () => {
    m.posDetail.mockResolvedValue(normalizePositionDetail('F', [{ date: '20261103', code: 'TXFL6', quantity: 1, entry_quantity: 2, price: 23000, last_price: 22900, dseq: 'X', direction: 'Sell', pnl: 20000, fee: 60 }]));
    m.priv = true;
    await act(async () => { view = create(createElement(TwPositionDetail, { account: F(), market: 'F', row: { id: 0, code: 'TXFL6', direction: 'Sell', quantity: 1 }, version: 1 })); });
    await settle();
    let t = all();
    expect(t).toContain('2026-11-03空');
    expect(t).toContain('22,900'); // 現價不遮
    expect(t).not.toMatch(/23,000|20,000|1（2）口/);
    m.priv = false;
    await act(async () => { view!.update(createElement(TwPositionDetail, { account: F(), market: 'F', row: { id: 0, code: 'TXFL6', direction: 'Sell', quantity: 1 }, version: 1 })); });
    t = all();
    expect(t).toContain('1（2）口');
    expect(t).toContain('23,000');
    expect(t).toContain('+20,000');
});

it('simulation explains that TW detail comes from the broker instead of saying there is none', async () => {
    m.sim = true;
    m.posDetail.mockResolvedValue([]);
    await act(async () => { view = create(createElement(TwPositionDetail, { account: S(), market: 'S', row: { id: 0, code: '2330', direction: 'Buy', quantity: 1000 }, version: 1 })); });
    await settle();
    expect(all()).toContain('模擬環境不提供台股庫存明細');
    await act(async () => view!.unmount());
    // 期貨列不說「台股」
    await act(async () => { view = create(createElement(TwPositionDetail, { account: F(), market: 'F', row: { id: 0, code: 'MXFL6', direction: 'Sell', quantity: 2 }, version: 1 })); });
    await settle();
    expect(all()).toContain('模擬環境不提供期貨／選擇權庫存明細');
    expect(all()).not.toContain('台股');
    await act(async () => view!.unmount());
    m.pnlDetail.mockResolvedValue([]);
    await act(async () => { view = create(createElement(TwPnlDetail, { account: F(), market: 'F', row: futRow, version: 1 })); });
    await settle();
    expect(all()).toContain('模擬環境不提供期貨／選擇權沖銷明細');
    m.sim = false;
});

it('broker transient failures are gray with retry; a stale-cache mismatch is a plain note', async () => {
    m.posDetail.mockRejectedValueOnce(new Error('500 Internal Server Error')).mockResolvedValueOnce(stockLots);
    await act(async () => { view = create(createElement(TwPositionDetail, { account: S(), market: 'S', row: { id: 0, code: '2330', direction: 'Buy', quantity: 2500 }, version: 1 })); });
    await settle();
    expect(all()).toContain('券商暫時查不到資料，稍後再試');
    expect(all()).not.toContain('資訊查詢失敗');
    const retry = view!.root.findAll(n => n.type === 'button' && text(n).includes('重試'))[0]!;
    await new Promise(r => setTimeout(r, 1600)); // useQuery 的 1.5 秒防連點
    await act(async () => { retry.props.onClick(); });
    await settle();
    expect(all()).toContain('2026-11-03');
    await act(async () => view!.unmount()); view = undefined;

    m.posDetail.mockReset().mockRejectedValue(new Error(TW_POSITION_DETAIL_MISMATCH));
    await act(async () => { view = create(createElement(TwPositionDetail, { account: S(), market: 'S', row: { id: 1, code: '2330', direction: 'Buy', quantity: 2500 }, version: 2 })); });
    await settle();
    expect(all()).toContain(TW_POSITION_DETAIL_MISMATCH);
    expect(all()).not.toContain('資訊查詢失敗');
    expect(all()).not.toContain('券商暫時查不到資料');
    // 對不上的提示也能重試（更新持倉後 id 會變）
    m.posDetail.mockReset().mockResolvedValue(stockLots);
    await new Promise(r => setTimeout(r, 1600));
    await act(async () => { view!.root.findAll(n => n.type === 'button' && text(n).includes('重試'))[0]!.props.onClick(); });
    await settle();
    expect(all()).toContain('2026-11-03');
});

it('closing detail is keyed by the P&L list version: a refreshed list re-queries instead of reusing a stale result', async () => {
    m.pnlDetail.mockRejectedValueOnce(new Error('損益資料已變動，找不到這一筆；請更新損益後再展開'))
        .mockResolvedValueOnce(normalizeProfitDetail('S', [{ date: '2026-11-03', code: '2330', quantity: 1500, price: 1000, cost: 1500020, fee: 20, tax: 0 }]));
    const account = S();
    const mount = async (version: number) => {
        await act(async () => { view = create(createElement(TwRealizedTable, { rows: [{ account, market: 'S' as const, row: stockRow }], priv: false, version })); });
        await act(async () => { view!.root.findAll(n => n.type === 'tr' && n.props['aria-expanded'] !== undefined)[0]!.props.onClick(); });
        await settle();
    };
    await mount(1);
    expect(all()).toContain('找不到這一筆');
    await act(async () => view!.unmount());
    await mount(1);
    expect(m.pnlDetail).toHaveBeenCalledTimes(1); // 同一版本沿用
    await act(async () => view!.unmount());
    await mount(2);
    expect(m.pnlDetail).toHaveBeenCalledTimes(2);
    expect(all()).toContain('1,500,020');
});

const stockRow = { id: 7, code: '2330', quantity: 1500, pnl: 4321, date: '2026-11-20', dseq: 'D1', price: 1010, pr_ratio: 0.01, pnl_pct: 1, cond: 'Cash', seqno: 'S1' };
const futRow = { id: 2, code: 'MXFK6', quantity: 1, pnl: -14850, date: '20261020', entry_price: 46681, cover_price: 46384, tax: 93, fee: 25, direction: 'Buy' as const };

it('realized table: same expand-row interaction as US, stock in shares, futures in contracts', async () => {
    m.pnlDetail.mockImplementation(async (_a: Account, market: 'S' | 'F') => (market === 'S'
        ? normalizeProfitDetail('S', [{ date: '2026-11-03', code: '2330', quantity: 1500, price: 1000, cost: 1500020, fee: 20, tax: 0, interest: 0, shortselling_fee: 0, ex_dividend_amt: 0 }])
        : normalizeProfitDetail('F', [{ date: '20261020', code: 'MXFK6', quantity: 1, direction: 'Buy', entry_date: '20261019', entry_price: 46681, cover_price: 46384, pnl: -14850, fee: 25.5, tax: 93 }])));
    const rows = [{ account: S(), market: 'S' as const, row: stockRow }, { account: F(), market: 'F' as const, row: futRow }];
    await act(async () => { view = create(createElement(TwRealizedTable, { rows, priv: false, version: 1 })); });
    let t = all();
    expect(t).toContain('2026-11-2023301張+500股1,010+4,321+1.00%');
    expect(t).toContain('2026-10-20MXFK6多1 口46,384-14,850—');
    const expandable = view!.root.findAll(n => n.type === 'tr' && n.props['aria-expanded'] !== undefined);
    expect(expandable).toHaveLength(2);
    await act(async () => { expandable[0]!.props.onClick(); });
    await act(async () => { expandable[1]!.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }); });
    await settle();
    expect(m.pnlDetail).toHaveBeenCalledWith(expect.objectContaining({ account_type: 'S' }), 'S', stockRow);
    expect(m.pnlDetail).toHaveBeenCalledWith(expect.objectContaining({ account_type: 'F' }), 'F', futRow);
    t = all();
    expect(t).toContain('原成交日條件股數原成交價成本手續費交易稅');
    expect(t).toContain('2026-11-03現股1張+500股1,0001,500,020200');
    expect(t).toContain('開倉日方向口數開倉價平倉價損益手續費交易稅');
    // 期貨手續費可有小數，不四捨五入成整數
    expect(t).toContain('2026-10-19多1 口46,68146,384-14,85025.593');
});

it('realized table masks quantities and amounts under privacy', async () => {
    const rows = [{ account: S(), market: 'S' as const, row: stockRow }];
    await act(async () => { view = create(createElement(TwRealizedTable, { rows, priv: true, version: 1 })); });
    const t = all();
    expect(t).not.toMatch(/1張\+500股|4,321/);
    expect(t).toContain('•••••');
});
