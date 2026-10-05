import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { glassBlur, reducedGlass, supportsGlass } from './login-glass.css';

export const track = style({
    position: 'relative',
    display: 'flex',
    gap: '2px',
    padding: '3px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: 10, // concentric with the 7px thumb at 3px padding
});

// two equal tabs: each is half the content box minus half the 2px gap
const thumbBase = style({
    position: 'absolute',
    top: '3px',
    bottom: '3px',
    left: '3px',
    width: 'calc(50% - 4px)',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: 7,
    boxShadow: 'inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.07))',
    transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1)',
    pointerEvents: 'none',
    '@supports': {
        [supportsGlass]: {
            background: `color-mix(in srgb, ${vars.color.panelRaised} 78%, transparent)`,
            WebkitBackdropFilter: glassBlur,
            backdropFilter: glassBlur,
        },
    },
    '@media': {
        '(prefers-reduced-motion: reduce)': { transition: 'none' },
        [reducedGlass]: {
            selectors: { '&&': { background: vars.color.panelRaised, WebkitBackdropFilter: 'none', backdropFilter: 'none' } },
        },
    },
});

export const thumb = styleVariants({
    account: [thumbBase],
    apikey: [thumbBase, { transform: 'translateX(calc(100% + 2px))' }],
});

const tabBase = style({
    position: 'relative',
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    height: '32px',
    fontFamily: vars.font.body,
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 7,
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    transition: 'color 160ms ease',
    ':hover': { color: vars.color.foreground },
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
});

export const tab = styleVariants({
    off: [tabBase],
    on: [tabBase, { color: vars.color.foreground }],
});

export const pane = style({
    display: 'contents',
    selectors: { '&[hidden]': { display: 'none' } },
});
