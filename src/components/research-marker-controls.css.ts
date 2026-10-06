import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    flexShrink: 0, borderBottom: `1px solid ${vars.color.border}`,
    padding: '3px 10px', fontSize: '0.75rem', color: vars.color.mutedForeground,
    minWidth: 0, containerType: 'inline-size',
});
// Regime Bar：研究版 K 線上方唯一常駐列，單列、可橫向捲動，不壓縮 K 線。
export const headline = style({
    display: 'flex', alignItems: 'center', gap: 8, minHeight: 36, minWidth: 0,
    flexWrap: 'nowrap', overflowX: 'auto',
});
export const headlineMeta = style({ fontSize: 11, color: vars.color.mutedForeground });
// Three compact readouts, not three large cards. Keep the candle area tall.
export const decisionSummary = style({ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'stretch' });
const decisionBadgeBase = style({
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1,
    minHeight: 32, padding: '2px 7px', borderRadius: 4, fontSize: 12, whiteSpace: 'nowrap',
    borderLeft: '2px solid #64748b', background: 'rgba(148,163,184,.05)',
});
export const decisionBadge = styleVariants({
    long: [decisionBadgeBase, { color: '#fb7185', borderLeftColor: '#fb7185', background: 'rgba(244,63,94,.08)' }],
    short: [decisionBadgeBase, { color: '#4ade80', borderLeftColor: '#4ade80', background: 'rgba(34,197,94,.08)' }],
    neutral: [decisionBadgeBase, { color: '#fbbf24', borderLeftColor: '#fbbf24', background: 'rgba(245,158,11,.06)' }],
    insufficient: [decisionBadgeBase, { color: '#94a3b8' }],
});
export const decisionRole = style({ fontSize: 10, opacity: .78 });
export const decisionEntry = style({
    font: 'inherit', textAlign: 'left', cursor: 'pointer',
    borderTop: 0, borderRight: 0, borderBottom: 0,
    ':focus-visible': { outline: '2px solid #22d3ee', outlineOffset: 2 },
});
export const decisionReasons = style({
    padding: '4px 8px', marginBottom: 4, fontSize: 11, lineHeight: 1.45,
    borderLeft: '2px solid #fbbf24', background: 'rgba(245,158,11,.04)',
});
globalStyle(`${decisionReasons} > strong`, { color: '#fbbf24', marginRight: 9 });
globalStyle(`${decisionReasons} > ul`, { paddingLeft: 18, margin: '3px 0 0' });
export const entryChecklist = style({ listStyle: 'none', paddingLeft: 0 });
const entryCheckBase = style({ display: 'flex', gap: 7, alignItems: 'baseline', padding: '1px 0' });
export const entryCheck = styleVariants({
    pass: [entryCheckBase, { color: '#94d6b0' }],
    wait: [entryCheckBase, { color: '#fbbf24' }],
    missing: [entryCheckBase, { color: '#94a3b8' }],
});
globalStyle(`${entryChecklist} > li > strong`, { flexShrink: 0, minWidth: 53 });
export const formulaSources = style({
    fontSize: 11, lineHeight: 1.45, margin: '3px 0 5px',
});
globalStyle(`${formulaSources} > summary`, { cursor: 'pointer', color: '#67e8f9' });
globalStyle(`${formulaSources} > p`, { margin: '4px 0', maxWidth: 900 });
const headlineBiasBase = style({
    display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0, fontSize: 15,
    paddingLeft: 9, borderLeft: '3px solid #64748b',
});
export const headlineBias = styleVariants({
    long: [headlineBiasBase, { color: '#fb7185', borderLeftColor: '#fb7185' }],
    short: [headlineBiasBase, { color: '#4ade80', borderLeftColor: '#4ade80' }],
    neutral: [headlineBiasBase, { color: '#fbbf24', borderLeftColor: '#fbbf24' }],
    insufficient: [headlineBiasBase, { color: '#94a3b8', borderLeftColor: '#64748b' }],
});
// 現價與漲跌
export const regimeQuote = style({
    display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0, alignItems: 'flex-start',
});
export const regimePrice = style({
    color: vars.color.foreground, fontSize: 16, fontWeight: 700,
    fontFamily: vars.font.mono, lineHeight: 1.1, whiteSpace: 'nowrap',
});
export const regimeChg = styleVariants({
    up: { color: '#fb7185', fontSize: '10.5px', fontFamily: vars.font.mono, whiteSpace: 'nowrap' },
    down: { color: '#4ade80', fontSize: '10.5px', fontFamily: vars.font.mono, whiteSpace: 'nowrap' },
    flat: { color: vars.color.mutedForeground, fontSize: '10.5px', fontFamily: vars.font.mono, whiteSpace: 'nowrap' },
});
// 四週期方向：單列、不換行（外層橫捲）
export const frameBadges = style({ display: 'flex', flex: '0 0 auto', gap: 5, minWidth: 0 });
const frameBadgeBase = style({ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 7px',
    whiteSpace: 'nowrap', borderRadius: 5, fontSize: 12, border: '1px solid transparent' });
export const frameBadge = styleVariants({
    long: [frameBadgeBase, { color: '#fb7185', background: 'rgba(244,63,94,.09)', borderColor: 'rgba(251,113,133,.25)' }],
    short: [frameBadgeBase, { color: '#4ade80', background: 'rgba(34,197,94,.09)', borderColor: 'rgba(74,222,128,.25)' }],
    neutral: [frameBadgeBase, { color: '#fbbf24', background: 'rgba(245,158,11,.09)' }],
    insufficient: [frameBadgeBase, { color: '#94a3b8', background: 'rgba(148,163,184,.06)' }],
});
// 開盤／ATR 精簡狀態
export const regimeReferenceItems = style({
    display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0,
    fontSize: '10.5px', fontWeight: 600, fontFamily: vars.font.mono, whiteSpace: 'nowrap',
});
// 工具按鈕槽（週期／平均K／指標…）
export const toolbarSlot = style({ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 });
const fibBtnBase = style({
    font: 'inherit', minHeight: 28, padding: '3px 9px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${vars.color.border}`, color: vars.color.mutedForeground, background: 'transparent',
    ':focus-visible': { outline: '2px solid #22d3ee', outlineOffset: 2 },
});
export const fibBtn = styleVariants({
    on: [fibBtnBase, { background: 'rgba(34,211,238,.10)', color: vars.color.foreground, borderColor: 'rgba(34,211,238,.4)' }],
    off: [fibBtnBase],
});
export const expandButton = style({ flexShrink: 0, minHeight: 28, padding: '4px 9px',
    fontSize: 12, color: vars.color.foreground, border: `1px solid ${vars.color.border}`, borderRadius: 5,
    background: vars.color.panelRaised, cursor: 'pointer',
    ':focus-visible': { outline: '2px solid #22d3ee', outlineOffset: 2 } });
// 保留：舊 headline 的壓/撐摘要（Regime Bar 已不收、details 內仍有完整壓撐）。
export const nearestSummary = style({ display: 'flex', gap: 12, fontSize: 12, whiteSpace: 'nowrap' });
export const detailsPanel = style({ maxHeight: 'min(32vh, 250px)', overflow: 'auto', paddingTop: 5,
    selectors: { '&[hidden]': { display: 'none' } } });
export const overview = style({
    display: 'flex', flexWrap: 'nowrap', gap: 5, marginBottom: 4,
    overflowX: 'auto', alignItems: 'stretch',
});
const directionCardBase = style({
    flex: '0 0 168px',
    minHeight: 46, display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '4px 8px', border: `1px solid ${vars.color.border}`, borderRadius: 6,
});
export const directionCard = styleVariants({
    long: [directionCardBase, { background: 'linear-gradient(135deg, rgba(244,63,94,.20), rgba(244,63,94,.04))', borderColor: 'rgba(251,113,133,.55)' }],
    short: [directionCardBase, { background: 'linear-gradient(135deg, rgba(34,197,94,.20), rgba(34,197,94,.04))', borderColor: 'rgba(74,222,128,.55)' }],
    neutral: [directionCardBase, { background: 'linear-gradient(135deg, rgba(245,158,11,.18), rgba(245,158,11,.03))', borderColor: 'rgba(251,191,36,.45)' }],
    insufficient: [directionCardBase, { background: 'rgba(148,163,184,.06)' }],
});
export const eyebrow = style({ fontSize: '0.64rem', letterSpacing: '.08em', opacity: .78, whiteSpace: 'nowrap' });
export const directionValue = style({ color: vars.color.foreground, fontSize: '0.84rem', lineHeight: 1.2, whiteSpace: 'nowrap' });
export const directionNote = style({ fontSize: '0.59rem', opacity: .8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
export const frameGrid = style({
    flex: '0 0 390px', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(72px, 1fr))', gap: 4,
});
const frameCardBase = style({
    minWidth: 0, minHeight: 46, display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '3px 6px', border: `1px solid ${vars.color.border}`, borderRadius: 5, background: 'rgba(15,23,42,.22)',
});
export const frameCard = styleVariants({
    long: [frameCardBase, { borderTop: '2px solid #fb7185', background: 'rgba(244,63,94,.08)' }],
    short: [frameCardBase, { borderTop: '2px solid #4ade80', background: 'rgba(34,197,94,.08)' }],
    neutral: [frameCardBase, { borderTop: '2px solid #fbbf24', background: 'rgba(245,158,11,.07)' }],
    insufficient: [frameCardBase, { borderTop: '2px solid #64748b' }],
});
export const frameName = style({ fontSize: 11, opacity: .76, whiteSpace: 'nowrap' });
export const frameDirection = style({ color: vars.color.foreground, fontSize: 14, lineHeight: 1.25, whiteSpace: 'nowrap' });
export const frameMeta = style({ fontSize: 11, opacity: .72, whiteSpace: 'nowrap' });
export const levelCard = style({
    flex: '0 0 300px',
    minHeight: 46, padding: '4px 7px', border: `1px solid ${vars.color.border}`, borderRadius: 6,
    background: 'rgba(15,23,42,.22)',
});
export const levelHeader = style({ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2, fontSize: '0.57rem' });
export const levelGrid = style({ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(74px, 1fr))', gap: 4 });
const levelPointBase = style({
    minWidth: 0, display: 'grid', gap: 1, paddingLeft: 6, borderLeft: '2px solid #64748b',
});
export const levelPoint = styleVariants({
    resistance: [levelPointBase, { borderLeftColor: '#fb7185', color: '#fb7185' }],
    current: [levelPointBase, { borderLeftColor: '#22d3ee', color: '#67e8f9' }],
    support: [levelPointBase, { borderLeftColor: '#4ade80', color: '#4ade80' }],
});
export const levelLabel = style({ fontSize: 11, opacity: .76 });
export const levelValue = style({ color: vars.color.foreground, fontSize: 13, whiteSpace: 'nowrap' });
export const levelDetail = style({ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const pivotCard = style({
    display: 'grid', gridTemplateColumns: 'minmax(230px, .8fr) minmax(285px, 1fr) minmax(300px, 1.3fr)',
    alignItems: 'center', gap: 8, minHeight: 42, marginBottom: 3,
    padding: '3px 7px', border: `1px solid ${vars.color.border}`, borderRadius: 5, overflowX: 'auto',
    background: 'rgba(15,23,42,.22)',
});
export const pivotLevels = style({ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 });
export const pivotLevel = style({
    display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0,
    padding: '2px 6px', borderRadius: 4, background: 'rgba(248,250,252,.08)',
});
export const pivotLevelName = style({ fontSize: '0.52rem', color: vars.color.mutedForeground, lineHeight: 1.1 });
export const pivotLevelPrice = style({ color: vars.color.foreground, fontSize: '0.66rem', lineHeight: 1.2, whiteSpace: 'nowrap' });
export const pivotSignal = style({
    display: 'flex', alignItems: 'center', gap: 7, minWidth: 0,
    padding: '4px 8px', borderRadius: 4, background: 'rgba(245,158,11,.10)',
});
export const pivotSignalTitle = style({ color: vars.color.foreground, fontSize: '0.7rem', whiteSpace: 'nowrap' });
export const pivotSignalText = style({ fontSize: '0.56rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const row = style({ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 4, paddingTop: 1, overflowX: 'auto' });
export const label = style({ color: vars.color.foreground, fontWeight: 600, whiteSpace: 'nowrap' });
const button = style({
    font: 'inherit', minHeight: 32, padding: '4px 8px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${vars.color.border}`, color: vars.color.mutedForeground,
    ':focus-visible': { outline: '2px solid #22d3ee', outlineOffset: 2 },
});
export const toggle = styleVariants({
    on: [button, { background: 'rgba(34, 211, 238, .10)', color: vars.color.foreground, borderColor: 'rgba(34, 211, 238, .4)' }],
    off: [button, { background: 'transparent' }],
});
export const status = style({ display: 'flex', flexWrap: 'nowrap', gap: '3px 10px', marginTop: 2, lineHeight: 1.25, overflowX: 'auto', whiteSpace: 'nowrap' });
export const help = style({ fontSize: '0.62rem', cursor: 'pointer', flexBasis: 'auto', whiteSpace: 'nowrap' });
export const explanation = style({
    maxWidth: 640, lineHeight: 1.65, padding: '6px 10px', cursor: 'text', whiteSpace: 'normal', fontSize: 12,
    borderLeft: '2px solid #22d3ee',
});
