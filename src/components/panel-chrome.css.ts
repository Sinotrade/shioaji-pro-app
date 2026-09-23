// src/components/panel-chrome.css.ts

import {
    createContainer,
    style,
    styleVariants,
    type StyleRule,
} from '@vanilla-extract/css';
import { vars } from '../theme.css';

// ---- 標題列版面（#125）----
//
// 標題列本身是 inline-size container（寬度由面板決定）。依
// data-controls（none＝彈出視窗無按鈕、linked＝連動鈕、pinned＝鎖定
// 輸入框＋鈕）分別設定門檻，因為各組合佔掉的寬度不同。
//
// 優先順序（窄→寬）：代碼 > 商品名稱 > 面板名稱 > 按鈕文字／彈出鈕
//   - 代碼：不縮、不換行，群組最小寬＝代碼寬，永遠可見
//   - 商品名稱：放在自己的換行盒，剩餘寬度不足約三個字時整段換到
//     被裁掉的第二行 — 不留孤立的省略號；足夠時省略號截斷
//   - 面板名稱：標題列低於門檻時隱藏（並排價梯的面板名稱都一樣）
//   - 標題列極窄（內容寬 ≤200px）：連動/鎖定鈕只留圖示、隱藏裝飾條、
//     收窄間距與鎖定輸入框；≤150px 再隱藏彈出鈕
// 已實測 135 / 200 / 265 / 320px 面板寬。
const titleBarContainer = createContainer();

export const titleBar = style({
    containerName: titleBarContainer,
    containerType: 'inline-size',
});

const bar = (maxContent: number) =>
    `${titleBarContainer} (max-width: ${maxContent}px)`;

// 隱藏面板名稱的門檻（標題列內容寬，不含左右 padding）：群組需容納
// 面板名稱＋代碼（選擇權代碼最長）＋間距約 150px，再加上該組合的按鈕
// 寬（實測）。鎖定時代碼在輸入框、按鈕最寬，面板名稱只在名稱仍有
// 足夠空間（約 120px）時才顯示 — 名稱優先於面板名稱。
const LABEL_HIDE: Record<'none' | 'linked' | 'pinned', number> = {
    none: 160,
    linked: 232,
    pinned: 330,
};

// titleBar 的 [data-controls] 決定門檻；suffix 可指定 ::before
const whenLabelHidden = (suffix: string, rule: StyleRule) => ({
    '@container': Object.fromEntries(
        (Object.keys(LABEL_HIDE) as (keyof typeof LABEL_HIDE)[]).map((k) => [
            bar(LABEL_HIDE[k]),
            {
                selectors: {
                    [`${titleBar}[data-controls="${k}"] &${suffix}`]: rule,
                },
            },
        ]),
    ),
});

const NARROW = bar(200);
const TINY = bar(150);

export const deco = style({
    '@container': { [NARROW]: { display: 'none' } },
});

export const titleGroup = style({
    flex: '1 1 0',
    // min-width: auto → 最小寬＝不縮的代碼（＋顯示中的面板名稱）
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    '@container': {
        // 極窄時吃掉一部分標題列左右 padding
        [NARROW]: { marginLeft: '-10px' },
    },
});

// 無商品的面板標題：單純省略號截斷
export const titleText = style({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

// 帶商品的面板名稱
export const symbolLabel = style({
    flexShrink: 0,
    whiteSpace: 'nowrap',
    ...whenLabelHidden('', { display: 'none' }),
});

export const symbolCode = style({
    flexShrink: 0,
    whiteSpace: 'nowrap',
    selectors: {
        '&::before': { content: "'· '" },
    },
    // 面板名稱隱藏時不留孤立的分隔點
    ...whenLabelHidden('::before', { content: 'none' }),
});

// 名稱的換行盒：固定一行高、超出裁掉；寬度不計入群組最小寬
export const nameBox = style({
    flex: '1 1 0',
    width: 0,
    minWidth: 0,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    height: '1.4em',
    overflow: 'hidden',
});

// 零寬的第一個項目 — 讓名稱成為可換行的第二項
export const nameBreak = style({ width: 0, height: '1.4em' });

const nameBase = style({
    flex: '1 1 3em',
    minWidth: '3em',
    maxWidth: 'max-content',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: '1.4em',
    textTransform: 'none',
    letterSpacing: 0,
    fontFamily: vars.font.body,
    fontWeight: 500,
    color: vars.color.mutedForeground,
    opacity: 0.8,
});

// 名稱維持原字形（標題列為大寫＋字距的 display 字型），前景較淡。
// afterLabel：鎖定時代碼不在標題，名稱直接接面板名稱，補分隔點
export const symbolName = styleVariants({
    afterCode: [nameBase],
    afterLabel: [
        nameBase,
        {
            selectors: { '&::before': { content: "'· '" } },
            ...whenLabelHidden('::before', { content: 'none' }),
        },
    ],
});

// 連動/鎖定鈕的文字：極窄時只留圖示
export const pinText = style({
    '@container': { [NARROW]: { display: 'none' } },
});

export const popoutBtn = style({
    '@container': { [TINY]: { display: 'none' } },
});

// 極窄時按鈕間距 8→4px，最後一顆吃掉部分右 padding
const compactControl: StyleRule = {
    '@container': {
        [NARROW]: {
            marginLeft: '-4px',
            selectors: { '&:last-child': { marginRight: '-10px' } },
        },
    },
};

const pinBase = style({
    ...compactControl,
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    fontWeight: 600,
    padding: '1px 7px',
    cursor: 'pointer',
    borderRadius: '999px',
    border: '1px solid',
    transition: 'all 0.12s',
    flexShrink: 0,
    textTransform: 'none',
    letterSpacing: 0,
});

export const pinBtn = styleVariants({
    linked: [
        pinBase,
        {
            color: vars.color.accent,
            borderColor: 'transparent',
            background: vars.color.accentDim,
            ':hover': { borderColor: vars.color.accent },
        },
    ],
    pinned: [
        pinBase,
        {
            color: vars.color.amber,
            borderColor: vars.color.amber,
            background: 'transparent',
        },
    ],
});

export const pinInput = style({
    width: '4.2rem',
    '@container': {
        [NARROW]: { width: '3.4rem', marginLeft: '-4px' },
    },
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: vars.color.amber,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    outline: 'none',
    textTransform: 'uppercase',
    ':focus': { borderColor: vars.color.amber },
});

export const closeBtn = style({
    ...compactControl,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    lineHeight: 1,
    width: '18px',
    height: '18px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    flexShrink: 0,
    ':hover': {
        color: vars.color.danger,
        background: vars.color.muted,
    },
});
