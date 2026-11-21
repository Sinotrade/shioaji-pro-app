// src/components/us-session-icon.css.ts

import { style } from '@vanilla-extract/css';

// 固定大小的方塊：換時段或清掉時寬度不變；顏色跟著所在的行（副行的淡色、收盤後轉灰）
export const icon = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    verticalAlign: 'middle',
    color: 'inherit',
    opacity: 0.9,
});

export const placeholder = style({ visibility: 'hidden' });
