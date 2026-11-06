import type { Layout, LayoutItem } from 'react-grid-layout';
import { bottom, cloneLayoutItem, correctBounds, verticalCompactor } from 'react-grid-layout/core';
import { BLOCK_META, GRID_LEGACY_COLS, GRID_LEGACY_SCALE, toRenderGeom, type Workspace } from './workspace';

export const NARROW_GRID_WIDTH = 640;

export function gridDensity(width: number): number {
    return width < 1800 ? 1 : width < 2800 ? 2 : width < 3900 ? 3 : 4;
}

export function desktopGridLayout(workspace: Workspace, width: number, density: number): Layout {
    const cols = GRID_LEGACY_COLS * density;
    const colW = width > 0 ? width / cols : 53;
    const typeOf = new Map(workspace.blocks.map(block => [block.id, block.type]));
    return workspace.layout.map(item => {
        const type = typeOf.get(item.i);
        const meta = type && BLOCK_META[type];
        const minPx = (meta?.defaultSize.minW ?? 3) * (1280 / GRID_LEGACY_COLS);
        return { ...item, ...toRenderGeom(item, density), minW: Math.min(Math.max(1, Math.ceil(minPx / colW)), cols) };
    });
}

/** Display only: never pass this projection to storeGridLayout. */
export function projectNarrowGridLayout(layout: Layout, childIds: readonly string[], cols: number): Layout {
    const ordered = [...normalizeGridLayout(layout, childIds, cols)]
        .sort((left, right) => left.y - right.y || left.x - right.x);
    let y = 0;
    return ordered.map(item => {
        const row = { ...item, x: 0, y, w: cols, minW: cols, maxW: cols, static: true, isDraggable: false, isResizable: false };
        y += item.h;
        return row;
    });
}

/** Match RGL's child-key order and its public bounds/compaction rules. */
export function normalizeGridLayout(layout: Layout, childIds: readonly string[], cols: number): Layout {
    const byId = new Map(layout.map(item => [item.i, item]));
    const ordered: LayoutItem[] = [];
    for (const id of childIds) {
        const item = byId.get(id);
        ordered.push(item ? cloneLayoutItem(item) : { i: id, x: 0, y: bottom(ordered), w: 1, h: 1 });
    }
    return verticalCompactor.compact(correctBounds(ordered, { cols }), cols);
}

/** Metadata and array order are not geometry; every child identity must match. */
export function sameGridGeometry(left: Layout, right: Layout): boolean {
    if (left.length !== right.length) return false;
    const remaining = new Map(right.map(item => [item.i, item]));
    if (remaining.size !== right.length) return false;
    return left.every(item => {
        const other = remaining.get(item.i);
        remaining.delete(item.i);
        return !!other && item.x === other.x && item.y === other.y && item.w === other.w && item.h === other.h;
    });
}

/** Preserve stored precision when RGL only acknowledges a rounded render. */
export function storeGridLayout(current: Layout, next: Layout, density: number): LayoutItem[] | undefined {
    const fromRender = GRID_LEGACY_SCALE / density;
    const previous = new Map(current.map(item => [item.i, item]));
    let changed = false;
    const stored = next.map(item => {
        const prior = previous.get(item.i);
        if (prior) {
            const rendered = toRenderGeom(prior, density);
            if (rendered.x === item.x && rendered.w === item.w && prior.y === item.y && prior.h === item.h) return prior;
        }
        changed = true;
        return {
            ...(prior ?? {}),
            i: item.i,
            x: Math.round(item.x * fromRender),
            y: item.y,
            w: Math.max(1, Math.round(item.w * fromRender)),
            h: item.h,
        };
    });
    return !changed && stored.length === current.length ? undefined : stored;
}
