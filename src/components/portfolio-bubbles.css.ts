// src/components/portfolio-bubbles.css.ts — 持股泡泡

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const mono = { fontFamily: vars.font.mono, fontVariantNumeric: 'tabular-nums' } as const;
const tint = (c: string, pct: number) => `color-mix(in oklab, ${c} ${pct}%, transparent)`;
const soft = (c: string, pct: number) => `color-mix(in oklab, ${c} ${pct}%, ${vars.color.mutedForeground})`;
const reduce = { '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none', animation: 'none' } } } as const;

export const root = style({ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' });
export const svg = style({ position: 'absolute', inset: 0, display: 'block' });

export const bar = style({
    position: 'absolute',
    top: '2px',
    left: '12px',
    right: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    zIndex: 2,
    pointerEvents: 'none',
});
export const barControls = style({ pointerEvents: 'auto' });
export const barHint = style({ fontSize: '0.62rem', color: vars.color.mutedForeground, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });

export const grid = style({ stroke: tint(vars.color.border, 38) });
export const axis = style({ stroke: tint(vars.color.mutedForeground, 38) });
export const diagonal = style({ stroke: tint(vars.color.mutedForeground, 40), strokeDasharray: '3 4', fill: 'none' });
export const tick = style({ fill: vars.color.mutedForeground, fontSize: '10.5px', fontFamily: vars.font.mono });
export const caption = style({ fill: vars.color.mutedForeground, fontSize: '11px', fontFamily: vars.font.body });
export const corner = style({ fill: vars.color.mutedForeground, fontSize: '11px', fontWeight: 600, fontFamily: vars.font.body, opacity: 0.8 });

// group columns: every stock of a group shares the group's x
export const guide = style({
    stroke: tint(vars.color.mutedForeground, 26),
    strokeDasharray: '2 4',
    transition: 'stroke 0.3s ease',
});
export const guideOn = style({ stroke: tint(vars.color.accent, 70), strokeDasharray: 'none' });
export const groupTag = style({ cursor: 'pointer' });
export const groupName = style({
    fill: vars.color.foreground,
    fontSize: '10.5px',
    fontWeight: 600,
    fontFamily: vars.font.body,
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3,
    strokeLinejoin: 'round',
});
export const groupNameDim = style({ opacity: 0.35 });
export const groupWeight = style({
    fill: vars.color.mutedForeground,
    fontSize: '9.5px',
    fontFamily: vars.font.mono,
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3,
});
export const groupFlowDot = styleVariants({
    up: { fill: soft(vars.color.up, 88) },
    down: { fill: soft(vars.color.down, 88) },
    flat: { fill: vars.color.mutedForeground },
});

export const bubble = style({ cursor: 'pointer', outline: 'none' });
const tone = (c: string) => ({
    fill: soft(c, 80),
    stroke: soft(c, 92),
    strokeWidth: 1,
    transition: 'r 900ms cubic-bezier(0.22, 1, 0.36, 1), fill-opacity 600ms ease, stroke 600ms ease',
    selectors: { [`${bubble}:hover &, ${bubble}:focus-visible &`]: { strokeWidth: 1.6 } },
    ...reduce,
});
export const fill = styleVariants({
    up: tone(vars.color.up),
    down: tone(vars.color.down),
    flat: { ...tone(vars.color.mutedForeground), fill: tint(vars.color.mutedForeground, 40) },
});
const ring = keyframes({ from: { transform: 'scale(1)', opacity: 0.6 }, to: { transform: 'scale(1.7)', opacity: 0 } });
export const pulse = style({
    fill: 'none',
    stroke: vars.color.amber,
    strokeWidth: 1.2,
    transformBox: 'fill-box',
    transformOrigin: 'center',
    animation: `${ring} 1.4s ease-out forwards`,
    ...reduce,
});
export const selected = style({ fill: 'none', stroke: tint(vars.color.accent, 85), strokeWidth: 1.4 });

export const nameIn = style({ fill: vars.color.foreground, fontWeight: 650, fontFamily: vars.font.body, pointerEvents: 'none' });
export const valueIn = style({ fill: vars.color.foreground, opacity: 0.8, fontFamily: vars.font.mono, pointerEvents: 'none' });
export const nameOut = style({
    fill: vars.color.foreground,
    fontSize: '9.5px',
    fontWeight: 600,
    fontFamily: vars.font.body,
    pointerEvents: 'none',
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3,
    strokeLinejoin: 'round',
});
export const label = style({ pointerEvents: 'none' });

export const side = style({
    position: 'absolute',
    right: '12px',
    bottom: '66px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    padding: '6px 8px',
    borderRadius: '6px',
    background: tint(vars.color.panelRaised, 88),
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    zIndex: 2,
});
export const sideRow = style({ display: 'flex', gap: '8px', justifyContent: 'space-between', cursor: 'pointer', border: 0, background: 'none', padding: 0, color: 'inherit', font: 'inherit' });
export const sideName = style({ color: vars.color.foreground, fontWeight: 600 });
export const sideNum = style({ ...mono });
export const toneText = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.mutedForeground },
});

export const empty = style({
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    padding: '8px 14px',
    borderRadius: '6px',
    background: tint(vars.color.panelRaised, 90),
    color: vars.color.mutedForeground,
    fontSize: '0.7rem',
    textAlign: 'center',
    maxWidth: '360px',
    zIndex: 3,
});

// ── grouped (A2): one enclosing circle per held group ──
export const sector = style({ cursor: 'pointer', outline: 'none' });
const sectorTone = (c: string) => ({
    fill: tint(c, 7),
    stroke: soft(c, 55),
    strokeWidth: 1,
    transition: 'r 900ms cubic-bezier(0.22, 1, 0.36, 1), fill 600ms ease, stroke 600ms ease',
    selectors: { [`${sector}:hover &, ${sector}:focus-visible &`]: { fill: tint(c, 12), stroke: soft(c, 80) } },
    ...reduce,
});
export const sectorRim = styleVariants({
    up: sectorTone(vars.color.up),
    down: sectorTone(vars.color.down),
    flat: sectorTone(vars.color.mutedForeground),
});
export const sectorSelected = style({ fill: 'none', stroke: tint(vars.color.accent, 85), strokeWidth: 1.5 });
export const sectorLabel = style({ pointerEvents: 'none' });
const halo = {
    paintOrder: 'stroke',
    stroke: vars.color.panel,
    strokeWidth: 3.5,
    strokeLinejoin: 'round',
} as const;
export const sectorName = style({ ...halo, fill: vars.color.foreground, fontSize: '11.5px', fontWeight: 650, fontFamily: vars.font.body });
export const sectorMeta = style({ ...halo, fill: vars.color.mutedForeground, fontSize: '10px', fontFamily: vars.font.mono, fontWeight: 500 });
export const sectorFlow = styleVariants({
    up: { ...halo, fill: soft(vars.color.up, 92), fontSize: '10px', fontFamily: vars.font.mono, fontWeight: 600 },
    down: { ...halo, fill: soft(vars.color.down, 92), fontSize: '10px', fontFamily: vars.font.mono, fontWeight: 600 },
    flat: { ...halo, fill: vars.color.mutedForeground, fontSize: '10px', fontFamily: vars.font.mono, fontWeight: 600 },
});
export const cornerSoft = style({ fill: vars.color.mutedForeground, fontSize: '10.5px', fontFamily: vars.font.body, opacity: 0.55 });
export const member = style({ cursor: 'pointer', outline: 'none' });
