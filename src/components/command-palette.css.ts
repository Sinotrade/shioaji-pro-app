// src/components/command-palette.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { resultCodeWeight, resultDetailSize, resultTextSize, searchResults, searchSurface } from './search-surface.css';

// Keep the usual top inset, but give short or zoomed viewports room for the controls.
const paletteTop = 'clamp(0.5rem, calc((100vh - 20rem) / 2), 18vh)';

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: paletteTop,
});

export const box = style({
    ...searchSurface,
    width: '26rem',
    maxWidth: 'calc(100vw - 2rem)',
    // Keep expanded details reachable below the top inset, including short windows.
    maxHeight: `calc(100vh - ${paletteTop} - 1rem)`,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
});

export const input = style({
    flexShrink: 0,
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: vars.font.mono,
    fontSize: '1rem',
    fontWeight: 600,
    color: vars.color.foreground,
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid ${vars.color.border}`,
    padding: `${vars.space.md} ${vars.space.lg}`,
    outline: 'none',
    textTransform: 'uppercase',
    '::placeholder': {
        color: vars.color.mutedForeground,
        textTransform: 'none',
        fontWeight: 400,
    },
    '@media': {
        '(max-height: 360px)': { padding: `${vars.space.sm} ${vars.space.lg}` },
    },
});

export const hint = style({
    flexShrink: 0,
    padding: `${vars.space.sm} ${vars.space.lg}`,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    display: 'flex',
    justifyContent: 'space-between',
    '@media': {
        '(max-height: 360px)': { padding: `${vars.space.xs} ${vars.space.sm}` },
    },
});

export const results = style({
    ...searchResults,
    maxHeight: '18rem',
    flex: '1 1 2.4rem',
    boxSizing: 'border-box',
    // Expanded details must never squeeze the selected result out of the list.
    minHeight: 'calc(2.4rem + 2px)',
    // Leave a fractional-pixel-safe edge below the final selected row.
    paddingBottom: 1,
    overscrollBehavior: 'contain',
    overflowY: 'auto',
    borderBottom: `1px solid ${vars.color.border}`,
});

// Palette rows are taller and wider set than the watchlist popup's.
export const result = style({
    minHeight: '2.4rem',
    padding: `${vars.space.xs} ${vars.space.lg}`,
    vars: { [resultTextSize]: '0.76rem', [resultCodeWeight]: '700', [resultDetailSize]: '0.65rem' },
});

// Panel commands keep their leading icon at every width; product order is unrelated.
export const panelIcon = style({
    flex: '0 0 auto',
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: '0.76rem',
});

export const panelName = style({
    flex: '1 1 10em',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.76rem',
});

export const err = style({
    color: vars.color.danger,
});
