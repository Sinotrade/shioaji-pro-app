// src/components/sector-heatmap.css.ts — 產業全景（全景 treemap＋產業下鑽）

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    minWidth: 0,
});

export const hint = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
});

export const spacer = style({ flex: 1 });

export const segmentGroup = style({
    display: 'inline-flex',
    gap: '2px',
    padding: '1px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

const segmentBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    lineHeight: 1.4,
    padding: '1px 7px',
    border: 'none',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
});

export const segment = styleVariants({
    on: [
        segmentBase,
        {
            background: vars.color.panel,
            color: vars.color.foreground,
            fontWeight: 600,
        },
    ],
    off: [
        segmentBase,
        {
            background: 'transparent',
            color: vars.color.mutedForeground,
            ':hover': { color: vars.color.foreground },
        },
    ],
});

// 不設 color — 讓並掛的 panel.dirText 方向色能生效（同權重 class 後者蓋前者）
export const totals = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});


export const simtrade = style({
    fontSize: '0.58rem',
    color: vars.color.danger,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.sm,
    padding: '0 4px',
    whiteSpace: 'nowrap',
});

export const error = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: `3px ${vars.space.sm}`,
    fontSize: '0.62rem',
    color: vars.color.danger,
    borderBottom: `1px solid ${vars.color.border}`,
});

// ---- 全景層 treemap ----

export const treemapBox = style({
    position: 'relative',
    flex: 1,
    minHeight: 0,
    margin: '3px',
    overflow: 'hidden',
});

export const heatTile = style({
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '4px 6px',
    color: vars.color.foreground,
    background: `color-mix(in srgb, var(--heat-color) var(--heat-alpha), ${vars.color.panel})`,
    border: `1px solid color-mix(in srgb, var(--heat-color) 55%, ${vars.color.border})`,
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'filter 120ms ease',
    ':hover': { filter: 'brightness(1.16)' },
});

export const tileName = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
});

export const tilePct = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 700,
});

export const tileSub = style({
    fontFamily: vars.font.mono,
    fontSize: '0.56rem',
    color: vars.color.mutedForeground,
});

// ---- 下鑽層 ----

export const drillBody = styleVariants({
    row: {
        display: 'flex',
        flexDirection: 'row',
        flex: 1,
        minHeight: 0,
    },
    // 窄面板：左右擺不下 → 上下堆疊（排行上、磚牆下）
    column: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
    },
});

export const rankPane = styleVariants({
    row: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1.15 1 0',
        minWidth: 0,
        minHeight: 0,
        borderRight: `1px solid ${vars.color.border}`,
        overflowY: 'auto',
    },
    column: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1.2 1 0',
        minHeight: 0,
        borderBottom: `1px solid ${vars.color.border}`,
        overflowY: 'auto',
    },
});

export const wallPane = style({
    position: 'relative',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    margin: '3px',
});

export const rankHeader = style({
    display: 'grid',
    gridTemplateColumns:
        '1.1rem minmax(4.4rem, 1.2fr) minmax(3rem, 0.9fr) minmax(0, 1.6fr) 3.6rem',
    gap: '6px',
    alignItems: 'center',
    padding: `3px ${vars.space.sm}`,
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    position: 'sticky',
    top: 0,
    background: vars.color.panel,
    zIndex: 1,
});

export const rankHeaderCell = style({
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

export const rankRow = style({
    display: 'grid',
    gridTemplateColumns:
        '1.1rem minmax(4.4rem, 1.2fr) minmax(3rem, 0.9fr) minmax(0, 1.6fr) 3.6rem',
    gap: '6px',
    alignItems: 'center',
    padding: `2px ${vars.space.sm}`,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    ':hover': { background: vars.color.inset },
});

export const rankIndex = style({
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontSize: '0.58rem',
    textAlign: 'right',
});

export const rankCode = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '4px',
    minWidth: 0,
    textAlign: 'left',
    fontFamily: vars.font.mono,
    fontWeight: 600,
    color: vars.color.foreground,
});

export const rankName = style({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.body,
    fontSize: '0.56rem',
    fontWeight: 400,
    color: vars.color.mutedForeground,
});

export const rankPct = style({
    fontFamily: vars.font.mono,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

// 中心軸雙向 bar：負值往左、正值往右
export const barCell = style({
    display: 'flex',
    alignItems: 'center',
    height: '0.62rem',
    minWidth: 0,
});

const barHalf = style({
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'flex',
    position: 'relative',
});

export const barHalfNeg = style([barHalf, { justifyContent: 'flex-end' }]);
export const barHalfPos = style([barHalf, {}]);

export const barFillNeg = style({
    height: '100%',
    background: `color-mix(in srgb, ${vars.color.down} 55%, transparent)`,
    borderRadius: '1px 0 0 1px',
});

export const barFillPos = style({
    height: '100%',
    background: `color-mix(in srgb, ${vars.color.up} 55%, transparent)`,
    borderRadius: '0 1px 1px 0',
});

// 成交值排行的單向 bar — 長度＝成交值、顏色跟該股漲跌方向
export const barFillAmount = style({
    height: '100%',
    background: `color-mix(in srgb, var(--bar-color, ${vars.color.flat}) 55%, transparent)`,
    borderRadius: '1px',
    alignSelf: 'center',
});

export const barAxis = style({
    width: '1px',
    alignSelf: 'stretch',
    background: vars.color.border,
    flexShrink: 0,
});

export const rankPoints = style({
    fontFamily: vars.font.mono,
    fontWeight: 600,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

// 其他成員／產業合計列
export const summaryRow = style({
    display: 'grid',
    gridTemplateColumns:
        '1.1rem minmax(4.4rem, 1.2fr) minmax(3rem, 0.9fr) minmax(0, 1.6fr) 3.6rem',
    gap: '6px',
    alignItems: 'center',
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.mutedForeground,
});

export const totalRow = style([
    summaryRow,
    {
        borderTop: `1px solid ${vars.color.border}`,
        position: 'sticky',
        bottom: 0,
        background: vars.color.panel,
    },
]);

// 摘要列的值固定落在第 5 欄（與排行的值欄對齊），標籤自由跨欄
export const summaryValue = style({
    gridColumn: '5 / 6',
});

export const totalLabel = style({
    gridColumn: '2 / 3',
    fontFamily: vars.font.body,
    textAlign: 'left',
    whiteSpace: 'nowrap',
});

export const summaryLabel = style({
    gridColumn: '2 / 4',
    fontFamily: vars.font.body,
    textAlign: 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

// 下鑽 header（breadcrumb＋官方類股指數錨點）
export const backBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
    cursor: 'pointer',
    padding: '1px 3px',
    borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground, background: vars.color.inset },
});

export const crumbName = style({
    fontSize: '0.7rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const officialQuote = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '5px',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

export const officialLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
});

export const empty = style({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
    padding: vars.space.md,
    textAlign: 'center',
});
