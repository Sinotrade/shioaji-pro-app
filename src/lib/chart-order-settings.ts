// src/lib/chart-order-settings.ts — K 線圖「下單設定」（#204）
//
// 圖表工具列只留一顆設定按鈕（顯示數量＋單位：「500 股」＝盤中零股、
// 「1 張」＝整股、「2 口」＝期貨），細項放在彈出面板。這裡是純邏輯：
// 正規化規則、各商品顯示哪些選項、按鈕／提示／摘要文字，以及轉成
// placeQuickOrder／addTrigger 真正會送出的參數。
//
// 只收錄圖表下單已經接得上的選項：帳號、單位、數量、委託條件（點價單）、
// 期貨開平倉。融資／融券、當沖與逐圖免確認目前沒有對應的送單路徑，
// 刻意不放（不做沒有作用的控制項）。

import { ODD_LOT_MAX_SHARES } from './odd-lot';
import type { FuturesOCType, OrderType } from './types/order';

export type ChartOrderMarket = 'S' | 'F';
export type ChartOrderLot = 'Common' | 'IntradayOdd';

export interface ChartOrderSettings {
    /** 張（整股）、股（盤中零股）或口（期貨） */
    qty: number;
    /** 股票：整股或盤中零股；期貨一律 Common */
    lot: ChartOrderLot;
    /** 點價買賣的委託條件（限價）；盤中零股只能 ROD */
    orderType: OrderType;
    /** 期貨：自動／新倉／平倉（點價單與停損停利都用） */
    octype: FuturesOCType;
    /** 固定帳戶（flashAccountKey 格式）；沒有 = 跟隨主畫面 */
    accountKey?: string;
}

export const ORDER_TYPES: readonly OrderType[] = ['ROD', 'IOC', 'FOK'];
export const OCTYPES: readonly { value: FuturesOCType; label: string }[] = [
    { value: 'Auto', label: '自動' },
    { value: 'New', label: '新倉' },
    { value: 'Cover', label: '平倉' },
];
export const QTY_PRESETS: Record<'張' | '股' | '口', readonly number[]> = {
    張: [1, 2, 5, 10],
    股: [100, 500, 999],
    口: [1, 2, 5, 10],
};

/** 商品不適用的值一律拿掉：期貨沒有零股、零股只能 ROD 且 1～999 股、股票沒有開平倉。 */
export function normalizeChartOrder(raw: Partial<ChartOrderSettings> | null | undefined, market: ChartOrderMarket): ChartOrderSettings {
    const lot: ChartOrderLot = market === 'S' && raw?.lot === 'IntradayOdd' ? 'IntradayOdd' : 'Common';
    const odd = lot === 'IntradayOdd';
    const orderType = !odd && raw?.orderType && ORDER_TYPES.includes(raw.orderType) ? raw.orderType : 'ROD';
    const octype = market === 'F' && raw?.octype && OCTYPES.some(o => o.value === raw.octype) ? raw.octype : 'Auto';
    const max = odd ? ODD_LOT_MAX_SHARES : 9999;
    const qty = Number.isSafeInteger(raw?.qty) && raw!.qty! >= 1 ? Math.min(raw!.qty!, max) : 1;
    return {
        qty, lot, orderType, octype,
        ...(typeof raw?.accountKey === 'string' && raw.accountKey ? { accountKey: raw.accountKey } : {}),
    };
}

export function chartOrderUnit(market: ChartOrderMarket, lot: ChartOrderLot): '張' | '股' | '口' {
    return market === 'F' ? '口' : lot === 'IntradayOdd' ? '股' : '張';
}

/** 工具列按鈕：只有數量與單位（單位本身就說明整股／零股）。 */
export function chartOrderChipLabel(s: ChartOrderSettings, market: ChartOrderMarket): string {
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
    };
}

function lotText(s: ChartOrderSettings, market: ChartOrderMarket): string {
    const unit = chartOrderUnit(market, s.lot);
    return `${s.qty.toLocaleString('en-US')} ${unit}${market === 'S' && s.lot === 'IntradayOdd' ? '盤中零股' : ''}`;
}

/** 停損停利觸發後怎麼送（沿用觸價引擎的既有行為）。 */
export function chartExitText(s: ChartOrderSettings, market: ChartOrderMarket): string {
    if (market === 'S' && s.lot === 'IntradayOdd') return '觸發後以漲跌停價送零股限價 ROD';
    if (market === 'F') return `觸發後以市價送出${s.octype === 'Auto' ? '' : `（${OCTYPES.find(o => o.value === s.octype)!.label}）`}`;
    return '觸發後以市價送出';
}

/** 面板底部一句話：點下去實際會送什麼。 */
export function chartOrderSummary(s: ChartOrderSettings, market: ChartOrderMarket, accountLabel: string): string {
    const odd = market === 'S' && s.lot === 'IntradayOdd';
    const oc = market === 'F' && s.octype !== 'Auto' ? `${OCTYPES.find(o => o.value === s.octype)!.label}` : '';
    return `點價買／賣以 ${s.orderType} 限價送出 ${lotText(s, market)}${oc ? `（${oc}）` : ''}，帳號 ${accountLabel}；`
        + `停損停利${chartExitText(s, market)}${odd ? '。零股只能現股、ROD 限價' : ''}。`;
}

/** 點價／停損／停利模式啟用時，圖上的提示。 */
export function chartModeHint(mode: 'buy' | 'sell' | 'stop' | 'take' | 'alert', s: ChartOrderSettings, market: ChartOrderMarket): string {
    // 單位本身就說明整股／零股（「500 股」＝盤中零股），提示與按鈕一致
    const what = chartOrderChipLabel(s, market);
    const type = s.orderType === 'ROD' ? '' : ` ${s.orderType}`;
    if (mode === 'buy') return `點擊價位 → 限價買進${type} ${what}`;
    if (mode === 'sell') return `點擊價位 → 限價賣出${type} ${what}`;
    if (mode === 'stop') return `點擊價位 → 停損 ${what}（${chartExitText(s, market)}）`;
    if (mode === 'take') return `點擊價位 → 停利 ${what}（${chartExitText(s, market)}）`;
    return '點擊價位設定到價警示（只通知不下單）';
}

/** 點價買賣：placeQuickOrder 的選項（帳戶另外帶）。 */
export function chartPlaceOptions(s: ChartOrderSettings, market: ChartOrderMarket) {
    return {
        ...(market === 'S' && s.lot === 'IntradayOdd' ? { orderLot: 'IntradayOdd' as const } : {}),
        ...(s.orderType !== 'ROD' ? { orderType: s.orderType } : {}),
        ...(market === 'F' && s.octype !== 'Auto' ? { ocType: s.octype } : {}),
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
export function flashOrderSummary(s: ChartOrderSettings, market: ChartOrderMarket, accountLabel: string): string {
    const odd = market === 'S' && s.lot === 'IntradayOdd';
    return `點買量／賣量以 ROD 限價送出 ${lotText(s, market)}，帳號 ${accountLabel}；`
        + (odd ? '零股沒有市價單，市價買／賣停用。' : '市價買／賣以市價 IOC 送出。');
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
