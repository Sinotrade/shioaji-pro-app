// src/components/chain-map.css.ts — 產業鏈資金流向（流向時間軸＋鏈內流向＋聚焦個股）
//
// Hairline structure, tabular mono figures, colour only where it carries
// meaning: up/down for flow direction and price, accent for selection.

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const ellipsis = {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
} as const;

const mono = {
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
} as const;

export const center = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: vars.space.md,
});

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
});

export const spacer = style({ flex: 1 });

// ---- toolbar ----

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: `5px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    minWidth: 0,
});

export const segmentGroup = style({
    display: 'inline-flex',
    gap: '2px',
    padding: '1px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

const segmentBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    lineHeight: 1.4,
    padding: '1px 7px',
    border: 'none',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
});

export const segment = styleVariants({
    on: [segmentBase, { background: vars.color.panel, color: vars.color.foreground, fontWeight: 600 }],
    off: [
        segmentBase,
        {
            background: 'transparent',
            color: vars.color.mutedForeground,
            ':hover': { color: vars.color.foreground },
        },
    ],
});

export const live = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    ...mono,
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const liveOn = style({ color: vars.color.success });

export const stale = style({
    fontSize: '0.56rem',
    color: vars.color.amber,
    whiteSpace: 'nowrap',
});

export const nameText = style({
    fontSize: '0.66rem',
    fontWeight: 600,
    color: vars.color.foreground,
    ...ellipsis,
});

const markBase = style({
    flexShrink: 0,
    width: '6px',
    height: '6px',
});

// 產業鏈＝實心方塊、題材＝空心圓：結構語意，用 accent／muted 不用 up/down
export const kindMark = styleVariants({
    chain: [markBase, { background: vars.color.accent, borderRadius: '1px' }],
    theme: [markBase, { border: `1px solid ${vars.color.mutedForeground}`, borderRadius: '50%' }],
});

export const dim = style({ color: vars.color.mutedForeground, fontWeight: 500 });

// ---- chain detail ----

export const detail = style({
    flexShrink: 0,
    height: '44%',
    minHeight: 210,
    maxHeight: 300,
    display: 'flex',
    flexDirection: 'column',
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
});

export const detailHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: `6px ${vars.space.sm} 2px`,
    minWidth: 0,
});

export const detailTitle = style({
    fontSize: '0.72rem',
    fontWeight: 700,
    color: vars.color.foreground,
    ...ellipsis,
});

export const detailMeta = style({
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
    ...ellipsis,
});

export const detailBody = style({
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '8px',
    padding: `4px ${vars.space.sm} 6px`,
});

export const detailBodyFocus = style({
    gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 30%)',
});

export const tiers = style({
    display: 'grid',
    gap: '8px',
    minHeight: 0,
    minWidth: 0,
});

export const tierCard = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
    minHeight: 0,
    padding: '6px 8px',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

export const tierHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
});

const tierBase = style({
    flexShrink: 0,
    fontSize: '0.58rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
});

// 上中下游用 accent／前景／muted 區分 — 非價格語意，不用 up/down
export const tierTag = styleVariants({
    upstream: [tierBase, { color: vars.color.accent }],
    midstream: [tierBase, { color: vars.color.foreground }],
    downstream: [tierBase, { color: vars.color.mutedForeground }],
});

export const tierCount = style({
    ...mono,
    fontSize: '0.54rem',
    color: vars.color.mutedForeground,
});

export const tierArrow = style({
    color: vars.color.mutedForeground,
    opacity: 0.6,
    flexShrink: 0,
});

export const shift = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '1px',
    ...mono,
    fontSize: '0.56rem',
    fontWeight: 700,
});

export const tierFigures = style({
    display: 'flex',
    gap: '12px',
    minWidth: 0,
    overflow: 'hidden',
});

export const figure = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    minWidth: 0,
});

export const figureLabel = style({
    fontSize: '0.5rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const figureValue = style({
    ...mono,
    fontSize: '0.7rem',
    fontWeight: 700,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const tierCanvas = style({
    display: 'block',
    width: '100%',
    flex: 1,
    minHeight: 34,
});

export const leaders = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

const leaderBase = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, auto) minmax(0, 1fr) auto auto',
    alignItems: 'baseline',
    columnGap: '6px',
    padding: '1px 2px',
    border: 'none',
    borderRadius: '2px',
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: vars.font.body,
    ':hover': { background: vars.color.panelRaised },
});

export const leader = styleVariants({
    on: [leaderBase, { boxShadow: `inset 2px 0 0 ${vars.color.accent}`, background: vars.color.panelRaised }],
    off: [leaderBase],
});

export const leaderName = style({
    fontSize: '0.6rem',
    fontWeight: 600,
    color: vars.color.foreground,
    ...ellipsis,
});

export const leaderStage = style({
    fontSize: '0.52rem',
    color: vars.color.mutedForeground,
    ...ellipsis,
});

export const leaderNum = style({
    ...mono,
    fontSize: '0.58rem',
    fontWeight: 700,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

export const empty = style({
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
});

// ---- focused stock ----

export const focus = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    padding: '6px 8px',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

export const focusHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
});

export const focusIcon = style({ color: vars.color.accent, flexShrink: 0 });

export const focusName = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 700,
    color: vars.color.foreground,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    ...ellipsis,
    ':hover': { color: vars.color.accent },
});

export const focusCode = style({
    ...mono,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    fontWeight: 400,
});

export const closeBtn = style({
    display: 'inline-flex',
    padding: '2px',
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground, background: vars.color.panelRaised },
});

export const focusFigures = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, auto)',
    justifyContent: 'start',
    gap: '2px 12px',
});

export const focusRole = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.4,
});

export const focusGroups = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
});

export const focusGroup = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    minWidth: 0,
});

export const groupLabel = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.54rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    padding: '2px 0',
});

export const groupCount = style({
    ...mono,
    fontWeight: 400,
});

export const rel = style({
    display: 'grid',
    gridTemplateColumns: '6px minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: '6px',
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.foreground,
    background: 'transparent',
    border: 'none',
    borderRadius: '2px',
    padding: '1px 2px',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: vars.color.panelRaised },
});

export const relStatic = style({
    cursor: 'default',
    color: vars.color.mutedForeground,
    ':hover': { background: 'transparent' },
});

export const relName = style({ ...ellipsis });

export const relPct = style({
    ...mono,
    fontSize: '0.56rem',
    fontWeight: 700,
    textAlign: 'right',
});

export const inChainDot = style({
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: vars.color.accent,
});

export const outChainDot = style({
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    border: `1px solid ${vars.color.border}`,
});

export const evidenceTag = style({
    fontSize: '0.5rem',
    color: vars.color.amber,
});

export const footer = style({
    display: 'flex',
    alignItems: 'center',
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.52rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

// ---- v3 motion: shared ----

const glide = 'transform 900ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease';
const reduce = { '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none', animation: 'none' } } } as const;

/** Applied when the viewer asked for reduced motion (also covered by the media query). */
export const still = style({ transition: 'none !important', animation: 'none !important' });

const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export const nextBar = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    ...mono,
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    minWidth: '34px',
});
export const nextBarTrack = style({ fill: 'none', stroke: vars.color.border, strokeWidth: 2 });
export const nextBarArc = style({
    fill: 'none',
    stroke: vars.color.success,
    strokeWidth: 2,
    strokeLinecap: 'round',
    transition: 'stroke-dashoffset 1s linear',
    ...reduce,
});

export const views = style({ flex: 1, minHeight: 160, display: 'flex', flexDirection: 'column', minWidth: 0 });

// ---- 排行 ----

export const rank = style({ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' });

export const kpi = style({ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 });
export const kpiLabel = style({ fontSize: '0.58rem', color: vars.color.mutedForeground, whiteSpace: 'nowrap' });

const RANK_COLUMNS = 'minmax(110px, 180px) minmax(0, 1fr) 92px';
// muted direction colours: the values and lanes sit back, the data reads
const soft = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, ${vars.color.mutedForeground})`;
export const rankTone = styleVariants({
    up: { color: soft(vars.color.up, 78) },
    down: { color: soft(vars.color.down, 78) },
    flat: { color: vars.color.mutedForeground },
});
export const rankKpis = style({
    display: 'flex',
    alignItems: 'flex-end',
    gap: vars.space.md,
    padding: `10px ${vars.space.md} 8px`,
});
export const rankKpiValue = style({ ...mono, fontSize: '1.7rem', fontWeight: 650, lineHeight: 1.15, letterSpacing: '-0.01em' });
export const rankKpiSide = style({ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-end', paddingBottom: '3px' });
export const rankKpiLine = style({ display: 'flex', alignItems: 'baseline', gap: '6px', whiteSpace: 'nowrap' });
export const rankKpiName = style({ fontSize: '0.7rem', fontWeight: 600, color: vars.color.foreground, ...ellipsis, maxWidth: '150px' });
export const rankKpiSub = style({ ...mono, fontSize: '0.68rem', minWidth: '72px', textAlign: 'right' });
export const rankHeader = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    padding: `4px ${vars.space.md} 0`,
});
export const rankHeaderTitle = style({ fontSize: '0.78rem', fontWeight: 650, color: vars.color.foreground, whiteSpace: 'nowrap' });
export const rankHeaderNote = style({ marginLeft: 'auto', fontSize: '0.6rem', color: vars.color.mutedForeground, ...ellipsis });
export const rankAxis = style({
    display: 'grid',
    gridTemplateColumns: RANK_COLUMNS,
    columnGap: '12px',
    padding: `6px ${vars.space.md} 2px`,
    fontSize: '0.62rem',
});
export const rankAxisTrack = style({ position: 'relative', height: '14px' });
export const rankAxisSide = style({ position: 'absolute', top: 0, padding: '0 7px', whiteSpace: 'nowrap', fontWeight: 600 });
export const rankMove = style({
    ...mono,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    fontSize: '0.58rem',
    lineHeight: 1,
    flexShrink: 0,
});
export const rankMoveDown = style({ transform: 'rotate(180deg)' });
export const rankStage = style({ position: 'relative', flex: 1, minHeight: 0, display: 'flex' });
export const rankArea = style({ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' });
export const rankCanvas = style({ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 });
export const rankRows = style({ position: 'relative', margin: `2px ${vars.space.sm}` });
// one dotted centre axis, drawn per row so it follows the list
export const rankZero = style({
    position: 'absolute',
    left: '50%',
    top: '-8px',
    bottom: '-8px',
    width: '1px',
    backgroundImage: `linear-gradient(to bottom, ${tint(vars.color.mutedForeground, 45)} 50%, transparent 50%)`,
    backgroundSize: '1px 4px',
});

const rankRowBase = style({
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: '34px',
    display: 'grid',
    gridTemplateColumns: RANK_COLUMNS,
    alignItems: 'center',
    columnGap: '12px',
    padding: `0 ${vars.space.sm}`,
    border: 0,
    margin: 0,
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: vars.radius.lg,
    transition: glide,
    willChange: 'transform',
    selectors: {
        '&:hover': { opacity: 1 },
        '&:focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: '-1px', opacity: 1 },
    },
    ...reduce,
});
// the selected lane stays at full strength with a faint outline; the others step back
export const rankRow = styleVariants({
    on: [rankRowBase, { background: tint(vars.color.foreground, 4), boxShadow: `inset 0 0 0 1px ${tint(vars.color.foreground, 10)}` }],
    off: [rankRowBase, { opacity: 0.65 }],
});
export const rankName = style({ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, fontSize: '0.78rem', fontWeight: 500, color: vars.color.foreground });
export const rankNameText = style({ ...ellipsis });
export const rankDot = styleVariants({
    chain: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: soft(vars.color.accent, 70) },
    theme: { width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0, background: soft(vars.color.amber, 70) },
});
export const rankTrack = style({ position: 'relative', height: '22px', minWidth: 0 });

const barGrow = ['width', 'height', 'border-radius'].map((p) => `${p} 900ms cubic-bezier(0.22, 1, 0.36, 1)`).join(', ');
const rankBarBase = style({ position: 'absolute', top: '50%', transform: 'translateY(-50%)', transition: barGrow, ...reduce });
// a thin translucent lane, faint at the axis
const lane = (color: string, deg: number) =>
    `linear-gradient(${deg}deg, ${tint(color, 10)}, ${tint(color, 34)} 50%, ${tint(color, 62)})`;
export const rankBar = styleVariants({
    in: [rankBarBase, { background: lane(vars.color.up, 90) }],
    out: [rankBarBase, { background: lane(vars.color.down, 270) }],
});
const headBase = style({
    position: 'absolute',
    top: '50%',
    borderRadius: '50%',
    transition: 'width 600ms, height 600ms, margin 600ms, box-shadow 600ms',
    ...reduce,
});
export const rankHead = styleVariants({
    in: [headBase, { background: soft(vars.color.up, 70) }],
    out: [headBase, { background: soft(vars.color.down, 70) }],
});
export const rankHeadGlow = styleVariants({
    in: [headBase, { background: vars.color.up, boxShadow: `0 0 8px 1px ${tint(vars.color.up, 45)}` }],
    out: [headBase, { background: vars.color.down, boxShadow: `0 0 8px 1px ${tint(vars.color.down, 45)}` }],
});
const pulse = keyframes({ from: { transform: 'scale(1)', opacity: 0.5 }, to: { transform: 'scale(2.4)', opacity: 0 } });
const pulseBase = style({
    position: 'absolute',
    inset: 0,
    borderRadius: '50%',
    pointerEvents: 'none',
    animation: `${pulse} 900ms ease-out 1 forwards`,
    ...reduce,
});
export const rankPulse = styleVariants({
    in: [pulseBase, { border: `1px solid ${vars.color.up}` }],
    out: [pulseBase, { border: `1px solid ${vars.color.down}` }],
});
export const rankValue = style({ ...mono, fontSize: '0.74rem', textAlign: 'right', whiteSpace: 'nowrap', justifyContent: 'flex-end' });

// ---- 輪動泡泡 ----

export const rot = style({ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' });
export const rotSvg = style({ position: 'absolute', inset: 0, display: 'block' });
export const rotStates = style({
    position: 'absolute',
    top: '6px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 2,
    display: 'flex',
    gap: '4px',
});
export const rotState = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: '999px',
    background: tint(vars.color.panel, 88),
    backdropFilter: 'blur(4px)',
    cursor: 'default',
    fontFamily: vars.font.body,
    color: vars.color.foreground,
});
export const rotStateOn = style({ borderColor: vars.color.borderBright });
export const rotStateLabel = style({ fontSize: '0.58rem', color: vars.color.mutedForeground, whiteSpace: 'nowrap' });
export const rotStateCount = style({ ...mono, fontSize: '0.72rem', fontWeight: 700 });

// two hues, diverging: inflow warm (up), outflow cool (down); the weaker
// quadrant of each side is the same hue pulled towards grey
const stateColor = {
    leading: vars.color.up,
    weakening: `color-mix(in oklab, ${vars.color.up} 58%, ${vars.color.mutedForeground})`,
    improving: `color-mix(in oklab, ${vars.color.down} 58%, ${vars.color.mutedForeground})`,
    lagging: vars.color.down,
} as const;
type StateKey = keyof typeof stateColor;
const perState = <T>(fn: (color: string, key: StateKey) => T) =>
    Object.fromEntries((Object.keys(stateColor) as StateKey[]).map((k) => [k, fn(stateColor[k], k)])) as Record<StateKey, T>;

// muted state colours: the hue reads, it does not shout
const mutedState = (c: string) => soft(c, 92);
export const rotDot = styleVariants(perState((c) => ({ width: '7px', height: '7px', borderRadius: '50%', background: mutedState(c) })));
export const rotCorner = style({
    fill: vars.color.mutedForeground,
    fontSize: '10px',
    fontWeight: 600,
    fontFamily: vars.font.body,
    letterSpacing: '0.04em',
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3,
    strokeLinejoin: 'round',
    pointerEvents: 'none',
});
export const rotCornerDot = styleVariants(perState((c) => ({ fill: mutedState(c), opacity: 0.9 })));
export const rotGrid = style({ stroke: tint(vars.color.border, 38) });
export const rotAxis = style({ stroke: tint(vars.color.mutedForeground, 38) });
export const rotTick = style({ fill: vars.color.mutedForeground, fontSize: '10.5px', fontFamily: vars.font.mono });
export const rotCaption = style({ fill: vars.color.mutedForeground, fontSize: '11px', fontFamily: vars.font.body });
export const rotTrail = styleVariants(perState((c) => ({ stroke: mutedState(c), fill: 'none', strokeWidth: 1.2, strokeLinecap: 'round' })));
export const rotTrailDot = styleVariants(perState((c) => ({ fill: mutedState(c) })));
export const rotBubble = style({ cursor: 'pointer', outline: 'none' });
export const rotLabel = style({ pointerEvents: 'none' });
export const rotFill = styleVariants(
    perState((c) => ({
        fill: tint(mutedState(c), 66),
        stroke: tint(mutedState(c), 90),
        strokeWidth: 1,
        transition: 'r 900ms cubic-bezier(0.22, 1, 0.36, 1), fill 600ms ease, stroke 600ms ease',
        selectors: { [`${rotBubble}:hover &, ${rotBubble}:focus-visible &`]: { fill: tint(mutedState(c), 62) } },
        ...reduce,
    })),
);
const ring = keyframes({ from: { transform: 'scale(1)', opacity: 0.55 }, to: { transform: 'scale(1.8)', opacity: 0 } });
export const rotPulse = styleVariants(
    perState((c) => ({
        fill: 'none',
        stroke: mutedState(c),
        strokeWidth: 1,
        transformBox: 'fill-box',
        transformOrigin: 'center',
        animation: `${ring} 1.2s ease-out forwards`,
        ...reduce,
    })),
);
export const rotSelected = style({ fill: 'none', stroke: tint(vars.color.foreground, 70), strokeWidth: 1.2 });
const labelBase = {
    fontFamily: vars.font.body,
    pointerEvents: 'none',
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3,
    strokeLinejoin: 'round',
} as const;
export const rotName = style({ ...labelBase, fill: vars.color.foreground, fontSize: '9.5px', fontWeight: 600 });
export const rotValue = styleVariants(
    perState((c) => ({ ...labelBase, fill: mutedState(c), color: mutedState(c), fontSize: '9px', fontWeight: 600, fontFamily: vars.font.mono })),
);
// inside a bubble: no halo stroke, the fill is the backdrop
export const rotNameIn = style({ fill: vars.color.foreground, fontSize: '9.5px', fontWeight: 650, fontFamily: vars.font.body, pointerEvents: 'none' });
export const rotValueIn = style({
    fill: vars.color.foreground,
    opacity: 0.78,
    fontSize: '8.5px',
    fontFamily: vars.font.mono,
    pointerEvents: 'none',
});
export const rotEmpty = style({
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    maxWidth: '320px',
    textAlign: 'center',
    fontSize: '0.62rem',
    lineHeight: 1.6,
    color: vars.color.mutedForeground,
    padding: '8px 12px',
    background: tint(vars.color.panel, 85),
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});
export const rotFoot = style({
    position: 'absolute',
    left: '50%',
    bottom: '3px',
    transform: 'translateX(-50%)',
    whiteSpace: 'nowrap',
    display: 'flex',
    gap: '14px',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    pointerEvents: 'none',
});
export const rotFootName = style({ color: vars.color.foreground, fontWeight: 650 });
export const rotFootValue = styleVariants(perState((c) => ({ ...mono, color: mutedState(c) })));

// ---- 熱力 ----

export const heat = style({
    position: 'relative',
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    padding: `6px ${vars.space.sm} 8px`,
});
export const heatLegend = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    marginBottom: '6px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
});
export const heatScale = style({
    width: '120px',
    height: '6px',
    borderRadius: '3px',
    background: `linear-gradient(90deg in oklab, color-mix(in oklab, ${vars.color.down} 54%, ${vars.color.panelRaised}), ${vars.color.panelRaised} 50%, color-mix(in oklab, ${vars.color.up} 54%, ${vars.color.panelRaised}))`,
});
export const heatScaleEnd = style({ ...mono, fontSize: '0.54rem' });
// treemap panes: groups over members (3 : 2), each measured for its layout
export const heatPaneOnly = style({ flex: '1 1 0', minHeight: '120px', display: 'flex' });
export const heatPaneMain = style({ flex: '3 1 0', minHeight: '120px', display: 'flex' });
export const heatPaneMembers = style({ flex: '2 1 0', minHeight: '96px', display: 'flex' });
export const heatMap = style({ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 });
export const heatSection = style({
    flexShrink: 0,
    margin: '8px 0 5px',
    fontSize: '0.62rem',
    fontWeight: 650,
    color: vars.color.foreground,
});

// position/size ease over 0.6 s when a minute bar re-weights the map (cut to
// 0 s while the panel is being resized); colour keeps its slower ease
const heatTileBase = style({
    position: 'absolute',
    overflow: 'hidden',
    padding: 0,
    border: `1px solid ${tint(vars.color.border, 70)}`,
    borderRadius: '3px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    transitionProperty: 'left, top, width, height, background-color, border-color',
    transitionDuration: 'var(--heat-move, 0.6s), var(--heat-move, 0.6s), var(--heat-move, 0.6s), var(--heat-move, 0.6s), 900ms, 300ms',
    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1), cubic-bezier(0.22, 1, 0.36, 1), cubic-bezier(0.22, 1, 0.36, 1), cubic-bezier(0.22, 1, 0.36, 1), ease, ease',
    selectors: {
        '&:hover': { borderColor: vars.color.borderBright },
        '&:focus-visible': { outline: `1.5px solid ${vars.color.accent}`, outlineOffset: '-1.5px', zIndex: 1 },
    },
    ...reduce,
});
export const heatTile = styleVariants({
    // oklab mixing: perceptually even steps from the neutral surface
    in: [heatTileBase, { background: `color-mix(in oklab, ${vars.color.up} var(--heat), ${vars.color.panelRaised})` }],
    out: [heatTileBase, { background: `color-mix(in oklab, ${vars.color.down} var(--heat), ${vars.color.panelRaised})` }],
    flat: [heatTileBase, { background: vars.color.panelRaised }],
});
export const heatTileOn = style({ boxShadow: `inset 0 0 0 1.5px ${vars.color.accent}`, borderColor: 'transparent' });

const sheen = keyframes({
    from: { transform: 'translateX(-110%)', opacity: 0.9 },
    to: { transform: 'translateX(110%)', opacity: 0 },
});
export const heatSheen = style({
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    background: `linear-gradient(100deg, transparent 20%, ${tint(vars.color.foreground, 22)} 50%, transparent 80%)`,
    animation: `${sheen} 1.1s ease-out forwards`,
    ...reduce,
});
// label: font size comes from the tile (heat-label font steps), lines scale with it
export const heatLabel = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.08em',
    padding: '0 4px',
    lineHeight: 1.1,
    pointerEvents: 'none',
});
export const heatName = style({ maxWidth: '100%', fontWeight: 650, ...ellipsis });
export const heatPct = style({ ...mono, fontSize: '0.86em', fontWeight: 600, whiteSpace: 'nowrap', opacity: 0.8 });
export const heatValue = style({ ...mono, fontSize: '0.72em', fontWeight: 700, whiteSpace: 'nowrap', opacity: 0.9 });
export const heatBars = style({
    position: 'absolute',
    left: '5px',
    right: '5px',
    bottom: '4px',
    display: 'flex',
    alignItems: 'flex-end',
    gap: '2px',
    height: '10px',
    pointerEvents: 'none',
});
const heatBarBase = style({ flex: 1, minHeight: '2px', borderRadius: '1px', transition: 'height 600ms ease', ...reduce });
export const heatBar = styleVariants({
    in: [heatBarBase, { background: `color-mix(in srgb, ${vars.color.up} 80%, ${vars.color.foreground})` }],
    out: [heatBarBase, { background: `color-mix(in srgb, ${vars.color.down} 80%, ${vars.color.foreground})` }],
    flat: [heatBarBase, { background: tint(vars.color.foreground, 45) }],
    none: [heatBarBase, { height: '2px', background: tint(vars.color.foreground, 20) }],
});

// ---- 排行明細卡 ----

export const rankLayout = style({ position: 'relative', flex: 1, minHeight: 0, display: 'flex', gap: vars.space.sm });
export const rankFold = style({
    position: 'absolute',
    left: 0,
    width: 'max-content',
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingLeft: '18px',
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.6rem',
    fontFamily: vars.font.body,
    cursor: 'pointer',
    opacity: 0.8,
    zIndex: 1,
    selectors: { '&:hover': { color: vars.color.foreground, opacity: 1 } },
});
export const rankDrawerToggle = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: '8px',
    padding: '1px 7px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: '999px',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.6rem',
    fontFamily: vars.font.body,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    selectors: {
        '&:hover': { color: vars.color.foreground, borderColor: vars.color.borderBright },
        '&[aria-expanded="true"]': { color: vars.color.foreground, borderColor: vars.color.borderBright },
    },
});
export const rankMain = style({ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' });
export const card = style({
    width: '264px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px 12px',
    margin: `6px ${vars.space.sm} 6px 0`,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    overflowY: 'auto',
    minHeight: 0,
});
// narrow panel: the card floats over the lanes instead of squeezing them
export const cardDrawer = style({
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    boxShadow: `0 8px 28px ${tint('#000000', 35)}`,
});
export const cardClose = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    flexShrink: 0,
    border: 'none',
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    selectors: { '&:hover': { color: vars.color.foreground, background: tint(vars.color.foreground, 8) } },
});
export const cardHead = style({ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 });
export const cardTitle = style({ fontSize: '0.86rem', fontWeight: 700, color: vars.color.foreground, ...ellipsis, flex: 1, minWidth: 0 });
export const cardBadge = styleVariants(
    perState((c) => ({
        flexShrink: 0,
        fontSize: '0.6rem',
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: '999px',
        color: c,
        background: tint(c, 14),
        boxShadow: `inset 0 0 0 1px ${tint(c, 40)}`,
    })),
);
export const cardStats = style({ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px' });
export const cardStat = style({ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 });
export const cardStatValue = style({ ...mono, fontSize: '0.74rem', fontWeight: 650, color: vars.color.foreground, whiteSpace: 'nowrap' });
export const cardFlow = style({ display: 'flex', flexDirection: 'column', gap: '1px' });
export const cardFlowValue = style({ ...mono, fontSize: '1.3rem', fontWeight: 700, lineHeight: 1.2 });
export const cardChart = style({ position: 'relative', height: '72px' });
export const cardSvg = style({ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' });
export const cardShade = style({ fill: tint(vars.color.mutedForeground, 8) });
export const cardZero = style({ stroke: tint(vars.color.mutedForeground, 45), strokeWidth: 1, strokeDasharray: '2 3' });
export const cardArea = styleVariants({
    up: { fill: tint(vars.color.up, 14) },
    down: { fill: tint(vars.color.down, 14) },
});
export const cardLine = styleVariants({
    up: { fill: 'none', stroke: vars.color.up, strokeWidth: 1.6 },
    down: { fill: 'none', stroke: vars.color.down, strokeWidth: 1.6 },
});
const endPulse = keyframes({
    '0%': { boxShadow: '0 0 0 0 var(--end-glow)' },
    '70%': { boxShadow: '0 0 0 7px transparent' },
    '100%': { boxShadow: '0 0 0 0 transparent' },
});
const endBase = style({
    position: 'absolute',
    width: '7px',
    height: '7px',
    margin: '-3.5px 0 0 -3.5px',
    borderRadius: '50%',
    animation: `${endPulse} 1.8s ease-out infinite`,
    ...reduce,
});
export const cardEnd = styleVariants({
    up: [endBase, { background: vars.color.up, vars: { '--end-glow': tint(vars.color.up, 60) }, filter: `drop-shadow(0 0 4px ${vars.color.up})` }],
    down: [endBase, { background: vars.color.down, vars: { '--end-glow': tint(vars.color.down, 60) }, filter: `drop-shadow(0 0 4px ${vars.color.down})` }],
});
export const cardCaption = style({ fontSize: '0.56rem', color: vars.color.mutedForeground, marginTop: '-4px' });
export const cardEmpty = style({ fontSize: '0.62rem', color: vars.color.mutedForeground, padding: '4px 0' });
export const cardList = style({ display: 'flex', flexDirection: 'column', gap: '1px' });
export const cardListTitle = style({ fontSize: '0.6rem', fontWeight: 650, color: vars.color.mutedForeground, marginBottom: '2px' });
export const cardMember = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto 52px 64px',
    alignItems: 'baseline',
    gap: '6px',
    padding: '2px 4px',
    margin: '0 -4px',
    border: 0,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    selectors: {
        '&:hover': { background: tint(vars.color.mutedForeground, 10) },
        '&:focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: '-1px' },
    },
});
export const cardMemberName = style({ fontSize: '0.7rem', fontWeight: 600, color: vars.color.foreground, ...ellipsis });
export const cardMemberCode = style({ ...mono, fontSize: '0.58rem', color: vars.color.mutedForeground });
export const cardMemberPct = style({ ...mono, fontSize: '0.62rem', textAlign: 'right' });
export const cardMemberNet = style({ ...mono, fontSize: '0.66rem', fontWeight: 650, textAlign: 'right', whiteSpace: 'nowrap' });
