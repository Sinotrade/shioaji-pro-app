// src/components/quote-board.css.ts

import { createContainer, globalStyle, style, styleVariants } from '@vanilla-extract/css';
import type { BoardTier } from '../lib/board-tier';
import { RAIL_CHARS, RAIL_METRICS, railCellsRem } from '../lib/day-range';
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

// 有階梯的看板（指數、個股共用）：data-tier 由 useBoardTier 依面板大小設定（目標是標題列加看板
// 不超過面板高度 1/5，strip 保底），各階梯的內容取捨寫在檔尾；未設定（首次繪製前）等同 wide。
// 整列對齊「最後一行」的文字基線：價格、漲跌的百分比、統計的數值列落在同一條線上
// 右側多留 TOGGLE_RESERVE 給絕對定位的展開／收合按鈕，按鈕不參與排版、不會自己換到新的一列
const TOGGLE_RESERVE = `calc(${vars.space.md} + 1.4rem)`;
const on = (...names: BoardTier[]) => names.map((name) => `&[data-tier="${name}"]`).join(', ');

export const boardTiered = style({
    position: 'relative',
    flexWrap: 'wrap',
    rowGap: vars.space.sm,
    alignItems: 'last baseline',
    paddingRight: TOGGLE_RESERVE,
    selectors: {
        // mid 只允許單行：放不下就讓給 inline，不會換成兩行留下大片空白。
        // 個股軌道兩級也只允許單行：放不下就讓給原本的數字欄
        [on('mid', 'rail', 'railMid')]: { flexWrap: 'nowrap' },
        // inline、lean 底部多留一點給數字下方的家數比例條
        [on('inline', 'lean', 'railLow')]: {
            flexWrap: 'nowrap',
            columnGap: '0.9rem',
            padding: `${vars.space.xs} ${TOGGLE_RESERVE} 0.3rem ${vars.space.md}`,
        },
        // 軌道各級的項目間距收窄：軌道取代數字欄時要多約 200px，1.5rem 的間距一個就占 28px，
        // 收窄後中等寬度（台指期約 640px 起）就放得下軌道，不會明明有空位卻退回數字欄
        [on('rail', 'railMid', 'railLow')]: { columnGap: '0.75rem' },
        [on('compact', 'tight')]: {
            flexWrap: 'nowrap',
            columnGap: '0.9rem',
            padding: `${vars.space.xs} ${TOGGLE_RESERVE} ${vars.space.xs} ${vars.space.md}`,
        },
        [on('strip')]: {
            flexWrap: 'nowrap',
            columnGap: '0.75rem',
            padding: `0.2rem ${TOGGLE_RESERVE} 0.2rem ${vars.space.md}`,
        },
    },
});

// 指數看板的標記（內容取捨規則掛在它底下）
export const boardIndex = style({});

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

// 兩組格數都會變動（沒有預估量時收起、使用者自訂關掉的格子不畫、lean 只留幾格），用自動欄數，不寫死欄數
export const indexGroup = styleVariants({
    volume: [indexGroupBase, { gridAutoFlow: 'column', gridAutoColumns: 'auto' }],
    breadth: [indexGroupBase, { gridAutoFlow: 'column', gridAutoColumns: 'auto' }],
});
// 兩組之間的分隔線畫在後面那一組的左側（使用者可以調換兩組的順序）。用絕對定位的線而不是 padding＋border：
// 家數比例條以整組的 padding box 定位，padding 會讓比例條往左多出一截
globalStyle(`${indexGroupBase} + ${indexGroupBase}`, { marginLeft: vars.space.md });
globalStyle(`${indexGroupBase} + ${indexGroupBase}::before`, {
    content: '""',
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `calc(-1 * ${vars.space.md})`,
    borderLeft: `1px solid ${vars.color.border}`,
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
// 第三種：量比的標籤和數值是相鄰的兩格，滑過數值時標籤也要恢復
globalStyle(`${tipCell}:hover ${tipLabel}, ${tipLabel}${tipCell}:hover, ${tipLabel}:has(+ ${tipCell}:hover)`, {
    textDecorationColor: 'currentColor',
});

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
// 右側工具（自訂欄位、展開收合）：絕對定位不參與排版，完整階梯（看板約 63px 高）時齒輪疊在箭頭上方
export const boardTools = style({
    position: 'absolute',
    right: '0.35rem',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

const toolBtnBase = style({
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

export const boardToggle = toolBtnBase;
// 齒輪平常淡一點，滑過看板才清楚；打開設定時維持亮著
export const boardSettings = style([
    toolBtnBase,
    {
        opacity: 0.45,
        selectors: { '&[aria-expanded="true"]': { opacity: 1, color: vars.color.accent } },
    },
]);

globalStyle(`${boardTiered}:hover ${boardToggle}, ${boardTiered}:hover ${boardSettings}`, { opacity: 1 });
// 精簡階梯（單行，看板不到兩個按鈕高）只留展開收合；自訂欄位改由展開後的齒輪或右鍵打開
globalStyle(
    (['inline', 'lean', 'compact', 'tight', 'strip', 'railLow'] as const)
        .map((t) => `${boardTiered}[data-tier="${t}"] ${boardSettings}`)
        .join(', '),
    { display: 'none' },
);

// 已展開（aria-expanded）時箭頭朝上
globalStyle(`${boardToggle}[aria-expanded="true"] svg`, { transform: 'rotate(180deg)' });

globalStyle(`${indexStats} > :first-child`, { marginLeft: 'auto' });

// ---- 各階梯的內容取捨（wide 為完整版，不需另外寫規則） ----
const tierOf = (base: string) => (name: BoardTier) => `${base}[data-tier="${name}"]`;
const tiersOf = (base: string) => (names: readonly BoardTier[], child: string) =>
    names.map((n) => `${tierOf(base)(n)} ${child}`).join(', ');
const tier = tierOf(boardIndex);
const tiers = tiersOf(boardIndex);
const SINGLE_ROW: readonly BoardTier[] = ['mid', 'inline', 'lean'];

// mid、inline、lean：成交金額、時間收進預估量的滑過提示；統計單行、依內容寬度，兩組整組靠右
globalStyle(tiers(SINGLE_ROW, lowPriority), { display: 'none' });
globalStyle(tiers(SINGLE_ROW, indexStats), { flexWrap: 'nowrap', flexBasis: 'auto', columnGap: '0.9rem' });

// inline、lean：中間寬度、高度又不夠兩層時擠進價格同一行，標籤與數值行高收緊
globalStyle(tiers(['inline', 'lean'], stat), { gap: '2px', lineHeight: 1.1 });

// lean：再窄一點，只留上漲、下跌、較昨日
globalStyle(tier('lean') + ' ' + secondary, { display: 'none' });

// compact、strip：統計區整組收起
globalStyle(tiers(['compact', 'strip'], indexStats), { display: 'none' });
globalStyle(tier('compact') + ' ' + leadTag, { display: 'inline-block' });
globalStyle(tier('compact') + ' ' + breadthMini, { display: 'flex' });

// ---- 通用（指數、個股）：單行階梯縮小價格、收緊漲跌兩行 ----
const gTier = tierOf(boardTiered);
const gTiers = tiersOf(boardTiered);
const SMALL_PRICE: readonly BoardTier[] = ['inline', 'lean', 'railLow', 'compact', 'tight'];
globalStyle(gTiers(SMALL_PRICE, bigPriceBase), { fontSize: '1.5rem' });
globalStyle(gTiers(SMALL_PRICE, changeBlock), { lineHeight: 1.05 });

// strip（保底）：現價與漲跌幅一行，拿掉漲跌點數，確保比其他階梯都窄
globalStyle(gTier('strip') + ' ' + bigPriceBase, { fontSize: '1.1rem' });
globalStyle(gTier('strip') + ' ' + changeBlock, { flexDirection: 'row', fontSize: '0.75rem' });
globalStyle(`${gTier('strip')} ${changeBlock} > :first-child`, { display: 'none' });

// ---- 個股、期貨、選擇權（非指數）看板：成對兩行 ----
// 上排放「上方」的值（高、漲停），下排放「下方」的值（低、跌停），跟價格軸方向一致。
// 代號名稱交給標題列；參考價、時間收進漲跌與現價的滑過提示；最佳一檔交給五檔面板，看板不重複
export const boardStock = style({});

// 會畫區間軌、盤前還沒有開高低的個股：wide 只允許單行，放不下就讓給 mid 以下（和盤中軌道放不下時一樣），
// 高窄面板 08:30、09:00 報價欄才不會先換成兩列再縮回（使用者指定；代價是盤前在窄面板手動展開時右側可能被裁掉）
export const boardRailPending = style({});
globalStyle(`${boardRailPending}[data-tier="wide"]`, { flexWrap: 'nowrap' });

export const stockStats = style({
    display: 'flex',
    alignItems: 'last baseline',
    flexWrap: 'nowrap',
    columnGap: vars.space.lg,
    marginLeft: 'auto',
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
});

const pairBase = style({
    display: 'grid',
    columnGap: '0.5rem',
    rowGap: '2px',
    alignItems: 'baseline',
});

// 標籤＋數值（高／低、開／量、漲停／跌停）
export const pairGroup = style([pairBase, { gridTemplateColumns: 'auto auto' }]);
// 開、量、量比這類單格連續排成一欄：第一格在上排，其餘在下排（預設：上排開，下排量與量比）。
// 欄數依下排格數（每格標籤加數值兩欄），由 quote-board.tsx 設定
export const VOL_COLS_VAR = '--qb-vol-cols';
export const volGroup = style([pairBase, { gridTemplateColumns: `repeat(var(${VOL_COLS_VAR}, 4), auto)` }]);
export const rowTop = style({ gridRow: 1 });
export const rowBottom = style({ gridRow: 2 });

// 字級連動 lib/day-range 的 railCellsRem（軌道數字列的收起門檻）
export const pairLabel = style({
    fontFamily: vars.font.display,
    fontSize: `${RAIL_METRICS.labelRem}rem`,
    color: vars.color.mutedForeground,
});

export const pairValue = style({ textAlign: 'right' });

// 停板組：mid 起收起（到停板時價格旁的漲停／跌停徽章照樣會亮）
export const stockLimit = style({});
// 開／量組固定上排開、下排量；lean 只收起開，量留在下排（優先序：量 > 高低 > 開 > 停板）
export const stockOpen = style({});
export const stockVol = style({});
// 量比（今日成交量 ÷ 昨日成交量），算法放在滑過提示
export const stockRatio = style({});

// compact：統計收起時，價格旁留成交量與量比；tight 只留成交量
export const stockVolTag = style({
    display: 'none',
    flexShrink: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});
// 價格旁的量比（compact 顯示、tight 收起），和量之間留一點距離
export const stockVolTagRatio = style({ marginLeft: '0.6rem' });

const sTier = tierOf(boardStock);
const sTiers = tiersOf(boardStock);

globalStyle(sTiers(['mid', 'inline', 'lean'], stockLimit), { display: 'none' });
// inline、lean：兩行行高收緊
globalStyle(sTiers(['inline', 'lean'], pairGroup), { lineHeight: 1.2 });
globalStyle(sTiers(['inline', 'lean'], volGroup), { lineHeight: 1.2 });
globalStyle(sTiers(['inline', 'lean'], stockStats), { columnGap: '0.9rem' });
globalStyle(sTier('lean') + ' ' + stockOpen, { display: 'none' });
// compact、tight、strip：統計收起（收起順序：漲跌停價 → 開 → 高低 → 量比 → 量）
globalStyle(sTiers(['compact', 'tight', 'strip'], stockStats), { display: 'none' });
globalStyle(sTiers(['compact', 'tight'], stockVolTag), { display: 'inline-block' });
globalStyle(sTier('tight') + ' ' + stockVolTagRatio, { display: 'none' });

// ---- 個股日內區間軌（rail、railMid、railLow 三級，見 day-range-rail.tsx） ----
// 上面是圖、下面一行數字。寬度跟著剩餘空間伸縮。
// rail：最小寬度由數字列的內容決定（flex 項目預設 min-width: auto），排不下就溢出，階梯量測會改用下一級。
// railMid、railLow：數字列的格子當容器，依它的寬度決定留幾格（見檔尾），所以軌道可以比數字列窄，
// 最小只留圖形（10rem，圖形約 100px 寬才看得出區間）；這兩級要明寫 min-width，階梯才量得到放不放得下
const railBox = createContainer();
export const railSlot = style({
    display: 'none',
    flexDirection: 'column',
    gap: '2px',
    flex: '1 1 0',
    alignSelf: 'center',
});
export const railGraphic = style({ width: '100%' });
export const railSvg = style({ display: 'block', width: '100%' });
// 軌道底線：比外框亮一階，兩端沒有箭頭時也看得出尺的長度
export const railTrack = style({ fill: vars.color.borderBright });
export const railNotch = style({ fill: vars.color.borderBright });
// 參考線、停板端線
export const railMark = style({ fill: vars.color.mutedForeground });
// 平盤（參考價）：點線，比刻度與次要文字亮一階（往前景色混四成，跟著深淺色與自訂配色）
export const railRef = style({
    stroke: `color-mix(in srgb, ${vars.color.mutedForeground} 60%, ${vars.color.foreground})`,
    strokeWidth: 1,
    strokeDasharray: '2 2',
});
// 兩端的尺幅度字（-1%、+1%）；字級要和 day-range-rail 量寬度用的 TAG_REM 一致
export const railTag = style({ fontFamily: vars.font.mono, fontSize: `${RAIL_METRICS.tagRem}rem`, fill: vars.color.mutedForeground });
// 參考線兩側的縫：穿過實體或引線時才看得見
export const railGap = style({ fill: vars.color.panel });
export const railBody = styleVariants({ up: { fill: vars.color.up }, down: { fill: vars.color.down } });
export const railWick = styleVariants({ up: { fill: vars.color.wickUp }, down: { fill: vars.color.wickDown } });
// 現價針：前景色加一圈面板色描邊，疊在實體上也分得開
export const railNeedle = style({
    fill: vars.color.foreground,
    stroke: vars.color.panel,
    strokeWidth: 1.5,
    paintOrder: 'stroke',
});
// 數字列：由小到大、固定間距從軌道起點往右排（不撐滿軌道，免得被當成刻度和軌道上的位置配對），
// 字級同右側數字欄
export const railNumbers = style({
    fontFamily: vars.font.mono,
    fontSize: `${RAIL_METRICS.numberRem}rem`,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.25,
    whiteSpace: 'nowrap',
});
// 格距連動 lib/day-range 的 railCellsRem
export const railCells = style({ display: 'flex', justifyContent: 'flex-start', columnGap: `${RAIL_METRICS.cellGapRem}rem` });
export const railNumLabel = style([pairLabel, { marginRight: `${RAIL_METRICS.labelGapRem}rem` }]);
// 跌停、漲停價整天不變，數值降成次要灰，讓低、開、高跳出來
export const railNumMuted = style({ color: vars.color.mutedForeground });
// 數字列兩端的格子（跌停／漲停，或指數期的距低／距高）：railMid、railLow 收起
export const railEdge = style({});
// 開盤價、最高最低：軌道變窄時依序收起（容器查詢，見檔尾）。開盤價的位置軌道上看得到（實體的一端）
export const railOpen = style({});
export const railHL = style({});

// 產業分類：只在 rail（最寬）顯示，用主題的強調色做成標籤（跟著深淺色與自訂配色）
export const sectorTag = style({
    display: 'none',
    alignSelf: 'center',
    flexShrink: 0,
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 500,
    // 文字往前景色混一成半：淺色主題原本的藍對淡藍底只有 4.27:1，混過之後兩個主題都有 5:1 以上
    color: `color-mix(in srgb, ${vars.color.accent} 85%, ${vars.color.foreground})`,
    background: vars.color.accentDim,
    border: `1px solid color-mix(in srgb, ${vars.color.accent} 35%, transparent)`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    whiteSpace: 'nowrap',
    // 可點（跳到產業全景）：按鈕預設的外距與行高會改變版面，歸零沿用原本的尺寸
    margin: 0,
    lineHeight: 'inherit',
    cursor: 'pointer',
    ':hover': { borderColor: vars.color.accent },
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
});

const RAIL: readonly BoardTier[] = ['rail', 'railMid', 'railLow'];
globalStyle(sTiers(RAIL, railSlot), { display: 'flex' });
const RAIL_NARROW: readonly BoardTier[] = ['railMid', 'railLow'];
globalStyle(sTiers(RAIL_NARROW, railEdge), { display: 'none' });
// railLow：圖與數字之間不留縫、數字列行高 1，顯示低、高時也不比沒有數字時高（不會因此換到沒有軌道的階梯）
globalStyle(sTier('railLow') + ' ' + railSlot, { gap: 0 });
globalStyle(sTier('railLow') + ' ' + railNumbers, { lineHeight: 1 });
// 數字列的格子當容器：寬度不夠就依序收起開盤價、最高最低，最後只剩圖形（使用者指定的收起順序：
// 漲跌停價 → 最高最低，開盤價排在最高最低之前；右側的量比、量不在軌道裡，不受影響）。
// 門檻依實際字數（data-chars，見 lib/day-range 的 railCellsRem），短價格不會在放得下時被收掉
globalStyle(sTiers(RAIL_NARROW, railSlot), { minWidth: '10rem' });
globalStyle(sTiers(RAIL_NARROW, railCells), { containerType: 'inline-size', containerName: railBox });
for (const n of RAIL_CHARS) {
    const cells = (child: string) =>
        RAIL_NARROW.map((t) => `${sTier(t)} ${railCells}[data-chars="${n}"] > ${child}`).join(', ');
    globalStyle(cells(railOpen), {
        '@container': { [`${railBox} (max-width: ${railCellsRem(3, n).toFixed(2)}rem)`]: { display: 'none' } },
    });
    globalStyle(cells(railHL), {
        '@container': { [`${railBox} (max-width: ${railCellsRem(2, n).toFixed(2)}rem)`]: { display: 'none' } },
    });
}
globalStyle(sTier('rail') + ' ' + sectorTag, { display: 'inline-block' });
// 高低、開、停板交給軌道；右側只留量與量比，排成一行、對齊軌道中線
globalStyle(sTiers(RAIL, `${stockStats} > ${pairGroup}`), { display: 'none' });
globalStyle(sTiers(RAIL, stockOpen), { display: 'none' });
globalStyle(sTiers(RAIL, rowTop), { gridRow: 'auto' });
globalStyle(sTiers(RAIL, rowBottom), { gridRow: 'auto' });
// 單格欄排成一行：不論使用者把量、量比排在上排或下排，軌道階梯都放在同一行
globalStyle(sTiers(RAIL, volGroup), { gridTemplateColumns: 'none', gridAutoFlow: 'column' });
globalStyle(sTiers(RAIL, stockStats), { alignSelf: 'center', marginLeft: 0 });

// 放在漲跌區內，避免成為階梯量測的直屬節點或污染現價的字寬估算。
export const srOnly = style({
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
});

export const statusBadge = style({
    alignSelf: 'center',
    flexShrink: 0,
    fontFamily: vars.font.body,
    fontSize: '0.56rem',
    fontWeight: 600,
    padding: '0 3px',
    color: vars.color.amber,
    border: `1px solid ${vars.color.amber}`,
    borderRadius: vars.radius.sm,
    whiteSpace: 'nowrap',
});
// 單行的窄階梯保留價格空間，狀態事實仍可從提示與讀屏文字取得。
const STOCK_NARROW: readonly BoardTier[] = ['inline', 'lean', 'compact', 'tight', 'strip'];
globalStyle(sTiers(STOCK_NARROW, statusBadge), { display: 'none' });
// 試撮價剛好在漲跌停：窄階梯只留一個標籤，留「試撮」、收起停板徽章，免得看成已經鎖停（寬階梯兩個都顯示）。
// 同 specificity，靠宣告順序蓋過上一條
export const statusKeep = style({});
export const limitWide = style({});
globalStyle(sTiers(STOCK_NARROW, statusKeep), { display: 'inline' });
globalStyle(sTiers(STOCK_NARROW, limitWide), { display: 'none' });
globalStyle(tiers(['inline', 'lean', 'compact', 'strip'], statusBadge), { display: 'none' });
