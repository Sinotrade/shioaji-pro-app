// src/lib/chart-fill-prefs.ts — K 線成交標記的全域偏好（圖例列「成交」打開的設定面板：形狀、標籤、顏色、帳戶範圍；顯示／隱藏／移除是各圖自己的面板設定）
//
// 形狀（FillMarkShape）：triangle 三角形（預設）／arrow 箭頭／circle 圓點／diamond 菱形
// 標籤（FillMarkStyle）：dot 不標／side 買賣／price 價格（預設）
// 顏色（ChartFillColor）：distinct 買賣各一色（預設藍買橘賣，可各自換色）／candle 同 K 棒
// 帳戶範圍：active 目前帳戶（預設）／all 同一市場的全部帳戶
// 圖表可能在彈出視窗、設定在主視窗改 — 以同源 storage 事件同步其他視窗

import { useSyncExternalStore } from 'react';
import type { FillMarkShape, FillMarkStyle } from './chart-fill-marks';

export type ChartFillScope = 'active' | 'all';
/** 成交標記在一張圖上的狀態（各圖自己的，不是全域偏好）：on 顯示／hidden 暫時隱藏（圖例列留著）／off 已移除（從「指標」加回） */
export type ChartFillsState = 'on' | 'hidden' | 'off';
/** distinct：買賣各一色（預設藍買橘賣，和 K 棒的紅綠分得開；可各自換色）；candle：跟 K 棒同色 */
export type ChartFillColor = 'distinct' | 'candle';

export const CHART_FILL_STYLE_KEY = 'sj-pro-chart-fill-style';
export const CHART_FILL_STYLES: FillMarkStyle[] = ['dot', 'side', 'price'];
export const CHART_FILL_SHAPE_KEY = 'sj-pro-chart-fill-shape';
export const CHART_FILL_SHAPES: FillMarkShape[] = ['triangle', 'arrow', 'circle', 'diamond'];
export const CHART_FILL_SCOPE_KEY = 'sj-pro-chart-fill-scope';
export const CHART_FILL_SCOPES: ChartFillScope[] = ['active', 'all'];
export const CHART_FILL_COLOR_KEY = 'sj-pro-chart-fill-color';
export const CHART_FILL_COLORS: ChartFillColor[] = ['distinct', 'candle'];
// 自選的買／賣色（#rrggbb）；沒選（空字串）就用依主題深淺的預設色
export const CHART_FILL_BUY_KEY = 'sj-pro-chart-fill-buy';
export const CHART_FILL_SELL_KEY = 'sj-pro-chart-fill-sell';
const HEX = /^#[0-9a-f]{6}$/i;

// 進出點的顏色：藍／橘是色覺差異也分得開的一對，和 K 棒的紅綠、十字線的藍（#3d8bff／#2962ff）都不同色相。
// 淺色底用深一階、橘偏琥珀，離台股漲色 #d6213a 遠一點（ΔE2000 32，綠色盲模擬 8）；
// 在標籤底色（panelRaised #f7f8fa）上對比 5.58:1，深色組在 #10131a 上 8 以上
const FILL_PALETTE: Record<'dark' | 'light', { buy: string; sell: string }> = {
    dark: { buy: '#38bdf8', sell: '#fb923c' },
    light: { buy: '#0369a1', sell: '#8a5a00' },
};
/** #rrggbb 是不是淺色（相對亮度 > 0.5）；解析不了回 null */
export function isLightColor(hex: string): boolean | null {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const l = 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
    return l > 0.5;
}
/** 成交標記的買／賣色：同 K 棒就沿用圖表的漲跌色；否則用自選色，沒選的那一邊用依主題深淺（theme-store 的 baseMode）的預設色 */
export function chartFillColors(
    base: 'dark' | 'light', candle: { up: string; down: string }, mode: ChartFillColor, custom: { buy?: string; sell?: string } = {},
): { buy: string; sell: string } {
    if (mode === 'candle') return { buy: candle.up, sell: candle.down };
    return { buy: custom.buy || FILL_PALETTE[base].buy, sell: custom.sell || FILL_PALETTE[base].sell };
}

// 每個偏好同一套讀寫：驗證（列舉或色碼）、不合法值與讀寫失敗退回預設
function preference<T extends string>(key: string, valid: readonly T[] | RegExp, fallback: T) {
    const ok = (v: string | null): v is T => v !== null && (valid instanceof RegExp ? valid.test(v) : valid.includes(v as T));
    const read = (): T => {
        try {
            const v = localStorage.getItem(key);
            return ok(v) ? v : fallback;
        } catch {
            return fallback;
        }
    };
    let current = read();
    const listeners = new Set<() => void>();
    const emit = () => listeners.forEach((l) => l());
    try {
        window.addEventListener('storage', (e) => {
            if (e.key !== key && e.key !== null) return;
            const next = read();
            if (next !== current) {
                current = next;
                emit();
            }
        });
    } catch {
        // non-browser environment
    }
    return {
        get: () => current,
        set(v: T) {
            current = v;
            try {
                localStorage.setItem(key, v);
            } catch {
                // session only
            }
            emit();
        },
        subscribe(l: () => void): () => void {
            listeners.add(l);
            return () => {
                listeners.delete(l);
            };
        },
    };
}

const style = preference(CHART_FILL_STYLE_KEY, CHART_FILL_STYLES, 'price');
const shape = preference(CHART_FILL_SHAPE_KEY, CHART_FILL_SHAPES, 'triangle');
const scope = preference(CHART_FILL_SCOPE_KEY, CHART_FILL_SCOPES, 'active');
const color = preference(CHART_FILL_COLOR_KEY, CHART_FILL_COLORS, 'distinct');
const buy = preference<string>(CHART_FILL_BUY_KEY, HEX, '');
const sell = preference<string>(CHART_FILL_SELL_KEY, HEX, '');

export const getChartFillStyle = style.get;
export const setChartFillStyle = style.set;
export const subscribeChartFillStyle = style.subscribe;
export function useChartFillStyle(): FillMarkStyle {
    return useSyncExternalStore(style.subscribe, style.get);
}

export const setChartFillShape = shape.set;
export function useChartFillShape(): FillMarkShape {
    return useSyncExternalStore(shape.subscribe, shape.get);
}

export const getChartFillScope = scope.get;
export const setChartFillScope = scope.set;
export const subscribeChartFillScope = scope.subscribe;
export function useChartFillScope(): ChartFillScope {
    return useSyncExternalStore(scope.subscribe, scope.get);
}

export const getChartFillColor = color.get;
export const setChartFillColor = color.set;
export function useChartFillColor(): ChartFillColor {
    return useSyncExternalStore(color.subscribe, color.get);
}

/** 自選買／賣色；空字串＝回到預設色 */
export const setChartFillBuy = buy.set;
export const setChartFillSell = sell.set;
export function useChartFillBuy(): string {
    return useSyncExternalStore(buy.subscribe, buy.get);
}
export function useChartFillSell(): string {
    return useSyncExternalStore(sell.subscribe, sell.get);
}
