import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const shell = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

export const statusBar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `5px ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
    flexShrink: 0,
    minWidth: 0,
});

export const badge = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: vars.color.foreground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 6px',
    whiteSpace: 'nowrap',
});

export const mutedText = style({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const quickRow = style({
    display: 'flex',
    gap: vars.space.xs,
    padding: `5px ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    overflowX: 'auto',
});

export const quickButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '24px',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '0 8px',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    ':hover': {
        borderColor: vars.color.borderBright,
        background: vars.color.muted,
    },
    ':disabled': {
        opacity: 0.45,
        cursor: 'not-allowed',
    },
});

export const transcript = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: vars.space.md,
});

export const message = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    marginBottom: vars.space.md,
});

export const messageUser = style({
    alignItems: 'flex-end',
});

export const bubble = style({
    maxWidth: '94%',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    padding: `${vars.space.sm} ${vars.space.md}`,
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    fontSize: '0.76rem',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
});

export const userBubble = style({
    background: vars.color.accentDim,
    borderColor: vars.color.accent,
});

export const toolRow = style({
    display: 'flex',
    gap: vars.space.xs,
    flexWrap: 'wrap',
});

export const toolChip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 6px',
    color: vars.color.mutedForeground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
});

export const toolOk = style({
    color: vars.color.success,
    borderColor: vars.color.success,
});

export const toolRunning = style({
    color: vars.color.accent,
    borderColor: vars.color.accent,
});

export const errorText = style({
    color: vars.color.danger,
});

export const errorBubble = style({
    borderColor: vars.color.danger,
    color: vars.color.danger,
});

export const tableWrap = style({
    width: '100%',
    overflowX: 'auto',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
});

export const table = style({
    width: '100%',
    minWidth: '620px',
    borderCollapse: 'collapse',
    tableLayout: 'fixed',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
});

export const th = style({
    color: vars.color.mutedForeground,
    textAlign: 'right',
    fontWeight: 600,
    padding: '5px 6px',
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: {
        '&:first-child': {
            textAlign: 'left',
        },
    },
});

export const td = style({
    color: vars.color.foreground,
    textAlign: 'right',
    padding: '5px 6px',
    borderBottom: `1px solid rgba(34, 43, 55, 0.45)`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    selectors: {
        '&:first-child': {
            textAlign: 'left',
        },
    },
});

export const candidateRow = style({
    cursor: 'pointer',
    ':hover': {
        background: vars.color.muted,
    },
});

export const compose = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 34px',
    gap: vars.space.sm,
    padding: vars.space.md,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const input = style({
    width: '100%',
    minWidth: 0,
    minHeight: '38px',
    maxHeight: '96px',
    resize: 'vertical',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '7px 8px',
    outline: 'none',
    fontFamily: vars.font.body,
    fontSize: '0.76rem',
    lineHeight: 1.35,
    ':focus': {
        borderColor: vars.color.accent,
    },
});

export const sendButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    alignSelf: 'end',
    color: vars.color.foreground,
    background: vars.color.accent,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':disabled': {
        opacity: 0.45,
        cursor: 'not-allowed',
    },
});
