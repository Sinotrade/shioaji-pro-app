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

export const warn = style({
    display: 'block',
    padding: '4px 8px',
    marginTop: vars.space.xs,
    fontSize: '0.66rem',
    lineHeight: 1.5,
    color: vars.color.amber,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

// ---- 除錯區塊 ----

export const debugGrid = style({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0,1fr)',
    gap: '1px 6px',
    fontSize: '0.62rem',
    lineHeight: 1.6,
});

export const debugKey = style({
    fontFamily: vars.font.body,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const debugVal = style({
    fontFamily: vars.font.mono,
    color: vars.color.foreground,
    wordBreak: 'break-word',
});

export const debugTarget = style({
    display: 'grid',
    gridTemplateColumns: '3.8rem minmax(0,1fr)',
    gap: '0 6px',
    padding: '3px 0',
    borderTop: `1px solid ${vars.color.border}`,
    fontSize: '0.62rem',
    lineHeight: 1.5,
});

export const debugTargetCode = style({
    fontFamily: vars.font.mono,
    fontWeight: 600,
    color: vars.color.foreground,
});

export const debugTargetName = style({
    fontFamily: vars.font.body,
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const debugTargetDetail = style({
    gridColumn: '1 / -1',
    fontFamily: vars.font.mono,
    color: vars.color.mutedForeground,
    wordBreak: 'break-word',
});

export const debugWarn = style({
    gridColumn: '1 / -1',
    display: 'block',
    padding: '3px 6px',
    marginTop: '2px',
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    lineHeight: 1.5,
    color: vars.color.amber,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

// ---- 控制卡（把所有可調項集中在一張卡）----

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: `${vars.space.sm} ${vars.space.md}`,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
});

export const cardHead = style({
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
});

export const chips = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: vars.space.xs,
});

export const chip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 9px',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '999px',
    cursor: 'pointer',
});

export const chipOn = style({
    color: vars.color.accent,
    background: vars.color.accentDim,
    borderColor: vars.color.accent,
});

export const chipDot = style({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: vars.color.borderBright,
    flexShrink: 0,
});

export const chipDotOn = style({ background: vars.color.accent });

export const chipHint = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const knobRow = style({
    display: 'grid',
    gridTemplateColumns: '2.6rem minmax(0,1fr) 3.4rem',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const knobLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const knobVal = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

export const voiceRow = style({
    display: 'grid',
    gridTemplateColumns: '2.6rem minmax(0,1fr)',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const testBtn = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    marginTop: '2px',
    padding: '4px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px dashed ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':hover': {
        color: vars.color.accent,
        borderColor: vars.color.accent,
        background: vars.color.accentDim,
    },
});

// ---- 分頁（設定 / 診斷）----

export const tabs = style({
    display: 'flex',
    gap: vars.space.xs,
    padding: `0 ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const tab = style({
    padding: '5px 10px',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground },
});

export const tabActive = style({
    color: vars.color.foreground,
    borderBottomColor: vars.color.accent,
});

export const tabBadge = style({
    marginLeft: '4px',
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const pane = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${vars.space.sm} ${vars.space.md} ${vars.space.md}`,
    display: 'flex',
    flexDirection: 'column',
});

// ---- 診斷頁的計數格 ----

export const counterGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0,1fr))',
    gap: vars.space.xs,
    marginTop: vars.space.xs,
});

export const counterCell = style({
    padding: '4px 6px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const counterKey = style({
    display: 'block',
    fontFamily: vars.font.mono,
    fontSize: '0.55rem',
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
});

export const counterVal = style({
    display: 'block',
    fontFamily: vars.font.mono,
    fontSize: '0.9rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});

export const diagNote = style({
    marginTop: vars.space.sm,
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});
