// src/components/app-lock.css.ts — 應用程式鎖專用樣式；欄位、按鈕、卡片沿用 server-settings-dialog.css。
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import * as s from './server-settings-dialog.css';

// 不透明、蓋住整個視窗；z-index 高過 App 內所有 dialog 與 popover（目前最高 2200）。
// 卡片用 auto margin 置中：內容比視窗高時從頂端開始捲動，不會被切掉
export const cover = style({
    position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', overflowY: 'auto', padding: vars.space.md,
    background: vars.color.background, color: vars.color.foreground, selectors: { '&:focus': { outline: 'none' } },
});
// 核可視窗（approval.html）沒有載入 index.css 的 button { font-family: inherit }
globalStyle(`${cover} button`, { fontFamily: 'inherit' });
// 核可視窗沒有全域的 box-sizing: border-box，width:100% 再加 padding 與邊框會超出遮蔽層
export const card = style([s.card, { boxSizing: 'border-box', width: '100%', maxWidth: '22rem', margin: 'auto', padding: vars.space.lg }]);
// 設定 → 應用程式鎖：字級縮到與其他分頁相近
// 鎖定畫面密碼欄下方一列：左邊「密碼提示」（或提示內容），右邊「忘記密碼？」
export const helpRow = style({ display: 'flex', alignItems: 'center', gap: vars.space.sm, fontSize: '0.8125em', color: vars.color.mutedForeground });
export const forgot = style([s.linkButton, { marginLeft: 'auto' }]);
export const wakeSelect = style([s.input, { width: 'auto', flexShrink: 0 }]);
export const settingsPage = style({ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: vars.space.sm });
