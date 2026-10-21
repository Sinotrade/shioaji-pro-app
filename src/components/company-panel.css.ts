// src/components/company-panel.css.ts — 公司資料面板（#337）

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    containerType: 'inline-size',
});

export const scroll = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
});

// ── header ────────────────────────────────────────────────────────────────

export const head = style({
    padding: `10px ${vars.space.md} 8px`,
    borderBottom: `1px solid ${vars.color.border}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
});

export const headRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    minWidth: 0,
    flexWrap: 'wrap',
});

export const code = style({
    fontFamily: vars.font.mono,
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const name = style({
    fontFamily: vars.font.display,
    fontSize: '1.05rem',
    fontWeight: 700,
    letterSpacing: '0.01em',
});

export const english = style({
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
});

export const price = style({
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

export const priceValue = style({ fontSize: '1.05rem', fontWeight: 600 });
export const priceChange = style({ fontSize: '0.74rem' });
export const priceNote = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const crumbs = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const crumbSep = style({ opacity: 0.6, display: 'inline-flex' });
export const crumbStrong = style({ color: vars.color.foreground, fontWeight: 600 });

export const chip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.64rem',
    fontWeight: 600,
    lineHeight: 1.6,
    padding: '0 6px',
    borderRadius: vars.radius.sm,
    background: vars.color.muted,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const chipTone = styleVariants({
    neutral: {},
    accent: { background: vars.color.accentDim, color: vars.color.accent },
    // 第三方資料標示：琥珀色，與漲跌／狀態色分開
    thirdParty: {
        background: 'transparent',
        color: vars.color.amber,
        boxShadow: `inset 0 0 0 1px ${vars.color.amber}`,
    },
    official: {
        background: 'transparent',
        color: vars.color.mutedForeground,
        boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}`,
    },
});

export const kpis = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))',
    gap: '1px',
    background: vars.color.border,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const kpi = style({
    background: vars.color.panel,
    padding: `6px ${vars.space.md}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
});

export const kpiLabel = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
});

export const kpiValue = style({
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.84rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

export const kpiSub = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

// ── tabs ──────────────────────────────────────────────────────────────────

export const tabs = style({
    display: 'flex',
    gap: '2px',
    padding: `0 ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    overflowX: 'auto',
    scrollbarWidth: 'none',
});

export const tab = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '7px 10px 6px',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    selectors: {
        '&:hover': { color: vars.color.foreground },
        '&[aria-selected="true"]': {
            color: vars.color.foreground,
            borderBottomColor: vars.color.accent,
        },
    },
});

export const tabCount = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

// ── sections ──────────────────────────────────────────────────────────────

export const section = style({
    padding: `10px ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    selectors: { '&:last-child': { borderBottom: 'none' } },
});

export const sectionHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: vars.color.mutedForeground,
    textTransform: 'uppercase',
});

export const sectionMeta = style({
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    letterSpacing: 0,
    textTransform: 'none',
});

export const prose = style({
    margin: 0,
    fontSize: '0.78rem',
    lineHeight: 1.7,
});

export const muted = style({ color: vars.color.mutedForeground });

export const notice = style({
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-start',
    padding: '8px 10px',
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    fontSize: '0.74rem',
    lineHeight: 1.6,
});

export const noticeTitle = style({ fontWeight: 600, display: 'block' });

// value chain: three tier columns, own stage highlighted
export const chain = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '6px',
});

export const tierCol = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
});

export const tierHead = style({
    fontSize: '0.62rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    letterSpacing: '0.06em',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
});

export const stage = style({
    textAlign: 'left',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    lineHeight: 1.35,
    padding: '4px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    selectors: {
        '&:hover': { borderColor: vars.color.borderBright, color: vars.color.foreground },
        '&[aria-pressed="true"]': { boxShadow: `0 0 0 1px ${vars.color.accent}` },
    },
});

export const stageLabel = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
});

export const stageTone = styleVariants({
    other: {},
    own: {
        background: vars.color.accentDim,
        borderColor: vars.color.accent,
        color: vars.color.accent,
        fontWeight: 600,
    },
    also: {
        borderColor: vars.color.accent,
        borderStyle: 'dashed',
        color: vars.color.foreground,
    },
});

export const reason = style({ fontSize: '0.7rem', color: vars.color.mutedForeground, margin: 0, lineHeight: 1.6 });

// revenue mix
export const mixBar = style({
    display: 'flex',
    height: '8px',
    borderRadius: '2px',
    overflow: 'hidden',
    background: vars.color.muted,
});

export const mixList = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: '2px 12px',
    fontSize: '0.72rem',
});

export const mixItem = style({ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 });
export const swatch = style({ width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0 });
export const mixName = style({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

export const themeChips = style({ display: 'flex', flexWrap: 'wrap', gap: '6px' });

export const themeChip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    padding: '3px 8px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    cursor: 'pointer',
    selectors: {
        '&:hover': { borderColor: vars.color.accent },
        '&[aria-pressed="true"]': { borderColor: vars.color.accent, background: vars.color.accentDim },
    },
});

export const themeStage = style({ fontSize: '0.64rem', color: vars.color.mutedForeground });

// member list (stage / theme drill-down)
export const members = style({
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    overflow: 'hidden',
});

export const membersHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '5px 8px',
    fontSize: '0.68rem',
    fontWeight: 600,
    background: vars.color.panelRaised,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const close = style({
    marginLeft: 'auto',
    display: 'inline-flex',
    background: 'none',
    border: 'none',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    padding: '2px',
    borderRadius: vars.radius.sm,
    selectors: { '&:hover': { color: vars.color.foreground, background: vars.color.muted } },
});

// rows (relations, members)
export const row = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(96px, 1.1fr) minmax(0, 1.6fr) auto',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '4px 8px',
    background: 'none',
    border: 'none',
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    textAlign: 'left',
    selectors: { '&:last-child': { borderBottom: 'none' } },
});

export const rowLink = style({
    cursor: 'pointer',
    selectors: { '&:hover': { background: vars.color.panelRaised } },
});

export const rowName = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    minWidth: 0,
    overflow: 'hidden',
});

export const rowNameText = style({
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const rowCode = style({ fontFamily: vars.font.mono, fontSize: '0.66rem', color: vars.color.mutedForeground, flexShrink: 0 });

export const rowDetail = style({
    color: vars.color.mutedForeground,
    fontSize: '0.7rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
});

export const rowEnd = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    justifyContent: 'flex-end',
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.7rem',
    whiteSpace: 'nowrap',
});

export const foreignIcon = style({ color: vars.color.mutedForeground, flexShrink: 0, alignSelf: 'center' });

export const groupHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 8px 4px',
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const groupCount = style({ fontFamily: vars.font.mono, color: vars.color.mutedForeground, fontWeight: 500 });

export const more = style({
    width: '100%',
    padding: '5px 8px',
    background: 'none',
    border: 'none',
    borderTop: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.display,
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.accent,
    cursor: 'pointer',
    textAlign: 'left',
    selectors: { '&:hover': { background: vars.color.panelRaised } },
});

// financials
export const chart = style({ display: 'block', width: '100%', height: 'auto' });

globalStyle(`${chart} text`, {
    fontFamily: vars.font.mono,
    fontSize: '9px',
    fill: vars.color.mutedForeground,
});

// 年增率線：琥珀色，不用漲跌色（營收成長不是價格方向）
export const yoyLine = style({ stroke: vars.color.amber });
export const yoySwatch = style({ background: vars.color.amber, height: '2px' });

export const legend = style({
    display: 'flex',
    gap: '12px',
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    alignItems: 'center',
    flexWrap: 'wrap',
});

export const legendKey = style({ display: 'inline-flex', alignItems: 'center', gap: '4px' });

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

globalStyle(`${table} th`, {
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    textAlign: 'right',
    padding: '4px 6px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});

globalStyle(`${table} td`, {
    fontFamily: vars.font.mono,
    textAlign: 'right',
    padding: '4px 6px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});

globalStyle(`${table} th:first-child, ${table} td:first-child`, { textAlign: 'left' });
globalStyle(`${table} tr:last-child td`, { borderBottom: 'none' });

export const tableWrap = style({ overflowX: 'auto' });

// sources
export const sourceList = style({ display: 'flex', flexDirection: 'column', gap: '6px', margin: 0, padding: 0, listStyle: 'none' });
export const sourceItem = style({ fontSize: '0.72rem', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: '1px' });

export const sourceLink = style({
    color: vars.color.foreground,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    selectors: { '&:hover': { color: vars.color.accent, textDecoration: 'underline' } },
});

export const sourceMeta = style({ fontSize: '0.64rem', color: vars.color.mutedForeground });

export const facts = style({
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    gap: '3px 12px',
    fontSize: '0.72rem',
    margin: 0,
});

globalStyle(`${facts} dt`, { color: vars.color.mutedForeground });
globalStyle(`${facts} dd`, { margin: 0, minWidth: 0, overflowWrap: 'anywhere' });

// footer
export const foot = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: `4px ${vars.space.sm} 4px ${vars.space.md}`,
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    flexShrink: 0,
    minWidth: 0,
});

export const footText = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    minWidth: 0,
    flex: 1,
});

export const stale = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: vars.color.amber,
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

export const center = style({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    padding: vars.space.lg,
    textAlign: 'center',
    fontSize: '0.76rem',
    color: vars.color.mutedForeground,
});

export const centerIcon = style({ color: vars.color.mutedForeground, opacity: 0.8 });
