// 指標對話框裡的「內建／成交標記」這一列：打開設定、移除、加回，以及搜尋與分類的顯示條件
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));

// 最小的假物件：localStorage 用記憶體（我的最愛、自訂指標）；document 只要有 body（portal 的目標）
vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as { document?: unknown }).document = { body: {} };
});

import { IndicatorDialog } from './indicator-dialog';

const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
let view: ReactTestRenderer;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => {
    act(() => view?.unmount());
    vi.unstubAllGlobals();
});

function open(added?: boolean) {
    const fills = added === undefined ? undefined : { added, colors: { buy: '#2563eb', sell: '#f97316' }, onOpen: vi.fn(), onRemove: vi.fn() };
    const onAdd = vi.fn();
    const onClose = vi.fn();
    act(() => { view = create(createElement(IndicatorDialog, { instances: [], onAdd, onClose, fills })); });
    return { fills: fills!, onAdd, onClose };
}
const all = () => text(view.root);
const headers = () => view.root.findAll((n) => n.type === 'div' && n.children.length === 1 && typeof n.children[0] === 'string').map(text);
// 整列：名稱是「成交標記」的那顆 <button>
const rows = () => view.root.findAll((n) => n.type === 'button' && text(n).startsWith('成交標記'));
const removeBtn = () => view.root.findAll((n) => n.props.role === 'button' && n.props['aria-label'] === '移除成交標記');
const search = (value: string) => act(() => view.root.findByType('input').props.onChange({ target: { value } }));
const key = (k: string) => ({ key: k, stopPropagation: vi.fn(), preventDefault: vi.fn() });

it('沒傳 fills：沒有「內建」與「成交標記」', () => {
    open();
    expect(headers()).toContain('主圖疊加');
    expect(headers()).not.toContain('內建');
    expect(all()).not.toContain('成交標記');
});

it('已加入：有「已加入」與「移除」；點整列打開設定；移除（滑鼠、Enter、空白鍵）只移除，不打開也不關對話框', () => {
    const { fills, onAdd, onClose } = open(true);
    expect(headers().slice(0, 3)).toEqual(['分類', '內建', '主圖疊加']); // 清單最上面、排在「主圖疊加」之前
    expect(rows()).toHaveLength(1);
    expect(text(rows()[0]!)).toBe('成交標記K 線上的實際成交點；點一下設定形狀、標籤與顏色已加入移除');
    expect(rows()[0]!.findAll((n) => n.props.style?.background === 'linear-gradient(135deg, #2563eb 50%, #f97316 50%)')).toHaveLength(1); // 色塊：買、賣色各一半
    expect(rows()[0]!.findAll((n) => n.props.title === '加入我的最愛')).toHaveLength(0); // 沒有星號
    expect([text(removeBtn()[0]!), removeBtn()[0]!.props.tabIndex]).toEqual(['移除', 0]);

    act(() => rows()[0]!.props.onClick());
    expect([fills.onOpen.mock.calls.length, fills.onRemove.mock.calls.length]).toEqual([1, 0]);

    const click = { stopPropagation: vi.fn() };
    act(() => removeBtn()[0]!.props.onClick(click));
    expect(click.stopPropagation).toHaveBeenCalled();
    expect([fills.onOpen.mock.calls.length, fills.onRemove.mock.calls.length]).toEqual([1, 1]);

    const enter = key('Enter');
    act(() => removeBtn()[0]!.props.onKeyDown(enter));
    expect(enter.stopPropagation).toHaveBeenCalled();
    expect(enter.preventDefault).toHaveBeenCalled(); // 不讓外層整列跟著被按下
    act(() => removeBtn()[0]!.props.onKeyDown(key(' ')));
    const tab = key('Tab');
    act(() => removeBtn()[0]!.props.onKeyDown(tab)); // 其他鍵不動
    expect([tab.stopPropagation.mock.calls.length, tab.preventDefault.mock.calls.length]).toEqual([0, 0]);
    expect([fills.onOpen.mock.calls.length, fills.onRemove.mock.calls.length]).toEqual([1, 3]);
    expect([onAdd.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 0]);
});

it('未加入：沒有「已加入」與「移除」，說明是加回那句；點整列打開設定', () => {
    const { fills } = open(false);
    expect(headers()).toContain('內建');
    expect(text(rows()[0]!)).toBe('成交標記K 線上的實際成交點；點一下加回這張圖');
    expect(all()).not.toContain('已加入');
    expect(removeBtn()).toHaveLength(0);
    act(() => rows()[0]!.props.onClick());
    expect([fills.onOpen.mock.calls.length, fills.onRemove.mock.calls.length]).toEqual([1, 0]);
});

it('搜尋「成交」「FILLS」看得到、搜尋「macd」看不到；切到「主圖疊加」分類看不到；只剩這一列時不出現空白訊息', () => {
    open(true);
    search('成交');
    expect(rows()).toHaveLength(1);
    search(' FILLS '); // 去頭尾空白、不分大小寫
    expect(rows()).toHaveLength(1);
    expect(all()).not.toContain('沒有符合');
    search('macd');
    expect([rows().length, headers().includes('內建')]).toEqual([0, false]);
    expect(all()).toContain('MACD');
    search('zzzz');
    expect(all()).toContain('沒有符合「zzzz」的指標'); // 兩邊都沒有才出現
    search('');
    expect(rows()).toHaveLength(1);
    act(() => view.root.find((n) => n.type === 'button' && text(n) === '主圖疊加').props.onClick());
    expect([rows().length, headers().includes('內建')]).toEqual([0, false]);
    expect(headers()).toContain('主圖疊加');
    act(() => view.root.find((n) => n.type === 'button' && text(n) === '全部指標').props.onClick());
    expect(rows()).toHaveLength(1);
});
