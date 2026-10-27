import { style, styleVariants } from '@vanilla-extract/css';
import { PRODUCT_BADGES, PRODUCT_BADGE_ALPHA } from '../lib/product-badge-presentation';
import { vars } from '../theme.css';

const badge = style({
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    padding: '1px 5px',
    border: '1px solid',
    borderColor: vars.color.border,
    background: 'transparent',
    color: vars.color.foreground,
    borderRadius: '3px',
    fontSize: '0.65rem',
    fontWeight: 600,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
});

export const tone = styleVariants(PRODUCT_BADGES, presentation => {
    const tint = 'blend' in presentation
        ? `color-mix(in srgb, ${vars.color[presentation.tint]} ${presentation.tintPercent}%, ${vars.color[presentation.blend]})`
        : vars.color[presentation.tint];
    return [badge, {
        '@supports': {
            '(background: color-mix(in srgb, currentColor, transparent))': {
                background: `color-mix(in srgb, ${tint} ${PRODUCT_BADGE_ALPHA.fill}%, transparent)`,
                borderColor: `color-mix(in srgb, ${tint} ${PRODUCT_BADGE_ALPHA.edge}%, transparent)`,
            },
        },
    }];
});
