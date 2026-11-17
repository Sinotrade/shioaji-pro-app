import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Trade } from '../lib/types/order';
const mocks = vi.hoisted(() => ({ qty: vi.fn(async () => ({})), notify: vi.fn() }));
vi.mock('../lib/shioaji', () => ({ updateOrderQty: mocks.qty, updateOrderPrice: vi.fn(), cancelOrder: vi.fn() }));
// 委託表併入美股列：美股操作模組在 import 時碰 window，測試裡換成空殼
vi.mock('./bottom-dock-us', () => ({ usAccountGroupKey: () => '', UsOrderActions: () => null, usOrderPriceText: () => '', usOrderRowKey: () => '', usStatusBucket: () => 'dead', UsTag: () => null }));
vi.mock('../lib/us/us-trading-state', () => ({ usRemaining: () => '0' }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify }));
import { OrderEditor } from './bottom-dock-orders';
let view: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function mount(quantity: number, deal_quantity = 0, cancel_quantity = 0) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const trade = { order: { id: 'fixture', quantity }, contract: { code: 'FIXTURE' },
        status: { status: deal_quantity ? 'PartFilled' : 'Submitted', deal_quantity, cancel_quantity } } as Trade;
    await act(async () => { view = create(createElement(OrderEditor, { trade, field: 'qty', onChanged: vi.fn() })); });
    await act(async () => view!.root.findByType('button').props.onClick());
}
async function submit(value?: string) {
    if (value !== undefined) await act(async () => view!.root.findByType('input').props.onChange({target:{value}}));
    await act(async () => view!.root.findByType('input').props.onKeyDown({key:'Enter'}));
}
it('converts desired remaining 2 out of 3 into reduction 1', async () => {
    await mount(3); await submit('2');
    expect(mocks.qty).toHaveBeenCalledExactlyOnceWith('fixture', 1);
});
it('subtracts prior fills and cumulative cancellations before calculating reduction', async () => {
    await mount(5, 1, 2);
    expect(view!.root.findByType('input').props.value).toBe('2');
    await submit('1');
    expect(mocks.qty).toHaveBeenCalledExactlyOnceWith('fixture', 1);
});
it.each([undefined, '3', '4', '0', '-1', '1.5', ''])('does not send unchanged, increasing or invalid remainder %s', async value => {
    await mount(3); await submit(value);
    expect(mocks.qty).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({title:'未送出減量', body:expect.stringContaining('全部取消請使用刪單')}));
});
