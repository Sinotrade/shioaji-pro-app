// src/components/onboarding/onboarding.css.ts
import { style, styleVariants, keyframes } from '@vanilla-extract/css';
import { vars } from '../../theme.css';

const fadeIn = keyframes({
  from: { opacity: 0, transform: 'translateY(4px)' },
  to: { opacity: 1, transform: 'translateY(0)' },
});

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.5 },
});

export const container = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.md,
  animation: `${fadeIn} 0.25s cubic-bezier(0.16, 1, 0.3, 1)`,
});

export const tabGroup = style({
  display: 'flex',
  background: vars.color.inset,
  padding: '3px',
  borderRadius: vars.radius.md,
  border: `1px solid ${vars.color.border}`,
  gap: '2px',
  marginBottom: '2px',
});

const tabBtnBase = style({
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  fontFamily: vars.font.display,
  fontSize: '0.78rem',
  fontWeight: 600,
  padding: '7px 12px',
  borderRadius: '5px',
  cursor: 'pointer',
  border: 'none',
  transition: 'all 0.15s ease',
});

export const tabBtn = styleVariants({
  active: [
    tabBtnBase,
    {
      background: vars.color.panelRaised,
      color: vars.color.foreground,
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
    },
  ],
  inactive: [
    tabBtnBase,
    {
      background: 'transparent',
      color: vars.color.mutedForeground,
      ':hover': {
        color: vars.color.foreground,
      },
    },
  ],
});

export const stepBar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '4px',
  padding: '8px 10px',
  background: 'rgba(255, 255, 255, 0.02)',
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  overflowX: 'auto',
});

export const stepItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  fontFamily: vars.font.display,
  fontSize: '0.68rem',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  transition: 'color 0.15s ease',
});

export const stepBadge = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '18px',
  height: '18px',
  borderRadius: '50%',
  fontSize: '0.62rem',
  fontWeight: 700,
});

export const stepBadgeVariants = styleVariants({
  current: [
    stepBadge,
    {
      background: vars.color.accent,
      color: '#0b0e14',
    },
  ],
  done: [
    stepBadge,
    {
      background: 'rgba(34, 197, 94, 0.2)',
      color: '#22c55e',
    },
  ],
  upcoming: [
    stepBadge,
    {
      background: vars.color.inset,
      color: vars.color.mutedForeground,
    },
  ],
});

export const stepArrow = style({
  color: vars.color.mutedForeground,
  opacity: 0.4,
  fontSize: '0.65rem',
});

export const stepCard = style({
  display: 'flex',
  flexDirection: 'column',
  gap: vars.space.md,
  animation: `${fadeIn} 0.2s ease`,
});

export const stepHeader = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
});

export const stepTitle = style({
  fontFamily: vars.font.display,
  fontSize: '0.95rem',
  fontWeight: 700,
  color: vars.color.foreground,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
});

export const stepDesc = style({
  fontFamily: vars.font.body,
  fontSize: '0.74rem',
  color: vars.color.mutedForeground,
  lineHeight: 1.4,
});

export const noticeBox = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '8px 10px',
  borderRadius: vars.radius.md,
  background: 'rgba(56, 189, 248, 0.08)',
  border: '1px solid rgba(56, 189, 248, 0.2)',
  color: '#38bdf8',
  fontSize: '0.72rem',
  lineHeight: 1.45,
});

export const errorBox = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '8px 10px',
  borderRadius: vars.radius.md,
  background: 'rgba(239, 68, 68, 0.1)',
  border: '1px solid rgba(239, 68, 68, 0.25)',
  color: vars.color.danger,
  fontSize: '0.72rem',
  fontWeight: 600,
  lineHeight: 1.45,
});

export const successBox = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '10px 12px',
  borderRadius: vars.radius.md,
  background: 'rgba(34, 197, 94, 0.1)',
  border: '1px solid rgba(34, 197, 94, 0.25)',
  color: '#22c55e',
  fontSize: '0.74rem',
  lineHeight: 1.45,
});

export const privacyBadge = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  fontSize: '0.68rem',
  color: vars.color.mutedForeground,
  marginTop: '2px',
});

export const actionRow = style({
  display: 'flex',
  gap: '8px',
  marginTop: '4px',
});

export const primaryBtn = style({
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  fontFamily: vars.font.display,
  fontSize: '0.84rem',
  fontWeight: 700,
  cursor: 'pointer',
  borderRadius: vars.radius.md,
  padding: '10px 14px',
  border: 'none',
  background: vars.color.accent,
  color: '#0b0e14',
  transition: 'opacity 0.15s, transform 0.1s',
  ':hover': {
    opacity: 0.92,
  },
  ':active': {
    transform: 'scale(0.98)',
  },
  ':disabled': {
    opacity: 0.5,
    cursor: 'not-allowed',
    transform: 'none',
  },
});

export const secondaryBtn = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  fontFamily: vars.font.display,
  fontSize: '0.78rem',
  fontWeight: 600,
  cursor: 'pointer',
  borderRadius: vars.radius.md,
  padding: '9px 12px',
  border: `1px solid ${vars.color.border}`,
  background: 'transparent',
  color: vars.color.mutedForeground,
  ':hover': {
    color: vars.color.foreground,
    borderColor: vars.color.borderBright,
  },
  ':disabled': {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
});

export const channelSelector = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '8px',
});

export const channelOption = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '8px 10px',
  borderRadius: vars.radius.md,
  border: `1px solid ${vars.color.border}`,
  background: vars.color.inset,
  cursor: 'pointer',
  transition: 'all 0.15s ease',
});

export const channelOptionActive = style([
  channelOption,
  {
    borderColor: vars.color.accent,
    background: 'rgba(255, 255, 255, 0.04)',
  },
]);

export const countdownText = style({
  fontFamily: vars.font.mono,
  fontSize: '0.74rem',
  color: vars.color.accent,
  fontWeight: 600,
});

export const copyCard = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px',
  background: vars.color.inset,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
});

export const copyRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  fontFamily: vars.font.mono,
  fontSize: '0.78rem',
});

export const keyText = style({
  color: vars.color.foreground,
  letterSpacing: '0.04em',
  wordBreak: 'break-all',
});

export const iconBtn = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '4px',
  background: 'transparent',
  border: 'none',
  color: vars.color.mutedForeground,
  cursor: 'pointer',
  borderRadius: '4px',
  ':hover': {
    color: vars.color.foreground,
    background: 'rgba(255, 255, 255, 0.08)',
  },
});

export const checkboxLabel = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  fontSize: '0.74rem',
  color: vars.color.foreground,
  cursor: 'pointer',
  lineHeight: 1.45,
});

export const termsScroll = style({
  maxHeight: '120px',
  overflowY: 'auto',
  padding: '8px 10px',
  background: vars.color.inset,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.md,
  fontSize: '0.7rem',
  lineHeight: 1.5,
  color: vars.color.mutedForeground,
  whiteSpace: 'pre-wrap',
});

export const envBadge = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '4px 8px',
  borderRadius: '4px',
  background: 'rgba(34, 197, 94, 0.15)',
  border: '1px solid rgba(34, 197, 94, 0.3)',
  color: '#22c55e',
  fontSize: '0.7rem',
  fontWeight: 600,
});
