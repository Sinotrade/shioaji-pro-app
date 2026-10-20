import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const disclosure = style({
    flexShrink: 1,
    minHeight: 44,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    borderTop: `1px solid ${vars.color.border}`,
    fontSize: '0.7rem',
    '@media': {
        '(forced-colors: active)': { color: 'CanvasText', background: 'Canvas', borderColor: 'CanvasText' },
    },
});

export const summary = style({
    minHeight: 44,
    boxSizing: 'border-box',
    padding: `12px ${vars.space.sm}`,
    cursor: 'pointer',
    lineHeight: 1.5,
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
    '@media': {
        '(max-height: 360px)': { paddingTop: 6, paddingBottom: 6 },
        '(forced-colors: active)': { ':focus-visible': { outlineColor: 'Highlight' } },
    },
});

export const content = style({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: `4px ${vars.space.sm}`,
    margin: 0,
    padding: `0 ${vars.space.sm} ${vars.space.sm}`,
    maxHeight: 'min(12rem, 30vh)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    lineHeight: 1.5,
});

export const value = style({
    minWidth: 0,
    margin: 0,
    overflowWrap: 'anywhere',
    whiteSpace: 'normal',
});
