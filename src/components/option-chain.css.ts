// src/components/option-chain.css.ts

import { createContainer, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const chainContainer = createContainer();
// #371 多一欄成交量後的窄面板退讓：先收欄距，再收買、賣兩欄（點選後在閃電看五檔）
const TIGHT = `${chainContainer} (max-width: 500px)`;
const NARROW = `${chainContainer} (max-width: 430px)`;
const MINIMAL = `${chainContainer} (max-width: 300px)`;

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    containerName: chainContainer,
    containerType: 'inline-size',
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const atm = style({
    marginLeft: 'auto',
    // 窄面板時先縮這一格，到期選擇器保持完整；全文在 title
    flexShrink: 1000,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
    '@container': { [MINIMAL]: { display: 'none' } },
});

// 合約載入狀態：工具列下方單獨一列，過長時以省略號截斷（全文在 title）
export const status = style({
    flexShrink: 0,
    minWidth: 0,
    padding: `2px ${vars.space.sm}`,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const table = style({
    width: '100%',
    // sticky 表頭在 collapse 下兩列之間會露出捲動中的列
    borderCollapse: 'separate',
    borderSpacing: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
});

// 表頭有兩列：整個 thead 一起 sticky，兩列才不會疊在同一個位置
export const thead = style({
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: vars.color.panel,
});

export const th = style({
    textAlign: 'center',
    padding: `3px 4px`,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    background: vars.color.panel,
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
    '@container': { [TIGHT]: { paddingLeft: 1, paddingRight: 1 } },
});

export const strikeTh = style({
    // muted 是半透明：sticky 表頭要先鋪不透明底，捲動的列才不會透出來
    background: `linear-gradient(${vars.color.muted}, ${vars.color.muted}), ${vars.color.panel}`,
});

// 表頭第一列：買、賣兩欄收掉時跨欄數跟著變，否則右邊留一塊空白
export const sideHeadWide = style({
    '@container': { [NARROW]: { display: 'none' } },
});
export const sideHeadNarrow = style({
    display: 'none',
    '@container': { [NARROW]: { display: 'table-cell' } },
});

export const td = style({
    textAlign: 'right',
    padding: `2px 6px`,
    borderBottom: `1px solid rgba(127, 127, 127, 0.08)`,
    whiteSpace: 'nowrap',
    '@container': { [TIGHT]: { paddingLeft: 3, paddingRight: 3 } },
});

// 買、賣兩欄：最窄時收掉
export const bookCol = style({
    '@container': { [NARROW]: { display: 'none' } },
});

export const volume = style({
    color: vars.color.mutedForeground,
});

export const strike = style({
    textAlign: 'center',
    padding: `2px 8px`,
    whiteSpace: 'nowrap',
    '@container': { [TIGHT]: { paddingLeft: 4, paddingRight: 4 } },
    fontWeight: 700,
    color: vars.color.foreground,
    background: vars.color.muted,
    borderBottom: `1px solid rgba(127, 127, 127, 0.08)`,
});

export const atmStrike = style({
    color: vars.color.accent,
    background: vars.color.accentDim,
});

export const pickableRow = style({
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});

// 訂閱窗外的列：數字是快照，不是即時
export const staleRow = style({
    opacity: 0.55,
});

export const atmBtn = style({
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.3rem',
    height: '1.3rem',
    padding: 0,
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground },
    selectors: {
        '&[data-away]': { color: vars.color.accent, borderColor: vars.color.accent },
    },
});
