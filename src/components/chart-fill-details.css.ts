import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

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
