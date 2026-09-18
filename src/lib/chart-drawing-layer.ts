// src/lib/chart-drawing-layer.ts — 把畫圖物件畫到主圖的 series primitive
//
// lightweight-charts v5 沒有線段／射線／方框這類自由物件（createPriceLine
// 只有水平線），跟 price-band 一樣用官方 plugin primitive 機制補上。
// 走 primitive 而不是另外疊一層 DOM／SVG 的理由：primitive 的 draw() 由
// 圖表自己的重繪迴圈驅動，平移縮放時不會比 K 棒慢一拍。

import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesPrimitiveAxisView,
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
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
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

// 水平線在價格軸上的色塊標籤 — 與現價游標、委託單價格線同一種呈現，
// 線是什麼顏色，標籤就是什麼顏色，一眼看得出這個價位屬於哪一條線。
//
// 物件本身可變（座標每次重繪都在動）：lightweight-charts 用陣列 reference
// 當快取鍵，每次都 new 一批會讓它每幀重建標籤，所以只在「有哪些線」變了
// 的時候換陣列，座標就地更新。
class DrawingAxisView implements ISeriesPrimitiveAxisView {
    y = 0;
    label = '';
    color = '#ffffff';
    ok = false; // 價位在可視範圍外時 priceToCoordinate 會回 null
    coordinate(): number {
        return this.y;
    }
    text(): string {
        return this.label;
    }
    textColor(): string {
        return contrastTextColor(this.color);
    }
    backColor(): string {
        return this.color;
    }
    visible(): boolean {
        return this.ok;
    }
}

const NO_AXIS_VIEWS: readonly ISeriesPrimitiveAxisView[] = [];

export class DrawingLayer implements ISeriesPrimitive<Time> {
    state: DrawingLayerState = EMPTY_STATE;
    paneSize: PaneSize = { width: 0, height: 0 };
    private _series: ISeriesApi<SeriesType> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private readonly _views: DrawingPaneView[];
    private _axisViews: DrawingAxisView[] = [];
    private _axisKey = '';

    // getTimes：目前圖上 K 棒的時間陣列（遞增）。切換週期／載入更舊的
    // 歷史都會換一份，所以用 callback 每次重讀，不快照。
    constructor(private readonly _getTimes: () => number[]) {
        this._views = [new DrawingPaneView(this)];
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
        this._axisViews = [];
        this._axisKey = '';
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }

    // 只有水平線有標籤：斜線與方框沒有單一價位可標，硬標一個（例如端點）
    // 反而會在拖曳時跳來跳去。繪製中的水平線也標，跟游標十字線一樣即時。
    priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
        const series = this._series;
        if (!series) return NO_AXIS_VIEWS;
        const rows: { id: string; price: number; color: string }[] = [];
        for (const d of this.state.drawings) {
            if (d.tool !== 'horizontal' || d.hidden) continue;
            const price = d.anchors[0]?.price;
            if (price === undefined) continue;
            rows.push({ id: d.id, price, color: d.style.color });
        }
        const draft = this.state.draft;
        if (draft?.tool === 'horizontal') {
            const price = draft.anchors[0]?.price;
            if (price !== undefined) {
                rows.push({ id: 'draft', price, color: draft.style.color });
            }
        }
        if (!rows.length) {
            this._axisKey = '';
            this._axisViews = [];
            return NO_AXIS_VIEWS;
        }
        // 價格不進 key：改價時標籤文字跟著 format 出來就好，不必換陣列
        const key = rows.map((r) => `${r.id}|${r.color}`).join(';');
        if (key !== this._axisKey) {
            this._axisKey = key;
            this._axisViews = rows.map(() => new DrawingAxisView());
        }
        const formatter = series.priceFormatter();
        rows.forEach((r, i) => {
            const view = this._axisViews[i]!;
            const y = series.priceToCoordinate(r.price);
            view.ok = y !== null;
            view.y = y ?? 0;
            view.label = formatter.format(r.price);
            view.color = r.color;
        });
        return this._axisViews;
    }

    setState(state: DrawingLayerState): void {
        this.state = state;
        this._requestUpdate?.();
    }

    noteCanvas(canvas: HTMLCanvasElement, size: PaneSize): void {
        this._canvas = canvas;
        this.paneSize = size;
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
        const bar = estimateBarSeconds(times);
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
