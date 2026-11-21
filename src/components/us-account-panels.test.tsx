// 美股帳務畫面：餘額／可下單／圈存／未交割、已實現損益＋明細、股利、庫存明細、尚未開放
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { nyToday, US_PARTIAL_FAILURE, US_POSITION_DETAIL_MISMATCH, UsAccountSection, UsPositionDetail, UsRealizedPnlSection, UsTodayPnlSection } from './us-account-panels';
import { notifyUsDealSettled, requestUsAccountRefresh, resetUsAccountBatchForTest } from '../lib/us/us-account-batch';
import { beginServerInfoRequest, observeServerInfo } from '../lib/server-info-store';
import { usAccountErrorKind } from '../lib/us/us-account-api';

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
    resetUsAccountBatchForTest();
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
    await mount(createElement(UsPositionDetail, { account: acct(), detailId: 0, code: 'AAPL', version: 1 }));
    expect(m.posDetail).toHaveBeenCalledWith(expect.anything(), 0);
    const t = all();
    expect(t).toContain('5（10）股');
    expect(t).toContain('—');
});

it('retries once when the query was dropped because the server mode was learned mid-flight', async () => {
    m.balance.mockRejectedValueOnce(new Error('查詢期間伺服器模式已變更，已丟棄回應；請重新更新'))
        .mockResolvedValue({ account_type: 'H', currency: 'USD', balance: '50', buying_power: '50' });
    m.settlements.mockResolvedValue([]);
    await mount(createElement(UsAccountSection, { accounts: [acct()] }));
    expect(m.balance).toHaveBeenCalledTimes(2);
    expect(all()).toContain('帳戶餘額50.00 USD');
    expect(all()).not.toContain('已丟棄回應');
});

// useQuery 兩次查詢之間至少隔 1.5 秒
const later = () => { const t = Date.now() + 2000; vi.spyOn(Date, 'now').mockReturnValue(t); };
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

it('dock refresh (and US order events) re-query balance, also after a 503', async () => {
    m.balance.mockRejectedValueOnce(unavailable()).mockResolvedValue({ account_type: 'H', currency: 'USD', balance: '10', buying_power: '10' });
    m.settlements.mockRejectedValueOnce(unavailable()).mockResolvedValue([]);
    await mount(createElement(UsAccountSection, { accounts: [acct()] }));
    expect(all()).toContain('美股帳務服務尚未開放');
    later();
    await act(async () => { requestUsAccountRefresh(); });
    await settle();
    expect(m.balance).toHaveBeenCalledTimes(2);
    expect(all()).toContain('帳戶餘額10.00 USD');
    vi.restoreAllMocks();
});

it('position detail is cached per code and positions version, and rejects lots of another symbol', async () => {
    const lot = (code: string) => ({ account_type: 'H', code, quantity: '1', original_quantity: '1', acquired_date: '2026-11-03', acquisition_type: 'Buy', price: '1', cost: '1', market_price: null, pnl: null, settlement_currency: 'USD', currency: 'USD', base_currency: 'USD' });
    const a = acct();
    m.posDetail.mockResolvedValue([lot('AAPL')]);
    await mount(createElement(UsPositionDetail, { account: a, detailId: 0, code: 'AAPL', version: 1 }));
    await act(async () => view!.unmount());
    // 庫存重查後 id 0 變成 MSFT：不能沿用 AAPL 的快取
    m.posDetail.mockResolvedValue([lot('MSFT')]);
    await mount(createElement(UsPositionDetail, { account: a, detailId: 0, code: 'MSFT', version: 2 }));
    expect(m.posDetail).toHaveBeenCalledTimes(2);
    expect(all()).not.toContain(US_POSITION_DETAIL_MISMATCH);
    await act(async () => view!.unmount());
    // 回來的明細代碼不符這一列：不顯示別檔的批次
    m.posDetail.mockResolvedValue([lot('AAPL')]);
    await mount(createElement(UsPositionDetail, { account: a, detailId: 1, code: 'TSLA', version: 3 }));
    expect(all()).toContain(US_POSITION_DETAIL_MISMATCH);
    expect(all()).not.toContain('2026-11-03');
});

it('keeps the last good P&L of a failed account, marks it and leaves it out of the total', async () => {
    const pl = (pnl: string, id: string) => ({ account_type: 'H', detail_id: id, code: 'AAPL', direction: 'Sell', date: '2026-11-17', quantity: '1', price: '1', cost: '1', pnl, pnl_pct: '1', currency: 'USD', base_currency: 'USD' });
    const a1 = acct(); const a2 = acct(H2);
    m.pnl.mockImplementation(async (a: typeof H) => [pl(a.account_id === a1.account_id ? '10' : '5', a.account_id)]);
    m.dividends.mockResolvedValue([]);
    await mount(createElement(UsRealizedPnlSection, { accounts: [a1, a2] }));
    expect(all()).toContain('已實現損益合計+15.00 USD');
    m.pnl.mockImplementation(async (a: typeof H) => {
        if (a.account_id === a2.account_id) throw new Error('502 UPSTREAM_ERROR');
        return [pl('10', a.account_id)];
    });
    later();
    await act(async () => { view!.root.findAll(n => n.type === 'button' && /更新美股損益/.test(String(n.props['aria-label'] ?? n.props.title ?? '')))[0]?.props.onClick(); });
    await settle();
    const t = all();
    expect(t).toContain('已實現損益合計+10.00 USD');
    expect(t).toContain(US_PARTIAL_FAILURE);
    expect(t).toContain('（上次查詢）');
    expect(t).toContain('+5.00 USD');
    vi.restoreAllMocks();
});

it('shows an error state, not 「無已實現損益」, when every account failed', async () => {
    m.pnl.mockRejectedValue(new Error('502 UPSTREAM_ERROR'));
    m.dividends.mockRejectedValue(new Error('502 UPSTREAM_ERROR'));
    await mount(createElement(UsRealizedPnlSection, { accounts: [acct(), acct(H2)] }));
    const t = all();
    expect(t).toContain('美股已實現損益查詢失敗');
    expect(t).toContain('美股現金股利查詢失敗');
    expect(t).not.toContain('無美股已實現損益');
    expect(t).not.toContain('已實現損益合計');
});

// ---- 帳務分頁：今日已實現損益（美東交易日） ----

const pl = (over: Record<string, string>) => ({ account_type: 'H', detail_id: 'D1', code: 'AAPL', direction: 'Sell', date: '2026-11-20', quantity: '1', price: '352.69', cost: '352.98', pnl: '-0.58', pnl_pct: '-0.16', currency: 'USD', base_currency: 'USD', ...over });
const findToggle = () => view!.root.findAll(n => n.type === 'button' && n.props.title === '展開明細')[0];

it('today = America/New_York date: Taipei is already 11/21 but NY is still 11/20', () => {
    // 2026-11-21 03:00 UTC = 台北 11:00 11/21 = 美東 22:00 11/20（EST）
    expect(nyToday(Date.parse('2026-11-21T03:00:00Z'))).toBe('2026-11-20');
    // 美東午夜過後才換日（EST UTC-5）
    expect(nyToday(Date.parse('2026-11-21T04:59:59Z'))).toBe('2026-11-20');
    expect(nyToday(Date.parse('2026-11-21T05:00:00Z'))).toBe('2026-11-21');
    // 夏令（EDT UTC-4）
    expect(nyToday(Date.parse('2026-07-01T03:59:00Z'))).toBe('2026-06-30');
});

describe('UsTodayPnlSection', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-21T03:00:00Z')); });
    afterEach(() => { vi.useRealTimers(); });

    it('queries NY today only, keeps only rows of that trade date, USD total not mixed with TWD', async () => {
        m.pnl.mockResolvedValue([
            pl({ detail_id: 'A', pnl: '-0.19', code: 'VT' }),
            pl({ detail_id: 'B', pnl: '12.5' }),
            pl({ detail_id: 'OLD', date: '2026-11-19', pnl: '999' }),
        ]);
        m.pnlDetail.mockResolvedValue([{ account_type: 'H', acquired_date: '2026-11-03', quantity: '1', price: '340', cost: '340', fee: '3', tax: '0', other_fees: '0.02', currency: 'USD', base_currency: 'USD' }]);
        await mount(createElement(UsTodayPnlSection, { accounts: [acct()] }));
        expect(m.pnl).toHaveBeenCalledWith(expect.objectContaining({ account_type: 'H' }), '2026-11-20', '2026-11-20');
        let t = all();
        expect(t).toContain('今日已實現損益（USD，美東 11/20）');
        expect(t).toContain('不和台幣合計');
        expect(t).toContain('+12.31 USD');
        expect(t).toContain('2 筆');
        expect(t).not.toContain('999');
        expect(t).not.toContain('TWD');
        // 收合時不列明細；展開後每列可再展開沖銷明細（同台股）
        expect(t).not.toContain('VT');
        await act(async () => { findToggle()!.props.onClick(); });
        t = all();
        expect(t.indexOf('AAPL')).toBeLessThan(t.indexOf('VT')); // 依損益絕對值排序
        const row = view!.root.findAll(n => n.type === 'tr' && n.props['aria-expanded'] === false)[0]!;
        await act(async () => { row.props.onClick(); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(m.pnlDetail).toHaveBeenCalledWith(expect.objectContaining({ account_type: 'H' }), 'B');
        expect(all()).toContain('原委託手續費');
    });

    it('shows 「今日無美股已實現損益」 when there is none', async () => {
        m.pnl.mockResolvedValue([]);
        await mount(createElement(UsTodayPnlSection, { accounts: [acct()] }));
        expect(all()).toContain('今日無美股已實現損益');
    });

    it('re-queries after a US deal (debounced deal event) and after the dock refresh', async () => {
        m.pnl.mockResolvedValue([]);
        await mount(createElement(UsTodayPnlSection, { accounts: [acct()] }));
        expect(m.pnl).toHaveBeenCalledTimes(1);
        m.pnl.mockResolvedValue([pl({ pnl: '3' })]);
        vi.setSystemTime(new Date('2026-11-21T03:00:05Z'));
        await act(async () => { notifyUsDealSettled(); await new Promise(r => setTimeout(r, 0)); });
        expect(m.pnl).toHaveBeenCalledTimes(2);
        expect(all()).toContain('+3.00 USD');
        vi.setSystemTime(new Date('2026-11-21T03:00:10Z'));
        await act(async () => { requestUsAccountRefresh(); await new Promise(r => setTimeout(r, 0)); });
        expect(m.pnl).toHaveBeenCalledTimes(3);
    });

    it('a temporary gtrade failure is a grey hint with retry, a real error is red', async () => {
        m.pnl.mockRejectedValue(new Error('502 UPSTREAM_ERROR'));
        await mount(createElement(UsTodayPnlSection, { accounts: [acct()] }));
        let t = all();
        expect(t).toContain('券商暫時查不到資料，稍後再試');
        expect(t).not.toContain('查詢失敗');
        expect(t).toContain('重試');
        await act(async () => view?.unmount()); view = undefined;
        seq++;
        m.pnl.mockRejectedValue(new Error('400 INVALID_ACCOUNT'));
        await mount(createElement(UsTodayPnlSection, { accounts: [acct()] }));
        t = all();
        expect(t).toContain('美股損益資訊查詢失敗：INVALID_ACCOUNT');
    });

    it('a failed account keeps its last rows marked, out of the total', async () => {
        m.pnl.mockImplementation(async (a: typeof H) => [pl({ detail_id: a.account_id, pnl: a.account_id.startsWith('0000002') ? '100' : '1' })]);
        await mount(createElement(UsTodayPnlSection, { accounts: [acct(), acct(H2)] }));
        expect(all()).toContain('+101.00 USD');
        m.pnl.mockImplementation(async (a: typeof H) => {
            if (a.account_id.startsWith('0000002')) throw new Error('502 UPSTREAM_ERROR');
            return [pl({ detail_id: a.account_id, pnl: '1' })];
        });
        vi.setSystemTime(new Date('2026-11-21T03:00:05Z'));
        await act(async () => { requestUsAccountRefresh(); await new Promise(r => setTimeout(r, 0)); });
        const t = all();
        expect(t).toContain('+1.00 USD');
        expect(t).toContain('2 筆');
        expect(t).toContain(US_PARTIAL_FAILURE);
        await act(async () => { findToggle()!.props.onClick(); });
        expect(all()).toContain('（上次查詢）');
    });

    it('a deal arriving while a query is in flight gets a trailing query, so old data is not left as current', async () => {
        let release!: (v: unknown) => void;
        m.pnl.mockReturnValueOnce(new Promise(r => { release = r; }));
        await mount(createElement(UsTodayPnlSection, { accounts: [acct()] }));
        expect(m.pnl).toHaveBeenCalledTimes(1);
        m.pnl.mockResolvedValue([pl({ pnl: '7' })]);
        await act(async () => { notifyUsDealSettled(); });
        expect(m.pnl).toHaveBeenCalledTimes(1); // 查詢中：去重，不另查
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date('2026-11-21T03:00:01Z'));
        await act(async () => { release([]); await vi.advanceTimersByTimeAsync(0); });
        expect(all()).toContain('今日無美股已實現損益');
        await act(async () => { await vi.advanceTimersByTimeAsync(1700); });
        expect(m.pnl).toHaveBeenCalledTimes(2);
        expect(all()).toContain('+7.00 USD');
    });

    it('re-queries on remount when a deal came while another dock tab was open', async () => {
        m.pnl.mockResolvedValue([]);
        const accounts = [acct()];
        await mount(createElement(UsTodayPnlSection, { accounts }));
        await act(async () => view?.unmount()); view = undefined;
        notifyUsDealSettled();
        vi.setSystemTime(new Date('2026-11-21T03:00:05Z'));
        m.pnl.mockResolvedValue([pl({ pnl: '4' })]);
        await mount(createElement(UsTodayPnlSection, { accounts }));
        expect(m.pnl).toHaveBeenCalledTimes(2);
        expect(all()).toContain('+4.00 USD');
    });

    it('a server mode change (same address) does not reuse the other mode\'s P&L', async () => {
        m.pnl.mockResolvedValue([pl({ pnl: '5' })]);
        const accounts = [acct()];
        await mount(createElement(UsTodayPnlSection, { accounts }));
        expect(all()).toContain('+5.00 USD');
        m.pnl.mockResolvedValue([]);
        await act(async () => {
            observeServerInfo(beginServerInfoRequest(), { simulation: seq % 2 === 0 } as never);
            await new Promise(r => setTimeout(r, 0));
        });
        await settle();
        expect(m.pnl).toHaveBeenCalledTimes(2);
        expect(all()).not.toContain('+5.00 USD');
    });

    it('after NY midnight a failed account does not show yesterday\'s rows as today\'s', async () => {
        m.pnl.mockResolvedValue([pl({ pnl: '9' })]);
        const accounts = [acct()];
        await mount(createElement(UsTodayPnlSection, { accounts }));
        expect(all()).toContain('+9.00 USD');
        await act(async () => view?.unmount()); view = undefined;
        vi.setSystemTime(new Date('2026-11-21T06:00:00Z')); // 美東 11/21 01:00
        m.pnl.mockRejectedValue(new Error('502 UPSTREAM_ERROR'));
        await mount(createElement(UsTodayPnlSection, { accounts }));
        const t = all();
        expect(m.pnl).toHaveBeenLastCalledWith(expect.anything(), '2026-11-21', '2026-11-21');
        expect(t).toContain('美東 11/21');
        expect(t).not.toContain('9.00');
        expect(t).toContain('券商暫時查不到資料');
    });

    it('a genuine error on one account keeps its marked rows and is shown red, not as a quiet hint', async () => {
        m.pnl.mockImplementation(async (a: typeof H) => [pl({ detail_id: a.account_id, pnl: '1' })]);
        await mount(createElement(UsTodayPnlSection, { accounts: [acct(), acct(H2)] }));
        m.pnl.mockImplementation(async (a: typeof H) => {
            if (a.account_id.startsWith('0000002')) throw new Error('400 INVALID_ACCOUNT');
            return [pl({ detail_id: a.account_id, pnl: '1' })];
        });
        vi.setSystemTime(new Date('2026-11-21T03:00:05Z'));
        await act(async () => { requestUsAccountRefresh(); await new Promise(r => setTimeout(r, 0)); });
        const t = all();
        expect(t).toContain(`美股損益資訊查詢失敗：${US_PARTIAL_FAILURE}：INVALID_ACCOUNT`);
        expect(t).toContain('+1.00 USD');
    });

    it('classifies the status-stripped bare 500 as temporary', () => {
        expect(usAccountErrorKind('Internal Server Error')).toBe('temporary');
        expect(usAccountErrorKind('400 INVALID_ACCOUNT')).toBeNull();
        expect(usAccountErrorKind(Object.assign(new Error('503'), { status: 503 }))).toBe('unavailable');
    });

    it('503 everywhere is one calm not-yet-open line', async () => {
        m.pnl.mockRejectedValue(unavailable());
        await mount(createElement(UsTodayPnlSection, { accounts: [acct(), acct(H2)] }));
        const t = all();
        expect(t.match(/美股帳務服務尚未開放/g)).toHaveLength(1);
    });
});
