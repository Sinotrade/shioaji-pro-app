// #402 每個價位的我的委託格：分段／精簡只看面板寬度、萬的寫法、格子內容（部分成交、全部成交、
// 依成交價歸位、同價多筆、刪單送出中）、滑鼠提示與遮金額
import { expect, it } from 'vitest';
import { cellTitle, failedCancels, flashCellsMode, fmtCellQty, ladderCells, settleCancelling, SPLIT_MIN_WIDTH } from './flash-cells';
import { normalizeFlashOrderOpts } from './flash-account';
import type { Trade } from './types/order';

let n = 0;
const trade = (action: 'Buy' | 'Sell', price: number, quantity: number, deals: [number, number][] = [], extra: Record<string, unknown> = {}) => {
    const id = `t${++n}`;
    const dealt = deals.reduce((s, [, q]) => s + q, 0);
    return {
        contract: { code: '2317', security_type: 'STK' },
        order: { id, ordno: `W${n}`, seqno: `Q${n}`, action, price, quantity, ...extra },
        status: { id, status: dealt >= quantity ? 'Filled' : dealt > 0 ? 'PartFilled' : 'Submitted', order_quantity: quantity, deal_quantity: dealt, cancel_quantity: 0, modified_price: 0,
            deals: deals.map(([p, q], i) => ({ seq: `${id}-${i}`, price: p, quantity: q, ts: 1 })) },
    } as unknown as Trade;
};
const key = (p: number) => p.toFixed(2);
const remaining = (t: Trade) => (t.status.status === 'Filled' || t.status.status === 'Cancelled' ? 0 : t.order.quantity - t.status.deal_quantity - t.status.cancel_quantity);
const cellsOf = (trades: Trade[], cancelling?: Set<string>) => ladderCells(trades, {
    workingQty: remaining, orderKey: t => key(t.order.price), fillScope: () => true, priceKey: key, cancelling,
});

it('split vs compact depends on the panel width only, at SPLIT_MIN_WIDTH', () => {
    expect(SPLIT_MIN_WIDTH).toBe(330);
    expect(flashCellsMode('split', 330)).toEqual({ split: true, fallback: null });
    expect(flashCellsMode('split', 340)).toEqual({ split: true, fallback: null });
    const narrow = flashCellsMode('split', 329);
    expect(narrow.split).toBe(false);
    expect(narrow.fallback).toContain('330px');
    expect(flashCellsMode('split', 214).split).toBe(false);
    // not measured yet (first paint, tests): the setting
    expect(flashCellsMode('split', null)).toEqual({ split: true, fallback: null });
    // compact chosen: never a fallback note
    expect(flashCellsMode('compact', 600)).toEqual({ split: false, fallback: null });
    expect(flashCellsMode('compact', 200)).toEqual({ split: false, fallback: null });
});

it('writes quantities without commas below 10,000 and with 萬 from 10,000 (same as the compact book)', () => {
    expect(fmtCellQty(8)).toBe('8');
    expect(fmtCellQty(999)).toBe('999');
    expect(fmtCellQty(9_999)).toBe('9999');
    expect(fmtCellQty(10_000)).toBe('1.0萬');
    expect(fmtCellQty(12_500)).toBe('1.3萬');
    expect(fmtCellQty(99_999)).toBe('10.0萬');
    expect(fmtCellQty(150_000)).toBe('15.0萬');
});

it('a partly filled order: working at its price, filled at the fill price', () => {
    const t = trade('Buy', 213.5, 12, [[213.5, 4]]);
    const c = cellsOf([t]).get(key(213.5))!.buy!;
    expect(c).toMatchObject({ working: 8, filled: 4, orders: 1, pending: false });
    expect(c.detail).toEqual([{ id: t.order.id, ordno: t.order.ordno, working: 8, filled: 4 }]);
});

it('a fully filled order leaves only the fill; fills at a better price go to that price', () => {
    const full = trade('Buy', 212.5, 10, [[212.5, 10]]);
    const better = trade('Buy', 214, 5, [[213.5, 3], [214, 2]]);
    const m = cellsOf([full, better]);
    expect(m.get(key(212.5))!.buy).toMatchObject({ working: 0, filled: 10, orders: 0 });
    expect(m.get(key(213.5))!.buy).toMatchObject({ working: 0, filled: 3 });
    expect(m.get(key(214))!.buy).toMatchObject({ working: 0, filled: 2 });
});

it('several orders at one price add up, each listed in the tooltip', () => {
    const a = trade('Sell', 216, 2, [[216, 1]]);
    const b = trade('Sell', 216, 3);
    const c = cellsOf([a, b]).get(key(216))!.sell!;
    expect(c).toMatchObject({ working: 4, filled: 1, orders: 2 });
    const title = cellTitle('sell', '216.00', c, '張', false).split('\n');
    expect(title[0]).toBe('刪除 216.00 賣單 4');
    expect(title).toContain(`・委託 ${a.order.ordno}：成交 1、未成交 1`);
    expect(title).toContain(`・委託 ${b.order.ordno}：未成交 3`);
});

it('odd-lot share quantities add up per price', () => {
    const a = trade('Buy', 100, 800, [[100, 200]], { order_lot: 'IntradayOdd' });
    const b = trade('Buy', 100, 999, [], { order_lot: 'IntradayOdd' });
    expect(cellsOf([a, b]).get(key(100))!.buy).toMatchObject({ working: 1599, filled: 200, orders: 2 });
});

it('cancel pending only while every working order at the price is being cancelled', () => {
    const a = trade('Buy', 211, 1);
    const b = trade('Buy', 211, 2);
    expect(cellsOf([a, b], new Set([a.order.id])).get(key(211))!.buy!.pending).toBe(false);
    expect(cellsOf([a, b], new Set([a.order.id, b.order.id])).get(key(211))!.buy!.pending).toBe(true);
    // a fill-only cell is never pending
    const f = trade('Buy', 210, 1, [[210, 1]]);
    expect(cellsOf([f], new Set([f.order.id])).get(key(210))!.buy!.pending).toBe(false);
    expect(cellTitle('buy', '211.00', cellsOf([a], new Set([a.order.id])).get(key(211))!.buy!, '張', false)).toContain('刪單送出中');
});

it('the tooltip keeps the old single-order line, and hides every number with 遮金額', () => {
    const one = cellsOf([trade('Buy', 100, 3)]).get(key(100))!.buy!;
    expect(cellTitle('buy', '100.00', one, '張', false)).toBe('刪除 100.00 買單 3');
    const t = trade('Buy', 100, 12, [[100, 4]]);
    const c = cellsOf([t]).get(key(100))!.buy!;
    const priv = cellTitle('buy', '100.00', c, '張', true);
    expect(priv.replaceAll('100.00', '')).not.toMatch(/\d/);
    expect(priv).not.toContain(t.order.ordno);
});

it('the 委託格 setting is saved only when 精簡 (absent = 分段)', () => {
    const base = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT' };
    expect(normalizeFlashOrderOpts({ ...base, orderCells: 'compact' })?.orderCells).toBe('compact');
    expect(normalizeFlashOrderOpts({ ...base, orderCells: 'split' })).not.toHaveProperty('orderCells');
    expect(normalizeFlashOrderOpts({ ...base, orderCells: 'bogus' })).not.toHaveProperty('orderCells');
    expect(normalizeFlashOrderOpts(base)).not.toHaveProperty('orderCells');
});

it('刪單送出中 ends when the order is no longer working (cancelled / filled / gone), not when the request returns', () => {
    const a = trade('Buy', 100, 2);
    const b = trade('Buy', 100, 3);
    const both = new Set([a.order.id, b.order.id]);
    // still working: the same Set (no re-render)
    expect(settleCancelling(both, [a, b], remaining)).toBe(both);
    const cancelled = { ...a, status: { ...a.status, status: 'Cancelled', cancel_quantity: 2 } } as Trade;
    expect([...settleCancelling(both, [cancelled, b], remaining)]).toEqual([b.order.id]);
    const filled = { ...b, status: { ...b.status, status: 'Filled', deal_quantity: 3 } } as Trade;
    expect(settleCancelling(both, [cancelled, filled], remaining).size).toBe(0);
    // no longer in the list at all
    expect(settleCancelling(both, [], remaining).size).toBe(0);
    const empty = new Set<string>();
    expect(settleCancelling(empty, [a], remaining)).toBe(empty);
});

it('a cancel that failed (rejected) is released at once; a sent one waits for the status update', () => {
    const results: PromiseSettledResult<unknown>[] = [{ status: 'fulfilled', value: {} }, { status: 'rejected', reason: new Error('x') }];
    expect(failedCancels(['a', 'b'], results)).toEqual(['b']);
    expect(failedCancels(['a'], [])).toEqual(['a']);
});
