import { describe, expect, it } from 'vitest';
import { defaultFibOptions } from './chart-drawing-fib';
import {
    channelOffset,
    estimateTextWidth,
    fibPrice,
    fibLabels,
    formatSpan,
    magnetAnchor,
    measureStats,
    nearestDrawingAnchor,
    nearestBarIndex,
    TEXT_FONT_PX,
    type Shape,
    ANCHOR_RADIUS,
    distanceToSegment,
    dragPoints,
    estimateBarSeconds,
    hitTest,
    logicalOfX,
    logicalToTime,
    measureXAxis,
    pickDrawing,
    projectAnchors,
    shapeOf,
    timeToLogical,
    unprojectPoint,
    xOfLogical,
    type PaneSize,
    type Point,
    type Projector,
} from './chart-drawing-geometry';

const MIN = 60;
const DAY = 86400;
const SIZE: PaneSize = { width: 800, height: 400 };

describe('可見範圍命中：未選取的斐波那契不能把指標交給委託線', () => {
    const pts = [{ x: 200, y: 300 }, { x: 500, y: 100 }];
    it('色帶內部命中，關閉色帶後空白處不命中', () => {
        const fib = { ...defaultFibOptions(), showTrend: false };
        expect(hitTest('fib', pts, SIZE, { x: 280, y: 180 }, 0, { fib })).toEqual({ kind: 'body' });
        expect(hitTest('fib', pts, SIZE, { x: 280, y: 180 }, 0, { fib: { ...fib, bandOpacity: 0 } })).toBeNull();
    });
    it.each(['left', 'right'] as const)('外側價位標籤命中（%s）', (labelH) => {
        const fib = { ...defaultFibOptions(), labelH, labelV: 'middle' as const, showTrend: false };
        expect(hitTest('fib', pts, SIZE, { x: labelH === 'left' ? 160 : 550, y: 100 }, 0, { fib })).toEqual({ kind: 'body' });
    });
    it.each(['top', 'middle', 'bottom'] as const)('字級16、百分比、反轉與延伸的全部標籤範圍命中（%s）', (labelV) => {
        const fib = { ...defaultFibOptions(), labelV, fontSize: 16, levelFormat: 'percent' as const, reverse: true, extendLeft: true, extendRight: true };
        const anchors = [{ time: 1, price: 25123.45 }, { time: 2, price: 24123.45 }];
        const shape = shapeOf('fib', pts, SIZE, { fib });
        if (shape?.kind !== 'fib') throw new Error('expected fib');
        const formatPrice = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2 });
        for (const r of fibLabels(shape, fib, anchors, SIZE.width, formatPrice)) {
            for (const at of [{ x: r.left, y: r.top }, { x: r.right, y: r.bottom }]) {
                expect(hitTest('fib', pts, SIZE, at, 0, { fib, anchors, formatPrice })).toEqual({ kind: 'body' });
            }
        }
    });
    it('新工具與粗線的完整範圍命中', () => {
        expect(hitTest('channel', [...pts, { x: 300, y: 330 }], SIZE, { x: 350, y: 280 }, 0)).toEqual({ kind: 'body' });
        expect(hitTest('text', [{ x: 200, y: 100 }], SIZE, { x: 240, y: 140 }, 0, { text: '兩行文字\n中文與abc' })).toEqual({ kind: 'body' });
        expect(hitTest('vertical', [{ x: 200, y: 100 }], SIZE, { x: 202, y: 399 }, 0, { style: { width: 4 } })).toEqual({ kind: 'body' });
    });
});

// 1 分 K：09:00 起連續 5 根
const m1 = [0, 1, 2, 3, 4].map((i) => 32400 + i * MIN);

describe('時間 ↔ logical index', () => {
    it('K 棒格點對應整數 index，棒與棒之間依比例內插', () => {
        expect(timeToLogical(m1, MIN, m1[0]!)).toBe(0);
        expect(timeToLogical(m1, MIN, m1[3]!)).toBe(3);
        // 09:02:30 — 第 2、3 根中間
        expect(timeToLogical(m1, MIN, m1[2]! + 30)).toBeCloseTo(2.5, 10);
    });

    it('超出兩端以每棒秒數等距外推 — 最後一根右邊的空白區也有座標', () => {
        expect(timeToLogical(m1, MIN, m1[4]! + 2 * MIN)).toBeCloseTo(6, 10);
        expect(timeToLogical(m1, MIN, m1[0]! - MIN)).toBeCloseTo(-1, 10);
    });

    it('缺口內的時間被壓進缺口 — 夜盤／假日不會把線甩到畫面外', () => {
        // 兩根之間隔了 8 小時（收盤到夜盤）
        const gapped = [0, 8 * 3600].map((d) => 32400 + d);
        const mid = 32400 + 4 * 3600;
        expect(timeToLogical(gapped, MIN, mid)).toBeCloseTo(0.5, 10);
    });

    it('logicalToTime 是 timeToLogical 的反函式（含兩端外推）', () => {
        for (const t of [m1[0]! - 3 * MIN, m1[0]!, m1[2]! + 20, m1[4]!, m1[4]! + 5 * MIN]) {
            const l = timeToLogical(m1, MIN, t);
            expect(logicalToTime(m1, MIN, l)).toBeCloseTo(t, 6);
        }
    });

    it('沒有 K 棒時回 NaN，呼叫端據此跳過投影', () => {
        expect(timeToLogical([], MIN, 123)).toBeNaN();
        expect(logicalToTime([], MIN, 1)).toBeNaN();
    });

    it('每棒秒數取中位數 — 不被夜盤大缺口拉走', () => {
        expect(estimateBarSeconds([0, 60, 120, 40000, 40060])).toBe(60);
        expect(estimateBarSeconds([5])).toBe(60); // 資料不足時的保守預設
    });
});

describe('跨週期保持同一個時間／價格位置（issue #122 三）', () => {
    // 同一個錨點時間（第 3 天收盤那一刻）在 1 分圖與日線圖上
    const day3 = 3 * DAY;
    const daily = [0, 1, 2, 3, 4].map((i) => i * DAY);
    const minutes = Array.from({ length: 5 * 390 }, (_, i) => Math.floor(i / 390) * DAY + (i % 390) * MIN);

    it('錨點落在兩個週期各自的格點上，仍指向同一個時間', () => {
        const lDaily = timeToLogical(daily, DAY, day3);
        const lMinute = timeToLogical(minutes, MIN, day3);
        expect(logicalToTime(daily, DAY, lDaily)).toBe(day3);
        expect(logicalToTime(minutes, MIN, lMinute)).toBe(day3);
        // index 本身當然不同 — 這正是不能存 K 棒 index 的理由
        expect(lDaily).toBe(3);
        expect(lMinute).toBe(3 * 390);
    });

    it('1 分圖上非日線格點的時間，切到日線仍落在正確的兩天之間', () => {
        const midday = 2 * DAY + 200 * MIN; // 第 3 天盤中
        const l = timeToLogical(daily, DAY, midday);
        expect(l).toBeGreaterThan(2);
        expect(l).toBeLessThan(3);
        expect(logicalToTime(daily, DAY, l)).toBeCloseTo(midday, 6);
    });
});

describe('logical index ↔ 畫面 x', () => {
    // lightweight-charts 的 logicalToCoordinate()：非整數 logical 一律回 0
    // （pane 左緣），這正是小週期畫的斜線切到大週期時端點黏在最左邊的原因
    const BAR_SPACING = 8;
    const ORIGIN = 30;
    const integerOnly = (logical: number) =>
        Number.isInteger(logical) ? ORIGIN + logical * BAR_SPACING : 0;

    it('用兩個整數 logical 量出線性映射', () => {
        const map = measureXAxis(integerOnly);
        expect(map).toEqual({ origin: ORIGIN, barSpacing: BAR_SPACING });
    });

    it('小數 logical 也有正確座標 — 不再掉回 pane 左緣', () => {
        const map = measureXAxis(integerOnly)!;
        expect(xOfLogical(map, 2.5)).toBe(ORIGIN + 2.5 * BAR_SPACING);
        expect(xOfLogical(map, -1.25)).toBe(ORIGIN - 1.25 * BAR_SPACING);
        // 直接問圖表會拿到 0，兩者差很多 — 這就是那個 bug
        expect(integerOnly(2.5)).toBe(0);
    });

    it('logicalOfX 是 xOfLogical 的反函式（拖曳時換回時間座標）', () => {
        const map = measureXAxis(integerOnly)!;
        for (const l of [-3.5, 0, 1.75, 42]) {
            expect(logicalOfX(map, xOfLogical(map, l))).toBeCloseTo(l, 10);
        }
    });

    it('時間軸還空著（回 null）或量不出棒距時回 null，呼叫端跳過投影', () => {
        expect(measureXAxis(() => null)).toBeNull();
        expect(measureXAxis(() => 100)).toBeNull(); // barSpacing = 0
    });
});

// 線性投影的假 Projector：time→x、price→y 都是簡單線性關係
const projector: Projector = {
    xOfTime: (t) => t / 10,
    yOfPrice: (p) => 400 - p,
    timeOfX: (x) => x * 10,
    priceOfY: (y) => 400 - y,
};

describe('投影', () => {
    it('錨點投影與反投影互為逆運算', () => {
        const pts = projectAnchors(projector, [{ time: 1000, price: 250 }]);
        expect(pts).toEqual([{ x: 100, y: 150 }]);
        expect(unprojectPoint(projector, { x: 100, y: 150 })).toEqual({ time: 1000, price: 250 });
    });

    it('任一錨點投影不出來就整個物件跳過，不畫半條線', () => {
        const broken: Projector = { ...projector, yOfPrice: () => null };
        expect(
            projectAnchors(broken, [
                { time: 1, price: 1 },
                { time: 2, price: 2 },
            ]),
        ).toBeNull();
    });

    it('線段端點可磁吸到其他圖形的同一價位與時間', () => {
        const drawings = [
            {
                id: 'line-a',
                hidden: false,
                anchors: [
                    { time: 1000, price: 250 },
                    { time: 2000, price: 260 },
                ],
            },
            { id: 'hidden', hidden: true, anchors: [{ time: 1050, price: 250 }] },
        ];

        expect(nearestDrawingAnchor(drawings, projector, { x: 103, y: 151 })).toEqual({ time: 1000, price: 250 });
        expect(nearestDrawingAnchor(drawings, projector, { x: 103, y: 151 }, 20, 'line-a')).toBeNull();
        expect(nearestDrawingAnchor(drawings, projector, { x: 140, y: 151 })).toBeNull();
    });
});

describe('各工具的形狀', () => {
    const a: Point = { x: 100, y: 100 };
    const b: Point = { x: 200, y: 150 };

    it('水平線橫貫整個 pane，x 與錨點時間無關', () => {
        const s = shapeOf('horizontal', [{ x: 640, y: 120 }], SIZE);
        expect(s).toEqual({ kind: 'line', a: { x: 0, y: 120 }, b: { x: 800, y: 120 } });
    });

    it('趨勢線就是兩點之間的線段', () => {
        expect(shapeOf('trend', [a, b], SIZE)).toEqual({ kind: 'line', a, b });
    });

    // 線端落在 pane 外擴 2px 的邊界上
    const onBorder = (p: Point) =>
        Math.abs(p.x + 2) < 1e-9 ||
        Math.abs(p.x - SIZE.width - 2) < 1e-9 ||
        Math.abs(p.y + 2) < 1e-9 ||
        Math.abs(p.y - SIZE.height - 2) < 1e-9;

    it('射線起點固定，只往第二點的方向延伸到畫面邊界', () => {
        const s = shapeOf('ray', [a, b], SIZE);
        expect(s!.kind).toBe('line');
        const line = s as { a: Point; b: Point };
        expect(line.a).toEqual(a); // 起點不動
        expect(line.b.x).toBeGreaterThan(b.x);
        expect(onBorder(line.b)).toBe(true);
        // 仍在同一條直線上（斜率 0.5）
        expect((line.b.y - a.y) / (line.b.x - a.x)).toBeCloseTo(0.5, 10);
    });

    it('延伸線兩端都延伸到畫面邊界，且反向端在起點的另一側', () => {
        const s = shapeOf('extended', [a, b], SIZE) as { a: Point; b: Point };
        expect(s.a.x).toBeLessThan(0);
        expect(onBorder(s.a) && onBorder(s.b)).toBe(true);
        expect(s.b.x).toBeGreaterThan(b.x);
        expect((s.b.y - s.a.y) / (s.b.x - s.a.x)).toBeCloseTo(0.5, 10);
    });

    it('控制點捲到很遠的畫面外，穿過畫面的射線仍畫得出來也點得到', () => {
        // 起點在左邊 10 萬像素外、水平往右 — 固定長度延伸到不了可視區
        const far: Point = { x: -100000, y: 200 };
        const next: Point = { x: -99990, y: 200 };
        const s = shapeOf('ray', [far, next], SIZE) as { a: Point; b: Point };
        expect(s).not.toBeNull();
        expect(s.a.x).toBeCloseTo(-2, 6);
        expect(s.b.x).toBeCloseTo(SIZE.width + 2, 6);
        expect(hitTest('ray', [far, next], SIZE, { x: 400, y: 202 })).toEqual({ kind: 'body' });
        // 延伸線同理：兩個控制點都在右邊很遠處
        const e = shapeOf('extended', [{ x: 90000, y: 100 }, { x: 90010, y: 100 }], SIZE);
        expect(e).not.toBeNull();
    });

    it('射線往畫面外的方向延伸、與畫面不相交時不畫也點不到', () => {
        const s = shapeOf('ray', [{ x: 900, y: 100 }, { x: 950, y: 100 }], SIZE);
        expect(s).toBeNull();
        expect(hitTest('ray', [{ x: 900, y: 100 }, { x: 950, y: 100 }], SIZE, { x: 700, y: 100 })).toBeNull();
    });

    it('兩點重合的退化情況不產生 NaN 座標', () => {
        const s = shapeOf('ray', [a, { ...a }], SIZE) as { a: Point; b: Point };
        expect(Number.isFinite(s.b.x) && Number.isFinite(s.b.y)).toBe(true);
    });

    it('方框把任意兩個對角正規化成左上／右下', () => {
        expect(shapeOf('box', [b, a], SIZE)).toEqual({
            kind: 'rect',
            left: 100,
            right: 200,
            top: 100,
            bottom: 150,
        });
    });

    it('兩點工具只有一個錨點時畫不出形狀（繪製進行中）', () => {
        expect(shapeOf('trend', [a], SIZE)).toBeNull();
    });
});

describe('命中判定', () => {
    const a: Point = { x: 100, y: 100 };
    const b: Point = { x: 200, y: 100 };

    it('控制點優先於本體 — 疊在線上的端點抓得到', () => {
        expect(hitTest('trend', [a, b], SIZE, { x: 100, y: 100 })).toEqual({
            kind: 'anchor',
            index: 0,
        });
        expect(hitTest('trend', [a, b], SIZE, { x: 200, y: 100 })).toEqual({
            kind: 'anchor',
            index: 1,
        });
        expect(hitTest('trend', [a, b], SIZE, { x: 150, y: 100 })).toEqual({ kind: 'body' });
    });

    it('容差內算命中，容差外不算', () => {
        expect(hitTest('trend', [a, b], SIZE, { x: 150, y: 105 }, 6)).toEqual({ kind: 'body' });
        expect(hitTest('trend', [a, b], SIZE, { x: 150, y: 120 }, 6)).toBeNull();
    });

    it('線段之外的延長線上不算命中（趨勢線有端點）', () => {
        expect(hitTest('trend', [a, b], SIZE, { x: 400, y: 100 }, 6)).toBeNull();
    });

    it('射線的延伸段算命中 — 看得到就點得到', () => {
        expect(hitTest('ray', [a, b], SIZE, { x: 700, y: 100 }, 6)).toEqual({ kind: 'body' });
        // 起點的反方向不在射線上
        expect(hitTest('ray', [a, b], SIZE, { x: 20, y: 100 }, 6)).toBeNull();
    });

    it('水平線在任何 x 都命中', () => {
        expect(hitTest('horizontal', [{ x: 640, y: 200 }], SIZE, { x: 5, y: 201 })).toEqual({
            kind: 'body',
        });
    });

    it('方框內部與邊框都命中，外部不命中', () => {
        const pts = [
            { x: 100, y: 100 },
            { x: 200, y: 200 },
        ];
        expect(hitTest('box', pts, SIZE, { x: 150, y: 150 })).toEqual({ kind: 'body' });
        expect(hitTest('box', pts, SIZE, { x: 100, y: 150 })).toEqual({ kind: 'body' });
        expect(hitTest('box', pts, SIZE, { x: 260, y: 150 })).toBeNull();
    });

    it('控制點命中半徑包含把手本身的大小', () => {
        const at = { x: 100 + ANCHOR_RADIUS + 5, y: 100 };
        expect(hitTest('trend', [a, b], SIZE, at, 6)).toEqual({ kind: 'anchor', index: 0 });
    });

    it('點到線段距離在端點外以端點計算', () => {
        expect(distanceToSegment({ x: 0, y: 100 }, a, b)).toBe(100);
        expect(distanceToSegment({ x: 150, y: 110 }, a, b)).toBe(10);
        expect(distanceToSegment({ x: 100, y: 110 }, a, a)).toBe(10); // 退化線段
    });
});

describe('從一疊物件裡挑出點到的那個', () => {
    const obj = (id: string, price: number, patch: Partial<{ hidden: boolean }> = {}) => ({
        id,
        tool: 'horizontal' as const,
        anchors: [{ time: 1000, price }],
        hidden: false,
        ...patch,
    });
    // projector：price 250 → y 150、price 200 → y 200
    const at = (y: number) => ({ x: 400, y });

    it('鎖定的物件照樣選得到 — 否則永遠解不了鎖、拿不掉', () => {
        // 鎖定與否根本不是 pickDrawing 的判斷條件，帶了 locked 也一樣選得到
        const locked = { ...obj('a', 250), locked: true };
        expect(pickDrawing([locked], projector, SIZE, at(150))?.drawing.id).toBe('a');
    });

    it('隱藏的物件跳過 — 看不見就不該點得到', () => {
        expect(pickDrawing([obj('a', 250, { hidden: true })], projector, SIZE, at(150))).toBeNull();
    });

    it('重疊時後畫的優先（畫在上面的先選到）', () => {
        const list = [obj('older', 250), obj('newer', 250)];
        expect(pickDrawing(list, projector, SIZE, at(150))?.drawing.id).toBe('newer');
    });

    it('沒點到任何物件時回 null', () => {
        expect(pickDrawing([obj('a', 250)], projector, SIZE, at(10))).toBeNull();
    });

    it('回傳的控制點座標可直接拿去當拖曳起點', () => {
        const picked = pickDrawing([obj('a', 250)], projector, SIZE, at(150))!;
        expect(picked.points).toEqual([{ x: 100, y: 150 }]);
        // 水平線橫貫整個 pane，離錨點很遠的 x 點到的是線身
        expect(picked.hit).toEqual({ kind: 'body' });
        // 錨點附近才抓得到控制點
        expect(pickDrawing([obj('a', 250)], projector, SIZE, { x: 100, y: 150 })!.hit).toEqual({
            kind: 'anchor',
            index: 0,
        });
    });

    it('投影不出來的物件跳過，不會中斷後面的搜尋', () => {
        const broken: Projector = {
            ...projector,
            yOfPrice: (p) => (p === 999 ? null : 400 - p),
        };
        const list = [obj('good', 250), obj('broken', 999)];
        expect(pickDrawing(list, broken, SIZE, at(150))?.drawing.id).toBe('good');
    });
});

describe('拖曳', () => {
    const start: Point[] = [
        { x: 100, y: 100 },
        { x: 200, y: 150 },
    ];

    it('拖本體時兩個控制點一起位移，形狀不變', () => {
        const moved = dragPoints(
            { hit: { kind: 'body' }, startPoints: start, startAt: { x: 150, y: 120 } },
            { x: 170, y: 90 },
        );
        expect(moved).toEqual([
            { x: 120, y: 70 },
            { x: 220, y: 120 },
        ]);
    });

    it('拖控制點只動那一點', () => {
        const moved = dragPoints(
            { hit: { kind: 'anchor', index: 1 }, startPoints: start, startAt: { x: 200, y: 150 } },
            { x: 240, y: 150 },
        );
        expect(moved).toEqual([
            { x: 100, y: 100 },
            { x: 240, y: 150 },
        ]);
    });

    it('不改動傳入的起始座標（拖曳中會重複呼叫）', () => {
        const before = structuredClone(start);
        dragPoints(
            { hit: { kind: 'body' }, startPoints: start, startAt: { x: 0, y: 0 } },
            { x: 5, y: 5 },
        );
        expect(start).toEqual(before);
    });
});

describe('第一期新工具的形狀與命中', () => {
    it('垂直線縱貫整個 pane，點在線附近命中', () => {
        expect(shapeOf('vertical', [{ x: 300, y: 50 }], SIZE)).toEqual({
            kind: 'line',
            a: { x: 300, y: 0 },
            b: { x: 300, y: 400 },
        });
        expect(hitTest('vertical', [{ x: 300, y: 50 }], SIZE, { x: 304, y: 380 })).toEqual({ kind: 'body' });
        expect(hitTest('vertical', [{ x: 300, y: 50 }], SIZE, { x: 320, y: 380 })).toBeNull();
    });

    it('平行通道：第三點決定平行線的垂直位移，中線在正中間，兩線之間可點選', () => {
        const a = { x: 100, y: 200 };
        const b = { x: 300, y: 100 };
        const c = { x: 200, y: 250 }; // 基準線在 x=200 的 y=150 → 位移 +100
        expect(channelOffset(a, b, c)).toEqual({ x: 0, y: 100 });
        const s = shapeOf('channel', [a, b, c], SIZE) as Extract<Shape, { kind: 'channel' }>;
        expect(s.parallel).toEqual({ a: { x: 100, y: 300 }, b: { x: 300, y: 200 } });
        expect(s.mid).toEqual({ a: { x: 100, y: 250 }, b: { x: 300, y: 150 } });
        expect(hitTest('channel', [a, b, c], SIZE, { x: 200, y: 200 })).toEqual({ kind: 'body' }); // 通道內
        expect(hitTest('channel', [a, b, c], SIZE, { x: 200, y: 330 })).toBeNull();
        // 還在等第三點：只畫基準線
        expect(shapeOf('channel', [a, b], SIZE)).toEqual({ kind: 'line', a, b });
    });

    it('斐波那契：終點＝0、起點＝1，比例線在兩點之間；可自訂比例', () => {
        const a = { x: 100, y: 300 }; // 起點（1）
        const b = { x: 400, y: 100 }; // 終點（0）
        const s = shapeOf('fib', [a, b], SIZE) as Extract<Shape, { kind: 'fib' }>;
        expect(s.levels.map((l) => l.level)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
        expect(s.levels.find((l) => l.level === 0)!.y).toBe(100);
        expect(s.levels.find((l) => l.level === 1)!.y).toBe(300);
        expect(s.levels.find((l) => l.level === 0.5)!.y).toBe(200);
        expect(fibPrice(48000, 48600, 0.5)).toBe(48300);
        expect(fibPrice(48000, 48600, 0)).toBe(48600);
        const fib = defaultFibOptions();
        const custom = shapeOf('fib', [a, b], SIZE, {
            fib: {
                ...fib,
                levels: [
                    { value: 0, visible: true, token: 'grey' },
                    { value: 0.5, visible: false, token: 'green' },
                    { value: 1.618, visible: true, token: 'teal' },
                ],
            },
        }) as Extract<Shape, { kind: 'fib' }>;
        // 隱藏的比例不畫也點不到；index 對回 fib.levels 取顏色
        expect(custom.levels.map((l) => [l.level, l.index])).toEqual([[0, 0], [1.618, 2]]);
        expect(hitTest('fib', [a, b], SIZE, { x: 250, y: 202 })).toEqual({ kind: 'body' }); // 0.5 線上
        expect(hitTest('fib', [a, b], SIZE, { x: 600, y: 200 })).toBeNull(); // 範圍外
    });

    it('文字註記：以錨點為左上角的文字框，框內點得到；中文字比英文寬', () => {
        const at = { x: 100, y: 100 };
        const s = shapeOf('text', [at], SIZE, { text: '月線支撐\nok' }) as Extract<Shape, { kind: 'text' }>;
        expect(s.lines).toEqual(['月線支撐', 'ok']);
        expect(s.left).toBe(100);
        expect(s.right - s.left).toBeCloseTo(4 * TEXT_FONT_PX + 12, 6);
        expect(estimateTextWidth('中')).toBeGreaterThan(estimateTextWidth('a'));
        expect(hitTest('text', [at], SIZE, { x: 104, y: 103 }, 6, { text: '月線支撐' })).toEqual({ kind: 'anchor', index: 0 });
        expect(hitTest('text', [at], SIZE, { x: 150, y: 115 }, 6, { text: '月線支撐' })).toEqual({ kind: 'body' });
        expect(hitTest('text', [at], SIZE, { x: 300, y: 115 }, 6, { text: '月線支撐' })).toBeNull();
    });
});

describe('磁吸', () => {
    const bars = [
        { time: 1000, open: 100, high: 110, low: 95, close: 105 },
        { time: 1060, open: 105, high: 120, low: 100, close: 118 },
    ];
    const y = (p: number) => 1000 - p; // 價格越高越上面

    it('貼齊最近那根 K 棒，取畫面上最近的開高低收', () => {
        expect(nearestBarIndex(bars, 1040)).toBe(1);
        expect(nearestBarIndex(bars, 1020)).toBe(0);
        expect(magnetAnchor({ time: 1050, price: 119 }, bars, y, y(119))).toEqual({ time: 1060, price: 120 });
        expect(magnetAnchor({ time: 1005, price: 96 }, bars, y, y(96))).toEqual({ time: 1000, price: 95 });
    });

    it('沒有 K 棒時原樣回傳', () => {
        expect(magnetAnchor({ time: 1, price: 2 }, [], y, 0)).toEqual({ time: 1, price: 2 });
    });
});

describe('價差量測', () => {
    const times = [0, 60, 120, 180, 240, 300];

    it('點數、漲跌幅、K 棒數、時間與損益', () => {
        const s = measureStats({ time: 0, price: 48000 }, { time: 300, price: 47880 }, times, 60, 200);
        expect(s.points).toBe(-120);
        expect(s.pct).toBeCloseTo(-0.25, 6);
        expect(s.bars).toBe(5);
        expect(s.seconds).toBe(300);
        expect(s.pnl).toBe(-24000);
        expect(measureStats({ time: 0, price: 1 }, { time: 60, price: 2 }, times, 60, null).pnl).toBeNull();
    });

    it('時間長度格式', () => {
        expect(formatSpan(5400)).toBe('1h30m');
        expect(formatSpan(3600)).toBe('1h');
        expect(formatSpan(90000)).toBe('1d 1h');
        expect(formatSpan(2700)).toBe('45m');
        expect(formatSpan(30)).toBe('30s');
        expect(formatSpan(-120)).toBe('−2m');
    });
});

describe('斐波那契：反轉、延伸、趨勢線', () => {
    const a = { x: 100, y: 300 };
    const b = { x: 400, y: 100 };
    const fib = defaultFibOptions();
    const shape = (patch: Partial<typeof fib>) =>
        shapeOf('fib', [a, b], SIZE, { fib: { ...fib, ...patch } }) as Extract<Shape, { kind: 'fib' }>;

    it('反轉：0 在起點、1 在終點', () => {
        const s = shape({ reverse: true });
        expect(s.levels.find((l) => l.level === 0)!.y).toBe(300);
        expect(s.levels.find((l) => l.level === 1)!.y).toBe(100);
    });

    it('延伸線段到圖表左右緣；回撤範圍（標籤外側基準）不變', () => {
        const s = shape({ extendLeft: true, extendRight: true });
        expect([s.left, s.right]).toEqual([0, SIZE.width]);
        expect([s.anchorLeft, s.anchorRight]).toEqual([100, 400]);
        expect(hitTest('fib', [a, b], SIZE, { x: 700, y: 200 }, 6, { fib: { ...fib, extendRight: true } })).toEqual({ kind: 'body' });
    });

    it('關掉趨勢線就沒有斜虛線', () => {
        expect(shape({ showTrend: false }).diag).toBeNull();
        expect(shape({}).diag).toEqual({ a, b });
    });
});
