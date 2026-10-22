// src/lib/portfolio-lanes-layout.ts — lanes of the 持股「資金通道」for the
// shared river engine (components/chain-river.tsx, the same one 排行 uses).
//
// One lane per held group, ordered by the window's net inflow (inflow on
// top, a gap, outflow below; weight order before the first bar). The band
// sits in the row's first RIVER_ROW_PX; my stocks follow on a chip line
// under it. Length = net inflow (square-root scale shared by both sides, as
// in 排行); thickness = my weight in the group, on the same 3–16 px range
// 排行 uses for turnover, so both views read with one visual vocabulary.

import { riverLength } from './chain-motion';
import { bandThickness } from './chain-river';

/**
 * Band line of a row: the river engine draws each band in the middle of the
 * row's first RIVER_ROW_PX (components/chain-river.tsx); kept here as a plain
 * number so styles can use it (a test pins it to the engine's value).
 */
export const BAND_LINE_PX = 34;
/** Chip line under the band. */
export const CHIP_LINE_PX = 18;
/** Space between two holdings rows. */
export const ROW_GAP_PX = 6;
/** Gap between the inflow and the outflow rows. */
export const SIDE_GAP_PX = 14;
/** Emphasis of the lanes other than the selected group (as in 排行). */
export const DIM = 0.4;

export interface LaneInput {
    id: string;
    net: number;
    weight: number;
}

export interface LaneTarget {
    id: string;
    y: number;
    m: number;
    thick: number;
    focus: number;
}

export interface LanesLayout<T extends LaneInput> {
    rows: (T & { y: number })[];
    lanes: LaneTarget[];
    height: number;
    /** y of the hairline between inflow and outflow, null without both sides. */
    divider: number | null;
}

export function laneOrder<T extends LaneInput>(rows: readonly T[], live: boolean): T[] {
    const list = [...rows];
    if (!live) list.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    else list.sort((a, b) => b.net - a.net || a.id.localeCompare(b.id));
    return list;
}

export function layoutLanes<T extends LaneInput>(
    rows: readonly T[],
    { live, rowPx, selected }: { live: boolean; rowPx: number; selected: string | null },
): LanesLayout<T> {
    const ordered = laneOrder(rows, live);
    const maxAbs = Math.max(0, ...ordered.map((r) => Math.abs(r.net)));
    const maxWeight = Math.max(0, ...ordered.map((r) => r.weight));
    const focusShown = selected !== null && ordered.some((r) => r.id === selected);
    const step = rowPx + CHIP_LINE_PX + ROW_GAP_PX;
    let y = 0;
    let divider: number | null = null;
    const placed: (T & { y: number })[] = [];
    const lanes: LaneTarget[] = [];
    ordered.forEach((r, i) => {
        if (live && i > 0 && r.net < 0 && ordered[i - 1]!.net >= 0) {
            divider = y + SIDE_GAP_PX / 2 - ROW_GAP_PX / 2;
            y += SIDE_GAP_PX;
        }
        placed.push({ ...r, y });
        lanes.push({
            id: r.id,
            y,
            m: live ? riverLength(r.net, maxAbs) * Math.sign(r.net) : 0,
            thick: bandThickness(r.weight, maxWeight),
            focus: !focusShown || r.id === selected ? 1 : DIM,
        });
        y += step;
    });
    return { rows: placed, lanes, height: Math.max(0, y - ROW_GAP_PX), divider };
}
