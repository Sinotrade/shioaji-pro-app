// src/components/pending-confirm.css.ts — 委託待確認卡 (#201 ③). Same card
// language as the bracket entry confirmation (title + 問號說明, chips,
// numbered steps, one primary button, muted footnote).

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const dangerMix = (pct: number, fallback: string) =>
    [fallback, `color-mix(in srgb, ${vars.color.danger} ${pct}%, transparent)`];

export const panel = style({
    position: 'fixed',
    right: vars.space.lg,
    bottom: vars.space.lg,
    width: 'min(420px, calc(100vw - 32px))',
    maxHeight: '70vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: '10px 12px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
    zIndex: 1001,
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    '@media': {
        'screen and (max-width: 520px)': { right: '16px', bottom: '16px' },
    },
});

export const panelQuiet = style([panel, { borderColor: vars.color.borderBright }]);
export const panelCollapsed = style([panel, { width: 'auto', maxWidth: 'calc(100vw - 32px)' }]);

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const title = style({
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '6px',
    fontSize: '0.84rem',
    fontWeight: 700,
    color: vars.color.danger,
});

export const titleQuiet = style([title, { color: vars.color.foreground }]);

export const count = style({
    fontSize: '0.7rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

export const banner = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    padding: '6px 8px',
    borderRadius: vars.radius.sm,
    color: vars.color.danger,
    background: dangerMix(10, 'rgba(242, 54, 69, 0.1)'),
    border: `1px solid ${vars.color.border}`,
    fontWeight: 600,
    lineHeight: 1.5,
});

const cardBase = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px',
    borderRadius: vars.radius.sm,
    background: vars.color.background,
    border: `1px solid ${vars.color.border}`,
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
});
export const cardConfirm = style([cardBase, { borderLeft: `3px solid ${vars.color.danger}` }]);
export const cardExpired = style([cardBase, { borderLeft: `3px solid ${vars.color.borderBright}` }]);

export const cardTitle = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontWeight: 700,
    color: vars.color.danger,
});
export const cardTitleQuiet = style([cardTitle, { color: vars.color.mutedForeground }]);

export const grow = style({ flex: 1, minWidth: 0 });

export const product = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: '6px',
});
export const productName = style({ fontSize: '0.9rem', fontWeight: 700 });
export const code = style({ fontFamily: vars.font.mono, fontSize: '0.68rem', color: vars.color.mutedForeground });

export const chips = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
});

export const chip = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});
export const chipBuy = style([chip, { color: vars.color.up, fontWeight: 700 }]);
export const chipSell = style([chip, { color: vars.color.down, fontWeight: 700 }]);
export const chipExpired = style([chip, {
    fontFamily: vars.font.body,
    fontWeight: 700,
    color: vars.color.mutedForeground,
    borderColor: vars.color.borderBright,
}]);

export const stepRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
});

export const stepLabel = style({
    fontWeight: 600,
    minWidth: '1.2em',
});

export const choices = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingLeft: '1.6em',
});

export const choice = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    lineHeight: 1.45,
    cursor: 'pointer',
    selectors: { '&:has(input:disabled)': { cursor: 'default', opacity: 0.6 } },
});

export const iconButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: 0,
    cursor: 'pointer',
    background: 'transparent',
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    ':hover': { borderColor: vars.color.borderBright },
});

export const button = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontFamily: vars.font.display,
    fontSize: '0.7rem',
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '2px 8px',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.5, cursor: 'default' },
});

export const primary = style({
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%',
    padding: '4px 8px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.accent}`,
    background: vars.color.accent,
    color: vars.color.background,
    ':disabled': {
        cursor: 'default',
        background: 'transparent',
        color: vars.color.mutedForeground,
        borderColor: vars.color.border,
    },
});

export const note = styleVariants({
    muted: { color: vars.color.mutedForeground, lineHeight: 1.5 },
    warn: { color: vars.color.amber, lineHeight: 1.5 },
    err: { color: vars.color.danger, lineHeight: 1.5 },
});

export const badgeWrap = style({
    position: 'fixed',
    right: vars.space.sm,
    bottom: '34px',
    zIndex: 1001,
});

export const badge = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontFamily: vars.font.display,
    fontSize: '0.7rem',
    fontWeight: 700,
    cursor: 'pointer',
    padding: '3px 8px',
    background: vars.color.panelRaised,
    color: vars.color.danger,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.sm,
});
