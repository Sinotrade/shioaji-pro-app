import '../test/mock-order-reconciliation';
import { operationNotice } from '../test/operation-notice';
// #216 閃電下單的觸價單與自動停損停利：觸價模式在點的價位掛觸價單（方向由
// 成交價決定、反向在持倉內＝出場）、鎖定一起關閉；梯形上的觸價單點一下刪除、
// 拖曳改價（不能拖過成交價）；自動停損停利讓每筆進場走括號單、減倉照送、
// 反手與不支援的條件不送。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { LadderMark } from '../lib/flash-trigger';
import type { FlashOrderOpts } from '../lib/flash-account';

const m = vi.hoisted(() => ({ appLocked: false, readClose: vi.fn(), watch: vi.fn(), readHeld: vi.fn(), restoreProt: vi.fn(), stop: vi.fn(), cancel: vi.fn(), place: vi.fn(), notify: vi.fn(), add: vi.fn(), modify: vi.fn(), remove: vi.fn(), bracket: vi.fn(),
    marks: new Map<string, { buy: LadderMark[]; sell: LadderMark[] }>(), background: false, protectedQty: 0 }));
const accounts: Account[] = [{ account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' }];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: undefined, selectedFutures: accounts[0] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '100', volume: 1 } }, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: m.marks, protectedQty: m.protectedQty, background: m.background }) }));
vi.mock('../lib/flash-conditional', () => ({ flashAddTrigger: m.add, flashModifyTrigger: m.modify, flashRemoveTrigger: m.remove, flashPlaceBracket: m.bracket, flashStopProtections: m.stop,
    flashReadHeld: m.readHeld, flashRestoreProtection: m.restoreProt, flashReadClose: m.readClose, flashLastPrice: async () => 100, flashEnvIs: async () => true }));
vi.mock('../lib/flash-flatten-restore', async orig => ({ ...(await orig<typeof import('../lib/flash-flatten-restore')>()), restoreAfterUnfilledClose: m.watch }));
vi.mock('../lib/shioaji', () => ({ cancelOrders: m.cancel }));
vi.mock('../lib/app-lock', async orig => ({ ...(await orig<typeof import('../lib/app-lock')>()), isAppAccessBlocked: () => m.appLocked }));
vi.mock('../lib/trade', () => ({ notify: m.notify, placeQuickOrder: m.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', reference: 100, limit_up: 0, limit_down: 0 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b).includes(label));
const byTestId = (r: ReactTestRenderer, id: string) => r.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string');
// rows top to bottom: 110 … 90 (21 rows around the last price 100)
const cell = (r: ReactTestRenderer, side: 'buy' | 'sell', price: number) =>
    r.root.findAll(n => n.type === 'div' && n.props['data-side'] === side)[110 - price]!;
const listeners: Record<string, ((e: unknown) => void)[]> = {};
const fire = (type: string, e: unknown) => { for (const fn of [...(listeners[type] ?? [])]) fn(e); };
const roots: ReactTestRenderer[] = [];

const position = (net: number) => [{ account: accounts[0], id: 1, code: 'TXFR1', direction: net > 0 ? 'Buy' as const : 'Sell' as const, quantity: Math.abs(net), price: 100, last_price: 100, pnl: 0 }];
const mount = async (opts: { order?: FlashOrderOpts; net?: number } = {}) => {
    let r!: ReactTestRenderer;
    const el = createElement(FlashOrder, { contract: fut, trades: [], positions: opts.net ? position(opts.net) : [], orderOpts: opts.order, onOrderOptsChange: vi.fn() });
    await act(async () => {
        r = create(el, { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 21 * 22, addEventListener() {}, removeEventListener() {} }) });
    });
    roots.push(r);
    return r;
};
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單')!.props.onClick(); }); };
// the outer 觸買／觸賣 columns, top to bottom like the cells
const trig = async (r: ReactTestRenderer, side: 'buy' | 'sell', price: number) => {
    await act(async () => { await r.root.findAll(n => n.type === 'div' && n.props['data-trigger'] === side)[110 - price]!.props.onClick(); });
};
const click = async (r: ReactTestRenderer, side: 'buy' | 'sell', price: number) => { await act(async () => { await cell(r, side, price).props.onClick({ altKey: false }); }); };
const PROTECT: FlashOrderOpts = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', protect: { on: true, stopTicks: 8, takeTicks: 16, trail: null } };

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.stubGlobal('window', {
        addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
        removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = (listeners[type] ?? []).filter(f => f !== fn); },
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    m.marks = new Map();
    m.background = false;
    m.protectedQty = 0;
    m.add.mockResolvedValue({ id: 'tg-1' });
    m.modify.mockResolvedValue(undefined);
    m.remove.mockResolvedValue(undefined);
    m.bracket.mockResolvedValue('placed');
    m.stop.mockResolvedValue({ stopped: 0, blocked: [], failed: [], restore: [] });
    m.cancel.mockResolvedValue([]);
    m.place.mockResolvedValue({ order: { id: 'o1' }, status: { status: 'Submitted' } });
});
afterEach(async () => { for (const r of roots.splice(0)) await act(async () => r.unmount()); vi.unstubAllGlobals(); });

it('both at once: the 觸買 column places a buy stop entry, the 買量 cell next to it a limit order', async () => {
    const r = await mount();
    await arm(r);
    expect(text(r.root)).toContain('觸買');
    expect(text(r.root)).toContain('觸賣');
    // hover preview / title says exactly what goes out
    const col = r.root.findAll(n => n.type === 'div' && n.props['data-trigger'] === 'buy')[5]!;
    expect(col.props['data-preview']).toBe('觸≥');
    expect(col.props.title).toBe('觸價買：成交價 ≥ 105.00 時市價買進（不是限價）');
    await trig(r, 'buy', 105);
    expect(m.place).not.toHaveBeenCalled();
    const [t, contract, account] = m.add.mock.calls[0]!;
    expect(t).toMatchObject({ code: 'TXFR1', condition: 'above', price: 105, action: 'Buy', quantity: 1, kind: 'stop', role: 'entry',
        validity: { type: 'today' } });
    expect(t.octype).toBeUndefined();
    expect(t.send).toBeUndefined();
    expect(contract).toBe(fut);
    expect(account).toBe(accounts[0]);
    // no mode: the limit cell still sends a limit order
    await click(r, 'buy', 99);
    expect(m.place.mock.calls[0]!.slice(1, 3)).toEqual(['Buy', 99]);
    expect(m.add).toHaveBeenCalledTimes(1);
});

it('opposite and within the position: a protective stop that closes (Cover, no entry role); at the traded price nothing', async () => {
    const r = await mount({ net: 3 });
    await arm(r);
    await trig(r, 'sell', 95);
    expect(m.add.mock.calls[0]![0]).toMatchObject({ condition: 'below', price: 95, action: 'Sell', kind: 'stop', octype: 'Cover' });
    expect(m.add.mock.calls[0]![0].role).toBeUndefined();
    await trig(r, 'sell', 100);
    expect(m.add).toHaveBeenCalledTimes(1);
    expect(operationNotice(m.notify, '⚡ 觸價單未建立')).toMatchObject({ title: '⚡ 觸價單未建立', body: expect.stringContaining('立刻觸發') });
});

it('a limit send style goes out toward a fill (sell −N ticks)', async () => {
    const r = await mount({ order: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', triggerSend: { type: 'LMT', ticks: 2 } } });
    await arm(r);
    await trig(r, 'sell', 97);
    expect(m.add.mock.calls[0]![0]).toMatchObject({ condition: 'below', send: { type: 'LMT', ticks: -2 }, role: 'entry' });
});

it('nothing is placed while locked; the Alt＋點 layout keeps 5 columns and needs Alt for a trigger', async () => {
    const r = await mount();
    await trig(r, 'buy', 105);
    await click(r, 'buy', 99);
    expect(m.add).not.toHaveBeenCalled();
    expect(m.place).not.toHaveBeenCalled();

    const alt = await mount({ order: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', triggerLayout: 'modifier' } });
    expect(alt.root.findAll(n => n.type === 'div' && n.props['data-trigger'])).toHaveLength(0);
    expect(text(alt.root)).not.toContain('觸買');
    await arm(alt);
    expect(cell(alt, 'buy', 105).props.title).toContain('Alt＋點＝觸價買（成交價 ≥ 105.00）');
    await act(async () => { await cell(alt, 'buy', 105).props.onClick({ altKey: true }); });
    expect(m.add.mock.calls[0]![0]).toMatchObject({ condition: 'above', price: 105, action: 'Buy' });
    expect(m.place).not.toHaveBeenCalled();
    await act(async () => { await cell(alt, 'buy', 99).props.onClick({ altKey: false }); });
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(m.add).toHaveBeenCalledTimes(1);
});

it('a pending trigger on the ladder: click deletes it, drag moves it, never across the traded price', async () => {
    const mark: LadderMark = { id: 'tg-9', side: 'buy', price: 105, quantity: 2, kind: 'trigger', protects: false, paused: false, pending: false,
        editable: true, background: false, condition: 'above', title: '觸價單' };
    m.marks = new Map([['105.00', { buy: [mark], sell: [] }]]);
    const r = await mount();
    const chip = () => byTestId(r, 'flash-trigger-mark')[0]!;
    expect(text(chip())).toBe('2');
    const ev = (clientY: number) => ({ button: 0, clientY, preventDefault() {}, stopPropagation() {} });
    // a click (no movement) deletes it: the browser sends pointerdown, pointerup, then click
    const stop = vi.fn();
    await act(async () => { chip().props.onPointerDown(ev(5 * 22 + 5)); });
    await act(async () => { fire('pointerup', ev(5 * 22 + 5)); });
    expect(m.remove).not.toHaveBeenCalled();
    await act(async () => { chip().props.onClick({ stopPropagation: stop }); });
    expect(m.remove).toHaveBeenCalledWith('tg-9');
    // the click never reaches the 觸價 column's place handler
    expect(stop).toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
    // drag needs the ladder armed
    await arm(r);
    // App Lock locks mid-drag: releasing moves nothing (the very same move goes out below once unlocked)
    await act(async () => { chip().props.onPointerDown(ev(5 * 22 + 5)); });
    await act(async () => { fire('pointermove', ev(2 * 22 + 5)); });
    m.appLocked = true;
    await act(async () => { fire('pointerup', ev(2 * 22 + 5)); });
    m.appLocked = false;
    expect(m.modify).not.toHaveBeenCalled();
    await act(async () => { chip().props.onPointerDown(ev(5 * 22 + 5)); });
    await act(async () => { fire('pointermove', ev(2 * 22 + 5)); });
    await act(async () => { fire('pointerup', ev(2 * 22 + 5)); }); // row 2 = 108
    expect(m.modify).toHaveBeenCalledWith('tg-9', { price: 108 });
    // the click that ends the drag is not a delete
    await act(async () => { chip().props.onClick({ stopPropagation() {} }); });
    expect(m.remove).toHaveBeenCalledTimes(1);
    // across the traded price (100): refused, nothing changed
    await act(async () => { chip().props.onPointerDown(ev(5 * 22 + 5)); });
    await act(async () => { fire('pointermove', ev(12 * 22 + 5)); });
    await act(async () => { fire('pointerup', ev(12 * 22 + 5)); }); // 98
    expect(m.modify).toHaveBeenCalledTimes(1);
    expect(operationNotice(m.notify, '⚡ 觸價單未改價')).toMatchObject({ body: expect.stringContaining('不能拖過') });
    // Esc ends a drag without moving it
    await act(async () => { chip().props.onPointerDown(ev(5 * 22 + 5)); });
    await act(async () => { fire('pointermove', ev(1 * 22 + 5)); });
    await act(async () => { fire('keydown', { key: 'Escape', preventDefault() {} }); });
    await act(async () => { fire('pointerup', ev(1 * 22 + 5)); });
    expect(m.modify).toHaveBeenCalledTimes(1);
    // …and the click that follows the cancelled drag is not a delete either
    await act(async () => { chip().props.onClick({ stopPropagation() {} }); });
    expect(m.remove).toHaveBeenCalledTimes(1);
    // a later, separate click deletes
    await act(async () => { chip().props.onPointerDown(ev(5 * 22 + 5)); });
    await act(async () => { fire('pointerup', ev(5 * 22 + 5)); });
    await act(async () => { chip().props.onClick({ stopPropagation() {} }); });
    expect(m.remove).toHaveBeenCalledTimes(2);
});

it('protection marks show on the exit side and are not editable from the ladder', async () => {
    const stop: LadderMark = { id: 'bkt:1:stop', side: 'sell', price: 92, quantity: 3, kind: 'stop', protects: false, paused: false, pending: false,
        editable: false, background: true, title: '停損 賣 3 口 @ 92' };
    m.marks = new Map([['92.00', { buy: [], sell: [stop] }]]);
    m.protectedQty = 3;
    m.background = true;
    const r = await mount({ order: PROTECT, net: 3 });
    expect(text(byTestId(r, 'flash-stop-mark')[0]!)).toBe('損3');
    expect(text(byTestId(r, 'flash-protect')[0]!)).toBe('停損停利・保護 3');
    expect(byTestId(r, 'flash-protect')[0]!.props.title).toContain('保護中 3 口');
    expect(byTestId(r, 'flash-protect')[0]!.props.title).toContain('由背景執行');
});

it('自動停損停利: a limit click goes through the panel bracket with the panel conditions and a confirmation note', async () => {
    m.background = true;
    const r = await mount({ order: PROTECT });
    expect(byTestId(r, 'flash-protect')[0]!.props.title).toContain('損 8・利 16 檔');
    await arm(r);
    await click(r, 'buy', 99);
    expect(m.place).not.toHaveBeenCalled();
    const req = m.bracket.mock.calls[0]![0];
    expect(req).toMatchObject({ action: 'Buy', entry: { type: 'LMT', price: 99 }, refPrice: 99,
        plan: { tiers: [{ quantity: 1, takeTicks: 16 }], stopTicks: 8 },
        order: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', confirmNote: '附自動停損停利（損 8・利 16 檔・背景執行）' } });
    expect(operationNotice(m.notify, '⚡ 買進已送出・附停損停利')).toMatchObject({ kind: 'ok', title: expect.stringContaining('附停損停利') });
    // the market button: a market entry priced from the traded price
    await act(async () => { await button(r, '市價賣')!.props.onClick(); });
    expect(m.bracket.mock.calls[1]![0]).toMatchObject({ action: 'Sell', entry: { type: 'MKT' }, refPrice: 100 });
});

it('自動停損停利: reducing is sent plainly, reversing is not sent, an unsupported 倉別 is not sent', async () => {
    const r = await mount({ order: PROTECT, net: 2 });
    await arm(r);
    await click(r, 'sell', 101);
    expect(m.bracket).not.toHaveBeenCalled();
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(operationNotice(m.notify, '⚡ 賣出已送出')).toMatchObject({ body: expect.stringContaining('減倉，未附加停損停利') });
    // qty 3 against a long 2: a reversal
    await act(async () => { r.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '數量')[0]!.props.onChange({ target: { value: '3' } }); });
    if (button(r, '啟用閃電下單')) await arm(r);
    await click(r, 'sell', 101);
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(m.bracket).not.toHaveBeenCalled();
    expect(operationNotice(m.notify, '⚡ 閃電下單失敗')).toMatchObject({ body: expect.stringContaining('反手') });

    const cover = await mount({ order: { ...PROTECT, octype: 'Cover' } });
    expect(byTestId(cover, 'flash-protect')[0]!.props.title).toContain('新倉');
    await arm(cover);
    await click(cover, 'buy', 99);
    expect(m.bracket).not.toHaveBeenCalled();
    expect(m.place).toHaveBeenCalledTimes(1);
});

it('自動停損停利: a 新倉 order is protected even against a position; a reduce sent only if still a reduce after confirmation', async () => {
    const r = await mount({ order: { ...PROTECT, octype: 'New' }, net: 2 });
    await arm(r);
    await click(r, 'sell', 101);
    expect(m.place).not.toHaveBeenCalled();
    expect(m.bracket.mock.calls[0]![0]).toMatchObject({ action: 'Sell', order: { octype: 'New' } });

    // 自動 + reduce: the position goes away while the confirmation is open → refused
    const view = await mount({ order: PROTECT, net: 1 });
    m.place.mockImplementationOnce(async (...a: unknown[]) => {
        await act(async () => {
            view.update(createElement(FlashOrder, { contract: fut, trades: [], positions: [], orderOpts: PROTECT, onOrderOptsChange: vi.fn() }));
        });
        (a[4] as { beforeSend: () => void }).beforeSend();
        return { order: { id: 'x' }, status: { status: 'Submitted' } };
    });
    await arm(view);
    await click(view, 'sell', 101);
    expect(operationNotice(m.notify, '⚡ 閃電下單失敗')).toMatchObject({ kind: 'err', body: expect.stringContaining('持倉已變動') });
});

it('a failed deletion is never announced as deleted', async () => {
    const mark: LadderMark = { id: 'tg-9', side: 'buy', price: 105, quantity: 1, kind: 'trigger', protects: false, paused: false, pending: false,
        editable: true, background: false, condition: 'above', title: '觸價單' };
    m.marks = new Map([['105.00', { buy: [mark], sell: [] }]]);
    m.remove.mockRejectedValue(new Error('主視窗沒有回應'));
    const r = await mount();
    const ev = { button: 0, clientY: 115, preventDefault() {}, stopPropagation() {} };
    await act(async () => { byTestId(r, 'flash-trigger-mark')[0]!.props.onPointerDown(ev); });
    await act(async () => { fire('pointerup', ev); });
    await act(async () => { byTestId(r, 'flash-trigger-mark')[0]!.props.onClick({ stopPropagation() {} }); });
    expect(operationNotice(m.notify, '⚡ 觸價單刪除未確認')).toMatchObject({ kind: 'err', title: '⚡ 觸價單刪除未確認' });
});

it('自動停損停利 + 觸價欄: a trigger entry that brackets its fill', async () => {
    m.bracket.mockResolvedValue('trigger');
    m.background = true;
    const r = await mount({ order: PROTECT });
    await arm(r);
    expect(r.root.findAll(n => n.type === 'div' && n.props['data-trigger'] === 'buy')[6]!.props.title).toContain('附停損停利');
    await trig(r, 'buy', 104);
    expect(m.add).not.toHaveBeenCalled();
    expect(m.bracket.mock.calls[0]![0]).toMatchObject({ action: 'Buy', refPrice: 104,
        entry: { type: 'touch', price: 104, condition: 'above', send: { type: 'MKT' }, validity: { type: 'today' } } });
    expect(operationNotice(m.notify, '⚡ 觸價單已掛・附停損停利（背景執行）')).toMatchObject({ title: expect.stringContaining('背景執行') });
});

it('the protect settings: applying saves them on the panel and locks the ladder', async () => {
    const onChange = vi.fn();
    let r!: ReactTestRenderer;
    await act(async () => {
        r = create(createElement(FlashOrder, { contract: fut, trades: [], positions: [], orderOpts: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT' }, onOrderOptsChange: onChange }),
            { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 462, addEventListener() {}, removeEventListener() {} }) });
    });
    roots.push(r);
    await arm(r);
    await act(async () => { byTestId(r, 'flash-protect')[0]!.props.onClick(); });
    const dialog = r.root.findAll(n => n.props.role === 'dialog')[0]!;
    await act(async () => { dialog.findAll(n => n.props.role === 'switch')[0]!.props.onClick(); });
    const input = (label: string) => r.root.findAll(n => n.type === 'input' && n.props['aria-label'] === label)[0]!;
    await act(async () => { input('停損檔數').props.onChange({ target: { value: '6' } }); });
    await act(async () => { input('停利檔數').props.onChange({ target: { value: '' } }); });
    // no take and no trailing stop: refused
    expect(button(r, '套用')!.props.disabled).toBe(true);
    await act(async () => { input('停利檔數').props.onChange({ target: { value: '12' } }); });
    await act(async () => { button(r, '套用')!.props.onClick(); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ protect: { on: true, stopTicks: 6, takeTicks: 12, trail: null } }));
    expect(button(r, '啟用閃電下單')).toBeDefined();
});

it('平倉 ends this panel\'s 停損停利 first, then closes; an exit out or unknown blocks the close', async () => {
    const order: string[] = [];
    m.stop.mockImplementation(async (scope: unknown) => { order.push('stop'); expect(scope).toEqual({ account: { account_type: 'F', broker_id: 'BR', account_id: 'F5678' }, codes: ['TXFR1'], odd: false }); return { stopped: 2, blocked: [], failed: [],
        restore: [{ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 }] }; });
    m.place.mockImplementation(async () => { order.push('close'); return { order: { id: 'c' }, status: { status: 'Submitted' } }; });
    const r = await mount({ order: PROTECT, net: 2 });
    await arm(r);
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    expect(order).toEqual(['stop', 'close']);
    expect(m.place.mock.calls[0]![4]).toMatchObject({ ocType: 'Cover' });
    // quantities in the product's unit (口), not a count of protections
    expect(operationNotice(m.notify, '⚡ 平倉已送出')).toMatchObject({ body: expect.stringContaining('已先取消停損停利（2 口）') });
    // the unfilled-close watch: what was held, what was protected, put back as Cover OCO triggers
    const [before, snaps, code, unit, deps] = m.watch.mock.calls[0]!;
    expect([before, snaps, code, unit]).toEqual([2, [{ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 }], 'TXFR1', '口']);
    m.readHeld.mockResolvedValue(1);
    expect(await deps.readHeld()).toBe(1);
    expect(m.readHeld).toHaveBeenCalledWith(accounts[0], ['TXFR1'], false);
    m.restoreProt.mockResolvedValue(true);
    await deps.restore({ exitAction: 'Sell', stop: 95, take: 110, quantity: 1 });
    const [legs] = m.restoreProt.mock.calls[0]!;
    expect(legs).toEqual([
        expect.objectContaining({ action: 'Sell', condition: 'below', price: 95, kind: 'stop', octype: 'Cover', quantity: 1, ocoMode: 'trigger' }),
        expect.objectContaining({ action: 'Sell', condition: 'above', price: 110, kind: 'take', octype: 'Cover', quantity: 1, ocoMode: 'trigger' }),
    ]);
    expect(legs[0].role).toBeUndefined();
    expect(legs[0].group).toBe(legs[1].group);
    // it waits for the close order itself (by its id) to be final
    m.readClose.mockResolvedValue({ final: true, filled: 0 });
    expect(await deps.readClose()).toEqual({ final: true, filled: 0 });
    expect(m.readClose).toHaveBeenCalledWith(accounts[0], 'c');

    m.stop.mockResolvedValue({ stopped: 0, blocked: ['TXFR1 停損停利的出場單結果未知'], failed: [], restore: [] });
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(operationNotice(m.notify, '⚡ 平倉未送出')).toMatchObject({ kind: 'err', title: '⚡ 平倉未送出', body: expect.stringContaining('結果未知') });

    const beforeCancelFailure = m.notify.mock.calls.length;
    m.stop.mockResolvedValue({ stopped: 1, blocked: [], failed: ['主視窗沒有回應'], restore: [] });
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(operationNotice(m.notify, '⚡ 平倉未送出', beforeCancelFailure)).toMatchObject({ kind: 'err', body: expect.stringContaining('取消未確認') });
});

it('全刪 cancels the working orders and ends the 停損停利; enabled by protection alone', async () => {
    const trades = [{ account: accounts[0], contract: fut, order: { id: 'w1', account: accounts[0], price: 99, action: 'Buy', quantity: 1 },
        status: { status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, deals: [] } }];
    m.stop.mockResolvedValue({ stopped: 1, blocked: [], failed: [], restore: [] });
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(FlashOrder, { contract: fut, trades: trades as never, positions: [], orderOpts: PROTECT, onOrderOptsChange: vi.fn() }),
        { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 462, addEventListener() {}, removeEventListener() {} }) }); });
    roots.push(r);
    await act(async () => { await button(r, '全刪')!.props.onClick(); });
    expect(m.stop).toHaveBeenCalledTimes(1);
    expect(m.cancel.mock.calls[0]![0]).toEqual(['w1']);
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 全刪・停損停利', body: expect.stringContaining('已取消停損停利 1 張') }));
    // blocked protection: the orders are still cancelled, the protection is reported
    m.stop.mockResolvedValue({ stopped: 0, blocked: ['TXFR1 停損停利的出場單正在送出或等待成交'], failed: [], restore: [] });
    await act(async () => { await button(r, '全刪')!.props.onClick(); });
    expect(m.cancel).toHaveBeenCalledTimes(2);
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', body: expect.stringContaining('停損停利未取消') }));

    // no working orders: 全刪 is enabled while protection exists
    m.protectedQty = 2;
    const p = await mount({ order: PROTECT, net: 2 });
    expect(button(p, '全刪')!.props.disabled).toBe(false);
    m.protectedQty = 0;
    const q = await mount({ order: PROTECT, net: 2 });
    expect(button(q, '全刪')!.props.disabled).toBe(true);
});

it('the gear holds the settings: 觸價點法 is saved on the panel; the protect editor opens from it', async () => {
    const onChange = vi.fn();
    let r!: ReactTestRenderer;
    await act(async () => {
        r = create(createElement(FlashOrder, { contract: fut, trades: [], positions: [], orderOpts: PROTECT, onOrderOptsChange: onChange }),
            { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 462, addEventListener() {}, removeEventListener() {} }) });
    });
    roots.push(r);
    // the fast-trading top: no 觸價 mode button, no 跟隨／置中 buttons, a gear
    expect(byTestId(r, 'flash-trigger-mode')).toHaveLength(0);
    expect(byTestId(r, 'flash-settings')).toHaveLength(1);
    await act(async () => { byTestId(r, 'flash-settings')[0]!.props.onClick(); });
    const item = (label: string) => r.root.findAll(n => n.type === 'button' && text(n).startsWith(label))[0]!;
    await act(async () => { item('Alt＋點').props.onClick(); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ triggerLayout: 'modifier' }));
    await act(async () => { byTestId(r, 'flash-settings')[0]!.props.onClick(); });
    await act(async () => { item('自動停損停利').props.onClick(); });
    expect(r.root.findAll(n => n.props.role === 'dialog' && n.props['aria-label'] === '自動停損停利設定')).toHaveLength(1);
});

it('changing 觸價點法 locks the ladder (an Alt-click must not become a limit order)', async () => {
    const onChange = vi.fn();
    let r!: ReactTestRenderer;
    await act(async () => {
        r = create(createElement(FlashOrder, { contract: fut, trades: [], positions: [], orderOpts: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', triggerLayout: 'modifier' }, onOrderOptsChange: onChange }),
            { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 462, addEventListener() {}, removeEventListener() {} }) });
    });
    roots.push(r);
    await arm(r);
    await act(async () => { byTestId(r, 'flash-settings')[0]!.props.onClick(); });
    await act(async () => { r.root.findAll(n => n.type === 'button' && text(n).startsWith('觸價欄'))[0]!.props.onClick(); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ triggerLayout: 'columns' }));
    expect(button(r, '啟用閃電下單')).toBeDefined();
});

it('a crowded 觸價 cell keeps every mark with short labels', async () => {
    const base = { protects: false, paused: false, pending: false, background: false, title: 't' };
    m.marks = new Map([['103.00', { buy: [], sell: [
        { ...base, id: 'a', side: 'sell', price: 103, quantity: 1, kind: 'trigger', editable: true, condition: 'above' },
        { ...base, id: 'b', side: 'sell', price: 103, quantity: 2, kind: 'take', editable: false },
    ] as LadderMark[] }]]);
    const r = await mount();
    expect(text(byTestId(r, 'flash-trigger-mark')[0]!)).toBe('1');
    expect(text(byTestId(r, 'flash-take-mark')[0]!)).toBe('利');
});

it('the preview uses the same entry / exit classification as placing (QA 10/13)', async () => {
    // long 3 with protection on: the 觸賣 column is a 停損 exit (no protection), the 觸買 column an entry with it
    const r = await mount({ order: PROTECT, net: 3 });
    await arm(r);
    const col = (side: 'buy' | 'sell', price: number) => r.root.findAll(n => n.type === 'div' && n.props['data-trigger'] === side)[110 - price]!;
    expect(col('sell', 95).props.title).toBe('觸價賣：成交價 ≤ 95.00 時市價賣出平倉（出場單，不附停損停利）（不是限價）');
    expect(col('buy', 105).props.title).toBe('觸價買：成交價 ≥ 105.00 時市價買進（附停損停利）（不是限價）');
    await trig(r, 'sell', 95);
    expect(m.add.mock.calls[0]![0]).toMatchObject({ action: 'Sell', octype: 'Cover' });
    expect(m.bracket).not.toHaveBeenCalled();
});


it('a close refused right away (nothing went out) after the protection was ended: it is put back at once', async () => {
    m.stop.mockResolvedValue({ stopped: 1, blocked: [], failed: [], restore: [{ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 }], env: 'e' });
    m.place.mockRejectedValue(Object.assign(new Error('券商拒絕'), { mutationNotStarted: true }));
    const r = await mount({ order: PROTECT, net: 2 });
    await arm(r);
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    expect(m.watch).toHaveBeenCalledTimes(1);
    const deps = m.watch.mock.calls[0]![4];
    expect(await deps.readClose()).toEqual({ final: true, filled: 0 });
});

it('an unknown close outcome: the protection is not put back, and the panel says it is unprotected', async () => {
    m.stop.mockResolvedValue({ stopped: 1, blocked: [], failed: [], restore: [{ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 }], env: 'e' });
    m.place.mockRejectedValue(new Error('timeout'));
    const r = await mount({ order: PROTECT, net: 2 });
    await arm(r);
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    expect(m.watch).not.toHaveBeenCalled();
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 停損停利已取消（未受保護）' }));
});

it('each restored protection gets its own OCO group; an alias panel shares the product lock', async () => {
    m.stop.mockResolvedValue({ stopped: 2, blocked: [], failed: [], restore: [{ exitAction: 'Sell', stop: 95, take: 110, quantity: 1 }, { exitAction: 'Sell', stop: 95, take: 110, quantity: 1 }], env: 'e' });
    m.place.mockResolvedValue({ order: { id: 'c' }, status: { status: 'Submitted' } });
    const r = await mount({ order: PROTECT, net: 2 });
    await arm(r);
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    const deps = m.watch.mock.calls[0]![4];
    m.restoreProt.mockResolvedValue(true);
    await deps.restore({ exitAction: 'Sell', stop: 95, take: 110, quantity: 1 });
    await deps.restore({ exitAction: 'Sell', stop: 95, take: 110, quantity: 1 });
    const g1 = m.restoreProt.mock.calls[0]![0][0].group;
    const g2 = m.restoreProt.mock.calls[1]![0][0].group;
    expect(g1).not.toBe(g2);
});

it('some protections ended before another failed: no close, and the ended ones are said to be unprotected', async () => {
    m.stop.mockResolvedValue({ stopped: 1, blocked: [], failed: ['主視窗沒有回應'], restore: [], env: 'e' });
    const r = await mount({ order: PROTECT, net: 2 });
    await arm(r);
    await act(async () => { await button(r, '平倉')!.props.onClick(); });
    expect(m.place).not.toHaveBeenCalled();
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 部分停損停利已取消（未受保護）' }));
});
