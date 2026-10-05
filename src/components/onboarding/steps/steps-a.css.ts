// src/components/onboarding/steps/steps-a.css.ts — Login / Birthday / Otp / Terms steps.
// 字級與控制項尺寸對齊 onboarding-setup.css 的原始表單；這裡只補焦點環、步驟標題與缺少的元件。

import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '../../../theme.css';
import * as setup from '../../onboarding-setup.css';
import { linkText } from '../login-glass.css';
import * as shared from '../onboarding.css';
import { fieldFocus, focusRing, groupFill, hairline, radius, stepFade } from './steps-b.css';

const CONTROL = '38px';
const spin = keyframes({ to: { transform: 'rotate(360deg)' } });

export const form = style([shared.stepCard, { gap: '16px', ...stepFade }]);

export const header = style({ display: 'flex', flexDirection: 'column', gap: '4px' });

export const title = style({
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: vars.font.display,
    fontSize: '1rem',
    fontWeight: 700,
    lineHeight: 1.35,
    color: vars.color.foreground,
});

export const titleIcon = style({ flexShrink: 0, color: vars.color.accent });

export const lead = style({
    margin: 0,
    fontFamily: vars.font.body,
    fontSize: '0.8rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const field = setup.fieldGroup;

export const label = style([setup.label, { fontSize: '0.72rem' }]);

export const input = style([
    setup.input,
    {
        height: CONTROL,
        boxSizing: 'border-box',
        padding: '0 11px',
        fontSize: '0.9rem',
        borderColor: vars.color.borderBright,
        borderRadius: radius.control,
        selectors: {
            '&:focus-visible': fieldFocus,
            '&[aria-invalid="true"]': { borderColor: vars.color.danger },
            '&:disabled': { opacity: 0.6, cursor: 'not-allowed' },
        },
    },
]);

// 句子裡的文字連結：沿用行內字級，只加底線與焦點環。
export const inlineLink = style({
    display: 'inline',
    padding: 0,
    margin: 0,
    background: 'none',
    border: 'none',
    borderRadius: vars.radius.sm,
    font: 'inherit',
    color: linkText,
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
    selectors: {
        '&:focus-visible': focusRing,
        '&:disabled': { opacity: 0.6, cursor: 'not-allowed' },
    },
});

// 同意勾選：勾選框、「我已閱讀並同意」與可展開的條款連結同一行。
export const consent = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '6px 12px',
    background: groupFill,
    border: hairline,
    borderRadius: radius.group,
    '@media': { '(prefers-contrast: more)': { borderColor: vars.color.borderBright } },
});

export const consentRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minHeight: '28px',
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: vars.color.foreground,
});

// the box sits outside this label, so the label carries the 28px hit height
export const consentLabel = style({ display: 'inline-block', paddingBlock: '3px', cursor: 'pointer' });

// 條款全文：在同意勾選下方展開，太長時自己捲動，網址可斷行。
export const termsPanel = style({
    marginBottom: '6px',
    maxHeight: '13rem',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: radius.control,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    fontSize: '0.72rem',
    lineHeight: 1.65,
    overflowWrap: 'anywhere',
    selectors: {
        '&:focus-visible': focusRing,
        '&[hidden]': { display: 'none' },
    },
});

export const termsClause = style({ margin: '0 0 6px', selectors: { '&:last-child': { marginBottom: 0 } } });

export const inputRow = setup.inputRow;
export const passwordInput = style([input, { paddingRight: '40px' }]);
export const eyeBtn = style([
    setup.eyeBtn,
    {
        right: '5px',
        width: '28px',
        height: '28px',
        justifyContent: 'center',
        borderRadius: radius.thumb,
        selectors: { '&:focus-visible': { ...focusRing, outlineOffset: 0 } },
    },
]);

export const otpInput = style([
    input,
    {
        height: '44px',
        textAlign: 'center',
        fontSize: '1.25rem',
        letterSpacing: '0.3em',
        textIndent: '0.3em',
    },
]);

export const select = style([input, { cursor: 'pointer' }]);

export const fieldError = style({
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.45,
    color: vars.color.danger,
});

export const hint = style({
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.45,
    color: vars.color.mutedForeground,
});

// 隱私與授權說明：安靜的 accentDim 區塊，授權代為同意條款是法律同意，文字維持前景色。
export const infoBox = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    margin: 0,
    padding: '10px 12px',
    borderRadius: radius.group,
    background: vars.color.accentDim,
    color: vars.color.foreground,
    fontSize: '0.75rem',
    lineHeight: 1.55,
});

export const infoIcon = style({ flexShrink: 0, marginTop: '2px', color: vars.color.accent });

export const infoBody = style({ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 });

export const infoText = style({ margin: 0 });

export const alertBox = style([
    shared.errorBox,
    { margin: 0, fontSize: '0.8rem', lineHeight: 1.5, borderRadius: radius.group },
]);

export const warnBox = style([
    shared.noticeBox,
    {
        margin: 0,
        fontSize: '0.8rem',
        lineHeight: 1.5,
        color: vars.color.foreground,
        background: 'rgba(224, 164, 60, 0.12)',
        borderColor: 'rgba(224, 164, 60, 0.4)',
        borderRadius: radius.group,
    },
]);

export const actions = style({ display: 'flex', flexDirection: 'column', gap: '8px' });

// 沿用原始表單的 submitBtn；處理中改用 aria-disabled，按鈕才不會失去焦點。
export const primaryBtn = style([
    setup.submitBtn,
    {
        width: '100%',
        height: '40px',
        boxSizing: 'border-box',
        padding: '0 16px',
        borderRadius: radius.group,
        color: vars.color.panelRaised,
        selectors: {
            '&:focus-visible': focusRing,
            '&[aria-disabled="true"]': { opacity: 0.5, cursor: 'default' },
        },
    },
]);

export const spinner = style({
    flexShrink: 0,
    animation: `${spin} 1s linear infinite`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
});

export const linkBtn = style({
    alignSelf: 'center',
    minHeight: '28px',
    padding: '0 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: radius.thumb,
    cursor: 'pointer',
    fontFamily: vars.font.body,
    fontSize: '0.78rem',
    color: linkText,
    textDecoration: 'underline',
    textUnderlineOffset: '4px',
    selectors: {
        '&:focus-visible': focusRing,
        '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
    },
});

export const checkRow = style([
    shared.checkboxLabel,
    {
        minHeight: '28px',
        alignItems: 'center',
        gap: '10px',
        fontSize: '0.8125rem',
        lineHeight: 1.5,
    },
]);

export const checkRowTop = style([checkRow, { alignItems: 'flex-start', padding: '6px 0' }]);

export const checkRowLocked = style({ opacity: 0.6, cursor: 'not-allowed' });

export const choiceInput = style({
    flexShrink: 0,
    width: '16px',
    height: '16px',
    margin: 0,
    accentColor: vars.color.accent,
    cursor: 'inherit',
    selectors: { '&:focus-visible': focusRing },
});

export const choiceHint = style({
    display: 'block',
    color: vars.color.mutedForeground,
});

// 收碼方式：一個群組裡、以細線分隔的單選列（選取由圓鈕表示）
export const channelList = style({
    display: 'grid',
    gap: 0,
    margin: 0,
    padding: 0,
    border: 'none',
    minWidth: 0,
});

export const legend = style([label, { padding: 0, marginBottom: '6px' }]);

const channelRow = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: '10px',
    minHeight: CONTROL,
    padding: '0 12px',
    fontSize: '0.85rem',
    background: groupFill,
    border: hairline,
    borderRadius: 0,
    selectors: {
        '&:first-of-type': { borderTopLeftRadius: radius.group, borderTopRightRadius: radius.group },
        '&:last-of-type': { borderBottomLeftRadius: radius.group, borderBottomRightRadius: radius.group },
        'label + &': { borderTop: 0 },
    },
} as const;

export const channelOption = style([shared.channelOption, channelRow]);
export const channelOptionActive = style([shared.channelOptionActive, channelRow]);
export const channelLocked = style({ opacity: 0.6, cursor: 'default' });
export const channelName = style({ fontWeight: 600 });

export const countdown = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '10px 12px',
    borderRadius: radius.group,
    background: vars.color.accentDim,
    color: vars.color.foreground,
    fontSize: '0.78rem',
    lineHeight: 1.5,
});

export const countdownTime = style([
    shared.countdownText,
    {
        fontSize: '1rem',
        fontVariantNumeric: 'tabular-nums',
        minWidth: '4ch',
        display: 'inline-block',
        textAlign: 'right',
    },
]);

export const termsBox = style([
    shared.termsScroll,
    {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxHeight: '12rem',
        padding: '10px 12px',
        borderRadius: radius.group,
        fontSize: '0.78rem',
        lineHeight: 1.6,
        color: vars.color.foreground,
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
        selectors: { '&:focus-visible': focusRing },
    },
]);

export const termsParagraph = style({ margin: 0, flexShrink: 0 });
