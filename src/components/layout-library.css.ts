// src/components/layout-library.css.ts — 版面庫 dialog：卡片＋縮圖＋
// hover flyout，視覺語彙沿用 panel-library.css.ts（backdrop/shell/卡片）。

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 212,
    background: 'rgba(0, 0, 0, 0.45)',
});

export const shell = style({
    position: 'fixed',
    top: '8vh',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 213,
    width: 'min(680px, calc(100vw - 32px))',
});

export const dialog = style({
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '78vh',
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
    overflow: 'hidden',
});

export const titleRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
    fontWeight: 600,
});

export const titleClose = style({
    marginLeft: 'auto',
});

export const body = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${vars.space.sm} ${vars.space.md} ${vars.space.md}`,
});

export const sectionHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: `${vars.space.sm} 2px 4px`,
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
    fontWeight: 600,
});

export const cardGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
    gap: '6px',
});

const cardBase = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    padding: '7px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});

export const card = styleVariants({
    normal: [cardBase, {}],
    active: [
        cardBase,
        {
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});

export const thumbFrame = style({
    width: '100%',
    aspectRatio: '3 / 2',
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
    background: vars.color.inset,
    overflow: 'hidden',
});

export const thumbSvg = style({
    display: 'block',
    width: '100%',
    height: '100%',
});

export const cardName = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '0.72rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const cardIcon = style({
    display: 'inline-flex',
    color: vars.color.accent,
    flexShrink: 0,
});

export const cardDesc = style({
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
});

// rename / delete micro-buttons: appear on card hover, top-right overlay
export const cardActions = style({
    position: 'absolute',
    top: '10px',
    right: '10px',
    display: 'flex',
    gap: '3px',
    opacity: 0,
    transition: 'opacity 0.12s',
    selectors: {
        [`${cardBase}:hover &, ${cardBase}:focus-within &`]: { opacity: 1 },
    },
});

const actionBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    padding: 0,
    cursor: 'pointer',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panelRaised,
    color: vars.color.mutedForeground,
});

export const actionBtn = styleVariants({
    normal: [
        actionBase,
        {
            ':hover': {
                color: vars.color.foreground,
                borderColor: vars.color.borderBright,
            },
        },
    ],
    // second stage of delete: widened, red, explicit
    danger: [
        actionBase,
        {
            width: 'auto',
            padding: '0 6px',
            color: '#fff',
            background: vars.color.danger,
            borderColor: vars.color.danger,
            fontSize: '0.6rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
        },
    ],
});

export const renameInput = style({
    width: '100%',
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    padding: '2px 6px',
    outline: 'none',
});

export const empty = style({
    padding: vars.space.md,
    color: vars.color.mutedForeground,
    fontSize: '0.68rem',
    lineHeight: 1.6,
});

// ---- hover flyout（放大縮圖＋面板清單）----

export const flyout = style({
    position: 'absolute',
    top: 0,
    left: 'calc(100% + 8px)',
    width: '280px',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.sm,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.35)',
    // shell 是置中 680px：flyout 右緣 = vw/2 + 340 + 8 + 280，
    // vw < 1256 就會被視窗右緣裁切 — 塞不下就整個藏起來
    '@media': {
        'screen and (max-width: 1255px)': {
            display: 'none',
        },
    },
});

export const flyoutThumbFrame = style({
    width: '100%',
    aspectRatio: '280 / 190',
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
    background: vars.color.inset,
    overflow: 'hidden',
});

export const flyoutTitle = style({
    fontSize: '0.74rem',
    fontWeight: 600,
});

export const flyoutDesc = style({
    color: vars.color.mutedForeground,
    fontSize: '0.64rem',
    lineHeight: 1.5,
});

export const flyoutList = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const flyoutItem = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.66rem',
    color: vars.color.foreground,
});

export const flyoutDot = style({
    width: '7px',
    height: '7px',
    borderRadius: '2px',
    flexShrink: 0,
});

export const flyoutPin = style({
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
});

// ---- 底部固定：儲存目前版面（所見即所存）----

export const saveBar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    flexWrap: 'wrap',
});

export const saveThumbFrame = style({
    width: '90px',
    height: '60px',
    flexShrink: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
    background: vars.color.inset,
    overflow: 'hidden',
});

export const saveFields = style({
    flex: 1,
    minWidth: '180px',
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
});

export const saveHint = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const iconRow = style({
    display: 'flex',
    gap: '3px',
    flexWrap: 'wrap',
});

const iconOptBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: 0,
    cursor: 'pointer',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
});

export const iconOpt = styleVariants({
    off: [
        iconOptBase,
        {
            ':hover': {
                color: vars.color.foreground,
                borderColor: vars.color.borderBright,
            },
        },
    ],
    on: [
        iconOptBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});
