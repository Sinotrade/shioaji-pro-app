import { createContainer, createVar, style, type StyleRule } from '@vanilla-extract/css';
import { PRODUCT_SEARCH_ACTIVE } from '../lib/product-badge-presentation';
import { vars } from '../theme.css';

// One bounded surface per search popup; children retain their own opaque text.
export const searchSurface = {
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    opacity: 1,
    // Prefix first: LightningCSS otherwise drops the preceding standard declaration.
    WebkitBackdropFilter: 'none',
    backdropFilter: 'none',
    '@supports': {
        '((backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px))) and (background: color-mix(in srgb, currentColor, transparent))': {
            '@media': {
                '(prefers-reduced-transparency: no-preference) and (forced-colors: none)': {
                    background: `color-mix(in srgb, ${vars.color.panelRaised} 90%, transparent)`,
                    WebkitBackdropFilter: 'blur(12px)',
                    backdropFilter: 'blur(12px)',
                },
            },
        },
    },
    '@media': {
        '(prefers-reduced-transparency: reduce)': {
            background: vars.color.panelRaised,
            WebkitBackdropFilter: 'none',
            backdropFilter: 'none',
        },
        '(forced-colors: active)': {
            background: 'Canvas',
            color: 'CanvasText',
            borderColor: 'CanvasText',
            boxShadow: 'none',
            WebkitBackdropFilter: 'none',
            backdropFilter: 'none',
        },
    },
} satisfies StyleRule;

// Component width, including a narrow desktop panel, controls the row presentation.
const resultsContainer = createContainer();
const narrowResults = `${resultsContainer} (max-width: 360px)`;

/** Spread into the element that scrolls a surface's result rows. */
export const searchResults = {
    containerType: 'inline-size',
    containerName: resultsContainer,
} satisfies StyleRule;

// Each surface sets its type scale on its own row class; the shared rules only read it.
export const resultTextSize = createVar();
export const resultCodeWeight = createVar();
export const resultDetailSize = createVar();

export const resultRow = style({
    position: 'relative',
    width: '100%',
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: vars.space.sm,
    border: 'none',
    boxSizing: 'border-box',
    minWidth: 0,
    color: vars.color.foreground,
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
});

// Added to the keyboard row after resultRow, so its background wins.
export const resultActive = style({
    background: vars.color[PRODUCT_SEARCH_ACTIVE.background],
    color: vars.color[PRODUCT_SEARCH_ACTIVE.color],
    boxShadow: `inset 2px 0 0 ${vars.color[PRODUCT_SEARCH_ACTIVE.indicator]}`,
    '@media': {
        '(forced-colors: active)': { outline: '1px solid Highlight', outlineOffset: -1 },
    },
});

// Carries an option's hover title without a box of its own, so the row layout is
// unchanged and screen readers do not read the title as the option's description.
export const optionText = style({ display: 'contents' });

export const resultCode = style({
    flex: '0 1 5.5rem',
    maxWidth: '28%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontWeight: resultCodeWeight,
    fontSize: resultTextSize,
    '@container': {
        [narrowResults]: { flex: '0 1 auto', maxWidth: '34%', fontWeight: 400 },
    },
});

export const resultName = style({
    // Reserve name space before shrinking lower-priority metadata near the breakpoint.
    flex: '1 1 10em',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: resultTextSize,
    '@container': {
        [narrowResults]: { flex: '1 1 0', fontWeight: 600 },
    },
});

export const resultDetail = style({
    color: vars.color.foreground,
    fontSize: resultDetailSize,
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
        [narrowResults]: {
            position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
            clipPath: 'inset(50%)', border: 0,
        },
    },
});
