import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
export const root = style({ flexShrink: 0, minWidth: 0, padding: '2px 7px', borderBottom: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground, fontSize: '0.64rem' });
export const summary = style({ cursor: 'pointer', padding: '5px 2px', fontSize: 12, color: vars.color.foreground,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    ':focus-visible': { outline: '2px solid #38bdf8' } });
export const summaryHint = style({ marginLeft: 12, fontSize: 11, color: vars.color.mutedForeground });
export const row = style({ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: '4px 8px', overflowX: 'auto', whiteSpace: 'nowrap' });
export const button = style({ font: 'inherit', minHeight: 24, padding: '2px 6px', cursor: 'pointer', whiteSpace: 'nowrap',
    borderRadius: 4, border: `1px solid ${vars.color.border}`, color: vars.color.foreground, background: vars.color.panel,
    ':disabled': { opacity: .4, cursor: 'default' }, ':focus-visible': { outline: '2px solid #38bdf8' },
    selectors: { '&[aria-pressed="true"]': { borderColor: '#38bdf8', background: 'rgba(56,189,248,.12)' } } });
export const message = style({ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.58rem', lineHeight: 1.25 });
