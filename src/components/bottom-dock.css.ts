// src/components/bottom-dock.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const dock = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
});

export const tabBar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    padding: `0 ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const tabBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.7rem',
    fontWeight: 500,
    padding: '7px 14px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const tab = styleVariants({
    off: [tabBase],
    on: [
        tabBase,
        {
            color: vars.color.foreground,
            fontWeight: 600,
            borderBottomColor: vars.color.accent,
        },
    ],
});

export const tabSpacer = style({ flex: 1 });

export const accountSelect = style({
    alignSelf: 'center',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 4px',
    marginRight: '6px',
    outline: 'none',
    maxWidth: '11rem',
    ':focus': { borderColor: vars.color.accent },
});

export const clickableRow = style({
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

export const th = style({
    position: 'sticky',
    top: 0,
    textAlign: 'right',
    padding: `4px ${vars.space.sm}`,
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 500,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
    background: vars.color.panel,
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: {
        '&:first-child': { textAlign: 'left' },
    },
});

export const td = style({
    textAlign: 'right',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid rgba(34, 43, 55, 0.5)`,
    selectors: {
        '&:first-child': { textAlign: 'left' },
    },
});

// quantity cells render mixed-unit stock amounts ("5張+10股") — CJK glyphs
// are line-break opportunities, so pin the whole quantity to one line
export const qtyCell = style({
    whiteSpace: 'nowrap',
});

const chipBase = style({
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: '0.64rem',
    fontWeight: 500,
    borderRadius: '999px',
});

export const statusChip = styleVariants({
    ok: [
        chipBase,
        {
            color: vars.color.down,
            background: vars.color.downDim,
        },
    ],
    pending: [
        chipBase,
        {
            color: vars.color.amber,
            background: 'rgba(224, 164, 60, 0.12)',
        },
    ],
    bad: [
        chipBase,
        {
            color: vars.color.mutedForeground,
            background: vars.color.muted,
        },
    ],
});

export const cancelBtn = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 500,
    color: vars.color.up,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 8px',
    cursor: 'pointer',
    ':hover': {
        borderColor: vars.color.up,
        background: vars.color.upDim,
    },
});

export const qtyInline = style({
    width: '3.4rem',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    padding: '1px 4px',
    outline: 'none',
});

export const detailCell = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const fillCell = style({
    display: 'inline-flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '2.4rem',
});

export const fillTrack = style({
    display: 'block',
    height: '3px',
    borderRadius: '2px',
    background: vars.color.muted,
    overflow: 'hidden',
});

export const fillBar = style({
    display: 'block',
    height: '100%',
    background: vars.color.amber,
});

export const emptyState = style({
    padding: vars.space.lg,
    textAlign: 'center',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.display,
    fontSize: '0.74rem',
});

export const accountGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: vars.space.sm,
    padding: vars.space.md,
});

export const statCard = style({
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `${vars.space.sm} ${vars.space.md}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const statCardLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

export const statCardValue = style({
    fontFamily: vars.font.mono,
    fontSize: '1rem',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
});

export const pnlBar = style({
    height: '3px',
    marginTop: '3px',
    background: vars.color.muted,
    borderRadius: '2px',
    position: 'relative',
    overflow: 'hidden',
});

export const pnlFill = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    transition: 'width 0.3s',
});

// ---- asset distribution (帳務 tab) ----

export const distBlock = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
});

export const distTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
});

// donut on the left, aligned detail/holdings list on the right
export const distWrap = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.lg,
});

export const distDetail = style({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
});

export const distRow = style({
    display: 'grid',
    gridTemplateColumns: '10px 5.2rem 1fr 3.2rem',
    alignItems: 'center',
    columnGap: vars.space.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

export const distLabel = style({
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    fontWeight: 500,
});

export const distValue = style({
    textAlign: 'right',
    color: vars.color.foreground,
    fontWeight: 600,
});

export const distPct = style({
    textAlign: 'right',
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
});

export const distSwatch = style({
    width: '10px',
    height: '10px',
    borderRadius: '3px',
});

export const holdingHead = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
    marginTop: '6px',
    paddingTop: '6px',
    borderTop: `1px solid ${vars.color.border}`,
});

export const holdingRow = style({
    display: 'grid',
    gridTemplateColumns: '3.6rem 1fr auto 3.2rem',
    alignItems: 'center',
    columnGap: vars.space.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
});

export const holdingCode = style({
    color: vars.color.foreground,
    fontWeight: 600,
});

export const holdingTrack = style({
    height: '6px',
    borderRadius: '3px',
    background: vars.color.muted,
    overflow: 'hidden',
});

export const holdingFill = style({
    height: '100%',
    borderRadius: '3px',
    background: vars.color.accent,
    opacity: 0.7,
});

export const holdingValue = style({
    color: vars.color.mutedForeground,
});

// ---- dock 全域控制列（帳戶範圍／合併模式／市場篩選）＋摘要列 ----

export const ctrlGroup = style({
    display: 'flex',
    gap: '2px',
    alignSelf: 'center',
    marginRight: '6px',
});

const ctrlOptBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    fontWeight: 500,
    padding: '2px 8px',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    transition: 'all 0.12s',
});

// 兩態/三態切換（合併｜分帳戶、全部｜證券｜期貨）— hud-header opt 語彙
export const ctrlOpt = styleVariants({
    off: [ctrlOptBase, { ':hover': { color: vars.color.foreground } }],
    on: [
        ctrlOptBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
});

export const summaryRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: vars.space.lg,
    rowGap: '2px',
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const sumItem = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '5px',
    whiteSpace: 'nowrap',
});

export const sumLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

export const sumValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
});

export const sumSub = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
});

// ---- pane 骨架：內部捲動區＋固定底部批次動作列 ----

export const dockBody = style({
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
});

export const paneScroll = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
});

export const batchBar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.sm,
    padding: `3px ${vars.space.sm}`,
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    flexShrink: 0,
});

export const batchCount = style({
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    fontWeight: 600,
});

export const batchSpacer = style({ flex: 1 });

const batchBtnBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 600,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    cursor: 'pointer',
    transition: 'all 0.12s',
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

// 兩段式確認：第一擊顯示筆數確認、第二擊執行（3 秒未確認自動復原）
export const batchExec = styleVariants({
    idle: [
        batchBtnBase,
        {
            color: vars.color.danger,
            background: 'transparent',
            border: `1px solid ${vars.color.border}`,
            selectors: {
                '&:hover:not(:disabled)': {
                    borderColor: vars.color.danger,
                },
            },
        },
    ],
    confirm: [
        batchBtnBase,
        {
            color: '#fff',
            background: vars.color.danger,
            border: `1px solid ${vars.color.danger}`,
        },
    ],
});

export const chk = style({
    width: '12px',
    height: '12px',
    margin: 0,
    accentColor: vars.color.accent,
    cursor: 'pointer',
    verticalAlign: 'middle',
    ':disabled': { cursor: 'not-allowed', opacity: 0.35 },
});

export const busyRow = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.amber,
});

// ---- 分帳戶區段 header ----

export const groupHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    width: '100%',
    padding: `3px ${vars.space.sm}`,
    background: vars.color.inset,
    border: 'none',
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    cursor: 'pointer',
    textAlign: 'left',
    ':hover': { background: vars.color.muted },
});

export const groupTitle = style({
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

export const groupStat = style({
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const groupSpacer = style({ flex: 1 });

// ---- 委託：狀態篩選 chips 列 ----

export const filterRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '4px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
});

// ---- 窄版兩行卡片式 row ----

export const cardRow = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid rgba(34, 43, 55, 0.5)`,
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});

export const cardLine = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    minWidth: 0,
});

export const cardCode = style({
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const cardName = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
});

export const cardSpacer = style({ flex: 1 });

const dirBadgeBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    padding: '0 5px',
    borderRadius: vars.radius.sm,
    whiteSpace: 'nowrap',
});

export const dirBadge = styleVariants({
    up: [dirBadgeBase, { color: vars.color.up, background: vars.color.upDim }],
    down: [
        dirBadgeBase,
        { color: vars.color.down, background: vars.color.downDim },
    ],
});

// 現價/均價 疊排（窄版第二行）
export const priceStack = style({
    display: 'flex',
    flexDirection: 'column',
    lineHeight: 1.25,
    fontSize: '0.64rem',
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});

export const priceStackLabel = style({
    color: vars.color.mutedForeground,
    marginRight: '4px',
    fontSize: '0.58rem',
    fontFamily: vars.font.display,
});

// ---- 委託：價格雙行（委託價／成交均價）與成交進度圈 ----

export const priceDual = style({
    display: 'inline-flex',
    flexDirection: 'column',
    lineHeight: 1.25,
    alignItems: 'flex-end',
});

export const priceDualSub = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const ringWrap = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    whiteSpace: 'nowrap',
});
