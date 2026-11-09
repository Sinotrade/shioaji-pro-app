// src/components/flash-order.css.ts

import { createContainer, globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const COLS = '3rem 1fr 4.8rem 1fr 3rem';
// #216 外側觸買／觸賣欄：觸價 | 委託 | 量 | 價格 | 量 | 委託 | 觸價
const COLS7 = '1.9rem 2rem minmax(0, 1fr) 3.9rem minmax(0, 1fr) 2rem 1.9rem';
// 最窄的面板放不下固定欄寬：全部改成比例。買量／賣量同時是限價下單的點擊區，不能收成 0
const COLS7_MINIMAL = 'minmax(0, 1.4fr) minmax(0, 1.3fr) minmax(0, 1.6fr) minmax(0, 3.2fr) minmax(0, 1.6fr) minmax(0, 1.3fr) minmax(0, 1.4fr)';

const flashContainer = createContainer();

// #376 版面只看面板寬度，不看內容長度：同寬的面板不論商品、價格、信用條件
// 或有沒有持倉都長得一樣。寬度門檻（寬→窄的退讓順序）：
//   > 460px  動作列一列排完
//   ≤ 460px  帳戶縮窄讓出位置，數量與齒輪不換行；市價買／賣獨佔一列，
//            平倉／全刪／停損停利固定在下一列
//   ≤ 300px  個股期對照列收掉百分比（1口=N張固定靠右，不換行）
//   ≤ 230px  七欄價格梯全部改比例欄寬，七欄都留得下（最小寬的面板內寬約 204px）
// 仍放不下時才截斷，全文在 tooltip。
const NARROW = `${flashContainer} (max-width: 460px)`;
const TIGHT = `${flashContainer} (max-width: 300px)`;
const MINIMAL = `${flashContainer} (max-width: 230px)`;

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    containerName: flashContainer,
    containerType: 'inline-size',
});

// 商品名稱列（#176）：鎖定或窄面板時標題列放不下名稱，這一列一律顯示
export const symbolRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panelRaised,
    flexShrink: 0,
    minWidth: 0,
});

export const symbolName = style({
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
});

export const symbolMeta = style({
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    flexShrink: 0,
});

// 帳戶：顯示精簡標籤，透明的原生 select 疊在上面負責開選單
export const accountPick = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    maxWidth: '100%',
    minWidth: 0,
    padding: '1px 5px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    cursor: 'pointer',
    selectors: {
        '&:focus-within': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
    },
    // 帳戶標籤長短（跟隨 ****02）不把齒輪擠到下一列：寬度由這格吸收
    '@container': {
        [NARROW]: { flex: '1 1 0' },
    },
});

export const accountText = style({
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const accountSelect = style({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    opacity: 0,
    cursor: 'pointer',
    // 選單項目沿用系統字級，戶名不被截
    fontSize: '0.8rem',
});

// 窄面板時「啟用閃電下單／跟隨／置中」換到第二列，帳戶與數量同一列
export const rowBreak = style({
    display: 'none',
    '@container': {
        [NARROW]: { display: 'block', flexBasis: '100%', height: 0 },
    },
});

// wraps so an 8-strip tile (~240px wide) still shows every control
export const controls = style({
    // the settings popover spans this row (see OrderSettingsButton align='panel')
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const qtyInput = style({
    width: '2.8rem',
    fontFamily: vars.font.mono,
    fontSize: '0.78rem',
    fontWeight: 600,
    textAlign: 'center',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const stepBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    width: '1.3rem',
    height: '1.3rem',
    lineHeight: 1,
    cursor: 'pointer',
    color: vars.color.mutedForeground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: 0,
    ':hover': { color: vars.color.foreground },
});

const armBase = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    padding: '3px 0',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.12s',
    whiteSpace: 'nowrap',
});

export const armBtn = styleVariants({
    off: [
        armBase,
        {
            color: vars.color.mutedForeground,
            borderColor: vars.color.border,
            background: vars.color.inset,
        },
    ],
    on: [
        armBase,
        {
            color: '#1a1304',
            borderColor: vars.color.amber,
            background: vars.color.amber,
            animation: 'pulse-glow 1.4s infinite',
        },
    ],
});

const smallToggle = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    borderRadius: vars.radius.sm,
    padding: '2px 8px',
    cursor: 'pointer',
    border: '1px solid',
    whiteSpace: 'nowrap',
});

export const followBtn = styleVariants({
    on: [
        smallToggle,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
    off: [
        smallToggle,
        {
            color: vars.color.mutedForeground,
            borderColor: vars.color.border,
            background: 'transparent',
            ':hover': { color: vars.color.foreground },
        },
    ],
});

export const qtyUnit = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const oddBanner = style({
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    color: vars.color.amber,
    background: 'rgba(224, 164, 60, 0.08)',
    borderBottom: `1px solid ${vars.color.border}`,
    lineHeight: 1.35,
    flexShrink: 0,
});

export const oddMatchTime = style({
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});

export const recenterBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    ':hover': { color: vars.color.foreground },
});

// ---- action bar (market orders / flatten / cancel-all) ----

export const actionBar = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    '@container': {
        [NARROW]: { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
    },
});

// 平倉／全刪／停損停利：不換行，空間不夠時只有停損停利文字截斷
export const actionSecondary = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    minWidth: 0,
    '@container': {
        [NARROW]: { gridColumn: '1 / -1' },
    },
});

const mktBase = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    padding: '3px 0',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.12s',
    // 按鈕內不換行：長標籤（範圍市價融資買）在按鈕內截斷，全文在 title
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const mktBtn = styleVariants({
    buy: [
        mktBase,
        {
            color: vars.color.up,
            borderColor: vars.color.up,
            background: vars.color.upDim,
        },
    ],
    sell: [
        mktBase,
        {
            color: vars.color.down,
            borderColor: vars.color.down,
            background: vars.color.downDim,
        },
    ],
});

export const flatBtn = style([
    mktBase,
    {
        flex: '0 0 auto',
        padding: '3px 10px',
        color: vars.color.amber,
        borderColor: vars.color.amber,
        background: 'rgba(224, 164, 60, 0.08)',
        // 跟全刪一樣：停用時看起來不能按
        ':disabled': {
            opacity: 0.4,
            cursor: 'not-allowed',
            borderColor: vars.color.border,
            background: vars.color.inset,
        },
    },
]);

export const cancelAllBtn = style([
    mktBase,
    {
        flex: '0 0 auto',
        padding: '3px 10px',
        color: vars.color.danger,
        borderColor: vars.color.border,
        background: vars.color.inset,
        ':hover': { borderColor: vars.color.danger },
        ':disabled': {
            opacity: 0.4,
            cursor: 'not-allowed',
            borderColor: vars.color.border,
        },
    },
]);

// ---- position bar ----

export const posBar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const posLong = style({ color: vars.color.up, fontWeight: 600 });
export const posShort = style({ color: vars.color.down, fontWeight: 600 });
export const posMixed = style({
    padding: '0 4px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: 3,
    cursor: 'help',
});

// ---- ladder ----

export const headRow = style({
    display: 'grid',
    gridTemplateColumns: COLS,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    textAlign: 'center',
    padding: '3px 0',
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    flexShrink: 0,
});

// fixed window — no native scrolling; the wheel shifts the anchor in ticks
export const ladderBody = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

export const waiting = style({
    padding: vars.space.md,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    textAlign: 'center',
});

const rowBase = style({
    display: 'grid',
    gridTemplateColumns: COLS,
    height: '22px',
    alignItems: 'stretch',
    borderBottom: `1px solid rgba(127, 127, 127, 0.07)`,
});

export const row = styleVariants({
    normal: [rowBase],
    last: [
        rowBase,
        {
            background: vars.color.accentDim,
        },
    ],
});

const cellBase = style({
    display: 'flex',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
});

export const chipCell = style([
    cellBase,
    {
        justifyContent: 'center',
        gap: '2px',
    },
]);

const chipBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 700,
    lineHeight: 1,
    minWidth: '1.7rem',
    padding: '2px 3px',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.1s',
});

export const orderChip = styleVariants({
    buy: [
        chipBase,
        {
            color: vars.color.up,
            borderColor: vars.color.up,
            background: vars.color.upDim,
            ':hover': { color: '#fff', background: vars.color.up },
        },
    ],
    sell: [
        chipBase,
        {
            color: vars.color.down,
            borderColor: vars.color.down,
            background: vars.color.downDim,
            ':hover': { color: '#fff', background: vars.color.down },
        },
    ],
});

// solid badge = today's filled quantity at this price (not clickable),
// in contrast to the outlined working-order chip
const fillBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 700,
    lineHeight: 1,
    minWidth: '1.4rem',
    padding: '3px 3px',
    textAlign: 'center',
    borderRadius: vars.radius.sm,
    color: '#fff',
    cursor: 'default',
});

export const fillBadge = styleVariants({
    buy: [fillBase, { background: vars.color.up, opacity: 0.85 }],
    sell: [fillBase, { background: vars.color.down, opacity: 0.85 }],
});

export const buyCell = style([
    cellBase,
    {
        justifyContent: 'flex-end',
        paddingRight: '8px',
        cursor: 'pointer',
        color: vars.color.up,
        selectors: {
            '&:hover': { background: vars.color.upDim },
        },
    },
]);

export const sellCell = style([
    cellBase,
    {
        justifyContent: 'flex-start',
        paddingLeft: '8px',
        cursor: 'pointer',
        color: vars.color.down,
        selectors: {
            '&:hover': { background: vars.color.downDim },
        },
    },
]);

export const disabledCell = style({
    cursor: 'not-allowed',
    opacity: 0.55,
});

// 交易所規則不收（外國標的權證市價）：跟「尚未啟用」的淡色區分開 — 虛線框、刪除線、鎖頭
export const ruleLocked = style({
    cursor: 'not-allowed',
    opacity: 0.5,
    borderStyle: 'dashed',
    textDecoration: 'line-through',
});

export const ruleLockIcon = style({
    verticalAlign: '-1px',
    marginRight: 3,
});

export const priceCell = style([
    cellBase,
    {
        justifyContent: 'center',
        gap: '4px',
        fontWeight: 600,
        borderLeft: `1px solid ${vars.color.border}`,
        borderRight: `1px solid ${vars.color.border}`,
    },
]);

// limit-up/down rows: price cell filled solid in the limit color
export const bandUp = style({
    background: vars.color.up,
    color: '#fff',
    fontWeight: 700,
});
export const bandDown = style({
    background: vars.color.down,
    color: '#fff',
    fontWeight: 700,
});

// average-cost marker on the price cell
export const avgMark = style({
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
});

// inherits the cell color so it stays readable on filled limit rows
export const lastVol = style({
    fontSize: '0.58rem',
    fontWeight: 400,
    color: 'inherit',
    opacity: 0.75,
});

const volBarBase = style({
    position: 'absolute',
    top: '3px',
    bottom: '3px',
    zIndex: 0,
    borderRadius: '2px',
    background: 'currentcolor',
    opacity: 0.18,
});

export const volBarBid = style([volBarBase, { right: 0 }]);
export const volBarAsk = style([volBarBase, { left: 0 }]);

export const cellText = style({
    position: 'relative',
    zIndex: 1,
});

// floating "back to last price" pill when price leaves the window
const jumpBase = style({
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 600,
    padding: '3px 12px',
    cursor: 'pointer',
    borderRadius: '999px',
    color: vars.color.accent,
    border: `1px solid ${vars.color.accent}`,
    background: vars.color.panelRaised,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
    whiteSpace: 'nowrap',
});

export const jumpBtn = styleVariants({
    top: [jumpBase, { top: '6px' }],
    bottom: [jumpBase, { bottom: '6px' }],
});

export const totalsRow = style({
    display: 'flex',
    justifyContent: 'space-between',
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const totalBid = style({ color: vars.color.up });
export const totalAsk = style({ color: vars.color.down });

export const hint = style({
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    textAlign: 'center',
});

// ---- 信用條件（整股：現股／融資／融券＋現股當沖先賣）----

const amberDim = 'rgba(224, 164, 60, 0.08)';

// 數量旁的「張·融資」按鈕：單位＋信用條件的快速下拉
// static: the menu is placed against the controls row (position: relative),
// so it never hangs off a narrow panel
export const unitAnchor = style({
    position: 'static',
    display: 'inline-flex',
});

const unitBtnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 4px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    ':hover': { color: vars.color.foreground },
});

export const unitBtn = styleVariants({
    closed: [unitBtnBase],
    open: [unitBtnBase, { color: vars.color.foreground, borderColor: vars.color.accent }],
});

export const unitCredit = style({
    color: vars.color.amber,
    fontWeight: 700,
});

export const menuBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 40,
});

export const unitMenu = style({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: '6px',
    zIndex: 41,
    width: '11.5rem',
    maxWidth: 'calc(100% - 12px)',
    display: 'flex',
    flexDirection: 'column',
    padding: '4px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
});

const menuItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '4px 6px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    textAlign: 'left',
    color: vars.color.foreground,
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
    ':disabled': { opacity: 0.45, cursor: 'not-allowed', background: 'transparent' },
});

export const menuItem = styleVariants({
    off: [menuItemBase],
    on: [menuItemBase, { color: vars.color.amber, fontWeight: 600 }],
});

export const menuDesc = style({
    marginLeft: 'auto',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    fontWeight: 400,
});

export const menuSep = style({
    height: 1,
    margin: '3px 2px',
    background: vars.color.border,
});

export const menuNote = style({
    padding: '3px 6px',
    fontSize: '0.6rem',
    lineHeight: 1.35,
    color: vars.color.mutedForeground,
});

// 商品列的琥珀色小標籤（現股不顯示）；不能用時變紅並劃掉
const creditTagBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    fontWeight: 700,
    padding: '0 5px',
    borderRadius: 3,
    border: '1px solid',
    whiteSpace: 'nowrap',
    flexShrink: 0,
});

export const creditTag = styleVariants({
    ok: [creditTagBase, { color: vars.color.amber, borderColor: vars.color.amber, background: amberDim }],
    bad: [creditTagBase, { color: vars.color.danger, borderColor: vars.color.danger, textDecoration: 'line-through' }],
});

const creditBannerBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    lineHeight: 1.35,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const creditBanner = styleVariants({
    ok: [creditBannerBase, { color: vars.color.amber, background: amberDim }],
    bad: [creditBannerBase, { color: vars.color.danger, background: 'rgba(239, 68, 68, 0.08)' }],
});

// 這個信用條件不能送的那一邊：整欄變淡
export const blockedSide = style({
    opacity: 0.3,
});

// 快速下拉裡的分段列（效期／倉別／市價鈕）
export const menuSegRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    padding: '3px 6px',
    flexWrap: 'wrap',
});

export const menuSegLabel = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    minWidth: '2.6rem',
});

const menuSegBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.foreground,
    cursor: 'pointer',
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

export const menuSegBtn = styleVariants({
    off: [menuSegBase, { ':hover': { background: vars.color.muted } }],
    on: [menuSegBase, { color: vars.color.amber, borderColor: vars.color.amber, background: 'rgba(224, 164, 60, 0.08)', fontWeight: 600 }],
});

// 商品列最左邊的種類標籤：「整股｜張」「零股｜股」「股期｜口」
export const kindTag = style({
    display: 'inline-flex',
    alignSelf: 'center',
    flexShrink: 0,
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    lineHeight: 1.5,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: 3,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
});
globalStyle(`${kindTag} > b`, { padding: '0 4px', fontWeight: 700, color: vars.color.foreground, background: vars.color.muted });
globalStyle(`${kindTag} > i`, { padding: '0 4px', fontStyle: 'normal', color: vars.color.mutedForeground });

// 價差對照列（零股：整零差；個股期：期現差＋1口=N張）
export const refRow = style({
    display: 'flex',
    alignItems: 'baseline',
    columnGap: vars.space.sm,
    padding: `1px ${vars.space.sm}`,
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
});
export const refKey = style({ flexShrink: 0 });
globalStyle(`${refKey} > b`, { fontFamily: vars.font.mono, fontWeight: 600, color: vars.color.foreground });
// 差價是這一列唯一可以截斷的欄位，其他欄位的位置不受它的長度影響
export const refDiff = style({ flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' });
export const refPct = style({
    '@container': { [TIGHT]: { display: 'none' } },
});
// 1口=N張固定靠右
export const refLots = style({ marginLeft: 'auto' });
export const refUp = style({});
export const refDown = style({});
globalStyle(`${refKey} > b${refUp}`, { color: vars.color.up });
globalStyle(`${refKey} > b${refDown}`, { color: vars.color.down });

// 個股期月份選擇（透明原生 select 疊在標籤上）
export const monthPick = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 2,
    flexShrink: 0,
    padding: '0 5px',
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    fontWeight: 600,
    color: vars.color.accent,
    background: vars.color.accentDim,
    borderRadius: 3,
    cursor: 'pointer',
});
export const monthSelect = style({ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%' });
export const expiryTag = style({
    alignSelf: 'center',
    flexShrink: 0,
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    fontWeight: 700,
    padding: '0 4px',
    borderRadius: 3,
    color: vars.color.danger,
    border: `1px solid ${vars.color.danger}`,
});

// ---- #216 觸價模式與梯形上的觸價單／停損停利 ----

// 標在買量／賣量格的外側邊緣（買：左、賣：右），不新增欄位
const markSlot = style({
    position: 'absolute',
    top: 2,
    bottom: 2,
    zIndex: 2,
    display: 'flex',
    alignItems: 'stretch',
    gap: 2,
});
export const markSlotInline = style({
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 2,
    height: '100%',
    padding: '2px 0',
    position: 'relative',
    zIndex: 2,
});
export const markSlotSide = styleVariants({
    buy: [markSlot, { left: 2 }],
    sell: [markSlot, { right: 2 }],
});

const markBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    fontWeight: 700,
    lineHeight: 1,
    padding: '0 3px',
    minWidth: '1.6rem',
    justifyContent: 'center',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    touchAction: 'none',
});

export const mark = styleVariants({
    triggerBuy: [markBase, { color: vars.color.up, borderColor: vars.color.up, borderStyle: 'dashed', background: vars.color.panel, cursor: 'grab' }],
    triggerSell: [markBase, { color: vars.color.down, borderColor: vars.color.down, borderStyle: 'dashed', background: vars.color.panel, cursor: 'grab' }],
    stop: [markBase, { color: vars.color.amber, borderColor: vars.color.amber, background: amberDim, cursor: 'help' }],
    take: [markBase, { color: vars.color.accent, borderColor: vars.color.accent, background: vars.color.accentDim, cursor: 'help' }],
});

export const markLocked = style({ cursor: 'help' });
export const markPaused = style({ opacity: 0.45 });
export const markPending = style({ background: amberDim, borderColor: vars.color.amber, color: vars.color.amber });
export const markDragging = style({ opacity: 0.35 });

// 拖曳中的目標列
export const dropRow = styleVariants({
    ok: { outline: `1px dashed ${vars.color.amber}`, outlineOffset: -1, background: amberDim },
    bad: { outline: `1px dashed ${vars.color.danger}`, outlineOffset: -1 },
});

// ---- #216 自動停損停利 ----

export const protectAnchor = style({
    position: 'relative',
    flexShrink: 0,
    borderBottom: `1px solid ${vars.color.border}`,
});

const protectBase = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 5,
    rowGap: 0,
    width: '100%',
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    lineHeight: 1.35,
    textAlign: 'left',
    border: 'none',
    cursor: 'pointer',
    minWidth: 0,
});

export const protectStrip = styleVariants({
    off: [protectBase, { color: vars.color.mutedForeground, background: 'transparent', ':hover': { color: vars.color.foreground } }],
    on: [protectBase, { color: vars.color.success, background: 'rgba(34, 197, 94, 0.07)' }],
    bad: [protectBase, { color: vars.color.danger, background: 'rgba(239, 68, 68, 0.08)' }],
});

export const protectLabel = style({ fontWeight: 700, whiteSpace: 'nowrap' });
export const protectValue = style({ fontFamily: vars.font.mono, whiteSpace: 'nowrap' });
export const protectMeta = style({ color: vars.color.mutedForeground, whiteSpace: 'nowrap' });
export const protectWarn = style({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 });
export const protectChevron = style({ marginLeft: 'auto', flexShrink: 0 });

export const protectMenu = style({
    position: 'absolute',
    top: 'calc(100% + 2px)',
    left: 6,
    right: 6,
    zIndex: 41,
    maxWidth: '20rem',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: 6,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
});

export const protectHead = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontWeight: 700,
    padding: '2px 4px 4px',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const protectRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 4px',
    whiteSpace: 'nowrap',
});

export const protectSub = style({
    padding: '0 4px 2px 22px',
    lineHeight: 1.8,
    color: vars.color.mutedForeground,
});

export const protectInput = style({
    width: '2.6rem',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    textAlign: 'center',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 3px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
    ':disabled': { opacity: 0.4 },
});

export const protectError = style({
    padding: '2px 4px',
    fontSize: '0.62rem',
    color: vars.color.danger,
});

export const protectActions = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 4,
    padding: '4px 4px 0',
});

// #216 觸價欄：琥珀色虛線框、hover 顯示「觸≥／觸≤」預覽，跟限價的買量／賣量格分開
export const cols7 = style({
    gridTemplateColumns: COLS7,
    '@container': { [MINIMAL]: { gridTemplateColumns: COLS7_MINIMAL } },
});
// narrower cells in the 7-column ladder: volumes keep their digits
globalStyle(`${cols7} [data-side='buy']`, { paddingRight: 4 });
globalStyle(`${cols7} [data-side='sell']`, { paddingLeft: 4 });
globalStyle(`${cols7} > span, ${cols7} > button`, { whiteSpace: 'nowrap', overflow: 'hidden' });

export const trigCell = style([
    cellBase,
    {
        justifyContent: 'center',
        cursor: 'pointer',
        background: amberDim,
        borderLeft: `1px dashed ${vars.color.border}`,
        borderRight: `1px dashed ${vars.color.border}`,
        selectors: {
            '&:hover': { outline: `1px dashed ${vars.color.amber}`, outlineOffset: -2 },
            '&:hover:empty::after': {
                content: 'attr(data-preview)',
                fontFamily: vars.font.body,
                fontSize: '0.58rem',
                fontWeight: 700,
                color: vars.color.amber,
            },
        },
    },
]);

export const headTrigger = style({
    color: vars.color.amber,
    fontWeight: 700,
});

const headPriceBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
});
export const headPrice = styleVariants({
    on: [headPriceBase, { color: vars.color.accent }],
    off: [headPriceBase, { color: vars.color.mutedForeground, ':hover': { color: vars.color.foreground } }],
});

const gearBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.3rem',
    padding: 0,
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':hover': { color: vars.color.foreground },
});
export const gearBtn = styleVariants({
    closed: [gearBase],
    open: [gearBase, { color: vars.color.foreground, borderColor: vars.color.accent }],
});

// 動作列裡的停損停利狀態小標（開／關＋保護中 N）
const protectChipBase = style({
    flex: '0 1 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    padding: '3px 6px',
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    cursor: 'pointer',
    minWidth: 0,
    maxWidth: '100%',
});
export const protectChipText = style({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' });
export const protectChip = styleVariants({
    off: [protectChipBase, { color: vars.color.mutedForeground, borderColor: vars.color.border, background: 'transparent' }],
    on: [protectChipBase, { color: vars.color.success, borderColor: vars.color.success, background: 'rgba(34, 197, 94, 0.08)' }],
    bad: [protectChipBase, { color: vars.color.danger, borderColor: vars.color.danger, background: 'rgba(239, 68, 68, 0.08)' }],
});
export const protectChipAnchor = style({ position: 'static', display: 'inline-flex', minWidth: 0, marginLeft: 'auto' });

// several marks in one 觸價 cell: no minimum width, tight padding
export const markCrowded = style({ gap: 1 });
globalStyle(`${markCrowded} > *`, { minWidth: 0, padding: '0 2px' });
