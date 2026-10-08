// src/components/settings-test-order.css.ts — 測試單：市場狀態與商品／委託價／操作對齊

import { createContainer, createVar, globalStyle, style } from '@vanilla-extract/css';
import { themeClasses, vars } from '../theme.css';

// 恢復半透明材質；淡染跟隨主題 accent，不改卡片與欄位的排版。
const tint = (pct: number) => `color-mix(in srgb, ${vars.color.accent} ${pct}%, transparent)`;
const cardSurface = createVar();
const cardHighlight = createVar();
const cardTintTop = createVar();
const cardTintBottom = createVar();
const lightThemes = [themeClasses['light-tw'], themeClasses['light-intl']].map(c => `.${c} &`).join(', ');
const NO_BLUR = { WebkitBackdropFilter: 'none', backdropFilter: 'none' } as const;
const orderBox = createContainer();
const NARROW_ORDER = `${orderBox} (max-width: 30rem)`;
const COMPACT_ORDER = `${orderBox} (max-width: 18rem)`;
// 舊版 Safari 沒有 container query，依設定視窗外圍留白改用 viewport 備援。
const NO_CONTAINER_SUPPORT = 'not (container-type: inline-size)';
const NARROW_VIEWPORT = '(max-width: 50rem)';
const COMPACT_VIEWPORT = '(max-width: 24rem)';
const COLUMNS = 'minmax(0, 1fr) 10rem 8em';
const LABEL_FONT_SIZE = '0.7rem';
const LABEL_LINE_HEIGHT = 1.5;
const FIELD_GAP = '6px';
// 三欄標籤共用高度；放大字級時仍容納驗證徽章的行高與上下 padding。
const LABEL_MIN_HEIGHT = 'max(22px, calc(0.64rem * 1.5 + 4px))';
export const card = style({
    containerName: orderBox,
    containerType: 'inline-size',
    vars: {
        [cardSurface]: 'rgb(0 0 0 / 0.5)',
        [cardHighlight]: 'rgb(255 255 255 / 0.08)',
        [cardTintTop]: 'transparent',
        [cardTintBottom]: 'transparent',
    },
    marginTop: vars.space.sm,
    padding: '1rem',
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.border}`,
    backgroundColor: [vars.color.panel, cardSurface],
    backgroundImage: `linear-gradient(${cardTintTop}, ${cardTintBottom})`,
    boxShadow: `inset 0 1px 0 ${cardHighlight}`,
    WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
    backdropFilter: 'blur(20px) saturate(1.4)',
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.76rem',
    lineHeight: 1.5,
    selectors: {
        [lightThemes]: {
            vars: {
                [cardSurface]: 'rgb(255 255 255 / 0.85)',
                [cardHighlight]: 'rgb(255 255 255 / 0.9)',
            },
        },
    },
    '@supports': {
        '(background: color-mix(in srgb, red, blue))': {
            vars: { [cardTintTop]: tint(12), [cardTintBottom]: tint(4) },
            border: `1px solid color-mix(in srgb, ${vars.color.foreground} 14%, transparent)`,
            selectors: {
                [lightThemes]: { vars: { [cardTintTop]: tint(8), [cardTintBottom]: tint(3) } },
            },
            '@media': {
                '(prefers-reduced-transparency: reduce)': {
                    backgroundColor: `color-mix(in srgb, ${vars.color.accent} 6%, ${vars.color.panel})`,
                },
                '(prefers-contrast: more)': { borderColor: vars.color.mutedForeground },
            },
        },
    },
    '@media': {
        '(prefers-reduced-transparency: reduce)': {
            backgroundColor: vars.color.panel,
            backgroundImage: 'none',
            ...NO_BLUR,
        },
        '(prefers-contrast: more)': {
            backgroundColor: vars.color.panelRaised,
            backgroundImage: 'none',
            borderColor: vars.color.mutedForeground,
            boxShadow: 'none',
            ...NO_BLUR,
        },
    },
});
export const header = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' });
export const heading = style({ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' });
export const title = style({ display: 'inline-flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', fontSize: '0.88rem', fontWeight: 600, color: vars.color.foreground });
export const environment = style({ fontSize: '0.68rem', color: vars.color.mutedForeground });
export const description = style({ margin: 0, fontSize: '0.7rem', lineHeight: 1.6, color: vars.color.mutedForeground });
export const testSchedule = style([description]);
export const sectionNotice = style([description, { margin: '0 0 12px' }]);
export const headerActions = style({
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '6px 10px',
    minWidth: 0, maxWidth: '100%', marginLeft: 'auto',
});
export const refreshMessage = style([description, {
    minWidth: 0, flex: '0 1 auto', overflowWrap: 'anywhere',
    textAlign: 'right',
    selectors: { '&:empty': { position: 'absolute', width: 0, height: 0, margin: 0, overflow: 'hidden' } },
}]);
export const grid = style({ display: 'flex', flexDirection: 'column', marginTop: '12px' });
export const row = style({
    display: 'grid', gridTemplateColumns: COLUMNS, columnGap: '12px', rowGap: '6px',
    alignItems: 'start', padding: '10px 0',
    selectors: { '& + &': { borderTop: `1px solid ${vars.color.border}` } },
    '@container': {
        [NARROW_ORDER]: { gridTemplateColumns: 'minmax(0, 1fr) 8em' },
        [COMPACT_ORDER]: { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
    '@supports': {
        [NO_CONTAINER_SUPPORT]: {
            '@media': {
                [NARROW_VIEWPORT]: { gridTemplateColumns: 'minmax(0, 1fr) 8em' },
                [COMPACT_VIEWPORT]: { gridTemplateColumns: 'minmax(0, 1fr)' },
            },
        },
    },
});

const field = style({ display: 'flex', flexDirection: 'column', gap: FIELD_GAP, minWidth: 0 });
export const productField = style([field, {
    '@container': { [NARROW_ORDER]: { gridColumn: '1 / -1' } },
    '@supports': {
        [NO_CONTAINER_SUPPORT]: {
            '@media': { [NARROW_VIEWPORT]: { gridColumn: '1 / -1' } },
        },
    },
}]);
export const priceField = style([field, {
    '@container': { [NARROW_ORDER]: { gridColumn: '1' } },
    '@supports': {
        [NO_CONTAINER_SUPPORT]: {
            '@media': { [NARROW_VIEWPORT]: { gridColumn: '1' } },
        },
    },
}]);
export const fieldLabel = style({
    display: 'flex', alignItems: 'center', minHeight: LABEL_MIN_HEIGHT,
    fontSize: LABEL_FONT_SIZE, lineHeight: LABEL_LINE_HEIGHT, color: vars.color.mutedForeground,
});
export const actionCell = style({
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: FIELD_GAP, minWidth: 0,
    '@container': {
        [NARROW_ORDER]: { gridColumn: '2' },
        [COMPACT_ORDER]: { gridColumn: '1' },
    },
    '@supports': {
        [NO_CONTAINER_SUPPORT]: {
            '@media': {
                [NARROW_VIEWPORT]: { gridColumn: '2' },
                [COMPACT_VIEWPORT]: { gridColumn: '1' },
            },
        },
    },
});

export const cell = style({
    position: 'relative',
    minWidth: 0,
    display: 'flex',
});

export const productCell = style({ minWidth: 0, fontSize: '0.72rem' });
export const priceCell = style({ minWidth: 0 });

// 與 hud.saveInput 組合使用；統一三個控制項高度
export const control = style({
    height: '32px',
    fontSize: '0.76rem',
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    boxSizing: 'border-box',
    // 送出中停用：和停用的送出鈕一樣淡化
    ':disabled': { color: vars.color.mutedForeground },
});

export const refreshButton = style([control, {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    padding: '0 10px', minWidth: '7.5em', flexShrink: 0,
    border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.md,
    background: vars.color.muted, color: vars.color.foreground,
    fontFamily: vars.font.body, fontSize: '0.7rem', whiteSpace: 'nowrap', cursor: 'pointer',
    ':hover': { background: vars.color.panelRaised },
    ':disabled': { cursor: 'default', background: vars.color.muted },
}]);

// 右側代碼的寬度由元件依代碼長度給 padding-right
export const productInput = style({ paddingLeft: '24px', textOverflow: 'ellipsis' });

export const searchIcon = style({
    position: 'absolute',
    left: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: vars.color.mutedForeground,
    pointerEvents: 'none',
});

export const priceInput = style({
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
    minWidth: 0,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    selectors: { '&[data-stale]': { color: vars.color.mutedForeground } },
});

// 左側有「成交價」標示或恢復鈕時讓出空間
export const priceTagged = style({ paddingLeft: '64px' });

export const priceSource = style({
    position: 'absolute',
    left: '9px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

// accent 混一點 foreground：淺色主題純 accent 在 inset 上只有 4.41:1，
// 混過後在 inset／muted／hover 底上都 ≥ 4.5:1；深色與自訂主題跟著 token 走
const accentText = `color-mix(in srgb, ${vars.color.accent} 80%, ${vars.color.foreground})`;

// 24px 高：web view 適用 WCAG 2.5.8 的 24×24 CSS px；價位框 32px，上下各留 4px
export const priceReset = style({
    position: 'absolute',
    left: '4px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    height: '24px',
    padding: '0 5px',
    border: 'none',
    borderRadius: vars.radius.sm,
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.accent,
    '@supports': { '(background: color-mix(in srgb, red, blue))': { color: accentText } },
    ':hover': { background: vars.color.accentDim },
    ':disabled': { cursor: 'default', background: 'transparent', color: vars.color.mutedForeground },
});

// 與 hud.updateBtn 組合使用：中性、微凸的按鈕面，與凹陷的 inset 輸入框分開；
// hover／disabled 仍由 updateBtn 決定
export const sendBtn = style([control, {
    padding: '0 10px',
    // 保留完整操作文字，兩列使用相同寬度。
    minWidth: '8em',
    fontSize: '0.76rem',
    marginLeft: 0,
    whiteSpace: 'nowrap',
    background: vars.color.muted,
    borderColor: vars.color.borderBright,
    color: vars.color.accent,
    '@supports': { '(background: color-mix(in srgb, red, blue))': { color: accentText } },
    '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
    selectors: {
        '&[data-stale]': { color: vars.color.mutedForeground },
        // 按下：形狀回饋（下沉＋內陰影），不改文字色，對比不變；深色 hover 底上 brightness 看不出來
        '&:active:not([aria-disabled="true"])': { transform: 'translateY(1px)', boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.4)' },
        // 停用是「暫停送出」不是「處理中」：不用 updateBtn 的 wait 游標（處理中另有 Orb）
        '&[aria-disabled="true"]': { cursor: 'default', color: vars.color.mutedForeground, opacity: 0.5, filter: 'none', transform: 'none', boxShadow: 'none' },
        '&[aria-disabled="true"]:hover': { background: vars.color.muted, borderColor: vars.color.borderBright },
    },
}]);

// 常駐的 live region：空的時候不佔高度。訊息換成兩行時，圖示（12px 的 svg 或 Orb）
// 對齊第一行的中線，不浮在兩行中間
export const status = style({
    gridColumn: '1 / -1',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    minWidth: 0,
    fontSize: '0.7rem',
    lineHeight: 1.5,
    flexWrap: 'wrap',
    overflowWrap: 'anywhere',
    // 保留 live region 掛載與可存取性，但空白時移出版面，不產生 grid gap。
    selectors: { '&:empty': { position: 'absolute', width: 0, height: 0, padding: 0, overflow: 'hidden' } },
});
globalStyle(`${status} > [aria-hidden="true"]`, { flexShrink: 0, marginTop: 'calc((1.5em - 12px) / 2)' });

// 與設定視窗 styles.errorText 同色，錯誤不能長得跟說明文字一樣
export const statusError = style({
    color: vars.color.danger,
});

// 成功：文字用 foreground（success 綠在淺色只有約 4:1），綠色只給圖示
export const statusOk = style({
    color: vars.color.foreground,
});

export const resultContent = style({ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: '2px' });
export const resultHeading = style({ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px', fontWeight: 600 });
export const resultLatency = style({ fontFamily: vars.font.mono, fontWeight: 400, fontVariantNumeric: 'tabular-nums', color: vars.color.mutedForeground });
export const resultDetails = style({ color: vars.color.mutedForeground, overflowWrap: 'anywhere' });

export const okIcon = style({
    flexShrink: 0,
    color: vars.color.success,
});

export const statusIcon = style({ flexShrink: 0 });

// 結果未知：和可修正重試的錯誤分開。文字用 foreground（amber 在淺色對比不足、自訂主題
// 不推導 amber），顏色只給圖示
export const statusUnknown = style({
    color: vars.color.foreground,
    fontWeight: 600,
});

export const unknownIcon = style({
    flexShrink: 0,
    color: vars.color.amber,
});

// 商品框右側的實際送單代碼（框的 padding-right 已讓出位置，不靠底色遮字）
export const productCode = style({
    position: 'absolute',
    right: '9px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

// 本區位在設定內容捲動區最底部：清單往上展開才不會被裁到
export const popup = style({
    position: 'absolute',
    bottom: 'calc(100% + 2px)',
    left: 0,
    right: 0,
    zIndex: 30,
    maxHeight: '15rem',
    overflowY: 'auto',
    padding: '3px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 -6px 18px rgba(0, 0, 0, 0.3)',
});

export const option = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    padding: '5px 8px',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    fontSize: '0.72rem',
    color: vars.color.foreground,
    // 只有一種反白（滑鼠移動會同步 active）；加 accent 內框，光靠 12% 底色看不出來
    selectors: {
        '&[aria-selected="true"]': {
            background: vars.color.accentDim,
            boxShadow: `inset 0 0 0 1px ${vars.color.accent}`,
        },
    },
});

// 清單與商品框同寬（HIG：選項不比欄位寬）；太長就換行，不截掉月份等可區分的資訊。
// option 維持 baseline 對齊：類別、代碼對齊名稱第一行
export const optionName = style({
    flex: 1,
    minWidth: 0,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
});

export const optionCode = style({
    flexShrink: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    selectors: { [`${option}[aria-selected="true"] &`]: { color: vars.color.foreground } },
});

// 商品類別（股票／期貨…）：決定送 1 張還是 1 口、走哪個帳戶，選之前就看得到
export const optionCat = style([optionCode, { fontFamily: vars.font.body }]);

export const emptyOption = style({
    padding: '5px 8px',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});


export const market = style({
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', minHeight: LABEL_MIN_HEIGHT,
    color: vars.color.foreground,
});
export const marketName = style({ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600, whiteSpace: 'nowrap' });
export const quantity = style({
    display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: LABEL_MIN_HEIGHT,
    fontSize: LABEL_FONT_SIZE, lineHeight: LABEL_LINE_HEIGHT, color: vars.color.mutedForeground, textAlign: 'center', whiteSpace: 'nowrap',
});
export const srOnly = style({ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 });
export const acknowledge = style({
    fontFamily: vars.font.body, fontSize: '0.7rem', minHeight: '24px', padding: '2px 6px',
    color: vars.color.foreground, background: vars.color.muted, border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm, cursor: 'pointer', whiteSpace: 'nowrap',
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
});


export const verification = style({
    display: 'inline-flex', alignItems: 'center', flexShrink: 0, gap: '4px',
    padding: '2px 6px', borderRadius: vars.radius.sm,
    fontSize: '0.64rem', fontWeight: 500, color: vars.color.foreground, whiteSpace: 'nowrap',
    background: vars.color.muted,
    selectors: { '&[data-verified]': { background: `color-mix(in srgb, ${vars.color.success} 10%, ${vars.color.panel})` } },
});
export const guidance = style({ paddingTop: '12px', borderTop: `1px solid ${vars.color.border}` });
export const help = style({ marginTop: '8px', color: vars.color.mutedForeground });
export const helpToggle = style({
    width: 'fit-content', minHeight: '28px', padding: '4px 0', boxSizing: 'border-box',
    fontSize: '0.7rem', cursor: 'pointer', borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground },
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '3px' },
});
export const instructions = style({ margin: '8px 0 0', paddingLeft: '1.5em', fontSize: '0.7rem', lineHeight: 1.6 });
globalStyle(`${instructions} > li + li`, { marginTop: '6px' });
export const ruleLink = style({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    color: vars.color.accent, textDecoration: 'underline', textUnderlineOffset: '2px', borderRadius: vars.radius.sm,
    '@supports': { '(background: color-mix(in srgb, red, blue))': { color: accentText } },
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
});
export const signingLinks = style({ display: 'inline-flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', maxWidth: '100%' });
export const helpFooter = style([description, { margin: '8px 0', overflowWrap: 'anywhere' }]);
