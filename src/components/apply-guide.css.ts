// src/components/apply-guide.css.ts — 首次設定的「申請 API Key」導覽。
//
// 2026-11 無障礙改版：對象包含長輩，所以字級、對比、點擊範圍都比一般面板大。
// - 字級：卡片 max(17px, 0.96rem)，跟著 App 的文字大小（標準 1.15 → 17.7px，
//   大字 1.3 → 20px）；內文最小 0.84em（≥ 14.8px）。
// - 顏色：導覽自己的語意色（g.*），深色／淺色各一組，文字全部 ≥ 4.5:1、外框與焦點框 ≥ 3:1。
//   強調色是 Shioaji logo 的藏青（#15213B／#AEB9CF／米白 #F6F3EC；2026-11-25 owner 選定），
//   不用紅色：台股紅＝漲、錯誤是朱紅。
//   淺色以 html 上的 light theme class 切換；自訂配色沿用其底色那組。
// - 點擊範圍：所有按鈕 ≥ 44px；焦點框 3px。
// - 動畫：只有同步燈號與載入圈，prefers-reduced-motion 時停用。

import { createVar, globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { themeClasses } from '../theme.css';

// ── 導覽語意色 ────────────────────────────────────────────────────────
export const g = {
    page: createVar(), surface: createVar(), sunken: createVar(),
    text: createVar(), text2: createVar(),
    divider: createVar(), control: createVar(),
    accent: createVar(), accentText: createVar(), onAccent: createVar(), accentSoft: createVar(),
    success: createVar(), successSoft: createVar(),
    warn: createVar(), warnSoft: createVar(),
    danger: createVar(), dangerSoft: createVar(),
    chip: createVar(), shadow: createVar(),
    // 頁首鑰匙圖示（品牌記號）；預設同 accentText
    brand: createVar(),
};

const darkTokens = {
    [g.page]: '#000000', [g.surface]: '#0e1117', [g.sunken]: '#080a0e',
    [g.text]: '#eef1f6', [g.text2]: '#b9c1cf',
    [g.divider]: '#262d3b', [g.control]: '#5a6478',
    [g.accent]: '#aebbd6', [g.accentText]: '#b8c4dc', [g.onAccent]: '#15213b', [g.accentSoft]: 'rgba(174, 187, 214, 0.14)',
    [g.success]: '#3ccf9f', [g.successSoft]: 'rgba(60, 207, 159, 0.12)',
    [g.warn]: '#f2bf5e', [g.warnSoft]: 'rgba(242, 191, 94, 0.11)',
    [g.danger]: '#ff8266', [g.dangerSoft]: 'rgba(255, 130, 102, 0.12)',
    [g.chip]: '#1c2232', [g.shadow]: '0 24px 64px rgba(0, 0, 0, 0.5)', [g.brand]: '#b8c4dc',
};
const lightTokens = {
    [g.page]: '#eef0f3', [g.surface]: '#ffffff', [g.sunken]: '#f4f6f9',
    [g.text]: '#111827', [g.text2]: '#3d475a',
    [g.divider]: '#d5dbe4', [g.control]: '#8792a6',
    [g.accent]: '#22335c', [g.accentText]: '#2c3f6e', [g.onAccent]: '#f6f3ec', [g.accentSoft]: 'rgba(34, 51, 92, 0.08)',
    [g.success]: '#07704d', [g.successSoft]: 'rgba(7, 112, 77, 0.08)',
    [g.warn]: '#8a5600', [g.warnSoft]: 'rgba(196, 128, 0, 0.10)',
    [g.danger]: '#b3290f', [g.dangerSoft]: 'rgba(179, 41, 15, 0.07)',
    [g.chip]: '#eef1f7', [g.shadow]: '0 18px 48px rgba(17, 24, 39, 0.14)', [g.brand]: '#22335c',
};

/** 套用導覽語意色的根元素（首次設定整頁、AI 助理浮鈕都掛這個）。 */
export const tokens = style({ vars: darkTokens });
for (const key of ['light-tw', 'light-intl']) {
    const cls = themeClasses[key];
    if (cls) globalStyle(`.${cls} ${tokens}`, { vars: lightTokens });
}

const ring = { outline: `3px solid ${g.accent}`, outlineOffset: 2 } as const;
const noMotion = '(prefers-reduced-motion: reduce)';
/** 導覽卡的基準字級；em 都以這個為準。 */
export const GUIDE_FONT = 'max(17px, 0.96rem)';
/** 申請視窗蓋住主視窗時導覽卡寬度。原生端 apply_window.rs placement() 的 guide 要從 460 改成 540（508＋左右邊距）。 */
export const DOCKED_WIDTH = '508px';

// ── 卡片 ──────────────────────────────────────────────────────────────
export const card = style({
    position: 'relative',
    display: 'flex', flexDirection: 'column', minHeight: 0,
    width: 'min(34rem, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 2rem)', boxSizing: 'border-box',
    fontSize: GUIDE_FONT, lineHeight: 1.6, color: g.text,
    background: g.surface, border: `1px solid ${g.divider}`, borderRadius: 14,
    boxShadow: g.shadow, overflow: 'hidden',
});
export const cardDocked = style([card, { width: `min(${DOCKED_WIDTH}, calc(100vw - 2rem))`, maxHeight: 'calc(100vh - 1.5rem)' }]);

export const header = style({
    display: 'flex', alignItems: 'center', gap: '0.5em', flexShrink: 0, flexWrap: 'wrap',
    padding: '0.625em 0.75em 0.625em 1.25em', borderBottom: `1px solid ${g.divider}`,
});
export const headerTitle = style({ display: 'flex', alignItems: 'center', gap: '0.5em', minWidth: 0, flex: '1 1 auto' });
export const headerIcon = style({ color: g.brand, display: 'flex' });
export const brand = style({ margin: 0, fontWeight: 700, fontSize: '1em', whiteSpace: 'nowrap' });
export const brandSub = style({ color: g.text2, fontSize: '0.88em', whiteSpace: 'nowrap' });

// 顯示設定：大字、深淺色。文字＋圖示，不只靠圖示
export const displayControls = style({ display: 'flex', gap: '0.375em', flexShrink: 0 });
export const toggle = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.35em', minHeight: 44, padding: '0 0.75em',
    border: `1px solid ${g.control}`, borderRadius: 999, background: 'transparent', color: g.text,
    fontFamily: 'inherit', fontSize: '0.84em', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    selectors: {
        '&:hover': { background: g.accentSoft },
        '&[aria-pressed="true"]': { background: g.accentSoft, borderColor: g.accent, color: g.accentText },
        '&:focus-visible': ring,
    },
});

// 同步官網：燈號＋文字
export const syncBanner = style({
    display: 'flex', alignItems: 'center', gap: '0.5em', flexShrink: 0,
    padding: '0.5em 1.25em', background: g.successSoft, borderBottom: `1px solid ${g.divider}`,
    color: g.text, fontSize: '0.84em',
});
const blink = keyframes({ '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } });
export const syncDot = style({
    width: 9, height: 9, borderRadius: '50%', background: g.success, flexShrink: 0,
    animation: `${blink} 2.4s ease-in-out infinite`,
    '@media': { [noMotion]: { animation: 'none' } },
});

// ── 進度 ──────────────────────────────────────────────────────────────
// 圓點＋步驟名稱；完成打勾、目前步驟加粗與外框，不只靠顏色區分
export const progressWrap = style({ flexShrink: 0, padding: '0.875em 1em 0.25em' });
export const progressCount = style({ margin: '0 0.25em 0.5em', fontSize: '0.9em', fontWeight: 700, color: g.text });
export const progressCountMuted = style({ fontWeight: 500, color: g.text2 });
export const progress = style({
    display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 0,
    margin: 0, padding: 0, listStyle: 'none',
});
export const progressItem = style({ position: 'relative', minWidth: 0 });
const stepBase = style({
    position: 'relative', width: '100%', minHeight: 64,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3em',
    border: 0, background: 'transparent', padding: '0.125em 0', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: '0.84em', lineHeight: 1.3, color: g.text2, textAlign: 'center',
    borderRadius: 8,
    selectors: {
        '&:hover:not(:disabled)': { background: g.accentSoft },
        '&:focus-visible': ring,
        '&:disabled': { cursor: 'default' },
    },
});
export const step = styleVariants({
    todo: [stepBase],
    current: [stepBase, { color: g.text, fontWeight: 750 }],
    done: [stepBase, { color: g.text }],
});
// 連接線：從上一個圓點到這個圓點，畫在圓點後面
const lineBase = style({
    position: 'absolute', top: 'calc(0.125em + 1.06em)', left: '-50%', right: '50%', height: 3, zIndex: 0, borderRadius: 2,
});
export const stepLine = styleVariants({
    todo: [lineBase, { background: g.divider }],
    done: [lineBase, { background: g.accent }],
});
const dotBase = style({
    position: 'relative', zIndex: 1,
    width: '2.12em', height: '2.12em', borderRadius: '50%', boxSizing: 'border-box',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: '1em', fontVariantNumeric: 'tabular-nums',
    background: g.surface, border: `2px solid ${g.control}`, color: g.text2,
});
export const dot = styleVariants({
    todo: [dotBase],
    current: [dotBase, { borderColor: g.accent, borderWidth: 3, color: g.accentText, boxShadow: `0 0 0 4px ${g.accentSoft}` }],
    done: [dotBase, { background: g.accent, borderColor: g.accent, color: g.onAccent }],
});
export const stepLabel = style({ maxWidth: '100%', overflowWrap: 'anywhere', padding: '0 0.15em' });

// ── 內容 ──────────────────────────────────────────────────────────────
export const body = style({
    display: 'flex', flexDirection: 'column', gap: '1em', minHeight: 0, overflowY: 'auto',
    padding: '1em 1.25em 1.5em',
});
// 浮動 AI 鈕停在卡片右下時，內容底部留空避免被蓋住
export const bodyWithFab = style([body, { paddingBottom: '5em' }]);
export const title = style({ margin: 0, fontSize: '1.42em', lineHeight: 1.35, fontWeight: 750, letterSpacing: '0.01em' });
export const lead = style({ margin: 0, fontSize: '1em', lineHeight: 1.75, color: g.text });
export const secondary = style({ margin: 0, fontSize: '0.9em', lineHeight: 1.65, color: g.text2 });

// 介面上的按鈕／欄位名稱：框起來，使用者一眼知道要按哪個
export const uiChip = style({
    display: 'inline-block', padding: '0 0.4em', margin: '0 0.15em', borderRadius: 6,
    border: `1px solid ${g.control}`, background: g.chip, color: g.text,
    fontWeight: 700, lineHeight: 1.45,
});

export const srOnly = style({ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' });

export const hero = style({ display: 'flex', flexDirection: 'column', gap: '0.75em', alignItems: 'flex-start' });
export const heroIcon = style({
    width: '3em', height: '3em', borderRadius: '0.9em', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: g.accentSoft, color: g.accentText,
});
export const heroMeta = style({ display: 'flex', flexWrap: 'wrap', gap: '0.5em' });
export const metaPill = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.35em', padding: '0.2em 0.7em', borderRadius: 999,
    background: g.sunken, border: `1px solid ${g.divider}`, fontSize: '0.84em', fontWeight: 600, color: g.text,
});

// 清單：每一點有編號，照順序做
export const list = style({ display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none', gap: '0.625em' });
export const item = style({
    display: 'grid', gridTemplateColumns: '2em minmax(0, 1fr)', columnGap: '0.75em', alignItems: 'start',
    padding: '0.875em 1em', borderRadius: 12, border: `1px solid ${g.divider}`, background: g.sunken,
});
export const itemCaution = style([item, { borderColor: g.warn, borderLeftWidth: 5, paddingLeft: 'calc(1em - 4px)' }]);
export const itemNumber = style({
    width: '2em', height: '2em', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
    fontWeight: 700, fontVariantNumeric: 'tabular-nums', background: g.accentSoft, color: g.accentText, border: `1.5px solid ${g.accent}`,
});
export const itemIcon = style([itemNumber, { border: 0 }]);
export const itemText = style({ display: 'flex', flexDirection: 'column', gap: '0.3em', minWidth: 0 });
export const itemTitle = style({ margin: 0, fontWeight: 700, lineHeight: 1.5, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25em 0.5em' });
export const itemBody = style({ margin: 0, color: g.text2, lineHeight: 1.7, fontSize: '0.92em' });
export const groupTitle = style({ margin: '0.5em 0 0', fontSize: '0.92em', fontWeight: 750, color: g.text });

// 建議／注意：圖示＋文字標籤
const tagBase = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.25em',
    fontSize: '0.8em', fontWeight: 700, padding: '0.05em 0.55em', borderRadius: 999, border: '1.5px solid', lineHeight: 1.6,
});
export const tag = styleVariants({
    recommend: [tagBase, { color: g.success, borderColor: g.success, background: g.successSoft }],
    caution: [tagBase, { color: g.warn, borderColor: g.warn, background: g.warnSoft }],
});

// 在網頁上標示
export const locate = style({
    justifySelf: 'start', alignSelf: 'flex-start', marginTop: '0.4em',
    display: 'inline-flex', alignItems: 'center', gap: '0.4em', minHeight: 44, padding: '0 0.9em',
    border: `1.5px solid ${g.accent}`, borderRadius: 10, background: g.surface,
    color: g.accentText, fontSize: '0.88em', fontWeight: 650, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
    selectors: {
        '&:hover:not(:disabled)': { background: g.accentSoft },
        '&:focus-visible': ring,
        '&:disabled': { borderColor: g.control, color: g.text2, cursor: 'default', borderStyle: 'dashed' },
    },
});

// ── 按鈕 ──────────────────────────────────────────────────────────────
export const actions = style({ display: 'flex', alignItems: 'stretch', flexDirection: 'column', gap: '0.625em' });
const buttonBase = style({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5em',
    minHeight: 48, padding: '0 1.1em', borderRadius: 10, cursor: 'pointer', boxSizing: 'border-box',
    fontFamily: 'inherit', fontSize: '0.95em', fontWeight: 650, whiteSpace: 'nowrap',
    selectors: { '&:focus-visible': ring, '&:disabled': { opacity: 0.5, cursor: 'default' } },
});
export const primary = style([buttonBase, {
    minHeight: 64, fontSize: '1.42em', fontWeight: 750,
    border: `1px solid ${g.accent}`, background: g.accent, color: g.onAccent,
    selectors: { '&:hover:not(:disabled)': { filter: 'brightness(1.08)' } },
}]);
export const secondaryButton = style([buttonBase, {
    border: `1.5px solid ${g.control}`, background: g.surface, color: g.text,
    selectors: { '&:hover:not(:disabled)': { background: g.accentSoft, borderColor: g.accent } },
}]);
export const textButton = style([buttonBase, {
    minHeight: 44, padding: '0 0.5em', border: 0, background: 'transparent', color: g.accentText,
    fontSize: '0.92em', textDecoration: 'underline', textUnderlineOffset: '0.2em', whiteSpace: 'normal', textAlign: 'left',
    selectors: { '&:hover:not(:disabled)': { background: g.accentSoft } },
}]);
// 「同時把 .env 檔存到『下載』資料夾」：整列可點的勾選框
export const option = style({
    display: 'grid', gridTemplateColumns: '1.5em minmax(0, 1fr)', columnGap: '0.75em', alignItems: 'start',
    padding: '0.875em 1em', borderRadius: 12, border: `1px solid ${g.divider}`, background: g.surface, cursor: 'pointer',
});
export const optionBox = style({
    width: '1.25em', height: '1.25em', margin: '0.2em 0 0', accentColor: g.accent, cursor: 'pointer',
    selectors: { '&:focus-visible': ring },
});
export const optionText = style({ display: 'flex', flexDirection: 'column', gap: '0.25em', minWidth: 0 });
export const optionTitle = style({ fontWeight: 700, lineHeight: 1.5 });
export const optionHint = style({ color: g.text2, fontSize: '0.92em', lineHeight: 1.65 });
export const optionHintWarn = style([optionHint, { color: g.text, fontWeight: 600 }]);

export const quietLinks = style({ display: 'flex', flexWrap: 'wrap', gap: '0.25em 0.75em', marginLeft: '-0.5em' });

export const footer = style({
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.625em', flexShrink: 0,
    padding: '0.75em 1.25em', borderTop: `1px solid ${g.divider}`, background: g.sunken,
});

const spinFrames = keyframes({ to: { transform: 'rotate(360deg)' } });
export const spinner = style({ flexShrink: 0, animation: `${spinFrames} 0.9s linear infinite`, '@media': { [noMotion]: { animation: 'none' } } });

// ── 提示：錯誤／注意／成功 ─────────────────────────────────────────────
// 左側粗色條＋圖示＋「錯誤：」等文字前綴；內文用一般文字色確保可讀
const calloutBase = style({
    display: 'grid', gridTemplateColumns: '1.5em minmax(0, 1fr)', columnGap: '0.75em', alignItems: 'start',
    padding: '0.875em 1em 0.875em calc(1em - 4px)', borderRadius: 10, border: '1px solid', borderLeftWidth: 5,
    color: g.text, lineHeight: 1.65,
});
export const callout = styleVariants({
    danger: [calloutBase, { borderColor: g.danger, background: g.dangerSoft }],
    warn: [calloutBase, { borderColor: g.warn, background: g.warnSoft }],
    success: [calloutBase, { borderColor: g.success, background: g.successSoft }],
});
const calloutIconBase = style({ display: 'flex', height: '1.65em', alignItems: 'center' });
export const calloutIcon = styleVariants({
    danger: [calloutIconBase, { color: g.danger }],
    warn: [calloutIconBase, { color: g.warn }],
    success: [calloutIconBase, { color: g.success }],
});
export const calloutBody = style({ display: 'flex', flexDirection: 'column', gap: '0.3em', minWidth: 0, overflowWrap: 'anywhere' });
export const calloutTitle = style({ margin: 0, fontWeight: 750 });
export const calloutText = style({ margin: 0, fontSize: '0.95em' });
export const calloutActions = style({ display: 'flex', gap: '0.5em', flexWrap: 'wrap', marginTop: '0.5em' });

// ── 完成 ──────────────────────────────────────────────────────────────
export const doneHero = style({ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.5em', padding: '0.5em 0 0.25em' });
export const doneIcon = style({
    width: '3.5em', height: '3.5em', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: g.success, background: g.successSoft, border: `2px solid ${g.success}`,
});
export const doneBox = style({
    display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '0.375em 1em', alignItems: 'baseline',
    padding: '0.875em 1em', borderRadius: 12, border: `1px solid ${g.divider}`, background: g.sunken, margin: 0,
});
export const doneTerm = style({ color: g.text2, fontSize: '0.9em' });
export const doneValue = style({ margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5em', flexWrap: 'wrap', minWidth: 0 });
export const mono = style({ fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace", fontWeight: 600 });
export const simBadge = style({
    fontSize: '0.8em', fontWeight: 700, padding: '0.05em 0.6em', borderRadius: 999,
    color: g.accentText, background: g.accentSoft, border: `1.5px solid ${g.accent}`,
});

// 之後要正式交易：預設收合，降低第一次的資訊量
export const details = style({ borderRadius: 12, border: `1px solid ${g.divider}`, background: g.surface });
export const summary = style({
    display: 'flex', alignItems: 'center', gap: '0.5em', minHeight: 48, padding: '0 1em', cursor: 'pointer',
    fontWeight: 700, listStyle: 'none', borderRadius: 12,
    selectors: { '&::-webkit-details-marker': { display: 'none' }, '&:focus-visible': ring },
});
export const summaryChevron = style({
    marginLeft: 'auto', display: 'flex', color: g.text2, transition: 'transform 150ms',
    selectors: { [`${details}[open] &`]: { transform: 'rotate(180deg)' } },
    '@media': { [noMotion]: { transition: 'none' } },
});
export const detailsBody = style({ padding: '0 1em 1em', display: 'flex', flexDirection: 'column', gap: '0.625em' });
export const linkRow = style({ display: 'flex', flexWrap: 'wrap', gap: '0 0.75em', marginLeft: '-0.5em' });

// ── 簽署 API 約定書 ─────────────────────────────────────────────────────
export const subTitle = style({ margin: 0, fontSize: '1.05em', fontWeight: 750, display: 'flex', alignItems: 'center', gap: '0.4em' });
export const marketSet = style({ margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: '0.5em', minWidth: 0 });
export const marketLegend = style({ padding: 0, marginBottom: '0.5em', fontWeight: 700 });
export const marketOptions = style({ display: 'flex', flexWrap: 'wrap', gap: '0.5em' });
export const marketOption = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.5em', minHeight: 48, padding: '0 0.9em',
    borderRadius: 10, border: `1.5px solid ${g.control}`, background: g.surface, cursor: 'pointer',
    selectors: { '&:hover': { background: g.accentSoft }, '&:focus-within': ring },
});
export const marketOptionOn = style([marketOption, { borderColor: g.accent, background: g.accentSoft }]);
export const signList = style({ display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none', gap: '0.625em' });
export const signRow = style({
    display: 'flex', flexDirection: 'column', gap: '0.625em',
    padding: '0.875em 1em', borderRadius: 12, border: `1px solid ${g.divider}`, background: g.sunken,
    selectors: { '&[aria-current="page"]': { borderColor: g.accent, borderWidth: 2, padding: 'calc(0.875em - 1px) calc(1em - 1px)' } },
});
export const signHead = style({ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75em' });
// 狀態：圖示＋文字＋外框，不只靠顏色
const signStatusBase = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.3em', flexShrink: 0, whiteSpace: 'nowrap',
    fontSize: '0.88em', fontWeight: 700, padding: '0.15em 0.65em', borderRadius: 999, border: '1.5px solid', lineHeight: 1.6,
});
export const signStatus = styleVariants({
    unknown: [signStatusBase, { color: g.text2, borderColor: g.control, background: g.surface }],
    signed: [signStatusBase, { color: g.success, borderColor: g.success, background: g.successSoft }],
    unsigned: [signStatusBase, { color: g.warn, borderColor: g.warn, background: g.warnSoft }],
    pending: [signStatusBase, { color: g.accentText, borderColor: g.accent, background: g.accentSoft }],
});
export const signHere = style({ margin: 0, fontSize: '0.88em', fontWeight: 650, color: g.accentText });
export const signSection = style({
    display: 'flex', flexDirection: 'column', gap: '0.625em',
    padding: '0.875em 1em 1em', borderRadius: 12, border: `1px solid ${g.divider}`, background: g.surface,
});

// ── App 裡叫出的導覽（申請／下載憑證） ─────────────────────────────────
export const closeButton = style({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, flexShrink: 0,
    border: `1px solid ${g.control}`, borderRadius: 999, background: 'transparent', color: g.text, cursor: 'pointer',
    selectors: { '&:hover': { background: g.accentSoft }, '&:focus-visible': ring },
});
// 選擇要做的事：整列可點
export const taskList = style({ display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none', gap: '0.625em' });
export const taskButton = style({
    display: 'grid', gridTemplateColumns: '2em minmax(0, 1fr) auto', columnGap: '0.75em', alignItems: 'center', width: '100%',
    padding: '0.875em 1em', borderRadius: 12, border: `1.5px solid ${g.control}`, background: g.sunken, color: g.text,
    fontFamily: 'inherit', fontSize: '1em', textAlign: 'left', cursor: 'pointer', boxSizing: 'border-box',
    selectors: {
        '&:hover:not(:disabled)': { background: g.accentSoft, borderColor: g.accent },
        '&:focus-visible': ring,
        '&:disabled': { opacity: 0.6, cursor: 'default' },
    },
});
export const taskHint = style({ margin: 0, color: g.warn, fontWeight: 600, fontSize: '0.88em', lineHeight: 1.6 });
// CA 憑證：選正式帳號
export const profileOptions = style({ display: 'flex', flexDirection: 'column', gap: '0.5em' });
export const profileOption = style({
    display: 'grid', gridTemplateColumns: '1.5em minmax(0, 1fr)', columnGap: '0.75em', alignItems: 'start',
    padding: '0.75em 1em', borderRadius: 10, border: `1.5px solid ${g.control}`, background: g.surface, cursor: 'pointer',
    selectors: { '&:hover': { background: g.accentSoft }, '&:focus-within': ring },
});
export const profileOptionOn = style([profileOption, { borderColor: g.accent, background: g.accentSoft }]);
export const prodBadge = style({
    fontSize: '0.8em', fontWeight: 700, padding: '0.05em 0.6em', borderRadius: 999,
    color: g.danger, background: g.dangerSoft, border: `1.5px solid ${g.danger}`,
});
// App 裡的導覽面板：貼齊主視窗左側、不蓋住整個畫面（申請視窗蓋住右側時原生端保留左側 540px）
export const panel = style({
    position: 'fixed', left: 16, top: 56, bottom: 16, zIndex: 205,
    display: 'flex', flexDirection: 'column', minHeight: 0, pointerEvents: 'none',
});
globalStyle(`${panel} > *`, { pointerEvents: 'auto', maxHeight: '100%' });
