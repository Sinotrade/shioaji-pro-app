// src/components/onboarding/live-player.css.ts — DEV 即時畫面：固定在視窗右下角，浮在玻璃卡片之上。

import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { glassBlur, reducedGlass, supportsGlass } from './login-glass.css';
import { focusRing, hairline, radius } from './steps/steps-b.css';

const fadeIn = keyframes({ from: { opacity: 0 } });
const grow = keyframes({ from: { opacity: 0, transform: 'scale(0.96)' } });
const noMotion = { '(prefers-reduced-motion: reduce)': { animation: 'none' } };

// 浮在玻璃卡上：比卡片更不透明，陰影收短
const floating = style({
    background: vars.color.panelRaised,
    border: `1px solid color-mix(in srgb, ${vars.color.borderBright} 55%, transparent)`,
    boxShadow: [
        'inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.1))',
        `0 12px 32px light-dark(rgba(15, 23, 42, 0.16), rgba(0, 0, 0, 0.45))`,
    ].join(', '),
    '@supports': {
        [supportsGlass]: {
            background: `color-mix(in srgb, ${vars.color.panelRaised} 88%, transparent)`,
            WebkitBackdropFilter: glassBlur,
            backdropFilter: glassBlur,
        },
    },
    '@media': {
        // 加倍 class 權重，不靠 @supports／@media 的輸出順序
        [reducedGlass]: { selectors: { '&&': { background: vars.color.panelRaised, WebkitBackdropFilter: 'none', backdropFilter: 'none' } } },
    },
});

// 脫離排版流（不吃 layout 的 gap）；shell 是 z-index 1000 的堆疊環境，1 就蓋得過卡片。
// 不能放進玻璃卡片裡：卡片的 backdrop-filter 會變成 fixed 的定位基準。
export const launcher = style({
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column-reverse',
    alignItems: 'flex-end',
    gap: 12,
    animation: `${fadeIn} 160ms ease-out`,
    '@media': noMotion,
});

// 圓形、只放圖示：兩張卡片（26rem + 24rem + 1.5rem gap = 824px）置中，48px 圓鈕加 16px 邊距在視窗寬 ≥ 952px 時不會壓到卡片
export const bubble = style([
    floating,
    {
        display: 'grid',
        placeItems: 'center',
        width: 48,
        height: 48,
        padding: 0,
        borderRadius: '50%',
        color: vars.color.foreground,
        cursor: 'pointer',
        selectors: { '&:focus-visible': focusRing },
    },
]);

export const icon = style({ position: 'relative', display: 'flex' });

export const badge = style({
    position: 'absolute',
    top: -3,
    right: -4,
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: vars.color.accent,
    boxShadow: `0 0 0 2px ${vars.color.panelRaised}`,
    '@media': { '(forced-colors: active)': { background: 'CanvasText' } },
});

export const panel = style([
    floating,
    {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        // --live-w 是使用者拉出來的寬度；視窗變小時再被左右邊距與高度（維持 16:10）壓回來
        position: 'relative',
        width: 'min(var(--live-w, 384px), calc(100vw - 32px), calc((100dvh - 140px) * 1.6))',
        maxHeight: 'calc(100dvh - 96px)',
        padding: 8,
        boxSizing: 'border-box',
        borderRadius: 16,
        transformOrigin: 'bottom right',
        animation: `${grow} 160ms ease-out`,
        '@media': noMotion,
    },
]);

export const caption = style({
    margin: 0,
    padding: '2px 6px 0 24px', // 左邊讓給調整大小的把手
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
});

export const title = style({ marginRight: 8, fontWeight: 600, color: vars.color.foreground });

// 與本機瀏覽器同比例（1280×800）
export const screen = style({
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 10',
    overflow: 'hidden',
    borderRadius: radius.group,
    border: hairline,
    boxSizing: 'border-box',
    background: `color-mix(in srgb, ${vars.color.background} 80%, black)`,
});

export const frame = style({ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', objectFit: 'contain' });

export const placeholder = style({
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    margin: 0,
    fontSize: '0.78rem',
    // 不在玻璃卡片裡，吃不到卡片調高對比的 muted；淺色主題下 muted 對這個底色不到 4.5:1
    color: vars.color.foreground,
});

// 左上角（面板固定在右下角，往左上拉是放大）；24px 點擊區
export const resize = style({
    position: 'absolute',
    top: 2,
    left: 2,
    display: 'grid',
    placeItems: 'center',
    width: 24,
    height: 24,
    padding: 0,
    border: 'none',
    borderRadius: radius.control,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'nwse-resize',
    touchAction: 'none',
    selectors: {
        '&:hover': { color: vars.color.foreground },
        '&:focus-visible': focusRing,
    },
});
