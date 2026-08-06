import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 200,
    background: 'rgba(0, 0, 0, 0.45)',
});

export const shell = style({
    position: 'fixed',
    top: '10vh',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 201,
    width: 'min(760px, calc(100vw - 32px))',
});

export const dialog = style({
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '70vh',
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
    overflow: 'hidden',
});

// hover/keyboard preview flyout beside the dialog; hidden when the
// viewport has no room for it
export const previewFlyout = style({
    position: 'absolute',
    top: 0,
    left: 'calc(100% + 8px)',
    width: '228px',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.sm,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.35)',
    '@media': {
        'screen and (max-width: 1100px)': {
            display: 'none',
        },
    },
});

export const previewTitle = style({
    fontSize: '0.74rem',
    fontWeight: 600,
});

export const previewDesc = style({
    color: vars.color.mutedForeground,
    fontSize: '0.64rem',
    lineHeight: 1.5,
});

export const searchRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
});

export const searchInput = style({
    flex: 1,
    minWidth: 0,
    padding: '6px 0',
    border: 0,
    outline: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.82rem',
    '::placeholder': { color: vars.color.mutedForeground },
});

export const hintKey = style({
    padding: '1px 5px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    whiteSpace: 'nowrap',
});

export const body = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${vars.space.sm} ${vars.space.sm} ${vars.space.md}`,
});

export const sectionHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    width: '100%',
    margin: 0,
    padding: `${vars.space.sm} ${vars.space.xs} 3px`,
    border: 0,
    background: 'transparent',
    color: vars.color.mutedForeground,
    fontSize: '0.66rem',
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
});

export const sectionCount = style({
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontWeight: 400,
});

export const cardGrid = style({
    display: 'grid',
    // column count follows the dialog width: 3-up at full width,
    // 2-up / 1-up as the window narrows
    gridTemplateColumns: 'repeat(auto-fill, minmax(215px, 1fr))',
    gap: '4px',
});

const cardBase = style({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `7px ${vars.space.sm}`,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});

export const card = styleVariants({
    normal: [cardBase, {}],
    active: [
        cardBase,
        {
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});

export const cardIcon = style({
    display: 'inline-flex',
    color: vars.color.mutedForeground,
});

export const cardText = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
});

export const cardTitle = style({
    fontSize: '0.74rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const cardDesc = style({
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const cardGo = style({
    color: vars.color.accent,
    fontSize: '0.6rem',
    whiteSpace: 'nowrap',
});

export const empty = style({
    padding: vars.space.lg,
    color: vars.color.mutedForeground,
    textAlign: 'center',
    fontSize: '0.72rem',
});

const flashPulse = keyframes({
    '0%': { outlineColor: 'transparent' },
    '20%': { outlineColor: vars.color.accent },
    '100%': { outlineColor: 'transparent' },
});

// applied imperatively to a grid cell after "jump to existing panel"
export const blockFlash = style({
    outline: '2px solid transparent',
    outlineOffset: '-2px',
    animation: `${flashPulse} 1.2s ease-out 1`,
});
