// src/components/portfolio-sector.css.ts — shared chrome of the 持股 view
// (KPI strip, controls, alerts, empty states). Each variant owns its own css.

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const mono = { fontFamily: vars.font.mono, fontVariantNumeric: 'tabular-nums' } as const;
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

export const root = style({ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0 });

export const head = style({
    display: 'flex',
    alignItems: 'flex-end',
    gap: '22px',
    padding: '8px 12px 6px',
    flexWrap: 'wrap',
    rowGap: '6px',
});

export const kpi = style({ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 });
export const kpiLabel = style({ fontSize: '0.6rem', color: vars.color.mutedForeground, whiteSpace: 'nowrap' });
export const kpiBig = style({ ...mono, fontSize: '1.45rem', fontWeight: 650, lineHeight: 1.15, letterSpacing: '-0.01em', color: vars.color.foreground });
export const kpiValue = style({ ...mono, fontSize: '0.95rem', fontWeight: 600, lineHeight: 1.2, color: vars.color.foreground });
export const kpiSub = style({ ...mono, fontSize: '0.66rem', color: vars.color.mutedForeground, marginLeft: '6px', fontWeight: 500 });

export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.mutedForeground },
});

// share bar: inflow share of the portfolio's market value
export const alignBar = style({
    position: 'relative',
    width: '120px',
    height: '4px',
    borderRadius: '2px',
    background: vars.color.border,
    overflow: 'hidden',
    marginTop: '5px',
});
export const alignFill = style({
    position: 'absolute',
    inset: 0,
    right: 'auto',
    borderRadius: '2px',
    background: `color-mix(in oklab, ${vars.color.up} 70%, ${vars.color.mutedForeground})`,
    transition: 'width 0.6s cubic-bezier(0.22, 1, 0.36, 1)',
});

export const controls = style({ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' });

const slideIn = keyframes({
    from: { opacity: 0, transform: 'translateY(-4px)' },
    to: { opacity: 1, transform: 'none' },
});

export const alerts = style({
    display: 'flex',
    gap: '14px',
    alignItems: 'center',
    padding: '0 12px 6px',
    minHeight: '18px',
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
});
export const alert = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    whiteSpace: 'nowrap',
    animation: `${slideIn} 0.4s ease-out`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
});
export const alertIcon = style({ color: vars.color.amber, flexShrink: 0 });
export const alertTime = style({ ...mono, color: vars.color.mutedForeground });
export const alertName = style({ color: vars.color.foreground, fontWeight: 600 });

export const body = style({ position: 'relative', flex: 1, minHeight: 0, display: 'flex', minWidth: 0 });

export const empty = style({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '24px',
    textAlign: 'center',
    color: vars.color.mutedForeground,
    fontSize: '0.74rem',
});
export const emptyIcon = style({ color: vars.color.mutedForeground, opacity: 0.7 });
export const emptyTitle = style({ color: vars.color.foreground, fontWeight: 600, fontSize: '0.8rem' });

export const note = style({
    padding: '4px 12px 6px',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    ...ellipsis,
});
