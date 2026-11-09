// 權證閃電下單（docs/qa/warrant-rules.md）：權證走證券帳戶、固定整張現股
//（不得零股、不適用信用），外國標的權證（第六碼 F／Q）無漲跌幅、市價鈕停用。
// SDK 1.7 以前權證可能標成 STK：以代號判斷，行為與 WRT 相同。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn(), store: new Map<string, string>() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'A1234', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '5', volume: 1 } }, snapshot: { close: 5 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0, bandTickFor: () => undefined, prefetchTickBands: () => undefined }));
import { FlashOrder } from './flash-order';
import { WARRANT_FLASH_TEXT, WARRANT_TEXT } from '../lib/warrant-rules';
import * as css from './flash-order.css';

const wrt = { code: '030392', name: '台積電群益64購09', security_type: 'WRT', exchange: 'TSE', target_code: null, reference: 5, limit_up: 7.2, limit_down: 3.1 } as unknown as ContractInfo;
const otcWrt = { ...wrt, code: '700001', name: '上櫃測試購', exchange: 'OTC' } as ContractInfo;
const stkTyped = { ...wrt, security_type: 'STK' } as ContractInfo;
const foreign = { ...wrt, code: '03001F', name: '外國標的購', limit_up: 0, limit_down: 0 } as ContractInfo;
const foreignStkTyped = { ...foreign, security_type: 'STK' } as ContractInfo;
const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b).includes(label))!;
const mktBtn = (r: ReactTestRenderer, side: '買' | '賣') => r.root.findAllByType('button').find(b => text(b) === `市價${side}`)!;
const kind = (r: ReactTestRenderer) => text(r.root.findAll(n => n.props['data-testid'] === 'flash-kind')[0]!);
const props = (contract: ContractInfo, extra: Record<string, unknown> = {}) => ({ contract, trades: [], positions: [], ...extra });
const mount = async (contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(FlashOrder, props(contract, extra))); });
    roots.push(r);
    return r;
};
const show = async (r: ReactTestRenderer, contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    await act(async () => { r.update(createElement(FlashOrder, props(contract, extra))); });
};
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單').props.onClick(); }); };
const buyCellAt = (r: ReactTestRenderer, price: string) => r.root.findAll(n => {
    if (n.type !== 'div') return false;
    const title = String(n.props.title ?? '');
    return title.startsWith(`限價買 ${price}`) && !/[\d.]/.test(title.charAt(`限價買 ${price}`.length));
})[0];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.store.get(k) ?? null, setItem: (k: string, v: string) => { mocks.store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.unstubAllGlobals();
});

describe.each([
    ['WRT 上市權證', wrt],
    ['WRT 上櫃權證', otcWrt],
    ['標成 STK 的權證代號', stkTyped],
])('%s 可以閃電下單', (_name, contract) => {
    it('走證券帳戶、整張現股，限價點價送出', async () => {
        const r = await mount(contract);
        expect(kind(r)).toBe('權證張');
        await arm(r);
        const cell = buyCellAt(r, '5.00');
        expect(cell).toBeDefined();
        await act(async () => { cell!.props.onClick({ altKey: false }); });
        expect(mocks.place).toHaveBeenCalledOnce();
        const [sent, action, price, qty, opts] = mocks.place.mock.calls[0]!;
        expect(sent).toMatchObject({ code: contract.code });
        expect(action).toBe('Buy');
        expect(price).toBe(5);
        expect(qty).toBe(1);
        expect(opts.account).toBe(accounts[0]);
        expect(opts.orderLot).toBeUndefined();
        expect(opts.orderCond).toBeUndefined();
    });

    it('階梯照權證級距：5 元以上跳 0.05、以下跳 0.01', async () => {
        const r = await mount(contract);
        await arm(r);
        expect(buyCellAt(r, '5.05')).toBeDefined();
        expect(buyCellAt(r, '4.99')).toBeDefined();
        // 股票表在 5–10 元是 0.01，權證不會出現 5.01
        expect(buyCellAt(r, '5.01')).toBeUndefined();
    });

    it('國內標的權證有漲跌幅：市價鈕可用', async () => {
        const r = await mount(contract);
        expect(mktBtn(r, '買').props.disabled).toBe(false);
        expect(mktBtn(r, '賣').props.disabled).toBe(false);
    });
});

it('面板存著盤中零股與融資：權證固定整張現股，設定保留，換回股票時恢復', async () => {
    const owner = { lot: 'IntradayOdd', credit: { cond: 'MarginTrading', daytradeShort: false } };
    const extra = () => ({ lot: owner.lot, onLotChange: (l: string) => { owner.lot = l; }, credit: owner.credit, onCreditChange: (c: typeof owner.credit) => { owner.credit = c; } });
    const r = await mount(wrt, extra());
    expect(kind(r)).toBe('權證張');
    expect(text(r.root)).not.toContain('融資');
    await arm(r);
    await act(async () => { buyCellAt(r, '5.00')!.props.onClick({ altKey: false }); });
    const opts = mocks.place.mock.calls[0]![4];
    expect(opts.orderLot).toBeUndefined();
    expect(opts.orderCond).toBeUndefined();
    expect(owner.lot).toBe('IntradayOdd');
    expect(owner.credit.cond).toBe('MarginTrading');
    await show(r, stk, extra());
    expect(kind(r)).toBe('零股股');
});

it('設定選單：權證不顯示零股與信用選項，改顯示說明', async () => {
    const r = await mount(wrt);
    await act(async () => { r.root.findAll(n => n.props['data-testid'] === 'flash-settings')[0]!.props.onClick(); });
    const all = text(r.root);
    expect(all).toContain('權證只能以整張');
    expect(all).not.toContain('股（盤中零股）');
    expect(r.root.findAll(n => n.props.role === 'menuitemcheckbox' && text(n).includes('現股當沖先賣'))).toHaveLength(0);
    expect(r.root.findAll(n => n.props.role === 'menuitemradio' && text(n).includes('融資'))).toHaveLength(0);
});

describe.each([
    ['WRT 外國標的', foreign],
    ['標成 STK 的外國標的權證', foreignStkTyped],
])('%s：無漲跌幅、交易所不收市價', (_name, contract) => {
    it('市價鈕停用並說明原因，點價限價照常', async () => {
        const r = await mount(contract);
        for (const side of ['買', '賣'] as const) {
            expect(mktBtn(r, side).props.disabled).toBe(true);
            expect(mktBtn(r, side).props.title).toBe(WARRANT_TEXT.foreignMarket);
        }
        await arm(r);
        await act(async () => { buyCellAt(r, '5.00')!.props.onClick({ altKey: false }); });
        expect(mocks.place).toHaveBeenCalledOnce();
        expect(mocks.place.mock.calls[0]![2]).toBe(5);
    });

    it('即使市價鈕被觸發（快捷鍵等），也不送出', async () => {
        const r = await mount(contract);
        await arm(r);
        await act(async () => { mktBtn(r, '買').props.onClick(); });
        expect(mocks.place).not.toHaveBeenCalled();
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ body: WARRANT_TEXT.foreignMarket }));
    });
});

describe('外國標的權證：市價停用要看得出來', () => {
    it('市價鈕帶鎖頭與規則樣式，面板上直接寫出原因', async () => {
        const r = await mount(foreign);
        const note = r.root.findAll(n => n.props['data-testid'] === 'flash-warrant-market');
        expect(note).toHaveLength(1);
        expect(text(note[0]!)).toBe(WARRANT_FLASH_TEXT.foreignMarket);
        expect(String(mktBtn(r, '買').props.className)).toContain(css.ruleLocked);
        expect(mktBtn(r, '買').findAll(n => n.props.className === css.ruleLockIcon).length).toBeGreaterThan(0);
    });

    it('國內標的權證與股票沒有這行說明，市價鈕不是規則停用樣式', async () => {
        for (const c of [wrt, stk]) {
            const r = await mount(c);
            expect(r.root.findAll(n => n.props['data-testid'] === 'flash-warrant-market')).toHaveLength(0);
            expect(String(mktBtn(r, '買').props.className)).not.toContain(css.ruleLocked);
        }
    });
});

describe('權證暫不支援觸價與停損停利', () => {
    const openMenu = async (r: ReactTestRenderer) => {
        await act(async () => { r.root.findAll(n => n.props['data-testid'] === 'flash-settings')[0]!.props.onClick(); });
    };
    const group = (r: ReactTestRenderer, label: string) => r.root.findAll(n => n.props.role === 'group' && n.props['aria-label'] === label);
    const headers = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'span' && (text(n) === '觸買' || text(n) === '觸賣'));

    it('權證：沒有觸買／觸賣欄、選單沒有觸價設定與停損停利，只留一行說明', async () => {
        const r = await mount(wrt);
        expect(headers(r)).toHaveLength(0);
        expect(r.root.findAll(n => n.props['data-trigger'] !== undefined && n.type === 'div')).toHaveLength(0);
        expect(r.root.findAll(n => n.props['data-testid'] === 'flash-protect')).toHaveLength(0);
        await openMenu(r);
        expect(group(r, '觸價後')).toHaveLength(0);
        expect(group(r, '觸價點法')).toHaveLength(0);
        expect(r.root.findAll(n => n.props.role === 'menuitem' && text(n).includes('自動停損停利'))).toHaveLength(0);
        const note = r.root.findAll(n => n.props['data-testid'] === 'flash-warrant-trigger-note');
        expect(note).toHaveLength(1);
        expect(text(note[0]!)).toContain('權證暫不支援觸價');
    });

    it('權證面板存著觸價欄與停損停利開啟：欄位仍收起，停損停利鈕留著讓使用者關掉', async () => {
        const r = await mount(wrt, { orderOpts: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', triggerLayout: 'columns', protect: { on: true, stopTicks: 10, takeTicks: 20, trail: null } }, onOrderOptsChange: vi.fn() });
        expect(headers(r)).toHaveLength(0);
        expect(r.root.findAll(n => n.props['data-testid'] === 'flash-protect')).toHaveLength(1);
    });

    it('股票：觸買／觸賣欄、觸價設定、停損停利照常', async () => {
        const r = await mount(stk);
        expect(headers(r)).toHaveLength(2);
        expect(r.root.findAll(n => n.props['data-trigger'] === 'buy' && n.type === 'div').length).toBeGreaterThan(0);
        expect(r.root.findAll(n => n.props['data-testid'] === 'flash-protect')).toHaveLength(1);
        await openMenu(r);
        expect(group(r, '觸價後')).toHaveLength(1);
        expect(group(r, '觸價點法')).toHaveLength(1);
        expect(r.root.findAll(n => n.props.role === 'menuitem' && text(n).includes('自動停損停利'))).toHaveLength(1);
        expect(r.root.findAll(n => n.props['data-testid'] === 'flash-warrant-trigger-note')).toHaveLength(0);
    });
});
