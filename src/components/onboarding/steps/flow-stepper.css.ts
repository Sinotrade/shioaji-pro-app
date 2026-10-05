import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../../theme.css';

export const stepper = style({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '6px 2px',
    margin: 0,
    padding: '6px 8px',
    listStyle: 'none',
    fontVariantNumeric: 'tabular-nums',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: 10, // inset group radius
    '@media': {
        '(max-width: 480px)': { display: 'grid', gridTemplateColumns: 'repeat(3, auto)', justifyContent: 'center', gap: '6px 12px' },
    },
});

const itemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
});

export const item = styleVariants({
    upcoming: [itemBase],
    skipped: [itemBase],
    done: [itemBase],
    current: [itemBase, { color: vars.color.foreground, fontWeight: 600 }],
});

const dotBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: 22,
    height: 22,
    borderRadius: '50%',
    fontSize: '0.6875rem',
    fontWeight: 600,
    boxSizing: 'border-box',
    border: `1px solid ${vars.color.borderBright}`,
});

export const dot = styleVariants({
    upcoming: [dotBase],
    skipped: [dotBase, { background: vars.color.muted, borderColor: vars.color.border, opacity: 0.7 }],
    done: [dotBase, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent }],
    current: [dotBase, { background: vars.color.accent, borderColor: vars.color.accent, color: vars.color.panelRaised }],
});

export const separator = style({
    color: vars.color.borderBright,
    '@media': { '(max-width: 480px)': { display: 'none' } },
});

export const srOnly = style({
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
});
