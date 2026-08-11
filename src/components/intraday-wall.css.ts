// src/components/intraday-wall.css.ts

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
    alignItems: 'center',
    gap: '6px',
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    fontSize: '0.68rem',
    whiteSpace: 'nowrap',
});

export const select = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    background: vars.color.inset,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 4px',
    maxWidth: '11em',
    cursor: 'pointer',
});

const pagerBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    padding: '0 7px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
    ':disabled': { opacity: 0.3, cursor: 'default' },
});

export const pagerBtn = pagerBase;

export const pageInfo = style({
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    minWidth: '3.2em',
    textAlign: 'center',
});

export const spacer = style({ flex: 1 });

export const grid = style({
    flex: 1,
    minHeight: 0,
    display: 'grid',
    gap: '4px',
    padding: '4px',
});

export const cell = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panel,
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'border-color 0.12s',
    ':hover': { borderColor: vars.color.borderBright },
});

export const cellHead = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    padding: '2px 6px',
    fontSize: '0.64rem',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    flexShrink: 0,
});

export const cellCode = style({
    fontWeight: 700,
    color: vars.color.foreground,
});

export const cellName = style({
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
    flex: 1,
});

export const cellPx = style({
    fontWeight: 700,
});

// 鎖漲停/跌停亮燈（cell 版）
const cellLockBase = style({
    fontWeight: 700,
    padding: '0 4px',
    borderRadius: vars.radius.sm,
    color: '#fff',
});

export const cellLock = styleVariants({
    up: [cellLockBase, { background: vars.color.up }],
    down: [cellLockBase, { background: vars.color.down }],
});

export const cellChart = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
});

export const centerMsg = style({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: vars.color.mutedForeground,
    fontSize: '0.7rem',
    gap: '6px',
});
