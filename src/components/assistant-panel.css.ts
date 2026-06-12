// src/components/assistant-panel.css.ts

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
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
        position: 'relative', // anchors the hover-revealed fork button
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

// ---- chat sessions (history / resume / fork) ----

export const sessionBar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const sessionTitleTxt = style({
    flex: 1,
    minWidth: 0,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const sessionIconBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    flexShrink: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.4, cursor: 'default' },
});

export const sessRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `4px ${vars.space.sm}`,
});

export const sessMain = style({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    padding: 0,
});

export const sessTitle = style({
    fontSize: '0.72rem',
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const sessMeta = style({
    fontSize: '0.62rem',
    fontFamily: vars.font.mono,
    color: vars.color.mutedForeground,
});

export const msgForkBtn = style({
    position: 'absolute',
    top: '2px',
    insetInlineStart: '-24px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panel,
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    opacity: 0,
    transition: 'opacity 0.12s',
    ':hover': { color: vars.color.foreground },
});

globalStyle(`${userMsg}:hover ${msgForkBtn}`, { opacity: 1 });

// ---- slash skill palette (/ opens, ↑↓ navigates, Enter runs) ----

export const slashMenu = style({
    position: 'absolute',
    bottom: '100%',
    insetInlineStart: 0,
    insetInlineEnd: 0,
    marginBottom: '4px',
    display: 'flex',
    flexDirection: 'column',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 -8px 24px rgba(0,0,0,0.4)',
    overflow: 'hidden',
    zIndex: 30,
});

const slashItemBase = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    padding: `5px ${vars.space.sm}`,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
});

export const slashItem = styleVariants({
    off: [slashItemBase],
    on: [slashItemBase, { background: vars.color.accentDim }],
});

export const slashName = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 650,
    color: vars.color.accent,
    flexShrink: 0,
});

export const slashDesc = style({
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

// ---- Claude-Code-style tool / thinking rows ----

export const aiGroup = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    alignSelf: 'stretch',
});

export const toolRow = style({
    alignSelf: 'stretch',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    overflow: 'hidden',
});

export const toolHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 8px',
    cursor: 'pointer',
    listStyle: 'none',
    color: vars.color.mutedForeground,
    userSelect: 'none',
    ':hover': { color: vars.color.foreground },
});

globalStyle(`${toolHead}::-webkit-details-marker`, { display: 'none' });

export const toolChevron = style({
    flexShrink: 0,
    transition: 'transform 0.12s',
});

globalStyle(`${toolRow}[open] > ${toolHead} ${toolChevron}`, {
    transform: 'rotate(90deg)',
});

export const toolDotOk = style({
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    flexShrink: 0,
    background: vars.color.down, // green = success in tw convention
});

export const toolDotErr = style([toolDotOk, { background: vars.color.danger }]);

export const toolName = style({
    color: vars.color.foreground,
    fontWeight: 600,
    flexShrink: 0,
});

export const toolBrief = style({
    flex: 1,
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    opacity: 0.8,
});

export const toolDetail = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    padding: '6px 8px',
    borderTop: `1px solid ${vars.color.border}`,
});

export const toolDetailLabel = style({
    fontSize: '0.6rem',
    fontWeight: 650,
    color: vars.color.mutedForeground,
    letterSpacing: '0.06em',
});

export const toolPre = style({
    margin: 0,
    padding: '5px 7px',
    maxHeight: '200px',
    overflow: 'auto',
    fontSize: '0.62rem',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: vars.color.foreground,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const thinkRow = style({
    alignSelf: 'stretch',
    fontSize: '0.66rem',
    borderInlineStart: `2px solid ${vars.color.border}`,
    paddingInlineStart: '6px',
});

export const thinkHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 0',
    cursor: 'pointer',
    listStyle: 'none',
    color: vars.color.mutedForeground,
    fontStyle: 'italic',
    userSelect: 'none',
    ':hover': { color: vars.color.foreground },
});

globalStyle(`${thinkHead}::-webkit-details-marker`, { display: 'none' });
globalStyle(`${thinkRow}[open] > ${thinkHead} ${toolChevron}`, {
    transform: 'rotate(90deg)',
});

export const thinkBody = style({
    padding: '2px 0 4px 15px',
    color: vars.color.mutedForeground,
    fontStyle: 'italic',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
});

// rendered-markdown body for assistant text (msgBase is pre-wrap for plain
// user text; markdown supplies its own block spacing)
export const mdBody = style({
    whiteSpace: 'normal',
});

globalStyle(`${mdBody} > :first-child`, { marginTop: 0 });
globalStyle(`${mdBody} > :last-child`, { marginBottom: 0 });
globalStyle(`${mdBody} p`, { margin: '0.35em 0' });
globalStyle(`${mdBody} h1, ${mdBody} h2, ${mdBody} h3, ${mdBody} h4`, {
    fontSize: '0.78rem',
    fontWeight: 700,
    margin: '0.7em 0 0.3em',
    color: vars.color.foreground,
});
globalStyle(`${mdBody} h1`, { fontSize: '0.84rem' });
globalStyle(`${mdBody} h2`, {
    borderBottom: `1px solid ${vars.color.border}`,
    paddingBottom: '0.2em',
});
globalStyle(`${mdBody} ul, ${mdBody} ol`, {
    margin: '0.3em 0',
    paddingInlineStart: '1.3em',
});
globalStyle(`${mdBody} li`, { margin: '0.15em 0' });
globalStyle(`${mdBody} code`, {
    fontFamily: vars.font.mono,
    fontSize: '0.95em',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
    padding: '0 4px',
});
globalStyle(`${mdBody} pre`, {
    margin: '0.4em 0',
    padding: '6px 8px',
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    overflowX: 'auto',
});
globalStyle(`${mdBody} pre code`, {
    border: 'none',
    background: 'transparent',
    padding: 0,
});
globalStyle(`${mdBody} table`, {
    borderCollapse: 'collapse',
    margin: '0.4em 0',
    fontVariantNumeric: 'tabular-nums',
});
globalStyle(`${mdBody} th, ${mdBody} td`, {
    border: `1px solid ${vars.color.border}`,
    padding: '2px 8px',
    textAlign: 'left',
});
globalStyle(`${mdBody} th`, {
    background: vars.color.panel,
    fontWeight: 650,
});
globalStyle(`${mdBody} blockquote`, {
    margin: '0.4em 0',
    paddingInlineStart: '0.8em',
    borderInlineStart: `2px solid ${vars.color.accent}`,
    color: vars.color.mutedForeground,
});
globalStyle(`${mdBody} hr`, {
    border: 'none',
    borderTop: `1px solid ${vars.color.border}`,
    margin: '0.6em 0',
});
globalStyle(`${mdBody} a`, { color: vars.color.accent });
globalStyle(`${mdBody} strong`, { fontWeight: 700 });

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
