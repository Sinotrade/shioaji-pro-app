import { describe, expect, it } from 'vitest';
import {
    ANCHOR_RADIUS,
    distanceToSegment,
    dragPoints,
    estimateBarSeconds,
    hitTest,
    logicalToTime,
    pickDrawing,
    projectAnchors,
    shapeOf,
    timeToLogical,
    unprojectPoint,
    type PaneSize,
    type Point,
    type Projector,
} from './chart-drawing-geometry';

const MIN = 60;
const DAY = 86400;
const SIZE: PaneSize = { width: 800, height: 400 };

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

    it('射線起點固定，只往第二點的方向延伸出畫面', () => {
        const s = shapeOf('ray', [a, b], SIZE);
        expect(s!.kind).toBe('line');
        const line = s as { a: Point; b: Point };
        expect(line.a).toEqual(a); // 起點不動
        expect(line.b.x).toBeGreaterThan(SIZE.width);
        // 仍在同一條直線上（斜率 0.5）
        expect((line.b.y - a.y) / (line.b.x - a.x)).toBeCloseTo(0.5, 10);
    });

    it('延伸線兩端都伸出畫面，且反向端在起點的另一側', () => {
        const s = shapeOf('extended', [a, b], SIZE) as { a: Point; b: Point };
        expect(s.a.x).toBeLessThan(0);
        expect(s.b.x).toBeGreaterThan(SIZE.width);
        expect((s.b.y - s.a.y) / (s.b.x - s.a.x)).toBeCloseTo(0.5, 10);
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
