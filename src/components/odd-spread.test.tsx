// 整零價差面板：設計稿數字、按鈕啟用規則、確認後重新驗證、點價拆單、執行狀態列
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { OddSpreadFeed } from '../hooks/use-odd-spread-feed';
import type { SpreadExecRecord } from '../lib/odd-spread-service';

const mocks = vi.hoisted(() => ({
    place: vi.fn(), notify: vi.fn(), confirm: vi.fn(), start: vi.fn(), action: vi.fn(), dismiss: vi.fn(), refresh: vi.fn(),
    candidates: vi.fn((): unknown[] => []), claim: vi.fn(),
    addLock: vi.fn((..._a: unknown[]) => 'lk-1'), updateLock: vi.fn(), clearLock: vi.fn(),
    accept: vi.fn((..._a: unknown[]) => true), env: { base: 'http://127.0.0.1:21322', simulation: true as boolean | undefined }, envOk: { value: true },
    risk: { confirmManualOrders: false },
}));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts: [], selectedStock: undefined }) }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true, useQuote: () => undefined }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: undefined, book: undefined }) }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => mocks.risk }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: mocks.confirm, accountConfirmLabel: () => 'BR-***A' }));
vi.mock('../lib/utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, d: number) => p + d * 5 }));
vi.mock('../lib/odd-spread-service', () => ({
    startSpreadExecution: mocks.start,
    spreadExecAction: mocks.action,
    dismissSpreadExecution: mocks.dismiss,
    refreshHedgeOrders: mocks.refresh,
    candidateOrders: mocks.candidates,
    claimOrder: mocks.claim,
    ENV_PAUSED_TEXT: '環境已切換，執行暫停',
    envMatches: () => mocks.envOk.value,
    currentEnv: () => mocks.env,
    acceptHedge: mocks.accept,
    oddSpreadExecUnavailable: () => null,
    useSpreadExecutions: () => [],
    useClickLocks: () => [],
    addClickLock: mocks.addLock,
    updateClickLock: mocks.updateLock,
    clearClickLock: mocks.clearLock,
    hedgeUnitLabel: (leg: string, q: number) => (leg === 'odd' ? `零股 ${q} 股` : `整股 ${q} 張`),
}));

import { OddSpreadView, type OddSpreadViewProps } from './odd-spread';

const account: Account = { account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
const otherAccount: Account = { ...account, account_id: 'B' };
const contract = { code: '2330', name: '台積電', security_type: 'STK', reference: 1080, limit_up: 1185, limit_down: 975 } as unknown as ContractInfo;
const feed: OddSpreadFeed = {
    round: {
        asks: [{ price: 1085, vol: 2317 }, { price: 1090, vol: 1038 }, { price: 1095, vol: 655 }, { price: 1100, vol: 412 }],
        bids: [{ price: 1080, vol: 1904 }, { price: 1075, vol: 822 }, { price: 1070, vol: 530 }],
    },
    odd: {
        asks: [{ price: 1100, vol: 86 }],
        bids: [{ price: 1095, vol: 380 }, { price: 1090, vol: 1020 }, { price: 1085, vol: 640 }, { price: 1080, vol: 3410 }, { price: 1075, vol: 2200 }, { price: 1070, vol: 150 }],
    },
    roundLast: 1085, roundChange: 5, oddLast: 1095, oddChange: 15, oddTime: '10:52:57', oddAvailable: true,
};

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const buttons = () => view.root.findAllByType('button');
const button = (label: string) => buttons().find(b => text(b).includes(label))!;
const input = (label: string) => view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === label)[0]!;
const base: OddSpreadViewProps = { contract, feed, inventoryShares: 3420, live: true, account, execUnavailable: null };
const lossFeed: OddSpreadFeed = { ...feed, odd: { bids: [{ price: 1080, vol: 5000 }], asks: [{ price: 1100, vol: 5000 }] } };
const executeButton = (direction = '買整 → 賣零') => buttons().find(b => String(b.props['aria-label'] ?? '').startsWith(direction))!;
const render = async (p: Partial<OddSpreadViewProps> = {}) => {
    await act(async () => { view = create(createElement(OddSpreadView, { ...base, ...p })); });
};
const rerender = async (p: Partial<OddSpreadViewProps>) => {
    await act(async () => { view.update(createElement(OddSpreadView, { ...base, ...p })); });
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.risk.confirmManualOrders = false;
    mocks.envOk.value = true;
    mocks.env = { base: 'http://127.0.0.1:21322', simulation: true };
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ discount: 0.6, taxRate: null }), setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('顯示設計稿的兩個方向與價格梯', async () => {
    await render();
    const all = text(view.root);
    for (const s of ['台積電', '零股撮合', '10:52:57', '+10.00', '92 bps', '+4.85 元/股', '1,095×380、1,090×620', '+1.76 元/股', '+1,763 元', '−20.00', '−182 bps', '−25.10 元/股', '可賣 整 3 張／零 420 股']) {
        expect(all).toContain(s);
    }
    expect(button('以 1 張執行').props.disabled).toBe(false);
    expect(button('零股量不足').props.disabled).toBe(true);
    expect(button('買整賣零').props.disabled).toBe(false);
    expect(button('買零賣整').props.disabled).toBe(true);
    const rows = view.root.findAll(n => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('ladderRow'));
    expect(rows.length).toBe(7);
});

it('未接上零股行情時兩個方向都停用', async () => {
    await render({ feed: { ...feed, odd: { bids: [], asks: [] }, oddAvailable: false, oddLast: null, oddTime: null } });
    expect(text(view.root)).toContain('等待零股行情');
    expect(button('買整賣零').props.disabled).toBe(true);
    expect(button('買零賣整').props.disabled).toBe(true);
});

it('彈出視窗：兩腳送單停用並說明原因', async () => {
    await render({ execUnavailable: '兩腳價差單只能在主視窗執行（彈出視窗關閉後無法繼續追蹤第二腳）' });
    expect(text(view.root)).toContain('只能在主視窗執行');
    expect(button('買整賣零').props.disabled).toBe(true);
    expect(button('請在主視窗執行').props.disabled).toBe(true);
});

it('張數改 2 → 加權後不賺，依完整費稅顯示虧損確認', async () => {
    await render();
    await act(async () => { input('整股張數').props.onChange({ target: { value: '2' } }); });
    expect(input('零股股數').props.value).toBe('2,000');
    expect(executeButton().props.disabled).toBe(false);
    expect(text(executeButton())).toContain('仍要送出（預估虧損 1,356 元）');
    expect(button('價差未達成本').props.disabled).toBe(true);
});

it.each(['買整 → 賣零', '買零 → 賣整'])('未達成本（%s）：第一次只武裝，5 秒內第二次才交給原送單流程', async direction => {
    vi.useFakeTimers();
    await render({ feed: lossFeed });
    const warningClass = executeButton(direction).props.className;
    if (direction === '買整 → 賣零') expect(text(executeButton(direction))).toContain('仍要送出（預估虧損 10,091 元）');
    await act(async () => { executeButton(direction).props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(text(executeButton(direction))).toContain('再按一次確認 · 虧損');
    expect(executeButton(direction).props.className).not.toBe(warningClass);
    await act(async () => { vi.advanceTimersByTime(4999); executeButton(direction).props.onClick(); });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls[0]![0].plan.direction).toBe(direction === '買整 → 賣零' ? 'buyRoundSellOdd' : 'buyOddSellRound');
    expect(mocks.start.mock.calls[0]![0].plan.oddOrders.map((o: { quantity: number }) => o.quantity)).toEqual([999, 1]);
    expect(text(executeButton(direction))).toContain('仍要送出');
});

it('武裝滿 5 秒解除；下一次點擊只重新武裝', async () => {
    vi.useFakeTimers();
    await render({ feed: lossFeed });
    await act(async () => { executeButton().props.onClick(); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(text(executeButton())).toContain('仍要送出');
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(text(executeButton())).toContain('再按一次確認');
});

it('計時回呼尚未執行但已逾時，也不能沿用舊確認送出', async () => {
    vi.useFakeTimers();
    await render({ feed: lossFeed });
    await act(async () => { executeButton().props.onClick(); });
    vi.setSystemTime(Date.now() + 5000);
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
});

it.each(['價差', '商品', '帳戶', '數量', '零股數量', '費用', '送單方式'])('%s 變動後解除武裝，改回原值也須重新確認', async change => {
    await render({ feed: lossFeed });
    await act(async () => { executeButton().props.onClick(); });
    if (change === '價差') {
        await rerender({ feed: { ...lossFeed, odd: { ...lossFeed.odd, bids: [{ price: 1075, vol: 5000 }] } } });
        await rerender({ feed: lossFeed });
    } else if (change === '商品' || change === '帳戶') {
        await rerender({ feed: lossFeed, ...(change === '商品' ? { contract: { ...contract, code: '2317' } as ContractInfo } : { account: otherAccount }) });
        await rerender({ feed: lossFeed });
    } else if (change === '數量') {
        await act(async () => { input('整股張數').props.onChange({ target: { value: '2' } }); });
    } else if (change === '零股數量') {
        await act(async () => { button('配對').props.onClick(); });
        await act(async () => { input('零股股數').props.onChange({ target: { value: '500' } }); });
    } else if (change === '費用') {
        await act(async () => { input('證交稅率（%）').props.onChange({ target: { value: '0.15' } }); });
    } else {
        await act(async () => { view.root.findByType('select').props.onChange({ target: { value: 'simultaneous' } }); });
    }
    expect(text(executeButton())).toContain('仍要送出');
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
});

it.each([
    { live: false }, { account: undefined }, { inventoryShares: null }, { inventoryShares: 999 },
    { initialLots: 0 }, { execUnavailable: '只能在主視窗執行' },
    { feed: { ...lossFeed, odd: { ...lossFeed.odd, bids: [{ price: 1080, vol: 999 }] } } },
    { feed: { ...lossFeed, round: { ...lossFeed.round, asks: [{ price: 1085, vol: 0.5 }] } } },
    { clickLocks: [{ id: 'locked', code: '2330', account: 'S-BR-A', text: '結果未確認', at: 0 }] },
])('其他停用原因不提供虧損強制送出：%j', async props => {
    await render({ feed: lossFeed, ...props });
    expect(executeButton().props.disabled).toBe(true);
    expect(text(executeButton())).not.toContain('仍要送出');
    await act(async () => { executeButton().props.onClick(); executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
});

it('零股賣出超過可賣量，即使未達成本仍不可點', async () => {
    await render({ feed: lossFeed, inventoryShares: 1500 });
    await act(async () => { button('配對').props.onClick(); });
    await act(async () => { input('零股股數').props.onChange({ target: { value: '2000' } }); });
    expect(executeButton().props.disabled).toBe(true);
    await act(async () => { executeButton().props.onClick(); executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
});

it.each(['執行中', '結果不明', '較早未確認', '斷線'])('武裝後出現%s，仍不可點；解除阻擋後須重新武裝', async reason => {
    await render({ feed: lossFeed });
    await act(async () => { executeButton().props.onClick(); });
    const props = reason === '斷線' ? { live: false } : {
        execs: [rec({
            phase: reason === '較早未確認' ? 'failed' : reason === '結果不明' ? 'unknown' : 'oddPending',
            slots: reason === '執行中' ? [] : [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1080, quantity: 999, status: 'unknown', filled: 0 }],
        })],
    } satisfies Partial<OddSpreadViewProps>;
    await rerender({ feed: lossFeed, ...props });
    expect(executeButton().props.disabled).toBe(true);
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
    await rerender({ feed: lossFeed });
    expect(text(executeButton())).toContain('仍要送出');
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
});

it('有利價差維持一次點擊執行', async () => {
    await render();
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(text(executeButton())).toContain('買整賣零');
});

it('虧損第二次確認後仍依設定跳委託確認，期間價差改變則不送', async () => {
    mocks.risk.confirmManualOrders = true;
    let approve!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
    await render({ feed: lossFeed });
    await act(async () => { executeButton().props.onClick(); });
    await act(async () => { executeButton().props.onClick(); });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    await rerender({ feed: { ...lossFeed, odd: { ...lossFeed.odd, bids: [{ price: 1075, vol: 5000 }] } } });
    await act(async () => { approve(true); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('確認期間價差、數量或費用已變動');
});

it('執行：把點擊當下的商品、帳戶與計畫交給主視窗服務', async () => {
    await render();
    await act(async () => { button('以 1 張執行').props.onClick(); });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    const req = mocks.start.mock.calls[0]![0];
    expect(req.contract).toBe(contract);
    expect(req.account).toBe(account);
    expect(req.plan).toEqual({
        direction: 'buyRoundSellOdd', mode: 'sequential', lots: 1, roundPrice: 1085,
        oddOrders: [{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }], netPerShare: 1.76,
    });
    expect(req.fees).toMatchObject({ discount: 0.6, taxRate: 0.003, minFeeRound: 20, minFeeOdd: 1 });
    expect(req.maxSlipTicks).toBe(2);
    expect(req.env).toEqual({ base: 'http://127.0.0.1:21322', simulation: true });
});

it('委託確認期間帳戶、商品或行情變了 → 不送並說明', async () => {
    mocks.risk.confirmManualOrders = true;
    let approve!: (v: boolean) => void;
    const pending = () => { mocks.confirm.mockImplementationOnce(() => new Promise(r => { approve = r; })); };

    pending();
    await render();
    await act(async () => { button('以 1 張執行').props.onClick(); });
    expect(mocks.confirm.mock.calls[0]![0].note).toContain('整零價差');
    await rerender({ account: otherAccount });
    await act(async () => { approve(true); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('確認期間帳戶已變更');

    pending();
    await rerender({ account });
    await act(async () => { button('以 1 張執行').props.onClick(); });
    await rerender({ contract: { ...contract, code: '2317' } as ContractInfo });
    await act(async () => { approve(true); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('確認期間商品已切換');

    pending();
    await rerender({ contract });
    await act(async () => { button('以 1 張執行').props.onClick(); });
    // 零股買一被吃掉，價差不再成立
    await rerender({ feed: { ...feed, odd: { ...feed.odd, bids: [{ price: 1080, vol: 5000 }] } } });
    await act(async () => { approve(true); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('確認期間行情或庫存已變動');

    pending();
    await rerender({ feed });
    await act(async () => { button('以 1 張執行').props.onClick(); });
    await rerender({ inventoryShares: 500 });
    await act(async () => { approve(true); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('庫存不足');

    // 都沒變 → 送出確認過的那一份
    pending();
    await rerender({ inventoryShares: 3420 });
    await act(async () => { button('以 1 張執行').props.onClick(); });
    await act(async () => { approve(true); });
    expect(mocks.start).toHaveBeenCalledTimes(1);
});

it('點價下單：未啟用不送；1,000 股拆 999＋1，後一筆失敗時說明哪筆已送出並鎖定點價', async () => {
    mocks.place.mockResolvedValueOnce({ order: { id: 'X' }, status: { status: 'Submitted' } })
        .mockRejectedValueOnce(new Error('連線逾時'));
    await render();
    const locked = view.root.findAll(n => n.type === 'span' && n.props.title === '先啟用點價')[0]!;
    await act(async () => { locked.props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
    await act(async () => { button('啟用點價').props.onClick(); });
    const cell = view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('零股限價買'))[0]!;
    await act(async () => { cell.props.onClick(); });
    expect(mocks.place.mock.calls.map(c => [c[1], c[3], c[4].orderLot])).toEqual([
        ['Buy', 999, 'IntradayOdd'],
        ['Buy', 1, 'IntradayOdd'],
    ]);
    const n = mocks.notify.mock.calls.at(-1)![0];
    expect(n.title).toBe('零股拆單只送出部分');
    expect(n.body).toContain('已送出 999 股');
    expect(n.body).toContain('零股 第 2/2 筆 1 股結果未確認（可能已送出）');
    expect(mocks.updateLock).toHaveBeenCalledWith('lk-1', expect.stringContaining('已送出 999 股'));
    expect(n.body).toContain('勿重送整筆');
    // 點價已鎖定，不能直接再點一次
    expect(button('啟用點價')).toBeDefined();
});

it('整股點價：手動來源（依設定跳確認）', async () => {
    mocks.place.mockResolvedValue({ order: { id: 'X' }, status: { status: 'Submitted' } });
    await render();
    await act(async () => { button('啟用點價').props.onClick(); });
    const roundAsk = view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('整股限價賣'))[0]!;
    await act(async () => { roundAsk.props.onClick(); });
    expect(mocks.place.mock.calls[0]!.slice(1, 4)).toEqual(['Sell', expect.any(Number), 1]);
    expect(mocks.place.mock.calls[0]![4].orderLot).toBeUndefined();
    expect(mocks.place.mock.calls[0]![4].source).toBeUndefined();
});

it('手續費折數、最低手續費、稅率與補單滑價存本機，並反映在試算', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ discount: 0.6 }), setItem });
    await render();
    await act(async () => { input('手續費折數').props.onChange({ target: { value: '2.8' } }); });
    await act(async () => { input('證交稅率（%）').props.onChange({ target: { value: '0.15' } }); });
    await act(async () => { input('零股每筆最低手續費（元）').props.onChange({ target: { value: '5' } }); });
    await act(async () => { input('整股每筆最低手續費（元）').props.onChange({ target: { value: '1' } }); });
    await act(async () => { input('補單滑價上限（檔）').props.onChange({ target: { value: '3' } }); });
    expect(JSON.parse(setItem.mock.calls.at(-1)![1])).toEqual({ discount: 0.28, taxRate: 0.0015, minFeeRound: 1, minFeeOdd: 5, maxSlipTicks: 3 });
});

const rec = (state: Partial<SpreadExecRecord['state']>): SpreadExecRecord => ({
    id: 'os-1', tagBase: 'abc', env: { base: 'http://127.0.0.1:21322', simulation: true },
    contract, account, fees: { discount: 0.6, taxRate: 0.003 }, maxSlipTicks: 2, startedAt: 0,
    state: {
        plan: { direction: 'buyRoundSellOdd', mode: 'sequential', lots: 1, roundPrice: 1085, oddOrders: [{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }] },
        phase: 'oddPending', slots: [], started: true, cancelRequested: false, seq: 2, waived: { odd: 0, round: 0 }, pendingHedge: null,
        ...state,
    },
});

it('未配對待處理：列出原因與最新價，可以最新價補單或取消', async () => {
    mocks.refresh.mockReturnValue([{ price: 1100, quantity: 1 }]);
    const exec = rec({
        phase: 'hedgeDecision',
        slots: [
            { key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380, status: 'filled', filled: 380 },
            { key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 620, status: 'filled', filled: 620 },
        ],
        pendingHedge: { leg: 'round', action: 'Buy', quantity: 1, reason: '價格已偏離計畫價超過 2 檔（1,085 → 1,100）', orders: [{ price: 1100, quantity: 1 }], version: 3 },
    });
    await render({ execs: [exec] });
    const all = text(view.root);
    expect(all).toContain('未配對，待處理');
    expect(all).toContain('未配對 零股多 1,000 股');
    expect(all).toContain('超過 2 檔');
    expect(button('買整賣零').props.disabled).toBe(true);
    await act(async () => { button('以最新價補單').props.onClick(); });
    expect(mocks.accept).toHaveBeenCalledWith('os-1', { version: 3, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] });
    await act(async () => { buttons().find(b => text(b) === '取消')!.props.onClick(); });
    expect(mocks.action).toHaveBeenCalledWith('os-1', { type: 'hedgeDecline', version: 3 });
});

it('結果不明：說明哪筆、禁止再執行，可在核對後標記未送出', async () => {
    const exec = rec({
        phase: 'unknown',
        slots: [
            { key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380, status: 'filled', filled: 380 },
            { key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 620, status: 'unknown', filled: 0 },
        ],
    });
    await render({ execs: [exec] });
    expect(text(view.root)).toContain('零股 620 股 @ 1,090：可能已送出但未收到回應');
    expect(button('有委託結果未確認').props.disabled).toBe(true);
    await act(async () => { button('已核對：未送出').props.onClick(); });
    expect(mocks.action).toHaveBeenCalledWith('os-1', { type: 'resolveUnknown', key: 'odd:1' });
});

it('結果不明且委託列有同價量無標記的委託：列出候選由使用者指定，不自動認領', async () => {
    mocks.candidates.mockReturnValue([{ order: { id: 'X1', ordno: 'A0001' } }]);
    const exec = rec({
        phase: 'unknown',
        slots: [{ key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 620, status: 'unknown', filled: 0 }],
    });
    await render({ execs: [exec] });
    expect(text(view.root)).toContain('沒有標記的委託，是否為這筆');
    await act(async () => { button('是 A0001').props.onClick(); });
    expect(mocks.claim).toHaveBeenCalledWith('os-1', 'odd:1', 'X1');
});

it('刪單失敗：列出失敗的委託與原因，按鈕改為「再次取消」可重試', async () => {
    const exec = rec({
        phase: 'oddPending',
        cancelRequested: true,
        slots: [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380, status: 'working', filled: 0, orderId: 'A', cancelState: 'failed', cancelError: '伺服器忙碌' }],
    });
    await render({ execs: [exec] });
    expect(text(view.root)).toContain('刪單失敗：零股 380 股 @ 1,095（伺服器忙碌）');
    await act(async () => { button('再次取消').props.onClick(); });
    expect(mocks.action).toHaveBeenCalledWith('os-1', { type: 'cancel' });
});

it('環境已切換：顯示暫停並停用操作', async () => {
    const exec = rec({ phase: 'oddPending', slots: [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380, status: 'working', filled: 0, orderId: 'A' }] });
    await render({ execs: [exec], isPaused: () => true });
    expect(text(view.root)).toContain('環境已切換，執行暫停');
    expect(button('取消剩餘').props.disabled).toBe(true);
    expect(button('執行暫停（環境已切換）').props.disabled).toBe(true);
});

it('拆單第一筆就逾時（結果不明）：送出前加持久化鎖、失敗後保持鎖定並說明', async () => {
    mocks.place.mockRejectedValueOnce(new Error('連線逾時'));
    await render();
    await act(async () => { button('啟用點價').props.onClick(); });
    const cell = () => view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('零股限價買'))[0];
    await act(async () => { cell()!.props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(mocks.addLock).toHaveBeenCalledTimes(1);
    expect(mocks.addLock.mock.calls[0]!.slice(0, 2)).toEqual(['2330', account]);
    expect(mocks.clearLock).not.toHaveBeenCalled();
    expect(mocks.updateLock).toHaveBeenCalledWith('lk-1', '2330 買 @ 1,100：零股 第 1/2 筆 999 股結果未確認（可能已送出）；第 2～2 筆未送');
    expect(mocks.notify.mock.calls.at(-1)![0].title).toBe('點價委託結果未確認');
    expect(button('啟用點價')).toBeDefined();
});

it('拆單只送出部分、其餘確定未送：同樣鎖定，說明哪幾筆已送出', async () => {
    mocks.place.mockResolvedValueOnce({ order: { id: 'X' }, status: { status: 'Submitted' } })
        .mockRejectedValueOnce(Object.assign(new Error('風控'), { mutationNotStarted: true }));
    await render();
    await act(async () => { button('啟用點價').props.onClick(); });
    const cell = view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('零股限價買'))[0]!;
    await act(async () => { cell.props.onClick(); });
    expect(mocks.clearLock).not.toHaveBeenCalled();
    expect(mocks.updateLock).toHaveBeenCalledWith('lk-1', '2330 買 @ 1,100：已送出 999 股；零股 第 2/2 筆 1 股未送出');
    expect(mocks.notify.mock.calls.at(-1)![0].title).toBe('零股拆單只送出部分');
});

it('有點價鎖時：顯示原因、不能啟用點價；核對後解除', async () => {
    await render({ clickLocks: [{ id: 'lk-9', code: '2330', account: 'S-BR-A', text: '2330 買 @ 1,100：已送出 999 股；零股 第 2/2 筆 1 股未送出', at: 0 }] });
    expect(text(view.root)).toContain('已送出 999 股；零股 第 2/2 筆 1 股未送出；點價已鎖定');
    expect(button('啟用點價').props.disabled).toBe(true);
    await act(async () => { button('已核對委託，解除鎖定').props.onClick(); });
    expect(mocks.clearLock).toHaveBeenCalledWith('lk-9');
});

it('全部送出或確定一筆都沒送：解除鎖', async () => {
    mocks.place.mockRejectedValueOnce(Object.assign(new Error('風控'), { mutationNotStarted: true }))
        .mockResolvedValue({ order: { id: 'X' }, status: { status: 'Submitted' } });
    await render();
    await act(async () => { button('啟用點價').props.onClick(); });
    const cell = () => view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('零股限價買'))[0]!;
    await act(async () => { cell().props.onClick(); });
    expect(mocks.clearLock).toHaveBeenCalledTimes(1);
    expect(mocks.updateLock).not.toHaveBeenCalled();
    await act(async () => { cell().props.onClick(); });
    expect(mocks.clearLock).toHaveBeenCalledTimes(2);
});

it('同商品有多筆需要處理的執行：每筆各自顯示與操作', async () => {
    const older = { ...rec({
        phase: 'hedgeDecision',
        slots: [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 1000, status: 'filled', filled: 1000 }],
        pendingHedge: { leg: 'round', action: 'Buy', quantity: 1, reason: '補單未成交（被拒或已刪除）', orders: [], version: 4 },
    }), id: 'os-old' };
    const newer = { ...rec({ phase: 'failed', slots: [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380, status: 'cancelled', filled: 0 }] }), id: 'os-new' };
    await render({ execs: [newer, older] });
    const all = text(view.root);
    expect(all).toContain('補單未成交（被拒或已刪除）');
    expect(all).toContain('未完成');
    await act(async () => { buttons().find(b => text(b) === '取消')!.props.onClick(); });
    expect(mocks.action).toHaveBeenCalledWith('os-old', { type: 'hedgeDecline', version: 4 });
    await act(async () => { button('關閉').props.onClick(); });
    expect(mocks.dismiss).toHaveBeenCalledWith('os-new');
});

it('環境在按下時綁定：確認期間切換伺服器或模擬／正式 → 不送', async () => {
    mocks.risk.confirmManualOrders = true;
    let approve!: (v: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise(r => { approve = r; }));
    await render();
    await act(async () => { button('以 1 張執行').props.onClick(); });
    mocks.envOk.value = false; // 確認視窗開著時切到正式
    await act(async () => { approve(true); });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('確認期間伺服器或模擬／正式環境已切換');
});

it('模擬／正式未知時不開始', async () => {
    mocks.env = { base: 'http://127.0.0.1:21322', simulation: undefined };
    await render();
    await act(async () => { button('以 1 張執行').props.onClick(); });
    expect(mocks.start).not.toHaveBeenCalled();
});

it('點價拆單整批固定環境：每一筆送出前檢查，切換後不送', async () => {
    mocks.place.mockResolvedValue({ order: { id: 'X' }, status: { status: 'Submitted' } });
    await render();
    await act(async () => { button('啟用點價').props.onClick(); });
    const cell = view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('零股限價買'))[0]!;
    await act(async () => { cell.props.onClick(); });
    const hooks = mocks.place.mock.calls.map(c => c[4].beforeSend as () => void);
    expect(hooks).toHaveLength(2);
    for (const h of hooks) expect(() => h()).not.toThrow();
    mocks.envOk.value = false;
    for (const h of hooks) expect(() => h()).toThrow('環境已切換');
});

it('補單確認：以確認當下的數量與價格送；缺口已變則不送並請重新確認', async () => {
    mocks.refresh.mockReturnValue([{ price: 1100, quantity: 1 }]);
    const exec = rec({
        phase: 'hedgeDecision',
        slots: [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 1000, status: 'filled', filled: 1000 }],
        pendingHedge: { leg: 'round', action: 'Buy', quantity: 1, reason: 'x', orders: [{ price: 1100, quantity: 1 }], version: 3 },
    });
    mocks.accept.mockReturnValueOnce(false);
    await render({ execs: [exec] });
    await act(async () => { button('以最新價補單').props.onClick(); });
    expect(mocks.accept).toHaveBeenCalledWith('os-1', { version: 3, leg: 'round', action: 'Buy', quantity: 1, orders: [{ price: 1100, quantity: 1 }] });
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('確認期間缺口或環境已變更');
    // 建議委託總量與缺口不符 → 不送
    mocks.refresh.mockReturnValue([{ price: 1100, quantity: 2 }]);
    mocks.accept.mockClear();
    await act(async () => { button('以最新價補單').props.onClick(); });
    expect(mocks.accept).not.toHaveBeenCalled();
});

it('較早執行還有標記「未送出」但未確認的委託：擋下新單、可確認沒有送出並結束追蹤', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: () => true });
    const old = { ...rec({
        phase: 'failed',
        slots: [{ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380, status: 'unknown', filled: 0, markedUnsent: true }],
    }), id: 'os-old' };
    await render({ execs: [old] });
    expect(button('先確認較早的未送出委託').props.disabled).toBe(true);
    expect(text(view.root)).toContain('在確認前，同商品不能開始新的價差單');
    await act(async () => { button('確認沒有送出，結束追蹤').props.onClick(); });
    expect(mocks.action).toHaveBeenCalledWith('os-old', { type: 'abandonUnknown', key: 'odd:0' });
});
