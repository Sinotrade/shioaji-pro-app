// src/lib/chart-fill-prefs.ts — K 線成交標記的全域偏好（圖表設定的「成交標記」頁：樣式、顏色、帳戶範圍；不畫是各圖自己的面板設定）
//
// 樣式（FillMarkStyle）：dot 三角形／side 買賣／price 價格（預設）
// 顏色（ChartFillColor）：distinct 藍買橘賣（預設）／candle 同 K 棒
// 帳戶範圍：active 目前帳戶（預設）／all 同一市場的全部帳戶
// 圖表可能在彈出視窗、設定在主視窗改 — 以同源 storage 事件同步其他視窗

import { useSyncExternalStore } from 'react';
import type { FillMarkStyle } from './chart-fill-marks';

export type ChartFillScope = 'active' | 'all';
/** distinct：藍買橘賣，和 K 棒的紅綠分得開（預設）；candle：跟 K 棒同色 */
export type ChartFillColor = 'distinct' | 'candle';

export const CHART_FILL_STYLE_KEY = 'sj-pro-chart-fill-style';
export const CHART_FILL_STYLES: FillMarkStyle[] = ['dot', 'side', 'price'];
export const CHART_FILL_SCOPE_KEY = 'sj-pro-chart-fill-scope';
export const CHART_FILL_SCOPES: ChartFillScope[] = ['active', 'all'];
export const CHART_FILL_COLOR_KEY = 'sj-pro-chart-fill-color';
export const CHART_FILL_COLORS: ChartFillColor[] = ['distinct', 'candle'];

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
/** 成交標記的買／賣色：獨立色依主題深淺（theme-store 的 baseMode）；同 K 棒就沿用圖表的漲跌色 */
export function chartFillColors(base: 'dark' | 'light', candle: { up: string; down: string }, mode: ChartFillColor): { buy: string; sell: string } {
    return mode === 'candle' ? { buy: candle.up, sell: candle.down } : FILL_PALETTE[base];
}

// 三個偏好同一套讀寫：列舉驗證、不合法值與讀寫失敗退回預設
function preference<T extends string>(key: string, values: readonly T[], fallback: T) {
    const read = (): T => {
        try {
            const v = localStorage.getItem(key);
            return values.includes(v as T) ? (v as T) : fallback;
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
const scope = preference(CHART_FILL_SCOPE_KEY, CHART_FILL_SCOPES, 'active');
const color = preference(CHART_FILL_COLOR_KEY, CHART_FILL_COLORS, 'distinct');

export const getChartFillStyle = style.get;
export const setChartFillStyle = style.set;
export const subscribeChartFillStyle = style.subscribe;
export function useChartFillStyle(): FillMarkStyle {
    return useSyncExternalStore(style.subscribe, style.get);
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
