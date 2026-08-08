import { describe, expect, it } from 'vitest';
import { labelChars, layoutRows, thumbRects } from './layout-thumb';
import { GRID_COLS, LAYOUT_PRESETS, type Workspace } from './workspace';

function preset(name: string) {
    const p = LAYOUT_PRESETS.find((c) => c.name === name);
    if (!p) throw new Error(`preset ${name} missing`);
    return p.workspace;
}

describe('layout thumbnail geometry', () => {
    it('computes logical rows as max(y+h)', () => {
        // 盤中雷達: all columns are h=24 strips → 24 rows
        expect(layoutRows(preset('盤中雷達'))).toBe(24);
        // 標準看盤: dock ends at y16+h9 = 25
        expect(layoutRows(preset('標準看盤'))).toBe(25);
    });

    it('maps 盤中雷達 grid coords into the pixel box', () => {
        // width 240 → 10px per col; height 240 → 10px per row; gap 2
        const rects = thumbRects(preset('盤中雷達'), 240, 240, 2);
        const byId = new Map(rects.map((r) => [r.id, r]));
        // signals: x0 w6 full height
        expect(byId.get('signals-sr')).toMatchObject({
            type: 'signals',
            x: 1,
            y: 1,
            w: 58,
            h: 238,
        });
        // chart: x6 w13
        expect(byId.get('chart-sr')).toMatchObject({ x: 61, w: 128 });
        // tape: x19 y10 w5 h14
        expect(byId.get('tape-sr')).toMatchObject({
            x: 191,
            y: 101,
            w: 48,
            h: 138,
        });
    });

    it('maps 雙圖對照 side-by-side charts symmetrically', () => {
        const rects = thumbRects(preset('雙圖對照'), 240, 240, 0);
        const a = rects.find((r) => r.id === 'chart-2ca');
        const b = rects.find((r) => r.id === 'chart-2cb');
        // rows = 24 (y14 + h10) → sy = 10
        expect(a).toMatchObject({ x: 40, y: 0, w: 100, h: 140 });
        expect(b).toMatchObject({ x: 140, y: 0, w: 100, h: 140 });
        expect(a?.label).toBe('K 線圖');
    });

    it('skips layout items with no matching block', () => {
        const ws = preset('盤中雷達');
        const broken = {
            blocks: ws.blocks.filter((b) => b.id !== 'tape-sr'),
            layout: ws.layout,
        };
        const rects = thumbRects(broken, 120, 80);
        expect(rects.map((r) => r.id)).not.toContain('tape-sr');
        expect(rects).toHaveLength(3);
    });

    it('decides label visibility from rect size', () => {
        expect(labelChars({ w: 60, h: 20 }, 8)).toBe(7);
        expect(labelChars({ w: 60, h: 8 }, 8)).toBe(0); // too short
        expect(labelChars({ w: 14, h: 20 }, 8)).toBe(0); // too narrow
    });

    it('survives an empty workspace (no ÷0, no rects)', () => {
        const empty: Workspace = { blocks: [], layout: [] };
        expect(layoutRows(empty)).toBe(1);
        expect(thumbRects(empty, 120, 80)).toEqual([]);
    });

    it('maps a single full-width panel to the whole box', () => {
        const one: Workspace = {
            blocks: [{ id: 'chart-1', type: 'chart', pin: null }],
            layout: [{ i: 'chart-1', x: 0, y: 0, w: GRID_COLS, h: 10 }],
        };
        const [r] = thumbRects(one, 120, 80, 0);
        expect(r).toMatchObject({ x: 0, y: 0, w: 120, h: 80 });
    });

    it('clamps degenerate zero-size items to visible slivers', () => {
        const ws: Workspace = {
            blocks: [{ id: 'tape-1', type: 'tape', pin: null }],
            layout: [{ i: 'tape-1', x: 0, y: 0, w: 0, h: 0 }],
        };
        const [r] = thumbRects(ws, 120, 80, 2);
        expect(r?.w).toBeGreaterThanOrEqual(1);
        expect(r?.h).toBeGreaterThanOrEqual(1);
    });

    it('all presets stay inside the real grid column count', () => {
        for (const p of LAYOUT_PRESETS) {
            for (const l of p.workspace.layout) {
                expect(l.x + l.w).toBeLessThanOrEqual(GRID_COLS);
            }
        }
    });
});
