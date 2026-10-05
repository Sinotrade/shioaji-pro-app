// src/components/onboarding/sinopac-wizard.css.ts — wrapper around the step components.

import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { focusRing, hairline, radius } from './steps/steps-b.css';

const shimmer = keyframes({ '0%': { opacity: 0.5 }, '50%': { opacity: 1 }, '100%': { opacity: 0.5 } });

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minWidth: 0,
    fontFamily: vars.font.body,
    color: vars.color.foreground,
});

export const content = style({ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 });

const bone = {
    borderRadius: radius.control,
    background: vars.color.muted,
    animation: `${shimmer} 1.4s ease-in-out infinite`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
} as const;

export const skeleton = style({ display: 'flex', flexDirection: 'column', gap: '16px' });
export const boneBar = style({ ...bone, height: '2.25rem' });
export const boneTitle = style({ ...bone, height: '1.25rem', width: '60%' });
export const boneLine = style({ ...bone, height: '0.8rem', width: '90%' });
export const boneLabel = style({ ...bone, height: '0.7rem', width: '25%' });
export const boneField = style({ ...bone, height: '38px' });
export const boneButton = style({ ...bone, height: '40px', marginTop: 'auto' });

export const status = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: 0,
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const notice = style({
    margin: 0,
    padding: '10px 12px',
    fontSize: '0.78rem',
    fontWeight: 600,
    lineHeight: 1.5,
    color: vars.color.danger,
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.4)',
    borderRadius: radius.group,
    selectors: { '&:focus-visible': focusRing },
});

export const unavailable = style({
    margin: 0,
    padding: '12px 14px',
    fontSize: '0.8125rem',
    lineHeight: 1.55,
    color: vars.color.mutedForeground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: radius.group,
});

// 取消鈕消失時（處理中）高度仍保留，避免底部跳動。
export const footer = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '4px 12px',
    minHeight: '32px',
    paddingTop: '12px',
    borderTop: hairline,
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const confirm = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.78rem',
    color: vars.color.foreground,
});

export const secondaryBtn = style({
    minHeight: '32px',
    padding: '0 12px',
    fontFamily: vars.font.body,
    fontSize: '0.78rem',
    color: vars.color.foreground,
    background: 'transparent',
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: radius.control,
    cursor: 'pointer',
    selectors: {
        '&:hover': { borderColor: vars.color.accent },
        '&:focus-visible': focusRing,
    },
});
