// src/components/us-ticket.css.ts — 下單面板的美股分支（樣式取自原美股下單面板）

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    flexWrap: 'wrap',
});

/** 「美股」市場徽章：所有美股畫面都標，避免和台股混淆 */
export const marketBadge = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    color: vars.color.accent,
    background: vars.color.accentDim,
    border: `1px solid ${vars.color.accent}`,
    whiteSpace: 'nowrap',
});

export const accountSelect = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
});

export const infoCard = style({
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '2px 8px',
    padding: '6px 8px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const infoName = style({
    fontSize: '0.74rem',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const infoMeta = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const refLabel = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    textAlign: 'right',
});

export const refValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.92rem',
    fontWeight: 700,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

export const notice = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    fontSize: '0.7rem',
    lineHeight: 1.45,
    color: vars.color.mutedForeground,
    padding: '6px 8px',
    border: `1px dashed ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const warn = style({
    color: vars.color.amber,
});

export const unit = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    flexShrink: 0,
});

export const smallBtn = style({
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    padding: '3px 6px',
    cursor: 'pointer',
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

// ---- 委託／庫存區段（底部 dock） ----

export const priceLine = style({
    gridColumn: '1 / -1',
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

export const quoteMeta = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});
