// src/components/command-palette.css.ts

import { createContainer, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { PRODUCT_SEARCH_ACTIVE } from '../lib/product-badge-presentation';
import { searchSurface } from './search-surface.css';

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

const searchContainer = createContainer();
const narrowSearch = `${searchContainer} (max-width: 360px)`;

export const results = style({
    containerType: 'inline-size',
    containerName: searchContainer,
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

const resultBase = {
    position: 'relative' as const,
    width: '100%',
    minHeight: '2.4rem',
    display: 'flex',
    flexWrap: 'nowrap' as const,
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `${vars.space.xs} ${vars.space.lg}`,
    border: 'none',
    boxSizing: 'border-box' as const,
    minWidth: 0,
    color: vars.color.foreground,
    textAlign: 'left' as const,
    cursor: 'pointer',
};

export const result = style({
    ...resultBase,
    background: 'transparent',
});

export const resultActive = style({
    ...resultBase,
    background: vars.color[PRODUCT_SEARCH_ACTIVE.background],
    color: vars.color[PRODUCT_SEARCH_ACTIVE.color],
    boxShadow: `inset 2px 0 0 ${vars.color[PRODUCT_SEARCH_ACTIVE.indicator]}`,
    '@media': {
        '(forced-colors: active)': { outline: '1px solid Highlight', outlineOffset: -1 },
    },
});

export const resultCode = style({
    flex: '0 1 5.5rem',
    maxWidth: '28%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontWeight: 700,
    fontSize: '0.76rem',
    '@container': {
        [narrowSearch]: { flex: '0 1 auto', maxWidth: '34%', fontWeight: 400 },
    },
});

export const resultName = style({
    // Reserve name space before shrinking lower-priority metadata near the breakpoint.
    flex: '1 1 10em',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.76rem',
    '@container': {
        [narrowSearch]: { flex: '1 1 0', fontWeight: 600 },
    },
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

export const resultType = style({
    color: vars.color.foreground,
    fontSize: '0.65rem',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    selectors: { [`${resultActive} &`]: { color: vars.color[PRODUCT_SEARCH_ACTIVE.color] } },
});

export const resultMeta = style({
    flex: '0 4 auto',
    maxWidth: '42%',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    gap: vars.space.xs,
    // Keep classification and expiry/warnings in the accessible name at narrow widths.
    '@container': {
        [narrowSearch]: {
            position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
            clipPath: 'inset(50%)', border: 0,
        },
    },
});

export const err = style({
    color: vars.color.danger,
});
