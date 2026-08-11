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

// 自訂排列 popover（欄×列步進器）
export const layoutWrap = style({
    position: 'relative',
    display: 'inline-flex',
});

export const popBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 29,
});

export const pop = style({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
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

export const popRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
});

export const stepBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    width: '20px',
    height: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    transition: 'all 0.12s',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.3, cursor: 'default' },
});

export const stepVal = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    minWidth: '1.4em',
    textAlign: 'center',
    color: vars.color.foreground,
});

export const popHint = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

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

// 單檔設定齒輪 — 平時隱形，滑過 cell 才浮現
export const cellGear = style({
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 3px',
    marginLeft: '2px',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    opacity: 0,
    transition: 'opacity 0.12s',
    flexShrink: 0,
    selectors: {
        [`${cell}:hover &`]: { opacity: 1 },
        '&:hover': { color: vars.color.foreground },
    },
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
