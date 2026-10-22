import { describe, expect, it } from 'vitest';
import { RIVER_ROW_PX } from '../components/chain-river';
import { bandThickness } from './chain-river';
import { BAND_LINE_PX, CHIP_LINE_PX, DIM, layoutLanes, ROW_GAP_PX, SIDE_GAP_PX } from './portfolio-lanes-layout';

const ROW = 34;
const rows = [
    { id: 'a', net: -400, weight: 0.1 },
    { id: 'b', net: 900, weight: 0.5 },
    { id: 'c', net: 100, weight: 0.4 },
];

describe('layoutLanes', () => {
    it('keeps the band line in step with the river engine row', () => {
        expect(BAND_LINE_PX).toBe(RIVER_ROW_PX);
    });

    it('orders by net inflow with a gap before the outflows, as the river lanes 排行 draws', () => {
        const l = layoutLanes(rows, { live: true, rowPx: ROW, selected: null });
        const step = ROW + CHIP_LINE_PX + ROW_GAP_PX;
        expect(l.rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
        expect(l.lanes.map((x) => x.y)).toEqual([0, step, 2 * step + SIDE_GAP_PX]);
        expect(l.divider).toBe(2 * step + SIDE_GAP_PX / 2 - ROW_GAP_PX / 2);
        expect(l.height).toBe(3 * step + SIDE_GAP_PX - ROW_GAP_PX);
        // square-root length on one scale, signed by direction
        expect(l.lanes[0]!.m).toBe(1);
        expect(l.lanes[1]!.m).toBeCloseTo(Math.sqrt(100 / 900));
        expect(l.lanes[2]!.m).toBeCloseTo(-Math.sqrt(400 / 900));
        // thickness = my weight on 排行's band range
        expect(l.lanes[0]!.thick).toBe(bandThickness(0.5, 0.5));
        expect(l.lanes[2]!.thick).toBe(bandThickness(0.1, 0.5));
        expect(l.lanes.every((x) => x.focus === 1)).toBe(true);
    });

    it('dims the other lanes while a group is selected', () => {
        const l = layoutLanes(rows, { live: true, rowPx: ROW, selected: 'c' });
        expect(l.lanes.map((x) => [x.id, x.focus])).toEqual([['b', DIM], ['c', 1], ['a', DIM]]);
        const none = layoutLanes(rows, { live: true, rowPx: ROW, selected: 'gone' });
        expect(none.lanes.every((x) => x.focus === 1)).toBe(true);
    });

    it('before the first bar: weight order, no length, no divider', () => {
        const l = layoutLanes(rows, { live: false, rowPx: ROW, selected: null });
        expect(l.rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
        expect(l.lanes.every((x) => x.m === 0)).toBe(true);
        expect(l.divider).toBeNull();
    });

    it('handles no rows and all-zero flow', () => {
        expect(layoutLanes([], { live: true, rowPx: ROW, selected: null })).toMatchObject({ lanes: [], height: 0, divider: null });
        const z = layoutLanes([{ id: 'x', net: 0, weight: 0 }], { live: true, rowPx: ROW, selected: null });
        expect(z.lanes[0]).toMatchObject({ m: 0, thick: 3 });
    });
});
