import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    flexShrink: 0, borderBottom: `1px solid ${vars.color.border}`,
    padding: '6px 10px', fontSize: '0.7rem', color: vars.color.mutedForeground,
});
export const row = style({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 });
export const label = style({ color: vars.color.foreground, fontWeight: 600, whiteSpace: 'nowrap' });
const button = style({
    font: 'inherit', minHeight: 30, padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
    border: `1px solid ${vars.color.border}`, color: vars.color.mutedForeground,
    ':focus-visible': { outline: '2px solid #22d3ee', outlineOffset: 2 },
});
export const toggle = styleVariants({
    on: [button, { background: 'rgba(34, 211, 238, .10)', color: vars.color.foreground, borderColor: 'rgba(34, 211, 238, .4)' }],
    off: [button, { background: 'transparent' }],
});
export const status = style({ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', marginTop: 5, lineHeight: 1.6 });
export const help = style({ fontSize: '0.7rem', cursor: 'pointer', flexBasis: 'auto' });
export const explanation = style({
    maxWidth: 640, lineHeight: 1.65, padding: '6px 10px', cursor: 'text',
    borderLeft: '2px solid #22d3ee',
});
