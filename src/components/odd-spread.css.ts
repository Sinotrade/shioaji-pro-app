// src/components/odd-spread.css.ts — 整零價差面板

import { createContainer, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const box = createContainer();
const AMBER_DIM = 'rgba(224, 164, 60, 0.10)';
const AMBER_TAG = 'rgba(224, 164, 60, 0.22)';
// 成功色（綠）淡底：舊 WebView 不支援 color-mix 時退回固定色
const successMix = (pct: number, fallback: string) => [fallback, `color-mix(in srgb, ${vars.color.success} ${pct}%, transparent)`];

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    containerName: box,
    containerType: 'inline-size',
    fontVariantNumeric: 'tabular-nums',
});

// ---- 名稱列：名稱 · 整股／零股最後成交 · 零股撮合時間 ----

export const symbolRow = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `2px ${vars.space.sm}`,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    flexShrink: 0,
});

export const symbolName = style({
    fontSize: '0.78rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const quoteMeta = style({
    marginLeft: 'auto',
    display: 'flex',
    flexWrap: 'wrap',
    gap: `0 ${vars.space.sm}`,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const quoteItem = style({ display: 'inline-flex', gap: 4, alignItems: 'baseline' });
export const quoteVal = style({ fontFamily: vars.font.mono, color: vars.color.foreground });
export const chg = styleVariants({
    up: { fontFamily: vars.font.mono, color: vars.color.up },
    down: { fontFamily: vars.font.mono, color: vars.color.down },
    flat: { fontFamily: vars.font.mono, color: vars.color.flat },
});

export const notice = style({
    padding: `3px ${vars.space.sm}`,
    fontSize: '0.64rem',
    lineHeight: 1.4,
    color: vars.color.amber,
    background: AMBER_DIM,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

// ---- 兩個方向的試算卡 ----

export const cards = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.sm,
    padding: `${vars.space.sm} ${vars.space.sm}`,
    flexShrink: 0,
    '@container': {
        [`${box} (max-width: 400px)`]: { gridTemplateColumns: '1fr' },
    },
});

const cardBase = style({
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
    padding: '7px 8px',
    borderRadius: vars.radius.md,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
});

export const card = styleVariants({
    idle: [cardBase],
    good: [cardBase, { borderColor: vars.color.success, background: successMix(7, 'rgba(22, 179, 137, 0.07)') }],
});

export const cardTitle = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: vars.space.xs,
    fontSize: '0.74rem',
    fontWeight: 700,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const cardHint = style({
    fontSize: '0.6rem',
    fontWeight: 400,
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const cardPath = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
});

export const big = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: 6,
    fontFamily: vars.font.mono,
    fontSize: '1.15rem',
    fontWeight: 700,
    lineHeight: 1.2,
});

export const bigUnit = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 400,
});

export const kv = style({
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '2px 8px',
    fontSize: '0.66rem',
});

export const kvKey = style({ color: vars.color.mutedForeground, whiteSpace: 'nowrap' });
export const kvVal = style({ textAlign: 'right', fontFamily: vars.font.mono, color: vars.color.foreground, minWidth: 0 });
export const kvSub = style({ fontFamily: vars.font.body, color: vars.color.mutedForeground });

// 放在 kvVal 之後：同權重時後定義者勝，損益色才蓋得過預設前景色
export const tone = styleVariants({
    pos: { color: vars.color.success },
    neg: { color: vars.color.danger },
    flat: { color: vars.color.mutedForeground },
});

const goBase = style({
    marginTop: 'auto',
    width: '100%',
    padding: '5px 0',
    border: 0,
    borderRadius: vars.radius.sm,
    fontSize: '0.72rem',
    fontWeight: 700,
    cursor: 'pointer',
});

export const goBtn = styleVariants({
    on: [goBase, { color: '#fff', background: vars.color.success, ':hover': { filter: 'brightness(1.08)' } }],
    off: [goBase, { color: vars.color.mutedForeground, background: vars.color.muted, cursor: 'not-allowed' }],
});

// ---- 價格梯：左整股（張）· 價格 · 右零股（股） ----

const COLS = '1fr 1fr 5.8rem 1fr 1fr';

export const ladderHead = style({
    display: 'grid',
    gridTemplateColumns: COLS,
    alignItems: 'center',
    textAlign: 'center',
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    flexShrink: 0,
});

export const groupCell = style({
    gridColumn: 'span 2',
    padding: '4px 0 2px',
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const headCell = style({ padding: '2px 0 3px' });

export const armBtn = styleVariants({
    off: {
        margin: '2px auto',
        fontSize: '0.6rem',
        padding: '1px 6px',
        borderRadius: vars.radius.sm,
        border: `1px solid ${vars.color.border}`,
        background: vars.color.inset,
        color: vars.color.mutedForeground,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        ':disabled': { cursor: 'not-allowed', opacity: 0.6 },
    },
    on: {
        margin: '2px auto',
        fontSize: '0.6rem',
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: vars.radius.sm,
        border: `1px solid ${vars.color.amber}`,
        background: vars.color.amber,
        color: '#1a1304',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
    },
});

export const ladderBody = style({
    flexShrink: 0,
});

export const ladderRow = styleVariants({
    normal: {
        display: 'grid',
        gridTemplateColumns: COLS,
        height: 22,
        alignItems: 'stretch',
        textAlign: 'center',
        borderBottom: `1px solid ${vars.color.border}`,
        fontFamily: vars.font.mono,
        fontSize: '0.72rem',
    },
    cross: {
        display: 'grid',
        gridTemplateColumns: COLS,
        height: 22,
        alignItems: 'stretch',
        textAlign: 'center',
        borderBottom: `1px solid ${vars.color.border}`,
        fontFamily: vars.font.mono,
        fontSize: '0.72rem',
        background: AMBER_DIM,
    },
});

const volBase = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
});

export const volCell = styleVariants({
    bid: [volBase, { color: vars.color.up }],
    ask: [volBase, { color: vars.color.down }],
});

export const volLive = styleVariants({
    bid: { cursor: 'pointer', ':hover': { background: vars.color.upDim } },
    ask: { cursor: 'pointer', ':hover': { background: vars.color.downDim } },
});

export const oddSep = style({ borderLeft: `2px solid ${vars.color.borderBright}` });

export const priceCell = styleVariants({
    normal: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        fontWeight: 600,
        color: vars.color.foreground,
        borderLeft: `1px solid ${vars.color.border}`,
    },
    cross: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        fontWeight: 600,
        color: vars.color.amber,
        borderLeft: `1px solid ${vars.color.border}`,
    },
});

const markBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.56rem',
    lineHeight: 1,
    padding: '2px 3px',
    borderRadius: 3,
});

export const mark = styleVariants({
    round: [markBase, { background: vars.color.muted, color: vars.color.foreground, border: `1px solid ${vars.color.borderBright}` }],
    odd: [markBase, { background: AMBER_TAG, color: vars.color.amber }],
});

export const empty = style({
    padding: `${vars.space.md} ${vars.space.sm}`,
    textAlign: 'center',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

// ---- 下方送單 ----

export const footer = style({
    display: 'grid',
    gap: 6,
    padding: `${vars.space.sm}`,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    marginTop: 'auto',
});

export const fRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    fontSize: '0.68rem',
    color: vars.color.foreground,
});

export const fLabel = style({ color: vars.color.mutedForeground, whiteSpace: 'nowrap' });
export const fLabelW = style({ color: vars.color.mutedForeground, whiteSpace: 'nowrap', minWidth: '3.4rem' });

export const input = style({
    width: '4.2rem',
    fontFamily: vars.font.mono,
    fontSize: '0.74rem',
    textAlign: 'center',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const inputNarrow = style([input, { width: '3.2rem' }]);
export const inputTiny = style([input, { width: '2.6rem' }]);

export const lockBtn = styleVariants({
    on: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: '0.66rem',
        fontWeight: 600,
        color: vars.color.amber,
        background: 'transparent',
        border: 0,
        padding: 0,
        cursor: 'pointer',
    },
    off: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: '0.66rem',
        color: vars.color.mutedForeground,
        background: 'transparent',
        border: 0,
        padding: 0,
        cursor: 'pointer',
    },
});

export const inventory = style({ marginLeft: 'auto', whiteSpace: 'nowrap', fontFamily: vars.font.mono });

export const select = style({
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 4px',
});

export const btns = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.sm,
});

const bigBtnBase = style({
    padding: '7px 4px',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    fontSize: '0.74rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const bigBtn = styleVariants({
    on: [bigBtnBase, { color: vars.color.success, borderColor: vars.color.success, background: successMix(13, 'rgba(22, 179, 137, 0.13)'), cursor: 'pointer', ':hover': { background: successMix(22, 'rgba(22, 179, 137, 0.22)') } }],
    warn: [bigBtnBase, { color: vars.color.amber, borderColor: vars.color.amber, background: AMBER_DIM, cursor: 'pointer', ':hover': { background: AMBER_TAG } }],
    danger: [bigBtnBase, { color: vars.color.danger, borderColor: vars.color.danger, background: vars.color.panelRaised, cursor: 'pointer' }],
    off: [bigBtnBase, { color: vars.color.mutedForeground, borderColor: vars.color.border, background: vars.color.muted, cursor: 'not-allowed' }],
});

export const execBar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    padding: '5px 7px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.amber}`,
    background: AMBER_DIM,
    fontSize: '0.66rem',
    color: vars.color.foreground,
});

export const execPhase = style({ fontWeight: 700, color: vars.color.amber });
export const execNums = style({ fontFamily: vars.font.mono });

export const execWarn = style({ fontWeight: 700, color: vars.color.danger });
export const execDetail = style({ flexBasis: '100%', lineHeight: 1.4, color: vars.color.foreground });
export const execActions = style({ marginLeft: 'auto', display: 'inline-flex', gap: 6 });

export const smallBtn = style({
    fontSize: '0.64rem',
    padding: '2px 8px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.foreground,
    cursor: 'pointer',
    ':hover': { borderColor: vars.color.danger },
});

export const note = style({
    padding: `5px ${vars.space.sm}`,
    fontSize: '0.6rem',
    lineHeight: 1.45,
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const smallBtnPrimary = style([smallBtn, {
    fontWeight: 700,
    color: vars.color.amber,
    borderColor: vars.color.amber,
    ':hover': { borderColor: vars.color.amber, background: AMBER_DIM },
}]);

export const noticeBtn = style({
    marginLeft: 8,
    fontSize: '0.62rem',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.amber}`,
    background: 'transparent',
    color: vars.color.amber,
    cursor: 'pointer',
});
