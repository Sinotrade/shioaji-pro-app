import { describe, expect, it } from 'vitest';
import {
    binarySplit,
    heatBudget,
    layoutFlat,
    layoutNested,
    selectHeatItems,
    type SplitMemo,
    stableOrder,
    type Rect,
} from './heat-layout';

const area = (r: Rect) => r.w * r.h;
const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('binarySplit', () => {
    it('面積與權重成比例且填滿', () => {
        const items = [
            { key: 'a', weight: 50 },
            { key: 'b', weight: 30 },
            { key: 'c', weight: 15 },
            { key: 'd', weight: 5 },
        ];
        const rects = binarySplit(items, { x: 0, y: 0, w: 400, h: 200 });
        const total = [...rects.values()].reduce((s, r) => s + area(r), 0);
        expect(total).toBeCloseTo(80000);
        expect(area(rects.get('a')!) / 80000).toBeCloseTo(0.5);
        expect(area(rects.get('d')!) / 80000).toBeCloseTo(0.05);
    });

    it('略過權重 ≤ 0', () => {
        const rects = binarySplit(
            [
                { key: 'a', weight: 1 },
                { key: 'z', weight: 0 },
            ],
            { x: 0, y: 0, w: 10, h: 10 },
        );
        expect(rects.has('z')).toBe(false);
    });
});

describe('layoutFlat / layoutNested', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
        key: `s${i}`,
        weight: 100 / (i + 1),
    }));

    it('整數座標、1px 間隙、不重疊、不超出', () => {
        const tiles = layoutFlat(items, 300, 200);
        for (const t of tiles) {
            expect(Number.isInteger(t.rect.x)).toBe(true);
            expect(Number.isInteger(t.rect.w)).toBe(true);
            expect(t.rect.x + t.rect.w).toBeLessThanOrEqual(300);
            expect(t.rect.y + t.rect.h).toBeLessThanOrEqual(200);
        }
        for (let i = 0; i < tiles.length; i++) {
            for (let j = i + 1; j < tiles.length; j++) {
                expect(overlaps(tiles[i]!.rect, tiles[j]!.rect)).toBe(false);
            }
        }
        // 最右／最下的 tile 貼齊邊緣
        expect(Math.max(...tiles.map((t) => t.rect.x + t.rect.w))).toBe(300);
        expect(Math.max(...tiles.map((t) => t.rect.y + t.rect.h))).toBe(200);
    });

    it('兩層：每個產業有標題列，個股落在產業內標題下方', () => {
        const groups = [
            { key: 'g1', stocks: items.slice(0, 6) },
            { key: 'g2', stocks: items.slice(6) },
        ];
        const { sectors, tiles } = layoutNested(groups, 600, 400, 18);
        expect(sectors).toHaveLength(2);
        for (const sector of sectors) {
            expect(sector.header).not.toBeNull();
            expect(sector.header!.h).toBe(18);
            const own = tiles.filter((t) => t.groupKey === sector.key);
            for (const t of own) {
                expect(t.rect.y).toBeGreaterThanOrEqual(sector.rect.y + 19);
                expect(t.rect.x).toBeGreaterThanOrEqual(sector.rect.x);
                expect(t.rect.x + t.rect.w).toBeLessThanOrEqual(
                    sector.rect.x + sector.rect.w,
                );
                expect(t.rect.y + t.rect.h).toBeLessThanOrEqual(
                    sector.rect.y + sector.rect.h,
                );
            }
        }
        // 產業間 2px
        const [a, b] = sectors;
        const gapX = Math.abs(b!.rect.x - (a!.rect.x + a!.rect.w));
        const gapY = Math.abs(b!.rect.y - (a!.rect.y + a!.rect.h));
        expect(Math.min(gapX, gapY)).toBe(2);
    });

    it('太矮的產業不放標題列', () => {
        const { sectors } = layoutNested(
            [
                { key: 'big', stocks: [{ key: 'a', weight: 1000 }] },
                { key: 'tiny', stocks: [{ key: 'b', weight: 1 }] },
            ],
            400,
            300,
            18,
        );
        expect(sectors.find((s) => s.key === 'tiny')?.header ?? null).toBeNull();
    });
});

describe('stableOrder（版面穩定）', () => {
    const base = [
        { key: 'a', weight: 100 },
        { key: 'b', weight: 50 },
        { key: 'c', weight: 49 },
        { key: 'd', weight: 10 },
    ];

    it('無前次順序 → 依權重排序', () => {
        expect(stableOrder(undefined, base)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('小幅波動不交換名次', () => {
        const order = stableOrder(['a', 'b', 'c', 'd'], [
            { key: 'a', weight: 100 },
            { key: 'b', weight: 49.5 },
            { key: 'c', weight: 51 }, // 只超過 3%，未達 15% 門檻
            { key: 'd', weight: 10 },
        ]);
        expect(order).toEqual(['a', 'b', 'c', 'd']);
    });

    it('超過門檻才交換', () => {
        const order = stableOrder(['a', 'b', 'c', 'd'], [
            { key: 'a', weight: 100 },
            { key: 'b', weight: 40 },
            { key: 'c', weight: 60 },
            { key: 'd', weight: 10 },
        ]);
        expect(order).toEqual(['a', 'c', 'b', 'd']);
    });

    it('新項目依權重插入、消失的項目移除', () => {
        const order = stableOrder(['a', 'b', 'c', 'd'], [
            { key: 'a', weight: 100 },
            { key: 'b', weight: 50 },
            { key: 'e', weight: 30 },
            { key: 'd', weight: 10 },
        ]);
        expect(order).toEqual(['a', 'b', 'e', 'd']);
    });

    it('連續 60 秒 ±3% 隨機波動：版面位置不跳動', () => {
        let seed = 7;
        const rand = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
        const baseW = keys.map((_, i) => 100 / (i + 1) + 2);
        let order: string[] | undefined;
        let previous: Map<string, Rect> | undefined;
        let split: SplitMemo | undefined;
        let maxShift = 0;
        for (let t = 0; t < 60; t++) {
            const items = keys.map((key, i) => ({
                key,
                weight: baseW[i]! * (1 + (rand() - 0.5) * 0.06),
            }));
            order = stableOrder(order, items);
            const byKey = new Map(items.map((item) => [item.key, item]));
            const memo: SplitMemo = new Map();
            const tiles = layoutFlat(
                order.map((key) => byKey.get(key)!),
                600,
                400,
                split,
                memo,
            );
            split = memo;
            const now = new Map(tiles.map((tile) => [tile.key, tile.rect]));
            if (previous) {
                for (const [key, r] of now) {
                    const p = previous.get(key)!;
                    maxShift = Math.max(
                        maxShift,
                        Math.abs(r.x - p.x) + Math.abs(r.y - p.y),
                    );
                }
            }
            previous = now;
        }
        // 只有尺寸微調造成的小位移，不會整塊換位
        expect(maxShift).toBeLessThan(40);
    });
});

describe('heatBudget / selectHeatItems', () => {
    it('面積越大，產業與檔數越多', () => {
        const small = heatBudget(300, 200);
        const big = heatBudget(1600, 900);
        expect(big.groups).toBeGreaterThan(small.groups);
        expect(big.total).toBeGreaterThan(small.total);
        expect(big.perGroup).toBeLessThanOrEqual(10);
    });

    it('超過總數時每個產業至少留龍頭', () => {
        const groups = Array.from({ length: 5 }, (_, g) => ({
            key: `g${g}`,
            stocks: Array.from({ length: 10 }, (_, i) => ({
                key: `g${g}s${i}`,
                weight: (10 - i) * (5 - g),
            })),
        }));
        const picked = selectHeatItems(groups, {
            groups: 5,
            perGroup: 10,
            total: 12,
        });
        const count = picked.reduce((s, e) => s + e.stocks.length, 0);
        expect(count).toBe(12);
        for (const entry of picked) {
            expect(entry.stocks[0]!.key).toBe(`${entry.group.key}s0`);
        }
    });
});
