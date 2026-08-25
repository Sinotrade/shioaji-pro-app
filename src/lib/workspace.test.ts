// src/lib/workspace.test.ts — 288 欄底座的升階與密度往返語意

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_WORKSPACE,
    GRID_COLS,
    GRID_LEGACY_COLS,
    GRID_LEGACY_SCALE,
    LAYOUT_PRESETS,
    upscaleLegacyWorkspace,
    type Workspace,
} from './workspace';

describe('grid base upscale', () => {
    it('legacy 24-col workspace scales ×12 losslessly (x/w/minW only)', () => {
        const legacy: Workspace = {
            blocks: [{ id: 'a', type: 'watchlist', pin: null }],
            layout: [{ i: 'a', x: 4, y: 3, w: 5, h: 14, minW: 3, minH: 6 }],
        };
        const up = upscaleLegacyWorkspace(legacy);
        const l = up.layout[0]!;
        expect(l.x).toBe(48);
        expect(l.w).toBe(60);
        expect(l.minW).toBe(36);
        // 垂直軸是絕對 rowHeight，不縮放
        expect(l.y).toBe(3);
        expect(l.h).toBe(14);
        expect(l.minH).toBe(6);
    });

    it('exported defaults/presets are already in the 288 base', () => {
        for (const ws of [
            DEFAULT_WORKSPACE,
            ...LAYOUT_PRESETS.map((p) => p.workspace),
        ]) {
            for (const l of ws.layout) {
                expect(l.x + l.w).toBeLessThanOrEqual(GRID_COLS);
            }
            // 至少一個面板寬度超過 24 → 確認不是漏升階的舊基準
            expect(ws.layout.some((l) => l.w > GRID_LEGACY_COLS)).toBe(true);
        }
    });

    it('render/store round-trip is lossless for every density k|12', () => {
        for (const k of [1, 2, 3, 4]) {
            const toRender = k / GRID_LEGACY_SCALE;
            const fromRender = GRID_LEGACY_SCALE / k;
            expect(Number.isInteger(fromRender)).toBe(true);
            for (const stored of [0, 12, 48, 60, 132, 276]) {
                const rendered = Math.round(stored * toRender);
                const back = Math.round(rendered * fromRender);
                expect(back).toBe(stored);
            }
        }
    });
});
