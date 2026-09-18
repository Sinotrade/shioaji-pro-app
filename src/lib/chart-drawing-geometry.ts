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
    | { kind: 'rect'; left: number; top: number; right: number; bottom: number };

// 射線／延伸線往畫面外延伸的長度：夠長到一定穿出 pane，剩下的交給
// canvas 自己裁切（比逐邊做線段裁切少掉一堆退化情況）
function extentOf(size: PaneSize): number {
    return (Math.abs(size.width) + Math.abs(size.height) + 1) * 4;
}

// 從 from 沿著 origin→toward 的方向再走 length 像素
function extend(from: Point, origin: Point, toward: Point, length: number): Point {
    const dx = toward.x - origin.x;
    const dy = toward.y - origin.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { ...from }; // 兩點重合 — 沒有方向可延伸
    return { x: from.x + (dx / len) * length, y: from.y + (dy / len) * length };
}

// 把控制點換成實際要畫的形狀。pts 已是畫面座標。
export function shapeOf(tool: DrawingTool, pts: Point[], size: PaneSize): Shape | null {
    const a = pts[0];
    if (!a) return null;
    if (tool === 'horizontal') {
        return { kind: 'line', a: { x: 0, y: a.y }, b: { x: size.width, y: a.y } };
    }
    const b = pts[1];
    if (!b) return null;
    switch (tool) {
        case 'trend':
            return { kind: 'line', a, b };
        case 'ray':
            // 起點固定，經第二點往外無限延伸
            return { kind: 'line', a, b: extend(b, a, b, extentOf(size)) };
        case 'extended': {
            const len = extentOf(size);
            // 兩端各自往外延伸 — 斜率由兩點決定，向左右無限延伸
            return { kind: 'line', a: extend(a, b, a, len), b: extend(b, a, b, len) };
        }
        case 'box':
            return {
                kind: 'rect',
                left: Math.min(a.x, b.x),
                right: Math.max(a.x, b.x),
                top: Math.min(a.y, b.y),
                bottom: Math.max(a.y, b.y),
            };
    }
    return null;
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
): Hit | null {
    for (let i = 0; i < pts.length; i++) {
        const pt = pts[i]!;
        if (Math.hypot(at.x - pt.x, at.y - pt.y) <= ANCHOR_RADIUS + tolerance) {
            return { kind: 'anchor', index: i };
        }
    }
    const shape = shapeOf(tool, pts, size);
    if (!shape) return null;
    if (shape.kind === 'line') {
        return distanceToSegment(at, shape.a, shape.b) <= tolerance ? { kind: 'body' } : null;
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
    T extends { tool: DrawingTool; anchors: DrawingAnchor[]; hidden: boolean },
>(
    list: readonly T[],
    projector: Projector,
    size: PaneSize,
    at: Point,
    tolerance = HIT_TOLERANCE,
): { drawing: T; hit: Hit; points: Point[] } | null {
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i]!;
        if (d.hidden) continue;
        const points = projectAnchors(projector, d.anchors);
        if (!points) continue;
        const hit = hitTest(d.tool, points, size, at, tolerance);
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
