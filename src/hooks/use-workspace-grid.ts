import { useCallback, useMemo, useState, type RefObject } from 'react';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { GRID_LEGACY_COLS, type Workspace } from '../lib/workspace';
import { desktopGridLayout, gridDensity, NARROW_GRID_WIDTH, normalizeGridLayout, projectNarrowGridLayout, sameGridGeometry, storeGridLayout } from '../lib/workspace-grid';

interface WorkspaceGridOptions {
    workspace: Workspace;
    workspaceRef: RefObject<Workspace>;
    width: number;
    updateWorkspace: (workspace: Workspace) => void;
}

interface GestureFrame {
    id: string;
    kind: 'drag' | 'resize';
    /** The stored layout the gesture started from; any replacement revokes it. */
    layout: Layout;
    density: number;
    cols: number;
    width: number;
    renderLayout: Layout;
}

/** Keep pixel-to-grid calculations and canonical coordinates in one gesture frame. */
export function useWorkspaceGrid({ workspace, workspaceRef, width, updateWorkspace }: WorkspaceGridOptions) {
    const [gesture, setGesture] = useState<GestureFrame | null>(null);
    const [resync, setResync] = useState(0);
    const activeFrame = gesture?.layout === workspace.layout ? gesture : null;
    const density = activeFrame?.density ?? gridDensity(width);
    const renderCols = activeFrame?.cols ?? GRID_LEGACY_COLS * density;
    const renderWidth = activeFrame?.width ?? width;
    const projected = !activeFrame && width < NARROW_GRID_WIDTH;
    const desktop = useMemo(() => activeFrame?.renderLayout ?? desktopGridLayout(workspace, width, density), [activeFrame, workspace, width, density]);
    const renderLayout = useMemo(() => {
        const layout = projected ? projectNarrowGridLayout(desktop, workspace.blocks.map(block => block.id), renderCols) : desktop;
        // RGL only re-reads an equal-content layout prop when it changes; a revoked drop is undone this way.
        return resync ? layout.map(item => ({ ...item, resync })) : layout;
    }, [projected, desktop, workspace.blocks, renderCols, resync]);
    const normalizedGridLayout = useMemo(
        () => normalizeGridLayout(renderLayout, workspace.blocks.map(block => block.id), renderCols),
        [renderLayout, workspace.blocks, renderCols],
    );
    const persistGridLayout = useCallback((next: Layout, coordinateDensity: number) => {
        // Preserve panel writes made in the same commit, not the render's older workspace.
        const current = workspaceRef.current;
        const stored = storeGridLayout(current.layout, next, coordinateDensity);
        if (stored) updateWorkspace({ ...current, layout: stored });
    }, [workspaceRef, updateWorkspace]);
    const onLayoutChange = useCallback((next: Layout) => {
        if (projected || workspace.layout !== workspaceRef.current.layout) return;
        // RGL can emit its previous-density layout while synchronizing new props.
        if (sameGridGeometry(next, normalizedGridLayout)) persistGridLayout(next, density);
    }, [projected, workspace.layout, workspaceRef, normalizedGridLayout, persistGridLayout, density]);
    const startGesture = useCallback((kind: GestureFrame['kind'], next: Layout, item: LayoutItem | null) => {
        if (!item || projected || activeFrame || workspace.layout !== workspaceRef.current.layout
            || !sameGridGeometry(next, normalizedGridLayout)) return;
        setGesture({ id: item.i, kind, layout: workspace.layout, density, cols: renderCols, width: renderWidth, renderLayout: normalizedGridLayout });
    }, [projected, activeFrame, workspace.layout, workspaceRef, normalizedGridLayout, density, renderCols, renderWidth]);
    const stopGesture = useCallback((kind: GestureFrame['kind'], next: Layout, item: LayoutItem | null) => {
        if (!gesture || gesture.kind !== kind || item?.i !== gesture.id) return;
        setGesture(null); // Also unlock a changed viewport when a no-op stop has no workspace write.
        if (gesture.layout === workspaceRef.current.layout) persistGridLayout(next, gesture.density);
        else setResync(count => count + 1);
    }, [gesture, workspaceRef, persistGridLayout]);
    const gridProps = useMemo(() => ({
        onLayoutChange,
        onDragStart: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => startGesture('drag', next, item),
        onResizeStart: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => startGesture('resize', next, item),
        onDragStop: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => stopGesture('drag', next, item),
        onResizeStop: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => stopGesture('resize', next, item),
        dragConfig: { enabled: !projected, handle: '.drag-handle', cancel: 'button, input, select' },
        resizeConfig: { enabled: !projected },
    }), [onLayoutChange, startGesture, stopGesture, projected]);
    return { renderLayout, renderCols, renderWidth, density, gridProps };
}
