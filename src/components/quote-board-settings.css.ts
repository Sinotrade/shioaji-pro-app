// src/components/quote-board-settings.css.ts：報價欄自訂欄位的設定面板

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 60,
});

export const pop = style({
    position: 'fixed',
    zIndex: 61,
    width: '15.5rem',
    maxHeight: 'calc(100vh - 16px)',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    color: vars.color.foreground,
    cursor: 'default',
});

export const head = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
});

export const title = style({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    fontWeight: 600,
});

export const subtitle = style({
    fontWeight: 400,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

const iconBtnBase = style({
    display: 'inline-grid',
    placeItems: 'center',
    width: '1.35rem',
    height: '1.35rem',
    padding: 0,
    border: 'none',
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    selectors: {
        '&:hover:not(:disabled)': { background: vars.color.muted, color: vars.color.foreground },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -1 },
        '&:disabled': { opacity: 0.3, cursor: 'default' },
    },
});

export const iconBtn = iconBtnBase;
// 排序箭頭較小，一列放兩個不搶標籤
export const moveBtn = style([iconBtnBase, { width: '1.15rem', height: '1.15rem' }]);

// 指數／個股切換：整排分段按鈕，目前看板的種類預設選中
export const segment = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    padding: '2px',
    gap: '2px',
    borderRadius: vars.radius.sm,
    background: vars.color.muted,
});

const segBtnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    padding: '3px 6px',
    border: 'none',
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    cursor: 'pointer',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -1 },
    },
});

export const segBtn = styleVariants({
    on: [segBtnBase, { background: vars.color.panelRaised, color: vars.color.foreground, fontWeight: 600 }],
    off: [segBtnBase, { background: 'transparent', color: vars.color.mutedForeground }],
});

// 目前看板正在用的那一種，加一個小圓點
export const currentDot = style({
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: vars.color.accent,
});

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    overflow: 'hidden',
});

export const sectionHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 4px 3px 8px',
    background: vars.color.muted,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

export const sectionLabel = style({ flex: 1 });

export const row = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 4px 2px 8px',
    minHeight: '1.6rem',
    selectors: {
        '&:hover': { background: `color-mix(in srgb, ${vars.color.muted} 55%, transparent)` },
    },
});

export const check = style({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    minWidth: 0,
    cursor: 'pointer',
});

export const checkbox = style({
    margin: 0,
    width: '13px',
    height: '13px',
    accentColor: vars.color.accent,
    cursor: 'pointer',
});

export const fieldLabel = style({ whiteSpace: 'nowrap' });

export const fieldOff = style({ color: vars.color.mutedForeground });

export const hint = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

// 排序箭頭的位置固定佔住，位置固定的格子顯示一個鎖，欄位才對得齊
export const moves = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    width: '2.4rem',
    flexShrink: 0,
    color: vars.color.mutedForeground,
});

export const pinned = style({
    display: 'inline-grid',
    placeItems: 'center',
    width: '1.15rem',
    opacity: 0.6,
});

export const foot = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    paddingTop: '2px',
});

export const footNote = style({
    flex: 1,
    display: 'flex',
    gap: '4px',
    fontSize: '0.6rem',
    lineHeight: 1.4,
    color: vars.color.mutedForeground,
});

export const reset = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    padding: '3px 7px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    cursor: 'pointer',
    selectors: {
        '&:hover:not(:disabled)': { background: vars.color.muted },
        '&:disabled': { opacity: 0.4, cursor: 'default' },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
    },
});

globalStyle(`${pop} svg`, { flexShrink: 0 });
