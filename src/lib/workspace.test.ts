// src/lib/workspace.test.ts — 288 欄底座的升階與密度往返語意

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_WORKSPACE,
    GRID_COLS,
    GRID_LEGACY_COLS,
    GRID_LEGACY_SCALE,
    LAYOUT_PRESETS,
    loadWorkspace,
    toRenderGeom,
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
            const fromRender = GRID_LEGACY_SCALE / k;
            expect(Number.isInteger(fromRender)).toBe(true);
            for (const stored of [
                { x: 0, w: 60 },
                { x: 12, w: 48 },
                { x: 132, w: 156 },
                { x: 228, w: 60 },
            ]) {
                const g = toRenderGeom(stored, k);
                expect(Math.round(g.x * fromRender)).toBe(stored.x);
                expect(Math.round(g.w * fromRender)).toBe(stored.w);
            }
        }
    });

    it('edge-anchored render keeps neighbors adjacent — never overlaps', () => {
        // k=2 存的 6 倍數版面在 k=1 開啟：x/w 獨立舍入會讓 A 的右緣
        // (round(66/12)=6) 蓋過 B 的左緣 (round(72/12)=6) → RGL compaction
        // 把 B 往下推一列。邊緣錨定：共用邊緣走同一映射，精確相鄰。
        const a = { x: 6, w: 66 };
        const b = { x: 72, w: 60 };
        const ga = toRenderGeom(a, 1);
        const gb = toRenderGeom(b, 1);
        expect(ga.x + ga.w).toBe(gb.x);
    });
});

describe('loadWorkspace fallback', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('corrupt v3 JSON does not block the v2 legacy fallback', () => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
        });
        const legacy: Workspace = {
            blocks: [{ id: 'a', type: 'watchlist', pin: null }],
            layout: [{ i: 'a', x: 4, y: 0, w: 5, h: 14 }],
        };
        store.set('sj-pro-workspace-v3', '{corrupt');
        store.set('sj-pro-workspace-v2', JSON.stringify(legacy));
        const w = loadWorkspace();
        // 讀到 v2 並 ×12 升階，而不是掉回預設版面
        expect(w.layout[0]!.i).toBe('a');
        expect(w.layout[0]!.x).toBe(48);
        expect(w.layout[0]!.w).toBe(60);
    });
});
