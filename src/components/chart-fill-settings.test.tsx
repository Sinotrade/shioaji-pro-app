// 成交標記的設定面板：形狀、標籤、顏色（買賣各自換色／跟 K 棒同色）、帳戶範圍 — 都是全域偏好，點了就寫入
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// localStorage 用記憶體（要在偏好模組載入前就位）
const store = vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    };
    return store;
});

import { DRAWING_PALETTE } from '../lib/chart-drawings';
import {
    CHART_FILL_BUY_KEY as BUY, CHART_FILL_COLOR_KEY as COLOR, CHART_FILL_SCOPE_KEY as SCOPE, CHART_FILL_SELL_KEY as SELL, CHART_FILL_SHAPE_KEY as SHAPE,
    CHART_FILL_STYLE_KEY as STYLE, chartFillColors, getChartFillColor, getChartFillScope, getChartFillStyle, setChartFillBuy, setChartFillColor,
    setChartFillScope, setChartFillSell, setChartFillShape, setChartFillStyle, useChartFillBuy, useChartFillColor, useChartFillScope, useChartFillSell,
    useChartFillShape, useChartFillStyle,
} from '../lib/chart-fill-prefs';
import * as drawStyles from './chart-drawing-tools.css';
import { ChartFillSettings, FILL_SHAPE_GLYPH } from './chart-fill-settings';

const CANDLE = { up: '#f23645', down: '#16b389' };
const DEFAULTS = chartFillColors('dark', CANDLE, 'distinct'); // 深色主題的預設藍買橘賣
// 面板的 props 由全域偏好的 hook 帶入（使用端的接法）：點了寫入偏好就跟著重畫
function Panel() {
    const [color, buy, sell] = [useChartFillColor(), useChartFillBuy(), useChartFillSell()];
    return createElement(ChartFillSettings, {
        shape: useChartFillShape(), style: useChartFillStyle(), color, scope: useChartFillScope(),
        colors: chartFillColors('dark', CANDLE, color, { buy, sell }), custom: { buy, sell }, account: '期貨 ****567',
    });
}

let view: ReactTestRenderer;
const mount = () => act(() => { view = create(createElement(Panel)); });
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setChartFillShape('triangle');
    setChartFillStyle('price');
    setChartFillColor('distinct');
    setChartFillScope('active');
    setChartFillBuy('');
    setChartFillSell('');
});
afterEach(() => {
    act(() => view?.unmount());
    vi.unstubAllGlobals();
});

// 看得到的文字（示意字元與色塊是 aria-hidden，不算）；鈕的名稱以 aria-label 優先（只有顏色列的買／賣鈕與色塊有）
const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.props['aria-hidden'] ? '' : n.children.map(text).join('');
const name = (b: ReactTestInstance): string => b.props['aria-label'] ?? text(b).trim();
const groups = (label: string) => view.root.findAll((n) => n.type === 'div' && n.props.role === 'group' && n.props['aria-label'] === label);
const row = (label: string) => groups(label)[0]!.findAllByType('button');
const pressed = (label: string) => row(label).filter((b) => b.props['aria-pressed']).map(name);
const click = (b: ReactTestInstance) => act(() => b.props.onClick());
const pick = (label: string, option: string) => click(row(label).find((b) => name(b) === option)!);
// 顏色列：買／賣兩顆鈕、鈕上的色塊、哪一邊的色盤開著、色盤裡描邊（選中）的色塊
type Side = '買的顏色' | '賣的顏色';
const side = (label: Side) => row('顏色').find((b) => name(b) === label)!;
const chips = () => (['買的顏色', '賣的顏色'] as const).map((label) => side(label).findAllByProps({ 'aria-hidden': true })[0]!.props.style.background);
const expanded = () => (['買的顏色', '賣的顏色'] as const).map((label) => side(label).props['aria-expanded']);
// 色塊後面的箭頭：▾ 可展開、▴ 已展開
const carets = () => (['買的顏色', '賣的顏色'] as const).map((label) => side(label).findAllByProps({ 'aria-hidden': true })[1]!.children.join(''));
const active = (label: Side) => row(label).filter((b) => b.props.className === drawStyles.swatch.active).map(name);
// 「跟 K 棒同色」勾選框（原生 checkbox，不是分段鈕）
const candle = () => groups('顏色')[0]!.findByType('input');
const setCandle = (checked: boolean) => act(() => candle().props.onChange({ target: { checked } }));
// 色盤前面的小字：正在換哪一邊
const pickerSide = (label: Side) => text(groups(label)[0]!.findAllByType('span')[0]!);

it('形狀四選一、標籤三選一：aria-pressed 是目前的偏好，點了就寫入；沒有「不畫／顯示」也沒有「完成」', () => {
    mount();
    expect(view.root.findAllByType('button').map(name)).toEqual([
        '三角形', '箭頭', '圓點', '菱形', '不標', '買賣', '價格', '買的顏色', '賣的顏色', '改成全部帳戶',
    ]);
    // 色鈕不是分段裡的選項（沒有 aria-pressed）；跟 K 棒同色是另一個勾選框
    expect([pressed('顏色'), candle().props.type, candle().props.checked, text(candle().parent!).trim()]).toEqual([[], 'checkbox', false, '跟 K 棒同色']);
    expect([pressed('形狀'), pressed('標籤')]).toEqual([['三角形'], ['價格']]);
    for (const [label, value] of [['箭頭', 'arrow'], ['圓點', 'circle'], ['菱形', 'diamond'], ['三角形', 'triangle']] as const) {
        pick('形狀', label);
        expect([pressed('形狀'), store.get(SHAPE)]).toEqual([[label], value]);
    }
    for (const [label, value] of [['不標', 'dot'], ['買賣', 'side'], ['價格', 'price']] as const) {
        pick('標籤', label);
        expect([pressed('標籤'), getChartFillStyle(), store.get(STYLE)]).toEqual([[label], value, value]);
    }
    expect(pressed('形狀')).toEqual(['三角形']); // 兩列各管各的
});

it('形狀鈕前面有一個示意字元（FILL_SHAPE_GLYPH 的買），用圖上現在的買色', () => {
    setChartFillBuy(DRAWING_PALETTE[7]);
    mount();
    const samples = row('形狀').map((b) => [name(b), ...b.findAllByType('span').flatMap((s) => [text(s.children[0]!), s.props.style.color])]);
    expect(samples).toEqual(Object.values(FILL_SHAPE_GLYPH).map(([buy, , label]) => [label, buy, DRAWING_PALETTE[7]]));
    expect(samples.map((s) => s[1])).toEqual(['▲', '↑', '●', '◆']);
});

it('點「買的顏色」展開色盤；選色寫入買色（賣色不動），原本同 K 棒就切回買賣各一色；「預設」把自選色清成空字串', () => {
    setChartFillBuy(DRAWING_PALETTE[0]);
    setChartFillColor('candle');
    mount();
    expect([expanded(), carets(), groups('買的顏色'), chips()]).toEqual([[false, false], ['▾', '▾'], [], [CANDLE.up, CANDLE.down]]);
    click(side('買的顏色'));
    expect([expanded(), carets(), getChartFillColor()]).toEqual([[true, false], ['▴', '▾'], 'candle']); // 只是打開色盤，還沒換
    expect([pickerSide('買的顏色'), row('買的顏色').map(name)]).toEqual(['買', [...DRAWING_PALETTE.map((c) => `顏色 ${c}`), '預設色']]);
    expect([active('買的顏色'), pressed('買的顏色')]).toEqual([[], []]); // 同 K 棒時自選色和預設色都沒在用
    pick('買的顏色', `顏色 ${DRAWING_PALETTE[2]}`);
    expect([store.get(BUY), store.get(SELL), getChartFillColor(), store.get(COLOR)]).toEqual([DRAWING_PALETTE[2], '', 'distinct', 'distinct']);
    expect([chips(), active('買的顏色'), pressed('買的顏色')]).toEqual([[DRAWING_PALETTE[2], DEFAULTS.sell], [`顏色 ${DRAWING_PALETTE[2]}`], [`顏色 ${DRAWING_PALETTE[2]}`]]); // 沒選的賣色用預設
    expect(expanded()).toEqual([true, false]); // 色盤留著，可以繼續換
    pick('買的顏色', '預設色');
    expect([store.get(BUY), getChartFillColor(), chips(), active('買的顏色'), pressed('買的顏色')]).toEqual(['', 'distinct', [DEFAULTS.buy, DEFAULTS.sell], [], ['預設色']]);
    click(side('買的顏色')); // 再點一次收起
    expect([expanded(), groups('買的顏色')]).toEqual([[false, false], []]);
});

it('賣色一樣換；色盤一次只開一邊', () => {
    mount();
    click(side('買的顏色'));
    click(side('賣的顏色'));
    expect([expanded(), groups('買的顏色').length, groups('賣的顏色').length, pickerSide('賣的顏色')]).toEqual([[false, true], 0, 1, '賣']);
    pick('賣的顏色', `顏色 ${DRAWING_PALETTE[5]}`);
    expect([store.get(SELL), store.get(BUY), chips()]).toEqual([DRAWING_PALETTE[5], '', [DEFAULTS.buy, DRAWING_PALETTE[5]]]);
    pick('賣的顏色', '預設色');
    expect([store.get(SELL), chips()]).toEqual(['', [DEFAULTS.buy, DEFAULTS.sell]]);
});

it('勾「跟 K 棒同色」切換 candle／distinct 並收起色盤；自選色留著，取消勾選後還在', () => {
    setChartFillBuy(DRAWING_PALETTE[1]);
    mount();
    click(side('買的顏色'));
    expect([candle().props.checked, expanded(), active('買的顏色')]).toEqual([false, [true, false], [`顏色 ${DRAWING_PALETTE[1]}`]]);
    setCandle(true);
    expect([getChartFillColor(), store.get(COLOR), candle().props.checked]).toEqual(['candle', 'candle', true]);
    expect([expanded(), groups('買的顏色'), chips()]).toEqual([[false, false], [], [CANDLE.up, CANDLE.down]]);
    setCandle(false);
    expect([getChartFillColor(), store.get(COLOR), candle().props.checked]).toEqual(['distinct', 'distinct', false]);
    expect([store.get(BUY), chips()]).toEqual([DRAWING_PALETTE[1], [DRAWING_PALETTE[1], DEFAULTS.sell]]);
});

it('帳戶那一行：目前帳戶時顯示帳戶名稱、可改成全部帳戶，再改回來', () => {
    mount();
    const toggle = () => view.root.findAllByType('button').at(-1)!;
    const line = () => [text(toggle().parent!.findByType('span')), name(toggle())];
    expect(line()).toEqual(['帳戶：期貨 ****567', '改成全部帳戶']);
    click(toggle());
    expect([getChartFillScope(), store.get(SCOPE), line()]).toEqual(['all', 'all', ['帳戶：全部帳戶', '改成目前帳戶']]);
    click(toggle());
    expect([getChartFillScope(), store.get(SCOPE), line()]).toEqual(['active', 'active', ['帳戶：期貨 ****567', '改成全部帳戶']]);
});
