// src/lib/chart-drawing-geometry.ts — 畫圖物件的幾何運算（純函式）
//
// 這裡刻意不 import lightweight-charts：投影所需的座標轉換由呼叫端以
// Projector 介面注入，幾何與命中判定才能在沒有 DOM／canvas 的環境下
// 單元測試（本專案的測試環境沒有 jsdom）。
//
// 跨週期的關鍵在 timeToLogical()：lightweight-charts 的
// timeScale().timeToCoordinate() 對「不在 K 棒格點上的時間」一律回
// null，所以 1m 圖上錨在 09:31 的線切到 1D 就會整條消失。改成先把時間
// 內插成小數 logical index 再交給 logicalToCoordinate()，任何時間都有
// 座標，包含最後一根 K 棒右邊的空白區。

import type { DrawingAnchor, DrawingTool } from './chart-drawings';
import { defaultFibOptions, fibLabel, fibLabelPlacement, fibLevelPrice, type FibOptions } from './chart-drawing-fib';

export interface Point {
    x: number;
    y: number;
}

export interface PaneSize {
    width: number;
    height: number;
}

// 由元件以 chart / series API 實作；價格方向直接用 series 的轉換，
// 對數座標與線性座標都正確
export interface Projector {
    xOfTime(time: number): number | null;
    yOfPrice(price: number): number | null;
    timeOfX(x: number): number | null;
    priceOfY(y: number): number | null;
}

// ── 時間 ↔ logical index ─────────────────────────────────────────────

// 以中位數估計每根 K 棒的秒數 — 用平均會被夜盤／假日的大缺口帶偏
export function estimateBarSeconds(times: number[]): number {
    if (times.length < 2) return 60;
    const diffs: number[] = [];
    for (let i = 1; i < times.length; i++) {
        const d = times[i]! - times[i - 1]!;
        if (d > 0) diffs.push(d);
    }
    if (!diffs.length) return 60;
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)]!;
}

// 回傳小數 logical index；times 必須遞增。落在兩根 K 棒之間時依比例
// 內插（缺口內的時間就被壓進缺口裡，與 TradingView 一致），超出兩端
// 則以 barSeconds 等距外推。
export function timeToLogical(times: number[], barSeconds: number, time: number): number {
    const n = times.length;
    if (n === 0) return NaN;
    const first = times[0]!;
    const last = times[n - 1]!;
    const span = barSeconds > 0 ? barSeconds : 60;
    if (time <= first) return (time - first) / span;
    if (time >= last) return n - 1 + (time - last) / span;
    // binary search：times[lo] <= time < times[lo + 1]
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= time) lo = mid;
        else hi = mid;
    }
    const a = times[lo]!;
    const b = times[lo + 1]!;
    return b === a ? lo : lo + (time - a) / (b - a);
}

// timeToLogical 的反函式（拖曳時把畫面位置換回時間座標保存）
export function logicalToTime(times: number[], barSeconds: number, logical: number): number {
    const n = times.length;
    if (n === 0) return NaN;
    const span = barSeconds > 0 ? barSeconds : 60;
    if (logical <= 0) return times[0]! + logical * span;
    if (logical >= n - 1) return times[n - 1]! + (logical - (n - 1)) * span;
    const i = Math.floor(logical);
    const frac = logical - i;
    const a = times[i]!;
    const b = times[i + 1]!;
    return a + frac * (b - a);
}

// ── 投影 ─────────────────────────────────────────────────────────────

export function projectAnchor(p: Projector, anchor: DrawingAnchor): Point | null {
    const x = p.xOfTime(anchor.time);
    const y = p.yOfPrice(anchor.price);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

export function projectAnchors(p: Projector, anchors: DrawingAnchor[]): Point[] | null {
    const pts: Point[] = [];
    for (const a of anchors) {
        const pt = projectAnchor(p, a);
        if (!pt) return null;
        pts.push(pt);
    }
    return pts;
}

export function unprojectPoint(p: Projector, pt: Point): DrawingAnchor | null {
    const time = p.timeOfX(pt.x);
    const price = p.priceOfY(pt.y);
    if (time === null || price === null || !Number.isFinite(time) || !Number.isFinite(price)) {
        return null;
    }
    return { time, price };
}

// ── 形狀 ─────────────────────────────────────────────────────────────

export type Shape =
    | { kind: 'line'; a: Point; b: Point }
    | { kind: 'rect'; left: number; top: number; right: number; bottom: number }
    // 平行通道：基準線、平行線、中線（虛線），fill 是兩線圍出的四邊形
    | { kind: 'channel'; base: Segment; parallel: Segment; mid: Segment; fill: Point[] }
    // 斐波那契：各比例的水平線（left～right），diag 是起點到終點的虛線
    // 斐波那契：各比例的水平線（left～right，延伸時到圖表邊緣）；
    // anchorLeft／anchorRight 是回撤本身的範圍（標籤放在它外側）；
    // index 是該比例在 fib.levels 裡的位置（取顏色用）；diag 是起點到終點
    // 的斜虛線（關掉時為 null）
    | {
          kind: 'fib';
          left: number;
          right: number;
          anchorLeft: number;
          anchorRight: number;
          levels: { level: number; y: number; index: number }[];
          diag: Segment | null;
      }
    // 文字註記：以錨點為左上角的文字框
    | { kind: 'text'; left: number; top: number; right: number; bottom: number; lines: string[] };

export interface Segment {
    a: Point;
    b: Point;
}

// 形狀需要的物件資料（控制點以外）
export interface ShapeExtra {
    text?: string;
    fib?: FibOptions;
    anchors?: DrawingAnchor[];
    style?: { width: number };
    formatPrice?: (price: number) => string;
}

export const TEXT_FONT_PX = 12;
export const TEXT_LINE_PX = 16;
export const TEXT_PAD_X = 6;
export const TEXT_PAD_Y = 4;

// 文字寬度估算 — 命中判定沒有 canvas 可量字，繪製與命中共用這個估算，
// 框的大小才一致（CJK 全形字約一個字高，半形約 0.6 個字高）
export function estimateTextWidth(line: string, fontPx = TEXT_FONT_PX): number {
    let w = 0;
    for (const ch of line) w += ch.charCodeAt(0) > 0x2e80 ? fontPx : fontPx * 0.6;
    return w;
}

export function textBox(at: Point, text: string) {
    const lines = (text || ' ').split('\n');
    const width = Math.max(...lines.map((l) => estimateTextWidth(l))) + TEXT_PAD_X * 2;
    const height = lines.length * TEXT_LINE_PX + TEXT_PAD_Y * 2;
    return { left: at.x, top: at.y, right: at.x + width, bottom: at.y + height, lines };
}

// 繪製與命中共用同一標籤範圍；canvas 文字以 width 作 maxWidth，
// 字型差異不會讓可見文字超出命中框。
export function fibLabels(
    shape: Extract<Shape, { kind: 'fib' }>,
    fib: FibOptions,
    anchors: DrawingAnchor[],
    paneWidth: number,
    formatPrice: (price: number) => string = String,
) {
    return shape.levels.map((l) => {
        const text = fibLabel(l.level, fibLevelPrice(anchors[0]!.price, anchors[1]!.price, l.level, fib.reverse), fib, formatPrice);
        const at = fibLabelPlacement({ min: shape.anchorLeft, max: shape.anchorRight }, fib, paneWidth, l.y, fib.fontSize);
        const width = estimateTextWidth(text, fib.fontSize);
        const left = at.align === 'left' ? at.x : at.x - width;
        const top = at.baseline === 'top' ? at.y : at.baseline === 'middle' ? at.y - fib.fontSize / 2 : at.y - fib.fontSize;
        return { ...at, text, width, left, right: left + width, top, bottom: top + fib.fontSize, index: l.index };
    });
}

// 通道的平行線相對基準線的垂直位移（畫面座標）：第三點與基準線在同一個
// x 上的 y 差。基準線垂直（兩點同 x）時退化成水平位移。
export function channelOffset(a: Point, b: Point, c: Point): Point {
    if (b.x === a.x) return { x: c.x - a.x, y: 0 };
    const yOnLine = a.y + ((c.x - a.x) * (b.y - a.y)) / (b.x - a.x);
    return { x: 0, y: c.y - yOnLine };
}

// 斐波那契各比例的價格：終點＝0、起點＝1（由高點拉到低點時，0 在低點）
export function fibPrice(start: number, end: number, level: number): number {
    return end + (start - end) * level;
}

// 射線／延伸線依畫面邊界裁切（Liang–Barsky）。直線參數式
// P(t) = origin + t·(toward − origin)，t 的範圍 [tMin, tMax]（射線 [0, ∞)，
// 延伸線 (−∞, ∞)），與 pane 矩形（外擴 margin，讓線端穿出邊界）求交。
// 不用「固定長度往外延伸」：控制點捲到很遠的畫面外時，固定長度到不了
// 可視區，本該穿過畫面的線就消失、也點不到。
// 與畫面不相交時回 null（整條線都在畫面外）。
export function clipLine(
    origin: Point,
    toward: Point,
    size: PaneSize,
    tMin: number,
    tMax: number,
    margin = 2,
): { a: Point; b: Point } | null {
    const dx = toward.x - origin.x;
    const dy = toward.y - origin.y;
    if (dx === 0 && dy === 0) return null; // 兩點重合 — 沒有方向
    let t0 = tMin;
    let t1 = tMax;
    const left = -margin;
    const top = -margin;
    const right = Math.max(0, size.width) + margin;
    const bottom = Math.max(0, size.height) + margin;
    // p·t <= q 的四個半平面
    const edges: [number, number][] = [
        [-dx, origin.x - left],
        [dx, right - origin.x],
        [-dy, origin.y - top],
        [dy, bottom - origin.y],
    ];
    for (const [p, q] of edges) {
        if (p === 0) {
            if (q < 0) return null; // 平行且在這條邊外側
            continue;
        }
        const r = q / p;
        if (p < 0) {
            if (r > t1) return null;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return null;
            if (r < t1) t1 = r;
        }
    }
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 > t1) return null;
    return {
        a: { x: origin.x + t0 * dx, y: origin.y + t0 * dy },
        b: { x: origin.x + t1 * dx, y: origin.y + t1 * dy },
    };
}

// 把控制點換成實際要畫的形狀。pts 已是畫面座標。
export function shapeOf(
    tool: DrawingTool,
    pts: Point[],
    size: PaneSize,
    extra?: ShapeExtra,
): Shape | null {
    const a = pts[0];
    if (!a) return null;
    if (tool === 'horizontal') {
        return { kind: 'line', a: { x: 0, y: a.y }, b: { x: size.width, y: a.y } };
    }
    if (tool === 'vertical') {
        return { kind: 'line', a: { x: a.x, y: 0 }, b: { x: a.x, y: size.height } };
    }
    if (tool === 'text') {
        return { kind: 'text', ...textBox(a, extra?.text ?? '') };
    }
    const b = pts[1];
    if (!b) return null;
    switch (tool) {
        case 'trend':
            return { kind: 'line', a, b };
        case 'ray': {
            // 起點固定，經第二點往外無限延伸；兩點重合時沒有方向，退回一點
            if (a.x === b.x && a.y === b.y) return { kind: 'line', a, b };
            const seg = clipLine(a, b, size, 0, Infinity);
            return seg ? { kind: 'line', ...seg } : null;
        }
        case 'extended': {
            // 斜率由兩點決定，向左右無限延伸
            if (a.x === b.x && a.y === b.y) return { kind: 'line', a, b };
            const seg = clipLine(a, b, size, -Infinity, Infinity);
            return seg ? { kind: 'line', ...seg } : null;
        }
        case 'box':
            return {
                kind: 'rect',
                left: Math.min(a.x, b.x),
                right: Math.max(a.x, b.x),
                top: Math.min(a.y, b.y),
                bottom: Math.max(a.y, b.y),
            };
        case 'channel': {
            const c = pts[2];
            // 還在等第三點：先畫基準線
            if (!c) return { kind: 'line', a, b };
            const off = channelOffset(a, b, c);
            const a2 = { x: a.x + off.x, y: a.y + off.y };
            const b2 = { x: b.x + off.x, y: b.y + off.y };
            return {
                kind: 'channel',
                base: { a, b },
                parallel: { a: a2, b: b2 },
                mid: {
                    a: { x: a.x + off.x / 2, y: a.y + off.y / 2 },
                    b: { x: b.x + off.x / 2, y: b.y + off.y / 2 },
                },
                fill: [a, b, b2, a2],
            };
        }
        case 'fib': {
            // y 在畫面座標線性內插 — 線性價格軸下與價格內插完全一致。
            // 預設終點＝0、起點＝1；反轉時起點＝0、終點＝1
            const fib = extra?.fib ?? defaultFibOptions();
            const [from, to] = fib.reverse ? [b, a] : [a, b];
            const levels = fib.levels
                .map((l, index) => ({ level: l.value, y: to.y + (from.y - to.y) * l.value, index, visible: l.visible }))
                .filter((l) => l.visible)
                .map(({ level, y, index }) => ({ level, y, index }));
            const anchorLeft = Math.min(a.x, b.x);
            const anchorRight = Math.max(a.x, b.x);
            return {
                kind: 'fib',
                left: fib.extendLeft ? Math.min(0, anchorLeft) : anchorLeft,
                right: fib.extendRight ? Math.max(size.width, anchorRight) : anchorRight,
                anchorLeft,
                anchorRight,
                levels,
                diag: fib.showTrend ? { a, b } : null,
            };
        }
    }
    return null;
}

// 射線法判斷點是否在多邊形內
export function pointInPolygon(p: Point, poly: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!;
        const b = poly[j]!;
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

// ── 命中判定 ─────────────────────────────────────────────────────────

export function distanceToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type Hit = { kind: 'anchor'; index: number } | { kind: 'body' };

export const ANCHOR_RADIUS = 4;
export const HIT_TOLERANCE = 6;

// 控制點優先於本體 — 不然抓不到疊在線上的端點
export function hitTest(
    tool: DrawingTool,
    pts: Point[],
    size: PaneSize,
    at: Point,
    tolerance = HIT_TOLERANCE,
    extra?: ShapeExtra,
): Hit | null {
    for (let i = 0; i < pts.length; i++) {
        const pt = pts[i]!;
        if (Math.hypot(at.x - pt.x, at.y - pt.y) <= ANCHOR_RADIUS + tolerance) {
            return { kind: 'anchor', index: i };
        }
    }
    const shape = shapeOf(tool, pts, size, extra);
    if (!shape) return null;
    tolerance = Math.max(tolerance, (extra?.style?.width ?? 0) / 2);
    const near = (seg: Segment) => distanceToSegment(at, seg.a, seg.b) <= tolerance;
    if (shape.kind === 'line') {
        return near(shape) ? { kind: 'body' } : null;
    }
    if (shape.kind === 'channel') {
        const hit =
            near(shape.base) || near(shape.parallel) || near(shape.mid) || pointInPolygon(at, shape.fill);
        return hit ? { kind: 'body' } : null;
    }
    if (shape.kind === 'fib') {
        const inX = at.x >= shape.left - tolerance && at.x <= shape.right + tolerance;
        const fib = extra?.fib ?? defaultFibOptions();
        const ys = shape.levels.map((l) => l.y);
        const band = fib.bandOpacity > 0 && ys.length > 1 && inX && at.y >= Math.min(...ys) && at.y <= Math.max(...ys);
        const labels = fibLabels(shape, fib, extra?.anchors ?? pts.map((p) => ({ time: p.x, price: p.y })), size.width, extra?.formatPrice);
        const label = labels.some((r) => r.text && at.x >= r.left - tolerance - 2 && at.x <= r.right + tolerance + 2 && at.y >= r.top - tolerance - 2 && at.y <= r.bottom + tolerance + 2);
        const hit =
            band || label ||
            (inX && shape.levels.some((l) => Math.abs(at.y - l.y) <= tolerance)) ||
            (!!shape.diag && near(shape.diag));
        return hit ? { kind: 'body' } : null;
    }
    // 方框：填色區域內部與四個邊都算命中（有填色就該點得到）
    const inside =
        at.x >= shape.left - tolerance &&
        at.x <= shape.right + tolerance &&
        at.y >= shape.top - tolerance &&
        at.y <= shape.bottom + tolerance;
    return inside ? { kind: 'body' } : null;
}

// 從一疊物件裡挑出游標點到的那個。後畫的疊在上面，所以從尾端往前找。
//
// 篩選規則只有一條：隱藏的跳過。**鎖定的照樣選得到** — 鎖定擋的是拖曳，
// 不是選取；選不到就沒辦法解鎖或改樣式，物件會永遠黏在圖上拿不掉。
export function pickDrawing<
    T extends {
        tool: DrawingTool;
        anchors: DrawingAnchor[];
        hidden: boolean;
        text?: string;
        fib?: FibOptions;
    },
>(
    list: readonly T[],
    projector: Projector,
    size: PaneSize,
    at: Point,
    tolerance = HIT_TOLERANCE,
    formatPrice?: (price: number) => string,
): { drawing: T; hit: Hit; points: Point[] } | null {
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i]!;
        if (d.hidden) continue;
        const points = projectAnchors(projector, d.anchors);
        if (!points) continue;
        const hit = hitTest(d.tool, points, size, at, tolerance, { ...d, formatPrice });
        if (hit) return { drawing: d, hit, points };
    }
    return null;
}

// ── 拖曳 ─────────────────────────────────────────────────────────────
//
// 位移一律在畫面座標算完再換回時間／價格：時間軸有缺口、價格軸可能是
// 對數，直接加減時間或價格都會在拖曳時漂掉。

export interface DragPlan {
    hit: Hit;
    startPoints: Point[]; // 按下當下各控制點的畫面座標
    startAt: Point; // 按下當下的游標位置
}

// 回傳拖曳後的新控制點畫面座標；呼叫端再 unproject 回時間／價格
export function dragPoints(plan: DragPlan, at: Point): Point[] {
    const dx = at.x - plan.startAt.x;
    const dy = at.y - plan.startAt.y;
    if (plan.hit.kind === 'anchor') {
        const i = plan.hit.index;
        return plan.startPoints.map((p, idx) =>
            idx === i ? { x: p.x + dx, y: p.y + dy } : { ...p },
        );
    }
    return plan.startPoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

// ── logical index ↔ 畫面 x ────────────────────────────────────────────
//
// lightweight-charts 的 timeScale.logicalToCoordinate() 只認整數 logical：
// 內部 indexToCoordinate() 對非整數直接回 0，也就是 pane 的左緣。切到
// 大週期時，小週期存下的時間會落在兩根 K 棒之間（小數 logical），端點
// 就被釘在畫面最左邊、跟著平移一起跑。coordinateToLogical() 反向也會
// Math.ceil() 成整數，拖曳時被量化到整棒。
//
// logical → x 在同一幀內是線性的（x = 左緣 + logical × barSpacing），所以
// 拿兩個整數 logical 量出這條直線，小數自己算，兩個方向都精確。
export interface XAxisMap {
    origin: number; // logical 0 的 x
    barSpacing: number; // 每根 K 棒的像素寬
}

// at 由呼叫端包成 timeScale.logicalToCoordinate；time scale 還空著時回 null
export function measureXAxis(at: (logical: number) => number | null): XAxisMap | null {
    const a = at(0);
    const b = at(1);
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    const barSpacing = b - a;
    if (!(barSpacing > 0)) return null;
    return { origin: a, barSpacing };
}

export function xOfLogical(map: XAxisMap, logical: number): number {
    return map.origin + logical * map.barSpacing;
}

export function logicalOfX(map: XAxisMap, x: number): number {
    return (x - map.origin) / map.barSpacing;
}

// ── 磁吸 ─────────────────────────────────────────────────────────────
//
// 貼齊游標所在時間最近那根 K 棒的開高低收中，畫面上離游標最近的價位；
// 時間也貼齊那根 K 棒。bars 依時間遞增。

export interface OhlcBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

export function nearestBarIndex(bars: readonly { time: number }[], time: number): number {
    const n = bars.length;
    if (!n) return -1;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (bars[mid]!.time <= time) lo = mid;
        else hi = mid;
    }
    return Math.abs(bars[hi]!.time - time) < Math.abs(bars[lo]!.time - time) ? hi : lo;
}

export function magnetAnchor(
    anchor: DrawingAnchor,
    bars: readonly OhlcBar[],
    yOfPrice: (p: number) => number | null,
    y: number,
): DrawingAnchor {
    const i = nearestBarIndex(bars, anchor.time);
    if (i < 0) return anchor;
    const bar = bars[i]!;
    let best = anchor.price;
    let bestD = Infinity;
    for (const p of [bar.open, bar.high, bar.low, bar.close]) {
        const py = yOfPrice(p);
        if (py === null) continue;
        const d = Math.abs(py - y);
        if (d < bestD) {
            bestD = d;
            best = p;
        }
    }
    return { time: bar.time, price: best };
}

// ── 價差量測 ─────────────────────────────────────────────────────────

export interface MeasureStats {
    points: number; // 終點 − 起點（價格）
    pct: number; // 漲跌幅 %
    bars: number; // 經過幾根 K 棒（依 logical index 差，可為負）
    seconds: number; // 經過時間（秒，可為負）
    pnl: number | null; // 依目前下單數量換算的損益（不知道乘數時為 null）
}

export function measureStats(
    a: DrawingAnchor,
    b: DrawingAnchor,
    times: number[],
    barSeconds: number,
    pnlPerPoint: number | null,
): MeasureStats {
    const points = b.price - a.price;
    const pct = a.price !== 0 ? (points / a.price) * 100 : 0;
    const la = timeToLogical(times, barSeconds, a.time);
    const lb = timeToLogical(times, barSeconds, b.time);
    const bars = Number.isFinite(la) && Number.isFinite(lb) ? Math.round(lb - la) : 0;
    return {
        points,
        pct,
        bars,
        seconds: b.time - a.time,
        pnl: pnlPerPoint && pnlPerPoint > 0 ? points * pnlPerPoint : null,
    };
}

// 1h30m、2d 3h、45m、30s — 量測標籤用
export function formatSpan(seconds: number): string {
    const s = Math.abs(Math.round(seconds));
    const sign = seconds < 0 ? '−' : '';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${sign}${d}d${h ? ` ${h}h` : ''}`;
    if (h) return `${sign}${h}h${m ? `${m}m` : ''}`;
    if (m) return `${sign}${m}m`;
    return `${sign}${s}s`;
}
