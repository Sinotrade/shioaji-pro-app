// src/components/quote-board.css.ts

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const board = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.lg,
    padding: `${vars.space.sm} ${vars.space.md}`,
    flexShrink: 0,
    borderBottom: `1px solid ${vars.color.border}`,
    overflow: 'hidden',
});

export const symbolBlock = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: '7rem',
});

export const symbolCode = style({
    fontFamily: vars.font.display,
    fontSize: '1.15rem',
    fontWeight: 700,
    letterSpacing: '0.01em',
    color: vars.color.foreground,
});

export const symbolName = style({
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

const bigPriceBase = style({
    fontFamily: vars.font.mono,
    fontSize: '1.9rem',
    fontWeight: 600,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
});

export const bigPrice = styleVariants({
    up: [bigPriceBase, { color: vars.color.up }],
    down: [bigPriceBase, { color: vars.color.down }],
    flat: [bigPriceBase, { color: vars.color.flat }],
});

export const changeBlock = style({
    display: 'flex',
    flexDirection: 'column',
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    fontVariantNumeric: 'tabular-nums',
});

export const statGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, auto)',
    columnGap: vars.space.lg,
    rowGap: '2px',
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

export const statLabel = style({
    fontFamily: vars.font.display,
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
    fontWeight: 500,
});

export const statValue = style({
    textAlign: 'right',
});

const limitBadgeBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#fff',
    borderRadius: vars.radius.sm,
    padding: '3px 8px',
    alignSelf: 'center',
});

export const limitBadge = styleVariants({
    up: [limitBadgeBase, { background: vars.color.up }],
    down: [limitBadgeBase, { background: vars.color.down }],
});

// 指數看板：data-tier 由 useBoardTier 依面板大小設定（目標是標題列加看板不超過面板高度 1/5，
// strip 保底），各階梯的內容取捨寫在檔尾；未設定（首次繪製前）等同 wide。
// 整列對齊「最後一行」的文字基線：價格、漲跌的百分比、統計的數值列、量能標籤落在同一條線上
// 右側多留 TOGGLE_RESERVE 給絕對定位的展開／收合按鈕，按鈕不參與排版、不會自己換到新的一列
const TOGGLE_RESERVE = `calc(${vars.space.md} + 1.4rem)`;

export const boardIndex = style({
    position: 'relative',
    flexWrap: 'wrap',
    rowGap: vars.space.sm,
    alignItems: 'last baseline',
    paddingRight: TOGGLE_RESERVE,
    selectors: {
        // mid 只允許單行：放不下就讓給 inline，不會換成兩行留下大片空白
        '&[data-tier="mid"]': { flexWrap: 'nowrap' },
        // inline、lean 底部多留一點給數字下方的家數比例條
        '&[data-tier="inline"], &[data-tier="lean"]': {
            flexWrap: 'nowrap',
            columnGap: '0.9rem',
            padding: `${vars.space.xs} ${TOGGLE_RESERVE} 0.3rem ${vars.space.md}`,
        },
        '&[data-tier="compact"]': {
            flexWrap: 'nowrap',
            columnGap: '0.9rem',
            padding: `${vars.space.xs} ${TOGGLE_RESERVE} ${vars.space.xs} ${vars.space.md}`,
        },
        '&[data-tier="strip"]': {
            flexWrap: 'nowrap',
            columnGap: '0.75rem',
            padding: `0.2rem ${TOGGLE_RESERVE} 0.2rem ${vars.space.md}`,
        },
    },
});

// 指數統計區：兩組（漲跌家數／成交量能）橫向排開。wide 時寬面板一排、放不下的組換行，
// basis 取兩組完整並排的實測寬度（約 26rem）；其餘階梯單行、依內容寬度
export const indexStats = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'last baseline',
    // 不用 justify-content: flex-end：空間不夠時內容會往左溢出、壓到漲跌數字，而且量不到。
    // 改由第一組 margin-left: auto 推到右邊，溢出時往右、看板量得到並降級
    justifyContent: 'flex-start',
    gap: `${vars.space.sm} ${vars.space.md}`,
    flex: '1 1 26rem',
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

// 組內欄寬跟著內容、不拉開：組內欄距固定 0.75rem，兩組之間另有分隔線，分組一眼看得出來。
// position: relative 讓家數比例條以格線區域定位、貼在數字正下方
const indexGroupBase = style({
    position: 'relative',
    display: 'grid',
    columnGap: '0.75rem',
    flex: '0 0 auto',
});

export const indexGroup = styleVariants({
    // 量能組格數會依資料有無變動（沒有預估量時收起），用自動欄數，不寫死欄數
    volume: [
        indexGroupBase,
        {
            gridAutoFlow: 'column',
            gridAutoColumns: 'auto',
            paddingLeft: vars.space.md,
            borderLeft: `1px solid ${vars.color.border}`,
        },
    ],
    breadth: [indexGroupBase, { gridTemplateColumns: 'repeat(5, auto)' }],
});

// 不准斷行：中文標籤可以在任意字之間斷開，放不下時會被擠成一字一行；
// 禁止後放不下就真的溢出或換到下一排，useBoardTier 才量得到並改用更精簡的階梯
export const stat = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '3px',
    whiteSpace: 'nowrap',
});

// 有滑過提示的格子：標籤加虛線底線、游標變成說明，看得出來可以滑過看更多。
// 底線平常只留一成濃度（整排點點不搶數字），滑過那一格才恢復成文字色
export const tipCell = style({ cursor: 'help' });
export const tipLabel = style({
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textDecorationColor: 'color-mix(in srgb, currentColor 10%, transparent)',
    textUnderlineOffset: '2px',
});
globalStyle(`${tipCell}:hover ${tipLabel}, ${tipLabel}${tipCell}:hover`, { textDecorationColor: 'currentColor' });

// 數值的單位（億、萬）縮小淡化，數字才是主角
export const unit = style({
    marginLeft: '2px',
    fontSize: '0.78em',
    fontWeight: 400,
    opacity: 0.65,
});

// 漲跌家數比例條：絕對定位在整組家數下方，是整組的比例量表，不對應單一欄位
// （以前只跨中間三欄，紅色段會落在平盤數字正下方，看起來像平盤被標成紅色）。
// 不參與排版，所以不影響基線對齊、也不增加看板高度
export const breadthBar = style({
    position: 'absolute',
    gridRow: 1,
    gridColumn: '1 / -1',
    top: 'calc(100% + 2px)',
    left: 0,
    right: 0,
    display: 'flex',
    height: '3px',
    borderRadius: '2px',
    overflow: 'hidden',
    background: vars.color.muted,
});

const breadthSegBase = style({ flexBasis: 0, minWidth: 0 });

export const breadthSeg = styleVariants({
    up: [breadthSegBase, { background: vars.color.up }],
    flat: [breadthSegBase, { background: vars.color.flat }],
    down: [breadthSegBase, { background: vars.color.down }],
});

// 漲停／跌停家數：大於 0 時淡底色標籤，等於 0 為灰字（底色降飽和，不跟價格搶目光）
const limitCountBase = style({
    borderRadius: vars.radius.sm,
    padding: '0 5px',
});

export const limitCount = styleVariants({
    up: [
        limitCountBase,
        {
            color: vars.color.up,
            fontWeight: 700,
            background: `color-mix(in srgb, ${vars.color.up} 12%, transparent)`,
        },
    ],
    down: [
        limitCountBase,
        {
            color: vars.color.down,
            fontWeight: 700,
            background: `color-mix(in srgb, ${vars.color.down} 12%, transparent)`,
        },
    ],
    zero: [limitCountBase, { color: vars.color.mutedForeground }],
});

// 低優先（成交金額、時間）：mid 起收進預估量的滑過提示
export const lowPriority = style({});
// 次要（漲停、平盤、跌停、預估量）：lean 只留上漲、下跌、較昨日
export const secondary = style({});

// 量能標籤（量-12%）：統計區收起時（compact）留在價格旁邊。
// 中性色：量能減少不等於下跌，紅綠只留給價格方向
export const leadTag = style({
    display: 'none',
    flexShrink: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

// compact 的家數比例條：短短一截跟在量能標籤後面，意思綁在內容上，不再橫跨整個看板
export const breadthMini = style({
    display: 'none',
    alignSelf: 'center',
    flexShrink: 0,
    width: '3rem',
    height: '4px',
    borderRadius: '2px',
    overflow: 'hidden',
    background: vars.color.muted,
});

// 展開／收合統計：絕對定位在看板右側、垂直置中，看板右側預留空間（TOGGLE_RESERVE）。
// 平常就要看得到（對比至少 3:1），滑過看板或按鈕時更明顯
export const boardToggle = style({
    position: 'absolute',
    right: '0.35rem',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '1.4rem',
    height: '1.4rem',
    padding: 0,
    display: 'grid',
    placeItems: 'center',
    border: 'none',
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    opacity: 0.8,
    cursor: 'pointer',
    selectors: {
        '&:hover, &:focus-visible': { opacity: 1, background: vars.color.muted },
    },
});

globalStyle(`${boardIndex}:hover ${boardToggle}`, { opacity: 1 });

// 已展開（aria-expanded）時箭頭朝上
globalStyle(`${boardToggle}[aria-expanded="true"] svg`, { transform: 'rotate(180deg)' });

globalStyle(`${indexStats} > :first-child`, { marginLeft: 'auto' });

// ---- 各階梯的內容取捨（wide 為完整版，不需另外寫規則） ----
const tier = (name: string) => `${boardIndex}[data-tier="${name}"]`;
const tiers = (names: string[], child: string) => names.map((n) => `${tier(n)} ${child}`).join(', ');
const SINGLE_ROW = ['mid', 'inline', 'lean'];

// mid、inline、lean：成交金額、時間收進預估量的滑過提示；統計單行、依內容寬度，兩組整組靠右
globalStyle(tiers(SINGLE_ROW, lowPriority), { display: 'none' });
globalStyle(tiers(SINGLE_ROW, indexStats), { flexWrap: 'nowrap', flexBasis: 'auto', columnGap: '0.9rem' });

// inline、lean：中間寬度、高度又不夠兩層時擠進價格同一行，標籤與數值行高收緊
globalStyle(tiers(['inline', 'lean'], stat), { gap: '2px', lineHeight: 1.1 });

// lean：再窄一點，只留上漲、下跌、較昨日
globalStyle(tier('lean') + ' ' + secondary, { display: 'none' });
globalStyle(tier('lean') + ' ' + indexGroup.breadth, { gridTemplateColumns: 'repeat(2, auto)' });

// compact、strip：統計區整組收起
globalStyle(tiers(['compact', 'strip'], indexStats), { display: 'none' });
globalStyle(tier('compact') + ' ' + leadTag, { display: 'inline-block' });
globalStyle(tier('compact') + ' ' + breadthMini, { display: 'flex' });

globalStyle(tiers(['inline', 'lean', 'compact'], bigPriceBase), { fontSize: '1.5rem' });
globalStyle(tiers(['inline', 'lean', 'compact'], changeBlock), { lineHeight: 1.05 });

// strip（保底）：現價與漲跌幅一行，拿掉漲跌點數，確保比其他階梯都窄
globalStyle(tier('strip') + ' ' + bigPriceBase, { fontSize: '1.1rem' });
globalStyle(tier('strip') + ' ' + changeBlock, { flexDirection: 'row', fontSize: '0.75rem' });
globalStyle(`${tier('strip')} ${changeBlock} > :first-child`, { display: 'none' });
