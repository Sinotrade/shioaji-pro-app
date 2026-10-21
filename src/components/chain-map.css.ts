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

export const kpis = style({
    display: 'flex',
    alignItems: 'flex-end',
    gap: '18px',
    padding: `6px ${vars.space.sm} 6px`,
    borderBottom: `1px solid ${tint(vars.color.border, 70)}`,
    flexShrink: 0,
    minWidth: 0,
});
export const kpi = style({ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 });
export const kpiLabel = style({ fontSize: '0.54rem', color: vars.color.mutedForeground, whiteSpace: 'nowrap' });
export const kpiValue = style({ ...mono, fontSize: '1.02rem', fontWeight: 700, lineHeight: 1.1, whiteSpace: 'nowrap' });
export const kpiName = style({ fontSize: '0.74rem', fontWeight: 650, color: vars.color.foreground, lineHeight: 1.2, ...ellipsis, maxWidth: '140px' });
export const kpiSub = style({ ...mono, fontSize: '0.62rem', fontWeight: 600, whiteSpace: 'nowrap' });
export const clock = style({
    ...mono,
    fontSize: '1.5rem',
    fontWeight: 700,
    lineHeight: 1,
    letterSpacing: '0.02em',
    color: vars.color.foreground,
});

export const rankArea = style({ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' });
export const rankCanvas = style({ position: 'absolute', top: 0, left: 0, width: '100%', pointerEvents: 'none', zIndex: 1 });
export const rankRows = style({ position: 'relative', margin: `4px 0` });
export const rankZero = style({
    position: 'absolute',
    top: '-6px',
    bottom: '-6px',
    width: '1px',
    background: tint(vars.color.mutedForeground, 40),
    transition: 'left 900ms cubic-bezier(0.22, 1, 0.36, 1)',
    ...reduce,
});

const rankRowBase = style({
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: '24px',
    display: 'grid',
    gridTemplateColumns: '132px minmax(0, 1fr) 74px 56px',
    alignItems: 'center',
    columnGap: '8px',
    padding: `0 ${vars.space.sm}`,
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    transition: glide,
    willChange: 'transform',
    selectors: { '&:hover': { background: tint(vars.color.panelRaised, 80) } },
    ...reduce,
});
export const rankRow = styleVariants({
    on: [rankRowBase, { background: vars.color.panelRaised, boxShadow: `inset 2px 0 0 ${vars.color.accent}` }],
    off: [rankRowBase],
});
export const rankName = style({ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 });
export const rankTrack = style({ position: 'relative', height: '12px', minWidth: 0 });

const barGrow = ['width', 'left', 'right'].map((p) => `${p} 900ms cubic-bezier(0.22, 1, 0.36, 1)`).join(', ');
const rankBarBase = style({ position: 'absolute', top: 0, bottom: 0, transition: barGrow, ...reduce });
export const rankBar = styleVariants({
    in: [
        rankBarBase,
        {
            borderRadius: '0 3px 3px 0',
            background: `linear-gradient(90deg, ${tint(vars.color.up, 10)}, ${tint(vars.color.up, 55)})`,
        },
    ],
    out: [
        rankBarBase,
        {
            borderRadius: '3px 0 0 3px',
            background: `linear-gradient(270deg, ${tint(vars.color.down, 10)}, ${tint(vars.color.down, 55)})`,
        },
    ],
});
const headBase = style({
    position: 'absolute',
    top: '50%',
    width: '7px',
    height: '7px',
    marginTop: '-3.5px',
    borderRadius: '50%',
});
export const rankHead = styleVariants({
    in: [headBase, { right: '-3.5px', background: vars.color.up, boxShadow: `0 0 8px 2px ${tint(vars.color.up, 60)}` }],
    out: [headBase, { left: '-3.5px', background: vars.color.down, boxShadow: `0 0 8px 2px ${tint(vars.color.down, 60)}` }],
});
export const rankValue = style({ ...mono, fontSize: '0.66rem', fontWeight: 650, textAlign: 'right', whiteSpace: 'nowrap' });
export const rankPct = style({ ...mono, fontSize: '0.6rem', textAlign: 'right', whiteSpace: 'nowrap' });

const flashFade = keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const flashBase = style({
    position: 'absolute',
    inset: 0,
    borderRadius: vars.radius.sm,
    pointerEvents: 'none',
    animation: `${flashFade} 1.2s ease-out forwards`,
    ...reduce,
});
export const rankFlash = styleVariants({
    in: [flashBase, { background: tint(vars.color.up, 16) }],
    out: [flashBase, { background: tint(vars.color.down, 16) }],
});

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

const stateColor = {
    leading: vars.color.up,
    weakening: vars.color.amber,
    improving: vars.color.accent,
    lagging: vars.color.down,
} as const;
type StateKey = keyof typeof stateColor;
const perState = <T>(fn: (color: string, key: StateKey) => T) =>
    Object.fromEntries((Object.keys(stateColor) as StateKey[]).map((k) => [k, fn(stateColor[k], k)])) as Record<StateKey, T>;

export const rotDot = styleVariants(perState((c) => ({ width: '7px', height: '7px', borderRadius: '50%', background: c })));
export const rotTint = styleVariants(perState((c, k) => ({ fill: tint(c, k === 'improving' ? 3 : 4) })));
export const rotCorner = styleVariants(
    perState((c) => ({ fill: c, fontSize: '10px', fontWeight: 600, opacity: 0.55, fontFamily: vars.font.body })),
);
export const rotGrid = style({ stroke: tint(vars.color.border, 60), strokeDasharray: '2 4' });
export const rotAxis = style({ stroke: tint(vars.color.mutedForeground, 45) });
export const rotTick = style({ fill: vars.color.mutedForeground, fontSize: '9px', fontFamily: vars.font.mono, opacity: 0.85 });
export const rotCaption = style({ fill: vars.color.mutedForeground, fontSize: '9.5px', fontFamily: vars.font.body });
export const rotTrail = styleVariants(perState((c) => ({ stroke: c, strokeWidth: 1.4, strokeLinecap: 'round' })));
export const rotBubble = style({ cursor: 'pointer', transition: glide, willChange: 'transform', ...reduce });
export const rotFill = styleVariants(
    perState((c) => ({
        fill: tint(c, 26),
        stroke: c,
        strokeWidth: 1.2,
        transition: 'r 900ms cubic-bezier(0.22, 1, 0.36, 1), fill 600ms ease, stroke 600ms ease',
        selectors: { [`${rotBubble}:hover &`]: { fill: tint(c, 42) } },
        ...reduce,
    })),
);
const breathe = keyframes({ '0%, 100%': { opacity: 0.12 }, '50%': { opacity: 0.4 } });
export const rotHalo = styleVariants(
    perState((c) => ({ fill: 'none', stroke: c, strokeWidth: 3, filter: 'blur(2px)', animation: `${breathe} 2.6s ease-in-out infinite`, ...reduce })),
);
const ring = keyframes({ from: { transform: 'scale(1)', opacity: 0.85 }, to: { transform: 'scale(2.4)', opacity: 0 } });
export const rotPulse = styleVariants(
    perState((c) => ({
        fill: 'none',
        stroke: c,
        strokeWidth: 1.5,
        transformBox: 'fill-box',
        transformOrigin: 'center',
        animation: `${ring} 1.4s ease-out forwards`,
        ...reduce,
    })),
);
export const rotSelected = style({ fill: 'none', stroke: vars.color.accent, strokeWidth: 1.6, strokeDasharray: '3 2' });
export const rotName = style({
    fill: vars.color.foreground,
    fontSize: '9.5px',
    fontWeight: 650,
    fontFamily: vars.font.body,
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3,
    strokeLinejoin: 'round',
    pointerEvents: 'none',
});
export const rotValue = styleVariants(
    perState((c) => ({
        fill: c,
        color: c,
        fontSize: '9px',
        fontWeight: 650,
        fontFamily: vars.font.mono,
        paintOrder: 'stroke',
        stroke: vars.color.panel,
        strokeWidth: 3,
        strokeLinejoin: 'round',
        pointerEvents: 'none',
    })),
);
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

// ---- 熱力 ----

export const heat = style({
    position: 'relative',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
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
    background: `linear-gradient(90deg, ${vars.color.down}, ${tint(vars.color.down, 25)} 35%, ${vars.color.panelRaised} 50%, ${tint(vars.color.up, 25)} 65%, ${vars.color.up})`,
});
export const heatGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
    gap: '4px',
});
export const heatGridSmall = style({ gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '3px' });
export const heatSection = style({
    margin: '10px 0 5px',
    fontSize: '0.62rem',
    fontWeight: 650,
    color: vars.color.foreground,
});

const heatTileBase = style({
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    height: '62px',
    padding: '5px 7px 4px',
    border: `1px solid ${tint(vars.color.border, 70)}`,
    borderRadius: vars.radius.sm,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    transition: 'background-color 900ms ease, border-color 300ms ease, transform 150ms ease',
    selectors: {
        '&:hover': { borderColor: vars.color.borderBright, transform: 'translateY(-1px)' },
        '&:focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: '1px' },
    },
    ...reduce,
});
export const heatTile = styleVariants({
    in: [heatTileBase, { background: `color-mix(in srgb, ${vars.color.up} var(--heat), ${vars.color.panelRaised})` }],
    out: [heatTileBase, { background: `color-mix(in srgb, ${vars.color.down} var(--heat), ${vars.color.panelRaised})` }],
    flat: [heatTileBase, { background: vars.color.panelRaised }],
});
export const heatTileSmall = style({ height: '50px', padding: '4px 6px 3px' });
export const heatTileOn = style({ boxShadow: `0 0 0 1.5px ${vars.color.accent}`, borderColor: 'transparent' });

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
export const heatHead = style({ display: 'flex', alignItems: 'baseline', gap: '4px', minWidth: 0 });
export const heatName = style({ flex: 1, minWidth: 0, fontSize: '0.64rem', fontWeight: 650, ...ellipsis });
export const heatPct = style({ ...mono, fontSize: '0.54rem', fontWeight: 600, whiteSpace: 'nowrap', color: vars.color.foreground, opacity: 0.72 });
export const heatValue = style({ ...mono, fontSize: '0.78rem', fontWeight: 700, lineHeight: 1.15, whiteSpace: 'nowrap' });
export const heatBars = style({
    marginTop: 'auto',
    display: 'flex',
    alignItems: 'flex-end',
    gap: '2px',
    height: '12px',
});
const heatBarBase = style({ flex: 1, minHeight: '2px', borderRadius: '1px', transition: 'height 600ms ease', ...reduce });
export const heatBar = styleVariants({
    in: [heatBarBase, { background: `color-mix(in srgb, ${vars.color.up} 80%, ${vars.color.foreground})` }],
    out: [heatBarBase, { background: `color-mix(in srgb, ${vars.color.down} 80%, ${vars.color.foreground})` }],
    none: [heatBarBase, { height: '2px', background: tint(vars.color.foreground, 20) }],
});
