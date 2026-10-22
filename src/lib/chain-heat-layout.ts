// src/lib/chain-heat-layout.ts — 族群與成分股熱力：依成交值決定 tile 面積
//
// 面積＝今日成交值（族群為成分股加總、成分股為個股），顏色仍是近 N 分鐘
// 淨流入占成交值。成交值在盤中只增不減，版面每分鐘只微調；|淨流入| 會
// 在 0 附近翻正負，拿來當面積會讓 tile 忽大忽小，方向又已由顏色表達。
//
// 版面沿用產業全景的 heat-layout：帶遲滯的排序（stableOrder）＋對半二分
// （binarySplit，含切點記憶）＋整數化扣間隙（snapRect）；標籤沿用
// heat-label 的字級階梯。

import { fitHeatLabel, type HeatLabelFit } from './heat-label';
import { binarySplit, type Rect, snapRect, type SplitMemo, stableOrder } from './heat-layout';

/** tile 之間的間隙（px）；這個面板的 tile 有圓角與邊框，比全景的 1px 寬。 */
export const HEAT_TILE_GAP = 3;
/** 最小面積占最大者的比例：成交值極小的族群仍留一塊點得到的 tile。 */
export const HEAT_MIN_SHARE = 0.015;

/**
 * 面積權重：成交值，下限為最大者的 HEAT_MIN_SHARE；全部為 0（開盤前、
 * 尚未收到任何成交）時每塊等大。
 */
export function heatTileWeights(values: readonly number[]): number[] {
    const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
    const max = Math.max(0, ...clean);
    if (max <= 0) return clean.map(() => 1);
    const floor = max * HEAT_MIN_SHARE;
    return clean.map((v) => Math.max(v, floor));
}

export interface HeatLayoutMemo {
    scope: string;
    order: string[];
    split: SplitMemo;
}

export const emptyHeatMemo = (): HeatLayoutMemo => ({ scope: '', order: [], split: new Map() });

/**
 * 依成交值切出 tile 矩形（整數、已扣間隙）。回傳新的記憶，下一次版面
 * 以它為底：排序要差超過 15 % 才換位、切點與方向只在明顯失衡時才改，
 * 每分鐘更新時 tile 只會微調大小。scope 變了（換族群）記憶歸零。
 */
export function layoutHeatTiles(
    items: readonly { key: string; value: number }[],
    width: number,
    height: number,
    memo: HeatLayoutMemo,
    scope: string,
): { rects: Map<string, Rect>; memo: HeatLayoutMemo } {
    const base = memo.scope === scope ? memo : emptyHeatMemo();
    const rects = new Map<string, Rect>();
    if (width <= 0 || height <= 0 || items.length === 0) {
        return { rects, memo: { ...base, scope } };
    }
    const weights = heatTileWeights(items.map((item) => item.value));
    const weighted = items.map((item, i) => ({ key: item.key, weight: weights[i]! }));
    const order = stableOrder(base.order, weighted);
    const byKey = new Map(weighted.map((item) => [item.key, item]));
    const split: SplitMemo = new Map();
    const raw = binarySplit(
        order.map((key) => byKey.get(key)!),
        { x: 0, y: 0, w: width + HEAT_TILE_GAP, h: height + HEAT_TILE_GAP },
        base.split,
        split,
    );
    for (const key of order) {
        const r = raw.get(key);
        if (!r) continue;
        const rect = snapRect(r, HEAT_TILE_GAP);
        if (rect.w > 0 && rect.h > 0) rects.set(key, rect);
    }
    return { rects, memo: { scope, order, split } };
}

export interface HeatTileContent {
    fit: HeatLabelFit;
    /** 淨流入金額那一行 */
    showValue: boolean;
    /** 底部逐分成交值細條 */
    showBars: boolean;
}

/** 依 tile 大小決定要畫哪些內容：名稱＋漲跌 → 淨流入 → 逐分細條。 */
export function heatTileContent(
    width: number,
    height: number,
    name: string,
    pctText: string | null,
    code?: string,
): HeatTileContent {
    const fit = fitHeatLabel(width, height, name, pctText, code);
    const lines = fit.mode === 'both' ? 2.3 : 1.2;
    const labelH = fit.fontSize * lines + 8;
    const showValue = fit.mode === 'both' && height >= labelH + fit.fontSize * 1.2 + 6;
    const used = labelH + (showValue ? fit.fontSize * 1.2 : 0);
    const showBars = fit.mode !== 'none' && width >= 56 && height >= used + 18;
    return { fit, showValue, showBars };
}
