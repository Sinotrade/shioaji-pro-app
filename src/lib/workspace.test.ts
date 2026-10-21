// src/lib/workspace.test.ts — 288 欄底座的升階與密度往返語意

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BLOCK_META,
    DEFAULT_WORKSPACE,
    GRID_COLS,
    GRID_LEGACY_COLS,
    GRID_LEGACY_SCALE,
    LAYOUT_PRESETS,
    loadWorkspace,
    toRenderGeom,
    popoutSessionFromQuery,
    popoutSessionParam,
    upscaleLegacyWorkspace,
    withBlockSessionConfig,
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

describe('panel session config (issue #73)', () => {
    const ws: Workspace = {
        blocks: [
            { id: 'c1', type: 'chart', pin: null },
            { id: 'i1', type: 'intraday', pin: null },
        ],
        layout: [],
    };

    it('writes the choice onto the matching block only', () => {
        const a = withBlockSessionConfig(ws, 'c1', { chartSession: 'day' });
        expect(a.blocks[0]).toEqual({ id: 'c1', type: 'chart', pin: null, chartSession: 'day' });
        expect(a.blocks[1]).toBe(ws.blocks[1]);
        const b = withBlockSessionConfig(a, 'i1', { intradaySession: 'night' });
        expect(b.blocks[1]!.intradaySession).toBe('night');
        expect(b.blocks[0]!.chartSession).toBe('day');
        expect(ws.blocks[0]!.chartSession).toBeUndefined(); // immutable
    });

    it('survives the saved-workspace JSON round trip', () => {
        const saved = JSON.parse(
            JSON.stringify(withBlockSessionConfig(ws, 'c1', { chartSession: 'day' })),
        ) as Workspace;
        expect(saved.blocks[0]!.chartSession).toBe('day');
    });
});

describe('popout session param', () => {
    it('carries the panel choice into the popout URL', () => {
        expect(popoutSessionParam({ id: 'c', type: 'chart', pin: null, chartSession: 'day' })).toEqual({ session: 'day' });
        expect(popoutSessionParam({ id: 'i', type: 'intraday', pin: null, intradaySession: 'night' })).toEqual({ session: 'night' });
        expect(popoutSessionParam({ id: 'c', type: 'chart', pin: null })).toEqual({});
        expect(popoutSessionParam({ id: 'd', type: 'depth', pin: null })).toEqual({});
        const qs = new URLSearchParams({ popout: 'chart', code: 'TXFR1', ...popoutSessionParam({ id: 'c', type: 'chart', pin: null, chartSession: 'day' }) });
        expect(popoutSessionFromQuery(qs).chartSession).toBe('day');
    });

    it('carries the K-line interval into the popout URL (#331)', () => {
        const block = { id: 'c', type: 'chart' as const, pin: null, chartSession: 'day' as const, chartInterval: '1D' as const };
        expect(popoutSessionParam(block)).toEqual({ session: 'day', interval: '1D' });
        expect(popoutSessionParam({ id: 'i', type: 'intraday', pin: null, chartInterval: '1D' })).toEqual({});
        const qs = new URLSearchParams(popoutSessionParam(block));
        expect(popoutSessionFromQuery(qs).chartInterval).toBe('1D');
        expect(popoutSessionFromQuery(new URLSearchParams({ interval: '2h' })).chartInterval).toBeUndefined();
    });

    it('persists the K-line interval with the saved workspace (#331)', () => {
        const ws = { blocks: [{ id: 'c1', type: 'chart' as const, pin: null }], layout: [] };
        const saved = JSON.parse(JSON.stringify(withBlockSessionConfig(ws, 'c1', { chartInterval: '15m' }))) as Workspace;
        expect(saved.blocks[0]!.chartInterval).toBe('15m');
    });

    it('reads back only known values per panel type', () => {
        const q = (v: string) => popoutSessionFromQuery(new URLSearchParams({ session: v }));
        expect(q('day')).toEqual({ chartSession: 'day', intradaySession: 'day' });
        expect(q('night')).toEqual({ chartSession: undefined, intradaySession: 'night' });
        expect(q('all')).toEqual({ chartSession: 'all', intradaySession: undefined });
        expect(q('foo')).toEqual({ chartSession: undefined, intradaySession: undefined });
        expect(popoutSessionFromQuery(new URLSearchParams())).toEqual({ chartSession: undefined, intradaySession: undefined });
    });
});

describe('built-in layout presets', () => {
    const NEW_PRESETS = ['期貨當沖', '期現對照', '零股存股', '條件單監控', '選擇權組合', '盤勢總覽'];
    const BANNED = ['原生', '免費', '交易終端', 'Claude', 'Codex'];
    const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    it('names are unique and avoid banned wording', () => {
        const names = LAYOUT_PRESETS.map((p) => p.name);
        expect(new Set(names).size).toBe(names.length);
        for (const p of LAYOUT_PRESETS) {
            for (const word of BANNED) {
                expect(p.name).not.toContain(word);
                expect(p.desc).not.toContain(word);
            }
        }
    });

    it('ships the new panel combinations and keeps the existing ones', () => {
        const names = LAYOUT_PRESETS.map((p) => p.name);
        for (const n of NEW_PRESETS) expect(names).toContain(n);
        for (const n of ['標準看盤', '當沖交易', '雙圖對照', '選擇權', '衍生商品探索', '鋪單交易', '閃電矩陣', '熱力選股', '市場脈動', '盤中雷達', 'AI 副駕', '分析研究']) {
            expect(names).toContain(n);
        }
    });

    for (const p of LAYOUT_PRESETS) {
        it(`「${p.name}」is a valid workspace`, () => {
            const ws = p.workspace;
            const ids = ws.blocks.map((b) => b.id);
            expect(new Set(ids).size).toBe(ids.length);
            // 每個面板恰好一個格子，沒有孤兒格子
            expect(ws.layout.map((l) => l.i).sort()).toEqual([...ids].sort());
            for (const b of ws.blocks) {
                const meta = BLOCK_META[b.type];
                expect(meta, b.type).toBeDefined();
                // 不可釘選的面板不能帶代碼
                if (!meta.pinnable) expect(b.pin, b.id).toBeNull();
                if (meta.singleton) expect(ws.blocks.filter((x) => x.type === b.type).length, b.type).toBe(1);
                // 連動群組只給閃電，且群組必須有代碼
                if (b.linkGroup) {
                    expect(b.type).toBe('flash');
                    expect(b.pin).toBeNull();
                    expect(ws.linkGroups?.[b.linkGroup]).toBeTruthy();
                }
            }
            for (const l of ws.layout) {
                expect(l.x).toBeGreaterThanOrEqual(0);
                expect(l.y).toBeGreaterThanOrEqual(0);
                expect(l.x + l.w).toBeLessThanOrEqual(GRID_COLS);
            }
            for (let i = 0; i < ws.layout.length; i++) {
                for (let j = i + 1; j < ws.layout.length; j++) {
                    expect(overlaps(ws.layout[i]!, ws.layout[j]!), `${ws.layout[i]!.i} × ${ws.layout[j]!.i}`).toBe(false);
                }
            }
        });
    }

    for (const name of NEW_PRESETS) {
        it(`「${name}」fills the 24×24 screen and respects panel minimum sizes`, () => {
            const p = LAYOUT_PRESETS.find((x) => x.name === name)!;
            const ws = p.workspace;
            const typeOf = new Map(ws.blocks.map((b) => [b.id, b.type]));
            let area = 0;
            for (const l of ws.layout) {
                const min = BLOCK_META[typeOf.get(l.i)!].defaultSize;
                expect(l.w, l.i).toBeGreaterThanOrEqual(min.minW * GRID_LEGACY_SCALE);
                expect(l.h, l.i).toBeGreaterThanOrEqual(min.minH);
                expect(l.minW).toBe(min.minW * GRID_LEGACY_SCALE);
                expect(l.minH).toBe(min.minH);
                expect(l.y + l.h).toBeLessThanOrEqual(24);
                area += l.w * l.h;
            }
            // 無重疊＋面積剛好 = 整個畫面鋪滿，沒有空洞
            expect(area).toBe(GRID_COLS * 24);
        });
    }

    it('期現對照 drives a stock ladder and a stock-futures ladder from one selection', () => {
        const ws = LAYOUT_PRESETS.find((x) => x.name === '期現對照')!.workspace;
        const flashes = ws.blocks.filter((b) => b.type === 'flash');
        expect(flashes.map((b) => b.flashLink?.kind).sort()).toEqual(['future', 'stock']);
        // 兩條梯都跟自選選取（同一個來源），不釘選也不進群組
        for (const b of flashes) {
            expect(b.pin).toBeNull();
            expect(b.linkGroup).toBeUndefined();
        }
    });

    it('期貨當沖 keeps every quote panel on the same futures contract', () => {
        const ws = LAYOUT_PRESETS.find((x) => x.name === '期貨當沖')!.workspace;
        const pins = ws.blocks.filter((b) => BLOCK_META[b.type].pinnable).map((b) => b.pin);
        expect(new Set(pins)).toEqual(new Set(['TXFR1']));
    });
});
