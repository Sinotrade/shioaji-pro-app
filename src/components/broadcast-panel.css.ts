// src/components/broadcast-panel.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: vars.color.panel,
    overflow: 'hidden',
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `6px ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const title = style({
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const badge = styleVariants({
    ok: {
        fontFamily: vars.font.mono,
        fontSize: '0.62rem',
        padding: '1px 6px',
        borderRadius: vars.radius.sm,
        color: vars.color.success,
        background: vars.color.successDim,
    },
    bad: {
        fontFamily: vars.font.mono,
        fontSize: '0.62rem',
        padding: '1px 6px',
        borderRadius: vars.radius.sm,
        color: vars.color.danger,
        background: vars.color.dangerDim,
    },
});

export const spacer = style({ flex: 1 });

export const toggle = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 600,
    padding: '3px 10px',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
});

export const toggleOn = style({
    color: vars.color.accent,
    borderColor: vars.color.accent,
    background: vars.color.accentDim,
});

export const toggleOff = style({
    color: vars.color.mutedForeground,
    borderColor: vars.color.border,
    background: 'transparent',
});

export const scroller = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${vars.space.sm} ${vars.space.md} ${vars.space.md}`,
});

export const sectionTitle = style({
    display: 'block',
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
    padding: `${vars.space.md} 0 ${vars.space.xs}`,
});

export const settingsGrid = style({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0,1fr) auto',
    alignItems: 'center',
    gap: `${vars.space.xs} ${vars.space.sm}`,
    fontSize: '0.7rem',
});

export const settingLabel = style({
    fontFamily: vars.font.body,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const settingValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

export const slider = style({
    width: '100%',
    accentColor: vars.color.accent,
});

export const select = style({
    gridColumn: '1 / -1',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    padding: '3px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.foreground,
});

export const targetRow = style({
    display: 'grid',
    gridTemplateColumns: '3.8rem minmax(0,1fr) auto auto',
    alignItems: 'center',
    columnGap: vars.space.sm,
    width: '100%',
    padding: '3px 0',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const code = style({
    fontWeight: 600,
    color: vars.color.foreground,
});

export const name = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const price = style({
    textAlign: 'right',
    color: vars.color.foreground,
    fontWeight: 600,
});

export const removeBtn = style({
    fontSize: '0.7rem',
    lineHeight: 1,
    padding: '2px 5px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.danger, borderColor: vars.color.danger },
});

export const addRow = style({
    position: 'relative',
    paddingTop: vars.space.sm,
});

export const addInput = style({
    width: '100%',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    padding: '4px 8px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    ':focus': { outline: `1px solid ${vars.color.accent}` },
});

export const suggestBox = style({
    position: 'absolute',
    zIndex: 20,
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 2,
    maxHeight: 180,
    overflowY: 'auto',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
});

export const suggestRow = style({
    display: 'grid',
    gridTemplateColumns: '3.8rem minmax(0,1fr) auto',
    alignItems: 'center',
    gap: vars.space.sm,
    width: '100%',
    padding: '4px 8px',
    fontSize: '0.7rem',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.foreground,
    ':hover': { background: vars.color.muted },
});

export const suggestCode = style({
    fontFamily: vars.font.mono,
    fontWeight: 600,
});

export const suggestName = style({
    fontFamily: vars.font.body,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const suggestCat = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const logRow = style({
    display: 'grid',
    gridTemplateColumns: '3.6rem minmax(0,1fr)',
    gap: vars.space.sm,
    padding: '2px 0',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
});

export const logTime = style({
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const logText = style({
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const empty = style({
    display: 'block',
    padding: '4px 0',
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
});

export const notice = style({
    display: 'block',
    padding: '4px 8px',
    marginTop: vars.space.xs,
    fontSize: '0.66rem',
    lineHeight: 1.5,
    color: vars.color.danger,
    background: vars.color.dangerDim,
    borderRadius: vars.radius.sm,
});

// ---- 事件開關列 ----

export const switchList = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const switchRow = style({
    display: 'grid',
    gridTemplateColumns: 'auto auto minmax(0,1fr)',
    alignItems: 'baseline',
    gap: vars.space.sm,
    padding: '3px 0',
    cursor: 'pointer',
});

export const switchLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const switchHint = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});
