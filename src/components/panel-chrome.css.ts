// src/components/panel-chrome.css.ts

import { createContainer, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// 標題文字群組：佔滿按鈕以外的剩餘寬度，並作為 inline-size container —
// 連動／鎖定輸入／彈出／關閉鈕的組合各面板不同，以群組自身寬度判斷
// 才準確。
const titleGroupContainer = createContainer();

export const titleGroup = style({
    containerName: titleGroupContainer,
    containerType: 'inline-size',
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    overflow: 'hidden',
});

// 窄面板截斷順序（#125，閃電下單最小約 265px）：
//   群組 >150px：面板名稱與代碼完整，剩餘空間給商品名稱（省略號截斷）
//   群組 ≤150px：隱藏面板名稱（價梯本身即可辨識），代碼＋商品名稱
// 並排多個閃電價梯時面板名稱都一樣，商品名稱才是區分資訊；代碼是
// 身分，不截斷。面板名稱與代碼不設 flexShrink — 任何次像素的縮減都會
// 觸發省略號。150px ≈ 最長面板名稱＋選擇權代碼＋間距。
const NARROW = `${titleGroupContainer} (max-width: 150px)`;

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
    '@container': {
        [NARROW]: { display: 'none' },
    },
});

export const symbolCode = style({
    flexShrink: 0,
    whiteSpace: 'nowrap',
    selectors: {
        '&::before': { content: "'· '" },
    },
    '@container': {
        // 面板名稱隱藏時不留孤立的分隔點
        [NARROW]: { selectors: { '&::before': { content: 'none' } } },
    },
});

// 名稱維持原字形（標題列為大寫＋字距的 display 字型），前景較淡
export const symbolName = style({
    minWidth: 0,
    flexShrink: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textTransform: 'none',
    letterSpacing: 0,
    fontFamily: vars.font.body,
    fontWeight: 500,
    color: vars.color.mutedForeground,
    opacity: 0.8,
});

const pinBase = style({
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
