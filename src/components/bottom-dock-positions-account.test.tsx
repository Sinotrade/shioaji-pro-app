import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
const mocks = vi.hoisted(() => ({ place: vi.fn(), stock: vi.fn(), notify: vi.fn() }));
vi.mock('../lib/trade', () => ({ placeQuickOrder: mocks.place, placeStockExitByShares: mocks.stock, notify: mocks.notify }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => ({ code, name: code, security_type: code === '2330' ? 'STK' : 'FUT' }) }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null, yesterdayQuantityNotice: () => null }));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: { current: null }, width: 1400 }) }));
import { PositionsPane } from './bottom-dock-positions';
import { ArmLockButton } from './bottom-dock-shared';
const selected: Account = { account_type: 'F', broker_id: 'BR', account_id: 'SELECTED', signed: true, person_id: '', username: '' };
const owner = { ...selected, account_id: 'OWNER' };
const position: AccountedPosition = { account: owner, code: 'TMF', id: 1, direction: 'Buy', quantity: 3, price: 100, last_price: 100, pnl: 0 };
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function mount(row: AccountedPosition) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    await act(async () => { view = create(createElement(PositionsPane, { positions: [row], initialStatus: 'ready', mode: 'merged', market: 'all', scopeKey: '', fallback: { stock: null, futures: selected }, onChanged: vi.fn(), onSelectCode: vi.fn() })); });
    await act(async () => { view!.root.findAllByType(ArmLockButton)[0]!.props.onToggle(); });
}
it('shows loading before the first positions result and empty only after a successful read', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const props = { positions: [], mode: 'merged' as const, market: 'all' as const,
        scopeKey: '', fallback: { stock: null, futures: selected },
        onChanged: vi.fn(), onSelectCode: vi.fn() };
    await act(async () => { view = create(createElement(PositionsPane, { ...props, initialStatus: 'loading' })); });
    expect(JSON.stringify(view!.toJSON())).toContain('載入持倉');
    expect(JSON.stringify(view!.toJSON())).not.toContain('NO OPEN POSITIONS');
    await act(async () => { view!.update(createElement(PositionsPane, { ...props, initialStatus: 'ready' })); });
    expect(JSON.stringify(view!.toJSON())).toContain('NO OPEN POSITIONS');
    await act(async () => { view!.update(createElement(PositionsPane, { ...props, initialStatus: 'failed' })); });
    expect(JSON.stringify(view!.toJSON())).toContain('持倉尚未確認');
    expect(JSON.stringify(view!.toJSON())).not.toContain('NO OPEN POSITIONS');
});
async function click(label: string) {
    const button = view!.root.findAllByType('button').find(b => b.children.filter(c => typeof c === 'string').join('').trim() === label)!;
    await act(async () => { await button.props.onClick({ stopPropagation: vi.fn() }); });
}
it('closes the row owner with Cover even when another account is selected', async () => {
    mocks.place.mockResolvedValue({ status: { status: 'Submitted', deal_quantity: 0 } });
    await mount(position); await click('平');
    expect(mocks.place.mock.calls[0]!.slice(1)).toEqual(['Sell', null, 3, { account: owner, ocType: 'Cover' }]);
});
it('does not infer an unknown owner from the selected account', async () => {
    await mount({ ...position, account: undefined }); await click('平');
    expect(mocks.place).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('帳戶歸屬不明');
});
it.each(['Submitted', 'PartFilled', 'timeout'])('submits exactly one owner-scoped Auto reverse order for %s', async status => {
    if (status === 'timeout') mocks.place.mockRejectedValueOnce(new Error('timeout'));
    else mocks.place.mockResolvedValueOnce({ status: { status, deal_quantity: 1 } });
    await mount(position); await click('反');
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(mocks.place.mock.calls[0]!.slice(1)).toEqual(['Sell', null, 6, { account: owner, ocType: 'Auto' }]);
    if (status === 'timeout') expect(mocks.notify.mock.calls.at(-1)![0].title).toBe('反手未完整確認');
});
it('does not send a second reverse order even when the HTTP response is Filled', async () => {
    mocks.place.mockResolvedValueOnce({ status: { status: 'Filled', deal_quantity: 6 } });
    await mount(position); await click('反');
    expect(mocks.place.mock.calls.map(call => call.slice(1))).toEqual([
        ['Sell', null, 6, { account: owner, ocType: 'Auto' }],
    ]);
});
it('keeps stock shares and explicit owner in the split-exit helper', async () => {
    const stock = { ...owner, account_type: 'S' };
    mocks.stock.mockResolvedValue([]);
    await mount({ ...position, code: '2330', account: stock, quantity: 1500, yd_quantity: 1500, cond: 'Cash' }); await click('平');
    expect(mocks.stock.mock.calls[0]!.slice(1)).toEqual(['Sell', 1500, stock]);
    await click('反');
    expect(mocks.stock).toHaveBeenCalledTimes(1);
    expect(mocks.place).not.toHaveBeenCalled();
});
