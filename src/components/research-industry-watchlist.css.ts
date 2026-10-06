import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', fontFamily: vars.font.body });
export const toolbar = style({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 5, padding: 7, flexShrink: 0 });
export const control = style({ minWidth: 0, width: '100%', height: 29, border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm, background: vars.color.inset, color: vars.color.foreground, fontSize: '0.7rem', padding: '0 6px' });
export const note = style({ padding: '0 8px 6px', color: vars.color.mutedForeground, fontSize: '0.6rem', lineHeight: 1.5, flexShrink: 0 });
export const body = style({ flex: 1, minHeight: 0, overflowY: 'auto' });
export const group = style({ margin: 0 });
export const heading = style({ display: 'flex', justifyContent: 'space-between', margin: 0, padding: '5px 8px', background: vars.color.inset, borderTop: `1px solid ${vars.color.border}`, color: vars.color.accent, fontSize: '0.66rem', fontWeight: 600, position: 'sticky', top: 0, zIndex: 1 });
const rowBase = style({ width: '100%', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, alignItems: 'center', textAlign: 'left', padding: '5px 8px', border: 0, borderBottom: `1px solid ${vars.color.border}`, background: 'transparent', color: vars.color.foreground, cursor: 'pointer', minHeight: 38, ':hover': { background: vars.color.muted }, ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 } });
export const row = styleVariants({ normal: [rowBase], selected: [rowBase, { background: vars.color.accentDim, boxShadow: `inset 2px 0 ${vars.color.accent}` }] });
export const identity = style({ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 });
export const code = style({ fontFamily: vars.font.mono, fontSize: '0.72rem', fontWeight: 700 });
export const name = style({ fontSize: '0.65rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
export const numbers = style({ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, fontFamily: vars.font.mono, fontSize: '0.72rem', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' });
export const price = styleVariants({ up: { color: vars.color.up }, down: { color: vars.color.down }, flat: { color: vars.color.foreground } });
export const source = style({ color: vars.color.mutedForeground, fontFamily: vars.font.body, fontSize: '0.58rem' });
export const empty = style({ padding: 16, textAlign: 'center', color: vars.color.mutedForeground, fontSize: '0.7rem' });
