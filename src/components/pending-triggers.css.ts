// src/components/pending-triggers.css.ts — 觸價單待確認 panel (#144).

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const panel = style({
    position: 'fixed',
    left: '50%',
    bottom: vars.space.lg,
    transform: 'translateX(-50%)',
    width: 'min(600px, calc(100vw - 32px))',
    maxHeight: '60vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: '10px 12px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.55)',
    zIndex: 1001,
    fontFamily: vars.font.body,
});

export const panelCollapsed = style([panel, { width: 'auto', maxWidth: 'calc(100vw - 32px)' }]);

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    justifyContent: 'space-between',
});

export const badge = style({
    position: 'fixed',
    right: vars.space.sm,
    bottom: vars.space.sm,
    zIndex: 1001,
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

export const title = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.86rem',
    fontWeight: 700,
    color: vars.color.danger,
});

export const dot = style({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: vars.color.danger,
    boxShadow: ['0 0 0 3px rgba(255, 106, 77, 0.25)', `0 0 0 3px color-mix(in srgb, ${vars.color.danger} 25%, transparent)`],
});

export const hint = style({
    fontSize: '0.7rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const row = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px 12px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    fontSize: '0.76rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    overflowWrap: 'break-word',
});

export const rowHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});

const tag = style({
    fontSize: '0.68rem',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
});
export const kindStop = style([tag, { color: vars.color.amber, background: ['rgba(224, 164, 60, 0.14)', `color-mix(in srgb, ${vars.color.amber} 14%, transparent)`] }]);
export const kindTake = style([tag, { color: vars.color.accent, background: vars.color.accentDim }]);

// 台股慣例：買進紅、賣出綠 — follows the user's up/down colour convention
export const buy = style({ fontWeight: 700, color: vars.color.up });
export const sell = style({ fontWeight: 700, color: vars.color.down });
export const orderType = style({ color: vars.color.mutedForeground });
export const detected = style({ marginLeft: 'auto', fontSize: '0.68rem', color: vars.color.mutedForeground });

export const product = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    flexWrap: 'wrap',
});
export const productName = style({ fontSize: '0.95rem', fontWeight: 700 });
export const code = style({ fontFamily: vars.font.mono, fontSize: '0.7rem', color: vars.color.mutedForeground });

export const facts = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '1px',
    background: vars.color.border,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    overflow: 'hidden',
});
export const fact = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '6px 8px',
    background: vars.color.panelRaised,
});
export const factLabel = style({ fontSize: '0.66rem', color: vars.color.mutedForeground });
export const factValue = style({ fontSize: '0.84rem', fontWeight: 600 });
export const factPast = style([factValue, { color: vars.color.danger }]);
export const factUnpast = style([factValue, { color: vars.color.amber }]);
export const factMuted = style([factValue, { color: vars.color.mutedForeground }]);

export const message = style({ fontSize: '0.72rem', lineHeight: 1.5, color: vars.color.amber });

export const actions = style({
    display: 'flex',
    gap: vars.space.sm,
    flexWrap: 'wrap',
    marginTop: '2px',
});

export const button = style({
    fontFamily: vars.font.display,
    fontSize: '0.74rem',
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '4px 10px',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.5, cursor: 'default' },
});

export const primary = style([button, {
    borderColor: vars.color.danger,
    color: vars.color.danger,
    // color-mix needs Safari 16.2+; older WKWebView keeps the rgba fallback
    background: ['rgba(255, 106, 77, 0.12)', `color-mix(in srgb, ${vars.color.danger} 12%, transparent)`],
    ':hover': { borderColor: vars.color.danger, background: ['rgba(255, 106, 77, 0.22)', `color-mix(in srgb, ${vars.color.danger} 22%, transparent)`] },
}]);
