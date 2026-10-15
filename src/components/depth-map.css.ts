// src/components/depth-map.css.ts
import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
});

export const chartFrame = style({
    display: 'flex',
    position: 'relative',
    flex: 1,
    minHeight: 0,
});

export const canvas = style({
    flex: 1,
    minHeight: 0,
    height: 0,
    width: '100%',
    touchAction: 'pan-y',
});

export const hover = style({
    position: 'absolute',
    zIndex: 2,
    pointerEvents: 'none',
    padding: '4px 6px',
    maxWidth: '190px',
    fontSize: '0.65rem',
    lineHeight: 1.5,
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    boxShadow: '0 2px 12px rgba(0, 0, 0, 0.25)',
    overflowWrap: 'anywhere',
});

export const hint = style({
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    textAlign: 'center',
});
