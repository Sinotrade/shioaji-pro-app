// src/components/combo-ticket.css.ts — 組合單版面：腳/組合資訊/報價
// 各自成塊、欄位對齊，不再是連續文字行擠在一起。

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const section = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: '6px',
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
});

export const sectionTitle = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

// 腳列：方向 chip｜代碼輸入｜（鎖定鈕）
export const legRow = style({
    display: 'grid',
    gridTemplateColumns: '24px 1fr auto',
    alignItems: 'center',
    gap: '6px',
});

export const dirChip = styleVariants({
    buy: {
        width: '24px',
        height: '20px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        fontSize: '0.66rem',
        fontWeight: 700,
        color: vars.color.up,
        background: `color-mix(in srgb, ${vars.color.up} 14%, transparent)`,
    },
    sell: {
        width: '24px',
        height: '20px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        fontSize: '0.66rem',
        fontWeight: 700,
        color: vars.color.down,
        background: `color-mix(in srgb, ${vars.color.down} 14%, transparent)`,
    },
    none: {
        width: '24px',
        height: '20px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        fontSize: '0.66rem',
        color: vars.color.mutedForeground,
        background: vars.color.muted,
    },
});

// 腳報價列：名稱靠左、買/賣靠右，對齊 chip 欄位
export const legQuoteRow = style({
    display: 'grid',
    gridTemplateColumns: '24px 1fr auto',
    alignItems: 'baseline',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const legQuoteRight = style({
    whiteSpace: 'nowrap',
});

// 組合資訊列：型別 badge＋月份＋代碼
export const infoRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
});

export const typeBadge = style({
    padding: '1px 6px',
    borderRadius: '4px',
    fontSize: '0.62rem',
    fontWeight: 600,
    color: vars.color.accent,
    background: vars.color.accentDim,
    whiteSpace: 'nowrap',
});

export const infoCode = style({
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
});

// 快照 L1（尚無即時簿時）：左右兩格對齊
export const snapRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '8px',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
});

// 合成參考：label＋買/中/賣 三欄
export const synthRow = style({
    display: 'grid',
    gridTemplateColumns: 'auto 1fr 1fr 1fr',
    alignItems: 'baseline',
    gap: '8px',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const synthCell = style({
    textAlign: 'center',
    whiteSpace: 'nowrap',
});

// 方向摘要（買進組合 ＝ 賣近／買遠）— 下單區上方的醒目確認行
export const dirSummaryRow = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});
