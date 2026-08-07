// src/lib/list-move.ts — pure neighbor lookup for the watchlist 排序模式
// 上移/下移 buttons. Kept out of the component so the move decision is
// unit-testable; the actual reorder goes through the same onReorder
// (drag-to-reorder) server-persisting path.

// which code should `code` swap toward? null = at the edge / not found
export function neighborCode(
    codes: string[],
    code: string,
    dir: -1 | 1,
): string | null {
    const i = codes.indexOf(code);
    if (i < 0) return null;
    const j = i + dir;
    if (j < 0 || j >= codes.length) return null;
    return codes[j] ?? null;
}
