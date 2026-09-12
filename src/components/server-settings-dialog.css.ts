import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const backdrop = style({ position: 'fixed', inset: 0, zIndex: 209, background: 'rgba(0,0,0,.45)' });
export const dialog = style({
    position: 'fixed', inset: '5vh auto auto 50%', transform: 'translateX(-50%)', zIndex: 210,
    width: 'min(44rem, calc(100vw - 24px))', maxHeight: '90dvh', display: 'flex', flexDirection: 'column',
    color: vars.color.foreground, background: vars.color.panelRaised, border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md, boxShadow: '0 18px 48px rgba(0,0,0,.4)', fontSize: '1rem',
});
export const header = style({ flexShrink: 0, padding: '18px 20px 14px', borderBottom: `1px solid ${vars.color.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 });
export const title = style({ margin: '0 0 6px', fontSize: '1.25rem', fontWeight: 700 });
export const hint = style({ margin: 0, color: vars.color.mutedForeground, lineHeight: 1.6, overflowWrap: 'anywhere' });
export const body = style({ padding: '18px 20px', overflowY: 'auto', minHeight: 0 });
export const fields = style({ minWidth: 0, border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 20 });
export const section = style({ display: 'flex', flexDirection: 'column', gap: 10 });
export const heading = style({ margin: 0, fontSize: '1.05rem', fontWeight: 650 });
export const field = style({ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 });
export const label = style({ fontWeight: 600 });
export const input = style({ width: '100%', boxSizing: 'border-box', minWidth: 0, padding: '9px 10px', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.panel, color: vars.color.foreground, fontSize: '1rem' });
export const row = style({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' });
export const button = style({ border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, padding: '8px 12px', background: vars.color.panel, color: vars.color.foreground, cursor: 'pointer', fontSize: '1rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, selectors: { '&:disabled': { opacity: .5, cursor: 'default' }, '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 } } });
export const primary = style([button, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent, fontWeight: 600 }]);
export const selected = style([button, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent }]);
export const warning = style({ margin: 0, lineHeight: 1.6, color: vars.color.danger });
export const notice = style({ padding: '10px 12px', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.panel, lineHeight: 1.6, overflowWrap: 'anywhere' });
export const footer = style({ flexShrink: 0, padding: '14px 20px', borderTop: `1px solid ${vars.color.border}`, display: 'flex', flexDirection: 'column', gap: 10, background: vars.color.panelRaised, borderRadius: `0 0 ${vars.radius.md} ${vars.radius.md}` });
export const actions = style([row, { justifyContent: 'flex-end' }]);
export const details = style({ borderTop: `1px solid ${vars.color.border}`, paddingTop: 14 });
globalStyle(`${details} > summary`, { cursor: 'pointer', fontWeight: 600, marginBottom: 12 });
