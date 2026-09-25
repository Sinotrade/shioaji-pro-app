// src/components/pending-triggers.css.ts — 觸價單待確認 panel (#144).

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const panel = style({
    position: 'fixed',
    left: '50%',
    bottom: vars.space.lg,
    transform: 'translateX(-50%)',
    width: 'min(560px, calc(100vw - 32px))',
    maxHeight: '50vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    padding: '8px 10px',
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
    fontSize: '0.78rem',
    fontWeight: 700,
    color: vars.color.danger,
});

export const hint = style({
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const row = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    padding: '5px 7px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    overflowWrap: 'break-word',
});

export const line = style({ fontFamily: vars.font.mono });

export const message = style({ color: vars.color.amber });

export const actions = style({
    display: 'flex',
    gap: vars.space.xs,
    flexWrap: 'wrap',
});

export const button = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
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

export const primary = style([button, {
    borderColor: vars.color.danger,
    color: vars.color.danger,
}]);
