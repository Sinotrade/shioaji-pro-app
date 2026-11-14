// src/lib/chart-fill-marks.ts — K 線實際成交標記：三角形錨點＋標籤
//
// 錨點畫在真實成交價與所屬 K 棒（不吸附、不夾回）：買 ▲ 尖端在成交價、往下長，
// 賣 ▼ 尖端在成交價、往上長。同一根 K 棒同方向有多個價位時 hook 交來一組（members）：
// 三角形在最低買價／最高賣價（區間外側），一條區間線＋每個價位一條短刻度（買朝右、賣朝左），
// 標籤放在均價高度、用短線接回。同一根又買又賣時買整組右移、賣整組左移 FILL_SPLIT_PX。
// 標籤字串由 hook 組好；買偏好右側、賣偏好左側，偏好側放不下才試另一側。價位樣式只在同一高度試兩側；
// 買／賣樣式每側再試上下各 1 格並畫短連接線；都放不下只留錨點。
// 跟最高／最低一樣用 series primitive，由圖表重繪迴圈驅動；
// 不實作 hitTest／autoscaleInfo／priceAxisViews，不影響點價下單、畫圖與價格縮放。

import type {
    IChartApi,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    SeriesAttachedParameter,
    SeriesType,
    Time,
    UTCTimestamp,
} from 'lightweight-charts';
import { MARK_EDGE_PX, MARK_GAP_PX, MARK_LABEL_H, MARK_LEADER_PX, resolveOverlap } from './chart-highlow';

// 版面常數（CSS px）
export const FILL_TRI_W = 8; // 三角形底寬
export const FILL_TRI_H = 7; // 三角形高；面積和舊版半徑 3 的圓點相當
export const FILL_TRI_RING = 1.5; // 三角形外框（標籤底色），壓在同色 K 棒上也看得到
export const FILL_LABEL_GAP = 3; // 三角形到標籤
export const FILL_LABEL_H = 15;
export const FILL_LABEL_PAD_X = 4;
export const FILL_LABEL_RADIUS = 3;
export const FILL_EDGE_PX = 4; // 標籤與 pane 邊緣的最小距離
export const FILL_LABEL_STEP = FILL_LABEL_H + 2; // 上下錯開一格
export const FILL_LABEL_MAX = 120; // 畫面內超過這麼多組就只畫錨點
export const FILL_MIN_BAR_PX = 3; // 每根 K 棒比這窄就只畫錨點
export const FILL_HIT_MARK_PX = 3; // 三角形外接範圍（含外框）再外擴
export const FILL_HIT_LABEL_PX = 2;
export const FILL_DIM_ALPHA = 0.4; // 待確認時保留的上次分組
export const FILL_FONT = '600 11px sans-serif';
export const FILL_TICK_W = 4; // 多價位組每個價位的刻度長（買朝右、賣朝左）
export const FILL_SPLIT_PX = 2; // 同一根又買又賣：買整組右移、賣整組左移
const FILL_WIDTH_CACHE_MAX = 512; // 字寬快取上限（均價字串隨成交改變）
export const FILL_LABEL_GLASS_ALPHA = 0.5; // 標籤底色半透明（玻璃）：底下的 K 棒透得出來
const SIDE_STEPS = [0, -1, 1];

export type FillAction = 'Buy' | 'Sell';
/** dot：只畫三角形；side：三角形＋買／賣；price：三角形＋價格 */
export type FillMarkStyle = 'dot' | 'side' | 'price';
export interface FillRect { x: number; y: number; w: number; h: number }
export interface FillMarkGroup {
    key: string;
    time: number;
    price: number;
    action: FillAction;
    /** 標籤字串（hook 依樣式組好）；null = 只畫錨點 */
    text: string | null;
    /** 待確認時保留的上次分組：淡色、不排標籤、不可命中 */
    dimmed?: boolean;
    /** 多價位組：各價位（依價格由小到大）與它的每價分組鍵；命中時回傳離游標最近的那個鍵 */
    members?: readonly { key: string; price: number }[];
    /** 標籤高度的價格（多價位組＝均價）；沒有就是 price */
    labelPrice?: number;
}
/** 已轉成 pane 座標的一組成交；多價位組另有各價位的 y（ys，順序同 members）與標籤的 y（ly） */
export interface FillMarkPoint extends FillMarkGroup { x: number; y: number; ys?: readonly number[]; ly?: number }
export interface FillMarkLayout extends FillMarkPoint {
    label: FillRect | null;
    /** 標籤上下錯開時畫短連接線連回錨點；同一高度（含左側）不畫 */
    leader: boolean;
}

// 同一 x：買先於賣，再價格由小到大
const sameBarOrder = (a: FillMarkGroup, b: FillMarkGroup) =>
    a.action === b.action ? a.price - b.price : a.action === 'Buy' ? -1 : 1;
const overlaps = (a: FillRect, b: FillRect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// 點到矩形的距離（在矩形內 = 0）
const rectDistance = (x: number, y: number, r: FillRect) =>
    Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
// 三角形外接範圍（含外框）：買往下長、賣往上長，尖端都在 (x, y)。多價位組再併入整條區間線（刻度在三角形寬度內）
function anchorBox(p: { x: number; y: number; action: FillAction; ys?: readonly number[] }): FillRect {
    let top = (p.action === 'Buy' ? p.y : p.y - FILL_TRI_H) - FILL_TRI_RING;
    let bottom = top + FILL_TRI_H + FILL_TRI_RING * 2;
    if (p.ys?.length) {
        top = Math.min(top, p.ys[p.ys.length - 1]! - FILL_TRI_RING); // 最高價在最上面
        bottom = Math.max(bottom, p.ys[0]! + FILL_TRI_RING);
    }
    return { x: p.x - FILL_TRI_W / 2 - FILL_TRI_RING, y: top, w: FILL_TRI_W + FILL_TRI_RING * 2, h: bottom - top };
}
// 命中的鍵：多價位組回傳 y 最接近游標的價位（hook 用每價分組列滑過明細），其他就是組鍵
// 窄 K 棒時 ys 只有兩端：命中那一組才換出全部價位的座標
function keyAt(m: FillMarkPoint, y: number, coord: (price: number) => number | null): string {
    if (!m.members || !m.ys) return m.key;
    const ys = m.ys.length === m.members.length ? m.ys : m.members.map((member) => coord(member.price) ?? NaN);
    let best = 0;
    for (let i = 1; i < ys.length; i += 1) if (Math.abs(ys[i]! - y) < Math.abs(ys[best]! - y)) best = i;
    return m.members[best]!.key;
}

/**
 * 標籤版面。只處理 pane 內的點（多價位組看整組的垂直範圍），由右（最新）到左、同棒買先於賣、價格排序（縮放平移時不跳動）。
 * 候選：偏好側（買右、賣左）再另一側；price 每側只試同一高度，side 每側試 dy = 0、−1、+1 格；標籤中線＝ly（多價位組的均價）或 y。
 * 合法 = 在 pane 內、不疊已放好的標籤、不蓋任何錨點範圍（含區間線、淡色）、不碰 blocked。dot 不排標籤。多價位組一律畫連接線。
 */
export function layoutFillMarks(
    points: readonly FillMarkPoint[],
    pane: { width: number; height: number },
    opts: { textWidth: (text: string) => number; style: FillMarkStyle; barWidth?: number; blocked?: readonly FillRect[] },
): FillMarkLayout[] {
    const marks = points
        .filter((p) => {
            // 用「在範圍內」的正面寫法：NaN 座標一律排除
            if (!(p.x >= 0 && p.x <= pane.width)) return false;
            if (!p.ys) return p.y >= 0 && p.y <= pane.height;
            const box = anchorBox(p);
            return box.y + box.h >= 0 && box.y <= pane.height;
        })
        .sort((a, b) => b.x - a.x || sameBarOrder(a, b));
    if (opts.style === 'dot' || marks.length > FILL_LABEL_MAX || (opts.barWidth ?? Infinity) < FILL_MIN_BAR_PX) {
        return marks.map((p) => ({ ...p, label: null, leader: false }));
    }
    const blocked = opts.blocked ?? [];
    const anchors = marks.map(anchorBox);
    const placed: FillRect[] = [];
    const steps = opts.style === 'side' ? SIDE_STEPS : [0];
    // 兩兩比對 O(n²)，n 已被 FILL_LABEL_MAX 封頂；要放寬上限再改空間索引
    const free = (r: FillRect) =>
        r.x >= FILL_EDGE_PX && r.y >= FILL_EDGE_PX
        && r.x + r.w <= pane.width - FILL_EDGE_PX && r.y + r.h <= pane.height - FILL_EDGE_PX
        && !placed.some((o) => overlaps(r, o)) && !blocked.some((o) => overlaps(r, o))
        && !anchors.some((o) => overlaps(r, o));
    return marks.map((p) => {
        if (!p.text || p.dimmed) return { ...p, label: null, leader: false };
        const w = opts.textWidth(p.text) + FILL_LABEL_PAD_X * 2;
        const right = p.x + FILL_TRI_W / 2 + FILL_LABEL_GAP;
        const left = p.x - FILL_TRI_W / 2 - FILL_LABEL_GAP - w;
        const ly = p.ly ?? p.y;
        for (const x of p.action === 'Buy' ? [right, left] : [left, right]) {
            for (const k of steps) {
                const label = { x, y: ly - FILL_LABEL_H / 2 + k * FILL_LABEL_STEP, w, h: FILL_LABEL_H };
                if (free(label)) {
                    placed.push(label);
                    return { ...p, label, leader: k !== 0 || !!p.ys };
                }
            }
        }
        return { ...p, label: null, leader: false };
    });
}

/**
 * 最高／最低標籤的保守範圍（寬度估 110）：layoutMark 右側放得下或在左半邊就放右側，
 * 否則放左側。估算寬度放不下右側、實際較窄的標籤仍可能在右側，這時兩側都避開。
 * 垂直照 layoutMark 夾回 pane 內（拖價格軸讓最高點貼邊時標籤框會被夾回），上下各留 1px。
 * 兩個框夾回後疊在一起時，畫的時候 resolveOverlap 會錯開（最低往下、到底就把最高往上）；
 * 估算寬度不知道左右是不是真的相疊，錯開前、後的位置都避開。
 */
export function highLowAvoid(marks: readonly { x: number; labelY: number }[], pane: { width: number; height: number }): FillRect[] {
    const w = MARK_LEADER_PX + 110;
    const maxY = Math.max(MARK_EDGE_PX, pane.height - MARK_EDGE_PX - MARK_LABEL_H);
    const boxes = marks.map((m) => ({ boxX: 0, boxW: 1, boxY: Math.max(MARK_EDGE_PX, Math.min(m.labelY - MARK_LABEL_H / 2, maxY)), boxH: MARK_LABEL_H }));
    const ys = boxes.map((b) => [b.boxY]);
    if (boxes.length === 2) {
        resolveOverlap(boxes[0]!, boxes[1]!, pane.height);
        boxes.forEach((b, i) => { if (b.boxY !== ys[i]![0]) ys[i]!.push(b.boxY); });
    }
    return marks.flatMap((m, i) => ys[i]!.flatMap((boxY) => {
        const right = { x: m.x + MARK_GAP_PX, y: boxY - 1, w, h: MARK_LABEL_H + 2 };
        if (right.x + w <= pane.width - MARK_EDGE_PX || m.x < pane.width / 2) return [right];
        return [{ ...right, x: m.x - MARK_GAP_PX - w }, right];
    }));
}

interface DrawTarget {
    useMediaCoordinateSpace<T>(f: (scope: {
        context: CanvasRenderingContext2D;
        mediaSize: { width: number; height: number };
    }) => T): T;
}

// 三角形路徑：買 ▲ 尖端在 (x, y)、往下長；賣 ▼ 尖端在 (x, y)、往上長
function trianglePath(ctx: CanvasRenderingContext2D, m: FillMarkPoint): void {
    const base = m.action === 'Buy' ? m.y + FILL_TRI_H : m.y - FILL_TRI_H;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(m.x + FILL_TRI_W / 2, base);
    ctx.lineTo(m.x - FILL_TRI_W / 2, base);
    ctx.closePath();
}

export class FillMarksLayer implements ISeriesPrimitive<Time> {
    private _groups: FillMarkGroup[] = [];
    private _style: { up: string; down: string; labelBg: string; font: string; style: FillMarkStyle } =
        { up: '', down: '', labelBg: '', font: FILL_FONT, style: 'price' };
    private _avoid: (() => FillRect[]) | null = null;
    private _series: ISeriesApi<SeriesType> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    // 標籤字寬，以字串為鍵；換字型或樣式時清掉
    private readonly _textWidth = new Map<string, number>();
    // 最近一次繪製的幾何：_marks 是畫出來的三角形與標籤（直接命中用）；
    // _column 是 x 在畫面內的所有組，含價格超出上下緣的（同棒備援用）
    private _marks: FillMarkLayout[] = [];
    private _column: FillMarkPoint[] = [];
    private readonly _renderer = { draw: (target: DrawTarget) => this._draw(target) };
    private readonly _views: readonly IPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => this._renderer }];

    attached(param: SeriesAttachedParameter<Time>): void {
        this._series = param.series;
        this._chart = param.chart;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._chart = null;
        this._requestUpdate = null;
        this._marks = [];
        this._column = [];
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }

    setGroups(groups: readonly FillMarkGroup[]): void {
        // 依時間排好：每幀只要二分搜尋出畫面內那一段
        this._groups = [...groups].sort((a, b) => a.time - b.time || sameBarOrder(a, b));
        // 清空時立即作廢命中幾何；有資料時沿用到下一幀重繪，免得收盤換棒、
        // 新回報時游標下的 tooltip 閃掉（舊 key 查不到只是暫時沒有 tooltip）
        if (this._groups.length === 0) {
            this._marks = [];
            this._column = [];
        }
        this._requestUpdate?.();
    }

    /** 不要傳 undefined（會蓋掉現值）；style 預設 price、font 預設 FILL_FONT */
    setStyle(patch: { up?: string; down?: string; labelBg?: string; font?: string; style?: FillMarkStyle }): void {
        const next = { ...this._style, ...patch };
        if (next.font !== this._style.font || next.style !== this._style.style) this._textWidth.clear();
        this._style = next;
        this._requestUpdate?.();
    }

    setAvoid(fn: (() => FillRect[]) | null): void {
        this._avoid = fn;
    }

    /**
     * 最近的錨點範圍（三角形＋區間線，外擴 3px）或標籤（外擴 2px）；都沒有就取游標所在 K 棒中
     * 錨點垂直範圍離 y 最近的一組。多價位組回傳離游標最近的價位的鍵。淡色分組不命中。
     * 距離平手取後畫的那組（同棒同價又買又賣、游標正好在價位上時是後畫的賣）。
     */
    hitAt(x: number, y: number, barTime?: number): string | null {
        let best: FillMarkPoint | null = null;
        let bestD = Infinity;
        for (const m of this._marks) {
            if (m.dimmed) continue;
            const mark = rectDistance(x, y, anchorBox(m));
            const label = m.label ? rectDistance(x, y, m.label) : Infinity;
            const d = Math.min(mark <= FILL_HIT_MARK_PX ? mark : Infinity, label <= FILL_HIT_LABEL_PX ? label : Infinity);
            if (d < Infinity && d <= bestD) {
                bestD = d;
                best = m;
            }
        }
        if (best === null && barTime !== undefined) {
            for (const p of this._column) {
                if (p.dimmed || p.time !== barTime) continue;
                const box = anchorBox(p);
                const d = Math.max(box.y - y, 0, y - box.y - box.h);
                if (d <= bestD) {
                    bestD = d;
                    best = p;
                }
            }
        }
        return best ? keyAt(best, y, (price) => this._series?.priceToCoordinate(price) ?? null) : null;
    }

    private _draw(target: DrawTarget): void {
        if (this._groups.length === 0) return;
        const chart = this._chart;
        const series = this._series;
        if (!chart || !series) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const timeScale = chart.timeScale();
            const range = timeScale.getVisibleRange();
            const groups = this._groups;
            const column: FillMarkPoint[] = [];
            // lightweight-charts 的 logical range 長度 = pane 寬 ÷ barSpacing − 1
            const logical = timeScale.getVisibleLogicalRange();
            const barWidth = logical ? mediaSize.width / (logical.to - logical.from + 1) : undefined;
            // K 棒太窄只畫三角形：多價位組只換兩端的座標（錨點範圍用），命中時才換全部
            const narrow = barWidth !== undefined && barWidth < FILL_MIN_BAR_PX;
            if (range) {
                const from = range.from as number;
                const to = range.to as number;
                let lo = 0;
                let hi = groups.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (groups[mid]!.time < from) lo = mid + 1;
                    else hi = mid;
                }
                for (let i = lo; i < groups.length && groups[i]!.time <= to; i += 1) {
                    const g = groups[i]!;
                    const x = timeScale.timeToCoordinate(g.time as UTCTimestamp);
                    const y = series.priceToCoordinate(g.price);
                    if (x === null || y === null || x < 0 || x > mediaSize.width) continue;
                    if (!g.members) {
                        column.push({ ...g, x, y });
                        continue;
                    }
                    // 多價位組：任一價位或均價換不出座標就整組不畫（不畫在 0）
                    const list = narrow ? [g.members[0]!, g.members[g.members.length - 1]!] : g.members;
                    const ys: number[] = [];
                    for (const member of list) {
                        const my = series.priceToCoordinate(member.price);
                        if (my === null) break;
                        ys.push(my);
                    }
                    const ly = series.priceToCoordinate(g.labelPrice ?? g.price);
                    if (ys.length === list.length && ly !== null) column.push({ ...g, x, y, ys, ly });
                }
                // 同一根又買又賣：買整組右移、賣整組左移（只有一個方向就不動）
                const sides = new Map<number, number>();
                for (const p of column) sides.set(p.time, (sides.get(p.time) ?? 0) | (p.action === 'Buy' ? 1 : 2));
                for (const p of column) if (sides.get(p.time) === 3) p.x += p.action === 'Buy' ? FILL_SPLIT_PX : -FILL_SPLIT_PX;
            }
            this._column = column;
            this._marks = [];
            if (column.length === 0) return;
            ctx.save();
            ctx.font = this._style.font;
            const widths = this._textWidth;
            const marks = layoutFillMarks(column, mediaSize, {
                textWidth: (text) => {
                    let w = widths.get(text);
                    if (w === undefined) {
                        // ponytail: 超過上限整個清掉重量；真的常常滿再改 LRU
                        if (widths.size >= FILL_WIDTH_CACHE_MAX) widths.clear();
                        widths.set(text, w = ctx.measureText(text).width);
                    }
                    return w;
                },
                style: this._style.style,
                barWidth,
                blocked: this._avoid?.() ?? [],
            });
            this._marks = marks;
            const { up, down, labelBg } = this._style;
            const color = (a: FillAction) => (a === 'Buy' ? up : down);
            // 連接線（最底層）→ 區間線與刻度 → 三角形 → 標籤；標籤本來就不會蓋到錨點範圍
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.6;
            for (const m of marks) {
                if (!m.leader || !m.label) continue;
                ctx.strokeStyle = color(m.action);
                ctx.beginPath();
                ctx.moveTo(m.x, m.ly ?? m.y);
                ctx.lineTo(m.label.x > m.x ? m.label.x : m.label.x + m.label.w, m.label.y + m.label.h / 2);
                ctx.stroke();
            }
            // 多價位組：區間線＋每個價位一條刻度（同一像素列只畫一條，上百個價位也有上限）；
            // 先用標籤底色描寬一點的外框，壓在同色 K 棒上也看得到。K 棒太窄只畫三角形
            if (barWidth === undefined || barWidth >= FILL_MIN_BAR_PX) {
                for (const [width, outline] of [[FILL_TRI_RING * 2, true], [1, false]] as const) {
                    ctx.lineWidth = width;
                    for (const m of marks) {
                        if (!m.ys) continue;
                        ctx.globalAlpha = m.dimmed ? FILL_DIM_ALPHA : 1;
                        ctx.strokeStyle = outline ? labelBg : color(m.action);
                        const dir = m.action === 'Buy' ? 1 : -1;
                        ctx.beginPath();
                        ctx.moveTo(m.x, m.ys[0]!);
                        ctx.lineTo(m.x, m.ys[m.ys.length - 1]!);
                        let row = NaN;
                        for (const y of m.ys) {
                            if (Math.round(y) === row) continue;
                            row = Math.round(y);
                            ctx.moveTo(m.x, y);
                            ctx.lineTo(m.x + dir * FILL_TICK_W, y);
                        }
                        ctx.stroke();
                    }
                }
            }
            // 先畫全部外框再填色：描邊一半在形狀外剛好是外框寬，填色蓋掉內側那一半，
            // 同價買賣兩個尖端都完整停在成交價
            ctx.lineWidth = FILL_TRI_RING * 2;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = labelBg;
            for (const m of marks) {
                ctx.globalAlpha = m.dimmed ? FILL_DIM_ALPHA : 1;
                trianglePath(ctx, m);
                ctx.stroke();
            }
            for (const m of marks) {
                ctx.globalAlpha = m.dimmed ? FILL_DIM_ALPHA : 1;
                trianglePath(ctx, m);
                ctx.fillStyle = color(m.action);
                ctx.fill();
            }
            ctx.lineWidth = 1;
            ctx.textBaseline = 'middle';
            for (const m of marks) {
                if (!m.label) continue;
                const { x, y, w, h } = m.label;
                ctx.beginPath();
                // 舊版 WebView 沒有 roundRect 就退回直角
                if (ctx.roundRect) ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, FILL_LABEL_RADIUS);
                else ctx.rect(x + 0.5, y + 0.5, w - 1, h - 1);
                // 玻璃：底色半透明，K 棒透得出來；字另外描一圈底色，壓在 K 棒上也讀得清楚（不做模糊：每幀成本高、舊 WebView 不支援）
                ctx.globalAlpha = FILL_LABEL_GLASS_ALPHA;
                ctx.fillStyle = labelBg;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.strokeStyle = color(m.action);
                ctx.stroke();
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.strokeStyle = labelBg;
                ctx.strokeText(m.text!, x + FILL_LABEL_PAD_X, y + h / 2 + 0.5);
                ctx.lineWidth = 1;
                ctx.fillStyle = color(m.action);
                ctx.fillText(m.text!, x + FILL_LABEL_PAD_X, y + h / 2 + 0.5); // 有標籤就一定有字串
            }
            ctx.restore();
        });
    }
}
