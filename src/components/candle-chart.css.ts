// src/components/candle-chart.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
});

export const toolbar = style({
    display: 'flex',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const tfBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 500,
    padding: '2px 10px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const tfBtn = styleVariants({
    normal: [tfBase],
    active: [
        tfBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});

export const iconBtn = style([
    tfBase,
    {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2px 6px',
    },
]);

export const toolbarDivider = style({
    width: '1px',
    alignSelf: 'stretch',
    margin: '2px 4px',
    background: vars.color.border,
});

const modeBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 500,
    padding: '2px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const modeBtn = styleVariants({
    normal: [modeBase],
    active: [
        modeBase,
        { color: vars.color.foreground, background: vars.color.muted },
    ],
    armed: [
        modeBase,
        {
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            fontWeight: 600,
        },
    ],
});

export const qtyInput = style({
    width: '3rem',
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 600,
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const indBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 90,
});

export const indMenu = style({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 91,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    width: '9rem',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    padding: '4px',
});

export const indItem = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    textAlign: 'left',
    padding: '3px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    ':hover': { background: vars.color.muted },
});

export const indSwatch = style({
    width: '10px',
    height: '3px',
    borderRadius: '1px',
    flexShrink: 0,
});

export const modeHint = style({
    position: 'absolute',
    top: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: '#1a1304',
    background: vars.color.amber,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    pointerEvents: 'none',
});

export const triggerList = style({
    position: 'absolute',
    top: '8px',
    left: '8px',
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
});

export const triggerRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 6px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
});

export const orderCancel = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.danger,
    padding: '0 6px',
    ':hover': {
        borderColor: vars.color.danger,
        background: vars.color.muted,
    },
});

export const triggerRemove = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    lineHeight: 1,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '1px 2px',
    ':hover': { color: vars.color.danger },
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
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
});
