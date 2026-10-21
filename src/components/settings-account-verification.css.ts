import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { description } from './settings-test-order.css';

export const failIcon = style({
    flexShrink: 0,
    color: vars.color.danger,
});

export const legend = style([description]);
globalStyle(`${legend} > svg`, { verticalAlign: '-0.15em' });

export const rules = style({
    marginTop: vars.space.sm,
    paddingTop: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
    // 避免句尾孤字（「效。」單獨一行）；不支援的 WebKit 直接忽略
    textWrap: 'pretty',
});

export const rulesTitle = style({
    margin: 0,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const statusList = style({
    margin: `${vars.space.sm} 0 0`,
    padding: 0,
    listStyle: 'none',
});

export const statusRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    columnGap: vars.space.sm,
    rowGap: vars.space.xs,
    padding: `${vars.space.sm} 0`,
    lineHeight: '1.14rem',
    selectors: {
        '& + &': { borderTop: `1px solid ${vars.color.border}` },
    },
});

export const statusMarket = style({
    flex: '0 0 2.5em',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const statusText = style({
    flex: '1 1 14em',
    minWidth: 0,
    display: 'flex',
    gap: vars.space.xs,
    alignItems: 'flex-start',
});
globalStyle(`${statusText} > svg`, { marginTop: 'calc((1.14rem - 14px) / 2)' });

export const statusMain = style({
    fontWeight: 600,
    color: vars.color.foreground,
});

export const statusSub = style({
    fontWeight: 400,
    color: vars.color.mutedForeground,
});

export const accountId = style({
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});
