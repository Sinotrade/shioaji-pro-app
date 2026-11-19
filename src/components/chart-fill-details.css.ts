import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { seg } from './chart-order-popover.css';

export const tooltip = style({
    position: 'absolute', top: 8, right: 72, zIndex: 7, pointerEvents: 'none',
    width: 'max-content', maxWidth: 'calc(100% - 80px)', overflow: 'hidden', padding: '8px 10px',
    background: vars.color.panelRaised, border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm, color: vars.color.foreground,
    fontSize: '0.68rem', boxShadow: '0 3px 14px rgb(0 0 0 / 12%)',
});
// 窄面板：靠右貼邊、時間只留時分秒，內容才放得進框（框外的字會被圖表區裁掉）
export const tooltipCompact = style({ right: 8, maxWidth: 'calc(100% - 16px)', padding: '6px 8px' });
// 清單最高 168px，但不超過這張圖（K 線元件）高度的 38%：面板矮時清單縮小並在內部捲動，
// 不會把圖表壓扁，也不會被面板邊界裁掉。
export const details = style({
    maxHeight: 'min(168px, 38%)', minHeight: 40, flex: '0 1 auto', overflow: 'auto',
    borderTop: `1px solid ${vars.color.border}`, padding: '6px 10px',
    color: vars.color.foreground, background: vars.color.panel,
    fontSize: '0.7rem',
    // 可用鍵盤聚焦後捲動；外框往內畫，避免被外層 overflow 裁掉
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
});
export const header = style({
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5,
});
// 清單的「這根 K 棒」摘要行：捲動時黏在清單頂端。sticky 停在容器的內容框，top 要抵掉清單的上內距 6px，
// 否則上方會露出 6px 的列（Chromium、WebKit 實測）
export const focusLine = style({
    position: 'sticky', top: -6, zIndex: 1, background: vars.color.panel,
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5,
});
// 標亮的列：全站的選取底色
export const focusRow = style({ background: vars.color.accentDim });
export const focusClear = style({
    marginLeft: 'auto', padding: '0 4px', border: 0, background: 'none', color: vars.color.mutedForeground, font: 'inherit', cursor: 'pointer',
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
});
export const muted = style({ color: vars.color.mutedForeground, fontWeight: 400 });
export const table = style({ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' });
export const cell = style({ padding: '3px 9px 3px 0', textAlign: 'left', fontWeight: 400 });
export const number = style([cell, { textAlign: 'right' }]);
export const tooltipMeta = style([cell, muted, { whiteSpace: 'normal' }]);
// 窄提示框的時間格：可以在日期和時間之間換行（表格是 nowrap，日 K 的「月-日 時:分:秒」會把數量欄擠出框外）
export const tooltipTime = style([cell, { whiteSpace: 'normal' }]);
export const empty = style({ padding: '5px 0', color: vars.color.mutedForeground });
// 工具列上的「成交待對帳／暫停」提示（成交來源未確認時標記整批隱藏，需要讓人看得出原因）
export const pendingNote = style({
    display: 'inline-flex', alignItems: 'center', padding: '0 6px', whiteSpace: 'nowrap',
    fontSize: '0.68rem', color: vars.color.amber,
});

// ── 圖例列與設定面板（圖例列「成交」或「指標」裡的「成交標記」打開） ──
// 圖例列的控制鈕一直顯示（指標列是滑鼠移上去才出現）：第一次用的人要看得到設定在哪
export const legendCtrls = style({ display: 'inline-flex', gap: '1px' });
// 點擊範圍放大到約 21×21（macOS 最小 20），負邊距讓列高不變
globalStyle(`${legendCtrls} > button`, { padding: '5px', margin: '-4px 0' });
export const legendName = style({ color: vars.color.foreground });
// 彈出層（畫圖工具的 Popover）內容不換行、寬度跟內容；這裡固定寬、窄視窗縮到放得下
export const settings = style({
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '8px', padding: '4px',
    width: 'min(19rem, calc(100vw - 32px))', whiteSpace: 'normal',
});
// 分段鈕外框 overflow: hidden 會裁掉預設焦點框：分段鈕的焦點框畫在內側（其他控制項用預設的，色塊的焦點框才不會跟色塊同色）
globalStyle(`${settings} ${seg} > button:focus-visible`, { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' });
// 樣式鈕裡的示意標籤（「買」「962」）
export const sample = style({
    display: 'inline-block', marginLeft: '2px', padding: '0 3px', border: '1px solid currentColor', borderRadius: '3px',
    fontFamily: vars.font.mono, fontSize: '0.64rem', lineHeight: 1.3,
});
// 「買 ■」「賣 ■」的色塊
export const chip = style({
    display: 'inline-block', width: '10px', height: '10px', marginLeft: '4px', borderRadius: '3px', verticalAlign: '-1px',
    border: `1px solid ${vars.color.border}`,
});
export const caret = style({ marginLeft: '4px', fontSize: '0.72rem', fontWeight: 400, color: vars.color.mutedForeground });
export const picker = style({ gridColumn: '2', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
export const check = style({ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', whiteSpace: 'nowrap' });
// 帳戶範圍那一行：說明在左、切換在右，放不下就換行
export const scopeLine = style({ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' });
export const link = style({
    padding: '2px 0', border: 'none', background: 'transparent', cursor: 'pointer',
    font: 'inherit', color: vars.color.foreground, textDecoration: 'underline',
});
// 從「指標」打開設定後雙擊間隔內的透明遮罩（同對話框遮罩的層級）
export const clickShield = style({ position: 'fixed', inset: 0, zIndex: 2000 });
