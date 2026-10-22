// 產業全景可同時開多個面板：各面板存自己的市場（加權／櫃買並排免切換）。
// 版面沒有指定 index 時才沿用上次的 localStorage 選擇，舊存檔因此不受影響。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IcProjection } from '../lib/types/market';

const m = vi.hoisted(() => ({ indexes: [] as string[] }));

vi.mock('../hooks/use-index-components', () => ({
    useIndexComponents: (index: { code: string }, projections: IcProjection[]) => {
        m.indexes.push(index.code);
        return {
            states: projections.map(() => undefined),
            subErrors: projections.map(() => undefined),
            bootstrap: { status: 'ready' },
        };
    },
}));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../lib/index-components', () => ({
    getIcBootstrapGroupWeights: () => new Map<string, number>(),
    getIcGroupWperfAt: () => undefined,
}));
vi.mock('../lib/sector-sync', () => ({ useFocusedSector: () => null }));
vi.mock('../lib/trade', () => ({ notify: () => undefined }));
vi.mock('../lib/theme-store', () => ({
    useThemeSettings: () => ({ mode: 'dark', convention: 'tw', fontScale: 1 }),
}));
vi.mock('../lib/stock-index', () => ({
    loadStockDetails: () => Promise.resolve([]),
    SECTOR_INDICES: [],
}));

const { SectorHeatmap } = await import('./sector-heatmap');

const INDEX_KEY = 'sj-pro-panorama-index';
const text = (n: ReactTestInstance): string =>
    n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
let views: ReactTestRenderer[] = [];

function pressed(root: ReactTestInstance, label: string) {
    const btn = root.find(
        (n) => n.type === 'button' && text(n) === label && typeof n.props['aria-pressed'] === 'boolean',
    );
    return btn.props['aria-pressed'] as boolean;
}

async function render(props: Record<string, unknown> = {}) {
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(createElement(SectorHeatmap, props));
    });
    views.push(view);
    return view;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    m.indexes = [];
});

afterEach(async () => {
    for (const v of views) await act(async () => v.unmount());
    views = [];
    vi.unstubAllGlobals();
});

it('兩個面板各看各的市場，互不干擾', async () => {
    const a = await render({ index: 'IX0001' });
    const b = await render({ index: 'IX0043' });
    expect(m.indexes).toContain('IX0001');
    expect(m.indexes).toContain('IX0043');
    expect(pressed(a.root, '加權')).toBe(true);
    expect(pressed(a.root, '櫃買')).toBe(false);
    expect(pressed(b.root, '櫃買')).toBe(true);
    expect(pressed(b.root, '加權')).toBe(false);
});

it('版面沒指定市場 → 沿用上次的 localStorage 選擇', async () => {
    localStorage.setItem(INDEX_KEY, 'IX0043');
    const v = await render();
    expect(pressed(v.root, '櫃買')).toBe(true);
    expect(m.indexes).not.toContain('IX0001');
});

it('沒有任何選擇時預設加權', async () => {
    const v = await render();
    expect(pressed(v.root, '加權')).toBe(true);
});

it('點市場切換 → 回報給版面，並記住選擇', async () => {
    const onIndexChange = vi.fn();
    const v = await render({ index: 'IX0001', onIndexChange });
    const btn = v.root.find(
        (n) => n.type === 'button' && text(n) === '櫃買' && typeof n.props['aria-pressed'] === 'boolean',
    );
    await act(async () => {
        btn.props.onClick();
    });
    expect(onIndexChange).toHaveBeenCalledWith('IX0043');
    expect(localStorage.getItem(INDEX_KEY)).toBe('IX0043');
    expect(pressed(v.root, '櫃買')).toBe(true);
});

it('版面換掉市場 → 面板跟著換', async () => {
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(createElement(SectorHeatmap, { index: 'IX0001' }));
    });
    views.push(view);
    expect(pressed(view.root, '加權')).toBe(true);
    await act(async () => {
        view.update(createElement(SectorHeatmap, { index: 'IX0043' }));
    });
    expect(pressed(view.root, '櫃買')).toBe(true);
    expect(pressed(view.root, '加權')).toBe(false);
});