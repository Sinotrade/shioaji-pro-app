// src/components/portfolio-lanes.css.ts — 持股「資金通道」variant.
//
// Same visual language as 排行 (chain-map.css.ts): hairline structure, muted
// up/down tones, a dotted centre axis, translucent lanes with a small head,
// light particles on a canvas above. Up/down only for price, P&L and flow
// direction; accent only for selection.

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const mono = { fontFamily: vars.font.mono, fontVariantNumeric: 'tabular-nums' } as const;
const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const reduce = { '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none', animation: 'none' } } } as const;
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
const soft = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, ${vars.color.mutedForeground})`;
const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Applied when the viewer asked for reduced motion. */
export const still = style({ transition: 'none !important', animation: 'none !important' });

export const tone = styleVariants({
    up: { color: soft(vars.color.up, 80) },
    down: { color: soft(vars.color.down, 80) },
    flat: { color: vars.color.mutedForeground },
});

export const root = style({ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minWidth: 0 });

// name | lane | 淨流入 | 權重 | 今日損益 — set per width by the component (--cols / --gap)
const COLUMNS = 'var(--cols)';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `6px ${vars.space.md} 0`,
    minHeight: '26px',
});
export const title = style({ fontSize: '0.78rem', fontWeight: 650, color: vars.color.foreground, whiteSpace: 'nowrap' });
export const note = style({ marginLeft: 'auto', fontSize: '0.6rem', color: vars.color.mutedForeground, ...ellipsis, minWidth: 0 });

// window switch: 近 5 分／近 10 分／累計 (small, quiet)
export const windows = style({
    display: 'inline-flex',
    padding: '1px',
    borderRadius: vars.radius.md,
    background: tint(vars.color.foreground, 5),
    flexShrink: 0,
});
const windowBase = style({
    border: 0,
    margin: 0,
    font: 'inherit',
    fontSize: '0.6rem',
    padding: '2px 7px',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    background: 'transparent',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    selectors: { '&:focus-visible': { outline: `1px solid ${vars.color.accent}` } },
});
export const windowBtn = styleVariants({
    on: [windowBase, { background: vars.color.panelRaised, color: vars.color.foreground, boxShadow: `0 0 0 1px ${tint(vars.color.foreground, 8)}` }],
    off: [windowBase, { selectors: { '&:hover': { color: vars.color.foreground } } }],
});

export const axis = style({
    display: 'grid',
    gridTemplateColumns: COLUMNS,
    columnGap: 'var(--gap)',
    padding: `8px calc(${vars.space.md} + ${vars.space.sm}) 3px`,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});
export const axisTrack = style({ position: 'relative', height: '14px' });
export const axisSide = style({ position: 'absolute', top: 0, padding: '0 7px', whiteSpace: 'nowrap', fontWeight: 600 });
export const axisNum = style({ textAlign: 'right', whiteSpace: 'nowrap' });

export const stage = style({ position: 'relative', flex: 1, minHeight: 0, display: 'flex' });
export const area = style({ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' });
export const canvas = style({ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 });
export const rows = style({ position: 'relative', margin: `2px ${vars.space.md}` });

// one dotted centre axis drawn per row so it travels with the list
export const zero = style({
    position: 'absolute',
    left: '50%',
    top: '-6px',
    bottom: '-6px',
    width: '1px',
    backgroundImage: `linear-gradient(to bottom, ${tint(vars.color.mutedForeground, 45)} 50%, transparent 50%)`,
    backgroundSize: '1px 4px',
});

const flash = keyframes({
    '0%': { boxShadow: `inset 0 0 0 1px ${tint(vars.color.amber, 0)}`, background: tint(vars.color.amber, 0) },
    '18%': { boxShadow: `inset 0 0 0 1px ${tint(vars.color.amber, 55)}`, background: tint(vars.color.amber, 7) },
    '100%': { boxShadow: `inset 0 0 0 1px ${tint(vars.color.amber, 0)}`, background: tint(vars.color.amber, 0) },
});

const rowBase = style({
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    display: 'grid',
    gridTemplateColumns: COLUMNS,
    gridTemplateRows: 'var(--lane-h) 18px',
    columnGap: 'var(--gap)',
    alignItems: 'center',
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    cursor: 'pointer',
    transition: `transform 700ms ${ease}, opacity 300ms ease, background 300ms ease`,
    willChange: 'transform',
    selectors: { '&:hover': { opacity: 1, background: tint(vars.color.foreground, 2.5) } },
    '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
});
export const row = styleVariants({
    plain: [rowBase],
    on: [rowBase, { background: tint(vars.color.foreground, 4), boxShadow: `inset 0 0 0 1px ${tint(vars.color.accent, 38)}` }],
    off: [rowBase, { opacity: 0.6 }],
});
export const flip = style({
    position: 'absolute',
    inset: 0,
    borderRadius: vars.radius.lg,
    pointerEvents: 'none',
    animation: `${flash} 1600ms ease-out 1 forwards`,
    ...reduce,
});

export const nameBtn = style({
    gridRow: '1',
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    minWidth: 0,
    border: 0,
    padding: 0,
    margin: 0,
    font: 'inherit',
    textAlign: 'left',
    background: 'transparent',
    cursor: 'pointer',
    color: vars.color.foreground,
    selectors: { '&:focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: '2px', borderRadius: '2px' } },
});
export const nameText = style({ fontSize: '0.8rem', fontWeight: 560, ...ellipsis });
export const nameNone = style({ color: vars.color.mutedForeground, fontWeight: 500 });
export const count = style({ ...mono, fontSize: '0.6rem', color: vars.color.mutedForeground, flexShrink: 0 });
export const flipMark = style({ display: 'inline-flex', alignSelf: 'center', color: vars.color.amber, flexShrink: 0 });

// line 2 under the name: the group's own change today
export const sub = style({
    gridRow: '2',
    gridColumn: '1',
    alignSelf: 'start',
    display: 'flex',
    gap: '5px',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
});
export const subNum = style({ ...mono });

export const track = style({ gridRow: '1', gridColumn: '2', position: 'relative', height: '100%', minWidth: 0 });

const grow = ['width', 'height', 'border-radius'].map((p) => `${p} 800ms ${ease}`).join(', ');
const barBase = style({ position: 'absolute', top: '50%', transform: 'translateY(-50%)', transition: grow, ...reduce });
// translucent lane, faint at the axis, firmer toward the head
const lane = (color: string, deg: number) =>
    `linear-gradient(${deg}deg, ${tint(color, 10)}, ${tint(color, 32)} 50%, ${tint(color, 60)})`;
export const bar = styleVariants({
    in: [barBase, { background: lane(vars.color.up, 90) }],
    out: [barBase, { background: lane(vars.color.down, 270) }],
});
const headBase = style({
    position: 'absolute',
    top: '50%',
    borderRadius: '50%',
    transition: 'width 600ms, height 600ms, margin 600ms, box-shadow 600ms',
    ...reduce,
});
export const head = styleVariants({
    in: [headBase, { background: soft(vars.color.up, 70) }],
    out: [headBase, { background: soft(vars.color.down, 70) }],
});
export const headGlow = styleVariants({
    in: [headBase, { background: vars.color.up, boxShadow: `0 0 9px 1px ${tint(vars.color.up, 45)}` }],
    out: [headBase, { background: vars.color.down, boxShadow: `0 0 9px 1px ${tint(vars.color.down, 45)}` }],
});

// chips: my stocks in the group, under the lane
const chipsBase = style({
    gridRow: '2',
    gridColumn: '2',
    alignSelf: 'start',
    display: 'flex',
    gap: '4px',
    minWidth: 0,
    overflow: 'hidden',
    position: 'relative',
    zIndex: 2,
});
// chips sit under their lane: from the axis outward, largest holding nearest the axis
export const chips = styleVariants({
    start: [chipsBase],
    in: [chipsBase, { paddingLeft: 'calc(50% + 4px)' }],
    out: [chipsBase, { flexDirection: 'row-reverse', paddingRight: 'calc(50% + 4px)' }],
});
export const chip = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '4px',
    height: '16px',
    padding: '0 6px 1px',
    border: 0,
    margin: 0,
    font: 'inherit',
    fontSize: '0.62rem',
    lineHeight: '15px',
    borderRadius: vars.radius.sm,
    background: tint(vars.color.foreground, 4.5),
    color: vars.color.foreground,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    overflow: 'hidden',
    selectors: {
        '&:hover': { background: tint(vars.color.foreground, 9) },
        '&:focus-visible': { outline: `1px solid ${vars.color.accent}` },
    },
});
export const chipTier = style({ color: vars.color.mutedForeground, fontSize: '0.56rem' });
export const chipPct = style({ ...mono, fontSize: '0.6rem' });
// width ∝ the stock's weight in the portfolio
export const chipWeight = style({
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: '1.5px',
    background: tint(vars.color.foreground, 32),
    transition: `width 800ms ${ease}`,
    ...reduce,
});
export const chipMore = style({ fontSize: '0.6rem', color: vars.color.mutedForeground, alignSelf: 'center', whiteSpace: 'nowrap', flexShrink: 0 });

const numBase = style({ ...mono, gridRow: '1', fontSize: '0.74rem', textAlign: 'right', whiteSpace: 'nowrap', justifyContent: 'flex-end' });
export const net = style([numBase, { gridColumn: '3' }]);
export const weight = style([numBase, { gridColumn: '4', color: vars.color.foreground }]);
export const pnl = style([numBase, { gridColumn: '5' }]);
export const masked = style({ color: vars.color.mutedForeground, letterSpacing: '0.05em' });
// line 2 under the figures: turnover share / P&L % (quiet)
const subRight = style({ ...mono, gridRow: '2', alignSelf: 'start', fontSize: '0.58rem', textAlign: 'right', whiteSpace: 'nowrap', color: vars.color.mutedForeground });
export const netSub = style([subRight, { gridColumn: '3' }]);
export const pnlSub = style([subRight, { gridColumn: '5' }]);

export const divider = style({
    position: 'absolute',
    left: vars.space.sm,
    right: vars.space.sm,
    height: '1px',
    background: vars.color.border,
    transition: `transform 700ms ${ease}`,
    ...reduce,
});

export const waiting = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});
