// src/components/panel-previews.tsx — schematic thumbnails for the panel
// library's hover preview. Hand-drawn SVG skeletons, colored via theme
// vars so they follow light/dark automatically and never go stale the
// way screenshots would. All share a 120×76 canvas.

import type { ReactNode } from 'react';
import type { BlockType } from '../lib/workspace';
import { vars } from '../theme.css';

const up = vars.color.up;
const down = vars.color.down;
const accent = vars.color.accent;
const muted = vars.color.mutedForeground;
const border = vars.color.border;

function Frame({ children }: { children: ReactNode }) {
    return (
        <svg
            viewBox='0 0 120 76'
            width='100%'
            role='img'
            aria-hidden='true'
            style={{ display: 'block' }}
        >
            <rect
                x='0.5'
                y='0.5'
                width='119'
                height='75'
                rx='3'
                fill='none'
                stroke={border}
            />
            {children}
        </svg>
    );
}

// text placeholder line
function Ln({
    x,
    y,
    w,
    color = muted,
    o = 0.55,
}: {
    x: number;
    y: number;
    w: number;
    color?: string;
    o?: number;
}) {
    return (
        <rect x={x} y={y} width={w} height='3' rx='1.5' fill={color} fillOpacity={o} />
    );
}

function rowList(colors: string[], x = 8, y0 = 12, gap = 13) {
    return colors.map((color, i) => (
        <g key={i}>
            <Ln x={x} y={y0 + i * gap} w={34} />
            <Ln x={x + 70} y={y0 + i * gap} w={20} color={color} o={0.9} />
        </g>
    ));
}

const candles = (
    xs: { x: number; o: number; c: number; h: number; l: number }[],
) =>
    xs.map(({ x, o, c, h, l }, i) => {
        const rising = c < o; // smaller y = higher price
        const color = rising ? up : down;
        return (
            <g key={i}>
                <line x1={x} y1={h} x2={x} y2={l} stroke={color} />
                <rect
                    x={x - 3}
                    y={Math.min(o, c)}
                    width='6'
                    height={Math.max(2, Math.abs(c - o))}
                    fill={color}
                />
            </g>
        );
    });

export const PANEL_PREVIEWS: Record<BlockType, ReactNode> = {
    watchlist: <Frame>{rowList([up, down, up, up, down])}</Frame>,
    movers: (
        <Frame>
            {[52, 44, 37, 30, 24].map((w, i) => (
                <g key={i}>
                    <Ln x={8} y={12 + i * 13} w={18} />
                    <rect
                        x={34}
                        y={10 + i * 13}
                        width={w}
                        height='6'
                        rx='1'
                        fill={i < 3 ? up : down}
                        fillOpacity='0.8'
                    />
                </g>
            ))}
        </Frame>
    ),
    dock: (
        <Frame>
            <rect x='8' y='8' width='24' height='7' rx='2' fill={accent} fillOpacity='0.6' />
            <rect x='36' y='8' width='24' height='7' rx='2' fill={muted} fillOpacity='0.25' />
            <rect x='64' y='8' width='24' height='7' rx='2' fill={muted} fillOpacity='0.25' />
            <line x1='8' y1='22' x2='112' y2='22' stroke={border} />
            {[0, 1, 2, 3].map((i) => (
                <g key={i}>
                    <Ln x={8} y={28 + i * 11} w={26} />
                    <Ln x={48} y={28 + i * 11} w={18} />
                    <Ln
                        x={86}
                        y={28 + i * 11}
                        w={22}
                        color={i % 2 ? down : up}
                        o={0.9}
                    />
                </g>
            ))}
        </Frame>
    ),
    chart: (
        <Frame>
            {candles([
                { x: 14, o: 44, c: 34, h: 30, l: 48 },
                { x: 26, o: 34, c: 26, h: 22, l: 38 },
                { x: 38, o: 26, c: 32, h: 22, l: 36 },
                { x: 50, o: 32, c: 20, h: 16, l: 36 },
                { x: 62, o: 20, c: 28, h: 16, l: 32 },
                { x: 74, o: 28, c: 18, h: 14, l: 32 },
                { x: 86, o: 18, c: 24, h: 14, l: 28 },
                { x: 98, o: 24, c: 14, h: 10, l: 28 },
            ])}
            {[14, 26, 38, 50, 62, 74, 86, 98].map((x, i) => (
                <rect
                    key={x}
                    x={x - 3}
                    y={70 - (i % 4) * 3 - 4}
                    width='6'
                    height={(i % 4) * 3 + 4}
                    fill={i % 3 ? up : down}
                    fillOpacity='0.45'
                />
            ))}
        </Frame>
    ),
    intraday: (
        <Frame>
            <line
                x1='6'
                y1='36'
                x2='114'
                y2='36'
                stroke={muted}
                strokeOpacity='0.5'
                strokeWidth='1'
                strokeDasharray='3 2'
            />
            <path
                d='M6 36 L16 30 L28 24 L40 27 L52 18 L64 23 L76 28 L88 34'
                fill='none'
                stroke={up}
                strokeWidth='1.5'
            />
            <path
                d='M6 36 L16 30 L28 24 L40 27 L52 18 L64 23 L76 28 L88 34 L88 36 Z'
                fill={up}
                fillOpacity='0.15'
                stroke='none'
            />
            <path
                d='M88 34 L96 40 L106 44 L114 41'
                fill='none'
                stroke={down}
                strokeWidth='1.5'
            />
            <path
                d='M88 36 L88 34 L96 40 L106 44 L114 41 L114 36 Z'
                fill={down}
                fillOpacity='0.15'
                stroke='none'
            />
            <path
                d='M6 36 L28 31 L52 27 L76 28 L96 31 L114 33'
                fill='none'
                stroke={accent}
                strokeOpacity='0.8'
                strokeWidth='1'
            />
            {[6, 9, 5, 11, 7, 4, 8, 5, 10, 6, 4, 7].map((h, i) => (
                <rect
                    key={i}
                    x={7 + i * 9}
                    y={70 - h}
                    width='5'
                    height={h}
                    fill={i % 4 === 3 ? down : up}
                    fillOpacity='0.45'
                />
            ))}
        </Frame>
    ),
    depth: (
        <Frame>
            {[0, 1, 2, 3, 4].map((i) => (
                <rect
                    key={`a${i}`}
                    x={60 - 8 - (10 + i * 8)}
                    y={8 + i * 6}
                    width={10 + i * 8}
                    height='4'
                    fill={down}
                    fillOpacity='0.75'
                />
            ))}
            <line x1='60' y1='6' x2='60' y2='70' stroke={border} />
            {[0, 1, 2, 3, 4].map((i) => (
                <rect
                    key={`b${i}`}
                    x={68}
                    y={64 - i * 6 - 4}
                    width={10 + i * 8}
                    height='4'
                    fill={up}
                    fillOpacity='0.75'
                />
            ))}
        </Frame>
    ),
    ticket: (
        <Frame>
            {[12, 24, 36].map((y) => (
                <rect
                    key={y}
                    x='8'
                    y={y}
                    width='104'
                    height='8'
                    rx='2'
                    fill={muted}
                    fillOpacity='0.18'
                />
            ))}
            <rect x='8' y='52' width='50' height='14' rx='2' fill={up} fillOpacity='0.85' />
            <rect x='62' y='52' width='50' height='14' rx='2' fill={down} fillOpacity='0.85' />
        </Frame>
    ),
    tape: <Frame>{rowList([up, up, down, up, down], 8, 12, 13)}</Frame>,
    flash: (
        <Frame>
            {[0, 1, 2].map((i) => (
                <rect
                    key={`s${i}`}
                    x={64}
                    y={8 + i * 7}
                    width={18 + i * 9}
                    height='5'
                    fill={down}
                    fillOpacity='0.75'
                />
            ))}
            <rect x='54' y='34' width='12' height='8' rx='1' fill={accent} fillOpacity='0.8' />
            {[0, 1, 2].map((i) => (
                <rect
                    key={`b${i}`}
                    x={56 - 18 - i * 9 - 18}
                    y={47 + i * 7}
                    width={18 + i * 9}
                    height='5'
                    fill={up}
                    fillOpacity='0.75'
                />
            ))}
        </Frame>
    ),
    pnl: (
        <Frame>
            <polyline
                points='10,58 30,50 48,54 66,38 84,30 108,18'
                fill='none'
                stroke={up}
                strokeWidth='2'
            />
            <polygon
                points='10,58 30,50 48,54 66,38 84,30 108,18 108,68 10,68'
                fill={up}
                fillOpacity='0.15'
            />
            <Ln x={10} y={10} w={26} color={up} o={0.9} />
            <Ln x={46} y={10} w={20} />
        </Frame>
    ),
    chips: (
        <Frame>
            <line x1='8' y1='40' x2='112' y2='40' stroke={border} />
            {[14, 12, 8, -6, -12, 10, -8, 6].map((v, i) => (
                <rect
                    key={i}
                    x={12 + i * 13}
                    y={v > 0 ? 40 - v * 2 : 40}
                    width='8'
                    height={Math.abs(v) * 2}
                    fill={v > 0 ? up : down}
                    fillOpacity='0.8'
                />
            ))}
        </Frame>
    ),
    volprofile: (
        <Frame>
            {[46, 66, 88, 72, 52, 34, 22].map((w, i) => (
                <rect
                    key={i}
                    x={8}
                    y={9 + i * 9}
                    width={w}
                    height='6'
                    fill={i === 2 ? accent : muted}
                    fillOpacity={i === 2 ? 0.8 : 0.35}
                />
            ))}
        </Frame>
    ),
    optchain: (
        <Frame>
            <rect x='52' y='6' width='16' height='64' fill={muted} fillOpacity='0.15' />
            {[0, 1, 2, 3, 4].map((i) => (
                <g key={i}>
                    <Ln x={10} y={14 + i * 12} w={16} color={up} o={0.7} />
                    <Ln x={32} y={14 + i * 12} w={14} />
                    <Ln x={56} y={14 + i * 12} w={8} o={0.8} />
                    <Ln x={74} y={14 + i * 12} w={14} />
                    <Ln x={94} y={14 + i * 12} w={16} color={down} o={0.7} />
                </g>
            ))}
        </Frame>
    ),
    stockfutures: (
        <Frame>
            {[0, 1, 2, 3].map((i) => (
                <g key={i}>
                    <Ln x={8} y={14 + i * 14} w={30} />
                    <rect
                        x={62}
                        y={11 + i * 14}
                        width='16'
                        height='8'
                        rx='2'
                        fill={accent}
                        fillOpacity='0.4'
                    />
                    <Ln
                        x={88}
                        y={14 + i * 14}
                        w={20}
                        color={i % 2 ? down : up}
                        o={0.9}
                    />
                </g>
            ))}
        </Frame>
    ),
    warrants: (
        <Frame>
            <polygon
                points='8,10 44,10 30,26 30,40 22,36 22,26'
                fill={muted}
                fillOpacity='0.4'
            />
            {[0, 1, 2, 3].map((i) => (
                <g key={i}>
                    <Ln x={54} y={12 + i * 12} w={26} />
                    <Ln
                        x={92}
                        y={12 + i * 12}
                        w={16}
                        color={i % 2 ? down : up}
                        o={0.9}
                    />
                </g>
            ))}
            <Ln x={8} y={54} w={100} o={0.3} />
            <Ln x={8} y={64} w={84} o={0.3} />
        </Frame>
    ),
    replay: (
        <Frame>
            <polyline
                points='10,50 26,42 40,46 56,30 72,36 90,22 108,26'
                fill='none'
                stroke={muted}
                strokeWidth='1.5'
                strokeOpacity='0.7'
            />
            <polygon points='52,54 52,68 64,61' fill={accent} />
            <rect x='10' y='70' width='98' height='2' rx='1' fill={muted} fillOpacity='0.3' />
            <rect x='10' y='70' width='42' height='2' rx='1' fill={accent} />
        </Frame>
    ),
    depthmap: (
        <Frame>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((col) =>
                [0, 1, 2, 3, 4].map((row) => (
                    <rect
                        key={`${col}-${row}`}
                        x={9 + col * 13}
                        y={9 + row * 12}
                        width='11'
                        height='10'
                        fill={row < 2 ? down : up}
                        fillOpacity={0.15 + ((col * 7 + row * 5) % 10) / 14}
                    />
                )),
            )}
            <polyline
                points='9,34 35,32 61,38 87,30 113,34'
                fill='none'
                stroke={vars.color.foreground}
                strokeWidth='1.5'
            />
        </Frame>
    ),
    combo: (
        <Frame>
            <circle cx='24' cy='20' r='7' fill={up} fillOpacity='0.8' />
            <circle cx='24' cy='56' r='7' fill={down} fillOpacity='0.8' />
            <path
                d='M31 20 C 60 20, 60 38, 88 38 M31 56 C 60 56, 60 38, 88 38'
                fill='none'
                stroke={muted}
                strokeOpacity='0.6'
                strokeWidth='1.5'
            />
            <rect x='88' y='31' width='20' height='14' rx='3' fill={accent} fillOpacity='0.6' />
        </Frame>
    ),
    notices: (
        <Frame>
            <path
                d='M20 24 a8 8 0 0 1 16 0 v6 l4 6 h-24 l4 -6 z'
                fill={accent}
                fillOpacity='0.7'
            />
            {[0, 1, 2].map((i) => (
                <g key={i}>
                    <rect
                        x='52'
                        y={10 + i * 20}
                        width='58'
                        height='14'
                        rx='3'
                        fill={muted}
                        fillOpacity='0.15'
                    />
                    <Ln x={57} y={15 + i * 20} w={40} o={0.5} />
                </g>
            ))}
        </Frame>
    ),
    debug: (
        <Frame>
            {[0, 1, 2, 3, 4].map((i) => (
                <g key={i}>
                    <circle
                        cx='13'
                        cy={14 + i * 12}
                        r='2.5'
                        fill={i === 3 ? down : up}
                    />
                    <Ln x={22} y={12 + i * 12} w={60 + ((i * 17) % 25)} o={0.4} />
                </g>
            ))}
        </Frame>
    ),
    grid: (
        <Frame>
            <line x1='60' y1='6' x2='60' y2='70' stroke={border} />
            {[0, 1, 2, 3].map((i) => (
                <rect
                    key={`u${i}`}
                    x={20}
                    y={42 + i * 7}
                    width='32'
                    height='5'
                    rx='1'
                    fill={up}
                    fillOpacity='0.75'
                />
            ))}
            {[0, 1, 2, 3].map((i) => (
                <rect
                    key={`d${i}`}
                    x={68}
                    y={29 - i * 7}
                    width='32'
                    height='5'
                    rx='1'
                    fill={down}
                    fillOpacity='0.75'
                />
            ))}
        </Frame>
    ),
    heatmap: (
        <Frame>
            <rect x='8' y='8' width='56' height='40' fill={down} fillOpacity='0.55' />
            <rect x='66' y='8' width='24' height='24' fill={up} fillOpacity='0.5' />
            <rect x='92' y='8' width='20' height='24' fill={up} fillOpacity='0.3' />
            <rect x='66' y='34' width='46' height='14' fill={down} fillOpacity='0.3' />
            <rect x='8' y='50' width='34' height='18' fill={up} fillOpacity='0.4' />
            <rect x='44' y='50' width='30' height='18' fill={down} fillOpacity='0.25' />
            <rect x='76' y='50' width='36' height='18' fill={up} fillOpacity='0.6' />
        </Frame>
    ),
    pulse: (
        <Frame>
            <rect x='10' y='12' width='6' height='34' fill={down} fillOpacity='0.85' />
            <rect x='10' y='52' width='6' height='14' fill={up} fillOpacity='0.85' />
            <rect x='56' y='10' width='6' height='24' fill={down} fillOpacity='0.85' />
            <rect x='56' y='40' width='6' height='10' fill={down} fillOpacity='0.6' />
            <rect x='56' y='54' width='6' height='12' fill={up} fillOpacity='0.85' />
            <path
                d='M16 20 C 36 20, 36 18, 56 18 M16 36 C 36 36, 36 44, 56 44 M16 56 C 36 56, 36 58, 56 58'
                fill='none'
                stroke={muted}
                strokeOpacity='0.45'
                strokeWidth='6'
            />
            {[0, 1, 2, 3, 4].map((i) => (
                <Ln
                    key={i}
                    x={70}
                    y={12 + i * 12}
                    w={26 + ((i * 11) % 14)}
                    color={i < 3 ? down : up}
                    o={0.7}
                />
            ))}
        </Frame>
    ),
    signals: (
        <Frame>
            {[up, down, up, up, down].map((color, i) => (
                <g key={i}>
                    <circle cx='13' cy={14 + i * 12} r='2.5' fill={color} />
                    <Ln x={22} y={12 + i * 12} w={30} />
                    <Ln x={70} y={12 + i * 12} w={20} color={color} o={0.8} />
                </g>
            ))}
        </Frame>
    ),
    optpnl: (
        <Frame>
            <line x1='8' y1='42' x2='112' y2='42' stroke={border} />
            <polyline
                points='10,62 52,62 84,20 108,20'
                fill='none'
                stroke={accent}
                strokeWidth='2'
            />
            <polygon points='52,62 84,20 84,42 68,42' fill={up} fillOpacity='0.18' />
            <polygon points='10,62 52,62 52,42 10,42' fill={down} fillOpacity='0.15' />
        </Frame>
    ),
    backtest: (
        <Frame>
            <polyline
                points='10,58 26,52 40,54 56,40 70,44 86,28 108,20'
                fill='none'
                stroke={up}
                strokeWidth='2'
            />
            <polyline
                points='10,66 26,64 40,68 56,62 70,66 86,60 108,58'
                fill='none'
                stroke={down}
                strokeWidth='1.5'
                strokeOpacity='0.7'
            />
            <Ln x={10} y={10} w={20} color={up} o={0.9} />
            <Ln x={38} y={10} w={16} />
            <Ln x={62} y={10} w={16} />
        </Frame>
    ),
    assistant: (
        <Frame>
            <rect x='8' y='10' width='64' height='16' rx='5' fill={muted} fillOpacity='0.2' />
            <rect x='48' y='32' width='64' height='16' rx='5' fill={accent} fillOpacity='0.35' />
            <rect x='8' y='54' width='52' height='14' rx='5' fill={muted} fillOpacity='0.2' />
        </Frame>
    ),
};
