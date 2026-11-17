// src/components/flash-order-us.css.ts — 美股閃電梯形的少數額外樣式（其餘沿用 flash-order.css.ts）

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

/** 最佳買價／賣價列：價格欄加一條細邊，和台股五檔的量條一起看 */
export const bestBid = style({ boxShadow: `inset 3px 0 0 ${vars.color.upDim}` });
export const bestAsk = style({ boxShadow: `inset -3px 0 0 ${vars.color.downDim}` });

/** 參考價／盤別提示列 */
export const refNote = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const warn = style({ color: vars.color.amber });
