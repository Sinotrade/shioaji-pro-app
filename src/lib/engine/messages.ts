// Error, rejection and diagnostic codes of the backtest core, with the single
// zh-TW translation table. Cores emit codes plus parameters; this module is the
// only place that turns them into the Chinese text users (and persisted
// rejection records) see.

import type { PortfolioDiagnosticKind, RiskReason } from './schema';

/**
 * The single zh-TW message table of the backtest core. Keys are stable codes;
 * `{name}` is replaced by `params.name` rendered with ECMAScript
 * `String(value)`; other braces are literal. A native core embeds the same
 * table (exported as JSON next to the golden files) and must render identical
 * text, because rejection messages are persisted in research records.
 */
export const CORE_MESSAGE_TABLE = {
    schemaVersion: 'backtest-core-messages-v1',
    errors: {
        VALUE_NOT_FINITE: '{label} 必須是有限數值',
        VALUE_OUT_OF_RANGE: '{label} 必須在 [{min}, {max}]',
        VALUE_OUT_OF_RANGE_INTEGER: '{label} 必須在 [{min}, {max}] 且為整數',
        INPUT_NOT_CLONEABLE: '{label} 必須可建立資料快照',
        INPUT_NOT_RECORD: '{label} 必須是資料物件',
        UNIVERSE_UNSUPPORTED: '只支援 static universe 與 union/intersection calendar',
        UNIVERSE_SIZE: 'universe 商品數必須在 1..{max}',
        ASSET_ID_INVALID: 'strategy asset id 重複或為空: {assetId}',
        ASSET_SYMBOL_INVALID: 'strategy asset symbol 重複或為空: {symbol}',
        ASSET_IDENTIFIER_CONFLICT: '商品識別衝突: {symbol}',
        PRIMARY_ASSET_MISSING: 'primaryAsset 必須存在於 universe',
        BARS_MISSING: '缺少 {assetId} 的 bars',
        BARS_FIELD_NOT_ARRAY: '{assetId}.{field} 必須是陣列',
        BARS_LENGTH_MISMATCH: '{assetId}.{field} 長度不一致',
        BARS_TIME_NOT_FINITE: '{assetId}.time[{index}] 必須是有限數值',
        BARS_TIME_NOT_INCREASING: '{assetId}.time 必須嚴格遞增且不可重複',
        BARS_AVAILABILITY_NOT_BOOLEAN: 'availability 必須是 boolean',
        BARS_VOLUME_INVALID: '{assetId}.volume[{index}] 無效',
        BARS_PRICE_INVALID: '{assetId}.{field}[{index}] 無效；價格範圍 [{min}, {max}]',
        BARS_OHLC_INCONSISTENT: '{assetId} OHLC 範圍不一致',
        BARS_LIMIT_INCONSISTENT: '{assetId}.limitDown[{index}] 必須小於 limitUp',
        EXECUTION_FIELD_MISSING: '缺少 execution.{field}',
        EXECUTION_FIELD_UNKNOWN: '未知 execution 欄位: {field}',
        TICK_LADDER_INVALID: '{assetId} tickLadder 無效',
        LIQUIDATE_AT_END_INVALID: 'liquidateAtEnd 必須是 boolean',
        STRATEGY_RESULT_NOT_ARRAY: 'strategy 必須回傳 intent 陣列或 undefined',
        STRATEGY_RESULT_INVALID: 'strategy 必須回傳 intent 陣列、{ intents, diagnostics } 或 undefined',
        STRATEGY_DIAGNOSTIC_INVALID: 'strategy diagnostic 格式、時間或商品無效',
        STRATEGY_CALLBACK_FAILED: 'strategy callback 失敗: {detail}',
        STRATEGY_INTENTS_UNVERIFIABLE: 'strategy intents 無法驗證: {detail}',
        UNIVERSE_UNKNOWN_ASSET: 'universe 外商品: {asset}',
        INTENT_NOT_CLONEABLE: 'intent 必須是可複製資料',
        INTENT_TAG_INVALID: 'intent.tag 必須是字串',
        INTENT_ORDER_INVALID: 'intent.order 無效',
        INTENT_UNKNOWN_ASSET: 'intent 指向 universe 外商品: {assetId}',
        INTENT_DUPLICATE_ASSET: '同商品、同週期只能有一個 intent: {assetId}',
        INTENT_KIND_UNKNOWN: '未知 intent kind',
        ENTRY_SIDE_INVALID: 'entry.side 無效',
        ENTRY_QUANTITY_NONPOSITIVE: 'entry.quantity 必須大於 0',
        REDUCE_SIZE_AMBIGUOUS: 'reduce 只能指定 quantity 或 fraction',
        REDUCE_FRACTION_RANGE: 'reduce.fraction 必須在 (0, 1]',
        REDUCE_QUANTITY_NONPOSITIVE: 'reduce.quantity 必須大於 0',
        REDUCE_BELOW_LOT: '非零 reduce 小於一個 lot',
        CLOSE_FIRST_INVALID: 'targetQuantity.closeFirst 必須是 boolean',
        TARGET_BELOW_LOT: '{assetId} 非零 {kind} 小於一個 lot',
        SIGNAL_ADAPTER_UNKNOWN_ASSET: 'Signal adapter 指向 universe 外商品: {assetId}',
        SIGNAL_RULE_DUPLICATE: '重複 Signal DSL collector: {assetId}.{name}',
        REQUEST_INVALID: '回測請求格式無效: {detail}',
        MODE_UNSUPPORTED: '{mode} 模式不支援: {detail}',
        INTENT_STREAM_UNKNOWN_TIME: 'intent stream 含有不在決策時間軸上的紀錄: {time}',
        STRATEGY_SCRIPT_FAILED: '策略執行失敗: {detail}',
        STRATEGY_LOOKAHEAD: '策略讀取了未來的 K 棒資料：{assetId} 的 {name} 在第 {index} 根（由 0 起算）的訊號會被之後的 K 棒改變。訊號只能用當根與之前的資料計算（例如不要讀 close[i + 1]、不要用整段資料的最高價、長度或平均）',
        STRATEGY_NONDETERMINISTIC_API: '策略不能使用每次執行結果都不同的功能：{name}（例如亂數、目前時間、計時器）。回測必須每次跑出相同結果，請改用 K 棒的 time 與固定參數',
        STRATEGY_LOOKAHEAD_OFFSET: 'ta.offset 的位移是 {n}：負數會讀到未來的 K 棒。位移必須是 0 或正數（例如 ta.offset(close, 1) 取前一根）',
        SCRIPT_UNKNOWN_ASSET: 'universe 外商品: {asset}',
        SCRIPT_COLLECTOR_INVALID: '{name}() 參數無效: {problem}',
        SCRIPT_SIZE_INVALID: 'position.{kind}() 數值無效',
        SCRIPT_RESERVED_FUNCTION: '{name}() 保留給 sequential/target-portfolio DSL，Signal DSL 不提供持倉狀態',
        SCRIPT_NO_SIGNALS: '策略沒有產生任何訊號 — 至少要呼叫 longEntry() 或 shortEntry()',
        SCRIPT_LONG_ENTRY_WITHOUT_EXIT: 'longEntry() 有了，但沒有 longExit()（或反向 shortEntry() 翻單）— 加上出場條件',
        SCRIPT_SHORT_ENTRY_WITHOUT_EXIT: 'shortEntry() 有了，但沒有 shortExit()（或反向 longEntry() 翻單）— 加上出場條件',
        SCRIPT_COLLECTOR_IN_STATEFUL: 'Signal DSL collector 不可用於 stateful/target strategy',
        SCRIPT_ONBAR_INVALID: 'onBar 需要單一 callback',
        SCRIPT_ENTRY_PERCENT: '進場不可使用 position.percent',
        SCRIPT_REDUCE_SIZE_REQUIRED: 'reducePosition 需要 quantity 或 percent',
        INTERNAL: '{detail}',
    },
    rejections: {
        RISK_WEIGHT_NEEDS_EQUITY: { reason: 'nonpositive-equity', message: '非零 targetWeight 需要正有限 portfolio equity' },
        RISK_WEIGHT_MISSING_CLOSE: { reason: 'missing-price', message: '{assetId} 本週期沒有可用 close，不能換算 targetWeight' },
        RISK_MISSING_VALUATION_PRICE: { reason: 'missing-price', message: '{assetId} 缺少估值價格' },
        RISK_UNPRICED_POSITION: { reason: 'missing-price', message: '{assetId} 沒有可用估值價格，不能規劃訂單' },
        RISK_NO_HISTORY: { reason: 'missing-price', message: '商品沒有可用歷史 K 棒，無法建立非零部位' },
        RISK_NONPOSITIVE_EQUITY: { reason: 'nonpositive-equity', message: 'portfolio equity 不大於 0，拒絕建立訂單' },
        RISK_GROSS_LEVERAGE: { reason: 'gross-leverage', message: '共享資金風控失敗: gross leverage {leverage} > {limit}' },
        RISK_NET_LEVERAGE: { reason: 'net-leverage', message: '共享資金風控失敗: net leverage {leverage} > {limit}' },
        RISK_INVALID_FILL_PRICE: { reason: 'invalid-fill-price', message: '滑價後成交價必須大於 0' },
        RISK_LIMIT_NOT_REACHED: { reason: 'limit-not-reached', message: '下一根可用 K 棒未觸及限價' },
        RISK_UNAVAILABLE_BAR: { reason: 'unavailable-bar', message: '缺 K 或停牌，等待下一個可成交 open' },
        RISK_LIMIT_LOCKED: { reason: 'limit-locked', message: '漲跌停鎖死，等待下一根可成交 K 棒' },
        RISK_FINAL_BAR_UNAVAILABLE: { reason: 'unavailable-bar', message: '最後一根缺 K 或停牌，部位未平倉並以最後收盤估值' },
    },
    riskReasonLabels: {
        'gross-leverage': '槓桿／資金不足',
        'net-leverage': '淨槓桿限制',
        'nonpositive-equity': '可用資金不足',
        'missing-price': '缺少價格',
        'unavailable-bar': '行情資料暫缺',
        'invalid-fill-price': '成交價格無效',
        'limit-not-reached': '限價未觸及',
        'limit-locked': '漲跌停鎖死',
    },
    diagnosticLabels: {
        'signal-conflict': '同時觸發多個訊號',
        'lot-rounding': '數量依交易單位捨去',
    },
} as const;

const table = CORE_MESSAGE_TABLE;

export const CORE_ERROR_CODES = Object.freeze(Object.keys(table.errors)) as readonly CoreErrorCode[];
export type CoreErrorCode = keyof typeof table.errors;

export const REJECTION_MESSAGE_KEYS = Object.freeze(Object.keys(table.rejections)) as readonly RejectionMessageKey[];
export type RejectionMessageKey = keyof typeof table.rejections;

export const RISK_REASONS = Object.freeze(Object.keys(table.riskReasonLabels)) as readonly RiskReason[];
export const DIAGNOSTIC_KINDS = Object.freeze(Object.keys(table.diagnosticLabels)) as readonly PortfolioDiagnosticKind[];

/** Parameter values are rendered with ECMAScript `String(value)`. */
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function render(template: string, params: MessageParams): string {
    return template.replace(PLACEHOLDER, (whole, name: string) =>
        Object.hasOwn(params, name) ? String(params[name]) : whole);
}

export function isCoreErrorCode(value: unknown): value is CoreErrorCode {
    return typeof value === 'string' && Object.hasOwn(table.errors, value);
}

/** zh-TW text of one error code, without time/asset context. */
export function coreErrorText(code: CoreErrorCode, params: MessageParams = {}): string {
    // A replayed recording may carry a code this table does not know; show the code itself.
    return render(Object.hasOwn(table.errors, code) ? table.errors[code] : code, params);
}

/** Reason code and exact persisted message of a simulated order rejection. */
export function rejectionReason(key: RejectionMessageKey, params: MessageParams = {}):
    { code: RiskReason; message: string } {
    const entry = table.rejections[key];
    return { code: entry.reason, message: render(entry.message, params) };
}

export function riskReasonLabel(reason: RiskReason): string {
    return table.riskReasonLabels[reason];
}

export function diagnosticLabel(kind: PortfolioDiagnosticKind): string {
    return table.diagnosticLabels[kind];
}

/** Formats a number exactly like the TypeScript core's `toFixed(4)` leverage text. */
export function formatLeverage(value: number): string {
    return value.toFixed(4);
}
