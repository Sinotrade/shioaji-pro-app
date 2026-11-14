import { reconcileOrdersOnce } from '../test/mock-order-reconciliation';
import '../test/mock-order-reconciliation';
import { operationNotice } from '../test/operation-notice';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
const mocks = vi.hoisted(() => ({ place: vi.fn(), stock: vi.fn(), notify: vi.fn(), simulation: undefined as boolean | undefined }));
vi.mock('../lib/trade', () => ({ placeQuickOrder: mocks.place, placeStockExitByShares: mocks.stock, notify: mocks.notify }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => ({ code, name: code, security_type: code === '2330' ? 'STK' : code === '030392' ? 'WRT' : 'FUT' }) }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null, yesterdayQuantityNotice: () => null, knownServerInfo: () => ({ simulation: mocks.simulation }) }));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: { current: null }, width: 1400 }) }));
import { PositionsPane } from './bottom-dock-positions';
import { ArmLockButton, ConfirmButton } from './bottom-dock-shared';
const selected: Account = { account_type: 'F', broker_id: 'BR', account_id: 'SELECTED', signed: true, person_id: '', username: '' };
const owner = { ...selected, account_id: 'OWNER' };
const position: AccountedPosition = { account: owner, code: 'TMF', id: 1, direction: 'Buy', quantity: 3, price: 100, last_price: 100, pnl: 0 };
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.place.mockReset(); mocks.stock.mockReset(); mocks.simulation = undefined; });
async function mount(row: AccountedPosition | AccountedPosition[]) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    await act(async () => { view = create(createElement(PositionsPane, { positions: Array.isArray(row) ? row : [row], initialStatus: 'ready', mode: 'merged', market: 'all', scopeKey: '', fallback: { stock: null, futures: selected }, onChanged: vi.fn(), onSelectCode: vi.fn() })); });
    await act(async () => { view!.root.findAllByType(ArmLockButton)[0]!.props.onToggle(); });
}
async function click(label: string) {
    const button = view!.root.findAllByType('button').find(b => b.children.filter(c => typeof c === 'string').join('').trim() === label)!;
    await act(async () => { await button.props.onClick({ stopPropagation: vi.fn() }); });
}

// PR #411 review: the 待對帳 guard sends nothing, so it must not be reported as
// "maybe partly sent, do not resend" nor spend an update_status reconciliation.
it.each(['平', '反'])('R7 blocked %s on a 待對帳 row reports 未送出 and does not trigger unknown-outcome reconciliation', async label => {
    await mount({ ...position, reconcileReason: '成交無法安全投影' });
    await click(label);
    expect(mocks.place).not.toHaveBeenCalled();
    const titles = mocks.notify.mock.calls.map(c => (c[0] as { title: string }).title);
    expect(titles.some(t => t.includes('未完整確認'))).toBe(false);
    expect(operationNotice(mocks.notify, label === '平' ? '平倉未成立（未送出或被券商拒絕）' : '反手未成立（未送出或被券商拒絕）').body).toContain('未送出委託');
    await vi.dynamicImportSettled();
    expect(reconcileOrdersOnce).not.toHaveBeenCalled();
});

it.each(['blocked', 'sent', 'unknown'])('batch flatten counts blocked rows separately when the other row is %s', async outcome => {
    const blocked = { ...position, reconcileReason: '成交無法安全投影' };
    const other = { ...position, code: 'MXF', ...(outcome === 'blocked' ? { reconcileReason: '成交待對帳' } : {}) };
    if (outcome === 'unknown') mocks.place.mockRejectedValueOnce(new Error('timeout'));
    else mocks.place.mockResolvedValueOnce({ status: { status: 'Submitted' } });
    await mount([blocked, other]);
    await act(async () => { view!.root.findAllByType('input').find(i => i.props.title === '全選（批次平倉）')!.props.onChange(); });
    await act(async () => { view!.root.findByType(ConfirmButton).props.onConfirm(); });
    await vi.dynamicImportSettled();
    expect(mocks.place).toHaveBeenCalledTimes(outcome === 'blocked' ? 0 : 1);
    const notice = operationNotice(mocks.notify, outcome === 'blocked' ? '批次平倉未成立（未送出或被券商拒絕）' : '批次平倉請核對委託');
    expect(notice.body).toContain(`未成立 ${outcome === 'blocked' ? 2 : 1} 筆`);
    expect(notice.body.includes('可能部分送出')).toBe(outcome === 'unknown');
    expect(reconcileOrdersOnce).toHaveBeenCalledTimes(outcome === 'unknown' ? 1 : 0);
});
