// src/lib/chain-map.ts — pure model for the 產業鏈地圖 panel.
//
// Joins shioaji-data structure (themes / chains with stages and members, the
// relation edge table, daily market cap, latest monthly revenue) with live
// snapshots. No I/O and no React here, so the layout and the aggregates are
// unit-tested and the panel only renders.

import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { ContractBase } from './types/contract';
import type { Snapshot } from './types/market';
import type { ChainTier, Edge, MarketDaily, Theme, ThemeStage } from './company-data/types';

/** Live (or last known) numbers of one Taiwan company. */
export interface Quote {
    /** Latest price; null when the company has not traded and no close is known. */
    close: number | null;
    /** Today's change in percent; null without a live snapshot. */
    pct: number | null;
    /** Turnover in TWD; 0 without a live snapshot. */
    amount: number;
    /** Market cap in TWD at `close` (shares × close). */
    cap: number;
}

/** Latest monthly revenue YoY (%) per code, from `tw/revenue`. */
export type RevenueYoy = ReadonlyMap<string, number>;

export type ColorMetric = 'pct' | 'yoy';
export type SizeMetric = 'cap' | 'amount';

const TIER_ORDER: Record<string, number> = { upstream: 0, midstream: 1, downstream: 2 };

export function tierRank(tier: ChainTier): number {
    return TIER_ORDER[tier] ?? 3;
}

/** Stages in chain order: upstream → midstream → downstream, data order within a tier. */
export function orderedStages(theme: Theme): ThemeStage[] {
    return theme.stages
        .map((stage, index) => ({ stage, index }))
        .sort((a, b) => tierRank(a.stage.tier) - tierRank(b.stage.tier) || a.index - b.index)
        .map(({ stage }) => stage);
}

/** `tw.2330` + market → the stock contract used for snapshots. */
export function stockContract(code: string, market: string | undefined): ContractBase {
    return {
        security_type: 'STK',
        exchange: market === 'tpex' ? 'OTC' : 'TSE',
        code,
        target_code: null,
    };
}

/** Every Taiwan member code across the given themes (deduplicated, stable order). */
export function memberCodes(themes: readonly Theme[]): string[] {
    const seen = new Set<string>();
    for (const theme of themes) {
        for (const member of theme.members) {
            if (member.id.startsWith('tw.')) seen.add(member.id.slice(3));
        }
    }
    return [...seen];
}

/**
 * Merge the official daily close with live snapshots. A snapshot only counts
 * when it has traded (close > 0); otherwise the daily close stands in with no
 * change, so a closed market still lays out by market cap.
 */
export function buildQuotes(
    codes: readonly string[],
    market: MarketDaily | null,
    snapshots: ReadonlyMap<string, Snapshot> | null,
): Map<string, Quote> {
    const quotes = new Map<string, Quote>();
    for (const code of codes) {
        const daily = market?.quotes[code];
        const shares = daily?.shares ?? null;
        const snap = snapshots?.get(code);
        const live = snap && snap.close > 0 ? snap : null;
        const close = live ? live.close : (daily?.close ?? null);
        const cap =
            shares && close ? shares * close : (daily?.market_cap_twd ?? 0);
        quotes.set(code, {
            close,
            pct: live && Number.isFinite(live.change_rate) ? live.change_rate : null,
            amount: live ? live.total_amount : 0,
            cap: cap > 0 ? cap : 0,
        });
    }
    return quotes;
}

export interface Breadth {
    up: number;
    flat: number;
    down: number;
    /** Members without a live change. */
    none: number;
}

export interface GroupStats {
    count: number;
    /** Market-cap-weighted change (previous-close weights); null without live data. */
    pct: number | null;
    amount: number;
    cap: number;
    breadth: Breadth;
    /** Market-cap-weighted monthly revenue YoY; null when none known. */
    yoy: number | null;
}

/** Aggregate a list of codes. Weighted change uses the previous close's cap. */
export function groupStats(codes: Iterable<string>, quotes: ReadonlyMap<string, Quote>, yoy?: RevenueYoy): GroupStats {
    const breadth: Breadth = { up: 0, flat: 0, down: 0, none: 0 };
    let count = 0;
    let amount = 0;
    let cap = 0;
    let wSum = 0;
    let wPct = 0;
    let yoyW = 0;
    let yoySum = 0;
    for (const code of codes) {
        count += 1;
        const q = quotes.get(code);
        if (!q) {
            breadth.none += 1;
            continue;
        }
        amount += q.amount;
        cap += q.cap;
        if (q.pct === null) breadth.none += 1;
        else if (q.pct > 0) breadth.up += 1;
        else if (q.pct < 0) breadth.down += 1;
        else breadth.flat += 1;
        if (q.pct !== null && q.cap > 0) {
            const prevCap = q.cap / (1 + q.pct / 100);
            wSum += prevCap;
            wPct += prevCap * q.pct;
        }
        const y = yoy?.get(code);
        if (y !== undefined && Number.isFinite(y) && q.cap > 0) {
            yoyW += q.cap;
            yoySum += q.cap * y;
        }
    }
    return {
        count,
        pct: wSum > 0 ? wPct / wSum : null,
        amount,
        cap,
        breadth,
        yoy: yoyW > 0 ? yoySum / yoyW : null,
    };
}

export interface ThemeHeat {
    theme: Theme;
    stats: GroupStats;
}

export type HeatSort = 'pct' | 'breadth' | 'amount';

/** Up share of members with a live change, in [-1, 1] (up − down) / live. */
export function breadthScore(b: Breadth): number {
    const live = b.up + b.flat + b.down;
    return live > 0 ? (b.up - b.down) / live : 0;
}

/** Rank themes by today's weighted change, breadth or turnover. */
export function rankThemes(
    themes: readonly Theme[],
    quotes: ReadonlyMap<string, Quote>,
    sort: HeatSort,
    yoy?: RevenueYoy,
): ThemeHeat[] {
    const rows = themes
        .filter((theme) => theme.members.some((m) => m.id.startsWith('tw.')))
        .map((theme) => ({
            theme,
            stats: groupStats(twCodes(theme), quotes, yoy),
        }));
    const key = (row: ThemeHeat) =>
        sort === 'amount'
            ? row.stats.amount
            : sort === 'breadth'
              ? breadthScore(row.stats.breadth)
              : (row.stats.pct ?? -Infinity);
    return rows.sort((a, b) => key(b) - key(a) || b.stats.cap - a.stats.cap);
}

function twCodes(theme: Theme): string[] {
    const codes = new Set<string>();
    for (const m of theme.members) if (m.id.startsWith('tw.')) codes.add(m.id.slice(3));
    return [...codes];
}

// ── chain layout ─────────────────────────────────────────────────────────

export interface Tile {
    /** Stable key: stage + code (a company can sit in two stages). */
    key: string;
    code: string;
    stage: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface StageColumn {
    stage: ThemeStage;
    codes: string[];
    /** Column rectangle inside the map box (header excluded). */
    x: number;
    width: number;
    tiles: Tile[];
}

export interface ChainLayout {
    columns: StageColumn[];
    /** Tiles by code (first stage wins for edges). */
    byCode: Map<string, Tile>;
}

/** Members per stage, Taiwan only, deduplicated within a stage. */
export function stageMembers(theme: Theme): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const stage of theme.stages) map.set(stage.id, []);
    for (const member of theme.members) {
        if (!member.id.startsWith('tw.')) continue;
        const list = map.get(member.stage);
        const code = member.id.slice(3);
        if (list && !list.includes(code)) list.push(code);
    }
    return map;
}

/**
 * Lay a chain out as stage columns, each a squarified treemap. Column widths
 * follow √(member count) so a crowded stage gets room without starving a thin
 * one; every non-empty stage keeps at least `minColumn` px.
 */
export function layoutChain(
    theme: Theme,
    size: (code: string) => number,
    width: number,
    height: number,
    opts: { gap?: number; minColumn?: number } = {},
): ChainLayout {
    const gap = opts.gap ?? 6;
    const minColumn = opts.minColumn ?? 64;
    const stages = orderedStages(theme);
    const members = stageMembers(theme);
    const byCode = new Map<string, Tile>();
    const weights = stages.map((s) => Math.sqrt(Math.max(1, members.get(s.id)?.length ?? 0)));
    const total = weights.reduce((a, b) => a + b, 0);
    const usable = Math.max(0, width - gap * Math.max(0, stages.length - 1));
    let widths = weights.map((w) => (total > 0 ? (usable * w) / total : 0));
    // enforce a minimum, taking the space from the widest columns
    if (widths.length * minColumn <= usable) {
        const short = widths.map((w) => Math.max(0, minColumn - w));
        const need = short.reduce((a, b) => a + b, 0);
        if (need > 0) {
            const spare = widths.reduce((a, w) => a + Math.max(0, w - minColumn), 0);
            widths = widths.map((w) => (w < minColumn ? minColumn : w - (need * (w - minColumn)) / spare));
        }
    }
    let x = 0;
    const columns: StageColumn[] = stages.map((stage, i) => {
        const codes = members.get(stage.id) ?? [];
        const w = Math.floor(widths[i] ?? 0);
        const tiles = treemapTiles(codes, size, w, height).map((t) => ({
            key: `${stage.id}:${t.code}`,
            code: t.code,
            stage: stage.id,
            x0: t.x0 + x,
            y0: t.y0,
            x1: t.x1 + x,
            y1: t.y1,
        }));
        for (const tile of tiles) if (!byCode.has(tile.code)) byCode.set(tile.code, tile);
        const column = { stage, codes, x, width: w, tiles };
        x += w + gap;
        return column;
    });
    return { columns, byCode };
}

function treemapTiles(
    codes: readonly string[],
    size: (code: string) => number,
    width: number,
    height: number,
): { code: string; x0: number; y0: number; x1: number; y1: number }[] {
    if (width <= 0 || height <= 0 || codes.length === 0) return [];
    type Datum = { code?: string; value?: number; children?: Datum[] };
    // Unknown size still gets a sliver so every member is clickable.
    const values = codes.map((code) => Math.max(0, size(code) || 0));
    const max = values.reduce((a, b) => Math.max(a, b), 0);
    const floor = max > 0 ? max * 0.004 : 1;
    const root = hierarchy<Datum>({ children: codes.map((code, i) => ({ code, value: values[i] })) })
        .sum((d) => (d.code === undefined ? 0 : Math.max(floor, d.value ?? 0)))
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laid = treemap<Datum>()
        .tile(treemapSquarify.ratio(1.2))
        .size([width, height])
        .paddingInner(2)
        .round(true)(root);
    return laid
        .leaves()
        .filter((leaf) => leaf.data.code !== undefined)
        .map((leaf) => ({ code: leaf.data.code!, x0: leaf.x0, y0: leaf.y0, x1: leaf.x1, y1: leaf.y1 }));
}

// ── relations ─────────────────────────────────────────────────────────────

/** In-chain supplier link: `from` supplies `to`. */
export interface ChainLink {
    id: string;
    from: string;
    to: string;
    detail: string | null;
}

/** Supplier edges whose both ends are Taiwan members of the chain. */
export function chainLinks(edges: readonly Edge[], codes: ReadonlySet<string>): ChainLink[] {
    const links: ChainLink[] = [];
    const seen = new Set<string>();
    for (const edge of edges) {
        if (edge.type !== 'supplier') continue;
        if (!edge.src.startsWith('tw.') || !edge.dst.startsWith('tw.')) continue;
        const from = edge.src.slice(3);
        const to = edge.dst.slice(3);
        if (from === to || !codes.has(from) || !codes.has(to)) continue;
        const key = `${from}>${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ id: edge.id, from, to, detail: edge.detail });
    }
    return links;
}

/** Cubic curve between two tiles, leaving the right/left edge toward the other side. */
export function linkPath(a: Tile, b: Tile): string {
    const ay = (a.y0 + a.y1) / 2;
    const by = (b.y0 + b.y1) / 2;
    const forward = (a.x0 + a.x1) / 2 <= (b.x0 + b.x1) / 2;
    const ax = forward ? a.x1 : a.x0;
    const bx = forward ? b.x0 : b.x1;
    if (a.stage === b.stage) {
        // inside one stage: leave from the facing horizontal edge, curve vertically
        const acx = (a.x0 + a.x1) / 2;
        const bcx = (b.x0 + b.x1) / 2;
        const down = ay <= by;
        const sy = down ? a.y1 : a.y0;
        const ey = down ? b.y0 : b.y1;
        const dy = Math.max(16, Math.abs(ey - sy) / 2);
        return `M${acx},${sy} C${acx},${down ? sy + dy : sy - dy} ${bcx},${down ? ey - dy : ey + dy} ${bcx},${ey}`;
    }
    const dx = Math.max(24, Math.abs(bx - ax) / 2);
    const c1 = forward ? ax + dx : ax - dx;
    const c2 = forward ? bx - dx : bx + dx;
    return `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`;
}

/** Revenue YoY by code from the untyped `tw/revenue` dataset. */
export function revenueYoy(raw: Record<string, unknown> | null | undefined): Map<string, number> {
    const map = new Map<string, number>();
    if (!raw) return map;
    for (const [code, row] of Object.entries(raw)) {
        const yoy = (row as { yoy_pct?: unknown } | null)?.yoy_pct;
        if (typeof yoy === 'number' && Number.isFinite(yoy)) map.set(code, yoy);
    }
    return map;
}

/** Heat intensity 10–56 % mixed into the panel colour (same scale as 產業全景). */
export function heatAlpha(value: number, fullAt: number): number {
    return 10 + Math.min(1, Math.abs(value) / fullAt) * 46;
}

export function fmtSignedPct(value: number | null | undefined, digits = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '--';
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function fmtTwd(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '--';
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)} 兆`;
    if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e10 ? 0 : 1)} 億`;
    return `${Math.round(value / 1e4).toLocaleString('en-US')} 萬`;
}
