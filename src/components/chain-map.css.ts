// src/components/chain-map.css.ts — 產業鏈地圖（題材排行欄＋分階段 treemap＋關係曲線）

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const ellipsis = {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
} as const;

export const center = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: vars.space.md,
});

export const wrap = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
});

export const wrapRail = style({
    gridTemplateColumns: '196px minmax(0, 1fr)',
});

// ---- 題材排行欄 ----

export const rail = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRight: `1px solid ${vars.color.border}`,
});

export const railHead = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: `5px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const railList = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '2px 0',
});

const railRowBase = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gridTemplateAreas: '"name pct" "bar count"',
    columnGap: '6px',
    rowGap: '3px',
    width: '100%',
    padding: `4px ${vars.space.sm} 5px`,
    border: 'none',
    borderLeft: '2px solid transparent',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: vars.font.body,
    ':hover': { background: vars.color.panelRaised },
});

export const railRow = styleVariants({
    on: [railRowBase, { borderLeftColor: vars.color.accent, background: vars.color.panelRaised }],
    off: [railRowBase],
});

export const railName = style({
    gridArea: 'name',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.66rem',
    fontWeight: 600,
    minWidth: 0,
    ...ellipsis,
});

export const kindDot = style({
    flexShrink: 0,
    width: '5px',
    height: '5px',
    borderRadius: '1px',
    background: vars.color.accent,
});

export const railPct = style({
    gridArea: 'pct',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
});

export const railBreadth = style({ gridArea: 'bar', alignSelf: 'center' });

export const railCount = style({
    gridArea: 'count',
    fontFamily: vars.font.mono,
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

// ---- 漲平跌家數條 ----

export const breadth = style({
    display: 'flex',
    height: '4px',
    minWidth: '28px',
    borderRadius: '2px',
    overflow: 'hidden',
    background: vars.color.inset,
    gap: '1px',
});

const segBase = style({ flexBasis: 0, minWidth: 0 });
export const breadthSeg = styleVariants({
    up: [segBase, { background: vars.color.up }],
    flat: [segBase, { background: vars.color.flat, opacity: 0.5 }],
    down: [segBase, { background: vars.color.down }],
});

// ---- 主區 ----

export const main = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '6px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    minWidth: 0,
});

export const title = style({
    fontSize: '0.74rem',
    fontWeight: 700,
    color: vars.color.foreground,
    ...ellipsis,
    maxWidth: '40%',
});

export const select = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 4px',
    maxWidth: '46%',
});

export const kindTag = style({
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '0 4px',
    whiteSpace: 'nowrap',
});

export const totals = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

export const toolbarBreadth = style({ width: '56px' });

export const hint = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
    ...ellipsis,
});

export const spacer = style({ flex: 1 });

export const segmentGroup = style({
    display: 'inline-flex',
    gap: '2px',
    padding: '1px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    alignSelf: 'flex-start',
});

const segmentBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    lineHeight: 1.4,
    padding: '1px 6px',
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

const iconToggleBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontFamily: vars.font.mono,
    fontSize: '0.58rem',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    border: `1px solid ${vars.color.border}`,
});

export const iconToggle = styleVariants({
    on: [iconToggleBase, { color: vars.color.accent, borderColor: vars.color.accent, background: vars.color.accentDim }],
    off: [iconToggleBase, { color: vars.color.mutedForeground, background: 'transparent', ':hover': { color: vars.color.foreground } }],
});

export const notice = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.6rem',
    color: vars.color.amber,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const relatedRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: `3px ${vars.space.sm}`,
    overflowX: 'auto',
    flexShrink: 0,
    scrollbarWidth: 'none',
});

export const relatedLabel = style({
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
    flexShrink: 0,
});

export const chip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '999px',
    padding: '0 7px',
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
    ':hover': { borderColor: vars.color.accent },
});

// ---- 產業鏈圖 ----

export const map = style({
    position: 'relative',
    flex: 1,
    minHeight: 80,
    margin: `4px ${vars.space.sm} 2px`,
    overflow: 'hidden',
});

export const stageHead = style({
    position: 'absolute',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '2px 4px',
    borderTop: `2px solid ${vars.color.borderBright}`,
    minWidth: 0,
});

export const stageTop = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
});

const tierBase = style({
    flexShrink: 0,
    fontSize: '0.54rem',
    fontWeight: 600,
    padding: '0 3px',
    borderRadius: '2px',
    border: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
});

// 上中下游用 accent 深淺區分 — 非價格語意，不用 up/down
export const tierTag = styleVariants({
    upstream: [tierBase, { color: vars.color.accent, borderColor: vars.color.accent }],
    midstream: [tierBase, { color: vars.color.foreground }],
    downstream: [tierBase, { color: vars.color.mutedForeground }],
    other: [tierBase],
});

export const stageName = style({
    fontSize: '0.62rem',
    fontWeight: 600,
    color: vars.color.foreground,
    minWidth: 0,
    ...ellipsis,
});

export const stageBottom = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    minWidth: 0,
    overflow: 'hidden',
});

export const stagePct = style({
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

export const stageBreadth = style({ flex: 1, maxWidth: '72px' });

export const stageCount = style({
    fontFamily: vars.font.mono,
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
});

export const tiles = style({
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
});

export const tile = style({
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    gap: '1px',
    padding: '3px 4px',
    color: vars.color.foreground,
    background: `color-mix(in srgb, var(--heat-color) var(--heat-alpha), ${vars.color.panel})`,
    border: `1px solid color-mix(in srgb, var(--heat-color) 45%, ${vars.color.border})`,
    borderRadius: '2px',
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'opacity 140ms ease, filter 120ms ease',
    ':hover': { filter: 'brightness(1.16)' },
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
});

export const tileDim = style({ opacity: 0.28 });

export const tileFocus = style({
    boxShadow: `inset 0 0 0 2px ${vars.color.accent}`,
    zIndex: 1,
});

export const tileLinked = style({
    boxShadow: `inset 0 0 0 1px ${vars.color.accent}`,
});

export const tileName = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    fontWeight: 600,
    maxWidth: '100%',
    lineHeight: 1.2,
    ...ellipsis,
});

export const tilePct = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 700,
    lineHeight: 1.2,
});

export const tileSub = style({
    fontFamily: vars.font.mono,
    fontSize: '0.54rem',
    color: vars.color.mutedForeground,
    ...ellipsis,
    maxWidth: '100%',
});

export const links = style({
    position: 'absolute',
    left: 0,
    top: 0,
    pointerEvents: 'none',
    overflow: 'visible',
    zIndex: 2,
});

export const linkHot = style({
    fill: 'none',
    stroke: vars.color.accent,
    strokeWidth: 1.6,
    color: vars.color.accent,
});

export const linkFaint = style({
    fill: 'none',
    stroke: vars.color.mutedForeground,
    strokeWidth: 1,
    strokeOpacity: 0.35,
    color: vars.color.mutedForeground,
});

export const arrowHead = style({ fill: 'context-stroke' });

// ---- 焦點個股 ----

export const focus = style({
    flexShrink: 0,
    maxHeight: '42%',
    overflowY: 'auto',
    borderTop: `1px solid ${vars.color.border}`,
    padding: `4px ${vars.space.sm}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
});

export const focusHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
    flexWrap: 'wrap',
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
    ':hover': { color: vars.color.accent },
});

export const focusCode = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontWeight: 400,
});

export const focusNum = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
});

export const focusMeta = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
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

export const focusRole = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const focusEmpty = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const focusGroups = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: '4px 10px',
});

export const focusGroup = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '3px',
    minWidth: 0,
});

export const groupLabel = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '0.58rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    marginRight: '2px',
});

export const groupCount = style({
    fontFamily: vars.font.mono,
    fontWeight: 400,
});

export const rel = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    maxWidth: '100%',
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '0 5px',
    cursor: 'pointer',
    ':hover': { borderColor: vars.color.accent },
});

export const relStatic = style({
    cursor: 'default',
    color: vars.color.mutedForeground,
    ':hover': { borderColor: vars.color.border },
});

export const relName = style({ ...ellipsis, maxWidth: '9em' });

export const relPct = style({
    fontFamily: vars.font.mono,
    fontSize: '0.56rem',
    fontWeight: 700,
});

export const inChainDot = style({
    flexShrink: 0,
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: vars.color.accent,
});

export const evidenceTag = style({
    fontSize: '0.5rem',
    color: vars.color.amber,
    border: `1px solid ${vars.color.amber}`,
    borderRadius: '2px',
    padding: '0 2px',
});

export const footer = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.54rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
});
