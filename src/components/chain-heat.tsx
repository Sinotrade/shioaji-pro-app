// src/components/chain-heat.tsx — 熱力 view: money-flow heat of every group,
// and of the selected group's member stocks.
//
// Each tile is coloured by the last 5 / 10 minutes' net ÷ turnover (inflow
// up colour, outflow down colour, strength on a soft knee) and carries a
// strip of the window's per-minute turnover coloured by direction, so it reads from the first bar the
// panel receives — no session history needed. Colours ease to their new
// value when a minute bar lands, and the groups and stocks with the largest
// latest-minute flow get a sheen. Tile area is today's turnover (groups: the
// members' sum; members: the stock's own), laid out with 產業全景's
// treemap (stable order + remembered cuts), so a tile only resizes a little
// each minute; labels follow the same font-step fit.

import { type CSSProperties, useMemo, useRef } from 'react';
import { useBoxSize } from '../hooks/use-box-size';
import { emptyHeatMemo, heatTileContent, layoutHeatTiles, type HeatLayoutMemo } from '../lib/chain-heat-layout';
import type { Rect } from '../lib/heat-layout';
import { codePct, sessionTurnover } from '../lib/chain-flow';
import { chainFlowBook } from '../lib/chain-flow-feed';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { heatCell, heatFull, heatLevel, minuteSide, type HeatCell } from '../lib/chain-motion';
import type { FlowRow } from './chain-ui';
import * as s from './chain-map.css';

const SHEENS = 5;

interface Tile {
    id: string;
    name: string;
    sub: string;
    /** Stock code (members only): the label falls back to it on tiny tiles. */
    code?: string;
    cell: HeatCell;
    pct: number | null;
    order: number;
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
    const level = heatLevel(cell.ratio, full);
    const side = cell.ratio === null || cell.ratio === 0 ? 'flat' : cell.ratio > 0 ? 'in' : 'out';
    const pctText = tile.pct === null ? null : fmtSignedPct(tile.pct);
    const { fit, showValue, showBars } = heatTileContent(rect.w, rect.h, tile.name, pctText, tile.code);
    // near zero stays on the neutral surface; the strongest flows reach 54 %
    // (text keeps AA contrast on both themes)
    const style = {
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        fontSize: fit.fontSize,
        '--heat': `${Math.round(level * 54)}%`,
    } as CSSProperties;
    const peak = Math.max(1, ...cell.amounts);
    const title = `${tile.name}${tile.sub ? `・${tile.sub}` : ''}\n今日成交值 ${fmtTwd(tile.order)}\n近 ${cell.minutes.length} 分鐘淨流入 ${fmtTwd(cell.net, true)}・占成交值 ${cell.ratio !== null ? fmtSignedPct(cell.ratio * 100, 1) : '--'}（成交值 ${fmtTwd(cell.turnover)}）\n漲跌 ${fmtSignedPct(tile.pct)}`;
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
    selectedId,
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
    selectedId: string;
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
    const groupFull = useMemo(() => heatFull(groups.map((t) => t.cell.ratio)), [groups]);
    const memberFull = useMemo(() => heatFull(members.map((t) => t.cell.ratio)), [members]);
    const memberSheen = useMemo(() => sheenIds(members, last), [members]);

    return (
        <div className={s.heat}>
            <div className={s.heatLegend}>
                <span>近 {window} 分鐘淨流入占成交值</span>
                <span className={s.heatScaleEnd}>−{(groupFull * 100).toFixed(0)}%</span>
                <span className={s.heatScale} aria-hidden='true' />
                <span className={s.heatScaleEnd}>+{(groupFull * 100).toFixed(0)}%</span>
                <span className={s.spacer} />
                <span>面積＝今日成交值；下方細條為近 {window} 分鐘逐分成交值，顏色為該分鐘淨流入方向</span>
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
                        {selectedName}・成分股 {members.length} 檔・面積依成交值・色階 ±{(memberFull * 100).toFixed(0)}%
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
            {now === null && <div className={s.rotEmpty}>盤中每分鐘更新：收到第一根 1 分 K 起，依近 {window} 分鐘淨流入著色</div>}
        </div>
    );
}
