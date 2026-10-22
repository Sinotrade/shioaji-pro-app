// src/components/chain-heat.tsx — 熱力 view: money-flow heat of every group,
// and of the selected group's member stocks.
//
// Each tile is coloured by the last 5 / 10 minutes' net ÷ turnover (inflow
// up colour, outflow down colour, strength on a soft knee) and carries a
// strip of the window's per-minute turnover coloured by direction, so it reads from the first bar the
// panel receives — no session history needed. Colours ease to their new
// value when a minute bar lands, and the groups and stocks with the largest
// latest-minute flow get a sheen. Tiles are a uniform grid ordered by
// turnover (unlike 產業全景, a price-change treemap sized by weight).

import { useMemo } from 'react';
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
    full,
    selected,
    sheen,
    now,
    small,
    reducedMotion,
    onClick,
}: {
    tile: Tile;
    /** Ratio drawn at full colour (90th percentile of the grid). */
    full: number;
    selected: boolean;
    sheen: boolean;
    now: number | null;
    small: boolean;
    reducedMotion: boolean;
    onClick: () => void;
}) {
    const { cell } = tile;
    const level = heatLevel(cell.ratio, full);
    const side = cell.ratio === null || cell.ratio === 0 ? 'flat' : cell.ratio > 0 ? 'in' : 'out';
    // near zero stays on the neutral surface; the strongest flows reach 62 %
    // (text keeps AA contrast on both themes)
    const style = { '--heat': `${Math.round(level * 54)}%` } as React.CSSProperties;
    const peak = Math.max(1, ...cell.amounts);
    return (
        <button
            type='button'
            className={`${s.heatTile[side]} ${small ? s.heatTileSmall : ''} ${selected ? s.heatTileOn : ''} ${reducedMotion ? s.still : ''}`}
            style={style}
            onClick={onClick}
            aria-pressed={selected}
            title={`${tile.name}${tile.sub ? `・${tile.sub}` : ''}\n近 ${cell.minutes.length} 分鐘淨流入 ${fmtTwd(cell.net, true)}・占成交值 ${cell.ratio !== null ? fmtSignedPct(cell.ratio * 100, 1) : '--'}（成交值 ${fmtTwd(cell.turnover)}）\n漲跌 ${fmtSignedPct(tile.pct)}`}
        >
            {sheen && !reducedMotion && <span key={now} className={s.heatSheen} aria-hidden='true' />}
            <span className={s.heatHead}>
                <span className={s.heatName}>{tile.name}</span>
                <span className={s.heatPct}>{fmtSignedPct(tile.pct, small ? 1 : 2)}</span>
            </span>
            <span className={s.heatValue}>{now !== null && cell.turnover > 0 ? fmtTwd(cell.net, true) : '--'}</span>
            <span className={s.heatBars} aria-hidden='true'>
                {cell.minutes.map((m, i) => (
                    <span
                        key={i}
                        className={s.heatBar[minuteSide(m)]}
                        style={{ height: m === null ? undefined : `${Math.max(14, (cell.amounts[i]! / peak) * 100)}%` }}
                    />
                ))}
            </span>
        </button>
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
            rows
                .map((r) => ({
                    id: r.theme.id,
                    name: r.theme.name,
                    sub: `${r.codes.length} 檔`,
                    cell: heatCell(r.flow.net, r.flow.turnover, now, window),
                    pct: r.flow.pct,
                    order: r.flow.total,
                }))
                .sort((a, b) => b.order - a.order || a.id.localeCompare(b.id)),
        [rows, now, window],
    );
    // members of the selected group: rebuilt with the rows (same revision)
    const members = useMemo<Tile[]>(
        () =>
            selectedCodes
                .flatMap((code) => {
                    const flow = chainFlowBook.codes.get(code);
                    if (!flow) return [];
                    return [
                        {
                            id: code,
                            name: nameOf(code),
                            sub: code,
                            cell: heatCell(flow.net, flow.amount, now, window),
                            pct: codePct(flow),
                            order: sessionTurnover(flow),
                        },
                    ];
                })
                .sort((a, b) => b.order - a.order || a.id.localeCompare(b.id)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selectedCodes, nameOf, rows, now, window],
    );
    const last = (t: Tile) => {
        const m = t.cell.minutes[t.cell.minutes.length - 1];
        return m === null || m === undefined ? 0 : m * t.order;
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
                <span>依今日成交值排序；下方細條為近 {window} 分鐘逐分成交值，顏色為該分鐘淨流入方向</span>
            </div>
            <div className={s.heatGrid}>
                {groups.map((t) => (
                    <HeatTile
                        key={t.id}
                        tile={t}
                        full={groupFull}
                        selected={t.id === selectedId}
                        sheen={groupSheen.has(t.id)}
                        now={now}
                        small={false}
                        reducedMotion={reducedMotion}
                        onClick={() => onSelect(t.id)}
                    />
                ))}
            </div>
            {members.length > 0 && (
                <>
                    <div className={s.heatSection}>
                        {selectedName}・成分股 {members.length} 檔・色階 ±{(memberFull * 100).toFixed(0)}%
                    </div>
                    <div className={`${s.heatGrid} ${s.heatGridSmall}`}>
                        {members.map((t) => (
                            <HeatTile
                                key={t.id}
                                tile={t}
                                full={memberFull}
                                selected={false}
                                sheen={memberSheen.has(t.id)}
                                now={now}
                                small
                                reducedMotion={reducedMotion}
                                onClick={() => onPick(t.id)}
                            />
                        ))}
                    </div>
                </>
            )}
            {now === null && <div className={s.rotEmpty}>盤中每分鐘更新：收到第一根 1 分 K 起，依近 {window} 分鐘淨流入著色</div>}
        </div>
    );
}
