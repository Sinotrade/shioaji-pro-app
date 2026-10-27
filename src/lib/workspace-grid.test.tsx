import { StrictMode, createElement, useCallback, useEffect, useRef, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { calcGridItemPosition, GridItem, GridLayout, type Layout, type LayoutItem } from 'react-grid-layout';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeGridLayout, sameGridGeometry, storeGridLayout } from './workspace-grid';
import * as gridGeometry from './workspace-grid';
import { desktopGridLayout, gridDensity } from './workspace-grid';
import { toRenderGeom, type Workspace } from './workspace';
import { useWorkspaceGrid } from '../hooks/use-workspace-grid';
import appSource from '../App.tsx?raw';
import ts from 'typescript';

const initial: LayoutItem[] = [
    { i: 'a', x: 0, y: 0, w: 72, h: 8 },
    { i: 'b', x: 72, y: 0, w: 216, h: 8 },
];
const node = {
    addEventListener() {}, removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {}, body: {}, defaultView: {} },
};
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function createHarness(options: { width?: number; guarded?: boolean; layout?: LayoutItem[] } = {}) {
    const geometryCheck = vi.spyOn(gridGeometry, 'sameGridGeometry');
    let legacyCallbacks = 0;
    const stats = {
        renders: 0, writes: 0, capped: false, mounts: 0, unmounts: 0,
        get callbacks() { return options.guarded === false ? legacyCallbacks : geometryCheck.mock.calls.length; },
        get rejected() { return geometryCheck.mock.results.filter(result => result.type === 'return' && result.value === false).length; },
    };
    const api = {
        width: (_width: number) => {},
        bounce: (_width: number, _returnWidth: number) => {},
        replace: (_layout: LayoutItem[], _ids?: string[]) => {},
        updateLayout: (_layout: LayoutItem[]) => {},
        metadata: () => {},
        stored: initial as LayoutItem[],
        blocks: [] as Workspace['blocks'],
    };
    function Panel() {
        useEffect(() => { stats.mounts++; return () => { stats.unmounts++; }; }, []);
        return createElement('span', null, 'public panel');
    }
    function Harness() {
        const [width, setWidth] = useState(options.width ?? 1910);
        const [workspace, setWorkspace] = useState<Workspace>(() => ({
            blocks: (options.layout ?? initial).map(item => ({ id: item.i, type: 'watchlist', pin: null })),
            layout: options.layout ?? initial,
        }));
        const pendingBounce = useRef<number | undefined>(undefined);
        const latest = useRef(workspace);
        latest.current = workspace;
        api.stored = workspace.layout;
        api.blocks = workspace.blocks;
        api.width = setWidth;
        api.bounce = (next, back) => { pendingBounce.current = back; setWidth(next); };
        api.replace = (next, nextIds = next.map(item => item.i)) => {
            const current = latest.current;
            const replacement: Workspace = {
                ...current, layout: next,
                blocks: nextIds.map(id => current.blocks.find(block => block.id === id) ?? { id, type: 'watchlist', pin: null }),
            };
            latest.current = replacement;
            setWorkspace(replacement);
        };
        api.metadata = () => setWorkspace(current => ({ ...current, blocks: current.blocks.map(block => ({ ...block, pin: '2330' })) }));
        api.updateLayout = layout => {
            const next = { ...latest.current, layout };
            latest.current = next;
            setWorkspace(next);
        };
        stats.renders++;
        const updateWorkspace = useCallback((next: Workspace) => {
            // A finite diagnostic cap makes the legacy feedback failure test deterministic.
            if (stats.writes >= 20) { stats.capped = true; return; }
            stats.writes++;
            latest.current = next;
            setWorkspace(next);
        }, []);
        const adapter = useWorkspaceGrid({ workspace, workspaceRef: latest, width, updateWorkspace });
        // Test-only legacy control. The production branch uses the complete shared handler bag.
        const legacyOnLayoutChange = useCallback((next: Layout) => {
            legacyCallbacks++;
            const current = latest.current;
            const layout = storeGridLayout(current.layout, next, gridDensity(width));
            if (layout) updateWorkspace({ ...current, layout });
        }, [width, updateWorkspace]);
        const gridProps = options.guarded === false ? { onLayoutChange: legacyOnLayoutChange } : adapter.gridProps;
        const renderLayout = options.guarded === false ? desktopGridLayout(workspace, width, gridDensity(width)) : adapter.renderLayout;
        const renderCols = options.guarded === false ? gridDensity(width) * 24 : adapter.renderCols;
        useEffect(() => {
            if (pendingBounce.current === undefined) return;
            const back = pendingBounce.current;
            pendingBounce.current = undefined;
            setWidth(back);
        }, [width]);
        return createElement(GridLayout, {
            width: options.guarded === false ? width : adapter.renderWidth, layout: renderLayout,
            gridConfig: { cols: renderCols, rowHeight: 30, margin: [6, 6], containerPadding: [6, 6] },
            ...gridProps,
            children: workspace.blocks.map(({ id }) => createElement('div', { key: id }, createElement(Panel))),
        });
    }
    return { stats, api, element: createElement(StrictMode, null, createElement(Harness)) };
}

async function mountHarness(options?: Parameters<typeof createHarness>[0]) {
    const harness = createHarness(options);
    await act(async () => { view = create(harness.element, { createNodeMock: () => node }); });
    return harness;
}

describe('RGL controlled-layout passive-effect feedback', () => {
    it.each([[1910, 640], [640, 1910]])('rapid %i → %i → first width settles without rewriting stale density', async (first, middle) => {
        const { stats, api } = await mountHarness({ width: first });
        const mounts = stats.mounts;
        const unmounts = stats.unmounts;
        await act(async () => api.bounce(middle, first));
        expect(stats.capped).toBe(false);
        expect(stats.writes).toBe(0);
        expect(stats.rejected).toBeGreaterThanOrEqual(1);
        expect(api.stored).toEqual(initial);
        expect(stats.mounts).toBe(mounts);
        expect(stats.unmounts).toBe(unmounts);
    });

    it('legacy ungated adapter reproduces the same actual RGL feedback chain', async () => {
        const { stats, api } = await mountHarness({ guarded: false });
        await act(async () => api.bounce(320, 1910));
        expect(stats.capped).toBe(true);
        expect(stats.writes).toBe(20);
    });

    it('same-density minW updates and metadata-only rerenders do not rewrite or remount panels', async () => {
        const { stats, api } = await mountHarness({ width: 1801 });
        const before = { ...stats };
        for (const width of [2799, 1910, 1801, 2500]) await act(async () => api.width(width));
        for (let index = 0; index < 4; index++) await act(async () => api.metadata());
        expect(stats.writes).toBe(before.writes);
        expect(stats.mounts).toBe(before.mounts);
        expect(stats.unmounts).toBe(before.unmounts);
        expect(api.stored).toEqual(initial);
    });

    it('mount acknowledges real bounds and vertical compaction without changing frozen inputs', async () => {
        const layout = [{ i: 'a', x: -12, y: 10, w: 400, h: 4 }];
        const original = structuredClone(layout);
        Object.freeze(layout[0]);
        Object.freeze(layout);
        const { stats, api } = await mountHarness({ layout });
        expect(stats.capped).toBe(false);
        expect(stats.writes).toBe(1);
        expect(api.stored[0]).toMatchObject({ x: 0, y: 0, w: 288, h: 4 });
        expect(layout).toEqual(original);
    });

    it('add/remove/profile/reset replacements settle and match actual child keys', async () => {
        const { stats, api } = await mountHarness();
        expect(stats.writes).toBe(0);
        await act(async () => api.replace([...api.stored, { i: 'c', x: 0, y: Infinity, w: 72, h: 4 }]));
        expect(api.stored.find(item => item.i === 'c')?.y).toBe(8);
        expect(stats.writes).toBe(1);
        await act(async () => api.replace(api.stored, ['a', 'c']));
        expect(api.stored.map(item => item.i)).toEqual(['a', 'c']);
        expect(stats.writes).toBe(2);
        await act(async () => api.replace([{ i: 'profile', x: 0, y: 30, w: 288, h: 4 }]));
        expect(api.stored).toMatchObject([{ i: 'profile', y: 0, w: 288 }]);
        expect(stats.writes).toBe(3);
        await act(async () => api.replace(initial));
        expect(api.stored).toEqual(initial);
        expect(stats.capped).toBe(false);
        expect(stats.writes).toBe(3);
    });

    it('missing child layout receives the same default row as RGL and orphan rows disappear', async () => {
        const { stats, api } = await mountHarness();
        await act(async () => api.replace(initial, ['b', 'new']));
        expect(api.stored.map(item => item.i)).toEqual(['b', 'new']);
        expect(api.stored.find(item => item.i === 'new')).toMatchObject({ x: 0, y: 0, w: 6, h: 1 });
        expect(stats.capped).toBe(false);
    });

    it('actual RGL drag-stop persists a changed geometry rejected as an autonomous acknowledgment', async () => {
        const { stats, api } = await mountHarness();
        await act(async () => view!.root.findByType(GridLayout).props.onLayoutChange(initial.map(row => ({ ...row, w: 1 }))));
        expect(stats.writes).toBe(0);
        const item = () => view!.root.findAllByType(GridItem).find(row => row.props.i === 'a')!;
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 12, y: 8, w: 72 });
        expect(stats.writes).toBe(1);
        expect(stats.rejected).toBeGreaterThan(0);
        expect(stats.capped).toBe(false);
    });

    it('actual RGL resize-stop persists width/height without an autonomous write during the gesture', async () => {
        const { stats, api } = await mountHarness();
        const item = () => view!.root.findAllByType(GridItem).find(row => row.props.i === 'a')!;
        await act(async () => item().props.onResizeStart('a', 12, 8, { e: {}, node }));
        await act(async () => item().props.onResize('a', 10, 10, { e: {}, node, handle: 'se' }));
        expect(stats.writes).toBe(0);
        await act(async () => item().props.onResizeStop('a', 10, 10, { e: {}, node }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 0, y: 0, w: 60, h: 10 });
        expect(stats.writes).toBe(1);
        expect(stats.capped).toBe(false);
    });
});

describe('gesture coordinate epoch', () => {
    const item = (id = 'a') => view!.root.findAllByType(GridItem).find(row => row.props.i === id)!;
    const grid = () => view!.root.findByType(GridLayout).props;
    const draggable = () => item().find(row => typeof row.props.onStart === 'function' && typeof row.props.onStop === 'function');
    const resizable = () => item().find(row => typeof row.props.onResizeStart === 'function' && !!row.props.draggableOpts);
    const position = (w: number, h: number) => {
        const { margin, containerPadding, containerWidth, cols, rowHeight, maxRows } = item().props;
        return calcGridItemPosition({ margin, containerPadding, containerWidth, cols, rowHeight, maxRows }, 0, 0, w, h);
    };
    const physicalNode = { ...node, offsetParent: { scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
        getBoundingClientRect: () => ({ left: 6, top: 6 }) };

    it.each([[1910, 640], [640, 1910]])('physical drag callbacks %i → %i retain pixel-to-grid coordinates', async (start, next) => {
        const { api, stats } = await mountHarness({ width: start });
        const originalCols = grid().gridConfig.cols;
        const columnPixels = (start - 12 - 6 * (originalCols - 1)) / originalCols + 6;
        await act(async () => draggable().props.onStart({ clientX: 6, clientY: 6 }, { node: physicalNode }));
        // Cross RGL's public drag threshold before the viewport changes.
        await act(async () => draggable().props.onDrag({ clientX: 10, clientY: 6 }, { node: physicalNode, deltaX: 0, deltaY: 0 }));
        await act(async () => api.width(next));
        expect(grid().width).toBe(start);
        await act(async () => draggable().props.onDrag({ clientX: 10 + columnPixels * 2, clientY: 366 }, { node: physicalNode, deltaX: columnPixels * 2, deltaY: 360 }));
        await act(async () => draggable().props.onStop({}, { node: physicalNode }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 2 * 12 / gridDensity(start), w: 72 });
        expect(stats.writes).toBe(1);
        expect(grid().width).toBe(next);
    });

    it.each([[1910, 640], [640, 1910], [1910, 320]])('physical resize callbacks %i → %i decode the original pixel width', async (start, next) => {
        const { api, stats } = await mountHarness({ width: start });
        const originalColumns = 72 * gridDensity(start) / 12;
        const startSize = position(originalColumns, 8);
        const resized = position(originalColumns + 2, 10);
        await act(async () => resizable().props.onResizeStart({ nativeEvent: {} }, { node: physicalNode, size: startSize, handle: 'se' }));
        const constraints = item().props.minW;
        await act(async () => api.width(next));
        expect(grid().width).toBe(start);
        expect(item().props.minW).toBe(constraints);
        await act(async () => resizable().props.onResize({ nativeEvent: {} }, { node: physicalNode, size: resized, handle: 'se' }));
        await act(async () => resizable().props.onResizeStop({ nativeEvent: {} }, { node: physicalNode, size: resized, handle: 'se' }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ w: (originalColumns + 2) * 12 / gridDensity(start), h: 10 });
        expect(stats.writes).toBe(1);
        expect(grid().width).toBe(next);
    });

    it.each([[1910, 640], [640, 1910], [1910, 320]])('drag %i → %i keeps its coordinate epoch through stop', async (start, next) => {
        const { api, stats } = await mountHarness({ width: start });
        const cols = grid().gridConfig.cols;
        const mounts = stats.mounts;
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.width(next));
        expect(grid().gridConfig.cols).toBe(cols);
        expect(grid().width).toBe(start);
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(api.stored.find(row => row.i === 'a')?.w).toBe(72);
        expect(stats.writes).toBe(1);
        expect(stats.mounts).toBe(mounts);
        expect(stats.capped).toBe(false);
        expect(grid().gridConfig.cols).toBe(gridDensity(next) * 24);
        expect(grid().width).toBe(next);
    });

    it('resize across density stores 10 original columns as 60, not 120', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onResizeStart('a', 12, 8, { e: {}, node }));
        await act(async () => item().props.onResize('a', 10, 10, { e: {}, node, handle: 'se' }));
        await act(async () => api.width(320));
        expect(grid().gridConfig.cols).toBe(48);
        await act(async () => item().props.onResizeStop('a', 10, 10, { e: {}, node }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ w: 60, h: 10 });
        expect(stats.writes).toBe(1);
    });

    it('no-op stop still unlocks a pending narrow projection without a write', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.width(320));
        expect(grid().gridConfig.cols).toBe(48);
        await act(async () => item().props.onDragStop('a', 0, 0, { e: {}, node }));
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(grid().layout.every((row: LayoutItem) => row.x === 0 && row.w === 24)).toBe(true);
        expect(grid().dragConfig.enabled).toBe(false);
    });

    it('multiple width changes and panel metadata retain the gesture frame and merge latest metadata', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        for (const width of [2800, 320, 3900, 640]) await act(async () => api.width(width));
        await act(async () => api.metadata());
        expect(grid().width).toBe(1910);
        expect(grid().gridConfig.cols).toBe(48);
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(grid().width).toBe(640);
        expect(api.blocks.every(block => block.pin === '2330')).toBe(true);
        expect(api.stored.find(row => row.i === 'a')?.w).toBe(72);
        expect(stats.writes).toBe(1);
    });

    it.each(['profile', 'same-layout reset', 'remove'] as const)('%s invalidates a captured old stop without overwriting the new workspace', async action => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        const stop = item().props.onDragStop;
        await act(async () => api.width(320));
        const replacement = action === 'profile' ? initial.map(row => ({ ...row, x: row.i === 'a' ? 72 : 144, w: 72 }))
            : action === 'remove' ? [initial[1]!] : structuredClone(initial);
        await act(async () => api.replace(replacement));
        await act(async () => stop('a', 2, 10, { e: {}, node }));
        expect(api.stored).toEqual(replacement);
        expect(stats.writes).toBe(0);
        expect(stats.capped).toBe(false);
        expect(grid().width).toBe(320);
        expect(grid().dragConfig.enabled).toBe(false);
    });

    it('a workspace replacement revokes captured callbacks before React commits', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        const old = grid();
        const replacement = [{ i: 'a', x: 0, y: 0, w: 144, h: 4 }];
        await act(async () => {
            api.replace(replacement);
            old.onDragStop(initial.map(row => ({ ...row, x: 2 })), initial[0], initial[0]);
            old.onLayoutChange(initial.map(row => ({ ...row, ...toRenderGeom(row, 2) })));
        });
        expect(api.stored).toEqual(replacement);
        expect(stats.writes).toBe(0);
    });

    it('an equal-content replacement revokes the drop and RGL shows the stored position again', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.replace(structuredClone(initial)));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(item().props).toMatchObject({ x: 0, y: 0 });
        // Later gestures persist again instead of being rejected as foreign geometry.
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(stats.writes).toBe(1);
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 12 });
    });

    it('a replacement that keeps the layout (agent pin) still saves the drop', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.replace(api.stored));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(stats.writes).toBe(1);
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 12 });
    });

    it('a same-generation layout update revokes the previous gesture source', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        const stop = grid().onDragStop;
        await act(async () => api.width(640));
        const changed = initial.map(row => ({ ...row, h: 6 }));
        await act(async () => api.updateLayout(changed));
        expect(grid().width).toBe(640);
        await act(async () => stop(initial.map(row => ({ ...row, x: 2 })), initial[0], initial[0]));
        expect(api.stored).toEqual(changed);
        expect(stats.writes).toBe(0);
    });

    it('a stale start with an unrecognized coordinate frame grants no stop authority', async () => {
        const { api, stats } = await mountHarness();
        const old = grid();
        await act(async () => old.onDragStart(initial, initial[0], initial[0]));
        await act(async () => api.width(320));
        expect(grid().width).toBe(320);
        await act(async () => grid().onDragStop(initial, initial[0], initial[0]));
        expect(api.stored).toEqual(initial);
        expect(stats.writes).toBe(0);
    });

    it('an unmounted gesture never writes or remounts surviving panels', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.width(320));
        await act(async () => view!.unmount());
        view = undefined;
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
    });
});

describe('narrow display-only workspace', () => {
    const grid = () => view!.root.findByType(GridLayout).props;

    it.each([320, 360, 639])('container %i projects every child to a full-width vertical row with zero persistence', async width => {
        const { api, stats } = await mountHarness({ width });
        expect(grid().layout.map(({ i, x, y, w }: LayoutItem) => ({ i, x, y, w }))).toEqual([
            { i: 'a', x: 0, y: 0, w: 24 }, { i: 'b', x: 0, y: 8, w: 24 },
        ]);
        expect(grid().dragConfig.enabled).toBe(false);
        expect(grid().resizeConfig.enabled).toBe(false);
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
    });

    it('640 is the desktop boundary and restores normal interactions', async () => {
        const { stats } = await mountHarness({ width: 640 });
        expect(grid().dragConfig.enabled).toBe(true);
        expect(grid().resizeConfig.enabled).toBe(true);
        expect(grid().layout[0].w).toBe(6);
        expect(stats.writes).toBe(0);
    });

    it('stored per-item interaction overrides cannot enable dragging or resizing in narrow mode', async () => {
        const enabled = initial.map(row => ({ ...row, isDraggable: true, isResizable: true }));
        const { api, stats } = await mountHarness({ width: 320, layout: enabled });
        expect(view!.root.findAllByType(GridItem).every(row => !row.props.isDraggable && !row.props.isResizable)).toBe(true);
        expect(api.stored).toEqual(enabled);
        expect(stats.writes).toBe(0);
    });

    it('320 → 1280 → 360 → 1910 preserves canonical precision and mounted panels', async () => {
        const fine = [{ i: 'a', x: 7, y: 0, w: 67, h: 8 }];
        const { api, stats } = await mountHarness({ width: 320, layout: fine });
        const mounts = stats.mounts;
        const unmounts = stats.unmounts;
        for (const width of [1280, 360, 1910]) await act(async () => api.width(width));
        expect(api.stored).toEqual(fine);
        expect(stats.writes).toBe(0);
        expect(stats.mounts).toBe(mounts);
        expect(stats.unmounts).toBe(unmounts);
        expect(grid().dragConfig.enabled).toBe(true);
        expect(grid().resizeConfig.enabled).toBe(true);
    });

    it('captured wide callbacks and attempted narrow gestures cannot persist a projection', async () => {
        const { api, stats } = await mountHarness();
        const old = grid();
        await act(async () => api.width(320));
        const projected = grid().layout;
        await act(async () => {
            old.onLayoutChange(initial.map(row => ({ ...row, w: 1 })));
            old.onDragStart(initial, initial[0], initial[0]);
            grid().onDragStart(projected, projected[0], projected[0]);
            grid().onDragStop(projected, projected[0], projected[0]);
            grid().onResizeStart(projected, projected[0], projected[0]);
            grid().onResizeStop(projected, projected[0], projected[0]);
            grid().onLayoutChange(projected);
        });
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(grid().width).toBe(320);
    });

    it('narrow profile/remove changes remain canonical, including their original gaps', async () => {
        const { api, stats } = await mountHarness({ width: 320 });
        const profile = [{ i: 'profile', x: 13, y: 30, w: 151, h: 7 }];
        await act(async () => api.replace(profile));
        expect(api.stored).toEqual(profile);
        expect(grid().layout[0]).toMatchObject({ x: 0, y: 0, w: 24, h: 7 });
        expect(stats.writes).toBe(0);
        // The wide view may compact a profile's existing gap, but never stores the narrow projection.
        await act(async () => api.width(1280));
        expect(api.stored[0]).toMatchObject({ x: 12, w: 156, y: 0 });
        expect(stats.writes).toBe(1);
    });
});

describe('grid geometry boundaries', () => {
    it('projection follows canonical visual order, strips orphans and does not mutate frozen rows', () => {
        const rows = [{ i: 'b', x: 12, y: 0, w: 12, h: 3 }, { i: 'a', x: 0, y: 0, w: 12, h: 5 }, { i: 'orphan', x: 0, y: 5, w: 24, h: 8 }];
        const copy = structuredClone(rows);
        rows.forEach(Object.freeze);
        Object.freeze(rows);
        expect(gridGeometry.projectNarrowGridLayout(rows, ['b', 'a'], 24)).toMatchObject([
            { i: 'a', x: 0, y: 0, w: 24, h: 5, minW: 24, maxW: 24, static: true, isDraggable: false, isResizable: false },
            { i: 'b', x: 0, y: 5, w: 24, h: 3, static: true },
        ]);
        expect(rows).toEqual(copy);
    });
    it.each([[0, 1], [1799, 1], [1800, 2], [2799, 2], [2800, 3], [3899, 3], [3900, 4]])('width %i uses the shared density %i', (width, density) => {
        expect(gridDensity(width)).toBe(density);
    });

    it('normalization follows child order, excludes orphans and does not mutate inputs', () => {
        const layout = [{ i: 'a', x: 0, y: 8, w: 4, h: 4 }, { i: 'orphan', x: 0, y: 0, w: 24, h: 5 }];
        const original = structuredClone(layout);
        expect(normalizeGridLayout(layout, ['new', 'a'], 24).map(item => item.i)).toEqual(['new', 'a']);
        expect(layout).toEqual(original);
    });

    it('geometry matching ignores ordering and constraints, not identity or duplicate rows', () => {
        expect(sameGridGeometry(initial, [...initial].reverse().map(item => ({ ...item, minW: 1, moved: true })))).toBe(true);
        expect(sameGridGeometry(initial, [initial[0]!, initial[0]!])).toBe(false);
        expect(sameGridGeometry([initial[0]!, initial[0]!], initial)).toBe(false);
        expect(sameGridGeometry(initial, initial.slice(1))).toBe(false);
    });

    it.each(['i', 'x', 'y', 'w', 'h'] as const)('%s differences reject stale autonomous rows', key => {
        const changed = initial.map(item => ({ ...item }));
        if (key === 'i') changed[0]!.i = 'other';
        else changed[0]![key]++;
        expect(sameGridGeometry(initial, changed)).toBe(false);
    });

    it.each([1, 2, 3, 4])('density %i acknowledgment preserves sub-render precision and row identity', density => {
        const current = [{ i: 'fine', x: 7, y: 0, w: 67, h: 8, minW: 36 }];
        const rendered = current.map(item => ({ ...item, ...toRenderGeom(item, density) }));
        expect(storeGridLayout(current, rendered, density)).toBeUndefined();
        const changed = storeGridLayout(current, [...rendered, { i: 'new', x: 0, y: 8, w: 1, h: 1 }], density)!;
        expect(changed[0]).toBe(current[0]);
        expect(changed[1]?.w).toBe(12 / density);
    });
});

describe('App shared-adapter wiring', () => {
    it('spreads the shared handler bag without local overrides or a remount key', () => {
        const source = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const nodes: ts.Node[] = [];
        const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
        visit(source);
        const hookImport = nodes.filter(ts.isImportDeclaration).find(node =>
            ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './hooks/use-workspace-grid');
        expect(hookImport?.importClause?.namedBindings?.getText(source)).toContain('useWorkspaceGrid');
        const declaration = nodes.filter(ts.isVariableDeclaration).find(node =>
            node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useWorkspaceGrid');
        expect(declaration && ts.isObjectBindingPattern(declaration.name)).toBe(true);
        if (!declaration || !ts.isObjectBindingPattern(declaration.name)) throw new Error('Missing shared grid adapter destructuring');
        const bindings = new Map(declaration.name.elements.map(binding => [
            (binding.propertyName ?? binding.name).getText(source), binding.name.getText(source),
        ]));
        expect(bindings.get('gridProps')).toBeTruthy();
        const grids = nodes.filter(ts.isJsxOpeningElement).filter(node => node.tagName.getText(source) === 'GridLayout');
        expect(grids).toHaveLength(1);
        const properties = grids[0]!.attributes.properties;
        const spreads = properties.filter(ts.isJsxSpreadAttribute);
        expect(spreads.map(spread => spread.expression.getText(source))).toEqual([bindings.get('gridProps')]);
        const attributes = properties.filter(ts.isJsxAttribute);
        expect(attributes.filter(attribute => ['onLayoutChange', 'onDragStart', 'onResizeStart', 'onDragStop', 'onResizeStop', 'dragConfig', 'resizeConfig', 'key'].includes(attribute.name.getText(source)))).toHaveLength(0);
        const layout = attributes.find(attribute => attribute.name.getText(source) === 'layout');
        expect(layout?.initializer && ts.isJsxExpression(layout.initializer) ? layout.initializer.expression?.getText(source) : undefined).toBe(bindings.get('renderLayout'));
        const width = attributes.find(attribute => attribute.name.getText(source) === 'width');
        expect(width?.initializer && ts.isJsxExpression(width.initializer) ? width.initializer.expression?.getText(source) : undefined).toBe(bindings.get('renderWidth'));
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) throw new Error('Missing shared adapter call');
        const options = declaration.initializer.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error('Missing shared adapter options');
        const config = attributes.find(attribute => attribute.name.getText(source) === 'gridConfig');
        expect(config?.initializer && ts.isJsxExpression(config.initializer) && config.initializer.expression && ts.isObjectLiteralExpression(config.initializer.expression)).toBe(true);
        if (!config?.initializer || !ts.isJsxExpression(config.initializer) || !config.initializer.expression || !ts.isObjectLiteralExpression(config.initializer.expression)) throw new Error('Missing grid config');
        const cols = config.initializer.expression.properties.filter(ts.isPropertyAssignment).find(property => property.name.getText(source) === 'cols');
        expect(cols?.initializer.getText(source)).toBe(bindings.get('renderCols'));
    });
});
