import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ accounts: ['A', 'B'].map(account_id => ({ account_type: 'F', broker_id: 'BR', account_id, signed: true, person_id: '', username: '' })), pnl: vi.fn(), summary: vi.fn(), settlements: vi.fn(), limits: vi.fn(), reserve: vi.fn(), simulation: false }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: fixture.accounts }), getAccountState: () => ({ accounts: fixture.accounts }) }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'http://account-pane-fixture.invalid' }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: async () => ({ simulation: fixture.simulation }), fetchProfitLoss: fixture.pnl, fetchProfitLossSummary: fixture.summary,
    fetchSettlements: fixture.settlements, fetchTradingLimits: fixture.limits, fetchStockReserveSummary: fixture.reserve, fetchStockReserveDetail: fixture.reserve, fetchEarmarkingDetail: fixture.reserve, resolveContract: vi.fn(), fetchFuturesRoots: vi.fn(async () => [{ root: 'NSF', name: '美國那斯達克100期貨' }]) }));
import { AccountPane, type AccountRefreshControls } from './bottom-dock-account';
import type { AccountFunds } from '../lib/types/portfolio';
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
    vi.setSystemTime(new Date('2026-11-20T10:00:00+08:00'));
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

describe('#381 交易額度查詢失敗', () => {
    const WINDOW = '500 Query error: QCredit:Query fail{StartTime=83000, EndTime=150000}';
    const LIMITS = { trading_limit: 500, trading_used: 0, trading_available: 400, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0 };
    let run = 0;
    let controls: AccountRefreshControls | null;
    const text = () => JSON.stringify(view!.toJSON());
    const retry = () => view!.root.findAll(node => node.type === 'button' && node.children.some(child => typeof child === 'string' && child.includes('重試')));
    const mount = async () => {
        await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'S', scopeAccount: null, onRefreshControls: value => { controls = value; } })); });
    };
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
        vi.useFakeTimers();
        // 交易日盤中（台北 2026-11-20 週五 10:00）：額度查詢在服務時段內
        vi.setSystemTime(new Date('2026-11-20T10:00:00+08:00'));
        run += 1; controls = null; fixture.simulation = false;
        // Fresh account keys: the pane keeps the previous test's snapshot per account set.
        fixture.accounts.forEach((a, i) => { a.account_type = 'S'; a.account_id = `${'AB'[i]}-381-${run}`; });
        fixture.pnl.mockReset().mockResolvedValue([]); fixture.summary.mockReset().mockResolvedValue({ total: { pnl: 0 }, profitloss_sum: [] });
        fixture.settlements.mockReset().mockResolvedValue([]); fixture.reserve.mockReset().mockResolvedValue({ stocks: [] });
    });
    it('非交易時段的 500 顯示既有提示，不再卡載入、也不算報表錯誤', async () => {
        fixture.limits.mockReset().mockRejectedValue(new Error(WINDOW));
        await mount();
        expect(text()).not.toContain('載入交易額度');
        expect(text()).toContain('非交易時段無額度資料（交易日 08:30–15:00 提供）');
        expect(retry()).toHaveLength(0);
        expect(controls!.error).toBeNull();
    });
    it('模擬環境同一個錯誤沿用模擬提示', async () => {
        fixture.simulation = true;
        fixture.limits.mockReset().mockRejectedValue(new Error(WINDOW));
        await mount();
        expect(text()).toContain('模擬模式無法查詢');
        expect(text()).not.toContain('非交易時段無額度資料');
    });
    it('其他錯誤顯示原因與重試，不誤判成非交易時段；重試成功後顯示額度', async () => {
        fixture.limits.mockReset().mockRejectedValue(new Error('Failed to fetch'));
        await mount();
        expect(text()).toContain('交易額度查詢失敗：');
        expect(text()).toContain('Failed to fetch');
        expect(text()).not.toContain('非交易時段無額度資料');
        expect(text()).not.toContain('載入交易額度');
        expect(controls!.error).toContain('Failed to fetch');
        expect(retry()).toHaveLength(1);
        const pending: ((value: typeof LIMITS) => void)[] = [];
        fixture.limits.mockReset().mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
        await act(async () => { vi.advanceTimersByTime(1600); retry()[0]!.props.onClick(); });
        expect(text()).toContain('載入交易額度');
        expect(text()).not.toContain('Failed to fetch');
        await act(async () => { pending.forEach(resolve => resolve(LIMITS)); });
        expect(text()).toContain('現股 可用/上限');
        expect(text()).not.toContain('載入交易額度');
    });
    it('已有額度時刷新失敗保留上一份資料，錯誤留在狀態列', async () => {
        fixture.limits.mockReset().mockResolvedValue(LIMITS);
        await mount();
        expect(text()).toContain('現股 可用/上限');
        fixture.limits.mockReset().mockRejectedValue(new Error('Failed to fetch'));
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(text()).toContain('現股 可用/上限');
        expect(text()).not.toContain('交易額度查詢失敗');
        expect(controls!.error).toContain('Failed to fetch');
    });
    it('已有額度時遇到時段錯誤，舊資料不能看起來像剛更新', async () => {
        fixture.limits.mockReset().mockResolvedValue(LIMITS);
        await mount();
        fixture.limits.mockReset().mockRejectedValue(new Error(WINDOW));
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(text()).toContain('現股 可用/上限');
        expect(controls!.error).toContain('QCredit');
    });
});

describe('正式環境台股帳務查詢時段與券商暫時性錯誤', () => {
    const LIMITS = { trading_limit: 500, trading_used: 0, trading_available: 400, margin_limit: 0, margin_used: 0, margin_available: 0, short_limit: 0, short_used: 0, short_available: 0 };
    const AS400 = '500 Query error: QCredit:Query fail{no AS400Query Connection (RouteID=M|N, WebID=094, MachineID=H05)}';
    let run = 0;
    let controls: AccountRefreshControls | null;
    const text = () => JSON.stringify(view!.toJSON());
    const retry = () => view!.root.findAll(node => node.type === 'button' && node.children.some(child => typeof child === 'string' && child.includes('重試')));
    const mount = async () => {
        await act(async () => { view = create(createElement(AccountPane, { positions: [], market: 'S', scopeAccount: null, onRefreshControls: value => { controls = value; } })); });
    };
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
        vi.useFakeTimers();
        run += 1; controls = null; fixture.simulation = false;
        fixture.accounts.forEach((a, i) => { a.account_type = 'S'; a.account_id = `${'AB'[i]}-win-${run}`; });
        fixture.pnl.mockReset().mockResolvedValue([]); fixture.summary.mockReset().mockResolvedValue({ total: { pnl: 0 }, profitloss_sum: [] });
        fixture.settlements.mockReset().mockResolvedValue([]); fixture.reserve.mockReset().mockResolvedValue({ stocks: [] });
        fixture.limits.mockReset().mockResolvedValue(LIMITS);
    });

    it('深夜（01:54）不送額度查詢、顯示時段提示；08:30 計時器到點自動查詢', async () => {
        vi.setSystemTime(new Date('2026-11-20T01:54:00+08:00'));
        await mount();
        expect(fixture.limits).not.toHaveBeenCalled();
        expect(text()).toContain('非交易時段無額度資料（交易日 08:30–15:00 提供）');
        expect(text()).not.toContain('載入交易額度');
        expect(retry()).toHaveLength(0);
        expect(controls!.error).toBeNull();
        // 交割、預收沒有時段閘門，夜間照查
        expect(fixture.settlements).toHaveBeenCalled();
        expect(fixture.reserve).toHaveBeenCalled();
        // 手動重新整理也不會在時段外送額度查詢
        await act(async () => { await controls!.refresh(); });
        expect(fixture.limits).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(6 * 3600_000 + 36 * 60_000 - 1000); });
        expect(fixture.limits).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1100); });
        for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
        expect(fixture.limits).toHaveBeenCalledTimes(2);
        expect(text()).toContain('現股 可用/上限');
        // 15:00 收盤：回到時段提示，不再送
        await act(async () => { vi.advanceTimersByTime(6.5 * 3600_000); });
        expect(text()).toContain('非交易時段無額度資料');
        expect(text()).not.toContain('現股 可用/上限');
        expect(fixture.limits).toHaveBeenCalledTimes(2);
    });

    it('週末整天不送額度查詢', async () => {
        vi.setSystemTime(new Date('2026-11-21T10:00:00+08:00'));
        await mount();
        expect(fixture.limits).not.toHaveBeenCalled();
        expect(text()).toContain('非交易時段無額度資料');
    });

    it('模擬環境不受時段限制，深夜照查', async () => {
        fixture.simulation = true;
        vi.setSystemTime(new Date('2026-11-21T01:54:00+08:00'));
        await mount();
        expect(fixture.limits).toHaveBeenCalled();
        expect(text()).toContain('現股 可用/上限');
    });

    it('模擬 sidecar 在同一位址重啟成正式：舊的模擬判斷作廢，深夜不再送額度查詢', async () => {
        const store = await import('../lib/server-info-store');
        fixture.simulation = true;
        vi.setSystemTime(new Date('2026-11-21T01:54:00+08:00'));
        await mount();
        expect(fixture.limits).toHaveBeenCalledTimes(2);
        fixture.simulation = false;
        await act(async () => { store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never); });
        expect(text()).toContain('非交易時段無額度資料');
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(fixture.limits).toHaveBeenCalledTimes(2);
        await act(async () => { store.forgetServerInfo('http://account-pane-fixture.invalid'); });
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(fixture.limits).toHaveBeenCalledTimes(2);
        expect(text()).toContain('非交易時段無額度資料');
    });

    it('時段內券商回 AS400 未連線：灰字提示、原文只在 title、不算報表錯誤', async () => {
        vi.setSystemTime(new Date('2026-11-20T10:00:00+08:00'));
        fixture.limits.mockReset().mockRejectedValue(new Error(AS400));
        await mount();
        expect(text()).toContain('券商額度服務目前未開放');
        expect(text()).not.toContain('交易額度查詢失敗');
        expect(view!.root.findAll(node => node.type === 'span' && node.props.title === AS400)).toHaveLength(1);
        expect(view!.root.findAll(node => typeof node.type === 'string' && node.children.some(c => typeof c === 'string' && c.includes('AS400')))).toHaveLength(0);
        expect(controls!.error).toBeNull();
    });

    it.each(['500 Internal Server Error', '503 Service Unavailable', '503 6044 無法取得交易狀態'])(
        '交割、預收遇到 %s：灰字「稍後再試」＋重試，不算報表錯誤', async (message) => {
            vi.setSystemTime(new Date('2026-11-20T01:54:00+08:00'));
            fixture.settlements.mockReset().mockRejectedValue(new Error(message));
            fixture.reserve.mockReset().mockRejectedValue(new Error(message));
            await mount();
            expect(text()).not.toContain('載入交割資訊');
            expect(text()).not.toContain('載入預收資訊');
            expect(text().match(/券商暫時查不到資料，稍後再試/g)).toHaveLength(2);
            expect(text()).not.toContain('查詢失敗');
            expect(view!.root.findAll(node => node.type === 'span' && node.props.title === message)).toHaveLength(2);
            expect(controls!.error).toBeNull();
            expect(retry()).toHaveLength(2);
            fixture.settlements.mockReset().mockResolvedValue([{ T: 0, date: '2026-11-20', amount: 4321 }]);
            await act(async () => { vi.advanceTimersByTime(1600); retry().forEach(b => b.props.onClick()); });
            for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
            expect(fixture.settlements).toHaveBeenCalledTimes(2);
            expect(text()).toContain('8,642');
        });

    it('送出當下已過 15:00（計時器還沒觸發）：額度查詢不送出', async () => {
        vi.setSystemTime(new Date('2026-11-20T14:59:58+08:00'));
        await mount();
        expect(fixture.limits).toHaveBeenCalledTimes(2);
        // 傳給 API 的 beforeDispatch：時段內放行，過了 15:00 才真正送出就丟錯不送
        const guard = fixture.limits.mock.calls[0]![1] as () => void;
        expect(() => guard()).not.toThrow();
        vi.setSystemTime(new Date('2026-11-20T15:00:00.010+08:00'));
        expect(() => guard()).toThrow('交易額度查詢未送出');
        await act(async () => { await controls!.refresh(); });
        expect(fixture.limits).toHaveBeenCalledTimes(2);
        // 假計時器的 tick 不跟 setSystemTime 跳：邊界計時器排在掛載後約 2 秒
        await act(async () => { vi.advanceTimersByTime(2100); });
        expect(text()).toContain('非交易時段無額度資料');
        expect(fixture.limits).toHaveBeenCalledTimes(2);
    });

    it('已有交割／預收資料時遇到暫時性錯誤：保留資料、灰字提示、不進狀態列', async () => {
        vi.setSystemTime(new Date('2026-11-20T01:54:00+08:00'));
        fixture.settlements.mockReset().mockResolvedValue([{ T: 0, date: '2026-11-20', amount: 1000 }]);
        fixture.reserve.mockReset().mockResolvedValue({ stocks: [] });
        await mount();
        expect(text()).toContain('2,000');
        fixture.settlements.mockReset().mockRejectedValue(new Error('503 Service Unavailable'));
        fixture.reserve.mockReset().mockRejectedValue(new Error('500 Internal Server Error'));
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(text()).toContain('2,000');
        expect(text()).toContain('目前無可預收股票與預收紀錄');
        expect(text().match(/券商暫時查不到資料，稍後再試/g)).toHaveLength(2);
        expect(controls!.error).toBeNull();
    });

    it('已有額度時 AS400 斷線：保留資料、灰字、不進狀態列', async () => {
        vi.setSystemTime(new Date('2026-11-20T10:00:00+08:00'));
        await mount();
        fixture.limits.mockReset().mockRejectedValue(new Error(AS400));
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(text()).toContain('現股 可用/上限');
        expect(text()).toContain('券商額度服務目前未開放');
        expect(controls!.error).toBeNull();
    });

    it('交割的其他錯誤仍是紅字錯誤＋重試，並留在狀態列', async () => {
        vi.setSystemTime(new Date('2026-11-20T10:00:00+08:00'));
        fixture.settlements.mockReset().mockRejectedValue(new Error('500 Query error: session disconnected'));
        await mount();
        expect(text()).toContain('交割資訊查詢失敗：');
        expect(text()).not.toContain('稍後再試');
        expect(controls!.error).toContain('session disconnected');
    });
});

describe('今日已實現損益與期貨保證金的券商暫時性錯誤（TKAP01／r6）', () => {
    let run = 0;
    let controls: AccountRefreshControls | null;
    const text = () => JSON.stringify(view!.toJSON());
    const retry = () => view!.root.findAll(node => node.type === 'button' && node.children.some(child => typeof child === 'string' && child.includes('重試')));
    const mount = async (market: 'S' | 'F', extra: Record<string, unknown> = {}) => {
        await act(async () => { view = create(createElement(AccountPane, { positions: [], market, scopeAccount: null, onRefreshControls: value => { controls = value; }, ...extra })); });
    };
    const setType = (type: 'S' | 'F') => fixture.accounts.forEach((a, i) => { a.account_type = type; a.account_id = `${'AB'[i]}-pnl-${run}`; });
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-20T21:30:00+08:00'));
        run += 1; controls = null; fixture.simulation = false;
        fixture.pnl.mockReset().mockResolvedValue([]); fixture.summary.mockReset().mockResolvedValue({ total: { pnl: 0 }, profitloss_sum: [] });
        fixture.settlements.mockReset().mockResolvedValue([]); fixture.reserve.mockReset().mockResolvedValue({ stocks: [] });
        fixture.limits.mockReset().mockResolvedValue(null);
    });

    it.each([
        ['S', 'list', '500 Internal Server Error'],
        ['S', 'summary', '503 9906 系統忙碌'],
        ['F', 'list', '503 Service Unavailable'],
        ['F', 'summary', '500 TKAP01 6044 無法取得交易狀態'],
    ] as const)('%s 損益 %s 遇到 %s：灰字＋重試、不算報表錯誤，重試成功顯示資料', async (type, which, message) => {
        setType(type);
        (which === 'list' ? fixture.pnl : fixture.summary).mockReset().mockRejectedValue(new Error(message));
        await mount(type);
        expect(text()).not.toContain('載入已實現損益');
        expect(text()).toContain('券商暫時查不到資料，稍後再試');
        expect(text()).not.toContain('損益資訊查詢失敗');
        expect(view!.root.findAll(node => node.type === 'span' && node.props.title === message)).toHaveLength(1);
        expect(controls!.error).toBeNull();
        fixture.pnl.mockReset().mockResolvedValue([{ id: 1, code: '2330', pnl: 600, quantity: 1, date: '20261120', dseq: 'x' }]);
        fixture.summary.mockReset().mockResolvedValue({ total: { pnl: 600 }, profitloss_sum: [{}] });
        await act(async () => { vi.advanceTimersByTime(1600); retry().forEach(b => b.props.onClick()); });
        for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
        expect(text()).toContain('1,200');
        expect(text()).not.toContain('稍後再試');
    });

    it('已有損益時遇到暫時性錯誤：保留資料、灰字、不進狀態列', async () => {
        setType('F');
        fixture.summary.mockResolvedValue({ total: { pnl: 700 }, profitloss_sum: [{}] });
        fixture.pnl.mockResolvedValue([{ id: 1, code: 'TXF', pnl: 700, quantity: 1, date: '20261120' }]);
        await mount('F');
        expect(text()).toContain('1,400');
        fixture.pnl.mockReset().mockRejectedValue(new Error('500 Internal Server Error'));
        await act(async () => { vi.advanceTimersByTime(1600); await controls!.refresh(); });
        expect(text()).toContain('1,400');
        expect(text()).toContain('券商暫時查不到資料，稍後再試');
        expect(controls!.error).toBeNull();
    });

    it('損益的其他錯誤仍是紅字＋重試，並留在狀態列', async () => {
        setType('S');
        fixture.pnl.mockReset().mockRejectedValue(new Error('500 Query error: session disconnected'));
        await mount('S');
        expect(text()).toContain('損益資訊查詢失敗：');
        expect(text()).not.toContain('稍後再試');
        expect(controls!.error).toContain('session disconnected');
    });

    it('同一批裡先回 503、另一個帳戶回真錯誤：紅字、留在狀態列', async () => {
        setType('F');
        fixture.pnl.mockReset().mockImplementation(async (_m: string, account: { account_id: string }) => {
            if (account.account_id.startsWith('A')) throw new Error('503 Service Unavailable');
            await Promise.resolve();
            throw new Error('500 Query error: session disconnected');
        });
        await mount('F');
        expect(text()).toContain('損益資訊查詢失敗：500 Query error: session disconnected');
        expect(text()).not.toContain('稍後再試');
        expect(controls!.error).toContain('session disconnected');
    });

    it('模擬環境損益不分類：裸 500 照舊紅字', async () => {
        setType('S');
        fixture.simulation = true;
        fixture.pnl.mockReset().mockRejectedValue(new Error('500 Internal Server Error'));
        await mount('S');
        for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
        expect(text()).toContain('損益資訊查詢失敗：500 Internal Server Error');
        expect(text()).not.toContain('稍後再試');
    });

    it('期貨保證金暫時性失敗：沒有上一份顯示灰字＋重試（不再卡載入）；有上一份保留並灰字', async () => {
        setType('F');
        const onRetryFunds = vi.fn();
        const failed = (margin?: object) => fixture.accounts.map(account => ({ account, ...(margin ? { margin } : {}), error: '券商保證金暫時查不到資料，稍後再試，保留此帳戶上次資料', rawError: '503 Service Unavailable', errorKind: 'temporary' })) as unknown as AccountFunds[];
        await mount('F', { funds: failed(), onRetryFunds });
        expect(text()).not.toContain('載入期貨帳務');
        expect(text()).toContain('券商暫時查不到資料，稍後再試');
        expect(text()).not.toContain('期貨帳務資訊查詢失敗');
        expect(view!.root.findAll(node => node.type === 'span' && node.props.title === '503 Service Unavailable').length).toBeGreaterThan(0);
        retry()[0]!.props.onClick();
        expect(onRetryFunds).toHaveBeenCalledTimes(1);
        const margin = { yesterday_balance: 0, today_balance: 0, equity: 5000, initial_margin: 0, maintenance_margin: 0, available_margin: 0, risk_indicator: 0, plus_margin_indicator: 0, future_settle_profitloss: 0 };
        await act(async () => { view!.update(createElement(AccountPane, { positions: [], market: 'F', scopeAccount: null, funds: failed(margin), onRetryFunds })); });
        expect(text()).toContain('10,000');
        expect(text()).toContain('券商暫時查不到資料，稍後再試');
    });

    it('期貨保證金真錯誤：紅字＋原文，不顯示舊保證金', async () => {
        setType('F');
        const margin = { yesterday_balance: 0, today_balance: 0, equity: 5000, initial_margin: 0, maintenance_margin: 0, available_margin: 0, risk_indicator: 0, plus_margin_indicator: 0, future_settle_profitloss: 0 };
        const funds = fixture.accounts.map(account => ({ account, margin, error: '保證金查詢失敗，保留此帳戶上次資料', rawError: '500 margin parse failed' }));
        await mount('F', { funds });
        expect(text()).toContain('期貨帳務資訊查詢失敗：');
        expect(text()).toContain('500 margin parse failed');
        expect(text()).not.toContain('10,000');
        expect(text()).not.toContain('稍後再試');
    });
});
