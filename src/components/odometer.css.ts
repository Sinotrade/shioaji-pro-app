// src/components/odometer.css.ts — rolling digits (see odometer.tsx).

import { style } from '@vanilla-extract/css';

const reduce = { '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none', filter: 'none' } } } as const;

export const root = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
});

export const glyph = style({ display: 'inline-block' });

export const digit = style({
    display: 'inline-block',
    position: 'relative',
    height: '1.2em',
    lineHeight: '1.2em',
    overflow: 'hidden',
    verticalAlign: 'bottom',
});

// a slight overshoot reads as a mechanical counter settling
export const reel = style({
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 700ms cubic-bezier(0.34, 1.32, 0.64, 1)',
    willChange: 'transform',
    ...reduce,
});

export const still = style({ transition: 'none', filter: 'none' });

export const cell = style({ display: 'block', height: '1.2em', textAlign: 'center' });

export const srOnly = style({
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
});
