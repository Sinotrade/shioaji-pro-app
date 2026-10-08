// K 棒讀值列（issue #240）元件測試：游標選中 K 棒、離開回最新、窄面板、tick 更新
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createOhlcStore } from '../lib/ohlc-legend';
import type { Candle } from '../lib/types/market';
import { OhlcLegend } from './ohlc-legend';

const colors = { up: '#e5484d', down: '#30a46c' };
const mk = (time: number, open: number, high: number, low: number, close: number, volume: number): Candle =>
    ({ time, open, high, low, close, volume });

function setup(width = 900) {
    const bars: Candle[] = [
        mk(60, 49100, 49150, 49000, 49120, 800),
        mk(120, 49120, 49210, 49050, 49180, 1234),
        mk(180, 49180, 49190, 49020, 49030, 900),
    ];
    const store = createOhlcStore();
    let r!: ReactTestRenderer;
    const render = (w: number) =>
        createElement(OhlcLegend, { store, getBars: () => bars, decimalsFor: () => 0, width: w, colors });
    act(() => {
        r = create(render(width));
    });
    return { r, store, bars, rerender: (w: number) => act(() => r.update(render(w))) };
}

const field = (r: ReactTestRenderer, key: string): ReactTestInstance | undefined =>
    r.root.findAll((n) => n.props['data-ohlc'] === key && typeof n.type === 'string')[0];
const text = (n: ReactTestInstance | undefined): string =>
    n ? n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '';

describe('OhlcLegend', () => {
    it('預設（游標不在圖上）顯示最新一根的開高低收、漲跌、量', () => {
        const { r } = setup();
        expect(text(field(r, 'open'))).toBe('開49,180');
        expect(text(field(r, 'high'))).toBe('高49,190');
        expect(text(field(r, 'low'))).toBe('低49,020');
        expect(text(field(r, 'close'))).toBe('收49,030');
        expect(text(field(r, 'change'))).toBe('-150 (-0.31%)');
        expect(text(field(r, 'volume'))).toBe('量900');
        // 收 < 開 → 跌色；漲跌依前一根收盤 → 跌色
        expect(field(r, 'close')!.findByProps({ 'data-ohlc-value': true }).props.style.color).toBe(colors.down);
        expect(field(r, 'change')!.props.style.color).toBe(colors.down);
    });

    it('游標移到哪根就顯示那根，離開回到最新一根', () => {
        const { r, store } = setup();
        act(() => store.hover(120));
        expect(text(field(r, 'close'))).toBe('收49,180');
        expect(text(field(r, 'change'))).toBe('+60 (+0.12%)');
        expect(field(r, 'close')!.findByProps({ 'data-ohlc-value': true }).props.style.color).toBe(colors.up);
        expect(r.root.findByProps({ 'data-ohlc': 'row' }).props['data-hovering']).toBe(true);
        act(() => store.hover(null));
        expect(text(field(r, 'close'))).toBe('收49,030');
        expect(r.root.findByProps({ 'data-ohlc': 'row' }).props['data-hovering']).toBe(false);
    });

    it('游標在最新一根以外時，tick 不會把讀值跳走；離開後讀到 tick 更新的最新值', () => {
        const { r, store, bars } = setup();
        act(() => store.hover(60));
        bars[2]!.close = 49100;
        act(() => store.bump());
        expect(text(field(r, 'close'))).toBe('收49,120');
        act(() => store.hover(null));
        expect(text(field(r, 'close'))).toBe('收49,100');
    });

    it('窄面板：中等寬度省略量與漲跌幅，很窄只留高低收', () => {
        const { r, rerender } = setup(480);
        expect(field(r, 'open')).toBeDefined();
        expect(text(field(r, 'change'))).toBe('-150');
        expect(field(r, 'volume')).toBeUndefined();
        rerender(320);
        expect(field(r, 'open')).toBeUndefined();
        expect(field(r, 'change')).toBeUndefined();
        expect(field(r, 'volume')).toBeUndefined();
        expect(text(field(r, 'high'))).toBe('高49,190');
        expect(text(field(r, 'low'))).toBe('低49,020');
        expect(text(field(r, 'close'))).toBe('收49,030');
    });

    it('沒有 K 棒時不顯示', () => {
        const store = createOhlcStore();
        let r!: ReactTestRenderer;
        act(() => {
            r = create(createElement(OhlcLegend, { store, getBars: () => [], decimalsFor: () => 0, width: 900, colors }));
        });
        expect(r.toJSON()).toBeNull();
    });
});
