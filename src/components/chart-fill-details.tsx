import { Fragment, memo, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { fillDecimals, fillPriceText, priceKey, type ChartFill } from '../lib/chart-fills';
import { maskAccountId } from '../lib/privacy';
import * as styles from './chart-fill-details.css';

// 固定台北時區。價格是商品報價，不以帳戶金額遮罩處理。
// 來源帶小數秒才顯示到毫秒；先四捨五入，免得浮點誤差把 .123 顯示成 .122
// dateless：窄面板的分 K tooltip 省略月日（同一根分 K 的成交看時分秒就夠）；日 K 一根會跨兩個日期，不能省。
// seconds：窄面板的 tooltip 只到秒（毫秒會把最右邊的數量擠出框外），明細清單照樣到毫秒
function fillClock(ts: number, dateless = false, seconds = false) {
    return new Date(Math.round((ts + 8 * 3600) * 1000)).toISOString()
        .slice(dateless ? 11 : 5, seconds || Number.isInteger(ts) ? 19 : 23).replace('T', ' ');
}

// 清單可能上百列且隨圖表重繪：格式器建一次（帶選項的 toLocaleString 每次重建、慢約 70 倍）
const PRICE_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
const QTY_FORMAT = new Intl.NumberFormat();

// 合計數量：張、股、口不能相加，各單位分開列（依出現順序）
function totalQuantity(fills: readonly ChartFill[]) {
    const sums = new Map<ChartFill['unit'], number>();
    for (const fill of fills) sums.set(fill.unit, (sums.get(fill.unit) ?? 0) + fill.quantity);
    return [...sums].map(([unit, quantity]) => `${QTY_FORMAT.format(quantity)} ${unit}`).join('＋');
}

const NO_FILLS: readonly ChartFill[] = [];
// 清單最多列這麼多筆（最新的）：上萬筆全畫成表格，打開或每筆新回報都會卡住畫面
export const FILL_LIST_MAX = 500;
// 其中保留給無對應 K 棒的成交（多半是當天最晚的盤後成交）的名額，圖上成交再多也看得到
const FILL_LIST_UNPLACED = 50;

// 均價摘要：同商品、同方向、同單位一筆（買先於賣）；multi＝這根 K 棒有 2 個以上價位（tooltip 只列這種）。
// 也可以給每價分組（quantity 是那個價位的合計）：同商品、方向、單位裡價位互不相同，結果和逐筆算一樣
interface FillSummary { key: string; code: string; action: ChartFill['action']; unit: ChartFill['unit']; quantity: number; avg: number; low: number; high: number; multi: boolean }
function fillSummaries(fills: readonly Pick<ChartFill, 'code' | 'action' | 'unit' | 'price' | 'quantity'>[]): FillSummary[] {
    const sums = new Map<string, FillSummary & { notional: number; prices: Set<string> }>();
    for (const fill of fills) {
        const key = `${fill.code}|${fill.action}|${fill.unit}`;
        const sum = sums.get(key);
        if (!sum) {
            sums.set(key, { key, code: fill.code, action: fill.action, unit: fill.unit, quantity: fill.quantity, notional: fill.price * fill.quantity,
                avg: 0, low: fill.price, high: fill.price, multi: false, prices: new Set([priceKey(fill.price)]) });
            continue;
        }
        sum.quantity += fill.quantity;
        sum.notional += fill.price * fill.quantity;
        sum.low = Math.min(sum.low, fill.price);
        sum.high = Math.max(sum.high, fill.price);
        sum.prices.add(priceKey(fill.price));
    }
    return [...sums.values()]
        .map(s => ({ ...s, avg: s.notional / s.quantity, multi: s.prices.size > 1 }))
        .sort((a, b) => (a.action === b.action ? 0 : a.action === 'Buy' ? -1 : 1) || a.code.localeCompare(b.code));
}

// 摘要文字（提示框均價摘要與清單「這根 K 棒」共用）：2 個以上價位「▲ 買 22 口 · 均 46,464.4 · 46,458～46,474」，
// 1 個價位「▲ 買 3 口 · 46,459」；價格位數同圖表、均價最多多 1 位（沒給位數就不補 0、最多 8 位）
function summaryText(sum: FillSummary, withCode: boolean, decimalsFor?: (price: number) => number) {
    const price = (p: number) => fillPriceText(p, fillDecimals(decimalsFor, p));
    const head = `${withCode ? `${sum.code} ` : ''}${sum.action === 'Buy' ? '▲ 買' : '▼ 賣'} ${QTY_FORMAT.format(sum.quantity)} ${sum.unit}`;
    if (!sum.multi) return `${head} · ${price(sum.low)}`;
    const min = fillDecimals(decimalsFor, sum.avg);
    return `${head} · 均 ${fillPriceText(sum.avg, min, decimalsFor ? min + 1 : 8)} · ${price(sum.low)}～${price(sum.high)}`;
}

function ChartFillDetailsView({ fills, bar, unplaced = NO_FILLS, accountId, allAccounts = false, retained = false, privacy, up, down, tooltip = false, compact = false, dateless = false, pending = false, note, hint, barsLoading = false, id, decimalsFor, focus, onClearFocus }: {
    fills: readonly ChartFill[];
    /** tooltip：整根 K 棒的成交（筆數、合計、均價摘要用；同一根裡換價位時不變）；沒有就用 fills */
    bar?: readonly ChartFill[];
    /** 圖上沒有對應 K 棒的成交（例如盤後）：只在清單，列在最後 */
    unplaced?: readonly ChartFill[];
    accountId?: string;
    /** 全部帳戶：逐筆多一欄帳戶，表頭不顯示單一帳戶 */
    allAccounts?: boolean;
    /** 圖上畫著保留的淡色標記（斷線時帳戶可能暫時解析不出來）：照樣說明待確認，不請使用者選帳戶 */
    retained?: boolean;
    privacy: boolean;
    up: string;
    down: string;
    tooltip?: boolean;
    /** 窄面板：tooltip 貼邊、縮小內距 */
    compact?: boolean;
    /** tooltip 省略月日（只給分 K 窄面板用） */
    dateless?: boolean;
    pending?: boolean;
    /** 成交來源未確認時的原因（例如「成交待對帳：串流中斷」），沒有就用預設說法 */
    note?: string;
    /** 待確認時的處置（例如「可到主視窗的委託分頁按更新」），沒有就請使用者用委託分頁的更新 */
    hint?: string;
    /** K 線還沒載入：不能把空清單說成沒有成交 */
    barsLoading?: boolean;
    id?: string;
    /** 圖表的價格位數（tooltip 均價摘要與清單「這根 K 棒」摘要行用）；沒有就不補 0、最多 8 位 */
    decimalsFor?: (price: number) => number;
    /** 清單的「這根 K 棒」：time 是 K 棒 label，label 是顯示用的時間，fills 是那根的全部成交（不受 500 列限制），
     * groups 是那根的每價分組（有給就用它算摘要，上萬筆的日 K 不必逐筆重算）。tooltip 時忽略 */
    focus?: { time: number; label: string; fills: readonly ChartFill[]; groups?: readonly Pick<ChartFill, 'code' | 'action' | 'unit' | 'price' | 'quantity'>[] } | null;
    /** 按摘要行的「×」時呼叫 */
    onClearFocus?: () => void;
}) {
    // hover 只留必要資訊，大量分筆仍可在可捲動的明細清單查閱（清單只列最新 FILL_LIST_MAX 筆）。
    // 清單兩段合計最多 FILL_LIST_MAX 列，各取最新的：無對應 K 棒的至少保留 FILL_LIST_UNPLACED 個名額，其餘給圖上的
    const extraCount = tooltip ? 0 : Math.min(unplaced.length, Math.max(FILL_LIST_UNPLACED, FILL_LIST_MAX - fills.length));
    const rows = tooltip ? fills.slice(0, 4) : fills.slice(Math.max(0, fills.length - (FILL_LIST_MAX - extraCount)));
    const extra = extraCount ? unplaced.slice(unplaced.length - extraCount) : NO_FILLS;
    const hidden = tooltip ? 0 : fills.length - rows.length + unplaced.length - extra.length;
    const all = bar ?? fills;
    const { summaries, total } = useMemo(() => {
        if (!tooltip) return { summaries: [], total: '' };
        const summaries = fillSummaries(all).filter(s => s.multi);
        return { summaries, total: totalQuantity(all) };
    }, [tooltip, all]);
    const multiCode = useMemo(() => {
        const codes = new Set<string>();
        for (const source of tooltip ? [all] : [fills, unplaced]) for (const fill of source) {
            codes.add(fill.code);
            if (codes.size > 1) return true;
        }
        return false;
    }, [tooltip, all, fills, unplaced]);
    // 沒有圖表帳戶就沒有東西被藏起來：先請使用者選帳戶，不要說在等確認
    const scoped = allAccounts || !!accountId || retained;
    const waiting = pending && scoped;
    const count = tooltip ? `${all.length} 筆／${total}`
        : barsLoading ? '… 筆' : unplaced.length ? `${fills.length} 筆（圖上）＋${unplaced.length} 筆無對應 K 棒` : `${fills.length} 筆`;
    // 清單的「這根 K 棒」（待確認時 fills 是空的：不畫摘要行、不標亮）：摘要只在這根跨合約時加代碼；
    // listed 是清單（rows 已受上限裁過）裡列到的筆數
    const shown = !tooltip && focus && focus.fills.length > 0 ? focus : null;
    const src = shown ? shown.groups ?? shown.fills : NO_FILLS;
    const focusCode = new Set(src.map(fill => fill.code)).size > 1;
    const parts = shown ? fillSummaries(src).map(sum => ({ key: sum.key, action: sum.action, text: summaryText(sum, focusCode, decimalsFor) })) : [];
    const listed = shown ? rows.filter(fill => fill.time === shown.time).length : 0;
    const lineId = useId();
    const boxRef = useRef<HTMLDivElement>(null);
    const lineRef = useRef<HTMLDivElement>(null);
    // 只在打開（或換成另一根）時捲一次：相依只放 time，新回報換了 fills、待確認時摘要行暫時消失都不再捲。
    // 摘要行 sticky、top 抵掉容器上內距，黏住時頂端就是容器內緣：第一筆標亮的列捲到它下緣
    const scrollKey = tooltip ? undefined : focus?.time;
    useLayoutEffect(() => {
        const box = boxRef.current, line = lineRef.current;
        const row = box && line ? box.querySelector<HTMLElement>('tr[aria-current]') : null;
        if (row) box!.scrollTop += row.getBoundingClientRect().top - box!.getBoundingClientRect().top - box!.clientTop - line!.offsetHeight;
    }, [scrollKey]);
    const row = (fill: ChartFill, focused: boolean) => <FillRow key={fill.id} fill={fill} dateless={tooltip && dateless} up={up} down={down} allAccounts={allAccounts} privacy={privacy} tooltip={tooltip} compact={compact} multiCode={multiCode} focused={focused} />;
    // 說明只指向摘要（和未列提示），不含「×」按鈕的名稱
    return <div id={id} ref={boxRef} tabIndex={tooltip ? undefined : 0}
        aria-describedby={shown ? (listed < shown.fills.length ? `${lineId}-s ${lineId}-n` : `${lineId}-s`) : undefined}
        className={tooltip ? (compact ? `${styles.tooltip} ${styles.tooltipCompact}` : styles.tooltip) : styles.details}
        role={tooltip ? 'tooltip' : 'region'} aria-label={tooltip ? '此 K 棒成交' : '已載入成交明細'} data-fill-details={tooltip ? 'hover' : 'list'}>
        <div className={styles.header}>
            <strong>{waiting ? note ?? '成交資料待確認' : `${tooltip ? '此 K 棒成交' : '已載入成交'} · ${count}`}</strong>
            {allAccounts ? <span className={styles.muted}>全部帳戶</span>
                : accountId && <span className={styles.muted}>帳戶 {maskAccountId(accountId, privacy)}</span>}
        </div>
        {shown && <div data-fill-focus ref={lineRef} className={styles.focusLine}>
            <span id={`${lineId}-s`}>{shown.label} 這根：{parts.map((part, i) => <Fragment key={part.key}>
                {i > 0 && '；'}<span style={{ color: part.action === 'Buy' ? up : down }}>{part.text}</span>
            </Fragment>)}</span>
            {listed < shown.fills.length && <span id={`${lineId}-n`} className={styles.muted}>
                {listed ? `此棒另有 ${QTY_FORMAT.format(shown.fills.length - listed)} 筆未列於目前清單` : '此棒成交未列於目前清單'}
            </span>}
            <button type="button" className={styles.focusClear} aria-label="取消標示這根 K 棒" title="取消標示這根 K 棒"
                onClick={() => { onClearFocus?.(); boxRef.current?.focus({ preventScroll: true }); }}>×</button>
        </div>}
        {summaries.map(sum => <div key={sum.key} data-fill-summary={sum.key} style={{ color: sum.action === 'Buy' ? up : down }}>
            {summaryText(sum, multiCode, decimalsFor)}
        </div>)}
        {hidden > 0 && <div className={styles.muted}>清單只列最新 {QTY_FORMAT.format(FILL_LIST_MAX)} 筆，另有 {QTY_FORMAT.format(hidden)} 筆未列出。</div>}
        {rows.length || extra.length ? <table className={styles.table}>
            {!tooltip && <thead><tr>
                <th className={styles.cell} scope='col'>成交時間</th>
                <th className={styles.cell} scope='col'>買賣</th>
                {multiCode && <th className={styles.cell} scope='col'>合約</th>}
                <th className={styles.number} scope='col'>成交價</th>
                <th className={styles.number} scope='col'>數量</th>
                {allAccounts && <th className={styles.cell} scope='col'>帳戶</th>}
            </tr></thead>}
            <tbody>{rows.map(fill => row(fill, !!shown && fill.time === shown.time))}</tbody>
            {extra.length > 0 && <tbody>
                <tr><th className={`${styles.cell} ${styles.muted}`} scope='rowgroup' colSpan={4 + (allAccounts ? 1 : 0) + (multiCode ? 1 : 0)}>圖上無對應 K 棒（例如盤後）</th></tr>
                {extra.map(fill => row(fill, false))}
            </tbody>}
        </table> : <div className={styles.empty}>{!scoped ? '請先選擇圖表帳戶以查看成交。' : pending ? `確認前不顯示成交；${hint ?? '可使用委託分頁的更新'}。` : barsLoading ? '載入 K 線中…' : `${allAccounts ? '全部帳戶' : '目前帳戶'}在已載入 K 線範圍內沒有可顯示的逐筆成交。`}</div>}
        {tooltip && all.length > rows.length && <div className={styles.muted}>另有 {all.length - rows.length} 筆，請開啟「明細」查看。</div>}
    </div>;
}

// 一列成交。投影沿用沒變的委託的成交物件，所以盤中每筆新回報只重畫新的那幾列
const FillRow = memo(function FillRow({ fill, dateless, up, down, allAccounts, privacy, tooltip, compact, multiCode, focused }: {
    fill: ChartFill; dateless: boolean; up: string; down: string; allAccounts: boolean; privacy: boolean;
    tooltip: boolean; compact: boolean; multiCode: boolean;
    /** 清單「這根 K 棒」的成交：標亮 */
    focused: boolean;
}) {
    // 提示框跨合約或全部帳戶時，合約／帳戶一律放第二列（寬框 380～450px 也會裁到帳戶欄）
    const secondRow = tooltip && (multiCode || allAccounts);
    return <><tr data-fill-id={fill.id} aria-current={focused ? 'true' : undefined} className={focused ? styles.focusRow : undefined}>
        {/* 窄提示框：日期和時間放不下時分兩行（日 K 不省月日），數量欄才不會被裁掉 */}
        <td className={tooltip && compact ? styles.tooltipTime : styles.cell}>{fillClock(fill.ts, dateless, tooltip && compact)}</td>
        <td className={styles.cell} style={{ color: fill.action === 'Buy' ? up : down }}>
            {fill.action === 'Buy' ? '▲ 買' : '▼ 賣'}
        </td>
        {!tooltip && multiCode && <td className={styles.cell}>{fill.code}</td>}
        <td className={styles.number}>{PRICE_FORMAT.format(fill.price)}</td>
        <td className={styles.number}>{QTY_FORMAT.format(fill.quantity)} {fill.unit}</td>
        {allAccounts && !secondRow && <td className={styles.cell}>{maskAccountId(fill.account.account_id, privacy)}</td>}
    </tr>
    {secondRow && <tr><td className={styles.tooltipMeta} colSpan={4}>
        {multiCode ? `合約 ${fill.code}` : ''}
        {multiCode && allAccounts ? ' · ' : ''}
        {allAccounts ? `帳戶 ${maskAccountId(fill.account.account_id, privacy)}` : ''}
    </td></tr>}</>;
});

// 報價每次變動 CandleChart 都會重繪；清單開著時成交列數不少，props 沒變就不重建整張表。
export const ChartFillDetails = memo(ChartFillDetailsView);
