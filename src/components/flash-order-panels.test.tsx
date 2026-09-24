// issue #139 — two flash panels on the same contract, each with its own account
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
import type { FlashAccountKeys } from '../lib/flash-account';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), place: vi.fn(), stockExit: vi.fn(), notify: vi.fn(), selected: 'A', privacy: false }));
const accounts: Account[] = ['A', 'B'].map(account_id => ({ account_type: 'F', broker_id: 'BR', account_id: `12345${account_id}`, signed: true, person_id: '', username: '' }));
const [accA, accB] = accounts as [Account, Account];
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts, selectedStock: undefined, selectedFutures: accounts.find(a => a.account_id.endsWith(mocks.selected)) }) }));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMode: () => mocks.privacy, usePrivacyMoney: () => mocks.privacy }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => mocks.cancel(id))) }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: mocks.stockExit }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

const contract = { code: 'TMF', security_type: 'FUT', reference: 100 } as ContractInfo;
// same contract, one working order + position per account
const trades = accounts.map(account => ({ account, contract, order: { id: account.account_id, account, price: 100, action: 'Buy', quantity: 1 }, status: { status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, deals: [] } })) as unknown as Trade[];
const positions = accounts.map((account, i) => ({ account, id: i, code: 'TMF', direction: 'Buy' as const, quantity: i === 0 ? 3 : 5, price: 100, last_price: 100, pnl: 0 }));
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const button = (panel: ReactTestInstance, label: string) => panel.findAllByType('button').find(b => text(b).includes(label))!;
const select = (panel: ReactTestInstance) => panel.findByType('select');

let view!: ReactTestRenderer;
let keys: [FlashAccountKeys, FlashAccountKeys];
const onChange = [vi.fn(), vi.fn()];
const render = () => createElement('div', null, ...keys.map((k, i) => createElement('section', { key: i, 'data-panel': i },
    createElement(FlashOrder, { contract, trades, positions, accountKeys: k, onAccountKeysChange: onChange[i] }))));
const panels = () => view.root.findAll(n => n.type === 'section') as [ReactTestInstance, ReactTestInstance];

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    mocks.selected = 'A';
    mocks.privacy = false;
    mocks.cancel.mockResolvedValue({ status: { status: 'Cancelled' } });
    mocks.place.mockResolvedValue(trades[0]);
    keys = [{ F: 'F:BR:12345A' }, { F: 'F:BR:12345B' }];
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('scopes positions, working orders, cancels and sends to each panel\'s own account', async () => {
    await act(async () => { view = create(render()); });
    const [p1, p2] = panels();
    expect(text(p1)).toContain('多 3');
    expect(text(p2)).toContain('多 5');
    expect(text(button(p1, '全刪'))).toBe('全刪 1');
    // per-price cancel on panel 2 touches only account B's order
    await act(async () => { await p2.findAllByType('button').find(b => b.props.title === '刪除 100.00 買單 1')!.props.onClick(); });
    expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual(['12345B']);
    await act(async () => { await button(p1, '全刪').props.onClick(); });
    expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual(['12345B', '12345A']);
    // orders go out with the panel's own account even though the app-wide
    // selection is A — panel 2 is no longer refused for "not the global account"
    await act(async () => { button(p2, '啟用閃電下單').props.onClick(); });
    await act(async () => { await button(p2, '市價買').props.onClick(); });
    await act(async () => { button(p1, '啟用閃電下單').props.onClick(); });
    await act(async () => { await button(p1, '市價賣').props.onClick(); });
    expect(mocks.place.mock.calls.map(c => [c[1], c[4].account])).toEqual([['Buy', accB], ['Sell', accA]]);
});

it('switching one panel changes only that panel, never the other or the app-wide selection', async () => {
    await act(async () => { view = create(render()); });
    await act(async () => { select(panels()[1]).props.onChange({ target: { value: 'F:BR:12345A' } }); });
    expect(onChange[1]).toHaveBeenCalledWith({ F: 'F:BR:12345A' });
    expect(onChange[0]).not.toHaveBeenCalled();
    expect(mocks.selected).toBe('A');
    // back to following the main selection drops only this market's key
    await act(async () => { select(panels()[0]).props.onChange({ target: { value: '__follow__' } }); });
    expect(onChange[0]).toHaveBeenCalledWith({});
    // an unknown key is ignored rather than stored
    await act(async () => { select(panels()[0]).props.onChange({ target: { value: 'F:BR:nope' } }); });
    expect(onChange[0]).toHaveBeenCalledTimes(1);
});

it('a panel without a saved account follows the app-wide selection and shows it masked', async () => {
    keys = [{}, { F: 'F:BR:12345B' }];
    mocks.privacy = true;
    await act(async () => { view = create(render()); });
    const [p1, p2] = panels();
    expect(select(p1).props.value).toBe('__follow__');
    expect(text(select(p1))).toContain('跟隨主畫面 BR-••••5A');
    expect(text(select(p1))).not.toContain('12345A');
    expect(text(p1)).toContain('多 3');
    mocks.selected = 'B';
    await act(async () => { view.update(render()); });
    expect(text(panels()[0])).toContain('多 5');
    expect(select(p2).props.value).toBe('F:BR:12345B');
});

it('a saved account that disappears is shown unavailable, not replaced by the global one', async () => {
    keys = [{ F: 'F:BR:gone' }, { F: 'F:BR:12345B' }];
    await act(async () => { view = create(render()); });
    const p1 = panels()[0];
    expect(text(select(p1))).toContain('帳戶不可用');
    expect(text(p1)).not.toContain('多 3');
    expect(button(p1, '啟用閃電下單').props.disabled).toBe(true);
});

it('the order guard fails once the panel switches account while the confirmation is open', async () => {
    let guard!: () => boolean;
    let finish!: () => void;
    mocks.place.mockImplementationOnce((_c, _a, _p, _q, opts: { isAccountCurrent: () => boolean }) => {
        guard = opts.isAccountCurrent;
        return new Promise(resolve => { finish = () => resolve(trades[1]); });
    });
    await act(async () => { view = create(render()); });
    await act(async () => { button(panels()[1], '啟用閃電下單').props.onClick(); });
    let pending!: Promise<void>;
    await act(async () => { pending = button(panels()[1], '市價買').props.onClick(); });
    expect(guard()).toBe(true);
    // the other panel switching does not affect this order
    keys = [{ F: 'F:BR:12345B' }, keys[1]];
    await act(async () => { view.update(render()); });
    expect(guard()).toBe(true);
    keys = [keys[0], { F: 'F:BR:12345A' }];
    await act(async () => { view.update(render()); });
    expect(guard()).toBe(false);
    await act(async () => { finish(); await pending; });
});

it('a following (docked) panel\'s pending order fails its guard when the main selection changes', async () => {
    let guard!: () => boolean;
    let finish!: () => void;
    mocks.place.mockImplementationOnce((_c, _a, _p, _q, opts: { account: Account; isAccountCurrent: () => boolean }) => {
        guard = opts.isAccountCurrent;
        expect(opts.account).toBe(accA);
        return new Promise(resolve => { finish = () => resolve(trades[0]); });
    });
    keys = [{}, { F: 'F:BR:12345B' }];
    await act(async () => { view = create(render()); });
    await act(async () => { button(panels()[0], '啟用閃電下單').props.onClick(); });
    await act(async () => { button(panels()[0], '市價買').props.onClick(); });
    expect(guard()).toBe(true);
    // the app-wide selection moves in the same window
    mocks.selected = 'B';
    await act(async () => { view.update(render()); });
    expect(guard()).toBe(false);
    expect(text(panels()[0])).toContain('多 5');
    await act(async () => { finish(); });
});

it('a popout (followMain=false) uses only its pinned account and never follows the main selection', async () => {
    const onPop = vi.fn();
    const pop = (k: FlashAccountKeys) => createElement(FlashOrder, { contract, trades, positions, accountKeys: k, onAccountKeysChange: onPop, followMain: false });
    await act(async () => { view = create(pop({ F: 'F:BR:12345B' })); });
    const sel = () => view.root.findByType('select');
    expect(sel().props.value).toBe('F:BR:12345B');
    expect(text(sel())).not.toContain('跟隨主畫面');
    expect(text(view.root)).toContain('多 5');
    mocks.selected = 'B';
    await act(async () => { view.update(pop({ F: 'F:BR:12345B' })); });
    mocks.selected = 'A';
    await act(async () => { view.update(pop({ F: 'F:BR:12345B' })); });
    expect(text(view.root)).toContain('多 5');
    // the follow value is refused in a popout
    await act(async () => { sel().props.onChange({ target: { value: '__follow__' } }); });
    expect(onPop).not.toHaveBeenCalled();
    await act(async () => { sel().props.onChange({ target: { value: 'F:BR:12345A' } }); });
    expect(onPop).toHaveBeenCalledWith({ F: 'F:BR:12345A' });
});

it('a popout with nothing pinned has no account until the user picks one', async () => {
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades, positions, accountKeys: {}, onAccountKeysChange: vi.fn(), followMain: false })); });
    const sel = view.root.findByType('select');
    expect(sel.props.value).toBe('');
    expect(text(sel)).toContain('請選擇帳戶');
    expect(text(view.root)).not.toContain('多 3');
    expect(view.root.findAllByType('button').find(b => text(b).includes('啟用閃電下單'))!.props.disabled).toBe(true);
});
