// src/lib/day-range.ts：個股看板的日內區間軌，今天的日 K（開高低收）放在以參考價為中心的尺上。
// 尺預設 ±1%（指數期 ±2.5%），今天的波動超過就依序放大，最大用到漲跌停（大型股平常日只動零點幾 %，
// 尺直接畫到漲跌停的話整條軌幾乎是空的）。尺內是線性，影線長短可以直接比較。
// 這裡只放不依賴 DOM 的計算，畫面在 components/day-range-rail。

import { fmtPct } from './utils/format';

export interface DayRange {
    reference: number;
    limitUp: number;
    limitDown: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

// 尺的半寬（%）依序嘗試；今天最大偏離要落在尺的 92% 以內，兩端留一點邊。
// 指數期（台指期等）平常振幅約 ±1%，尺從 ±2.5% 起跳，大行情才放大（使用者指定）；個股期照個股
export const STOCK_SCALES: readonly number[] = [1, 2, 3, 5, 7];
export const INDEX_FUTURE_SCALES: readonly number[] = [2.5, 5, 7.5];
const SCALE_FILL = 0.92;

// 任一值缺席、不是有限數、<= 0，或漲跌停、高低不合理時回傳 undefined：不畫軌，看板維持數字欄
export function dayRangeOf(v: { [K in keyof DayRange]?: number }): DayRange | undefined {
    const r = {} as DayRange;
    for (const k of ['reference', 'limitUp', 'limitDown', 'open', 'high', 'low', 'close'] as const) {
        const n = v[k];
        if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
        r[k] = n;
    }
    if (r.limitDown >= r.reference || r.limitUp <= r.reference || r.low > r.high) return undefined;
    return r;
}

// 參考價到較近一側停板的距離（%）
function limitPctOf(r: Pick<DayRange, 'reference' | 'limitUp' | 'limitDown'>): number {
    return (Math.min(r.limitUp - r.reference, r.reference - r.limitDown) / r.reference) * 100;
}

// 尺的半寬（%）；null 表示直接用到漲跌停（今天的波動已接近停板幅度）
export function railScale(r: DayRange, scales: readonly number[] = STOCK_SCALES): number | null {
    const maxMove = Math.max(...[r.open, r.high, r.low, r.close].map((v) => Math.abs(v - r.reference)));
    const movePct = (maxMove / r.reference) * 100;
    const limitPct = limitPctOf(r);
    return scales.find((s) => s < limitPct && movePct <= SCALE_FILL * s) ?? null;
}

// 軌道兩端標的幅度（%）：有尺時是尺的半寬，用到漲跌停時是兩側停板幅度（四捨五入到整數）
export function railEndPcts(r: DayRange, scale: number | null): [number, number] {
    if (scale !== null) return [scale, scale];
    const pct = (d: number) => Math.round((d / r.reference) * 100);
    return [pct(r.reference - r.limitDown), pct(r.limitUp - r.reference)];
}

// 高、低跟開盤價比決定顏色（使用者指定）：高於開盤是漲色、低於開盤是跌色、相等不上色
export function dirVsOpen(v: number | undefined, open: number | undefined): 'up' | 'down' | null {
    if (v === undefined || open === undefined || !Number.isFinite(v) || !Number.isFinite(open) || v === open) return null;
    return v > open ? 'up' : 'down';
}

// 0（左端）到 1（右端），參考價在 0.5。有尺時線性、超出就貼在兩端；
// 沒有尺時兩側各自線性對到漲跌停（漲跌停距離不對稱時兩側比例不同）
export function railPos(price: number, r: DayRange, scale: number | null): number {
    const d = price - r.reference;
    const p =
        scale !== null
            ? ((d / r.reference) * 100) / scale
            : d >= 0
              ? d / (r.limitUp - r.reference)
              : d / (r.reference - r.limitDown);
    return 0.5 + 0.5 * Math.max(-1, Math.min(1, p));
}

const tickStep = (scale: number) => (scale <= 1 ? 0.5 : 1);

// 刻度的價格（不含參考價本身）：±1% 的尺每 0.5% 一格，其餘每 1% 一格；用到漲跌停時標 ±1%、±5%
export function railTicks(r: DayRange, scale: number | null): number[] {
    let pcts: number[];
    if (scale === null) {
        const limitPct = limitPctOf(r);
        pcts = [-5, -1, 1, 5].filter((k) => Math.abs(k) < limitPct);
    } else {
        // 落在格線上（±2.5% 的尺標 ±1、±2，不會出現 ±1.5）
        const step = tickStep(scale);
        pcts = [];
        for (let k = step; k < scale - 1e-9; k += step) pcts.push(-k, k);
        pcts.sort((a, b) => a - b);
    }
    return pcts.map((k) => r.reference * (1 + k / 100));
}

// 滑過提示：開高低與平盤價（軌道變窄時數字列會收起，這裡一定看得到）、看板上沒有的資訊，以及粗細兩段怎麼看
export function railTitle(r: DayRange, scale: number | null, fmt: (v: number) => string): string {
    const pct = (to: number, from: number) => fmtPct(((to - from) / from) * 100);
    const kind = r.close > r.open ? '陽線' : r.close < r.open ? '陰線' : '十字線';
    const ruler = scale === null ? '刻度到漲跌停' : `刻度 ±${scale}%，每格 ${tickStep(scale)}%`;
    return (
        `開 ${fmt(r.open)}｜高 ${fmt(r.high)}｜低 ${fmt(r.low)}｜平盤 ${fmt(r.reference)}\n` +
        `較開盤 ${pct(r.close, r.open)}（${kind}）｜距漲停 ${pct(r.limitUp, r.close)}｜距跌停 ${pct(r.limitDown, r.close)}｜${ruler}\n` +
        '粗段：開盤到現價｜細段：今日最低到最高'
    );
}

// railMid、railLow 數字列收起格子的門檻依實際字數算（低、開、高最長的那個，3 到 10 字；
// 500 到 999 元的個股跳動 1 元，價格只有 3 字）。
// 一格寬＝標籤（0.62rem 中文一字加 0.3rem 右距）＋數值（0.72rem 等寬字，每字 0.6em）；格距 0.9rem；
// 再留 0.25rem 給字型差異。實測 5 字一格 3.08rem、6 字 3.512rem，與公式相同。
// 連動 quote-board.css.ts：標籤字級在 pairLabel、右距在 railNumLabel、數值字級在 railNumbers、格距在 railCells，
// 改任何一個都要一起改這裡
export const RAIL_CHARS: readonly number[] = [3, 4, 5, 6, 7, 8, 9, 10];

export function railChars(values: readonly string[]): number {
    const n = Math.max(...values.map((v) => v.length));
    return Math.min(RAIL_CHARS[RAIL_CHARS.length - 1]!, Math.max(RAIL_CHARS[0]!, n));
}

export function railCellsRem(cells: number, chars: number): number {
    return cells * (0.62 + 0.3 + chars * 0.72 * 0.6) + (cells - 1) * 0.9 + 0.25;
}
