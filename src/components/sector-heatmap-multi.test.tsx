// 產業全景可同時開多個面板：各面板存自己的市場（加權／櫃買並排免切換）。
// 版面沒有指定 index 時用上次的 localStorage 選擇並固定進版面，舊存檔與新面板都一樣。
import { createElement, Fragment, useState } from 'react';
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

/** App 的版面：panoramaIndex 跟著 block 存，重新掛載時由它帶回。 */
function layout(blocks: Record<string, string | undefined>) {
    const props = (id: string) => ({
        index: blocks[id],
        onIndexChange: (code: string) => {
            blocks[id] = code;
        },
    });
    const press = async (view: ReactTestRenderer, label: string) => {
        const btn = view.root.find(
            (n) => n.type === 'button' && text(n) === label && typeof n.props['aria-pressed'] === 'boolean',
        );
        await act(async () => btn.props.onClick());
    };
    return { props, press };
}

it('兩個新面板只切一個，重新掛載後各自維持', async () => {
    const blocks: Record<string, string | undefined> = { a: undefined, b: undefined };
    const { props, press } = layout(blocks);
    const a = await render(props('a'));
    const b = await render(props('b'));
    expect(blocks).toEqual({ a: 'IX0001', b: 'IX0001' });

    await press(b, '櫃買');
    expect(blocks).toEqual({ a: 'IX0001', b: 'IX0043' });

    await act(async () => {
        a.unmount();
        b.unmount();
    });
    views = [];
    const a2 = await render(props('a'));
    const b2 = await render(props('b'));
    expect(pressed(a2.root, '加權')).toBe(true);
    expect(pressed(b2.root, '櫃買')).toBe(true);
});

it('舊存檔沒有市場時固定成上次的選擇，之後別的面板切換也不影響它', async () => {
    localStorage.setItem(INDEX_KEY, 'IX0043');
    const blocks: Record<string, string | undefined> = { old: undefined, added: undefined };
    const { props, press } = layout(blocks);
    const old = await render(props('old'));
    expect(blocks.old).toBe('IX0043');
    expect(pressed(old.root, '櫃買')).toBe(true);

    const added = await render(props('added'));
    await press(added, '加權');
    await act(async () => old.unmount());
    views = views.filter((v) => v !== old);
    const reopened = await render(props('old'));
    expect(pressed(reopened.root, '櫃買')).toBe(true);
});

it('全域選擇只影響之後的新面板', async () => {
    const blocks: Record<string, string | undefined> = { a: undefined, b: undefined };
    const { props, press } = layout(blocks);
    const a = await render(props('a'));
    await press(a, '櫃買');
    const b = await render(props('b'));
    expect(blocks.b).toBe('IX0043');
});

it('同一次 commit 掛載的兩個面板都固定進版面，且各自只切自己', async () => {
    // 比照 App：版面是唯一來源，面板的 index 由回寫後的版面帶回
    let setBlocks!: (update: (b: Record<string, string | undefined>) => Record<string, string | undefined>) => void;
    let latest: Record<string, string | undefined> = {};
    function Layout() {
        const [blocks, set] = useState<Record<string, string | undefined>>({ a: undefined, b: undefined });
        setBlocks = set;
        latest = blocks;
        return createElement(
            Fragment,
            null,
            ...Object.keys(blocks).map((id) =>
                createElement(SectorHeatmap, {
                    key: id,
                    index: blocks[id] as 'IX0001' | 'IX0043' | undefined,
                    onIndexChange: (code: string) => setBlocks((b) => ({ ...b, [id]: code })),
                }),
            ),
        );
    }
    let view!: ReactTestRenderer;
    await act(async () => {
        view = create(createElement(Layout));
    });
    views.push(view);
    expect(latest).toEqual({ a: 'IX0001', b: 'IX0001' });

    const second = view.root.findAll(
        (n) => n.type === 'button' && text(n) === '櫃買' && typeof n.props['aria-pressed'] === 'boolean',
    )[1]!;
    await act(async () => second.props.onClick());
    expect(latest).toEqual({ a: 'IX0001', b: 'IX0043' });
});

it('套用版面重用 block id 且沒有市場時，用全域選擇而不是上一個版面的市場', async () => {
    const onIndexChange = vi.fn();
    const v = await render({ index: 'IX0043', onIndexChange });
    localStorage.setItem(INDEX_KEY, 'IX0001');
    await act(async () => {
        v.update(createElement(SectorHeatmap, { onIndexChange }));
    });
    expect(onIndexChange).toHaveBeenCalledExactlyOnceWith('IX0001');
    expect(pressed(v.root, '加權')).toBe(true);
});

it('已有市場的面板掛載時不回寫版面', async () => {
    const onIndexChange = vi.fn();
    await render({ index: 'IX0043', onIndexChange });
    expect(onIndexChange).not.toHaveBeenCalled();
});
