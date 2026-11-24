// src/components/apply-guide.css.ts — 首次設定的「申請 API Key」導覽側欄。
// 申請視窗開著時這張卡片貼在主視窗左側，右側讓給原生申請視窗。

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
const SUPPORTS_MIX = '(color: color-mix(in srgb, red 50%, transparent))';
const focusRing = { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 } as const;

export const card = style({
    display: 'flex', flexDirection: 'column', minHeight: 0,
    width: 'min(28rem, 92vw)', maxHeight: '92vh', boxSizing: 'border-box',
    fontSize: '0.875rem', color: vars.color.foreground,
    background: vars.color.panelRaised, border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)', overflow: 'hidden',
});

export const header = style({
    display: 'flex', alignItems: 'center', gap: '0.625em', flexShrink: 0,
    padding: '1em 1.25em 0.875em', borderBottom: `1px solid ${vars.color.border}`,
});
export const brand = style({ fontFamily: vars.font.display, fontWeight: 700, fontSize: '1em' });
export const brandSub = style({ color: vars.color.mutedForeground, fontSize: '0.86em' });
export const headerSpacer = style({ flex: 1 });
export const sync = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.375em', fontSize: '0.78em',
    color: vars.color.mutedForeground, whiteSpace: 'nowrap',
});
const blink = keyframes({ '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } });
export const syncDot = style({
    width: 7, height: 7, borderRadius: '50%', background: vars.color.success,
    animation: `${blink} 2.4s ease-in-out infinite`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
});

// ── 進度 ──────────────────────────────────────────────────────────────
export const progress = style({
    display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '0.25em',
    padding: '0.875em 1.25em 0.25em', flexShrink: 0, margin: 0, listStyle: 'none',
});
const progressItemBase = style({
    display: 'flex', flexDirection: 'column', gap: '0.375em', minWidth: 0,
    border: 0, background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left',
    color: vars.color.mutedForeground, fontSize: '0.72em', fontFamily: 'inherit',
    selectors: { '&:focus-visible': focusRing, '&:disabled': { cursor: 'default' } },
});
export const progressItem = styleVariants({
    todo: [progressItemBase],
    current: [progressItemBase, { color: vars.color.accent, fontWeight: 650 }],
    done: [progressItemBase, { color: vars.color.foreground }],
});
const barBase = style({ height: 3, borderRadius: 2, background: vars.color.border });
export const progressBar = styleVariants({
    todo: [barBase],
    current: [barBase, { background: vars.color.accent }],
    done: [barBase, { background: tint(vars.color.accent, 55), '@supports': { [`not ${SUPPORTS_MIX}`]: { background: vars.color.accent, opacity: 0.55 } } }],
});
export const progressLabel = style({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

// ── 內容 ──────────────────────────────────────────────────────────────
export const body = style({
    display: 'flex', flexDirection: 'column', gap: '1em', minHeight: 0, overflowY: 'auto',
    padding: '1em 1.25em 1.25em',
});
export const stepEyebrow = style({ margin: 0, fontSize: '0.75em', color: vars.color.mutedForeground, fontFamily: vars.font.mono, letterSpacing: '0.02em' });
export const title = style({ margin: 0, fontFamily: vars.font.display, fontSize: '1.2em', lineHeight: 1.35, fontWeight: 700 });
export const lead = style({ margin: 0, lineHeight: 1.7, color: vars.color.foreground });

export const hero = style({ display: 'flex', flexDirection: 'column', gap: '0.75em', alignItems: 'flex-start' });
export const heroIcon = style({
    width: '2.75em', height: '2.75em', borderRadius: '0.75em', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: vars.color.accentDim, color: vars.color.accent,
});

export const points = style({ display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none', border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.md, background: vars.color.panel });
export const point = style({
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: '0.75em', alignItems: 'start',
    padding: '0.75em 0.875em',
    selectors: { '& + &': { borderTop: `1px solid ${vars.color.border}` } },
});
export const pointWithIcon = style([point, { gridTemplateColumns: '1.25em minmax(0, 1fr)' }]);
export const pointIcon = style({ color: vars.color.accent, display: 'flex', height: '1.6em', alignItems: 'center' });
export const pointText = style({ display: 'flex', flexDirection: 'column', gap: '0.25em', minWidth: 0 });
export const pointTitle = style({ margin: 0, fontWeight: 650, lineHeight: 1.5, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.25em 0.5em' });
export const pointBody = style({ margin: 0, color: vars.color.mutedForeground, lineHeight: 1.65, fontSize: '0.93em' });
const tagBase = style({ fontSize: '0.72em', fontWeight: 600, padding: '0.1em 0.5em', borderRadius: 999, border: '1px solid', lineHeight: 1.5 });
export const tag = styleVariants({
    recommend: [tagBase, { color: vars.color.success, borderColor: 'rgba(80, 190, 120, 0.45)', '@supports': { [SUPPORTS_MIX]: { borderColor: tint(vars.color.success, 45) } } }],
    caution: [tagBase, { color: vars.color.amber, borderColor: 'rgba(224, 164, 60, 0.45)', '@supports': { [SUPPORTS_MIX]: { borderColor: tint(vars.color.amber, 45) } } }],
});
export const locate = style({
    display: 'inline-flex', alignItems: 'center', gap: '0.3em', height: '1.9em', padding: '0 0.6em',
    border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.panelRaised,
    color: vars.color.mutedForeground, fontSize: '0.8em', fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
    selectors: {
        '&:hover:not(:disabled)': { color: vars.color.accent, borderColor: vars.color.accent },
        '&:focus-visible': focusRing,
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

export const actions = style({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5em' });
export const primaryLarge = style({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5em',
    height: '2.75em', padding: '0 1.25em', borderRadius: vars.radius.md, cursor: 'pointer',
    border: `1px solid ${vars.color.accent}`, background: vars.color.accentDim, color: vars.color.accent,
    fontFamily: vars.font.display, fontSize: '1em', fontWeight: 700,
    selectors: {
        '&:hover:not(:disabled)': { boxShadow: `inset 0 0 0 1px ${vars.color.accent}` },
        '&:focus-visible': focusRing,
        '&:disabled': { opacity: 0.5, cursor: 'default' },
    },
});
export const quietLinks = style({ display: 'flex', flexWrap: 'wrap', gap: '0.5em 1.25em', fontSize: '0.9em' });

export const footer = style({
    display: 'flex', alignItems: 'center', gap: '0.5em', flexShrink: 0,
    padding: '0.75em 1.25em', borderTop: `1px solid ${vars.color.border}`, background: vars.color.panel,
});
export const footerHint = style({ flex: 1, minWidth: 0, color: vars.color.mutedForeground, fontSize: '0.8em', lineHeight: 1.5 });

// 完成
export const doneBox = style({
    display: 'grid', gridTemplateColumns: '2.5em minmax(0, 1fr)', columnGap: '0.75em', alignItems: 'center',
    padding: '0.875em', borderRadius: vars.radius.md, border: '1px solid rgba(80, 190, 120, 0.45)', background: 'rgba(80, 190, 120, 0.08)',
    '@supports': { [SUPPORTS_MIX]: { borderColor: tint(vars.color.success, 40), background: tint(vars.color.success, 8) } },
});
export const doneIcon = style({
    width: '2.5em', height: '2.5em', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: vars.color.success,
});
export const doneName = style({ margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5em', flexWrap: 'wrap' });
export const doneMeta = style({ margin: 0, color: vars.color.mutedForeground, fontSize: '0.88em', fontFamily: vars.font.mono });
export const simBadge = style({
    fontSize: '0.75em', fontWeight: 600, padding: '0.1em 0.5em', borderRadius: 999,
    color: vars.color.accent, background: vars.color.accentDim, fontFamily: vars.font.body,
});
export const sectionTitle = style({ margin: 0, fontSize: '0.92em', fontWeight: 650, display: 'flex', alignItems: 'center', gap: '0.4em' });
export const numbered = style({
    width: '1.5em', height: '1.5em', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.75em', fontWeight: 700, fontFamily: vars.font.mono, background: vars.color.muted, color: vars.color.mutedForeground,
});
export const pointNumbered = style([point, { gridTemplateColumns: '1.5em minmax(0, 1fr)' }]);
export const linkRow = style({ display: 'flex', flexWrap: 'wrap', gap: '0.25em 1em', marginTop: '0.25em', fontSize: '0.9em' });
