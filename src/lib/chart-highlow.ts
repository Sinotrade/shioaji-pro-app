// src/lib/chart-highlow.ts — K 線圖可見範圍最高／最低標記（issue #240）
//
// 目前畫面上看得到的 K 棒中，最高價那根的上影線頂端標「最高 xxx」、
// 最低價那根的下影線底端標「最低 xxx」，平移縮放時跟著重算。
//
// 用 series primitive 畫（跟畫圖物件同一套機制）：draw() 由圖表自己的
// 重繪迴圈驅動，平移、縮放、拖價格軸都不會慢一拍，也不必另外監聽事件。
// 只畫在主圖 pane 上、不吃滑鼠事件，不影響點價與畫圖工具。

import type {
    IChartApi,
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';

export interface HighLowBar {
    high: number;
    low: number;
}

export interface HighLowHit {
    index: number;
    price: number;
}

/**
 * 可見範圍（logical index，可為小數、可超出資料範圍）內的最高與最低。
 * 同價取最新的一根（離現在最近、最常被關注）。少於 2 根不標。
 */
export function visibleHighLow(
    barAt: (logical: number) => HighLowBar | null | undefined,
    from: number,
    to: number,
): { high: HighLowHit; low: HighLowHit } | null {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    // 與 lightweight-charts 一致：邊緣只露出一部分的 K 棒也算看得到
    const start = Math.max(0, Math.floor(Math.min(from, to)));
    const end = Math.ceil(Math.max(from, to));
    let hi: HighLowHit | null = null;
    let lo: HighLowHit | null = null;
    let count = 0;
    for (let i = start; i <= end; i += 1) {
        const b = barAt(i);
        if (!b || !Number.isFinite(b.high) || !Number.isFinite(b.low)) continue;
        count += 1;
        if (!hi || b.high >= hi.price) hi = { index: i, price: b.high };
        if (!lo || b.low <= lo.price) lo = { index: i, price: b.low };
    }
    if (count < 2 || !hi || !lo) return null;
    return { high: hi, low: lo };
}

/** 陣列版（測試與純資料使用）：logical index = 陣列位置 */
export const barsAt = (bars: readonly HighLowBar[]) => (i: number) => bars[i];

// 版面常數（CSS px）
export const MARK_LEADER_PX = 10; // 影線端點到標籤的引線長度
export const MARK_GAP_PX = 3; // 引線與 K 棒之間留白
export const MARK_LABEL_H = 16;
export const MARK_PAD_X = 5;
export const MARK_EDGE_PX = 4; // 標籤與 pane 邊緣的最小距離

export interface MarkLayout {
    /** 標籤朝右（在 K 棒右邊）或朝左 */
    side: 'right' | 'left';
    /** 引線起點、終點（x）與 y */
    leaderFrom: number;
    leaderTo: number;
    /** 標籤左上角與大小 */
    boxX: number;
    boxY: number;
    boxW: number;
    boxH: number;
    /** 引線的 y（影線端點，可能因夾在 pane 內而與標籤中心不同） */
    tipY: number;
}

/**
 * 標籤位置：預設放在 K 棒右邊（引線向右），右邊放不下就放左邊；
 * 垂直以影線端點為中心，超出 pane 時夾回來（引線仍指向端點）。
 */
export function layoutMark(
    x: number,
    tipY: number,
    labelWidth: number,
    pane: { width: number; height: number },
    labelCenterY = tipY,
): MarkLayout {
    const boxW = Math.ceil(labelWidth + MARK_PAD_X * 2);
    const boxH = MARK_LABEL_H;
    const rightStart = x + MARK_GAP_PX;
    const fitsRight = rightStart + MARK_LEADER_PX + boxW <= pane.width - MARK_EDGE_PX;
    const side: 'right' | 'left' = fitsRight || x < pane.width / 2 ? 'right' : 'left';
    const leaderFrom = side === 'right' ? x + MARK_GAP_PX : x - MARK_GAP_PX;
    const leaderTo = side === 'right' ? leaderFrom + MARK_LEADER_PX : leaderFrom - MARK_LEADER_PX;
    let boxX = side === 'right' ? leaderTo : leaderTo - boxW;
    boxX = Math.max(MARK_EDGE_PX, Math.min(boxX, pane.width - MARK_EDGE_PX - boxW));
    const minY = MARK_EDGE_PX;
    const maxY = Math.max(minY, pane.height - MARK_EDGE_PX - boxH);
    const boxY = Math.max(minY, Math.min(labelCenterY - boxH / 2, maxY));
    return { side, leaderFrom, leaderTo, boxX, boxY, boxW, boxH, tipY };
}

export interface HighLowStyle {
    visible: boolean;
    /** 最高標記色（台灣慣例 = 紅／漲色） */
    highColor: string;
    /** 最低標記色（台灣慣例 = 綠／跌色） */
    lowColor: string;
    /** 標籤底色（圖表標籤底色）與外框 */
    labelBg: string;
    border: string;
    /** 「最高」「最低」字樣 */
    mutedText: string;
    format: (price: number) => string;
}

const FONT_VALUE = "600 10px 'JetBrains Mono', monospace";
const FONT_WORD = '10px sans-serif';

interface DrawTarget {
    useMediaCoordinateSpace<T>(f: (scope: {
        context: CanvasRenderingContext2D;
        mediaSize: { width: number; height: number };
    }) => T): T;
}

interface MarkSpec {
    word: string;
    value: string;
    color: string;
    x: number;
    y: number;
    /** 標籤中心 y（最高最低很接近時錯開，不疊在一起） */
    labelY: number;
}

/** 兩個標籤框（版面已夾回 pane 之後）若重疊，把最低往下、放不下就把最高往上 */
type MarkBox = Pick<MarkLayout, 'boxX' | 'boxY' | 'boxW' | 'boxH'>;
export function resolveOverlap(high: MarkBox, low: MarkBox, paneHeight: number): void {
    const xOverlap = high.boxX < low.boxX + low.boxW && low.boxX < high.boxX + high.boxW;
    if (!xOverlap) return;
    const gap = 2;
    if (low.boxY >= high.boxY + high.boxH + gap) return;
    const maxY = paneHeight - MARK_EDGE_PX - low.boxH;
    low.boxY = Math.min(high.boxY + high.boxH + gap, maxY);
    if (low.boxY < high.boxY + high.boxH + gap) {
        high.boxY = Math.max(MARK_EDGE_PX, low.boxY - gap - high.boxH);
    }
}

/** 最高、最低標籤中心：兩者距離不到一個標籤高就上下錯開 */
export function separateLabels(highY: number, lowY: number): { high: number; low: number } {
    const need = MARK_LABEL_H + 2;
    if (lowY - highY >= need) return { high: highY, low: lowY };
    const mid = (highY + lowY) / 2;
    return { high: Math.min(highY, mid - need / 2), low: Math.max(lowY, mid + need / 2) };
}

class HighLowRenderer implements IPrimitivePaneRenderer {
    constructor(private readonly _layer: HighLowLayer) {}
    draw(target: DrawTarget): void {
        const marks = this._layer.marks();
        if (marks.length === 0) return;
        const style = this._layer.style;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            ctx.save();
            ctx.textBaseline = 'middle';
            const gap = 4;
            const avail = mediaSize.width - MARK_EDGE_PX * 2 - MARK_PAD_X * 2;
            const planned = marks.map((m) => {
                ctx.font = FONT_VALUE;
                const valueW = ctx.measureText(m.value).width;
                ctx.font = FONT_WORD;
                // 窄面板放不下「最高」字樣就只留數值；連數值都放不下就不標
                const wordW = valueW + gap + ctx.measureText(m.word).width <= avail ? ctx.measureText(m.word).width : 0;
                if (valueW > avail) return null;
                const total = wordW ? wordW + gap + valueW : valueW;
                return { m, wordW, total, l: layoutMark(m.x, m.y, total, mediaSize, m.labelY) };
            });
            const [a, b] = planned;
            if (a && b) resolveOverlap(a.l, b.l, mediaSize.height);
            for (const p of planned) {
                if (!p) continue;
                const { m, l, wordW } = p;
                const midY = l.boxY + l.boxH / 2;
                // 引線：影線端點 → 標籤
                ctx.strokeStyle = m.color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(Math.round(l.leaderFrom) + 0.5, Math.round(l.tipY) + 0.5);
                const edgeX = l.side === 'right' ? l.boxX : l.boxX + l.boxW;
                ctx.lineTo(Math.round(edgeX) + 0.5, Math.round(midY) + 0.5);
                ctx.stroke();
                // 端點小圓點：看得出標的是哪一根的影線
                ctx.fillStyle = m.color;
                ctx.beginPath();
                ctx.arc(m.x, m.y, 1.75, 0, Math.PI * 2);
                ctx.fill();
                // 標籤底（圖表標籤底色＋外框，壓在 K 棒上仍看得清楚）
                roundRect(ctx, l.boxX + 0.5, l.boxY + 0.5, l.boxW - 1, l.boxH - 1, 3);
                ctx.fillStyle = style.labelBg;
                ctx.globalAlpha = 0.92;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.strokeStyle = style.border;
                ctx.stroke();
                // 文字：字樣用次要色、數值用標記色
                let tx = l.boxX + MARK_PAD_X;
                if (wordW) {
                    ctx.font = FONT_WORD;
                    ctx.fillStyle = style.mutedText;
                    ctx.fillText(m.word, tx, midY + 0.5);
                    tx += wordW + gap;
                }
                ctx.font = FONT_VALUE;
                ctx.fillStyle = m.color;
                ctx.fillText(m.value, tx, midY + 0.5);
            }
            ctx.restore();
        });
    }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

class HighLowPaneView implements IPrimitivePaneView {
    constructor(private readonly _layer: HighLowLayer) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'top';
    }
    renderer(): IPrimitivePaneRenderer {
        return new HighLowRenderer(this._layer);
    }
}

export class HighLowLayer implements ISeriesPrimitive<Time> {
    style: HighLowStyle;
    private _series: ISeriesApi<SeriesType> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private readonly _views: HighLowPaneView[];

    constructor(style: HighLowStyle) {
        this.style = style;
        this._views = [new HighLowPaneView(this)];
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
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }

    setStyle(patch: Partial<HighLowStyle>): void {
        this.style = { ...this.style, ...patch };
        this._requestUpdate?.();
    }

    /** 目前要畫的標記（pane 座標）；隱藏或資料不足回空陣列 */
    marks(): MarkSpec[] {
        const series = this._series;
        const chart = this._chart;
        if (!this.style.visible || !series || !chart) return [];
        const range = chart.timeScale().getVisibleLogicalRange();
        if (!range) return [];
        // dataByIndex 以 logical index 取值（空白資料、與其他序列時間軸不同時
        // 陣列位置不等於 logical index），只走可見範圍，不必每幀複製整段歷史
        const at = (i: number) => {
            const d = series.dataByIndex(i) as (Partial<HighLowBar> & { time: Time }) | null;
            return d && typeof d.high === 'number' && typeof d.low === 'number' ? (d as HighLowBar & { time: Time }) : null;
        };
        const hit = visibleHighLow(at, range.from, range.to);
        if (!hit) return [];
        const out: MarkSpec[] = [];
        const push = (h: HighLowHit, word: string, color: string) => {
            const time = at(h.index)?.time;
            if (time === undefined) return;
            const x = chart.timeScale().timeToCoordinate(time);
            const y = series.priceToCoordinate(h.price);
            if (x === null || y === null) return;
            out.push({ word, value: this.style.format(h.price), color, x, y, labelY: y });
        };
        push(hit.high, '最高', this.style.highColor);
        push(hit.low, '最低', this.style.lowColor);
        if (out.length === 2) {
            const sep = separateLabels(out[0]!.y, out[1]!.y);
            out[0]!.labelY = sep.high;
            out[1]!.labelY = sep.low;
        }
        return out;
    }
}
