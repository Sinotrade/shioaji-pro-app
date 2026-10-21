// src/components/event-toasts.css.ts — prominent kind-coded toast cards.
// Sizes are em-based so the 通知大小 setting scales everything at once.

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const slideIn = keyframes({
    from: { transform: 'translateX(110%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
});

export const stack = style({
    position: 'fixed',
    top: '52px',
    right: vars.space.md,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    zIndex: 1000,
    pointerEvents: 'none',
});

const toastBase = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.6em',
    fontFamily: vars.font.body,
    fontSize: '0.78em',
    padding: '0.7em 0.9em',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.55)',
    animation: `${slideIn} 0.22s ease-out`,
});

export const toast = styleVariants({
    deal: [toastBase, { borderLeft: `4px solid ${vars.color.amber}` }],
    ok: [toastBase, { borderLeft: `4px solid ${vars.color.success}` }],
    err: [
        toastBase,
        {
            borderLeft: `4px solid ${vars.color.danger}`,
            background: vars.color.panelRaised,
            boxShadow: `0 10px 30px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(242, 54, 69, 0.25)`,
        },
    ],
    info: [toastBase, { borderLeft: `4px solid ${vars.color.accent}` }],
});

const iconBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.9em',
    height: '1.9em',
    borderRadius: '50%',
    flexShrink: 0,
    marginTop: '0.05em',
});

export const icon = styleVariants({
    deal: [
        iconBase,
        { color: vars.color.amber, background: 'rgba(224, 164, 60, 0.14)' },
    ],
    ok: [iconBase, { color: vars.color.success, background: vars.color.successDim }],
    err: [
        iconBase,
        { color: vars.color.danger, background: 'rgba(242, 54, 69, 0.14)' },
    ],
    info: [
        iconBase,
        { color: vars.color.accent, background: vars.color.accentDim },
    ],
});

export const content = style({
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.15em',
});

export const title = style({
    fontFamily: vars.font.display,
    fontSize: '0.92em',
    fontWeight: 700,
    color: vars.color.foreground,
});

const lineBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.88em',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const line = styleVariants({
    plain: [lineBase],
    up: [lineBase, { color: vars.color.up, fontWeight: 600 }],
    down: [lineBase, { color: vars.color.down, fontWeight: 600 }],
});
