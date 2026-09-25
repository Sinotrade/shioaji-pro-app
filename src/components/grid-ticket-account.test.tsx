// issue #139 — grid lay-out and dynamic-follow use the account captured
// before confirmation / when follow starts, never a later selection
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ selected: 'A', dropped: false, confirm: vi.fn(), future: vi.fn(), cancel: vi.fn(), notify: vi.fn(), blocked: null as string | null, confirmOn: true }));
const h = vi.hoisted(() => ({ accounts: ['A', 'B'].map(id => ({ account_type: 'F', broker_id: 'BR', account_id: id, signed: true, person_id: '', username: '' })) }));
const accounts = h.accounts as Account[];
vi.mock('../lib/account-store', () => ({ getAccountState: () => ({ accounts: m.dropped ? h.accounts.filter(a => a.account_id !== 'A') : h.accounts, selectedStock: null, selectedFutures: h.accounts.find(a => a.account_id === m.selected) ?? null, loaded: true }) }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: () => m.blocked, getRiskSettings: () => ({ confirmManualOrders: m.confirmOn }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: m.cancel, cancelOrders: vi.fn(), placeFuturesOrder: m.future, placeStockOrder: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: m.notify, isFuturesContract: () => true }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { GridTicket } from './grid-ticket';

const contract = { code: 'TMF', security_type: 'FUT', exchange: 'TAIFEX', reference: 100, limit_up: 0, limit_down: 0 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const gridTrade = (account: Account, price: number, id: string) => ({ account, contract: { code: 'TMF' }, order: { id, account, action: 'Buy', price, custom_field: 'sjgrid' }, status: { status: 'Submitted' } }) as unknown as Trade;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.selected = 'A'; m.dropped = false; m.blocked = null; m.confirmOn = true;
    m.confirm.mockResolvedValue(true);
    m.future.mockResolvedValue({});
    m.cancel.mockResolvedValue({});
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

const render = async (trades: Trade[] = []) => {
    await act(async () => { view = create(createElement(GridTicket, { contract, trades })); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
};

it('lay-out sends with the account captured before confirmation and shows it', async () => {
    await render();
    await act(async () => { await btn('鋪 ').props.onClick(); });
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ accountLabel: 'BR-A' });
    expect(m.future).toHaveBeenCalledTimes(5);
    expect(m.future.mock.calls.every(c => c[2] === accounts[0])).toBe(true);
});

it('lay-out aborts when the selection changes during confirmation', async () => {
    m.confirm.mockImplementation(async () => { m.selected = 'B'; return true; });
    await render();
    await act(async () => { await btn('鋪 ').props.onClick(); });
    expect(m.future).not.toHaveBeenCalled();
    expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '鋪單未送出' });
});

it('follow refills use the account captured when follow started and only look at its orders', async () => {
    // account B already has grid orders at 99/98 — they must not count for A,
    // and B's stray order at 90 must not be cancelled by A's follow loop
    await render([gridTrade(accounts[1]!, 99, 'b99'), gridTrade(accounts[1]!, 98, 'b98'), gridTrade(accounts[1]!, 90, 'b90')]);
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    m.selected = 'B'; // a later in-window change does not move the loop
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(m.cancel).not.toHaveBeenCalled();
    expect(m.future.mock.calls.map(c => [c[1].price, c[2]])).toEqual([[99, accounts[0]], [98, accounts[0]], [97, accounts[0]], [96, accounts[0]]]);
});

it('follow stops and notifies when its account becomes unusable', async () => {
    await render();
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    m.dropped = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(m.future).not.toHaveBeenCalled();
    expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '鋪單跟隨已停止' });
    expect(text(btn('動態跟隨'))).toBe('動態跟隨現價');
});

it('follow refills respect the risk kill switch', async () => {
    await render();
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    m.blocked = '風控鎖啟動中 — 所有下單已封鎖';
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(m.future).not.toHaveBeenCalled();
    expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '鋪單跟隨已停止', body: expect.stringContaining('風控鎖') });
});

it('shows the pinned follow account, masked in privacy mode', async () => {
    const { setPrivacyMode } = await import('../lib/privacy');
    await render();
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    const shown = () => view.root.findAll(n => n.type === 'span').map(text).find(t => t.startsWith('跟隨帳戶'));
    expect(shown()).toBe('跟隨帳戶 BR-A');
    await act(async () => { setPrivacyMode(true); });
    expect(shown()).toBe('跟隨帳戶 BR-•');
    await act(async () => { setPrivacyMode(false); btn('動態跟隨中').props.onClick(); });
    expect(shown()).toBeUndefined();
});
