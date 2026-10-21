import { globalStyle, keyframes, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// 尺寸一律用 em：伺服器設定 dialog 是 1rem，首次設定卡片字級較小，
// 同一組元件在兩處都能等比例縮放，對齊關係不變。
const CONTROL = '2.25em'; // 輸入框、按鈕、分段切換同高
const CONTROL_SM = '2em'; // 列表列尾按鈕
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
// 舊版 WKWebView（Safari 13–16.1）不支援 color-mix。含 var() 的宣告在計算值
// 階段才失效，不會退回前一個值，所以 rgba 放基本樣式、color-mix 只在 @supports 內覆寫。
const SUPPORTS_MIX = '(color: color-mix(in srgb, red 50%, transparent))';
const mixed = (props: Record<'borderColor' | 'background', [string, string]>) => ({
    borderColor: props.borderColor[0], background: props.background[0],
    '@supports': { [SUPPORTS_MIX]: { borderColor: props.borderColor[1], background: props.background[1] } },
});
const focusRing = { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 } as const;

export const backdrop = style({ position: 'fixed', inset: 0, zIndex: 209, background: 'rgba(0,0,0,.45)' });
export const dialog = style({
    position: 'fixed', inset: '5vh auto auto 50%', transform: 'translateX(-50%)', zIndex: 210,
    width: 'min(44rem, calc(100vw - 24px))', maxHeight: '90dvh', display: 'flex', flexDirection: 'column',
    color: vars.color.foreground, background: vars.color.panelRaised, border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md, boxShadow: '0 18px 48px rgba(0,0,0,.4)', fontSize: '1rem',
    selectors: { '&:focus': { outline: 'none' } },
});
export const header = style({ flexShrink: 0, padding: '1em 1.25em', borderBottom: `1px solid ${vars.color.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75em' });
export const title = style({ margin: '0 0 0.25em', fontSize: '1.2em', lineHeight: 1.3, fontWeight: 700 });
export const hint = style({ margin: 0, color: vars.color.mutedForeground, fontSize: '0.875em', lineHeight: 1.6, overflowWrap: 'anywhere' });
export const body = style({ padding: '1.25em', overflowY: 'auto', minHeight: 0 });
export const fields = style({ minWidth: 0, border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '1.25em' });
export const section = style({ display: 'flex', flexDirection: 'column', gap: '0.75em', minWidth: 0 });
export const heading = style({ margin: 0, fontSize: '1em', lineHeight: 1.4, fontWeight: 650 });
export const field = style({ display: 'flex', flexDirection: 'column', gap: '0.375em', minWidth: 0 });
export const label = style({ fontSize: '0.875em', fontWeight: 600, lineHeight: 1.4 });
export const input = style({
    width: '100%', height: CONTROL, boxSizing: 'border-box', minWidth: 0, padding: '0 0.75em',
    border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm,
    background: vars.color.inset, color: vars.color.foreground, fontSize: '1em', fontFamily: 'inherit',
    selectors: {
        '&::placeholder': { color: vars.color.mutedForeground, opacity: 0.8 },
        '&:focus': { outline: 'none' },
        '&:focus-visible': { borderColor: vars.color.accent, boxShadow: `0 0 0 3px ${vars.color.accentDim}` },
        '&:disabled': { opacity: 0.55 },
    },
});
export const row = style({ display: 'flex', gap: '0.5em', alignItems: 'center', flexWrap: 'wrap' });
export const button = style({
    height: CONTROL, boxSizing: 'border-box', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm,
    padding: '0 0.875em', background: vars.color.panel, color: vars.color.foreground, cursor: 'pointer',
    fontSize: '0.9375em', fontWeight: 500, lineHeight: 1, whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4em', flexShrink: 0,
    selectors: {
        '&:hover:not(:disabled)': { borderColor: vars.color.mutedForeground },
        '&:disabled': { opacity: 0.45, cursor: 'default' },
        '&:focus-visible': focusRing,
    },
});
// 主要動作沿用全 App 的「淡底＋強調色字框」語彙
export const primary = style([button, {
    background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent, fontWeight: 600,
    selectors: { '&:hover:not(:disabled)': { borderColor: vars.color.accent, boxShadow: `inset 0 0 0 1px ${vars.color.accent}` } },
}]);
export const selected = style([button, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent }]);
export const iconButton = style([button, { width: CONTROL, padding: 0 }]);
export const warning = style({ margin: 0, lineHeight: 1.6, color: vars.color.danger });
export const notice = style({ padding: '0.625em 0.75em', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.panel, lineHeight: 1.6, overflowWrap: 'anywhere' });
export const footer = style({
    flexShrink: 0, padding: '0.875em 1.25em', borderTop: `1px solid ${vars.color.border}`,
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.75em 1em', background: vars.color.panelRaised,
    borderRadius: `0 0 ${vars.radius.md} ${vars.radius.md}`,
});
export const footerHint = style([hint, { flex: '1 1 18em' }]);
export const actions = style([row, { justifyContent: 'flex-end' }]);

// 其他設定以可收合區塊呈現；標題與「帳號」同級，自繪箭頭取代瀏覽器預設三角形
export const details = style({ borderTop: `1px solid ${vars.color.border}`, paddingTop: '1em' });
globalStyle(`${details} > summary`, {
    cursor: 'pointer', fontWeight: 650, lineHeight: 1.4, listStyle: 'none',
    display: 'flex', alignItems: 'center', gap: '0.625em', borderRadius: vars.radius.sm,
});
globalStyle(`${details} > summary::-webkit-details-marker`, { display: 'none' });
globalStyle(`${details} > summary::before`, {
    content: '""', width: '0.375em', height: '0.375em', flexShrink: 0, margin: '0 0.125em',
    borderRight: `1.5px solid ${vars.color.mutedForeground}`, borderBottom: `1.5px solid ${vars.color.mutedForeground}`,
    transform: 'rotate(-45deg)', transition: 'transform .12s',
});
globalStyle(`${details}[open] > summary::before`, { transform: 'rotate(45deg)' });
globalStyle(`${details} > summary:focus-visible`, focusRing);
globalStyle(`${details}[open] > summary`, { marginBottom: '0.75em' });
globalStyle(`${details} > :not(summary) + :not(summary)`, { marginTop: '0.625em' });

// ── 帳號列表與編輯（#193）──────────────────────────────────────────
// 模擬／正式徽章沿用頁首語彙：模擬琥珀框、正式紅底。正式一律用 danger
// 紅，不跟漲跌配色走，國際配色下也不會變成綠色。
export const credentials = style({ display: 'flex', flexDirection: 'column', gap: '1em', minWidth: 0 });
export const sectionHead = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75em', minHeight: CONTROL });
export const sectionTitle = style({ display: 'flex', alignItems: 'baseline', gap: '0.5em', minWidth: 0, margin: 0, fontSize: '1em' });
export const count = style({ color: vars.color.mutedForeground, fontWeight: 500, fontSize: '0.875em' });

const badgeBase = {
    display: 'inline-flex', alignItems: 'center', height: '1.375em', boxSizing: 'border-box', padding: '0 0.5em',
    fontSize: '0.75em', fontWeight: 650, letterSpacing: '0.04em', lineHeight: 1,
    borderRadius: vars.radius.sm, whiteSpace: 'nowrap', flexShrink: 0,
} as const;
export const simBadge = style({ ...badgeBase, color: vars.color.amber, border: '1px solid', ...mixed({ borderColor: ['rgba(224, 164, 60, 0.45)', tint(vars.color.amber, 50)], background: ['rgba(224, 164, 60, 0.08)', tint(vars.color.amber, 10)] }) });
export const prodBadge = style({ ...badgeBase, color: '#fff', background: vars.color.danger, border: `1px solid ${vars.color.danger}` });

export const profileList = style({
    listStyle: 'none', margin: 0, padding: 0, containerType: 'inline-size',
    border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, overflow: 'hidden', background: vars.color.panel,
});
export const profileItem = style({ selectors: { '& + &': { borderTop: `1px solid ${vars.color.border}` } } });
export const profileActive = style({ background: vars.color.accentDim, boxShadow: `inset 3px 0 0 ${vars.color.accent}` });
export const profileProblem = style({ boxShadow: `inset 3px 0 0 ${vars.color.danger}` });
// 狀態圖示欄＋間距；確認列以同樣的左內距對齊名稱
const ROW_PAD_X = '0.875em';
const MARK_COL = '1.125em';
const COL_GAP = '0.75em';
const NARROW_ROW = '(max-width: 400px)';
export const profileRow = style({
    display: 'grid', gridTemplateColumns: `${MARK_COL} minmax(0, 1fr) auto`, gridTemplateAreas: '"mark main actions"',
    alignItems: 'center', columnGap: COL_GAP, rowGap: '0.625em', padding: `0.75em ${ROW_PAD_X}`,
    '@container': { [NARROW_ROW]: { gridTemplateColumns: `${MARK_COL} minmax(0, 1fr)`, gridTemplateAreas: '"mark main" ". actions"' } },
});
export const profileMark = style({ gridArea: 'mark', alignSelf: 'start', height: '1.375em', display: 'flex', alignItems: 'center', color: vars.color.borderBright });
export const profileMarkOn = style([profileMark, { color: vars.color.accent }]);
export const profileMain = style({ gridArea: 'main', display: 'flex', flexDirection: 'column', gap: '0.25em', minWidth: 0 });
export const profileName = style({ display: 'flex', alignItems: 'center', gap: '0.5em', minWidth: 0, height: '1.375em' });
export const profileNameText = style({ fontWeight: 650, lineHeight: 1.375, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 });
export const activeTag = style({ color: vars.color.accent, fontSize: '0.8125em', fontWeight: 600, whiteSpace: 'nowrap' });
export const profileMeta = style({ display: 'flex', alignItems: 'center', columnGap: '0.5em', rowGap: '0.125em', flexWrap: 'wrap', color: vars.color.mutedForeground, fontSize: '0.8125em', lineHeight: 1.5 });
export const metaItem = style({ display: 'inline-flex', alignItems: 'center', gap: '0.3em', whiteSpace: 'nowrap' });
export const metaDot = style({ width: 3, height: 3, borderRadius: '50%', background: vars.color.mutedForeground, opacity: 0.6, flexShrink: 0 });
export const metaOk = style([metaItem, { color: vars.color.success }]);
export const metaWarn = style([metaItem, { color: vars.color.amber }]);
export const metaDanger = style([metaItem, { color: vars.color.danger, fontWeight: 600 }]);
export const mono = style({ fontFamily: vars.font.mono, letterSpacing: '0.04em' });
export const profileActions = style({
    gridArea: 'actions', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.375em',
    '@container': { [NARROW_ROW]: { justifyContent: 'flex-start' } },
});
export const smallButton = style([button, { height: CONTROL_SM, padding: '0 0.75em', fontSize: '0.875em' }]);
export const smallIconButton = style([button, {
    height: CONTROL_SM, width: CONTROL_SM, padding: 0, color: vars.color.mutedForeground,
    selectors: { '&:hover:not(:disabled)': { color: vars.color.foreground } },
}]);
export const smallDangerIcon = style([smallIconButton, { selectors: { '&:hover:not(:disabled)': { color: vars.color.danger, borderColor: vars.color.danger } } }]);

// 二次確認：列內展開，文字與上方名稱左緣對齊
export const confirmStrip = style({
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.625em 0.75em',
    padding: `0.625em ${ROW_PAD_X} 0.75em calc(${ROW_PAD_X} + ${MARK_COL} + ${COL_GAP})`,
    borderTop: `1px dashed ${vars.color.borderBright}`,
});
export const confirmText = style({ flex: '1 1 16em', margin: 0, fontSize: '0.875em', lineHeight: 1.6, minWidth: 0 });
export const confirmButtons = style({ display: 'flex', gap: '0.375em', marginLeft: 'auto' });
export const confirmDanger = style([smallButton, {
    background: vars.color.danger, borderColor: vars.color.danger, color: '#fff', fontWeight: 600,
    selectors: { '&:hover:not(:disabled)': { borderColor: vars.color.danger, filter: 'brightness(1.08)' } },
}]);
export const confirmPrimary = style([smallButton, {
    background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent, fontWeight: 600,
    selectors: { '&:hover:not(:disabled)': { borderColor: vars.color.accent, boxShadow: `inset 0 0 0 1px ${vars.color.accent}` } },
}]);
export const inlineBadge = style({ display: 'inline-flex', verticalAlign: '-0.1em', margin: '0 0.25em' });

// 空狀態
export const empty = style({
    display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.375em',
    padding: '1.75em 1.25em', border: `1px dashed ${vars.color.borderBright}`, borderRadius: vars.radius.sm,
});
export const emptyIcon = style({
    width: '2.5em', height: '2.5em', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: vars.color.accentDim, color: vars.color.accent, marginBottom: '0.375em',
});
export const emptyTitle = style({ margin: 0, fontWeight: 650 });
export const emptyAction = style({ marginTop: '0.625em' });

// 提示條：錯誤（紅）、注意（琥珀）
const calloutBase = style({
    display: 'grid', gridTemplateColumns: '1.125em minmax(0, 1fr)', columnGap: '0.625em', alignItems: 'start',
    padding: '0.625em 0.75em', borderRadius: vars.radius.sm, border: '1px solid', fontSize: '0.875em', lineHeight: 1.6,
});
export const calloutIcon = style({ height: '1.6em', display: 'flex', alignItems: 'center' });
export const calloutBody = style({ display: 'flex', flexDirection: 'column', gap: '0.25em', minWidth: 0, overflowWrap: 'anywhere', color: vars.color.foreground });
export const calloutTitle = style({ margin: 0, fontWeight: 650 });
export const calloutText = style({ margin: 0 });
export const calloutActions = style({ display: 'flex', gap: '0.375em', flexWrap: 'wrap', marginTop: '0.375em' });
export const calloutDanger = style([calloutBase, { ...mixed({ borderColor: ['rgba(242, 54, 69, 0.45)', tint(vars.color.danger, 40)], background: ['rgba(242, 54, 69, 0.08)', tint(vars.color.danger, 8)] }), color: vars.color.danger }]);
export const calloutWarn = style([calloutBase, { ...mixed({ borderColor: ['rgba(224, 164, 60, 0.45)', tint(vars.color.amber, 45)], background: ['rgba(224, 164, 60, 0.08)', tint(vars.color.amber, 9)] }), color: vars.color.amber }]);
const spin = keyframes({ to: { transform: 'rotate(360deg)' } });
export const status = style({
    display: 'flex', alignItems: 'center', gap: '0.4em', margin: 0, fontSize: '0.875em', lineHeight: 1.6, color: vars.color.mutedForeground,
    selectors: { '&:empty': { display: 'none' } },
});
export const statusOk = style({ color: vars.color.success, flexShrink: 0 });
export const spinner = style({ flexShrink: 0, animation: `${spin} 0.9s linear infinite` });

// ── 編輯表單 ────────────────────────────────────────────────────────
export const editorHead = style({ display: 'flex', alignItems: 'center', gap: '0.625em', minHeight: CONTROL, minWidth: 0 });
export const editorTitle = style([heading, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }]);
export const card = style({
    display: 'flex', flexDirection: 'column', gap: '0.875em', minWidth: 0,
    padding: '1em', border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm, background: vars.color.panel,
});
export const cardHead = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.25em 0.75em', flexWrap: 'wrap' });
export const cardTitle = style({ margin: 0, fontSize: '0.875em', lineHeight: 1.4, fontWeight: 650, color: vars.color.mutedForeground, display: 'flex', alignItems: 'center', gap: '0.4em' });
export const cardAside = style({ fontSize: '0.8125em', lineHeight: 1.4, color: vars.color.mutedForeground });
export const cardAsideWarn = style([cardAside, { color: vars.color.amber, fontWeight: 600 }]);
export const segmented = style({
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, padding: 3, height: CONTROL, boxSizing: 'border-box',
    border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.inset, width: '100%', maxWidth: '22em',
});
export const segment = style({
    border: '1px solid transparent', borderRadius: `calc(${vars.radius.sm} - 1px)`, padding: '0 0.75em',
    background: 'transparent', color: vars.color.mutedForeground, cursor: 'pointer', fontSize: '0.9375em', fontWeight: 500,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4em', whiteSpace: 'nowrap',
    selectors: {
        '&:hover:not(:disabled)': { color: vars.color.foreground },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
        '&:disabled': { cursor: 'default', opacity: 0.6 },
    },
});
export const segmentSim = style([segment, { color: vars.color.amber, ...mixed({ borderColor: ['rgba(224, 164, 60, 0.5)', tint(vars.color.amber, 55)], background: ['rgba(224, 164, 60, 0.1)', tint(vars.color.amber, 12)] }), fontWeight: 650, selectors: { '&:hover:not(:disabled)': { color: vars.color.amber } } }]);
export const segmentProd = style([segment, { color: '#fff', background: vars.color.danger, borderColor: vars.color.danger, fontWeight: 650, selectors: { '&:hover:not(:disabled)': { color: '#fff' } } }]);
export const fieldNote = style({ margin: 0, fontSize: '0.8125em', lineHeight: 1.5, color: vars.color.mutedForeground });
export const fieldNoteDanger = style([fieldNote, { color: vars.color.danger, display: 'flex', alignItems: 'center', gap: '0.375em', fontWeight: 600 }]);
export const importBox = style({
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5em 0.75em',
    padding: '0.625em 0.75em', border: `1px dashed ${vars.color.borderBright}`, borderRadius: vars.radius.sm,
});
export const importText = style({ flex: '1 1 14em', margin: 0, fontSize: '0.8125em', lineHeight: 1.5, color: vars.color.mutedForeground, minWidth: 0 });
export const importButtons = style({ display: 'flex', gap: '0.375em', flexWrap: 'wrap' });
export const importChoices = style({ display: 'flex', gap: '0.375em', flexWrap: 'wrap', flexBasis: '100%' });
export const fileRow = style({ display: 'flex', alignItems: 'center', gap: '0.5em', minWidth: 0 });
export const fileName = style({
    flex: 1, minWidth: 0, height: CONTROL, boxSizing: 'border-box', padding: '0 0.75em',
    display: 'flex', alignItems: 'center', gap: '0.5em',
    border: `1px dashed ${vars.color.borderBright}`, borderRadius: vars.radius.sm, color: vars.color.mutedForeground, background: vars.color.inset,
});
export const fileNameSet = style([fileName, { borderStyle: 'solid', color: vars.color.foreground }]);
export const fileNameText = style({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 });
export const linkButton = style({
    border: 0, padding: 0, background: 'transparent', color: vars.color.accent, cursor: 'pointer', fontSize: '1em',
    display: 'inline-flex', alignItems: 'center', gap: '0.25em',
    selectors: { '&:disabled': { opacity: .5, cursor: 'default' }, '&:focus-visible': focusRing },
});
export const editorFooter = style({ display: 'flex', flexDirection: 'column', gap: '0.75em' });
export const editorActions = style({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5em', flexWrap: 'wrap' });
export const actionsSpacer = style({ flex: 1 });
// 存檔前的確認：與列表的確認列同一個語彙
export const saveConfirm = style({
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.625em 0.75em',
    padding: '0.625em 0.75em', border: `1px dashed ${vars.color.borderBright}`, borderRadius: vars.radius.sm,
});

// 首次設定：列表下方的啟動列
export const startBar = style({
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.625em 0.75em',
    padding: '0.75em 0.875em', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.inset,
});
export const startText = style({ flex: '1 1 14em', margin: 0, fontSize: '0.875em', lineHeight: 1.6, minWidth: 0, overflowWrap: 'anywhere' });
