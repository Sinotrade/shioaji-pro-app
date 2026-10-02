// #204 閃電下單設定：零股切換移進一顆設定按鈕，彈出面板只列閃電下單真的會用到
// 的設定（單位、數量），底部一句話說明送出內容；Esc 只關面板，不觸發面板熱鍵
import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn(), store: new Map<string, string>() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'A1234', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '100', volume: 1 } }, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

const stk = { code: '2330', name: '台積電', security_type: 'STK', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', reference: 100 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
let target: EventTarget;
const gear = () => view.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0]!;
const pop = () => view.root.findAll(n => n.props.role === 'dialog')[0];
const btnIn = (root: ReactTestInstance, label: string) => root.findAll(n => n.type === 'button' && text(n) === label)[0]!;
const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const summary = () => text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!);
const qty = () => view.root.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('數量'))[0]!;
const mount = async (contract: ContractInfo) => { await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions: [] })); }); };
const esc = async () => { await act(async () => { target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); }); };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    target = new EventTarget();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.store.get(k) ?? null, setItem: (k: string, v: string) => { mocks.store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('the top row keeps account, −/qty/+ and the unit label; 零股 moved into the settings popover', async () => {
    await mount(stk);
    expect(view.root.findAll(n => n.type === 'button' && text(n) === '零股')).toHaveLength(0);
    expect(text(view.root)).toContain('張');
    expect(gear()).toBeDefined();
    expect(String(gear().props.title)).toContain('點買量／賣量以 ROD 限價送出 1 張');
    await act(async () => { gear().props.onClick(); });
    const t = text(pop()!);
    expect(t).toContain('整股（張）');
    expect(t).toContain('盤中零股（股）');
    // flash only sends ROD limits / IOC market with Auto 開平倉: no such rows
    expect(t).not.toContain('IOC FOK');
    expect(t).not.toContain('新倉');
    expect(pop()!.findAll(n => n.type === 'select')).toHaveLength(0); // the account picker stays in the top row
    expect(summary()).toBe('點買量／賣量以 ROD 限價送出 1 張，帳號 跟隨 A1234；市價買／賣以市價 IOC 送出。');
    await act(async () => { btnIn(pop()!, '5').props.onClick(); });
    expect(qty().props.value).toBe(5);
});

it('odd lot from the popover: unit 股, presets in shares, summary, disarms, and orders go out as IntradayOdd', async () => {
    await mount(stk);
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    await act(async () => { gear().props.onClick(); });
    await act(async () => { btnIn(pop()!, '盤中零股（股）').props.onClick(); });
    // switching unit locks the ladder again
    expect(text(view.root)).toContain('啟用閃電下單');
    await act(async () => { btnIn(pop()!, '500').props.onClick(); });
    expect(summary()).toBe('點買量／賣量以 ROD 限價送出 500 股盤中零股，帳號 跟隨 A1234；零股沒有市價單，市價買／賣停用。');
    await act(async () => { btnIn(pop()!, '完成').props.onClick(); });
    expect(pop()).toBeUndefined();
    expect(qty().props['aria-label']).toBe('數量（股）');
    expect(qty().props.value).toBe(500);
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    const cell = view.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!;
    await act(async () => { cell.props.onClick(); });
    expect(mocks.place.mock.calls[0]![3]).toBe(500);
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderLot: 'IntradayOdd' });
});

it('Esc closes only the popover; with it closed, Esc disarms as before', async () => {
    await mount(stk);
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    expect(text(view.root)).toContain('點價即下單');
    await act(async () => { gear().props.onClick(); });
    expect(pop()).toBeDefined();
    await esc();
    expect(pop()).toBeUndefined();
    expect(text(view.root)).toContain('點價即下單'); // the flash hotkey did not fire
    await esc();
    expect(text(view.root)).toContain('啟用閃電下單');
});

it('設為預設 seeds new panels of the same market; futures are fixed at 口', async () => {
    await mount(stk);
    await act(async () => { gear().props.onClick(); });
    await act(async () => { btnIn(pop()!, '盤中零股（股）').props.onClick(); });
    await act(async () => { btnIn(pop()!, '100').props.onClick(); });
    await act(async () => { btnIn(pop()!, '設為預設').props.onClick(); });
    await act(async () => view.unmount());
    await act(async () => { view = create(createElement(StrictMode, null, createElement(FlashOrder, { contract: stk, trades: [], positions: [] }))); });
    expect(qty().props['aria-label']).toBe('數量（股）');
    expect(qty().props.value).toBe(100);
    await act(async () => view.unmount());
    await mount(fut);
    expect(qty().props.value).toBe(1);
    await act(async () => { gear().props.onClick(); });
    expect(text(pop()!)).not.toContain('盤中零股');
    expect(summary()).toBe('點買量／賣量以 ROD 限價送出 1 口，帳號 跟隨 F5678；市價買／賣以市價 IOC 送出。');
});

it('odd 500 股 → futures → stock: the quantity never crosses units or instrument classes', async () => {
    await mount(stk);
    await act(async () => { gear().props.onClick(); });
    await act(async () => { btnIn(pop()!, '盤中零股（股）').props.onClick(); });
    await act(async () => { btnIn(pop()!, '500').props.onClick(); });
    await act(async () => { btnIn(pop()!, '完成').props.onClick(); });
    expect(qty().props.value).toBe(500);
    await act(async () => { view.update(createElement(FlashOrder, { contract: fut, trades: [], positions: [] })); });
    expect(qty().props.value).toBe(1); // 1 口, never 500 口
    expect(text(view.root)).toContain('口');
    await act(async () => { view.update(createElement(FlashOrder, { contract: stk, trades: [], positions: [] })); });
    expect(qty().props.value).toBe(1); // remembered 1 股, never 500 張
    expect(qty().props['aria-label']).toBe('數量（股）');
    // whole lots do not carry into futures either
    await act(async () => { qty().props.onChange({ target: { value: '5' } }); });
    await act(async () => { view.update(createElement(FlashOrder, { contract: fut, trades: [], positions: [] })); });
    expect(qty().props.value).toBe(1);
    // …but stay within the same unit and class
    await act(async () => { qty().props.onChange({ target: { value: '3' } }); });
    await act(async () => { view.update(createElement(FlashOrder, { contract: { ...fut, code: 'MXFR1' } as ContractInfo, trades: [], positions: [] })); });
    expect(qty().props.value).toBe(3);
});

it('another panel saving 設為預設 does not change an existing panel, even on its next symbol change', async () => {
    await mount(stk);
    const other = create(createElement(FlashOrder, { contract: stk, trades: [], positions: [] }));
    await act(async () => { gear().props.onClick(); });
    await act(async () => { btnIn(pop()!, '盤中零股（股）').props.onClick(); });
    await act(async () => { btnIn(pop()!, '500').props.onClick(); });
    await act(async () => { btnIn(pop()!, '設為預設').props.onClick(); });
    const otherQty = () => other.root.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('數量'))[0]!;
    expect(otherQty().props.value).toBe(1);
    await act(async () => { other.update(createElement(FlashOrder, { contract: { ...stk, code: '2317' } as ContractInfo, trades: [], positions: [] })); });
    expect(otherQty().props.value).toBe(1);
    expect(otherQty().props['aria-label']).toBe('數量');
    await act(async () => other.unmount());
});

it('a futures panel that later switches to a stock keeps the stock default it had when it was created', async () => {
    // futures panel created first, while the stock default is still 1 張
    await mount(fut);
    let writer!: ReactTestRenderer;
    await act(async () => { writer = create(createElement(FlashOrder, { contract: stk, trades: [], positions: [] })); });
    const wGear = () => writer.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0]!;
    const wPop = () => writer.root.findAll(n => n.props.role === 'dialog')[0]!;
    await act(async () => { wGear().props.onClick(); });
    await act(async () => { btnIn(wPop(), '盤中零股（股）').props.onClick(); });
    await act(async () => { btnIn(wPop(), '500').props.onClick(); });
    await act(async () => { btnIn(wPop(), '設為預設').props.onClick(); });
    // An unseen stock still uses this panel's original default snapshot.
    await act(async () => { view.update(createElement(FlashOrder, { contract: { ...stk, code: '2317' }, trades: [], positions: [] })); });
    expect(qty().props.value).toBe(1);
    expect(qty().props['aria-label']).toBe('數量');
    await act(async () => writer.unmount());
});

it('remembers the symbol unit across navigation and reload, while unit changes reset quantity to 1', async () => {
    const render = async (c = stk) => { await act(async () => { view.update(createElement(FlashOrder, { contract: c, trades: [], positions: [] })); }); };
    await mount(stk);
    await act(async () => { gear().props.onClick(); });
    await act(async () => { btnIn(pop()!, '盤中零股（股）').props.onClick(); });
    await act(async () => { btnIn(pop()!, '500').props.onClick(); });
    await act(async () => { btnIn(pop()!, '完成').props.onClick(); });
    await render({ ...stk, reference: 101 });
    expect(qty().props.value).toBe(500);
    await render({ ...stk, code: '2317' });
    expect(qty().props.value).toBe(1);
    expect(qty().props['aria-label']).toBe('數量');
    await act(async () => { qty().props.onChange({ target: { value: '7' } }); });
    await render();
    expect(qty().props.value).toBe(1);
    expect(qty().props['aria-label']).toBe('數量（股）');
    await act(async () => view.unmount());
    await mount(stk);
    expect(qty().props.value).toBe(1);
    expect(qty().props['aria-label']).toBe('數量（股）');
    await render({ ...fut, code: stk.code });
    expect(qty().props.value).toBe(1);
    expect(text(view.root)).toContain('口');
    await act(async () => { gear().props.onClick(); });
    expect(text(pop()!)).not.toContain('盤中零股');
    await render();
    await act(async () => { btnIn(pop()!, '500').props.onClick(); });
    await act(async () => { btnIn(pop()!, '整股（張）').props.onClick(); });
    expect(qty().props.value).toBe(1);
    await render({ ...stk, code: '2317' });
    await render();
    expect(qty().props['aria-label']).toBe('數量');
});
