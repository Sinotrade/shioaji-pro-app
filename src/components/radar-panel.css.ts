// src/components/radar-panel.css.ts

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// research palette (matches candle-chart / research components)
const LONG = '#fb7185';
const SHORT = '#4ade80';
const NEUTRAL = '#fbbf24';
const NONE = '#3a4350';

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const title = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.foreground,
    marginRight: 'auto',
    whiteSpace: 'nowrap',
});

export const iconBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground, borderColor: vars.color.mutedForeground },
});

export const iconBtnOn = style({
    color: vars.color.accent,
    borderColor: vars.color.accent,
});

export const head = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.5fr) auto repeat(4, 1.05rem)',
    alignItems: 'center',
    columnGap: '3px',
    padding: `3px ${vars.space.sm}`,
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const headNum = style({
    textAlign: 'center',
});

export const body = style({
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
});

export const row = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.5fr) auto repeat(4, 1.05rem)',
    alignItems: 'center',
    columnGap: '3px',
    padding: `3px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    borderBottom: '1px solid rgba(34, 43, 55, 0.4)',
    ':hover': { background: vars.color.muted },
});

export const idBlock = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const codeTxt = style({
    fontWeight: 600,
    color: vars.color.foreground,
    lineHeight: 1.1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const nameTxt = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const priceBlock = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    whiteSpace: 'nowrap',
    lineHeight: 1.15,
});

export const priceUp = style({ color: LONG, fontWeight: 600 });
export const priceDown = style({ color: SHORT, fontWeight: 600 });
export const priceFlat = style({ color: vars.color.foreground, fontWeight: 600 });
export const pctTxt = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

const cellBase = style({
    width: '1rem',
    height: '1rem',
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.55rem',
    fontWeight: 700,
});

export const cell = styleVariants({
    long: [cellBase, { background: LONG, color: '#1a1014' }],
    short: [cellBase, { background: SHORT, color: '#0f1a12' }],
    neutral: [cellBase, { background: NEUTRAL, color: '#1a1606' }],
    insufficient: [cellBase, { background: NONE, color: '#6b7480' }],
});

const flashKf = keyframes({
    '0%': { background: 'rgba(34, 211, 238, 0.4)' },
    '100%': { background: 'transparent' },
});

export const flashOverlay = style({
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    animation: `${flashKf} 2.4s ease-out`,
});

export const stateMsg = style({
    padding: '1rem',
    textAlign: 'center',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
});

// ---- event feed (collapsible) ----
export const feedToggle = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    width: '100%',
    padding: `4px ${vars.space.sm}`,
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: 'none',
    borderTop: `1px solid ${vars.color.border}`,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { color: vars.color.foreground },
});

export const feedCount = style({
    marginLeft: 'auto',
    color: vars.color.accent,
    fontWeight: 600,
});

export const feed = style({
    maxHeight: '38%',
    overflowY: 'auto',
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const eventRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '5px',
    padding: `3px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    borderBottom: '1px solid rgba(34, 43, 55, 0.35)',
});

export const eventTime = style({
    color: vars.color.mutedForeground,
    fontSize: '0.58rem',
    flexShrink: 0,
});

export const eventText = style({
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const eventTagLong = style({ color: LONG, fontWeight: 700 });
export const eventTagShort = style({ color: SHORT, fontWeight: 700 });
