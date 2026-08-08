// src/lib/layout-thumb.ts — workspace → SVG thumbnail geometry (pure).
// Grid coords (24 cols × maxY rows) scale into a fixed-size pixel box so
// every layout thumbnail keeps the same footprint regardless of how tall
// the layout is. Rendering lives in layout-library.tsx; this stays pure
// for unit tests.

import type { Workspace, BlockType } from './workspace';
import { BLOCK_META } from './workspace';

export const THUMB_GRID_COLS = 24;

export interface ThumbRect {
    id: string;
    type: BlockType;
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

// max(y + h) — logical row count of the layout (min 1 to avoid ÷0)
export function layoutRows(ws: Workspace): number {
    return Math.max(1, ...ws.layout.map((l) => l.y + l.h));
}

export function thumbRects(
    ws: Workspace,
    width: number,
    height: number,
    gap = 2,
): ThumbRect[] {
    const rows = layoutRows(ws);
    const sx = width / THUMB_GRID_COLS;
    const sy = height / rows;
    const types = new Map(ws.blocks.map((b) => [b.id, b.type]));
    return ws.layout.flatMap((l) => {
        const type = types.get(l.i);
        if (!type) return [];
        return [
            {
                id: l.i,
                type,
                label: BLOCK_META[type].label,
                x: l.x * sx + gap / 2,
                y: l.y * sy + gap / 2,
                w: Math.max(1, l.w * sx - gap),
                h: Math.max(1, l.h * sy - gap),
            },
        ];
    });
}

// how many label characters fit inside a rect; 0 → draw a plain block
export function labelChars(
    rect: Pick<ThumbRect, 'w' | 'h'>,
    fontSize: number,
): number {
    if (rect.h < fontSize + 4) return 0;
    const fit = Math.floor((rect.w - 4) / fontSize);
    return fit >= 2 ? fit : 0;
}
