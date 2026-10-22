import type { StyleRule } from '@vanilla-extract/css';
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
