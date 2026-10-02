// src/components/replay-panel.css.ts

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

export const controls = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const playBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    fontWeight: 600,
    padding: '2px 10px',
    cursor: 'pointer',
    background: vars.color.accentDim,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    color: vars.color.accent,
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

const speedBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    padding: '2px 7px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
});

export const speed = styleVariants({
    off: [speedBase, { ':hover': { color: vars.color.foreground } }],
    on: [
        speedBase,
        { color: vars.color.foreground, background: vars.color.muted },
    ],
});

export const seek = style({
    flex: 1,
    minWidth: 0,
    accentColor: vars.color.accent,
});

export const status = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

export const chartHost = style({
    flex: 1,
    minHeight: 0,
});

export const dateInput = style({
    width: 116,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
});

export const practice = style({ padding: `5px ${vars.space.sm}`, borderTop: `1px solid ${vars.color.border}`, flexShrink: 0 });
export const practiceStatus = style({ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center', color: vars.color.mutedForeground, fontFamily: vars.font.mono, fontSize: '0.64rem' });
export const practiceActions = style({ display: 'grid', gridTemplateColumns: '86px 1fr 1fr 1fr', gap: 5, marginTop: 5 });
globalStyle(`${practiceActions} label`, { display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.62rem', color: vars.color.mutedForeground });
globalStyle(`${practiceActions} input`, { width: 42, color: vars.color.foreground, background: vars.color.inset, border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm });
const practiceButton = style({ padding: '4px 7px', borderRadius: vars.radius.sm, cursor: 'pointer', fontWeight: 700, fontSize: '0.64rem', selectors: { '&:disabled': { opacity: 0.4, cursor: 'not-allowed' } } });
export const practiceBuy = style([practiceButton, { color: '#fff', background: vars.color.danger, border: `1px solid ${vars.color.danger}` }]);
export const practiceSell = style([practiceButton, { color: '#fff', background: '#16846c', border: '1px solid #35d09a' }]);
export const practiceFlat = style([practiceButton, { color: vars.color.amber, background: vars.color.inset, border: `1px solid ${vars.color.amber}` }]);
export const practiceNote = style({ marginTop: 4, color: vars.color.mutedForeground, fontSize: '0.56rem' });
