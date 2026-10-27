// src/components/chain-heat.tsx：漲跌 view: heat of every group, and of the
// selected group's member stocks.
//
// Each tile is coloured by today's change (up colour, down colour, strength
// against the map's 90th-percentile move, never less than ±1 %) and carries
// a strip of the last 5 / 10 minutes' per-minute turnover coloured by net
// flow direction. Colours ease to their new
// value when a minute bar lands, and the groups and stocks with the largest
// latest-minute flow get a sheen. Tile area is today's turnover (groups: the
// members' sum; members: the stock's own), laid out with 產業全景's
// treemap (stable order + remembered cuts), so a tile only resizes a little
// each minute; labels follow the same font-step fit.
//
// 清單 form shows the same groups and members as two sortable tables side by
// side (groups left, the selected group's members right).

import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useBoxSize } from '../hooks/use-box-size';
import { emptyHeatMemo, heatTileContent, layoutHeatTiles, type HeatLayoutMemo } from '../lib/chain-heat-layout';
import type { Rect } from '../lib/heat-layout';
import { codePct, codeVolumeRatio, sessionTurnover } from '../lib/chain-flow';
import { chainFlowBook } from '../lib/chain-flow-feed';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { heatCell, heatFull, heatLevel, minuteSide, type HeatCell } from '../lib/chain-motion';
import { fmtPrice } from '../lib/utils/format';
import { dir, markKind, useBoxSize as usePaneSize, writePref, type FlowRow } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const SHEENS = 5;
/** Smallest full-colour change, in percent. */
const PCT_FLOOR = 1;
/** Colour steps of a tile: ticks nudge the change all the time, and every step restarts the colour ease. */
const HEAT_LEVELS = 9;

export interface Tile {
    id: string;
    name: string;
    sub: string;
    /** Stock code (members only): the label falls back to it on tiny tiles. */
    code?: string;
    /** Group kind (groups only): the list's marker. */
    kind?: string;
    /** Latest price (members only, 清單). */
    price?: number | null;
    /** 量比 (清單). */
    volRatio?: number | null;
    cell: HeatCell;
    pct: number | null;
    order: number;
}

export type HeatForm = 'map' | 'list';
export interface ListSort {
    key: 'pct' | 'vol' | 'net' | 'turnover';
    desc: boolean;
}

/** Window net once a bar is in; before that the cell is all zero, not a real 0. */
const tileNet = (t: Tile, now: number | null) => (now !== null && t.cell.turnover > 0 ? t.cell.net : null);

/** Rows by the sorted column; missing values last, ties by today's turnover. */
export function sortTiles(tiles: Tile[], sort: ListSort, now: number | null): Tile[] {
    const value = (t: Tile) =>
        sort.key === 'pct' ? t.pct : sort.key === 'vol' ? (t.volRatio ?? null) : sort.key === 'net' ? tileNet(t, now) : t.order;
    return [...tiles].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (va === null || vb === null) return va === vb ? b.order - a.order : va === null ? 1 : -1;
        return (sort.desc ? vb - va : va - vb) || b.order - a.order;
    });
}

// toLocaleString with options builds a formatter per call; a list renders hundreds
const YI = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 億 without the unit (the header carries it); one decimal throughout so the column lines up by place value. */
export function fmtYi(value: number): string {
    return YI.format(value / 1e8);
}

/** What a list shows beside the name ('code' sits with the name), and the steps that free room when narrow. */
export type ListCol = 'code' | 'price' | 'pct' | 'vol' | 'net' | 'turnover';
export type ListStep = ListCol | 'slim';

/** Figure widths in rem; slim fits the longest value ("1,045.00", "+10.00%", "−3,200 萬") with less air. */
const COL_REM = { price: 4.4, pct: 4.4, vol: 3.6, net: 5.4, turnover: 5 } as const;
const SLIM_REM = { ...COL_REM, price: 3.8, pct: 3.6, vol: 3.2, net: 4.4 } as const;
const CODE_REM = 2.6;
/** Room a name keeps to stay readable (about six characters, e.g. 騰輝電子-KY). */
const NAME_REM = 5;

/** Columns that fit `width` rem: take `steps` in order (drop a column, or slim the figures) until the name keeps NAME_REM. */
export function fitColumns(
    width: number,
    cols: readonly ListCol[],
    steps: readonly ListStep[],
): { shown: ReadonlySet<ListCol>; slim: boolean } {
    const shown = new Set(cols);
    let slim = false;
    const need = () => [...shown].reduce((sum, c) => sum + (c === 'code' ? CODE_REM : (slim ? SLIM_REM : COL_REM)[c]), NAME_REM);
    for (const step of steps) {
        if (need() <= width) break;
        if (step === 'slim') slim = true;
        else shown.delete(step);
    }
    return { shown, slim };
}

// 漲跌% never gives way and members keep the price longest, as a quote board
// does. Live, 淨流入 (the panel's point) stays longest; before the first bar
// it is empty, so it goes first and 量比 / 成交值 keep the room (_IDLE).
export const GROUP_COLUMNS: readonly ListCol[] = ['pct', 'vol', 'net', 'turnover'];
export const GROUP_STEPS: readonly ListStep[] = ['slim', 'turnover', 'vol', 'net'];
export const GROUP_STEPS_IDLE: readonly ListStep[] = ['slim', 'net', 'turnover', 'vol'];
export const MEMBER_COLUMNS: readonly ListCol[] = ['code', 'price', 'pct', 'vol', 'net', 'turnover'];
export const MEMBER_STEPS: readonly ListStep[] = ['code', 'slim', 'turnover', 'vol', 'net', 'price'];
const MEMBER_STEPS_IDLE: readonly ListStep[] = ['code', 'slim', 'net', 'turnover', 'vol', 'price'];

type Figure = Exclude<ListCol, 'code'>;
const SORT_KEYS: readonly ListSort['key'][] = ['pct', 'vol', 'net', 'turnover'];
const isSortKey = (c: Figure): c is ListSort['key'] => c !== 'price';
const NET_DESC: ListSort = { key: 'net', desc: true };
/** The 漲跌 tab's list leads with the change, as its name and colours do. */
const PCT_DESC: ListSort = { key: 'pct', desc: true };

/** A table's saved sort ("net:desc"), else `fallback`. */
function readSort(key: string | undefined, fallback: ListSort): ListSort {
    try {
        const [k, d] = (key ? localStorage.getItem(key) : null)?.split(':') ?? [];
        if (SORT_KEYS.includes(k as ListSort['key'])) return { key: k as ListSort['key'], desc: d !== 'asc' };
    } catch {
        // storage unavailable: the default
    }
    return fallback;
}

/** Row a navigation key moves to from `at` (clamped), or null for any other key. */
export function rowStep(key: string, at: number, count: number, page = 10): number | null {
    const delta: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -page, PageDown: page };
    const to = key === 'Home' ? 0 : key === 'End' ? count - 1 : key in delta ? at + delta[key]! : null;
    return to === null || count === 0 ? null : Math.max(0, Math.min(count - 1, to));
}

/** One sortable table of tiles (清單 form, and the 金流 detail card); columns give way as it narrows. */
export function HeatList({
    tiles,
    now,
    netTitle,
    nameLabel,
    columns,
    steps,
    selectedId,
    followFocus = false,
    scope,
    sortKey,
    defaultSort = NET_DESC,
    label,
    onClick,
}: {
    tiles: Tile[];
    now: number | null;
    /** What the 淨流入 column measures (its window). */
    netTitle: string;
    nameLabel: string;
    /** Module constants: they key the fit memo. */
    columns: readonly ListCol[];
    steps: readonly ListStep[];
    /** Marked row (▶): the selected group, or the stock the panel follows; null for none. */
    selectedId: string | null;
    /** Arrow keys select the row they reach (groups); otherwise they only move focus and Enter picks (members). */
    followFocus?: boolean;
    /** Whose rows these are (members: the group); the list returns to the top when it changes. */
    scope?: string;
    /** localStorage key that remembers this table's sort. */
    sortKey?: string;
    /** Sort before the viewer picks one (淨流入 high to low unless given). */
    defaultSort?: ListSort;
    label: string;
    onClick: (id: string) => void;
}) {
    const { ref: paneRef, element: pane, size } = usePaneSize<HTMLDivElement>();
    // unmeasured (first paint, tests): everything; less the pane's border and scrollbar
    const width = useMemo(() => {
        if (size.width <= 0) return Infinity;
        const rem = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(document.documentElement).fontSize) : NaN;
        return size.width / (rem || 16) - 0.6;
    }, [size.width]);
    const fit = useMemo(() => fitColumns(width, columns, steps), [width, columns, steps]);
    const figures = columns.filter((c): c is Figure => c !== 'code' && fit.shown.has(c));
    const rem = fit.slim ? SLIM_REM : COL_REM;

    const [picked, setPicked] = useState<ListSort>(() => readSort(sortKey, defaultSort));
    // a hidden column, or 淨流入 before the first bar, sorts by 漲跌% instead, and says so
    const sort = useMemo<ListSort>(
        () => (fit.shown.has(picked.key) && !(now === null && picked.key === 'net') ? picked : { key: 'pct', desc: true }),
        [picked, now, fit],
    );
    const setSort = (next: ListSort) => {
        setPicked(next);
        if (sortKey) writePref(sortKey, `${next.key}:${next.desc ? 'desc' : 'asc'}`);
    };
    const sorted = useMemo(() => sortTiles(tiles, sort, now), [tiles, sort, now]);
    const selectedRef = useRef<HTMLTableRowElement>(null);
    // a new owner (another group's members) starts at the top; not on mount,
    // where a selected row further down must stay scrolled into view
    const lastScope = useRef(scope);
    useEffect(() => {
        if (!pane || lastScope.current === scope) return;
        lastScope.current = scope;
        pane.scrollTop = 0;
    }, [pane, scope]);
    // keep the selected row in view when it is picked or the viewer re-sorts,
    // not on each minute's re-order (that would undo the viewer's scrolling)
    useEffect(() => {
        const row = selectedRef.current;
        if (!pane || !row) return;
        const head = pane.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        const box = pane.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        if (r.top < box.top + head) pane.scrollTop -= box.top + head - r.top;
        else if (r.bottom > box.bottom) pane.scrollTop += r.bottom - box.bottom;
    }, [pane, selectedId, sort.key, sort.desc]);

    // one tab stop per table: the row last focused, else the marked row, else the first; arrows move within it
    const [cursor, setCursor] = useState<string | null>(null);
    const listed = (id: string | null) => id !== null && sorted.some((t) => t.id === id);
    // a selecting table (groups) follows its selection even when it was clicked with the mouse
    const current =
        followFocus && listed(selectedId) ? selectedId : listed(cursor) ? cursor : listed(selectedId) ? selectedId : (sorted[0]?.id ?? null);
    const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const to = at < 0 ? null : rowStep(e.key, at, buttons.length);
        if (to === null) return;
        e.preventDefault();
        buttons[to]!.focus();
        if (followFocus && to !== at) onClick(sorted[to]!.id);
    };

    const heading: Record<Figure, { label: string; title: string }> = {
        price: { label: '成交', title: '最新成交價' },
        pct: { label: '漲跌%', title: '今日漲跌幅' },
        vol: { label: '量比', title: '量比：今日累計成交量 ÷ 前一交易日全日成交量（盤中為部分交易日）' },
        net: { label: '淨流入', title: `${netTitle}${now === null ? '，盤中收到第一根 1 分 K 起才有值' : ''}` },
        turnover: { label: '成交值(億)', title: '今日成交值' },
    };
    const cell = (t: Tile, c: Figure) => {
        if (c === 'price') {
            return (
                <td key={c} className={`${s.listTd} ${panel.dirText[dir(t.pct)]}`}>
                    {t.price ? fmtPrice(t.price) : '--'}
                </td>
            );
        }
        if (c === 'pct') {
            return (
                <td key={c} className={`${s.listTd} ${panel.dirText[dir(t.pct)]}`}>
                    {fmtSignedPct(t.pct)}
                </td>
            );
        }
        if (c === 'vol') {
            return (
                <td key={c} className={s.listTd}>
                    {t.volRatio == null ? '--' : t.volRatio.toFixed(2)}
                </td>
            );
        }
        if (c === 'net') {
            const net = tileNet(t, now);
            return (
                <td key={c} className={`${s.listTd} ${panel.dirText[dir(net)]}`}>
                    {fmtTwd(net, true)}
                </td>
            );
        }
        return (
            <td key={c} className={s.listTd}>
                {fmtYi(t.order)}
            </td>
        );
    };
    return (
        <div ref={paneRef} className={s.listPane}>
            <table className={s.listTable} aria-label={label}>
                <thead>
                    <tr>
                        <th className={s.listThName} scope='col' title={nameLabel}>
                            {nameLabel}
                        </th>
                        {figures.map((c) => {
                            const style = { width: `${rem[c]}rem` };
                            if (!isSortKey(c)) {
                                return (
                                    <th key={c} className={s.listThText} scope='col' style={style} title={heading[c].title}>
                                        {heading[c].label}
                                    </th>
                                );
                            }
                            return (
                                <th
                                    key={c}
                                    className={s.listTh}
                                    scope='col'
                                    style={style}
                                    aria-sort={sort.key === c ? (sort.desc ? 'descending' : 'ascending') : undefined}
                                >
                                    <button
                                        type='button'
                                        className={s.listSort}
                                        // 淨流入 has nothing to sort before the first bar
                                        disabled={c === 'net' && now === null}
                                        title={`${heading[c].title}，點一下排序`}
                                        onClick={() => setSort({ key: c, desc: sort.key === c ? !sort.desc : true })}
                                    >
                                        {heading[c].label}
                                        {sort.key === c && <span aria-hidden='true'>{sort.desc ? ' ▼' : ' ▲'}</span>}
                                    </button>
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody onKeyDown={onKeyDown}>
                    {sorted.length === 0 && (
                        <tr>
                            <td className={s.listTdName} colSpan={figures.length + 1}>
                                尚無報價
                            </td>
                        </tr>
                    )}
                    {sorted.map((t) => {
                        const on = t.id === selectedId;
                        return (
                            <tr
                                key={t.id}
                                ref={on ? selectedRef : undefined}
                                className={`${s.listRow} ${on ? s.listRowOn : ''}`}
                                onClick={(e) => {
                                    // a click on a figure cell still moves the keyboard handle here
                                    e.currentTarget.querySelector('button')?.focus({ preventScroll: true });
                                    onClick(t.id);
                                }}
                            >
                                <td className={s.listTdName}>
                                    {/* keyboard / screen-reader handle; its click bubbles to the row */}
                                    <button
                                        type='button'
                                        className={s.listName}
                                        tabIndex={t.id === current ? 0 : -1}
                                        onFocus={() => setCursor(t.id)}
                                        aria-pressed={selectedId !== null ? on : undefined}
                                        title={t.code ? `${t.name} ${t.code}` : t.name}
                                    >
                                        {on && (
                                            <span className={s.listMark} aria-hidden='true'>
                                                ▶
                                            </span>
                                        )}
                                        {t.kind && <span className={s.rankDot[markKind(t.kind)]} aria-hidden='true' />}
                                        <span className={s.listNameText}>{t.name}</span>
                                        {t.code && fit.shown.has('code') && <span className={s.listCode}>{t.code}</span>}
                                    </button>
                                </td>
                                {figures.map((c) => cell(t, c))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/** Ids of the tiles with the largest absolute flow in the latest minute. */
function sheenIds(tiles: Tile[], latest: (t: Tile) => number) {
    return new Set(
        tiles
            .map((t) => [t.id, Math.abs(latest(t))] as const)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, SHEENS)
            .map(([id]) => id),
    );
}

function HeatTile({
    tile,
    rect,
    full,
    selected,
    sheen,
    now,
    reducedMotion,
    onClick,
}: {
    tile: Tile;
    rect: Rect;
    /** Ratio drawn at full colour (90th percentile of the map). */
    full: number;
    selected: boolean;
    sheen: boolean;
    now: number | null;
    reducedMotion: boolean;
    onClick: () => void;
}) {
    const { cell } = tile;
    // colour is today's change; the strip and the value below stay money flow
    const level = heatLevel(tile.pct, full);
    const side = tile.pct === null || tile.pct === 0 ? 'flat' : tile.pct > 0 ? 'in' : 'out';
    const pctText = tile.pct === null ? null : fmtSignedPct(tile.pct);
    const { fit, showValue, showBars } = heatTileContent(rect.w, rect.h, tile.name, pctText, tile.code);
    // near zero stays on the neutral surface; the strongest moves reach 54 %
    // (text keeps AA contrast on both themes)
    const style = {
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        fontSize: fit.fontSize,
        '--heat': `${(Math.round(level * HEAT_LEVELS) / HEAT_LEVELS) * 54}%`,
    } as CSSProperties;
    const peak = Math.max(1, ...cell.amounts);
    // the colour first: today's change; then size (turnover) and the number (net flow)
    const title = `${tile.name}${tile.sub ? `・${tile.sub}` : ''}\n漲跌 ${fmtSignedPct(tile.pct)}\n今日成交值 ${fmtTwd(tile.order)}\n近 ${cell.minutes.length} 分鐘淨流入 ${fmtTwd(cell.net, true)}・占成交值 ${cell.ratio !== null ? fmtSignedPct(cell.ratio * 100, 1) : '--'}（成交值 ${fmtTwd(cell.turnover)}）`;
    const label = fit.mode === 'code' ? (tile.code ?? tile.name) : tile.name;
    return (
        <button
            type='button'
            className={`${s.heatTile[side]} ${selected ? s.heatTileOn : ''} ${reducedMotion ? s.still : ''}`}
            style={style}
            onClick={onClick}
            aria-pressed={selected}
            aria-label={title}
            title={title}
        >
            {sheen && !reducedMotion && <span key={now} className={s.heatSheen} aria-hidden='true' />}
            {fit.mode !== 'none' && (
                <span className={s.heatLabel} style={showBars ? { bottom: 14 } : undefined} aria-hidden='true'>
                    <span className={s.heatName}>{label}</span>
                    {fit.mode === 'both' && <span className={s.heatPct}>{pctText}</span>}
                    {showValue && (
                        <span className={s.heatValue}>{now !== null && cell.turnover > 0 ? fmtTwd(cell.net, true) : '--'}</span>
                    )}
                </span>
            )}
            {showBars && (
                <span className={s.heatBars} aria-hidden='true'>
                    {cell.minutes.map((m, i) => (
                        <span
                            key={i}
                            className={s.heatBar[minuteSide(m)]}
                            style={{ height: m === null ? undefined : `${Math.max(14, (cell.amounts[i]! / peak) * 100)}%` }}
                        />
                    ))}
                </span>
            )}
        </button>
    );
}

/** One treemap of tiles, measured from its box and laid out by turnover. */
function HeatMap({
    tiles,
    scope,
    full,
    selectedId,
    sheens,
    now,
    reducedMotion,
    label,
    onClick,
}: {
    tiles: Tile[];
    scope: string;
    full: number;
    selectedId: string | null;
    sheens: Set<string>;
    now: number | null;
    reducedMotion: boolean;
    label: string;
    onClick: (id: string) => void;
}) {
    const { ref, size, resizing } = useBoxSize<HTMLDivElement>();
    const memo = useRef<HeatLayoutMemo>(emptyHeatMemo());
    const rects = useMemo(() => {
        const next = layoutHeatTiles(
            tiles.map((t) => ({ key: t.id, value: t.order })),
            size.width,
            size.height,
            memo.current,
            scope,
        );
        memo.current = next.memo;
        return next.rects;
    }, [tiles, size, scope]);
    // DOM order by id: position/size transitions are not cut short by node moves
    const sorted = useMemo(() => [...tiles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), [tiles]);
    return (
        <div
            ref={ref}
            className={s.heatMap}
            role='group'
            aria-label={label}
            style={resizing ? ({ '--heat-move': '0s' } as CSSProperties) : undefined}
        >
            {sorted.map((t) => {
                const rect = rects.get(t.id);
                if (!rect) return null;
                return (
                    <HeatTile
                        key={t.id}
                        tile={t}
                        rect={rect}
                        full={full}
                        selected={t.id === selectedId}
                        sheen={sheens.has(t.id)}
                        now={now}
                        reducedMotion={reducedMotion}
                        onClick={() => onClick(t.id)}
                    />
                );
            })}
        </div>
    );
}

export function FlowHeat({
    rows,
    now,
    window,
    form = 'map',
    selectedId,
    focusCode = null,
    selectedName,
    selectedCodes,
    nameOf,
    reducedMotion,
    onSelect,
    onPick,
}: {
    rows: FlowRow[];
    now: number | null;
    window: number;
    form?: HeatForm;
    selectedId: string;
    /** The stock the panel follows (last picked or linked): marked in the member list. */
    focusCode?: string | null;
    selectedName: string;
    selectedCodes: string[];
    nameOf: (code: string) => string;
    reducedMotion: boolean;
    onSelect: (id: string) => void;
    onPick: (code: string) => void;
}) {
    const groups = useMemo<Tile[]>(
        () =>
            rows.map((r) => ({
                id: r.theme.id,
                name: r.theme.name,
                sub: `${r.codes.length} 檔`,
                kind: r.theme.kind,
                volRatio: r.flow.volumeRatio,
                cell: heatCell(r.flow.net, r.flow.turnover, now, window),
                pct: r.flow.pct,
                order: r.flow.total,
            })),
        [rows, now, window],
    );
    // members of the selected group: rebuilt with the rows (same revision)
    const members = useMemo<Tile[]>(
        () =>
            selectedCodes.flatMap((code) => {
                const flow = chainFlowBook.codes.get(code);
                if (!flow) return [];
                return [
                    {
                        id: code,
                        name: nameOf(code),
                        sub: code,
                        code,
                        price: flow.last,
                        volRatio: codeVolumeRatio(flow),
                        cell: heatCell(flow.net, flow.amount, now, window),
                        pct: codePct(flow),
                        order: sessionTurnover(flow),
                    },
                ];
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selectedCodes, nameOf, rows, now, window],
    );
    const last = (t: Tile) => {
        const m = t.cell.minutes[t.cell.minutes.length - 1];
        return m === null || m === undefined ? 0 : m * t.cell.amounts[t.cell.amounts.length - 1]!;
    };
    const groupSheen = useMemo(() => sheenIds(groups, last), [groups]);
    // colour scale in percent: the map's 90th-percentile move, never under ±1 % (a quiet day stays pale)
    const groupFull = useMemo(() => heatFull(groups.map((t) => t.pct), 0.9, PCT_FLOOR), [groups]);
    const memberFull = useMemo(() => heatFull(members.map((t) => t.pct), 0.9, PCT_FLOOR), [members]);
    const memberSheen = useMemo(() => sheenIds(members, last), [members]);

    if (form === 'list') {
        const netTitle = `近 ${window} 分鐘淨流入（估算）`;
        // ← / → hop between the two tables, to the other table's tab stop
        const hop = (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const target = e.currentTarget.querySelectorAll('table')[e.key === 'ArrowRight' ? 1 : 0];
            if (!target || target.contains(document.activeElement)) return;
            const stop = target.querySelector<HTMLButtonElement>('tbody button[tabindex="0"]');
            if (!stop) return;
            e.preventDefault();
            stop.focus();
        };
        return (
            <div className={s.heat}>
                <div className={s.list} onKeyDown={hop}>
                    <HeatList
                        tiles={groups}
                        now={now}
                        netTitle={netTitle}
                        nameLabel={`族群 (${groups.length})`}
                        columns={GROUP_COLUMNS}
                        steps={now === null ? GROUP_STEPS_IDLE : GROUP_STEPS}
                        selectedId={selectedId}
                        followFocus
                        sortKey='sj-pro-chainmap-list-sort-groups'
                        defaultSort={PCT_DESC}
                        label='族群清單'
                        onClick={onSelect}
                    />
                    <HeatList
                        tiles={members}
                        now={now}
                        netTitle={netTitle}
                        nameLabel={`${selectedName} (${members.length})`}
                        columns={MEMBER_COLUMNS}
                        steps={now === null ? MEMBER_STEPS_IDLE : MEMBER_STEPS}
                        selectedId={focusCode}
                        scope={selectedId}
                        sortKey='sj-pro-chainmap-list-sort-members'
                        defaultSort={PCT_DESC}
                        label={`${selectedName}成分股`}
                        onClick={onPick}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className={s.heat}>
            <div className={s.heatLegend}>
                <span>今日漲跌幅</span>
                <span className={s.heatScaleEnd}>−{groupFull.toFixed(1)}%</span>
                <span className={s.heatScale} aria-hidden='true' />
                <span className={s.heatScaleEnd}>+{groupFull.toFixed(1)}%</span>
                <span className={s.spacer} />
                {/* the colour is the change; the amount and the strip are money flow */}
                <span className={s.heatLegendNote} title={`面積＝今日成交值；方塊金額為近 ${window} 分鐘淨流入，下方細條為逐分成交值，顏色為該分鐘淨流入方向`}>
                    面積＝今日成交值；方塊金額為近 {window} 分鐘淨流入，下方細條為逐分成交值，顏色為該分鐘淨流入方向
                </span>
            </div>
            <div className={members.length > 0 ? s.heatPaneMain : s.heatPaneOnly}>
                <HeatMap
                    tiles={groups}
                    scope='groups'
                    full={groupFull}
                    selectedId={selectedId}
                    sheens={groupSheen}
                    now={now}
                    reducedMotion={reducedMotion}
                    label='族群熱力'
                    onClick={onSelect}
                />
            </div>
            {members.length > 0 && (
                <>
                    <div className={s.heatSection}>
                        {selectedName}・成分股 {members.length} 檔・面積依成交值・色階 ±{memberFull.toFixed(1)}%
                    </div>
                    <div className={s.heatPaneMembers}>
                        <HeatMap
                            tiles={members}
                            scope={selectedId}
                            full={memberFull}
                            selectedId={null}
                            sheens={memberSheen}
                            now={now}
                            reducedMotion={reducedMotion}
                            label={`${selectedName}成分股熱力`}
                            onClick={onPick}
                        />
                    </div>
                </>
            )}
        </div>
    );
}
