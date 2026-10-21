import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ accounts: ['A', 'B'].map(account_id => ({ account_type: 'F', broker_id: 'BR', account_id, signed: true, person_id: '', username: '' })), pnl: vi.fn(), summary: vi.fn(), settlements: vi.fn(), limits: vi.fn(), reserve: vi.fn() }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: fixture.accounts }), getAccountState: () => ({ accounts: fixture.accounts }) }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'http://account-pane-fixture.invalid' }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: async () => ({ simulation: false }), fetchProfitLoss: fixture.pnl, fetchProfitLossSummary: fixture.summary,
    fetchSettlements: fixture.settlements, fetchTradingLimits: fixture.limits, fetchStockReserveSummary: fixture.reserve, fetchStockReserveDetail: fixture.reserve, fetchEarmarkingDetail: fixture.reserve, resolveContract: vi.fn(), fetchFuturesRoots: vi.fn(async () => [{ root: 'NSF', name: '美國那斯達克100期貨' }]) }));
import { AccountPane, type AccountRefreshControls } from './bottom-dock-account';
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('fans out explicit futures accounts, sums both and keeps a complete snapshot after a partial failure', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.useFakeTimers();
    fixture.pnl.mockImplementation(async (_market, account) => [{ id: 1, code: 'TMF', pnl: account.account_id === 'A' ? 100 : 250, quantity: 1, price: 100 }]);
    fixture.summary.mockImplementation(async (_market, account) => ({ total: { pnl: account.account_id === 'A' ? 100 : 250 }, profitloss_sum: [] }));
    let controls: AccountRefreshControls | null = null;
    const onRefreshControls = (value: AccountRefreshControls | null) => { controls = value; };
    await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: null, onRefreshControls })); });
    expect(fixture.pnl.mock.calls.map(call => call[1].account_id).sort()).toEqual(['A', 'B']);
    expect(JSON.stringify(view!.toJSON())).toContain('350');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(fixture.pnl).toHaveBeenCalledTimes(2);
    fixture.pnl.mockImplementation(async (_market, account) => { if (account.account_id === 'B') throw new Error('B offline'); return []; });
    await act(async () => { await controls!.refresh(); });
    expect(JSON.stringify(view!.toJSON())).toContain('350');
    expect(controls!.error).toContain('B offline');
    fixture.pnl.mockResolvedValue([]);
    await act(async () => { view!.update(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: fixture.accounts[1]!, onRefreshControls })); });
    expect(fixture.pnl.mock.calls.at(-1)![1].account_id).toBe('B');
    await act(async () => { view!.update(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: null, mode: 'grouped', onRefreshControls })); });
    expect(view!.root.findAllByType('h3')).toHaveLength(2);
    const before = fixture.pnl.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
    expect(fixture.pnl.mock.calls.slice(before).map(c => c[1].account_id).sort()).toEqual(['A', 'B']);
});
it('adds matching settlement dates and rejects mismatched dates; incomplete funds do not claim a total', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.useFakeTimers();
    fixture.accounts.forEach(a => { a.account_type = 'S'; });
    fixture.pnl.mockResolvedValue([]); fixture.summary.mockResolvedValue({ total: { pnl: 0 }, profitloss_sum: [] });
    fixture.limits.mockResolvedValue({ trading_limit: 0 }); fixture.reserve.mockResolvedValue({ stocks: [] });
    fixture.settlements.mockImplementation(async account => [{ T: 0, date: '2026-09-15', amount: account.account_id === 'A' ? 125 : 375 }]);
    let controls: AccountRefreshControls | null = null;
    const onRefreshControls = (value: AccountRefreshControls | null) => { controls = value; };
    const funds = [{ account: fixture.accounts[0]!, balance: { acc_balance: 999999, date: '', errmsg: '' } }, { account: fixture.accounts[1]!, error: 'offline' }];
    await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'S', scopeAccount: null, funds, onRefreshControls })); });
    expect(fixture.settlements.mock.calls.map(c => c[0].account_id)).toEqual(['A', 'B']);
    expect(JSON.stringify(view!.toJSON())).toContain('500');
    expect(JSON.stringify(view!.toJSON())).not.toContain('999,999');
    expect(JSON.stringify(view!.toJSON())).toContain('合計待確認');
    fixture.settlements.mockImplementation(async account => [{ T: 0, date: account.account_id === 'A' ? '2026-09-15' : '2026-09-16', amount: 10 }]);
    await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
    expect(controls!.error).toContain('交割日期不一致');
    expect(JSON.stringify(view!.toJSON())).toContain('500');
    await act(async () => { view!.update(createElement(AccountPane, { positions: [], market: 'S', scopeAccount: null, funds: funds.slice(0, 1), onRefreshControls })); });
    expect(JSON.stringify(view!.toJSON())).not.toContain('999,999');
    const errorFunds = [funds[0]!, { account: fixture.accounts[1]!, balance: { acc_balance: 250, date: '', errmsg: 'broker query failed' } }];
    await act(async () => { view!.update(createElement(AccountPane, { positions: [], market: 'S', scopeAccount: null, funds: errorFunds, onRefreshControls })); });
    expect(JSON.stringify(view!.toJSON())).toContain('合計待確認');
    expect(JSON.stringify(view!.toJSON())).not.toContain('1,000,249');
    expect(JSON.stringify(view!.toJSON())).not.toContain('999,999');
});
it('#240 shows the contract name in realized rows even when the broker code is not the canonical contract code', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    // Fresh account keys: the pane keeps the previous test's snapshot per account set.
    fixture.accounts.forEach(a => { a.account_type = 'F'; a.account_id = `${a.account_id}-240`; });
    const { resolveContract } = await import('../lib/shioaji');
    vi.mocked(resolveContract).mockImplementation(async (code: string) => ({ code: code.trim(), name: code.trim() === 'REFJ6' ? '測試期貨10' : '' }) as never);
    fixture.pnl.mockImplementation(async (_market, account) => account.account_id === 'A-240'
        ? [{ id: 1, code: 'REFJ6   ', pnl: 300, quantity: 3, date: '20261007', direction: 'Buy', entry_price: 1, cover_price: 2, fee: 0, tax: 0 }] : []);
    fixture.summary.mockResolvedValue({ total: { pnl: 300 }, profitloss_sum: [] });
    await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: null })); });
    const toggle = view!.root.findAll(node => node.type === 'button' && node.props.title === '展開明細')[0]!;
    await act(async () => { toggle.props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    expect(vi.mocked(resolveContract)).toHaveBeenCalledWith('REFJ6');
    expect(JSON.stringify(view!.toJSON())).toContain('測試期貨10');
});
it('#286 production realized rows (padded / long-form futures codes) show names and unresolved rows retry on refresh', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.useFakeTimers();
    fixture.accounts.forEach(a => { a.account_type = 'F'; a.account_id = `${a.account_id.split('-')[0]}-286`; });
    const { resolveContract } = await import('../lib/shioaji');
    let tmfOnline = false;
    vi.mocked(resolveContract).mockReset().mockImplementation(async (code: string) => {
        if (code === 'MXFJ6') return { code, name: '小型臺指期貨10' } as never;
        if (code === 'TMFJ6' && tmfOnline) return { code, name: '微型臺指期貨10' } as never;
        throw new Error(`404 ${code}`);
    });
    const fut = (id: number, code: string) => ({ id, code, pnl: 100 * id, quantity: -1, date: '20261012', direction: 'Sell', entry_price: 1, cover_price: 2, fee: 0, tax: 0 });
    fixture.pnl.mockImplementation(async (_market, account) => account.account_id === 'A-286'
        ? [fut(1, 'MXFJ6\u0000\u0000'), fut(2, 'TMF202610'), fut(3, 'NSFJ6 ')] : []);
    fixture.summary.mockResolvedValue({ total: { pnl: 600 }, profitloss_sum: [] });
    let controls: AccountRefreshControls | null = null;
    const onRefreshControls = (value: AccountRefreshControls | null) => { controls = value; };
    await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: null, onRefreshControls })); });
    const toggle = view!.root.findAll(node => node.type === 'button' && node.props.title === '展開明細')[0]!;
    await act(async () => { toggle.props.onClick(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
    let json = JSON.stringify(view!.toJSON());
    expect(json).toContain('小型臺指期貨10');
    expect(json).toContain('美國那斯達克100期貨');
    expect(json).not.toContain('微型臺指期貨10');
    // 查不到名稱的列滑過可看到券商原始代號（回報用）
    expect(view!.root.findAll(node => node.type === 'span' && node.props.title === '原始代號 "TMF202610"')).toHaveLength(1);
    expect(json).toContain('"MXFJ6"');
    // 合約查詢恢復後，按重新整理（列內容不變）會補查還沒有名稱的列
    tmfOnline = true;
    vi.mocked(resolveContract).mockClear();
    await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
    for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
    json = JSON.stringify(view!.toJSON());
    expect(json).toContain('微型臺指期貨10');
    expect(vi.mocked(resolveContract).mock.calls.map(c => c[0])).not.toContain('MXFJ6');
});

it('#268 遮金額：今日已實現損益展開列的數量也遮', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    fixture.accounts.forEach(a => { a.account_type = 'F'; a.account_id = `${a.account_id.split('-')[0]}-268`; });
    const { resolveContract } = await import('../lib/shioaji');
    vi.mocked(resolveContract).mockReset().mockImplementation(async (code: string) => ({ code: code.trim(), name: '' }) as never);
    fixture.pnl.mockReset().mockImplementation(async (_market, account) => account.account_id === 'A-268'
        ? [{ id: 1, code: 'TXFJ6', pnl: 123456, quantity: -37, date: '20261007', direction: 'Sell', entry_price: 1, cover_price: 2, fee: 0, tax: 0 }] : []);
    fixture.summary.mockResolvedValue({ total: { pnl: 123456 }, profitloss_sum: [] });
    const { setPrivacyMoney } = await import('../lib/privacy');
    setPrivacyMoney(true);
    try {
        await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: null })); });
        const toggle = view!.root.findAll(node => node.type === 'button' && node.props.title === '展開明細')[0]!;
        await act(async () => { toggle.props.onClick(); });
        await act(async () => { await Promise.resolve(); });
        const json = JSON.stringify(view!.toJSON());
        expect(json).toContain('TXFJ6');
        expect(json).not.toMatch(/37口|123,456/);
        expect(json).toContain('•••••');
    } finally {
        setPrivacyMoney(false);
    }
});
