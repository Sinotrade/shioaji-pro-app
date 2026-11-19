// src/components/us-depth.css.ts — 美股最佳一檔
//
// 只有一檔，不用五檔的「量｜價｜價｜量」四欄（窄面板時價格會被裁掉）。
// 改成買、賣兩格，每格價格在上、量在下，量條墊在格子底部；格子 minWidth 0，
// 價格不換行也不裁字，面板再窄時字級跟著容器縮。

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({
    containerType: 'inline-size',
    display: 'flex',
    flexDirection: 'column',
    padding: vars.space.sm,
    gap: '4px',
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.74rem',
});

export const note = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.xs,
    color: vars.color.mutedForeground,
    fontSize: '0.68rem',
});

export const sides = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    columnGap: '4px',
});

const cellBase = style({
    position: 'relative',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    padding: '4px 6px',
    borderRadius: vars.radius.sm,
    overflow: 'hidden',
    background: vars.color.muted,
});

export const bidCell = style([cellBase, { alignItems: 'flex-end', textAlign: 'right' }]);
export const askCell = style([cellBase, { alignItems: 'flex-start', textAlign: 'left' }]);

export const sideLabel = style({
    position: 'relative',
    zIndex: 1,
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
});

const priceBase = style({
    position: 'relative',
    zIndex: 1,
    whiteSpace: 'nowrap',
    fontWeight: 600,
    fontSize: 'clamp(0.66rem, 9cqi, 0.95rem)',
    lineHeight: 1.2,
});

export const priceBid = style([priceBase, { color: vars.color.up }]);
export const priceAsk = style([priceBase, { color: vars.color.down }]);

export const vol = style({
    position: 'relative',
    zIndex: 1,
    whiteSpace: 'nowrap',
    color: vars.color.mutedForeground,
    fontSize: '0.68rem',
});

export const bidBar = style({
    position: 'absolute',
    right: 0,
    bottom: 0,
    height: '3px',
    background: vars.color.up,
    transition: 'width 0.2s ease-out',
});

export const askBar = style({
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: '3px',
    background: vars.color.down,
    transition: 'width 0.2s ease-out',
});

export const seeded = style({ opacity: 0.7 });
