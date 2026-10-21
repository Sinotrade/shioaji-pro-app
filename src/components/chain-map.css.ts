// src/components/chain-map.css.ts — 產業鏈資金流向（流向時間軸＋鏈內流向＋聚焦個股）
//
// Hairline structure, tabular mono figures, colour only where it carries
// meaning: up/down for flow direction and price, accent for selection.

import { style, styleVariants } from '@vanilla-extract/css';
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

// ---- flow tape ----

export const tape = style({
    flex: 1,
    minHeight: 120,
    overflowY: 'auto',
    overflowX: 'hidden',
});

export const row = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(96px, 148px) minmax(0, 1fr) 78px 46px 62px',
    alignItems: 'center',
    columnGap: '10px',
    padding: `0 ${vars.space.sm}`,
    minWidth: 0,
});

export const rowNarrow = style({
    gridTemplateColumns: 'minmax(80px, 112px) minmax(0, 1fr) 70px 56px',
    columnGap: '8px',
});

export const headRow = style({
    position: 'sticky',
    top: 0,
    zIndex: 2,
    height: '22px',
    background: vars.color.panel,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const headName = style({
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    ...ellipsis,
});

export const headNum = style({
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    cursor: 'help',
});

export const axis = style({
    position: 'relative',
    height: '100%',
});

export const axisTick = style({
    position: 'absolute',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    ...mono,
    fontSize: '0.52rem',
    color: vars.color.mutedForeground,
    opacity: 0.8,
    selectors: {
        '&:first-child': { transform: 'translate(0, -50%)' },
        '&:nth-child(6)': { transform: 'translate(-100%, -50%)' },
    },
});

export const axisHover = style({
    position: 'absolute',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    ...mono,
    fontSize: '0.54rem',
    fontWeight: 700,
    color: vars.color.accent,
    background: vars.color.panel,
    padding: '0 3px',
    borderRadius: '2px',
    boxShadow: `0 0 0 1px ${vars.color.accent}`,
    zIndex: 1,
});

const dataRowBase = style({
    height: '30px',
    cursor: 'pointer',
    borderLeft: '2px solid transparent',
    paddingLeft: `calc(${vars.space.sm} - 2px)`,
    outline: 'none',
    selectors: {
        '&:hover': { background: vars.color.panelRaised },
        '&:focus-visible': { boxShadow: `inset 0 0 0 1px ${vars.color.accent}` },
        '& + &': { borderTop: `1px solid color-mix(in srgb, ${vars.color.border} 55%, transparent)` },
    },
});

export const dataRow = styleVariants({
    on: [dataRowBase, { borderLeftColor: vars.color.accent, background: vars.color.panelRaised }],
    off: [dataRowBase],
});

export const name = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
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

export const strip = style({
    position: 'relative',
    height: '100%',
    minWidth: 0,
});

export const stripCanvas = style({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
});

// minutes before the first received 1-minute bar: covered by the seed summary
export const seed = style({
    position: 'absolute',
    top: '6px',
    bottom: '6px',
    left: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: '6px',
    borderRadius: '2px',
    background: `repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, ${vars.color.border} 45%, transparent) 4px 5px)`,
    overflow: 'hidden',
    pointerEvents: 'none',
});

export const seedText = style({
    ...mono,
    fontSize: '0.54rem',
    color: vars.color.mutedForeground,
    background: vars.color.panel,
    padding: '0 4px',
    borderRadius: '2px',
    whiteSpace: 'nowrap',
});

export const num = style({
    ...mono,
    fontSize: '0.64rem',
    fontWeight: 700,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

export const hot = style({ color: vars.color.amber });
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
