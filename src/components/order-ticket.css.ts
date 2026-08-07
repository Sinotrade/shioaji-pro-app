// src/components/order-ticket.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const body = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.md,
    // the ticket sits directly inside the panel section (overflow:hidden);
    // with the split section (分倉) open the content can exceed the panel
    // height — the body itself must scroll or the exec button becomes
    // unreachable at compact panel sizes.
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
});

export const sideTabs = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.xs,
});

const sideBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.8rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '7px 0',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
});

export const buyTab = styleVariants({
    off: [sideBase, { ':hover': { color: vars.color.up } }],
    on: [
        sideBase,
        {
            color: '#fff',
            background: vars.color.up,
            borderColor: vars.color.up,
        },
    ],
});

export const sellTab = styleVariants({
    off: [sideBase, { ':hover': { color: vars.color.down } }],
    on: [
        sideBase,
        {
            color: '#fff',
            background: vars.color.down,
            borderColor: vars.color.down,
        },
    ],
});

export const fieldRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
});

export const fieldLabel = style({
    width: '3.4rem',
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    flexShrink: 0,
});

export const numInput = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.92rem',
    fontWeight: 600,
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '5px 8px',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    ':focus': {
        borderColor: vars.color.accent,
    },
});

export const stepBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.8rem',
    fontWeight: 600,
    width: '26px',
    height: '30px',
    cursor: 'pointer',
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    ':hover': {
        borderColor: vars.color.borderBright,
        background: vars.color.panelRaised,
    },
});

export const segGroup = style({
    display: 'flex',
    flex: 1,
    gap: '2px',
});

const segBase = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 500,
    padding: '4px 0',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
});

export const seg = styleVariants({
    off: [segBase, { ':hover': { color: vars.color.foreground } }],
    on: [
        segBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
});

const iconToggleBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    flexShrink: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    transition: 'all 0.12s',
});

export const iconToggle = styleVariants({
    off: [
        iconToggleBase,
        { ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright } },
    ],
    on: [
        iconToggleBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});

const execBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.82rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '9px 0',
    marginTop: vars.space.xs,
    cursor: 'pointer',
    border: '1px solid',
    borderRadius: vars.radius.sm,
    transition: 'all 0.12s',
    ':disabled': { opacity: 0.35, cursor: 'not-allowed' },
});

export const execBtn = styleVariants({
    buy: [
        execBase,
        {
            color: '#fff',
            background: vars.color.up,
            borderColor: vars.color.up,
            ':hover': { filter: 'brightness(1.1)' },
        },
    ],
    sell: [
        execBase,
        {
            color: '#fff',
            background: vars.color.down,
            borderColor: vars.color.down,
            ':hover': { filter: 'brightness(1.1)' },
        },
    ],
    armed: [
        execBase,
        {
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            animation: 'pulse-glow 0.9s infinite',
        },
    ],
});

// ---- account chip (multi-account routing) ----

export const chipRow = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    minWidth: 0,
});

const chipBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    maxWidth: '100%',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    padding: '3px 8px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const acctChip = styleVariants({
    // single signed account — pure display, no affordance
    single: [chipBase, { cursor: 'default' }],
    // >=2 accounts — clickable, switches the GLOBAL selected account
    multi: [
        chipBase,
        {
            cursor: 'pointer',
            ':hover': {
                borderColor: vars.color.borderBright,
                background: vars.color.muted,
            },
        },
    ],
    // production mode — danger outline as the wrong-account last line of
    // defense (danger applies whether clickable or not)
    dangerSingle: [
        chipBase,
        { cursor: 'default', borderColor: vars.color.danger },
    ],
    dangerMulti: [
        chipBase,
        {
            cursor: 'pointer',
            borderColor: vars.color.danger,
            ':hover': { background: vars.color.muted },
        },
    ],
});

export const prodTag = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: vars.color.danger,
    flexShrink: 0,
});

export const acctMenu = style({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    zIndex: 50,
    minWidth: '13rem',
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    padding: '3px',
    gap: '2px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
});

const acctMenuItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    padding: '5px 8px',
    cursor: 'pointer',
    textAlign: 'left',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const acctMenuItem = styleVariants({
    off: [acctMenuItemBase, { ':hover': { background: vars.color.muted } }],
    on: [
        acctMenuItemBase,
        {
            color: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
});

// ---- split-order (分倉) section ----

export const splitBox = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    padding: vars.space.sm,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const splitAcctLabel = style({
    flexShrink: 0,
    width: '7.6rem',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const splitInput = style({
    flex: 1,
    minWidth: '3rem',
    fontFamily: vars.font.mono,
    fontSize: '0.78rem',
    fontWeight: 600,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const splitUnit = style({
    flexShrink: 0,
    width: '1.4rem',
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const splitHint = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const splitError = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 600,
    color: vars.color.danger,
    fontVariantNumeric: 'tabular-nums',
});

export const previewTable = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `${vars.space.xs} 0 0`,
    borderTop: `1px dashed ${vars.color.border}`,
});

export const previewRow = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.xs,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});

export const previewTotal = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.xs,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.accent,
});

export const presetRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap',
});

export const presetSelect = style({
    flex: 1,
    minWidth: '5rem',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.foreground,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const presetInput = style({
    flex: 1,
    minWidth: '4rem',
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    color: vars.color.foreground,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const presetBtn = style({
    flexShrink: 0,
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    fontWeight: 500,
    padding: '3px 8px',
    cursor: 'pointer',
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

export const costRow = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const feedback = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    minHeight: '1.2em',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
});
