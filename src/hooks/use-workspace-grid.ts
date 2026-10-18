import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { GRID_LEGACY_COLS, type Workspace } from '../lib/workspace';
import { desktopGridLayout, gridDensity, NARROW_GRID_WIDTH, normalizeGridLayout, projectNarrowGridLayout, sameGridGeometry, storeGridLayout } from '../lib/workspace-grid';

interface WorkspaceGridOptions {
    workspace: Workspace;
    workspaceRef: RefObject<Workspace>;
    workspaceGenerationRef: RefObject<number>;
    width: number;
    updateWorkspace: (workspace: Workspace) => void;
}

interface GridSource {
    layout: Layout;
    childKeys: string;
    generation: number;
}

interface GestureFrame extends GridSource {
    id: string;
    kind: 'drag' | 'resize';
    density: number;
    cols: number;
    width: number;
    renderLayout: Layout;
}

const childKeysOf = (workspace: Workspace) => JSON.stringify(workspace.blocks.map(block => block.id));
function sameGridSource(frame: GridSource, workspace: Workspace, generation: number) {
    return frame.layout === workspace.layout && frame.childKeys === childKeysOf(workspace) && frame.generation === generation;
}

/** Keep pixel-to-grid calculations and canonical coordinates in one gesture frame. */
export function useWorkspaceGrid({ workspace, workspaceRef, workspaceGenerationRef, width, updateWorkspace }: WorkspaceGridOptions) {
    const [gesture, setGesture] = useState<GestureFrame | null>(null);
    const sessionRef = useRef<GestureFrame | null>(null);
    const generation = workspaceGenerationRef.current;
    const activeFrame = gesture && sameGridSource(gesture, workspace, generation) ? gesture : null;
    const density = activeFrame?.density ?? gridDensity(width);
    const renderCols = activeFrame?.cols ?? GRID_LEGACY_COLS * density;
    const renderWidth = activeFrame?.width ?? width;
    const projected = !activeFrame && width < NARROW_GRID_WIDTH;
    const desktop = useMemo(() => activeFrame?.renderLayout ?? desktopGridLayout(workspace, width, density), [activeFrame, workspace, width, density]);
    const renderLayout = useMemo(() => projected
        ? projectNarrowGridLayout(desktop, workspace.blocks.map(block => block.id), renderCols) : desktop,
    [projected, desktop, workspace.blocks, renderCols]);
    const normalizedGridLayout = useMemo(
        () => normalizeGridLayout(renderLayout, workspace.blocks.map(block => block.id), renderCols),
        [renderLayout, workspace.blocks, renderCols],
    );
    const renderFrame = useMemo(() => ({ projected, normalizedGridLayout, density, layout: workspace.layout, childKeys: childKeysOf(workspace), generation }),
        [projected, normalizedGridLayout, density, workspace, generation]);
    const committedFrame = useRef(renderFrame);
    useLayoutEffect(() => { committedFrame.current = renderFrame; }, [renderFrame]);
    const persistGridLayout = useCallback((next: Layout, coordinateDensity: number) => {
        // Preserve panel writes made in the same commit, not the render's older workspace.
        const current = workspaceRef.current;
        const stored = storeGridLayout(current.layout, next, coordinateDensity);
        if (stored) updateWorkspace({ ...current, layout: stored });
    }, [workspaceRef, updateWorkspace]);
    const onLayoutChange = useCallback((next: Layout) => {
        if (committedFrame.current !== renderFrame || renderFrame.projected) return;
        if (!sameGridSource(renderFrame, workspaceRef.current, workspaceGenerationRef.current)) return;
        const session = sessionRef.current;
        if (session && sameGridSource(session, workspaceRef.current, workspaceGenerationRef.current)) return;
        // RGL can emit its previous-density layout while synchronizing new props.
        if (sameGridGeometry(next, normalizedGridLayout)) persistGridLayout(next, density);
    }, [renderFrame, normalizedGridLayout, persistGridLayout, density, workspaceRef, workspaceGenerationRef]);
    const startGesture = useCallback((kind: GestureFrame['kind'], next: Layout, item: LayoutItem | null) => {
        if (!item || committedFrame.current !== renderFrame || projected
            || sessionRef.current && sameGridSource(sessionRef.current, workspaceRef.current, workspaceGenerationRef.current)) return;
        if (!sameGridSource(renderFrame, workspaceRef.current, workspaceGenerationRef.current)
            || !sameGridGeometry(next, normalizedGridLayout)) return;
        const frame: GestureFrame = { id: item.i, kind, density, cols: renderCols, width: renderWidth, renderLayout: normalizedGridLayout,
            layout: workspaceRef.current.layout, childKeys: childKeysOf(workspaceRef.current), generation: workspaceGenerationRef.current };
        sessionRef.current = frame;
        setGesture(frame);
    }, [renderFrame, projected, workspaceRef, workspaceGenerationRef, normalizedGridLayout, density, renderCols, renderWidth]);
    const stopGesture = useCallback((kind: GestureFrame['kind'], next: Layout, item: LayoutItem | null) => {
        if (!gesture || sessionRef.current !== gesture || gesture.kind !== kind || item?.i !== gesture.id) return;
        sessionRef.current = null;
        setGesture(null); // Also unlock a changed viewport when a no-op stop has no workspace write.
        if (sameGridSource(gesture, workspaceRef.current, workspaceGenerationRef.current)) persistGridLayout(next, gesture.density);
    }, [gesture, workspaceRef, workspaceGenerationRef, persistGridLayout]);
    const gridProps = useMemo(() => ({
        onLayoutChange,
        onDragStart: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => startGesture('drag', next, item),
        onResizeStart: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => startGesture('resize', next, item),
        onDragStop: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => stopGesture('drag', next, item),
        onResizeStop: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => stopGesture('resize', next, item),
        dragConfig: { enabled: !projected, handle: '.drag-handle', cancel: 'button, input, select' },
        resizeConfig: { enabled: !projected },
    }), [onLayoutChange, startGesture, stopGesture, projected]);
    return { renderLayout, renderCols, renderWidth, gridProps };
}
