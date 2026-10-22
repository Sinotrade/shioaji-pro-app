// src/lib/portfolio-pack.ts — 持股泡泡的版面：每個持有分組一個外圓，持股以
// d3 packSiblings 排在外圓裡（大小＝市值，√ 比例，全圖同一比例尺）。
// 純函式，畫面（portfolio-bubbles.tsx）只負責座標換算與動畫。

import { packEnclose, packSiblings } from 'd3-hierarchy';

/** Gap between packed members and between members and the rim (px). */
export const PACK_GAP = 1.5;
/** Rim padding of a group with several holdings (px). */
export const PACK_RIM = 6;
/**
 * A group holding a single stock would hug it with the same thin rim and
 * read as one bubble; give it a visibly larger outer ring (a share of the
 * member radius, at least 10 px) so the group circle still shows.
 */
export const SINGLE_RIM_RATIO = 0.35;
export const SINGLE_RIM_MIN = 10;
/** Smallest member radius (px), so tiny holdings stay clickable. */
export const MIN_MEMBER_R = 5;

export interface PackItem {
    code: string;
    value: number;
}

export interface PackedMember {
    code: string;
    /** Offset from the group centre (px). */
    dx: number;
    dy: number;
    r: number;
}

export interface PackedGroup {
    members: PackedMember[];
    /** Outer radius including the rim (px). */
    R: number;
}

export function rimOf(count: number, memberR: number): number {
    return count === 1 ? Math.max(SINGLE_RIM_MIN, memberR * SINGLE_RIM_RATIO) : PACK_RIM;
}

/** Pack one group's holdings at `scale` px per √TWD; deterministic order (value desc, then code). */
export function packGroup(items: readonly PackItem[], scale: number): PackedGroup {
    const sorted = [...items]
        .sort((a, b) => b.value - a.value || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map((it) => ({ code: it.code, r: Math.max(MIN_MEMBER_R, Math.sqrt(Math.max(0, it.value)) * scale) }));
    if (sorted.length === 0) return { members: [], R: PACK_RIM };
    const padded = sorted.map((it) => ({ x: 0, y: 0, r: it.r + PACK_GAP }));
    packSiblings(padded);
    const enclose = packEnclose(padded) ?? { x: 0, y: 0, r: padded[0]!.r };
    return {
        members: sorted.map((it, i) => ({ code: it.code, dx: padded[i]!.x - enclose.x, dy: padded[i]!.y - enclose.y, r: it.r })),
        R: enclose.r + rimOf(sorted.length, sorted[0]!.r),
    };
}

/**
 * One √-scale (px per √TWD) for every member of every group: the biggest
 * group spans about `maxShare` of the plot's short side, and all group
 * circles together take about `areaShare` of the plot (less on narrow panels).
 */
export function packScale(groups: readonly (readonly PackItem[])[], plotW: number, plotH: number): number {
    if (plotW <= 0 || plotH <= 0 || groups.length === 0) return 0;
    const maxR = Math.min(plotW, plotH) * 0.27;
    const target = (plotW < 1000 ? 0.24 : 0.3) * plotW * plotH;
    // content radius of every group at a scale (rims excluded: they do not scale)
    const fit = (scale: number) => {
        const radii = groups.map((items) => {
            const g = packGroup(items, scale);
            return g.R - rimOf(items.length, g.members[0]?.r ?? 0);
        });
        const area = radii.reduce((sum, r) => sum + Math.PI * r * r, 0);
        return Math.min(maxR / Math.max(1e-9, ...radii), Math.sqrt(target / Math.max(1e-9, area)));
    };
    // gaps and the minimum radius do not scale: refine a few times from the linear estimate
    let scale = fit(1);
    for (let i = 0; i < 4; i += 1) scale *= fit(scale);
    return scale;
}

// ── rim labels ──────────────────────────────────────────────────────────────

export interface LabelCircle {
    id: string;
    x: number;
    y: number;
    R: number;
    /** Label width (px). */
    w: number;
}

export interface LabelPlace {
    /** Offset of the label's baseline centre from the circle centre. */
    dx: number;
    dy: number;
}

/** Text box of a label relative to its baseline: 12 px above, 3 px below. */
const ASCENT = 12;
const DESCENT = 3;

/**
 * Place each group's rim label: above the rim, else below it, else nudged
 * sideways, avoiding the frame, every other group's circle and the labels
 * already placed (bigger circles first, so they get the natural spot).
 * When every spot collides the least-overlapping one wins.
 */
export function placeLabels(
    circles: readonly LabelCircle[],
    frame: { top: number; bottom: number; left?: number; right?: number },
): Map<string, LabelPlace> {
    const out = new Map<string, LabelPlace>();
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const order = [...circles].sort((a, b) => b.R - a.R || (a.id < b.id ? -1 : 1));
    for (const c of order) {
        const above = -c.R - 6;
        const below = c.R + 15;
        const nudge = c.w * 0.4;
        const spots: LabelPlace[] = [
            { dx: 0, dy: above },
            { dx: 0, dy: below },
            { dx: -nudge, dy: above },
            { dx: nudge, dy: above },
            { dx: -nudge, dy: below },
            { dx: nudge, dy: below },
        ];
        let best = spots[0]!;
        let bestCost = Infinity;
        for (const spot of spots) {
            const x0 = c.x + spot.dx - c.w / 2;
            const x1 = c.x + spot.dx + c.w / 2;
            const y0 = c.y + spot.dy - ASCENT;
            const y1 = c.y + spot.dy + DESCENT;
            let cost = 0;
            if (y0 < frame.top - 8 || y1 > frame.bottom + 8) cost += 1e6;
            if ((frame.left !== undefined && x0 < frame.left) || (frame.right !== undefined && x1 > frame.right)) cost += 1e6;
            for (const o of circles) {
                if (o.id === c.id) continue;
                const nx = Math.max(x0, Math.min(o.x, x1));
                const ny = Math.max(y0, Math.min(o.y, y1));
                if ((nx - o.x) ** 2 + (ny - o.y) ** 2 < o.R * o.R) cost += 1e4;
            }
            for (const b of boxes) {
                const ox = Math.min(x1, b.x1) - Math.max(x0, b.x0);
                const oy = Math.min(y1, b.y1) - Math.max(y0, b.y0);
                if (ox > 0 && oy > 0) cost += 1e5 + ox * oy;
            }
            // prefer the plain spots, then the smaller nudge
            cost += Math.abs(spot.dx) * 0.01 + (spot.dy > 0 ? 0.001 : 0);
            if (cost < bestCost) {
                bestCost = cost;
                best = spot;
            }
        }
        out.set(c.id, best);
        boxes.push({ x0: c.x + best.dx - c.w / 2, x1: c.x + best.dx + c.w / 2, y0: c.y + best.dy - ASCENT, y1: c.y + best.dy + DESCENT });
    }
    return out;
}
