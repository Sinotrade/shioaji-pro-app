// src/components/health-badge.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const dotBase = style({
    width: '0.5rem',
    height: '0.5rem',
    display: 'inline-block',
    marginRight: vars.space.sm,
    verticalAlign: 'middle',
    borderRadius: '9999px',
});

export const dot = styleVariants({
    ok: [dotBase, { background: vars.color.success }],
    err: [dotBase, { background: vars.color.danger }],
});
