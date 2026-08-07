// src/components/watchlist.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const list = style({
    display: 'flex',
    flexDirection: 'column',
});

const rowBase = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gridTemplateRows: 'auto auto',
    columnGap: vars.space.sm,
    padding: `6px ${vars.space.md}`,
    cursor: 'pointer',
    borderBottom: `1px solid ${vars.color.border}`,
    borderLeft: '2px solid transparent',
    transition: 'background 0.12s, border-color 0.12s',
    ':hover': {
        background: vars.color.muted,
    },
});

export const row = styleVariants({
    normal: [rowBase],
    selected: [
        rowBase,
        {
            background: vars.color.accentDim,
            borderLeftColor: vars.color.accent,
        },
    ],
});

export const code = style({
    fontFamily: vars.font.mono,
    fontSize: '0.8rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const name = style({
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const price = style({
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    fontWeight: 600,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

export const change = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

// flash plays on a keyed overlay so the row itself never remounts
// (remounting dropped hover state and thrashed the DOM on every deal)
const flashOverlayBase = style({
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
});

export const flashOverlay = styleVariants({
    up: [flashOverlayBase, { animation: 'flash-up 0.5s ease-out' }],
    down: [flashOverlayBase, { animation: 'flash-down 0.5s ease-out' }],
});

export const dropTarget = style({
    boxShadow: `inset 0 2px 0 ${vars.color.accent}`,
});

// 排序模式：左 grip 把手、右 上移/下移 直欄 — 都以絕對定位掛在 row 上，
// 靠加大的左右 padding 讓出空間，spark 欄版面不動
export const rowArrange = style({
    paddingLeft: '24px',
    paddingRight: '46px',
    cursor: 'grab',
});

export const gripHandle = style({
    position: 'absolute',
    left: '4px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    color: vars.color.mutedForeground,
    pointerEvents: 'none',
});

export const moveCol = style({
    position: 'absolute',
    right: '4px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const moveBtn = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '15px',
    padding: 0,
    cursor: 'pointer',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    ':hover': {
        color: vars.color.foreground,
        borderColor: vars.color.borderBright,
    },
    ':disabled': { opacity: 0.35, cursor: 'default' },
});

// sparkline mode: third middle column between code/name and price/change
export const rowSparkCols = style({
    gridTemplateColumns: 'minmax(0, 1fr) minmax(48px, 1.1fr) auto',
});

export const sparkCell = style({
    gridColumn: 2,
    gridRow: '1 / span 2',
    alignSelf: 'center',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    padding: '0 4px',
});

export const removeBtn = style({
    gridColumn: '1 / -1',
    display: 'none',
});

export const listPicker = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const listSelect = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 500,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const listBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    width: '24px',
    height: '24px',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    flexShrink: 0,
    ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.45, cursor: 'not-allowed' },
});

export const listBtnOn = style({
    color: vars.color.accent,
    borderColor: vars.color.accent,
    background: vars.color.accentDim,
});

export const listBtnDanger = style({
    color: '#fff',
    background: vars.color.danger,
    borderColor: vars.color.danger,
    fontSize: '0.6rem',
});

export const rowRemove = style({
    position: 'absolute',
    right: '4px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '18px',
    height: '18px',
    fontSize: '0.62rem',
    lineHeight: 1,
    cursor: 'pointer',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    opacity: 0,
    transition: 'opacity 0.12s',
    selectors: {
        [`${rowBase}:hover &`]: { opacity: 1 },
        '&:hover': { color: vars.color.danger, borderColor: vars.color.danger },
    },
});

export const loadingHint = style({
    padding: vars.space.md,
    textAlign: 'center',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const addRow = style({
    position: 'relative',
    display: 'flex',
    gap: vars.space.xs,
    padding: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

// name-search suggestions float above the add input
export const suggestBox = style({
    position: 'absolute',
    bottom: '100%',
    left: vars.space.sm,
    right: vars.space.sm,
    zIndex: 30,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    boxShadow: '0 -6px 18px rgba(0, 0, 0, 0.3)',
    overflow: 'hidden',
});

export const suggestRow = style({
    display: 'grid',
    gridTemplateColumns: '3.4rem 1fr auto',
    columnGap: vars.space.sm,
    alignItems: 'center',
    width: '100%',
    padding: `4px ${vars.space.sm}`,
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.foreground,
    fontSize: '0.7rem',
    ':hover': { background: vars.color.muted },
});

export const suggestCode = style({
    fontFamily: vars.font.mono,
    fontWeight: 600,
});

export const suggestName = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const suggestCat = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const addInput = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 8px',
    outline: 'none',
    ':focus': {
        borderColor: vars.color.accent,
    },
    '::placeholder': {
        color: vars.color.mutedForeground,
    },
});

export const typeSelect = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    outline: 'none',
});
