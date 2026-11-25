// src/components/assistant-fab.css.ts — 首次設定的 AI 助理：圓形浮鈕＋展開面板。

import { keyframes, style } from '@vanilla-extract/css';
import { g, GUIDE_FONT } from './apply-guide.css';

const ring = { outline: `3px solid ${g.accent}`, outlineOffset: 3 } as const;
const noMotion = '(prefers-reduced-motion: reduce)';
export const FAB_SIZE = 60;

export const root = style({ fontSize: GUIDE_FONT, color: g.text });

export const fab = style({
    position: 'fixed', zIndex: 1010, width: FAB_SIZE, height: FAB_SIZE, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer',
    border: `2px solid ${g.surface}`, background: g.accent, color: g.onAccent,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
    selectors: {
        '&:hover': { filter: 'brightness(1.08)' },
        '&:focus-visible': ring,
        '&[aria-expanded="true"]': { background: g.surface, color: g.text, borderColor: g.control },
    },
});

// 第一次看到時的提示：浮鈕旁的小標籤
const pop = keyframes({ from: { opacity: 0, transform: 'translateX(8px)' }, to: { opacity: 1, transform: 'none' } });
export const hint = style({
    position: 'fixed', zIndex: 1010, display: 'flex', alignItems: 'center', gap: '0.25em',
    minHeight: 44, padding: '0 0.4em 0 1em', borderRadius: 999,
    background: g.surface, color: g.text, border: `1px solid ${g.control}`,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.25)', fontSize: '0.92em', fontWeight: 650, whiteSpace: 'nowrap',
    animation: `${pop} 220ms ease-out`,
    '@media': { [noMotion]: { animation: 'none' } },
});
export const hintOpen = style({
    border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: 0,
    selectors: { '&:focus-visible': ring },
});
export const hintClose = style({
    width: 36, height: 36, borderRadius: '50%', border: 0, background: 'transparent', color: g.text2,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    selectors: { '&:hover': { background: g.accentSoft, color: g.text }, '&:focus-visible': ring },
});

export const panel = style({
    position: 'fixed', zIndex: 1009, display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
    background: g.surface, border: `1px solid ${g.control}`, borderRadius: 14,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)', overflow: 'hidden',
    selectors: { '&[hidden]': { display: 'none' }, '&:focus': { outline: 'none' } },
});
export const panelHeader = style({
    display: 'flex', alignItems: 'center', gap: '0.5em', flexShrink: 0,
    padding: '0.375em 0.5em 0.375em 1em', borderBottom: `1px solid ${g.divider}`, fontWeight: 700,
});
export const panelIcon = style({ color: g.accentText, display: 'flex' });
export const panelTitle = style({ margin: 0, fontSize: '1em', flex: 1, minWidth: 0 });
export const panelClose = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.3em', minHeight: 44, padding: '0 0.75em', borderRadius: 10,
    border: 0, background: 'transparent', color: g.text, font: 'inherit', fontSize: '0.88em', fontWeight: 600, cursor: 'pointer',
    selectors: { '&:hover': { background: g.accentSoft }, '&:focus-visible': ring },
});
// AI 面板本身是 App 共用元件（rem 排版），這裡只給它空間
export const panelBody = style({ flex: 1, minHeight: 0, fontSize: '1rem' });
