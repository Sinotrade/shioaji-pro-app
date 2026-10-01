// src/lib/chart-drawing-layer.ts — 把畫圖物件畫到主圖的 series primitive
//
// lightweight-charts v5 沒有線段／射線／方框這類自由物件（createPriceLine
// 只有水平線），跟 price-band 一樣用官方 plugin primitive 機制補上。
// 走 primitive 而不是另外疊一層 DOM／SVG 的理由：primitive 的 draw() 由
// 圖表自己的重繪迴圈驅動，平移縮放時不會比 K 棒慢一拍。

import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    IChartApi,
    Logical,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';
import {
    contrastTextColor,
    type Drawing,
    type DrawingAnchor,
    type DrawingStyle,
    type DrawingTool,
} from './chart-drawings';
import {
    ANCHOR_RADIUS,
    estimateBarSeconds,
    logicalOfX,
    logicalToTime,
    measureXAxis,
    projectAnchors,
    shapeOf,
    timeToLogical,
    xOfLogical,
    type PaneSize,
    type Point,
    type Projector,
} from './chart-drawing-geometry';

// 繪製中的物件（第一點已定、第二點跟著游標跑）
export interface DrawingDraft {
    tool: DrawingTool;
    anchors: DrawingAnchor[];
    style: DrawingStyle;
}

export interface DrawingLayerState {
    drawings: Drawing[];
    draft: DrawingDraft | null;
    selectedId: string | null;
    hoverId: string | null;
}

const EMPTY_STATE: DrawingLayerState = {
    drawings: [],
    draft: null,
    selectedId: null,
    hoverId: null,
};

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

function withAlpha(hex: string, alpha: number): string {
    const m = typeof hex === 'string' ? /^#([0-9a-f]{6})$/i.exec(hex.trim()) : null;
    if (!m) return hex;
    const n = parseInt(m[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

class DrawingRenderer implements IPrimitivePaneRenderer {
    constructor(private readonly _layer: DrawingLayer) {}

    draw(target: DrawTarget): void {
        const layer = this._layer;
        const projector = layer.projector();
        if (!projector) return;
        target.useBitmapCoordinateSpace((scope) => {
            // pane 的畫布就是命中判定的座標系來源 — 兩邊共用同一個
            // 元素，游標座標與畫出來的位置不可能對不上
            layer.noteCanvas(scope.context.canvas, scope.mediaSize);
            const ctx = scope.context;
            const hr = scope.horizontalPixelRatio;
            const vr = scope.verticalPixelRatio;
            const size: PaneSize = scope.mediaSize;
            const state = layer.state;

            for (const d of state.drawings) {
                if (d.hidden) continue;
                const pts = projectAnchors(projector, d.anchors);
                if (!pts) continue;
                const selected = d.id === state.selectedId;
                this._paint(ctx, hr, vr, size, d.tool, pts, d.style, selected, d.locked);
                if (selected && !d.locked) this._paintHandles(ctx, hr, vr, pts, d.style.color);
            }

            const draft = state.draft;
            if (draft) {
                const pts = projectAnchors(projector, draft.anchors);
                // 只有一個錨點的兩點工具還在等第二點 — 先畫控制點就好
                if (pts && pts.length === draft.anchors.length) {
                    if (pts.length >= 2 || draft.tool === 'horizontal') {
                        this._paint(ctx, hr, vr, size, draft.tool, pts, draft.style, false, false);
                    }
                    this._paintHandles(ctx, hr, vr, pts, draft.style.color);
                }
            }
        });
    }

    private _paint(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        size: PaneSize,
        tool: DrawingTool,
        pts: Point[],
        style: DrawingStyle,
        selected: boolean,
        locked: boolean,
    ): void {
        const shape = shapeOf(tool, pts, size);
        if (!shape) return;
        ctx.save();
        ctx.strokeStyle = style.color;
        // 選取中加粗一點當作視覺回饋；鎖定的物件畫淡一些
        ctx.lineWidth = (style.width + (selected ? 1 : 0)) * hr;
        // 鎖定的物件畫淡一些表示「不會被拖到」；但選取中要看得清楚
        // （選它通常就是為了解鎖或改樣式），所以選取時不淡化
        ctx.globalAlpha = locked && !selected ? 0.55 : 1;
        ctx.setLineDash(style.dash === 'dashed' ? [6 * hr, 4 * hr] : []);
        if (shape.kind === 'line') {
            ctx.beginPath();
            ctx.moveTo(shape.a.x * hr, shape.a.y * vr);
            ctx.lineTo(shape.b.x * hr, shape.b.y * vr);
            ctx.stroke();
        } else {
            const x = shape.left * hr;
            const y = shape.top * vr;
            const w = (shape.right - shape.left) * hr;
            const h = (shape.bottom - shape.top) * vr;
            if (style.fillOpacity > 0) {
                ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
                ctx.fillRect(x, y, w, h);
            }
            ctx.strokeRect(x, y, w, h);
        }
        ctx.restore();
    }

    private _paintHandles(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        pts: Point[],
        color: string,
    ): void {
        ctx.save();
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5 * hr;
        ctx.strokeStyle = color;
        ctx.fillStyle = '#ffffff';
        for (const p of pts) {
            ctx.beginPath();
            ctx.arc(p.x * hr, p.y * vr, ANCHOR_RADIUS * hr, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }
}

class DrawingPaneView implements IPrimitivePaneView {
    constructor(private readonly _layer: DrawingLayer) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'top'; // 畫在 K 棒之上 — 壓力線被 K 棒蓋住就沒意義了
    }
    renderer(): IPrimitivePaneRenderer {
        return new DrawingRenderer(this._layer);
    }
}

// 水平線在價格軸上的色塊標籤 — 線是什麼顏色，標籤就是什麼顏色，一眼
// 看得出這個價位屬於哪一條線。
//
// 自己畫在價格軸上（priceAxisPaneViews），不用 lightweight-charts 的
// priceAxisViews：後者會加入函式庫的標籤防重疊，標籤被連鎖推到別的價位，
// 我們不知道它最後在哪 — 委託線的拖曳判斷就可能把「拖畫圖標籤」當成
// 「拖委託標籤」而送出改價。自己畫就固定在線的價位上，範圍確切已知
// （axisLabelRects），委託線拖曳時排除這些範圍。
export const AXIS_LABEL_H = 18; // 標籤高度（px）
const AXIS_LABEL_FONT_PX = 11;

// 標籤色塊的範圍（CSS px，整數邊）。繪製與命中判定共用同一個矩形，
// 畫出來的邊和保護範圍一致（不會畫在 22、保護卻從 22.49 開始）
export function axisLabelBox(y: number): { top: number; bottom: number } {
    return { top: Math.floor(y - AXIS_LABEL_H / 2), bottom: Math.ceil(y + AXIS_LABEL_H / 2) };
}

// 委託線拖曳時要排除的範圍：色塊再往外各多 1 CSS px（涵蓋高 DPR 的
// 像素取整與邊緣抗鋸齒）
export const AXIS_LABEL_GUARD_PX = 1;

export interface AxisLabelRow {
    y: number; // pane 座標（與價格軸同一個垂直座標系）
    text: string;
    color: string;
}

class DrawingAxisRenderer implements IPrimitivePaneRenderer {
    constructor(private readonly _rows: AxisLabelRow[]) {}
    draw(target: DrawTarget): void {
        target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const hr = scope.horizontalPixelRatio;
            const vr = scope.verticalPixelRatio;
            const width = scope.mediaSize.width;
            ctx.save();
            ctx.font = `${AXIS_LABEL_FONT_PX * vr}px sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            for (const r of this._rows) {
                const box = axisLabelBox(r.y);
                const top = Math.round(box.top * vr);
                const bottom = Math.round(box.bottom * vr);
                ctx.fillStyle = r.color;
                ctx.fillRect(0, top, Math.round(width * hr), bottom - top);
                ctx.fillStyle = contrastTextColor(r.color);
                ctx.fillText(r.text, 5 * hr, r.y * vr);
            }
            ctx.restore();
        });
    }
}

class DrawingAxisPaneView implements IPrimitivePaneView {
    constructor(private readonly _layer: DrawingLayer) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'top'; // 蓋在函式庫的標籤之上 — 畫圖標籤按得到的地方就是看得到的地方
    }
    renderer(): IPrimitivePaneRenderer {
        return new DrawingAxisRenderer(this._layer.axisLabelRows());
    }
}

export class DrawingLayer implements ISeriesPrimitive<Time> {
    state: DrawingLayerState = EMPTY_STATE;
    paneSize: PaneSize = { width: 0, height: 0 };
    private _series: ISeriesApi<SeriesType> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private readonly _views: DrawingPaneView[];
    private readonly _axisPaneViews: DrawingAxisPaneView[];
    // 棒距估計要排序全部 K 棒間距 — 依時間陣列（資料變更才換新陣列）
    // 快取，滑鼠事件與每幀重繪都不重算
    private _barTimes: number[] | null = null;
    private _barSeconds = 60;

    // getTimes：目前圖上 K 棒的時間陣列（遞增）。切換週期／載入更舊的
    // 歷史都會換一份，所以用 callback 每次重讀，不快照。
    constructor(private readonly _getTimes: () => number[]) {
        this._views = [new DrawingPaneView(this)];
        this._axisPaneViews = [new DrawingAxisPaneView(this)];
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this._series = param.series;
        this._chart = param.chart;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._chart = null;
        this._requestUpdate = null;
        this._canvas = null;
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }

    // 只有水平線有標籤：斜線與方框沒有單一價位可標，硬標一個（例如端點）
    // 反而會在拖曳時跳來跳去。繪製中的水平線也標，跟游標十字線一樣即時。
    axisLabelRows(): AxisLabelRow[] {
        const series = this._series;
        if (!series) return [];
        const rows: { price: number; color: string }[] = [];
        for (const d of this.state.drawings) {
            if (d.tool !== 'horizontal' || d.hidden || !d.anchors[0]) continue;
            rows.push({ price: d.anchors[0].price, color: d.style.color });
        }
        const draft = this.state.draft;
        if (draft?.tool === 'horizontal' && draft.anchors[0]) {
            rows.push({ price: draft.anchors[0].price, color: draft.style.color });
        }
        const out: AxisLabelRow[] = [];
        for (const r of rows) {
            const y = series.priceToCoordinate(r.price);
            if (y === null) continue;
            out.push({ y, text: this.formatAxis(r.price), color: r.color });
        }
        return out;
    }

    // 畫圖標籤在價格軸上的確切範圍（pane 座標）：委託線拖曳判斷要排除
    axisLabelRects(): { top: number; bottom: number }[] {
        return this.axisLabelRows().map((r) => {
            const box = axisLabelBox(r.y);
            return { top: box.top - AXIS_LABEL_GUARD_PX, bottom: box.bottom + AXIS_LABEL_GUARD_PX };
        });
    }

    priceAxisPaneViews(): readonly IPrimitivePaneView[] {
        return this._axisPaneViews;
    }

    // 價格軸標籤的文字
    formatAxis = (price: number): string => {
        const series = this._series;
        return series ? series.priceFormatter().format(price) : String(price);
    };

    setState(state: DrawingLayerState): void {
        this.state = state;
        this._requestUpdate?.();
    }

    noteCanvas(canvas: HTMLCanvasElement, size: PaneSize): void {
        this._canvas = canvas;
        this.paneSize = size;
    }

    barSecondsOf(times: number[]): number {
        if (times !== this._barTimes) {
            this._barTimes = times;
            this._barSeconds = estimateBarSeconds(times);
        }
        return this._barSeconds;
    }

    // 把滑鼠事件換算成 pane 內座標；pane 畫布尚未建立時回 null
    pointOf(ev: { clientX: number; clientY: number }): Point | null {
        const canvas = this._canvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    // 時間／價格 ↔ 畫面座標。時間方向刻意繞過 timeToCoordinate() 與
    // logicalToCoordinate()：前者只認 K 棒格點上的時間，後者只認整數
    // logical（小數一律回 0＝pane 左緣），錨點落在別的週期或棒與棒之間
    // 就會消失或被釘在畫面最左邊。改成自己量出 logical→x 的線性映射。
    projector(): Projector | null {
        const series = this._series;
        const chart = this._chart;
        if (!series || !chart) return null;
        const timeScale = chart.timeScale();
        const times = this._getTimes();
        const bar = this.barSecondsOf(times);
        // 一幀內時間軸不會動 — 量一次給下面兩個方向共用
        const axis = measureXAxis((logical) => timeScale.logicalToCoordinate(logical as Logical));
        return {
            xOfTime: (time) => {
                if (!times.length || !axis) return null;
                const logical = timeToLogical(times, bar, time);
                if (!Number.isFinite(logical)) return null;
                return xOfLogical(axis, logical);
            },
            yOfPrice: (price) => series.priceToCoordinate(price),
            timeOfX: (x) => {
                if (!times.length || !axis) return null;
                return logicalToTime(times, bar, logicalOfX(axis, x));
            },
            priceOfY: (y) => {
                const p = series.coordinateToPrice(y);
                return p === null ? null : Number(p);
            },
        };
    }
}
