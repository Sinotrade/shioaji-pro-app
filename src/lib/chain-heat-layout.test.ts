import { describe, expect, it } from 'vitest';
import {
    emptyHeatMemo,
    HEAT_MIN_SHARE,
    HEAT_TILE_GAP,
    heatTileContent,
    heatTileWeights,
    layoutHeatTiles,
} from './chain-heat-layout';

const area = (r: { w: number; h: number }) => r.w * r.h;

describe('heatTileWeights', () => {
    it('keeps turnover as the weight, with a floor for tiny groups', () => {
        expect(heatTileWeights([1000, 500, 1])).toEqual([1000, 500, 1000 * HEAT_MIN_SHARE]);
    });

    it('is uniform before any turnover arrives', () => {
        expect(heatTileWeights([0, 0, 0])).toEqual([1, 1, 1]);
    });

    it('treats negative / NaN turnover as zero (floored, never dropped)', () => {
        const w = heatTileWeights([100, -5, Number.NaN]);
        expect(w[1]).toBe(100 * HEAT_MIN_SHARE);
        expect(w[2]).toBe(100 * HEAT_MIN_SHARE);
    });
});

describe('layoutHeatTiles', () => {
    const items = [
        { key: 'a', value: 600 },
        { key: 'b', value: 300 },
        { key: 'c', value: 100 },
    ];

    it('sizes tiles by turnover and keeps every tile inside the box', () => {
        const { rects } = layoutHeatTiles(items, 400, 300, emptyHeatMemo(), 's');
        expect(rects.size).toBe(3);
        const a = area(rects.get('a')!);
        const b = area(rects.get('b')!);
        const c = area(rects.get('c')!);
        expect(a).toBeGreaterThan(b);
        expect(b).toBeGreaterThan(c);
        // roughly proportional (gaps take a few px)
        expect(a / c).toBeGreaterThan(4);
        for (const r of rects.values()) {
            expect(r.x).toBeGreaterThanOrEqual(0);
            expect(r.y).toBeGreaterThanOrEqual(0);
            expect(r.x + r.w).toBeLessThanOrEqual(400);
            expect(r.y + r.h).toBeLessThanOrEqual(300);
        }
    });

    it('leaves a gap between neighbours', () => {
        const { rects } = layoutHeatTiles(
            [
                { key: 'a', value: 1 },
                { key: 'b', value: 1 },
            ],
            203,
            100,
            emptyHeatMemo(),
            's',
        );
        const [l, r] = [rects.get('a')!, rects.get('b')!].sort((p, q) => p.x - q.x);
        expect(r!.x - (l!.x + l!.w)).toBe(HEAT_TILE_GAP);
    });

    it('keeps the order on a small change (hysteresis) and resets on a new scope', () => {
        const first = layoutHeatTiles(items, 400, 300, emptyHeatMemo(), 's');
        expect(first.memo.order).toEqual(['a', 'b', 'c']);
        // b overtakes a by < 15 %: order and positions stay
        const nudged = [
            { key: 'a', value: 600 },
            { key: 'b', value: 650 },
            { key: 'c', value: 100 },
        ];
        const second = layoutHeatTiles(nudged, 400, 300, first.memo, 's');
        expect(second.memo.order).toEqual(['a', 'b', 'c']);
        expect(second.rects.get('a')!.x).toBe(first.rects.get('a')!.x);
        // another scope (another group's members) starts fresh
        const other = layoutHeatTiles(nudged, 400, 300, first.memo, 't');
        expect(other.memo.order).toEqual(['b', 'a', 'c']);
    });

    it('returns nothing for an unmeasured box', () => {
        expect(layoutHeatTiles(items, 0, 300, emptyHeatMemo(), 's').rects.size).toBe(0);
    });
});

describe('heatTileContent', () => {
    it('shows name, change, net and bars on a large tile', () => {
        const c = heatTileContent(220, 140, '半導體', '+1.23%');
        expect(c.fit.mode).toBe('both');
        expect(c.showValue).toBe(true);
        expect(c.showBars).toBe(true);
    });

    it('drops net and bars before the label on a small tile', () => {
        const c = heatTileContent(70, 34, '半導體', '+1.23%');
        expect(c.showValue).toBe(false);
        expect(c.showBars).toBe(false);
        expect(c.fit.mode).not.toBe('none');
    });

    it('falls back to the code, then nothing, on tiny member tiles', () => {
        expect(heatTileContent(34, 18, '台積電股份有限公司', '+1.0%', '2330').fit.mode).toBe('code');
        expect(heatTileContent(8, 8, '台積電', '+1.0%', '2330').fit.mode).toBe('none');
    });
});
