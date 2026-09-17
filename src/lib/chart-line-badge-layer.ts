// src/lib/chart-line-badge-layer.ts — 把價格線的操作標籤畫到主圖
//
// 跟 chart-drawing-layer 同一套做法（series primitive）。用 primitive 而不是
// 疊一層 DOM 的理由一樣：draw() 由圖表自己的重繪迴圈驅動，拖曳與縮放時
// 標籤不會比線慢一拍。
//
// 版面完全交給 chart-line-badges 的純函式算，這裡只負責畫，並把算好的
// BadgeBox 留給滑鼠事件做命中判定 — 畫的與點的是同一份座標。

import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';
import { contrastTextColor } from './chart-drawings';
import {
    layoutBadges,
    type BadgeBox,
    type BadgeRect,
    type BadgeSpec,
    type Point,
} from './chart-line-badges';

const FONT_PX = 10;
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
// 量寬度用 media px、畫的時候用 bitmap px；兩邊同一個字型只是尺度不同，
// 分開寫死很容易改了一邊忘了另一邊
const fontAt = (px: number) => `${px}px ${FONT_FAMILY}`;

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

class BadgeRenderer implements IPrimitivePaneRenderer {
    constructor(private readonly _layer: LineBadgeLayer) {}

    draw(target: DrawTarget): void {
        const layer = this._layer;
        const series = layer.series;
        if (!series) return;
        target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const hr = scope.horizontalPixelRatio;
            const vr = scope.verticalPixelRatio;
            ctx.save();
            ctx.font = fontAt(FONT_PX);
            const boxes = layoutBadges(layer.specs, {
                paneWidth: scope.mediaSize.width,
                yOf: (price) => series.priceToCoordinate(price),
                measureText: (text) => ctx.measureText(text).width,
            });
            // 記下畫布與算好的版面，滑鼠事件才有同一份座標可用
            layer.noteFrame(ctx.canvas, boxes);
            for (const box of boxes) this._paint(ctx, hr, vr, box);
            ctx.restore();
        });
    }

    private _paint(ctx: CanvasRenderingContext2D, hr: number, vr: number, box: BadgeBox): void {
        const { rect, spec } = box;
        const fg = contrastTextColor(spec.color);
        ctx.fillStyle = spec.color;
        const x = rect.x * hr;
        const y = rect.y * vr;
        const w = rect.w * hr;
        const h = rect.h * vr;
        if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, 2 * hr);
            ctx.fill();
        } else {
            // 舊版 WebKit 沒有 roundRect — 圓角是裝飾，方角照樣能用
            ctx.fillRect(x, y, w, h);
        }

        ctx.fillStyle = fg;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = fontAt(FONT_PX * Math.min(hr, vr));
        ctx.fillText(spec.text, box.textX * hr, (rect.y + rect.h / 2) * vr);

        if (box.drag) this._paintGrip(ctx, hr, vr, box.drag, fg);
        if (box.close) this._paintCross(ctx, hr, vr, box.close, fg);
    }

    // 六個點的握把 — 跟系統拖曳握把同一個視覺語彙，一眼看得出可以上下拖
    private _paintGrip(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        r: BadgeRect,
        color: string,
    ): void {
        ctx.fillStyle = color;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        for (const dx of [-2, 2]) {
            for (const dy of [-3, 0, 3]) {
                ctx.fillRect((cx + dx - 0.75) * hr, (cy + dy - 0.75) * vr, 1.5 * hr, 1.5 * vr);
            }
        }
    }

    private _paintCross(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        r: BadgeRect,
        color: string,
    ): void {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const a = 3;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2 * hr;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo((cx - a) * hr, (cy - a) * vr);
        ctx.lineTo((cx + a) * hr, (cy + a) * vr);
        ctx.moveTo((cx + a) * hr, (cy - a) * vr);
        ctx.lineTo((cx - a) * hr, (cy + a) * vr);
        ctx.stroke();
        ctx.restore();
    }
}

class BadgePaneView implements IPrimitivePaneView {
    constructor(private readonly _layer: LineBadgeLayer) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'top';
    }
    renderer(): IPrimitivePaneRenderer {
        return new BadgeRenderer(this._layer);
    }
}

export class LineBadgeLayer implements ISeriesPrimitive<Time> {
    specs: readonly BadgeSpec[] = [];
    boxes: readonly BadgeBox[] = [];
    series: ISeriesApi<SeriesType> | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private readonly _views: BadgePaneView[];

    constructor() {
        this._views = [new BadgePaneView(this)];
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this.series = param.series;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this.series = null;
        this._requestUpdate = null;
        this._canvas = null;
        this.boxes = [];
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }

    setSpecs(specs: readonly BadgeSpec[]): void {
        this.specs = specs;
        this._requestUpdate?.();
    }

    noteFrame(canvas: HTMLCanvasElement, boxes: BadgeBox[]): void {
        this._canvas = canvas;
        this.boxes = boxes;
    }

    // 滑鼠事件 → pane 內座標；pane 尚未畫過時回 null
    pointOf(ev: { clientX: number; clientY: number }): Point | null {
        const canvas = this._canvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }
}
