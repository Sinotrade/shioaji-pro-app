// src/components/assistant-panel.css.ts

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

export const setup = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.lg,
});

export const setupTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.86rem',
    fontWeight: 700,
});

export const setupHint = style({
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.6,
});

export const keyInput = style({
    fontFamily: vars.font.mono,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '6px 10px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const messages = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.sm,
});

export const emptyHint = style({
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.8,
    padding: vars.space.md,
});

const msgBase = style({
    maxWidth: '88%',
    fontSize: '0.74rem',
    lineHeight: 1.6,
    padding: `6px 10px`,
    borderRadius: vars.radius.md,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
});

export const userMsg = style([
    msgBase,
    {
        alignSelf: 'flex-end',
        background: vars.color.accentDim,
        color: vars.color.foreground,
        border: `1px solid ${vars.color.accent}`,
    },
]);

export const aiMsg = style([
    msgBase,
    {
        alignSelf: 'flex-start',
        background: vars.color.inset,
        border: `1px solid ${vars.color.border}`,
        color: vars.color.foreground,
    },
]);

export const proposalCard = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginTop: '6px',
    padding: vars.space.sm,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.amber}`,
    borderRadius: vars.radius.sm,
});

export const proposalTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 700,
    color: vars.color.amber,
});

export const proposalBody = style({
    fontFamily: vars.font.mono,
    fontSize: '0.74rem',
    fontWeight: 600,
});

export const proposalReason = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 400,
    color: vars.color.mutedForeground,
});

export const proposalBtns = style({
    display: 'flex',
    gap: vars.space.sm,
});

export const confirmBtn = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.7rem',
    fontWeight: 700,
    color: '#fff',
    background: vars.color.up,
    border: 'none',
    borderRadius: vars.radius.sm,
    padding: '5px 0',
    cursor: 'pointer',
});

export const rejectBtn = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '5px 0',
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground },
});

export const proposalDone = style({
    fontSize: '0.7rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

export const inputRow = style({
    display: 'flex',
    gap: vars.space.xs,
    padding: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const chatInput = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '5px 10px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const sendBtn = style({
    fontFamily: vars.font.display,
    fontSize: '0.7rem',
    fontWeight: 600,
    color: vars.color.accent,
    background: vars.color.accentDim,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    padding: '5px 14px',
    cursor: 'pointer',
    ':disabled': { opacity: 0.5, cursor: 'not-allowed' },
});

export const disclaimer = style({
    padding: `2px ${vars.space.sm} 4px`,
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
    textAlign: 'center',
    flexShrink: 0,
});

// ---- agent panel tabs / lists / forms ----

export const tabBar = style({
    display: 'flex',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm} 0`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const tabBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.68rem',
    fontWeight: 500,
    padding: '5px 10px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.foreground },
});

export const tabOn = style([
    tabBase,
    {
        color: vars.color.foreground,
        fontWeight: 600,
        borderBottomColor: vars.color.accent,
    },
]);

export const tabOff = tabBase;

export const listCol = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: vars.space.sm,
});

export const formCol = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.sm,
});

export const formRow = style({
    display: 'flex',
    gap: vars.space.xs,
});

// chatInput/formSelect carry flex:1 for horizontal rows — as direct children
// of the vertical formCol that would stretch them to fill the panel height
globalStyle(`${formCol} > input, ${formCol} > select`, {
    flex: '0 0 auto',
});

export const formArea = style({
    minHeight: '7rem',
    resize: 'vertical',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    lineHeight: 1.6,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '6px 10px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const formSelect = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 8px',
    outline: 'none',
});

export const itemRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `4px ${vars.space.sm}`,
});

export const itemMain = style({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: vars.color.foreground,
});

export const itemTitle = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
});

export const itemSub = style({
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
});

export const itemBadge = style({
    fontFamily: vars.font.mono,
    fontSize: '0.58rem',
    fontWeight: 500,
    color: vars.color.accent,
    background: vars.color.accentDim,
    borderRadius: '999px',
    padding: '1px 7px',
});

export const itemIconBtn = style({
    width: '22px',
    height: '22px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    flexShrink: 0,
    ':hover': { color: vars.color.foreground },
});

export const toggleOn = style([
    itemIconBtn,
    {
        color: vars.color.down,
        borderColor: vars.color.down,
        background: vars.color.downDim,
    },
]);

export const toggleOff = itemIconBtn;

export const warnLine = style({
    fontSize: '0.62rem',
    color: vars.color.amber,
});

export const toolNote = style({
    display: 'inline-block',
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    background: vars.color.muted,
    borderRadius: '999px',
    padding: '1px 8px',
    marginRight: '4px',
});
