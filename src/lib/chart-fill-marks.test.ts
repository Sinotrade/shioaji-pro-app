import { describe, expect, it, vi } from 'vitest';
import {
    FILL_DIM_ALPHA,
    FILL_EDGE_PX,
    FILL_FONT,
    FILL_HIT_LABEL_PX,
    FILL_HIT_MARK_PX,
    FILL_LABEL_GAP,
    FILL_LABEL_GLASS_ALPHA,
    FILL_LABEL_H,
    FILL_LABEL_MAX,
    FILL_LABEL_PAD_X,
    FILL_LABEL_STEP,
    FILL_MIN_BAR_PX,
    FILL_SPLIT_PX,
    FILL_TICK_W,
    FILL_TRI_H,
    FILL_TRI_RING,
    FILL_TRI_W,
    FillMarksLayer,
    highLowAvoid,
    layoutFillMarks,
    type FillAction,
    type FillMarkPoint,
    type FillMarkShape,
    type FillMarkStyle,
    type FillRect,
} from './chart-fill-marks';
import { layoutMark, resolveOverlap } from './chart-highlow';

const pane = { width: 400, height: 200 };
const textWidth = (s: string) => s.length * 11;
const LW = 11 + FILL_LABEL_PAD_X * 2; // 一個字（買／賣）的標籤寬
const SIDE = FILL_TRI_W / 2 + FILL_LABEL_GAP; // 尖端 x 到標籤靠錨點那一側
const pt = (x: number, y: number, action: FillAction = 'Buy', price = 100, text: string | null = action === 'Buy' ? '買' : '賣'): FillMarkPoint =>
    ({ key: `${x}|${y}|${action}|${price}`, time: x, price, action, text, x, y });
const layout = (points: FillMarkPoint[], opts: { style?: FillMarkStyle; barWidth?: number; blocked?: FillRect[] } = {}) =>
    layoutFillMarks(points, pane, { textWidth, style: 'side', ...opts });
const rightAt = (p: { x: number; y: number }, k: number, w = LW): FillRect =>
    ({ x: p.x + SIDE, y: p.y - FILL_LABEL_H / 2 + k * FILL_LABEL_STEP, w, h: FILL_LABEL_H });
const leftAt = (p: { x: number; y: number }, k: number, w = LW): FillRect => ({ ...rightAt(p, k, w), x: p.x - SIDE - w });
// 三角形外接範圍（含外框）：買往下長、賣往上長
const box = (p: { x: number; y: number; action: FillAction }): FillRect => ({
    x: p.x - FILL_TRI_W / 2 - FILL_TRI_RING,
    y: (p.action === 'Buy' ? p.y : p.y - FILL_TRI_H) - FILL_TRI_RING,
    w: FILL_TRI_W + FILL_TRI_RING * 2,
    h: FILL_TRI_H + FILL_TRI_RING * 2,
});
const overlap = (a: FillRect, b: FillRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('layoutFillMarks', () => {
    it('錨點就是輸入座標（不吸附、不夾回）；買的標籤預設在右側同一高度、不畫連接線', () => {
        const p = pt(100, 50);
        expect(layout([p])).toEqual([{ ...p, label: rightAt(p, 0), leader: false }]);
        expect(rightAt(p, 0).x).toBe(100 + 4 + 3);
        // 貼近左上角：錨點留在原處；買／賣樣式標籤只能往下錯開，價位樣式只留錨點
        const [corner] = layout([pt(1, 1)]);
        expect(corner).toMatchObject({ x: 1, y: 1, leader: true, label: rightAt(pt(1, 1), 1) });
        expect(layout([pt(1, 1)], { style: 'price' })[0]).toMatchObject({ x: 1, y: 1, label: null, leader: false });
    });

    it('貼近下緣的點：標籤不得伸出下邊界（距邊 FILL_EDGE_PX），買／賣樣式改往上錯開並畫連接線，價位樣式只留錨點', () => {
        for (const y of [pane.height - 2, pane.height - 10]) {
            const [m] = layout([pt(100, y)]);
            expect(m!.label).not.toBeNull();
            expect(m!.label!.y + m!.label!.h).toBeLessThanOrEqual(pane.height - FILL_EDGE_PX);
            expect(m!.label!.y).toBeLessThan(y);
            expect(m!.leader).toBe(true);
            expect(m!.y).toBe(y); // 錨點仍在原價位
            expect(layout([pt(100, y)], { style: 'price' })[0]!.label).toBeNull();
        }
    });

    it('右緣落在邊界帶（pane 寬 − FILL_EDGE_PX 到 pane 寬）內時翻到左側同一高度，而不是整個省略', () => {
        const x = pane.width - FILL_EDGE_PX - (SIDE + LW) + 1; // 右側標籤右緣剛好超過 pane.width − FILL_EDGE_PX
        expect(x + SIDE + LW).toBeGreaterThan(pane.width - FILL_EDGE_PX);
        expect(x + SIDE + LW).toBeLessThanOrEqual(pane.width);
        for (const style of ['side', 'price'] as const) {
            const [m] = layout([pt(x, 100)], { style });
            expect(m!.label).toEqual(leftAt(pt(x, 100), 0));
            expect(m!.label!.x + m!.label!.w).toBeLessThan(m!.x);
            expect(m!.leader).toBe(false);
        }
    });

    it('左緣、上緣也要留 FILL_EDGE_PX：賣的左側標籤 x 只剩 2 時改放右側；標籤 y 只剩 2 時價位樣式只留錨點', () => {
        const sell = pt(2 + SIDE + LW, 100, 'Sell');
        expect(leftAt(sell, 0).x).toBe(2);
        expect(layout([sell], { style: 'price' })[0]!.label).toEqual(rightAt(sell, 0));
        const top = pt(100, 2 + FILL_LABEL_H / 2);
        expect(rightAt(top, 0).y).toBe(2);
        expect(layout([top], { style: 'price' })[0]!.label).toBeNull();
    });

    it('超出 pane 或座標無效的點不畫', () => {
        expect(layout([pt(-1, 50), pt(401, 50), pt(100, -1), pt(100, 201), pt(Number.NaN, 50)])).toEqual([]);
    });

    it('買在右側放不下改放左側同一高度，不畫連接線（兩種樣式都一樣）', () => {
        for (const style of ['side', 'price'] as const) {
            const [m] = layout([pt(390, 50)], { style });
            expect(m).toMatchObject({ leader: false, label: { x: 390 - SIDE - LW, y: 50 - FILL_LABEL_H / 2, w: LW, h: FILL_LABEL_H } });
            expect(m!.label!.x + m!.label!.w).toBeLessThanOrEqual(pane.width - FILL_EDGE_PX);
        }
    });

    it('買／賣樣式：偏好側（買右、賣左）依 dy = 0、−1、+1，再換另一側同一序列；不試 ±2；全部不行只留錨點', () => {
        for (const action of ['Buy', 'Sell'] as const) {
            const p = pt(100, 100, action);
            const blocked: FillRect[] = [];
            for (const at of action === 'Buy' ? [rightAt, leftAt] : [leftAt, rightAt]) {
                for (const k of [0, -1, 1]) {
                    const [m] = layout([p], { blocked });
                    expect(m!.label).toEqual(at(p, k));
                    expect(m!.leader).toBe(k !== 0); // 錯開才畫連接線，同一高度（含左側）不畫
                    blocked.push(at(p, k));
                }
            }
            expect(layout([p], { blocked })).toEqual([{ ...p, label: null, leader: false }]);
        }
    });

    it('價位樣式：每側只試同一高度（標籤中線 = 錨點 y），偏好側放不下才換邊，不上下錯開也不畫連接線', () => {
        const w = textWidth('46,459') + FILL_LABEL_PAD_X * 2;
        for (const action of ['Buy', 'Sell'] as const) {
            const p = pt(200, 100, action, 46459, '46,459');
            const [first, second] = action === 'Buy' ? [rightAt, leftAt] : [leftAt, rightAt];
            const price = (blocked: FillRect[]) => layout([p], { style: 'price', blocked })[0]!;
            expect(price([])).toMatchObject({ label: first(p, 0, w), leader: false });
            expect(price([]).label!.y + FILL_LABEL_H / 2).toBe(p.y);
            expect(price([first(p, 0, w)])).toMatchObject({ label: second(p, 0, w), leader: false });
            // 兩側同一高度都被擋：上下明明有空也不錯開，只留錨點
            expect(price([first(p, 0, w), second(p, 0, w)])).toMatchObject({ label: null, leader: false });
        }
    });

    it('同棒同價又買又賣：買標籤在右、賣標籤在左，同一高度、不畫連接線，也不蓋對方的三角形', () => {
        const p = { x: 100, y: 100 };
        for (const style of ['side', 'price'] as const) {
            const out = layout([pt(100, 100, 'Sell'), pt(100, 100, 'Buy')], { style });
            expect(out.map((m) => [m.action, m.label, m.leader])).toEqual([['Buy', rightAt(p, 0), false], ['Sell', leftAt(p, 0), false]]);
            for (const m of out) for (const o of out) expect(overlap(m.label!, box(o))).toBe(false);
        }
    });

    it('密集時標籤互不重疊、不蓋任何三角形（外接範圍）、留在 pane 內；放不下的只留錨點', () => {
        const pts: FillMarkPoint[] = [];
        for (let i = 0; i < 6; i += 1) {
            for (let j = 0; j < 4; j += 1) pts.push(pt(100 + i * 8, 80 + j * 6, j % 2 ? 'Sell' : 'Buy', 100 + j));
        }
        for (const style of ['side', 'price'] as const) {
            const out = layout(pts, { style });
            expect(out).toHaveLength(pts.length);
            const labels = out.flatMap((m) => (m.label ? [m.label] : []));
            expect(labels.length).toBeGreaterThan(0);
            expect(out.some((m) => m.label === null)).toBe(true);
            for (const a of labels) {
                for (const b of labels) if (a !== b) expect(overlap(a, b)).toBe(false);
                for (const p of out) expect(overlap(a, box(p))).toBe(false);
                expect(a.x).toBeGreaterThanOrEqual(4);
                expect(a.y).toBeGreaterThanOrEqual(4);
                expect(a.x + a.w).toBeLessThanOrEqual(pane.width - 4);
                expect(a.y + a.h).toBeLessThanOrEqual(pane.height - 4);
            }
        }
    });

    it('標籤不得蓋住三角形本體（外接範圍），不只是避開尖端', () => {
        const p = pt(100, 100);
        const sell = pt(115, 110, 'Sell', 90, null); // 賣 ▼ 往上長進 p 右側標籤的高度，尖端在標籤下緣外
        expect(overlap(rightAt(p, 0), box(sell))).toBe(true);
        expect(sell.y - (rightAt(p, 0).y + FILL_LABEL_H)).toBeGreaterThan(FILL_TRI_RING); // 只看尖端（含外框）會以為沒撞到
        expect(layout([p, sell], { style: 'price' }).map((m) => [m.x, m.label])).toEqual([[115, null], [100, leftAt(p, 0)]]);
    });

    it('避開 blocked 矩形（最高／最低標籤）', () => {
        const p = pt(100, 100);
        const blocked = [{ x: 0, y: 95, w: 400, h: 2 }];
        const [m] = layout([p], { blocked });
        expect(overlap(m!.label!, blocked[0]!)).toBe(false);
        expect(m!.label).toEqual(rightAt(p, -1));
    });

    it('畫面內超過上限組數或 K 棒太窄：整層只畫錨點', () => {
        const many = Array.from({ length: FILL_LABEL_MAX + 1 }, (_, i) => pt(i * 3, 100));
        const dense = layout(many);
        expect(dense).toHaveLength(FILL_LABEL_MAX + 1);
        expect(dense.every((m) => m.label === null && !m.leader)).toBe(true);
        // 畫面外的點不算數
        expect(layout([...many.slice(0, FILL_LABEL_MAX), pt(-5, 100)]).some((m) => m.label)).toBe(true);
        expect(layout([pt(100, 100)], { barWidth: FILL_MIN_BAR_PX - 0.1 })[0]!.label).toBeNull();
        expect(layout([pt(100, 100)], { barWidth: FILL_MIN_BAR_PX })[0]!.label).not.toBeNull();
    });

    it('三角形樣式、或該組沒有字串（null）時只留錨點，也不量字寬', () => {
        const tw = vi.fn(textWidth);
        const pts = [pt(100, 100), pt(200, 100, 'Sell')];
        expect(layoutFillMarks(pts, pane, { textWidth: tw, style: 'dot' }).map((m) => [m.x, m.label, m.leader]))
            .toEqual([[200, null, false], [100, null, false]]);
        expect(layoutFillMarks([pt(100, 100, 'Buy', 100, null)], pane, { textWidth: tw, style: 'price' })[0]).toMatchObject({ label: null, leader: false });
        expect(tw).not.toHaveBeenCalled();
    });

    it('標籤寬度依各組字串量測（字寬 ＋ 左右內距）', () => {
        const tw = vi.fn(textWidth);
        const p = pt(100, 100, 'Buy', 46459, '46,459 3口');
        expect(layoutFillMarks([p], pane, { textWidth: tw, style: 'price' })[0]!.label).toEqual(rightAt(p, 0, 9 * 11 + FILL_LABEL_PAD_X * 2));
        expect(tw).toHaveBeenCalledWith('46,459 3口');
    });

    it('處理順序固定（x 由大到小、同棒買先於賣、價格），與輸入順序無關且不改動輸入', () => {
        const pts = [pt(100, 100, 'Sell', 101), pt(100, 100, 'Buy', 101), pt(100, 95, 'Buy', 102), pt(92, 100, 'Sell', 100)];
        const a = layout(pts);
        expect(layout([...pts].reverse())).toEqual(a);
        expect(a.map((m) => [m.x, m.action, m.price])).toEqual([[100, 'Buy', 101], [100, 'Buy', 102], [100, 'Sell', 101], [92, 'Sell', 100]]);
        expect(pts[0]!.action).toBe('Sell');
    });

    it('最新優先：右邊（較新）的那組先拿到偏好側，較舊的那組讓到另一側', () => {
        const older = pt(100, 100);
        const newer = pt(110, 110);
        for (const pts of [[older, newer], [newer, older]]) {
            expect(layout(pts, { style: 'price' }).map((m) => [m.x, m.label])).toEqual([
                [110, rightAt(newer, 0)],
                [100, leftAt(older, 0)],
            ]);
        }
    });

    it('淡色分組不排標籤，但它的三角形仍是障礙，別組的標籤不得蓋住', () => {
        const dim = { ...pt(110, 100), dimmed: true };
        const p = pt(100, 100);
        const out = layout([p, dim], { style: 'price' });
        expect(out.map((m) => [m.x, m.label])).toEqual([[110, null], [100, leftAt(p, 0)]]);
        expect(overlap(rightAt(p, 0), box(dim))).toBe(true); // 右側本來會蓋到淡色三角形
    });
});

describe('highLowAvoid', () => {
    it('右側放得下或在左半邊取右側；右半邊放不下時兩側都避開', () => {
        expect(highLowAvoid([{ x: 100, labelY: 50 }], pane)).toEqual([{ x: 103, y: 41, w: 120, h: 18 }]);
        expect(highLowAvoid([{ x: 100, labelY: 50 }], { width: 210, height: 200 })).toEqual([{ x: 103, y: 41, w: 120, h: 18 }]);
        expect(highLowAvoid([{ x: 350, labelY: 50 }], pane)).toEqual([
            { x: 350 - 3 - 120, y: 41, w: 120, h: 18 },
            { x: 353, y: 41, w: 120, h: 18 },
        ]);
        expect(highLowAvoid([], pane)).toEqual([]);
    });
    it('垂直照最高／最低 renderer 夾回 pane：標記貼近上緣、下緣時矩形跟著夾回', () => {
        const [top] = highLowAvoid([{ x: 100, labelY: 2 }], pane);
        const [bottom] = highLowAvoid([{ x: 100, labelY: 199 }], pane);
        expect(top).toEqual({ x: 103, y: 3, w: 120, h: 18 });
        expect(bottom).toEqual({ x: 103, y: 179, w: 120, h: 18 });
        // 與 layoutMark 夾回後的實際標籤框一致（上下各多 1px）
        const box = (labelY: number) => layoutMark(100, labelY, 60, pane, labelY);
        expect(top!.y).toBe(box(2).boxY - 1);
        expect(bottom!.y + bottom!.h).toBe(box(199).boxY + box(199).boxH + 1);
    });
    it('最高、最低都被夾到下緣疊在一起時，跟著 resolveOverlap 把最高往上錯開（錯開前的位置也避開）', () => {
        const high = layoutMark(100, 184, 60, pane, 184);
        const low = layoutMark(100, 202, 60, pane, 202);
        const before = high.boxY;
        resolveOverlap(high, low, pane.height);
        expect(high.boxY).toBeLessThan(before);
        expect(highLowAvoid([{ x: 100, labelY: 184 }, { x: 100, labelY: 202 }], pane)).toEqual([
            { x: 103, y: before - 1, w: 120, h: 18 },
            { x: 103, y: high.boxY - 1, w: 120, h: 18 },
            { x: 103, y: low.boxY - 1, w: 120, h: 18 },
        ]);
        // 沒疊在一起就不多出矩形
        expect(highLowAvoid([{ x: 100, labelY: 40 }, { x: 100, labelY: 120 }], pane)).toHaveLength(2);
    });
});

describe('FillMarksLayer', () => {
    // 每分鐘 10px、價格 y = 200 − price
    function setup(opts: { range?: { from: number; to: number } | null; logical?: { from: number; to: number } | null;
        price?: (p: number) => number | null; time?: (t: number) => number | null } = {}) {
        const requestUpdate = vi.fn();
        const timeScale = {
            getVisibleRange: () => (opts.range === undefined ? { from: 0, to: 6000 } : opts.range),
            getVisibleLogicalRange: () => (opts.logical === undefined ? { from: 0, to: 40 } : opts.logical),
            timeToCoordinate: vi.fn((t: number) => (opts.time ? opts.time(t) : (t / 60) * 10 + 50)),
        };
        const series = { priceToCoordinate: (p: number) => (opts.price ? opts.price(p) : 200 - p) };
        const layer = new FillMarksLayer();
        layer.attached({ series, chart: { timeScale: () => timeScale }, requestUpdate } as never);
        layer.setStyle({ up: '#f00', down: '#0f0', labelBg: '#111' });
        return { layer, requestUpdate, timeScale };
    }
    type Call = { op: string; args: any[]; fillStyle: unknown; strokeStyle: unknown; alpha: unknown; lineWidth: unknown; lineJoin: unknown };
    function canvas(opts: { roundRect?: boolean } = {}) {
        const calls: Call[] = [];
        const measured: string[] = [];
        const ctx: any = new Proxy({}, {
            get: (t: any, p: string) => {
                if (p === 'roundRect' && opts.roundRect === false) return undefined; // 舊版 WebView
                if (p === 'measureText') return (s: string) => { measured.push(s); return { width: s.length * 11 }; };
                if (p in t) return t[p];
                return (...args: any[]) => {
                    calls.push({ op: p, args, fillStyle: t.fillStyle, strokeStyle: t.strokeStyle, alpha: t.globalAlpha, lineWidth: t.lineWidth, lineJoin: t.lineJoin });
                };
            },
            set: (t: any, p, v) => { t[p] = v; return true; },
        });
        return { ctx, calls, measured };
    }
    function draw(layer: FillMarksLayer, ctx: unknown, mediaSize = { width: 400, height: 200 }) {
        const target = { useMediaCoordinateSpace: vi.fn((f: any) => f({ context: ctx, mediaSize })) };
        layer.paneViews()[0]!.renderer()!.draw(target as never);
        return target;
    }
    // 三角形路徑（moveTo＋兩個 lineTo）在 fill／stroke 那一刻的頂點與畫筆狀態
    function triangles(calls: Call[], op: 'fill' | 'stroke') {
        const out: { pts: number[][]; call: Call }[] = [];
        let path: number[][] = [];
        for (const c of calls) {
            if (c.op === 'beginPath') path = [];
            else if (c.op === 'moveTo' || c.op === 'lineTo') path.push(c.args);
            else if (c.op === op && path.length === 3) out.push({ pts: path, call: c });
        }
        return out;
    }
    const groups = [
        { key: 'a', time: 600, price: 120, action: 'Buy' as const, text: '買' }, // (150, 80)
        { key: 'b', time: 600, price: 100, action: 'Sell' as const, text: '賣' }, // (150, 100)
        { key: 'c', time: 1200, price: 100, action: 'Buy' as const, text: '買' }, // (250, 100)
        { key: 'd', time: 1800, price: 250, action: 'Buy' as const, text: '買' }, // (350, −50)：價格在畫面外
    ];

    it('三角形尖端在成交價（買 ▲ 往下、賣 ▼ 往上），外框用標籤底色先描邊；標籤寫 hook 給的字串並用買賣色', () => {
        const { layer, requestUpdate } = setup();
        layer.setGroups(groups.map((g) => (g.key === 'b' ? { ...g, text: '100 2口' } : g)));
        expect(requestUpdate).toHaveBeenCalled();
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        // 由右到左：c、a（買）、b（賣）；600 那根又買又賣：買右移、賣左移 FILL_SPLIT_PX
        const fills = triangles(calls, 'fill');
        expect(fills.map(({ pts, call }) => [...pts, call.fillStyle, call.alpha])).toEqual([
            [[250, 100], [254, 107], [246, 107], '#f00', 1],
            [[152, 80], [156, 87], [148, 87], '#f00', 1],
            [[148, 100], [152, 93], [144, 93], '#0f0', 1],
        ]);
        // 外框：同一路徑用標籤底色描邊，線寬 = 外框 × 2（內側一半被填色蓋掉），圓角接點免得尖端外凸
        const rings = triangles(calls, 'stroke');
        expect(rings.map(({ pts }) => pts)).toEqual(fills.map(({ pts }) => pts));
        for (const { call } of rings) expect([call.strokeStyle, call.lineWidth, call.lineJoin]).toEqual(['#111', FILL_TRI_RING * 2, 'round']);
        expect(calls.indexOf(rings[rings.length - 1]!.call)).toBeLessThan(calls.indexOf(fills[0]!.call));
        // 同一高度不畫連接線：moveTo 只有三角形外框、填色兩趟
        expect(calls.filter((c) => c.op === 'moveTo')).toHaveLength(fills.length * 2);
        // 價位樣式（預設）：買在右、賣在左，同一高度；字串照 hook 給的畫，寬度依字串量
        expect(calls.filter((c) => c.op === 'fillText').map((c) => [...c.args, c.fillStyle])).toEqual([
            ['買', 250 + SIDE + FILL_LABEL_PAD_X, 100.5, '#f00'],
            ['買', 152 + SIDE + FILL_LABEL_PAD_X, 80.5, '#f00'],
            ['100 2口', 148 - SIDE - (6 * 11 + FILL_LABEL_PAD_X * 2) + FILL_LABEL_PAD_X, 100.5, '#0f0'],
        ]);
    });

    it('字寬以字串為鍵快取：重畫不重量；換樣式或字型才清掉，換顏色或設成同一樣式不清', () => {
        const { layer } = setup();
        layer.setGroups(groups);
        const { ctx, measured } = canvas();
        draw(layer, ctx);
        expect(ctx.font).toBe(FILL_FONT);
        draw(layer, ctx);
        expect(measured).toEqual(['買', '賣']);
        layer.setStyle({ up: '#123', down: '#456', labelBg: '#000' });
        layer.setStyle({ style: 'price' }); // 預設就是 price
        draw(layer, ctx);
        expect(measured).toEqual(['買', '賣']);
        layer.setStyle({ style: 'side' });
        draw(layer, ctx);
        expect(measured).toEqual(['買', '賣', '買', '賣']);
        layer.setStyle({ font: '600 12px sans-serif' });
        draw(layer, ctx);
        expect(ctx.font).toBe('600 12px sans-serif');
        expect(measured).toEqual(['買', '賣', '買', '賣', '買', '賣']);
    });

    it('沒有成交時不碰畫布；沒有可見範圍時不畫', () => {
        const { layer } = setup({ range: null });
        const { ctx, calls } = canvas();
        expect(draw(layer, ctx).useMediaCoordinateSpace).not.toHaveBeenCalled();
        layer.setGroups(groups);
        draw(layer, ctx);
        expect(calls).toEqual([]);
        expect(layer.hitAt(150, 80, 600)).toBeNull();
    });

    it('每幀只走可見時間範圍內的組', () => {
        const { layer, timeScale } = setup({ range: { from: 1200, to: 1800 } });
        // 輸入不照時間排（二分搜尋靠 setGroups 自己排序）
        layer.setGroups(Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, time: (49 - i) * 60, price: 100, action: 'Buy' as const, text: '買' })));
        draw(layer, canvas().ctx);
        expect(timeScale.timeToCoordinate.mock.calls.map((c) => c[0])).toEqual(Array.from({ length: 11 }, (_, i) => 1200 + i * 60));
    });

    it('K 棒寬 = pane 寬 ÷（logical 長度 + 1），比 3px 窄只畫錨點（仍是三角形）；沒有 logical range 不限制', () => {
        const texts = (logical: { from: number; to: number } | null) => {
            const { layer } = setup({ logical });
            layer.setGroups(groups);
            const { ctx, calls } = canvas();
            draw(layer, ctx);
            expect(triangles(calls, 'fill')).toHaveLength(3);
            expect(calls.filter((c) => c.op === 'arc')).toHaveLength(0);
            return calls.filter((c) => c.op === 'fillText').length;
        };
        expect(texts({ from: 0, to: 133 })).toBe(0); // 400 ÷ 134 ≈ 2.99（少加 1 會算成 3.01）
        expect(texts({ from: 0, to: 132 })).toBe(3); // 400 ÷ 133 ≈ 3.01
        expect(texts(null)).toBe(3);
    });

    it('三角形樣式：只畫三角形，不畫標籤也不量字寬', () => {
        const { layer } = setup();
        layer.setStyle({ style: 'dot' });
        layer.setGroups(groups);
        const { ctx, calls, measured } = canvas();
        draw(layer, ctx);
        expect(triangles(calls, 'fill')).toHaveLength(3);
        expect(calls.filter((c) => c.op === 'fillText' || c.op === 'roundRect')).toEqual([]);
        expect(measured).toEqual([]);
    });

    it('買／賣樣式避開 setAvoid 的範圍，往上錯開並畫短連接線', () => {
        const { layer } = setup();
        layer.setStyle({ style: 'side' });
        layer.setGroups([groups[0]!]);
        layer.setAvoid(() => [{ x: 150, y: 72, w: 100, h: 16 }]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        const labelY = 80 - FILL_LABEL_H / 2 - FILL_LABEL_STEP;
        expect(calls.find((c) => c.op === 'fillText')!.args).toEqual(['買', 150 + SIDE + FILL_LABEL_PAD_X, labelY + FILL_LABEL_H / 2 + 0.5]);
        expect(calls.find((c) => c.op === 'moveTo')!.args).toEqual([150, 80]);
        expect(calls.find((c) => c.op === 'lineTo')!.args).toEqual([150 + SIDE, labelY + FILL_LABEL_H / 2]);
    });

    it('左側標籤的連接線連到標籤靠錨點那一側（label.x + label.w）', () => {
        const { layer } = setup();
        layer.setStyle({ style: 'side' });
        layer.setGroups([{ key: 's', time: 1200, price: 100, action: 'Sell', text: '賣' }]); // (250, 100)，賣偏好左側
        layer.setAvoid(() => [{ x: 200, y: 95, w: 40, h: 10 }]); // 擋住左側同一高度
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        const labelX = 250 - SIDE - LW;
        const mid = 100 - FILL_LABEL_STEP;
        expect(calls.find((c) => c.op === 'moveTo')!.args).toEqual([250, 100]);
        expect(calls.find((c) => c.op === 'lineTo')!.args).toEqual([labelX + LW, mid]);
        expect(calls.find((c) => c.op === 'fillText')!.args).toEqual(['賣', labelX + FILL_LABEL_PAD_X, mid + 0.5]);
    });

    it('hitAt：直接命中最近的三角形（外接範圍外擴 3px）／標籤 > 同棒 y 最近 > null', () => {
        const { layer } = setup();
        layer.setGroups(groups);
        expect(layer.hitAt(150, 80, 600)).toBeNull(); // 尚未繪製
        draw(layer, canvas().ctx);
        expect(layer.hitAt(152, 84)).toBe('a'); // 在 a（買，往下長）的三角形內
        expect(layer.hitAt(150, 94, 600)).toBe('b'); // 在 b（賣，往上長）的範圍內，離 a 5.5px
        expect(layer.hitAt(170, 76)).toBe('a'); // 在 a 的標籤上
        expect(layer.hitAt(130, 100)).toBe('b'); // 在 b 的標籤上（賣在左側）
        expect(layer.hitAt(265, 100, 600)).toBe('c'); // 直接命中優先於同棒
        // c 的三角形底在 107，外接範圍含外框到 108.5，再外擴 3px（以尖端算 7px 圓會落空）
        expect(layer.hitAt(250, 107 + FILL_TRI_RING + FILL_HIT_MARK_PX)).toBe('c');
        expect(layer.hitAt(250, 107 + FILL_TRI_RING + FILL_HIT_MARK_PX + 0.5)).toBeNull();
        expect(layer.hitAt(150, 30, 600)).toBe('a');
        expect(layer.hitAt(150, 190, 600)).toBe('b');
        expect(layer.hitAt(350, 10, 1800)).toBe('d'); // 價格在畫面外仍可由同棒找到
        expect(layer.hitAt(150, 190)).toBeNull();
        expect(layer.hitAt(50, 30, 9999)).toBeNull();
        layer.setGroups(groups.slice(0, 1));
        expect(layer.hitAt(152, 82, 600)).toBe('a'); // 有資料時沿用上一幀幾何到重繪
        layer.setGroups([]);
        expect(layer.hitAt(152, 82, 600)).toBeNull(); // 清空資料時立即作廢舊幾何
    });

    it('同棒同價買賣：兩個三角形上下分開、尖端都在成交價（買右移、賣左移 2px）；游標在下半命中買、上半命中賣，正好在價位上平手取後畫的賣', () => {
        const { layer } = setup();
        layer.setGroups([
            { key: 'sell', time: 600, price: 120, action: 'Sell', text: '賣' },
            { key: 'buy', time: 600, price: 120, action: 'Buy', text: '買' },
        ]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(triangles(calls, 'fill').map(({ pts, call }) => [...pts, call.fillStyle])).toEqual([
            [[152, 80], [156, 80 + FILL_TRI_H], [148, 80 + FILL_TRI_H], '#f00'], // 買 ▲ 先畫
            [[148, 80], [152, 80 - FILL_TRI_H], [144, 80 - FILL_TRI_H], '#0f0'], // 賣 ▼ 後畫
        ]);
        expect(layer.hitAt(150, 84)).toBe('buy');
        expect(layer.hitAt(150, 76)).toBe('sell');
        expect(layer.hitAt(150, 80)).toBe('sell'); // 平手取後畫的
        expect(layer.hitAt(150, 30, 600)).toBe('sell'); // 同棒備援看三角形的垂直範圍：上方離賣近
        expect(layer.hitAt(150, 190, 600)).toBe('buy'); // 下方離買近
        expect(layer.hitAt(158, 80)).toBe('buy'); // 買的標籤在右
        expect(layer.hitAt(142, 80)).toBe('sell'); // 賣的標籤在左
    });

    it('淡色分組（待確認時保留的上次分組）：只畫三角形、透明度 0.4、不畫標籤、不可命中', () => {
        const { layer } = setup();
        layer.setGroups([
            { key: 'old', time: 600, price: 120, action: 'Buy', text: '買', dimmed: true }, // (150, 80)
            { key: 'new', time: 1200, price: 100, action: 'Buy', text: '買' }, // (250, 100)
        ]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        for (const op of ['stroke', 'fill'] as const) {
            expect(triangles(calls, op).map(({ pts, call }) => [pts[0], call.alpha])).toEqual([[[250, 100], 1], [[150, 80], FILL_DIM_ALPHA]]);
        }
        expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[1])).toEqual([250 + SIDE + FILL_LABEL_PAD_X]);
        expect(layer.hitAt(150, 82)).toBeNull();
        expect(layer.hitAt(150, 82, 600)).toBeNull(); // 同棒備援也不找淡色
        expect(layer.hitAt(250, 102)).toBe('new');
    });

    it('setGroups 與 setStyle 各自要求重繪；detached 之後不再要求、不畫、命中幾何清空', () => {
        const { layer, requestUpdate } = setup();
        requestUpdate.mockClear();
        layer.setGroups(groups);
        expect(requestUpdate).toHaveBeenCalledTimes(1);
        requestUpdate.mockClear();
        layer.setStyle({ up: '#111' });
        expect(requestUpdate).toHaveBeenCalledTimes(1);
        draw(layer, canvas().ctx);
        expect(layer.hitAt(152, 82)).toBe('a');
        layer.detached();
        expect(layer.hitAt(152, 82, 600)).toBeNull();
        requestUpdate.mockClear();
        layer.setGroups(groups);
        layer.setStyle({ up: '#222' });
        expect(requestUpdate).not.toHaveBeenCalled();
        const after = canvas();
        draw(layer, after.ctx);
        expect(after.calls).toEqual([]);
    });

    it('座標轉換失敗（null）的成交不畫也不命中，不會被畫在 (0,0)', () => {
        const { layer } = setup({ price: (p) => (p === 120 ? null : 200 - p), time: (t) => (t === 1200 ? null : (t / 60) * 10 + 50) });
        layer.setGroups(groups); // a（價格 120）與 c（時間 1200）轉換失敗；d 價格在畫面外
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(triangles(calls, 'fill').map(({ pts }) => pts[0])).toEqual([[150, 100]]); // 只剩 b
        expect(layer.hitAt(0, 0, 600)).toBe('b'); // 同棒備援也只會找到轉換成功的
        expect(layer.hitAt(250, 100, 1200)).toBeNull();
    });

    it('標籤用 roundRect 畫，舊版 WebView 沒有 roundRect 時退回 rect', () => {
        const modern = setup();
        modern.layer.setGroups([groups[0]!]);
        const a = canvas();
        draw(modern.layer, a.ctx);
        // 錨點 (150, 80) 右側：標籤 x = 150 + 4 + 3、寬 11 + 2 × 4、y = 80 − 7.5、高 15（外框內縮 0.5）
        expect(a.calls.filter((c) => c.op === 'roundRect').map((c) => c.args)).toEqual([[157.5, 73, 18, 14, 3]]);
        expect(a.calls.filter((c) => c.op === 'rect')).toHaveLength(0);
        const legacy = setup();
        legacy.layer.setGroups([groups[0]!]);
        const b = canvas({ roundRect: false });
        expect(() => draw(legacy.layer, b.ctx)).not.toThrow();
        expect(b.calls.filter((c) => c.op === 'rect').map((c) => c.args)).toEqual([[157.5, 73, 18, 14]]);
        expect(b.calls.filter((c) => c.op === 'roundRect')).toHaveLength(0);
        expect(b.calls.filter((c) => c.op === 'fillText')).toHaveLength(1);
    });

    it('設計常數（規格寫死的數字）', () => {
        expect({ w: FILL_TRI_W, h: FILL_TRI_H, ring: FILL_TRI_RING, edge: FILL_EDGE_PX, labelH: FILL_LABEL_H, pad: FILL_LABEL_PAD_X,
            step: FILL_LABEL_STEP, max: FILL_LABEL_MAX, minBar: FILL_MIN_BAR_PX, hitMark: FILL_HIT_MARK_PX, hitLabel: FILL_HIT_LABEL_PX,
            dim: FILL_DIM_ALPHA, font: FILL_FONT })
            .toEqual({ w: 8, h: 7, ring: 1.5, edge: 4, labelH: 15, pad: 4, step: 17, max: 120, minBar: 3, hitMark: 3, hitLabel: 2,
                dim: 0.4, font: '600 11px sans-serif' });
    });

    it('不攔截圖表事件、不影響價格縮放；畫在最上層', () => {
        const layer = new FillMarksLayer();
        expect('hitTest' in layer).toBe(false);
        expect('autoscaleInfo' in layer).toBe(false);
        expect('priceAxisViews' in layer).toBe(false);
        expect(layer.paneViews()[0]!.zOrder?.()).toBe('top');
        // 尚未 attach 也能安全呼叫
        layer.setGroups(groups);
        layer.setStyle({ up: '#f00', style: 'side' });
        expect(layer.hitAt(0, 0, 600)).toBeNull();
    });

    // 多價位組：同一根 K 棒同方向 4 個價位（600 → x 150；價格 100～120 → y 100～80），均價 108（y 92）
    const bundle = (over: Record<string, unknown> = {}) => ({
        key: 'B', time: 600, price: 100, action: 'Buy' as const, text: '均 108 4口', labelPrice: 108,
        members: [100, 105, 110, 120].map((price) => ({ key: `b${price}`, price })), ...over,
    });
    // stroke 那一刻的整條路徑（moveTo／lineTo 依序）與畫筆狀態
    function strokes(calls: Call[]) {
        const out: { path: (string | number)[][]; call: Call }[] = [];
        let path: (string | number)[][] = [];
        for (const c of calls) {
            if (c.op === 'beginPath') path = [];
            else if (c.op === 'moveTo' || c.op === 'lineTo') path.push([c.op, ...c.args]);
            else if (c.op === 'stroke') out.push({ path, call: c });
        }
        return out;
    }
    const rangePath = (x: number, dir: 1 | -1, ys: number[]) => [['moveTo', x, ys[0]!], ['lineTo', x, ys[ys.length - 1]!],
        ...ys.flatMap((y) => [['moveTo', x, y], ['lineTo', x + dir * FILL_TICK_W, y]])];

    it('多價位組：三角形在最低買價、區間線＋每價一條朝右的刻度（先底色寬 3、再方向色寬 1），標籤在均價高度並以短線接回', () => {
        const { layer } = setup();
        layer.setGroups([bundle()]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(triangles(calls, 'fill').map(({ pts }) => pts)).toEqual([[[150, 100], [154, 107], [146, 107]]]);
        const all = strokes(calls);
        const range = all.filter((st) => st.path.length > 4);
        expect(range.map((st) => [st.path, st.call.strokeStyle, st.call.lineWidth])).toEqual([
            [rangePath(150, 1, [100, 95, 90, 80]), '#111', FILL_TRI_RING * 2],
            [rangePath(150, 1, [100, 95, 90, 80]), '#f00', 1],
        ]);
        // 繪製順序：連接線 → 區間線 → 三角形外框 → 填色 → 標籤
        const leader = all.find((st) => st.path.length === 2)!;
        expect(leader.path).toEqual([['moveTo', 150, 92], ['lineTo', 150 + SIDE, 92]]);
        const order = [leader.call, range[0]!.call, triangles(calls, 'stroke')[0]!.call, triangles(calls, 'fill')[0]!.call, calls.find((c) => c.op === 'fillText')!];
        expect(order.map((c) => calls.indexOf(c))).toEqual([...order.map((c) => calls.indexOf(c))].sort((a, b) => a - b));
        expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args)).toEqual([['均 108 4口', 150 + SIDE + FILL_LABEL_PAD_X, 92.5]]);
    });

    it('賣的多價位組：三角形在最高賣價、刻度朝左', () => {
        const { layer } = setup();
        layer.setGroups([bundle({ action: 'Sell', price: 120 })]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(triangles(calls, 'fill').map(({ pts }) => pts)).toEqual([[[150, 80], [154, 73], [146, 73]]]);
        expect(strokes(calls).filter((st) => st.path.length > 4).map((st) => st.path)[0]).toEqual(rangePath(150, -1, [100, 95, 90, 80]));
    });

    it('多價位組的命中：游標在區間線上回傳最近的價位鍵；同棒備援也取最近的價位；淡色不命中', () => {
        const { layer } = setup();
        layer.setGroups([bundle()]);
        draw(layer, canvas().ctx);
        expect(layer.hitAt(150, 91)).toBe('b110');
        expect(layer.hitAt(151, 82)).toBe('b120');
        expect(layer.hitAt(150, 99)).toBe('b100');
        expect(layer.hitAt(150, 10, 600)).toBe('b120'); // 同棒備援：上方最近 120
        expect(layer.hitAt(150, 190, 600)).toBe('b100');
        layer.setGroups([bundle({ dimmed: true })]);
        draw(layer, canvas().ctx);
        expect(layer.hitAt(150, 91)).toBeNull();
        expect(layer.hitAt(150, 91, 600)).toBeNull();
    });

    it('區間線也是障礙：別組的標籤不得蓋住區間線中段', () => {
        const { layer } = setup();
        // 540 → x 140、價格 110 → y 90：右側標籤會壓到 150 那根的區間線，只能放左側
        layer.setGroups([bundle(), { key: 'p', time: 540, price: 110, action: 'Buy', text: '買' }]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        const texts = calls.filter((c) => c.op === 'fillText').map((c) => [c.args[0], c.args[1]]);
        expect(texts).toContainEqual(['買', 140 - SIDE - LW + FILL_LABEL_PAD_X]);
    });

    it('可見性看整組範圍：尖端出界但區間線在畫面內照畫（不排標籤）；整組在畫面外、或任一價位換不出座標就不畫', () => {
        const inside = setup();
        // 價格 −5～10 → y 205～190：尖端在下緣外，區間線一半在畫面內
        inside.layer.setGroups([bundle({ price: -5, labelPrice: 2, members: [{ key: 'x', price: -5 }, { key: 'y', price: 10 }] })]);
        const a = canvas();
        draw(inside.layer, a.ctx);
        expect(strokes(a.calls).some((st) => st.path.length > 4)).toBe(true);
        expect(a.calls.filter((c) => c.op === 'fillText')).toHaveLength(0);
        inside.layer.setGroups([bundle({ price: -20, labelPrice: -15, members: [{ key: 'x', price: -20 }, { key: 'y', price: -10 }] })]);
        const b = canvas();
        draw(inside.layer, b.ctx);
        expect(b.calls.filter((c) => c.op === 'fill' || c.op === 'stroke')).toHaveLength(0);
        const missing = setup({ price: (p) => (p === 105 ? null : 200 - p) });
        missing.layer.setGroups([bundle()]);
        const c = canvas();
        draw(missing.layer, c.ctx);
        expect(c.calls.filter((call) => call.op === 'fill' || call.op === 'stroke')).toHaveLength(0);
        expect(missing.layer.hitAt(150, 92, 600)).toBeNull();
    });

    it('刻度依像素列去重：500 個價位擠在 10px 內，每趟最多 11 條刻度', () => {
        const { layer } = setup();
        const members = Array.from({ length: 500 }, (_, i) => ({ key: `m${i}`, price: 100 + i * 0.02 }));
        layer.setGroups([bundle({ members, labelPrice: 105 })]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        for (const st of strokes(calls).filter((st) => st.path.length > 4)) {
            expect(st.path.filter(([op]) => op === 'moveTo').length - 1).toBeLessThanOrEqual(11);
        }
    });

    it('K 棒窄於 3px：多價位組每幀只換兩端與標籤的座標，命中仍回傳最近的價位', () => {
        const members = Array.from({ length: 500 }, (_, i) => ({ key: `m${i}`, price: 100 + i * 0.1 }));
        const results: Record<string, (string | null)[]> = {};
        for (const [name, logical] of [['narrow', { from: 0, to: 200 }], ['wide', { from: 0, to: 40 }]] as const) {
            let n = 0;
            const { layer } = setup({ logical, price: (p) => { n += 1; return 200 - p; } });
            layer.setGroups([bundle({ members, labelPrice: 105 })]);
            draw(layer, canvas().ctx);
            if (name === 'narrow') expect(n).toBeLessThanOrEqual(4);
            else expect(n).toBeGreaterThanOrEqual(500);
            results[name] = [100, 95, 90.04, 52, 60.55].map((y) => layer.hitAt(150, y, 600));
        }
        expect(results.narrow).toEqual(results.wide);
        expect(results.narrow).toContain('m100');
    });

    it('K 棒窄於 3px 不畫區間線與刻度，只畫三角形', () => {
        const { layer } = setup({ logical: { from: 0, to: 200 } });
        layer.setGroups([bundle()]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(strokes(calls).filter((st) => st.path.length > 4)).toHaveLength(0);
        expect(triangles(calls, 'fill')).toHaveLength(1);
    });

    it('同一根又買又賣：買整組（含區間線）右移 2px、賣左移 2px；只有一個方向不移', () => {
        const { layer } = setup();
        layer.setGroups([bundle(), { key: 's', time: 600, price: 130, action: 'Sell', text: '賣' }, { key: 'c', time: 1200, price: 100, action: 'Buy', text: '買' }]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(FILL_SPLIT_PX).toBe(2);
        expect(triangles(calls, 'fill').map(({ pts }) => pts[0])).toEqual([[250, 100], [152, 100], [148, 70]]);
        expect(strokes(calls).filter((st) => st.path.length > 4)[0]!.path).toEqual(rangePath(152, 1, [100, 95, 90, 80]));
    });

    it('字寬快取有上限：不同字串累積超過上限就清掉重量，不會一直長大', () => {
        const { layer } = setup();
        for (let round = 0; round < 6; round += 1) {
            // 100 組都在畫面內（6 秒一組 → x 50～149），每輪 100 個新字串
            layer.setGroups(Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, time: i * 6, price: 100, action: 'Buy' as const, text: `均 ${round}-${i}` })));
            draw(layer, canvas().ctx);
            expect((layer as unknown as { _textWidth: Map<string, number> })._textWidth.size).toBeLessThanOrEqual(512);
        }
    });
    it('標籤是玻璃：底色半透明讓 K 棒透出來，字先用底色描一圈再上色（壓在 K 棒上也讀得清楚）', () => {
        const { layer } = setup();
        layer.setGroups([{ key: 'a', time: 600, price: 120, action: 'Buy', text: '120' }]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        expect(FILL_LABEL_GLASS_ALPHA).toBe(0.5);
        expect(calls.find((c) => c.op === 'fill' && c.fillStyle === '#111')!.alpha).toBe(FILL_LABEL_GLASS_ALPHA);
        const halo = calls.find((c) => c.op === 'strokeText')!;
        expect([halo.args[0], halo.strokeStyle, halo.lineWidth]).toEqual(['120', '#111', 3]);
        expect(calls.indexOf(halo)).toBeLessThan(calls.findIndex((c) => c.op === 'fillText'));
    });

    it('同一根 K 棒買區間與賣三角形都在游標高度時，取後畫的賣', () => {
        const { layer } = setup();
        layer.setGroups([bundle(), { key: 's', time: 600, price: 110, action: 'Sell', text: '賣' }]);
        draw(layer, canvas().ctx);
        expect(layer.hitAt(390, 90, 600)).toBe('s');
    });
    it('區間線遠端也算錨點範圍：買的上端、賣的下端各外擴外框＋命中容差，取最近的價位', () => {
        const buy = setup().layer;
        buy.setGroups([bundle()]);
        draw(buy, canvas().ctx);
        expect(buy.hitAt(150, 80 - FILL_TRI_RING - FILL_HIT_MARK_PX)).toBe('b120');
        const sell = setup().layer;
        sell.setGroups([bundle({ action: 'Sell', price: 120 })]);
        draw(sell, canvas().ctx);
        expect(sell.hitAt(150, 100 + FILL_TRI_RING + FILL_HIT_MARK_PX)).toBe('b100');
    });
    it('淡色的多價位組：區間線與刻度也是淡色', () => {
        const { layer } = setup();
        layer.setGroups([bundle({ dimmed: true })]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        const range = strokes(calls).filter(({ path }) => path.length > 4);
        expect(range).toHaveLength(2);
        for (const { call } of range) expect(call.alpha).toBe(FILL_DIM_ALPHA);
    });
    it('標籤外框用買賣色、不透明', () => {
        const { layer } = setup();
        layer.setGroups([{ key: 'a', time: 600, price: 120, action: 'Buy', text: '買' }]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        const border = calls.slice(calls.findIndex((c) => c.op === 'roundRect')).find((c) => c.op === 'stroke')!;
        expect([border.strokeStyle, border.alpha]).toEqual(['#f00', 1]);
    });

    // 形狀（三角形／箭頭／圓點／菱形）：外接範圍相同，只有路徑不同
    const SHAPES: readonly FillMarkShape[] = ['triangle', 'arrow', 'circle', 'diamond'];
    // groups 畫出來的三個錨點（由右到左：c、a、b；600 那根又買又賣，買右移、賣左移 FILL_SPLIT_PX）
    const ANCHORS = [{ x: 250, y: 100, action: 'Buy' }, { x: 152, y: 80, action: 'Buy' }, { x: 148, y: 100, action: 'Sell' }] as const;
    // 每個標記路徑在 fill／stroke 那一刻經過的點；圓（arc）取上下左右四個極點
    function markPaths(calls: Call[], op: 'fill' | 'stroke') {
        const out: number[][][] = [];
        let path: number[][] = [];
        for (const c of calls) {
            if (c.op === 'beginPath') path = [];
            else if (c.op === 'moveTo' || c.op === 'lineTo') path.push(c.args);
            else if (c.op === 'arc') {
                const [x, y, r] = c.args as [number, number, number];
                path.push([x - r, y], [x, y - r], [x + r, y], [x, y + r]);
            } else if (c.op === op && path.length) out.push(path);
        }
        return out;
    }
    const drawShape = (shape: FillMarkShape | undefined, style: FillMarkStyle) => {
        const { layer, requestUpdate } = setup();
        layer.setStyle(shape ? { style, shape } : { style });
        layer.setGroups(groups);
        const { ctx, calls, measured } = canvas();
        draw(layer, ctx);
        return { layer, requestUpdate, ctx, calls, measured };
    };

    it.each(SHAPES)('形狀 %s：路徑落在三角形的外接範圍內（寬 FILL_TRI_W、高 FILL_TRI_H）、上下頂滿，買的頂端與賣的底端都在成交價；外框描同一條路徑', (shape) => {
        // 不標文字：畫布上的 fill／stroke 只有標記本身
        const { calls } = drawShape(shape, 'dot');
        const fills = markPaths(calls, 'fill');
        expect(fills).toHaveLength(ANCHORS.length);
        fills.forEach((pts, i) => {
            const p = ANCHORS[i]!;
            const xs = pts.map(([x]) => x!), ys = pts.map(([, y]) => y!);
            const top = p.action === 'Buy' ? p.y : p.y - FILL_TRI_H; // 買往下長、賣往上長
            expect(Math.min(...xs)).toBeGreaterThanOrEqual(p.x - FILL_TRI_W / 2);
            expect(Math.max(...xs)).toBeLessThanOrEqual(p.x + FILL_TRI_W / 2);
            expect(Math.min(...xs) + Math.max(...xs)).toBe(p.x * 2); // 左右對稱於那根 K 棒
            expect([Math.min(...ys), Math.max(...ys)]).toEqual([top, top + FILL_TRI_H]);
            // 含外框（描邊一半在外）也不超出版面與命中用的外接範圍
            const b = box(p);
            expect(Math.min(...xs) - FILL_TRI_RING).toBeGreaterThanOrEqual(b.x);
            expect(Math.max(...xs) + FILL_TRI_RING).toBeLessThanOrEqual(b.x + b.w);
            expect([Math.min(...ys) - FILL_TRI_RING, Math.max(...ys) + FILL_TRI_RING]).toEqual([b.y, b.y + b.h]);
        });
        // 外框：同一條路徑先用標籤底色描邊（線寬 = 外框 × 2、圓角接點），三個都描完才開始填色
        const firstFill = calls.findIndex((c) => c.op === 'fill');
        const rings = calls.slice(0, firstFill);
        expect(markPaths(rings, 'stroke')).toEqual(fills);
        expect(rings.filter((c) => c.op === 'stroke').map((c) => [c.strokeStyle, c.lineWidth, c.lineJoin])).toEqual(ANCHORS.map(() => ['#111', FILL_TRI_RING * 2, 'round']));
    });

    it.each(SHAPES)('形狀 %s 的填色：買一律實心；圓點與菱形沒有方向，賣畫空心（填標籤底色、再用賣色描 FILL_TRI_RING 寬的邊），三角形與箭頭的賣照舊實心', (shape) => {
        const { calls } = drawShape(shape, 'dot');
        const hollow = shape === 'circle' || shape === 'diamond';
        // 由右到左：c、a（買）、b（賣）
        const fills = calls.filter((c) => c.op === 'fill');
        expect(fills.map((c) => [c.fillStyle, c.alpha])).toEqual([['#f00', 1], ['#f00', 1], [hollow ? '#111' : '#0f0', 1]]);
        // 填色開始之後的描邊：只有空心的賣方那一筆，買方與有方向的形狀都沒有
        const edges = calls.slice(calls.indexOf(fills[0]!)).filter((c) => c.op === 'stroke');
        expect(edges.map((c) => [c.strokeStyle, c.lineWidth, c.alpha])).toEqual(hollow ? [['#0f0', FILL_TRI_RING, 1]] : []);
        if (hollow) {
            // 描的就是剛填的那條路徑：緊接在賣方的填色後面
            expect(calls.indexOf(edges[0]!)).toBe(calls.indexOf(fills[2]!) + 1);
            expect(markPaths(calls, 'stroke').at(-1)).toEqual(markPaths(calls, 'fill').at(-1));
        }
    });

    it('空心的賣方在淡色分組（待確認時保留的上次分組）裡：外框、填色、描邊都是透明度 0.4；之後的標籤線寬回到 1', () => {
        const { layer } = setup();
        layer.setStyle({ shape: 'diamond' });
        layer.setGroups([
            { key: 'old', time: 600, price: 100, action: 'Sell', text: '賣', dimmed: true }, // (150, 100)
            { key: 'new', time: 1200, price: 100, action: 'Sell', text: '賣' }, // (250, 100)
        ]);
        const { ctx, calls } = canvas();
        draw(layer, ctx);
        const label = calls.findIndex((c) => c.op === 'roundRect');
        // 由右到左：new、old；外框兩趟 → 每個標記填底色再描賣色
        expect(calls.slice(0, label).filter((c) => c.op === 'fill' || c.op === 'stroke').map((c) => [c.op, c.op === 'fill' ? c.fillStyle : c.strokeStyle, c.lineWidth, c.alpha])).toEqual([
            ['stroke', '#111', FILL_TRI_RING * 2, 1], ['stroke', '#111', FILL_TRI_RING * 2, FILL_DIM_ALPHA],
            ['fill', '#111', FILL_TRI_RING, 1], ['stroke', '#0f0', FILL_TRI_RING, 1],
            ['fill', '#111', FILL_TRI_RING, FILL_DIM_ALPHA], ['stroke', '#0f0', FILL_TRI_RING, FILL_DIM_ALPHA],
        ]);
        // 只有沒淡化的那一組有標籤；標籤的框線不沿用空心描邊的線寬
        const border = calls.slice(label).find((c) => c.op === 'stroke')!;
        expect([border.strokeStyle, border.lineWidth, border.alpha]).toEqual(['#0f0', 1, 1]);
        expect(calls.filter((c) => c.op === 'roundRect')).toHaveLength(1);
    });

    it('各形狀的路徑：圓點用 arc（圓心在高度中點、直徑 = FILL_TRI_H），三角形 3 點、菱形 4 點、箭頭 7 點都不用 arc；四種路徑互不相同', () => {
        const drawn = Object.fromEntries(SHAPES.map((shape) => [shape, drawShape(shape, 'dot').calls])) as Record<FillMarkShape, Call[]>;
        const points = (shape: FillMarkShape) => drawn[shape].filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => c.args);
        const arcs = (shape: FillMarkShape) => drawn[shape].filter((c) => c.op === 'arc').map((c) => c.args);
        // 圓點：外框、填色各一趟，沒有折線
        const circles = ANCHORS.map((p) => [p.x, p.y + (p.action === 'Buy' ? 1 : -1) * FILL_TRI_H / 2, FILL_TRI_H / 2, 0, Math.PI * 2]);
        expect(arcs('circle')).toEqual([...circles, ...circles]);
        expect(points('circle')).toEqual([]);
        for (const [shape, corners] of [['triangle', 3], ['diamond', 4], ['arrow', 7]] as const) {
            expect(arcs(shape)).toEqual([]);
            expect(points(shape)).toHaveLength(corners * ANCHORS.length * 2);
            // 起點（moveTo）就是成交價那一點：三角形與箭頭的尖端、菱形的頂點
            expect(drawn[shape].filter((c) => c.op === 'moveTo').map((c) => c.args)).toEqual([...ANCHORS, ...ANCHORS].map((p) => [p.x, p.y]));
        }
        // 買的菱形（c）：成交價 → 右 → 底 → 左
        expect(points('diamond').slice(0, 4)).toEqual([[250, 100], [254, 103.5], [250, 107], [246, 103.5]]);
        // 買的箭頭（c）：箭頭高 4、箭身寬 3
        expect(points('arrow').slice(0, 7)).toEqual([[250, 100], [254, 104], [251.5, 104], [251.5, 107], [248.5, 107], [248.5, 104], [246, 104]]);
        const paths = SHAPES.map((shape) => JSON.stringify(markPaths(drawn[shape], 'fill')));
        expect(new Set(paths).size).toBe(SHAPES.length);
    });

    it('沒指定形狀就是三角形：和 setStyle({ shape: \'triangle\' }) 畫出同一串繪圖呼叫', () => {
        const calls = drawShape(undefined, 'price').calls;
        expect(calls).toEqual(drawShape('triangle', 'price').calls);
        expect(triangles(calls, 'fill')).toHaveLength(3);
        expect(calls.filter((c) => c.op === 'arc')).toEqual([]);
    });

    it('換形狀不改變版面與命中：標籤位置、連接線、hitAt 結果四種形狀都一樣；換形狀要求重繪、不清字寬快取', () => {
        const probe = (shape: FillMarkShape) => {
            const { layer, calls } = drawShape(shape, 'side');
            const hits: (string | null)[] = [];
            // 掃過三個標記與標籤附近的每一點，再加同棒備援、價格在畫面外、外接範圍邊界
            for (let x = 120; x <= 290; x += 2) for (let y = 65; y <= 120; y += 1) hits.push(layer.hitAt(x, y));
            hits.push(layer.hitAt(150, 30, 600), layer.hitAt(150, 190, 600), layer.hitAt(350, 10, 1800), layer.hitAt(50, 30, 9999));
            const edge = 107 + FILL_TRI_RING + FILL_HIT_MARK_PX; // c 的外接範圍（含外框）再外擴的下緣
            hits.push(layer.hitAt(250, edge), layer.hitAt(250, edge + 0.5));
            const labels = calls.filter((c) => c.op === 'fillText' || c.op === 'roundRect').map((c) => [c.op, ...c.args]);
            return { hits, labels, edge: hits.slice(-2) };
        };
        const base = probe('triangle');
        expect(new Set(base.hits)).toEqual(new Set(['a', 'b', 'c', 'd', null]));
        expect(base.edge).toEqual(['c', null]);
        expect(base.labels.filter(([op]) => op === 'fillText')).toHaveLength(3);
        for (const shape of SHAPES.slice(1)) expect(probe(shape)).toEqual(base);
        // 換形狀：要求重繪一次；字寬快取留著（重畫不重量）
        const { layer, requestUpdate, measured } = drawShape('triangle', 'side');
        const before = measured.length;
        requestUpdate.mockClear();
        layer.setStyle({ shape: 'circle' });
        expect(requestUpdate).toHaveBeenCalledTimes(1);
        const again = canvas();
        draw(layer, again.ctx);
        expect(again.calls.filter((c) => c.op === 'arc')).toHaveLength(ANCHORS.length * 2);
        expect(again.measured).toEqual([]);
        expect(before).toBeGreaterThan(0);
    });
});
