// 美股帳務畫面：餘額／可下單／圈存／未交割、已實現損益＋明細、股利、庫存明細、尚未開放
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    balance: vi.fn(), settlements: vi.fn(), pnl: vi.fn(), pnlDetail: vi.fn(), dividends: vi.fn(), posDetail: vi.fn(),
}));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, usePrivacyMoney: () => false, maskAccountId: (id: string) => id, maskMoney: (t: string) => t }));
vi.mock('../lib/us/us-account-api', async () => {
    const real = await vi.importActual<typeof import('../lib/us/us-account-api')>('../lib/us/us-account-api');
    return {
        ...real,
        fetchUsBalance: m.balance, fetchUsSettlements: m.settlements, fetchUsProfitLoss: m.pnl,
        fetchUsProfitLossDetail: m.pnlDetail, fetchUsDividends: m.dividends, fetchUsPositionDetail: m.posDetail,
    };
});

import { UsAccountSection, UsPositionDetail, UsRealizedPnlSection } from './us-account-panels';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const H2 = { ...H, account_id: '0000002' };
const unavailable = () => Object.assign(new Error('503 Service Unavailable'), { status: 503 });

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view: ReactTestRenderer | undefined;
const all = () => text(view!.root);
const mount = async (el: React.ReactElement) => {
    await act(async () => { view = create(el); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

let seq = 0;
beforeEach(() => {
    Object.values(m).forEach(f => f.mockReset());
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    seq++;
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); });

// useQuery 依 key 快取：每個測試用不同帳戶號碼，避免沿用上一個測試的結果
const acct = (a = H) => ({ ...a, account_id: `${a.account_id}${seq}` });

it('lists balance, buying power, held amount and unsettled amounts in USD', async () => {
    m.balance.mockResolvedValue({ account_type: 'H', currency: 'USD', balance: '10000', buying_power: '7500.5' });
    m.settlements.mockResolvedValue([
        { account_type: 'H', trade_date: '2026-11-14', settlement_date: '2026-11-17', net_amount: '512.25', currency: 'USD' },
        { account_type: 'H', trade_date: '2026-11-17', settlement_date: '2026-11-18', net_amount: '-1100.5', currency: 'USD' },
    ]);
    await mount(createElement(UsAccountSection, { accounts: [acct()] }));
    const t = all();
    expect(t).toContain('帳戶餘額10,000.00 USD');
    expect(t).toContain('可下單金額7,500.50 USD');
    expect(t).toContain('委託圈存2,499.50 USD');
    expect(t).toContain('未交割合計-588.25 USD');
    expect(t).toContain('2026-11-18 交割（2026-11-17 成交）-1,100.50 USD');
    expect(t).not.toContain('TWD');
});

it('shows one calm 「美股帳務服務尚未開放」 line when gtrade answers 503', async () => {
    m.balance.mockRejectedValue(unavailable());
    m.settlements.mockRejectedValue(unavailable());
    await mount(createElement(UsAccountSection, { accounts: [acct(), acct(H2)] }));
    const t = all();
    expect(t.match(/美股帳務服務尚未開放/g)).toHaveLength(1);
    expect(t).not.toContain('503');
});

it('keeps other accounts when one account fails', async () => {
    m.balance.mockImplementation(async (a: typeof H) => {
        if (a.account_id.startsWith('0000002')) throw new Error('502 UPSTREAM_ERROR');
        return { account_type: 'H', currency: 'USD', balance: '100', buying_power: '100' };
    });
    m.settlements.mockResolvedValue([]);
    await mount(createElement(UsAccountSection, { accounts: [acct(), acct(H2)] }));
    const t = all();
    expect(t).toContain('帳戶餘額100.00 USD');
    expect(t).toContain('券商美股帳務暫時無法查詢');
    expect(t).toContain('未交割款無');
});

it('shows realized P&L with an expandable FIFO detail labelled as whole-order fees', async () => {
    m.pnl.mockResolvedValue([{ account_type: 'H', detail_id: 'D1', code: 'AAPL', direction: 'Sell', date: '2026-11-17', quantity: '5', price: '231.2', cost: '1100', pnl: '56', pnl_pct: '5.09', currency: 'USD', base_currency: 'USD' }]);
    m.dividends.mockResolvedValue([{ account_type: 'H', code: 'MSFT', pay_date: '2026-11-13', record_date: '2026-11-10', quantity: '10', gross_amount: '8.3', withholding_tax: '2.49', net_amount: '5.81', currency: 'USD', settlement_currency: 'USD' }]);
    m.pnlDetail.mockResolvedValue([{ account_type: 'H', acquired_date: '2026-11-03', quantity: '5', price: '220', cost: '1100', fee: '3', tax: '0', other_fees: '0.02', currency: 'USD', base_currency: 'USD' }]);
    await mount(createElement(UsRealizedPnlSection, { accounts: [acct()] }));
    let t = all();
    expect(t).toContain('已實現損益合計+56.00 USD');
    expect(t).toContain('+5.09%');
    expect(t).toContain('股利淨額合計+5.81 USD');
    expect(t).toContain('2.49 USD');
    const row = view!.root.findAll(n => n.type === 'tr' && n.props['aria-expanded'] === false)[0]!;
    await act(async () => { row.props.onClick(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(m.pnlDetail).toHaveBeenCalledWith(expect.objectContaining({ account_type: 'H' }), 'D1');
    t = all();
    expect(t).toContain('原委託手續費');
    expect(t).toContain('不按本次股數分攤');
    expect(t).toContain('2026-11-03');
});

it('P&L section also shows the not-yet-open state instead of errors', async () => {
    m.pnl.mockRejectedValue(unavailable());
    m.dividends.mockRejectedValue(unavailable());
    await mount(createElement(UsRealizedPnlSection, { accounts: [acct()] }));
    expect(all()).toContain('美股帳務服務尚未開放');
    expect(all()).not.toContain('已實現損益合計');
});

it('position detail lists lots with null market data shown as a dash', async () => {
    m.posDetail.mockResolvedValue([{ account_type: 'H', code: 'AAPL', quantity: '5', original_quantity: '10', acquired_date: '2026-11-03', acquisition_type: 'Buy', price: '220', cost: '1100', market_price: null, pnl: null, settlement_currency: 'USD', currency: 'USD', base_currency: 'USD' }]);
    await mount(createElement(UsPositionDetail, { account: acct(), detailId: 0 }));
    expect(m.posDetail).toHaveBeenCalledWith(expect.anything(), 0);
    const t = all();
    expect(t).toContain('5（10）股');
    expect(t).toContain('—');
});
