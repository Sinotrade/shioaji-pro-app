// src/components/tick-tape.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const tape = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    display: 'flex',
    flexDirection: 'column',
});

export const tapeRow = style({
    display: 'grid',
    gridTemplateColumns: '7.6rem 1fr 3.4rem',
    columnGap: vars.space.sm,
    padding: `2px ${vars.space.sm}`,
    borderBottom: `1px solid rgba(34, 43, 55, 0.45)`,
});

// big-lot rows pop with a subtle amber wash + bold volume
export const tapeRowBig = style([
    tapeRow,
    {
        background: 'rgba(224, 164, 60, 0.07)',
    },
]);

export const time = style({
    color: vars.color.mutedForeground,
});

export const vol = style({
    textAlign: 'right',
    color: vars.color.mutedForeground,
});

export const volBig = style([
    vol,
    {
        color: vars.color.amber,
        fontWeight: 700,
    },
]);

/** 美股明細跨日分隔（盤前即時列接前一交易日歷史） */
export const dayBreak = style({
    padding: '2px 0',
    textAlign: 'center',
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
});
