// src/lib/chart-order-settings.ts — K 線圖「下單設定」（#204）
//
// 圖表工具列只留一顆設定按鈕（顯示數量＋單位：「500 股」＝盤中零股、
// 「1 張」＝整股、「2 口」＝期貨），細項放在彈出面板。這裡是純邏輯：
// 正規化規則、各商品顯示哪些選項、按鈕／提示／摘要文字，以及轉成
// placeQuickOrder／addTrigger 真正會送出的參數。
//
// 只收錄圖表下單已經接得上的選項：帳號、單位、數量、委託條件（點價單）、
// 期貨倉別（含當沖）、股票信用條件（現股／融資／融券／借券／借券豁免）與
// 現股當沖先賣 — 清單、規則與送出前檢查都沿用下單面板與閃電的共用函式
// （order-conditions、stockOrderProblem、credit-eligibility）。逐圖免確認目前
// 沒有對應的送單路徑，刻意不放。
//
// 不適用的條件「暫不套用」而不是覆寫：零股時效期只能 ROD、信用只能現股，
// 設定本身保留，切回整股時恢復（同閃電）。股票與期貨各存一份，換商品類別
// 也不會互相覆寫。

import { CASH_CREDIT, normalizeFlashCredit, type FlashCredit } from './flash-account';
import { creditLabel, ODD_LOT_MAX_SHARES } from './odd-lot';
import { FUTURES_OCTYPES, octypeLabel, ORDER_TYPES } from './order-conditions';
import type { FuturesOCType, OrderType } from './types/order';

export type ChartOrderMarket = 'S' | 'F';
export type ChartOrderLot = 'Common' | 'IntradayOdd';

export interface ChartOrderSettings {
    /** 張（整股）、股（盤中零股）或口（期貨） */
    qty: number;
    /** 股票：整股或盤中零股；期貨一律 Common */
    lot: ChartOrderLot;
    /** 點價買賣的委託條件（限價）；盤中零股暫時只用 ROD（設定保留） */
    orderType: OrderType;
    /** 期貨：自動／新倉／平倉／當沖（點價單與停損停利都用） */
    octype: FuturesOCType;
    /** 固定帳戶（flashAccountKey 格式）；沒有 = 跟隨主畫面 */
    accountKey?: string;
    /** 股票信用條件＋現股當沖先賣（只在不是現股時存）；零股暫不套用 */
    credit?: FlashCredit;
}

// 清單與下單面板共用（order-conditions）
export { ORDER_TYPES };
export const OCTYPES: readonly { value: FuturesOCType; label: string }[] = FUTURES_OCTYPES;
export const QTY_PRESETS: Record<'張' | '股' | '口', readonly number[]> = {
    張: [1, 2, 5, 10],
    股: [100, 500, 999],
    口: [1, 2, 5, 10],
};

/** 商品類別不適用的值拿掉：期貨沒有零股與信用條件、股票沒有開平倉；
 * 零股 1～999 股。零股時的效期與信用條件保留（暫不套用，見 chartEffective）。 */
export function normalizeChartOrder(raw: Partial<ChartOrderSettings> | null | undefined, market: ChartOrderMarket): ChartOrderSettings {
    const lot: ChartOrderLot = market === 'S' && raw?.lot === 'IntradayOdd' ? 'IntradayOdd' : 'Common';
    const odd = lot === 'IntradayOdd';
    const orderType = raw?.orderType && ORDER_TYPES.includes(raw.orderType) ? raw.orderType : 'ROD';
    const octype = market === 'F' && raw?.octype && OCTYPES.some(o => o.value === raw.octype) ? raw.octype : 'Auto';
    const max = odd ? ODD_LOT_MAX_SHARES : 9999;
    const qty = Number.isSafeInteger(raw?.qty) && raw!.qty! >= 1 ? Math.min(raw!.qty!, max) : 1;
    const credit = market === 'S' ? normalizeFlashCredit(raw?.credit) : undefined;
    return {
        qty, lot, orderType, octype,
        ...(typeof raw?.accountKey === 'string' && raw.accountKey ? { accountKey: raw.accountKey } : {}),
        ...(credit && (credit.cond !== 'Cash' || credit.daytradeShort) ? { credit } : {}),
    };
}

/** 點下去實際套用的條件：零股只有 ROD、只能現股；股票沒有倉別。 */
export function chartEffective(s: ChartOrderSettings, market: ChartOrderMarket): { orderType: OrderType; octype: FuturesOCType | undefined; credit: FlashCredit } {
    const odd = market === 'S' && s.lot === 'IntradayOdd';
    return {
        orderType: odd ? 'ROD' : s.orderType,
        octype: market === 'F' ? s.octype : undefined,
        credit: market === 'S' && !odd ? (s.credit ?? CASH_CREDIT) : CASH_CREDIT,
    };
}

/** 信用條件的短標籤（「融資」「現沖」；借券豁免在按鈕上縮成「借豁」）；現股回空字串 */
export function chartCreditTag(credit: FlashCredit, short = false): string {
    const tag = credit.cond !== 'Cash' ? creditLabel('Sell', credit.cond) ?? '' : credit.daytradeShort ? '現沖' : '';
    return short && tag === '借券豁免' ? '借豁' : tag;
}

/** 這一邊點價的動作名稱前綴：融資買進、融券賣出、現沖賣出；現股回空字串 */
export function chartActionCredit(credit: FlashCredit, action: 'Buy' | 'Sell'): string {
    return creditLabel(action, credit.cond, credit.daytradeShort) ?? '';
}

export const CHART_EXIT_CREDIT_TEXT = '停損停利觸發後只能以現股送出；信用條件不是現股時停用停損停利，請把信用改回現股';

/** 停損停利（觸價引擎）只送現股：信用條件生效時停用，不默默改成現股 */
export function chartExitBlocked(s: ChartOrderSettings, market: ChartOrderMarket): string | null {
    return chartCreditTag(chartEffective(s, market).credit) ? CHART_EXIT_CREDIT_TEXT : null;
}

export function chartOrderUnit(market: ChartOrderMarket, lot: ChartOrderLot): '張' | '股' | '口' {
    return market === 'F' ? '口' : lot === 'IntradayOdd' ? '股' : '張';
}

/** 工具列按鈕：數量與單位（單位本身就說明整股／零股），非預設的信用或
 * 期貨倉別接在後面：「1 張·融資」「2 口·當沖」。 */
export function chartOrderChipLabel(s: ChartOrderSettings, market: ChartOrderMarket): string {
    const eff = chartEffective(s, market);
    const tag = market === 'F' ? (eff.octype && eff.octype !== 'Auto' ? octypeLabel(eff.octype) : '') : chartCreditTag(eff.credit, true);
    return `${s.qty.toLocaleString('en-US')} ${chartOrderUnit(market, s.lot)}${tag ? `·${tag}` : ''}`;
}

/** 只有數量與單位（提示文字用） */
function qtyLabel(s: ChartOrderSettings, market: ChartOrderMarket): string {
    return `${s.qty.toLocaleString('en-US')} ${chartOrderUnit(market, s.lot)}`;
}

/** 彈出面板要顯示的列；不適用的列不顯示（不做灰掉的選項）。 */
export function chartOrderRows(market: ChartOrderMarket, lot: ChartOrderLot) {
    const odd = market === 'S' && lot === 'IntradayOdd';
    return {
        unit: market === 'S',
        // 零股只有 ROD — 沒得選就不顯示，摘要會寫明
        orderType: !odd,
        octype: market === 'F',
        // 零股時仍顯示但停用，並說明（設定保留，切回整股恢復）
        credit: market === 'S',
    };
}

function lotText(s: ChartOrderSettings, market: ChartOrderMarket): string {
    const unit = chartOrderUnit(market, s.lot);
    return `${s.qty.toLocaleString('en-US')} ${unit}${market === 'S' && s.lot === 'IntradayOdd' ? '盤中零股' : ''}`;
}

/** 停損停利觸發後怎麼送（沿用觸價引擎的既有行為）。 */
export function chartExitText(s: ChartOrderSettings, market: ChartOrderMarket): string {
    if (market === 'S' && s.lot === 'IntradayOdd') return '觸發後以漲跌停價送零股限價 ROD';
    if (market === 'F') return `觸發後以市價送出${s.octype === 'Auto' ? '' : `（${octypeLabel(s.octype)}）`}`;
    if (chartExitBlocked(s, market)) return '停用：觸發後只能以現股送出，信用條件不是現股';
    return '觸發後以市價送出';
}

/** 面板底部一句話：點下去實際會送什麼。 */
export function chartOrderSummary(s: ChartOrderSettings, market: ChartOrderMarket, accountLabel: string): string {
    const odd = market === 'S' && s.lot === 'IntradayOdd';
    const eff = chartEffective(s, market);
    const oc = market === 'F' && s.octype !== 'Auto' ? octypeLabel(s.octype) : '';
    const tag = chartCreditTag(eff.credit);
    const sellOnly = SELL_ONLY.has(eff.credit.cond);
    const what = sellOnly
        ? `點價賣以 ${eff.orderType} 限價${tag}賣出 ${lotText(s, market)}（點價買停用：${tag}只能賣出）`
        : eff.credit.daytradeShort
            ? `點價買以 ${eff.orderType} 限價現股買進、點價賣以現沖賣出 ${lotText(s, market)}`
            : `點價買／賣以 ${eff.orderType} 限價送出 ${lotText(s, market)}${oc ? `（${oc}）` : tag ? `（${tag}）` : ''}`;
    return `${what}，帳號 ${accountLabel}；`
        + `停損停利${chartExitText(s, market)}${odd ? '。零股只能現股、ROD 限價' : ''}。`;
}

const SELL_ONLY: ReadonlySet<string> = new Set(['ShortSelling', 'SBLShort', 'SBLShortPriceExempt']);

/** 點價／停損／停利模式啟用時，圖上的提示。 */
export function chartModeHint(mode: 'buy' | 'sell' | 'stop' | 'take' | 'alert', s: ChartOrderSettings, market: ChartOrderMarket): string {
    // 單位本身就說明整股／零股（「500 股」＝盤中零股），提示與按鈕一致
    const what = qtyLabel(s, market);
    const eff = chartEffective(s, market);
    const type = eff.orderType === 'ROD' ? '' : ` ${eff.orderType}`;
    const oc = eff.octype && eff.octype !== 'Auto' ? `（${octypeLabel(eff.octype)}）` : '';
    if (mode === 'buy') return `點擊價位 → ${chartActionCredit(eff.credit, 'Buy')}限價買進${type} ${what}${oc}`;
    if (mode === 'sell') return `點擊價位 → ${chartActionCredit(eff.credit, 'Sell')}限價賣出${type} ${what}${oc}`;
    if (mode === 'stop') return `點擊價位 → 停損 ${what}（${chartExitText(s, market)}）`;
    if (mode === 'take') return `點擊價位 → 停利 ${what}（${chartExitText(s, market)}）`;
    return '點擊價位設定到價警示（只通知不下單）';
}

/** 點價買賣：placeQuickOrder 的選項（帳戶另外帶）；只帶實際套用的條件。 */
export function chartPlaceOptions(s: ChartOrderSettings, market: ChartOrderMarket) {
    const eff = chartEffective(s, market);
    return {
        ...(market === 'S' && s.lot === 'IntradayOdd' ? { orderLot: 'IntradayOdd' as const } : {}),
        ...(eff.orderType !== 'ROD' ? { orderType: eff.orderType } : {}),
        ...(eff.octype && eff.octype !== 'Auto' ? { ocType: eff.octype } : {}),
        ...(eff.credit.cond !== 'Cash' ? { orderCond: eff.credit.cond } : {}),
        ...(eff.credit.daytradeShort ? { daytradeShort: true } : {}),
    };
}

/** 停損停利：addTrigger 的欄位（零股單位、期貨開平倉）。 */
export function chartTriggerFields(s: ChartOrderSettings, market: ChartOrderMarket) {
    return {
        ...(market === 'S' && s.lot === 'IntradayOdd' ? { orderLot: 'IntradayOdd' as const } : {}),
        ...(market === 'F' && s.octype !== 'Auto' ? { octype: s.octype } : {}),
    };
}

// ---- 閃電下單設定（#204）：只有單位與數量 — 閃電下單點價一律 ROD 限價、
// 市價鈕固定市價 IOC、期貨固定自動開平倉，沒有其他可選的送單參數 ----

/** 閃電下單面板底部一句話：點下去實際會送什麼。 */
export function flashOrderSummary(
    s: ChartOrderSettings,
    market: ChartOrderMarket,
    accountLabel: string,
    /** 閃電面板實際會送的委託條件（不適用的已排除） */
    cond?: { orderType?: OrderType; octype?: FuturesOCType; futuresPriceType?: 'MKT' | 'MKP' },
): string {
    const odd = market === 'S' && s.lot === 'IntradayOdd';
    const ot = odd ? 'ROD' : (cond?.orderType ?? 'ROD');
    const oc = market === 'F' && cond?.octype && cond.octype !== 'Auto' ? `（${octypeLabel(cond.octype)}）` : '';
    const mkt = market === 'F' && cond?.futuresPriceType === 'MKP' ? '範圍市價' : '市價';
    return `點買量／賣量以 ${ot} 限價送出 ${lotText(s, market)}${oc}，帳號 ${accountLabel}；`
        + (odd ? '零股沒有市價單，市價買／賣停用。' : `${mkt}買／賣以${mkt} IOC 送出${oc}。`);
}

// ---- 設為預設：依商品類別（股票／期貨）存新面板的預設 ----
const DEFAULTS_KEY = 'sj-pro-chart-order-defaults';
const FLASH_DEFAULTS_KEY = 'sj-pro-flash-order-defaults';

function loadDefault(key: string, market: ChartOrderMarket): ChartOrderSettings {
    try {
        const all = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}') as Record<string, Partial<ChartOrderSettings>>;
        const { accountKey: _ignored, ...rest } = all?.[market] ?? {};
        return normalizeChartOrder(rest, market);
    } catch {
        return normalizeChartOrder(null, market);
    }
}

function saveDefault(key: string, market: ChartOrderMarket, s: ChartOrderSettings): void {
    try {
        const all = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}') as Record<string, unknown>;
        const { accountKey: _ignored, ...rest } = normalizeChartOrder(s, market);
        globalThis.localStorage?.setItem(key, JSON.stringify({ ...(all && typeof all === 'object' ? all : {}), [market]: rest }));
    } catch { /* quota / private mode */ }
}

/** 預設不含帳戶 — 固定帳戶只屬於設定它的那張圖。 */
export function loadChartOrderDefault(market: ChartOrderMarket): ChartOrderSettings {
    return loadDefault(DEFAULTS_KEY, market);
}

export function saveChartOrderDefault(market: ChartOrderMarket, s: ChartOrderSettings): void {
    saveDefault(DEFAULTS_KEY, market, s);
}

/** 閃電下單新面板／換商品時的單位與數量（不含帳戶）。 */
export function loadFlashOrderDefault(market: ChartOrderMarket): ChartOrderSettings {
    return loadDefault(FLASH_DEFAULTS_KEY, market);
}

export function saveFlashOrderDefault(market: ChartOrderMarket, s: ChartOrderSettings): void {
    saveDefault(FLASH_DEFAULTS_KEY, market, s);
}

/** Stored panel value → settings per market (a chart can switch between a stock and a future). */
export type ChartOrderPanelState = Partial<Record<ChartOrderMarket, Partial<ChartOrderSettings>>>;
