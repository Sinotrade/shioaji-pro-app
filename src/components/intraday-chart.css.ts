// src/components/intraday-chart.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
});

export const legend = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: '10px',
    rowGap: '2px',
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    // NOTE: 不能 overflow hidden — 齒輪的設定 popover 從這層冒出來
});

export const sessionChip = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    background: vars.color.muted,
    color: vars.color.mutedForeground,
    alignSelf: 'center',
});

export const hoverChip = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.borderBright}`,
    color: vars.color.foreground,
    alignSelf: 'center',
});

export const price = style({
    fontSize: '0.85rem',
    fontWeight: 700,
});

export const kv = style({
    color: vars.color.mutedForeground,
});

export const kvVal = style({
    color: vars.color.foreground,
});

export const avgVal = style({
    color: vars.color.amber,
});

export const toggles = style({
    display: 'inline-flex',
    gap: '2px',
    marginLeft: 'auto',
    alignSelf: 'center',
    alignItems: 'center',
});

export const toggleDivider = style({
    width: '1px',
    height: '10px',
    margin: '0 3px',
    background: vars.color.border,
});

const scaleBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    fontWeight: 500,
    padding: '1px 7px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const scaleBtn = styleVariants({
    normal: [scaleBase],
    active: [
        scaleBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});

export const settingsWrap = style({
    position: 'relative',
    display: 'inline-flex',
});

export const settingsBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 29,
});

export const settingsPop = style({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
    whiteSpace: 'nowrap',
});

export const settingsRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const settingsLabel = style({
    minWidth: '2.2em',
});

export const chartHost = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
});

export const emptyMsg = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: vars.color.mutedForeground,
    fontSize: '0.7rem',
    pointerEvents: 'none',
    zIndex: 2,
});
