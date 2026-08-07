// src/lib/shioaji.ts

import { accountFor } from './account-store';
import { apiDelete, apiGet, apiPost, apiPut } from './api';
import type {
    ContractBase,
    ContractInfo,
    SecurityType,
} from './types/contract';
import type { Health } from './types/health';
import type {
    KBars,
    ContributionRanking,
    QuoteTypeName,
    ScannerExchange,
    ScannerRule,
    ScannerItem,
    ScannerType,
    Snapshot,
    SubscriptionResponse,
} from './types/market';
import type {
    FuturesOrderReq,
    StockOrderReq,
    Trade,
} from './types/order';
import type {
    Account,
    AccountBalance,
    AccountTypeName,
    FuturePosition,
    Margin,
    StockPosition,
} from './types/portfolio';
import {
    registerCapabilitySubscription,
    registerSubscription,
    unregisterCapabilitySubscription,
    unregisterSubscription,
} from './stream';
import type { HistoryTicks } from './types/tick';
import { todayStr } from './utils/date';

export interface ServerInfo {
    name: string;
    version: string;
    description: string;
    protocols: string[];
    simulation: boolean;
}

function contractKey(c: ContractBase) {
    return {
        security_type: c.security_type,
        region: c.region ?? 'TW',
        exchange: c.exchange,
        code: c.code,
        target_code: c.target_code || null,
    };
}

function streamContractKey(c: ContractBase) {
    return {
        security_type: c.security_type,
        exchange: c.exchange,
        code: c.code,
        target_code: c.target_code || null,
    };
}

// ---- health / info / auth ----

export function fetchHealth() {
    return apiGet<Health>('/api/v1/health');
}

export function fetchInfo() {
    return apiGet<ServerInfo>('/api/v1/info');
}

export function fetchAccounts() {
    return apiGet<Account[]>('/api/v1/auth/accounts');
}

// CA expiry for a person_id — production orders fail (400) without an active,
// unexpired CA. Returns the expire time so the panel can show 有效/過期.
export function fetchCaExpire(personId: string) {
    return apiGet<{ person_id: string; expire_time: string }>(
        `/api/v1/auth/ca_expiretime?person_id=${encodeURIComponent(personId)}`,
    );
}

export function subscribeTradeEvents(account: {
    broker_id: string;
    account_id: string;
    account_type: string;
}) {
    return apiPost<unknown>('/api/v1/auth/subscribe_trade', {
        broker_id: account.broker_id,
        account_id: account.account_id,
        account_type: account.account_type,
    });
}

// ---- contracts ----

const LEGACY_INDEX_CODES: Record<string, string> = {
    '001': 'IX0001',
    '015': 'IX0010',
    '016': 'IX0011',
    '017': 'IX0012',
    '018': 'IX0016',
    '019': 'IX0017',
    '020': 'IX0018',
    '021': 'IX0021',
    '022': 'IX0022',
    '023': 'IX0023',
    '024': 'IX0024',
    '025': 'IX0025',
    '026': 'IX0026',
    '028': 'IX0036',
    '029': 'IX0037',
    '030': 'IX0038',
    '031': 'IX0039',
    '032': 'IX0040',
    '035': 'IX0041',
    '036': 'IX0028',
    '037': 'IX0029',
    '038': 'IX0030',
    '039': 'IX0031',
    '040': 'IX0032',
    '041': 'IX0033',
    '042': 'IX0034',
    '043': 'IX0035',
};

export function normalizeContractCode(
    code: string,
    securityType?: SecurityType,
) {
    const normalized = code.trim().toUpperCase();
    return securityType === 'IND' || normalized in LEGACY_INDEX_CODES
        ? (LEGACY_INDEX_CODES[normalized] ?? normalized)
        : normalized;
}

export interface ContractsQueryResponse {
    contracts: ContractBase[];
    security_type: Exclude<SecurityType, null>;
    region: string;
    total: number;
    page?: number;
    page_size?: number;
    max_page?: number;
}

export interface ContractRoot {
    root: string;
    name: string;
}

export interface WarrantUnderlying {
    underlying_code: string;
    name?: string | null;
    warrant_count?: number;
}

function contractQuery(params: Record<string, string | number | undefined>) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    return qs.size ? `?${qs.toString()}` : '';
}

export function fetchContractBase(code: string, securityType?: SecurityType) {
    const normalized = normalizeContractCode(code, securityType);
    return apiGet<ContractBase>(
        `/api/v1/data/contracts/${encodeURIComponent(normalized)}${contractQuery({
            security_type: securityType ?? undefined,
            region: 'TW',
        })}`,
    );
}

export function fetchContractInfo(code: string, securityType?: SecurityType) {
    const normalized = normalizeContractCode(code, securityType);
    return apiGet<ContractInfo>(
        `/api/v1/data/contracts/${encodeURIComponent(normalized)}/info${contractQuery({
            security_type: securityType ?? undefined,
            region: 'TW',
        })}`,
    );
}

export function fetchContract(
    code: string,
    securityType: SecurityType = 'STK',
) {
    return fetchContractInfo(code, securityType);
}

export async function resolveContract(
    code: string,
    securityType?: SecurityType,
): Promise<ContractInfo> {
    const base = await fetchContractBase(code, securityType);
    if (base.security_type === 'WRT') {
        // Warrant info is sharded by underlying and cannot be fetched from
        // /{code}/info. A later warrant search can prime the full record.
        return {
            ...base,
            name: base.code,
            currency: 'TWD',
            reference: 0,
            limit_up: 0,
            limit_down: 0,
            day_trade: '',
            update_date: '',
            category: '',
            margin_trading_balance: 0,
            short_selling_balance: 0,
        };
    }
    return fetchContractInfo(base.code, base.security_type);
}

export function fetchContracts(
    securityType: Exclude<SecurityType, null>,
    page?: number,
    pageSize?: number,
) {
    return apiGet<ContractsQueryResponse>(
        `/api/v1/data/contracts${contractQuery({
            security_type: securityType,
            region: 'TW',
            page,
            page_size: pageSize,
        })}`,
    );
}

export function fetchFutures(filters: {
    root?: string;
    underlyingCode?: string;
    deliveryMonth?: string;
} = {}) {
    return apiGet<ContractInfo[]>(
        `/api/v1/data/contracts/futures${contractQuery({
            root: filters.root,
            underlying_code: filters.underlyingCode,
            delivery_month: filters.deliveryMonth,
            region: 'TW',
        })}`,
    );
}

export function fetchFuturesRoots() {
    return apiGet<ContractRoot[]>(
        '/api/v1/data/contracts/futures/roots?region=TW',
    );
}

export function fetchOptions(
    root: string,
    filters: {
        deliveryMonth?: string;
        optionRight?: 'C' | 'P';
        strikeMin?: number;
        strikeMax?: number;
        expiryWeekday?: string;
    } = {},
) {
    return apiGet<ContractInfo[]>(
        `/api/v1/data/contracts/options${contractQuery({
            root,
            delivery_month: filters.deliveryMonth,
            option_right: filters.optionRight,
            strike_min: filters.strikeMin,
            strike_max: filters.strikeMax,
            expiry_weekday: filters.expiryWeekday,
            region: 'TW',
        })}`,
    );
}

export function fetchOptionRoots() {
    return apiGet<ContractRoot[]>(
        '/api/v1/data/contracts/options/roots?region=TW',
    );
}

export function fetchWarrants(
    underlyingCode: string,
    filters: {
        code?: string;
        callPut?: 'C' | 'P';
        strikeMin?: number;
        strikeMax?: number;
        expiryFrom?: string;
        expiryTo?: string;
    } = {},
) {
    return apiGet<ContractInfo[]>(
        `/api/v1/data/contracts/warrants${contractQuery({
            underlying_code: underlyingCode,
            code: filters.code,
            call_put: filters.callPut,
            strike_min: filters.strikeMin,
            strike_max: filters.strikeMax,
            expiry_from: filters.expiryFrom,
            expiry_to: filters.expiryTo,
            region: 'TW',
        })}`,
    );
}

export function fetchWarrantUnderlyings() {
    return apiGet<WarrantUnderlying[]>(
        '/api/v1/data/contracts/warrants/underlyings?region=TW&include_name=true',
    );
}

// ---- market data ----

export function fetchSnapshots(contracts: ContractBase[]) {
    return apiPost<Snapshot[]>('/api/v1/data/snapshots', {
        contracts: contracts.map(contractKey),
    });
}

export function fetchKbars(contract: ContractBase, start: string, end: string) {
    return apiPost<KBars>('/api/v1/data/kbars', {
        contract: contractKey(contract),
        start,
        end,
    });
}

export function fetchHistoryTicks(contract: ContractBase, date: string) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: contractKey(contract),
        date,
    });
}

export function fetchLastTicks(
    contract: ContractBase,
    count: number,
    date = todayStr(),
) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: contractKey(contract),
        date,
        query_type: 'LastCount',
        last_cnt: count,
    });
}

export function fetchScanner(
    scannerType: ScannerType,
    count = 30,
    ascending = false,
) {
    return apiPost<ScannerItem[]>('/api/v1/data/scanner', {
        scanner_type: scannerType,
        date: todayStr(),
        ascending,
        count,
    });
}

// ---- streaming subscriptions ----

export function subscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    const body = {
        ...contractKey(contract),
        // empty string must become null — the server 500s on target_code ""
        target_code: contract.target_code || null,
        quote_type: quoteType,
        intraday_odd: false,
    };
    return apiPost<SubscriptionResponse>('/api/v1/stream/subscribe', body).then(
        (response) => {
            if (!response.success) {
                throw new Error(response.message || '行情訂閱失敗');
            }
            registerSubscription(body);
            return response;
        },
    );
}

export function unsubscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    return apiPost<SubscriptionResponse>('/api/v1/stream/unsubscribe', {
        ...contractKey(contract),
        quote_type: quoteType,
        intraday_odd: false,
    }).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '取消行情訂閱失敗');
        }
        unregisterSubscription(contract.code, quoteType);
        return response;
    });
}

export function subscribeContractQuotes(contract: ContractBase) {
    const quoteTypes: QuoteTypeName[] =
        contract.security_type === 'IND' ? ['Quote'] : ['Tick', 'BidAsk'];
    return Promise.allSettled(
        quoteTypes.map((quoteType) => subscribeQuote(contract, quoteType)),
    );
}

type CapabilityResponse = { success: boolean; message: string };
const capabilityQueues = new Map<string, Promise<CapabilityResponse>>();
const capabilityRefs = new Map<string, number>();

function enqueueCapability(
    key: string,
    operation: () => Promise<CapabilityResponse>,
) {
    const previous = capabilityQueues.get(key);
    const next = (previous ?? Promise.resolve())
        .catch(() => undefined)
        .then(operation);
    capabilityQueues.set(key, next);
    const cleanup = () => {
        if (capabilityQueues.get(key) === next) capabilityQueues.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
}

// The first subscribe after a server (re)start can race its warmup window:
// the listener is bound but the derived-data plumbing isn't serving yet, so
// the request hangs (apiPost has no timeout) or fails — and the panel then
// sat on 訂閱中 forever (2026-08-07 盤中實測). Bound every attempt and retry
// transient failures; explicit 4xx rejections are permanent and surface
// immediately.
const CAPABILITY_TIMEOUT_MS = 10_000;
const CAPABILITY_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`訂閱請求逾時（${ms / 1000} 秒）`)),
            ms,
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (reason: unknown) => {
                clearTimeout(timer);
                reject(
                    reason instanceof Error ? reason : new Error(String(reason)),
                );
            },
        );
    });
}

// apiPost errors lead with the HTTP status — 4xx means the request itself is
// wrong (unsupported code, bad ranking) and retrying can't help
function isPermanentApiError(reason: unknown): boolean {
    return reason instanceof Error && /^4\d\d\b/.test(reason.message);
}

async function updateCapabilitySubscription(
    action: 'subscribe' | 'unsubscribe',
    path: string,
    key: string,
    body: Record<string, unknown>,
) {
    return enqueueCapability(key, async () => {
        const refs = capabilityRefs.get(key) ?? 0;
        if (action === 'subscribe' && refs > 0) {
            capabilityRefs.set(key, refs + 1);
            return { success: true, message: 'Subscription retained' };
        }
        if (action === 'unsubscribe' && refs > 1) {
            capabilityRefs.set(key, refs - 1);
            return { success: true, message: 'Subscription retained' };
        }
        if (action === 'unsubscribe' && refs === 0) {
            return { success: true, message: 'Already unsubscribed' };
        }
        let response: CapabilityResponse;
        for (let attempt = 0; ; attempt++) {
            try {
                response = await withTimeout(
                    apiPost<CapabilityResponse>(
                        `/api/v1/stream/${action}/${path}`,
                        body,
                    ),
                    CAPABILITY_TIMEOUT_MS,
                );
                break;
            } catch (reason) {
                const delay = CAPABILITY_RETRY_DELAYS_MS[attempt];
                if (
                    action !== 'subscribe' ||
                    delay === undefined ||
                    isPermanentApiError(reason)
                ) {
                    throw reason;
                }
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        if (!response.success) {
            throw new Error(response.message || `${path} 訂閱操作失敗`);
        }
        if (action === 'subscribe') {
            capabilityRefs.set(key, 1);
            registerCapabilitySubscription(key, path, body);
        } else {
            capabilityRefs.delete(key);
            unregisterCapabilitySubscription(key);
        }
        return response;
    });
}

export type EnrichedIndexCapability =
    | 'calculated_index'
    | 'index_contribution'
    | 'industry_contribution';

export function subscribeEnrichedIndex(
    capability: EnrichedIndexCapability,
    contract: ContractBase,
    ranking?: ContributionRanking,
) {
    const body: Record<string, unknown> = {
        index: streamContractKey(contract),
    };
    if (capability === 'index_contribution') {
        body.ranking = ranking ?? 'top10';
    }
    const suffix =
        capability === 'index_contribution' ? `:${body.ranking}` : '';
    return updateCapabilitySubscription(
        'subscribe',
        capability,
        `${capability}:${contract.code}${suffix}`,
        body,
    );
}

export function unsubscribeEnrichedIndex(
    capability: EnrichedIndexCapability,
    contract: ContractBase,
    ranking?: ContributionRanking,
) {
    const body: Record<string, unknown> = {
        index: streamContractKey(contract),
    };
    if (capability === 'index_contribution') {
        body.ranking = ranking ?? 'top10';
    }
    const suffix =
        capability === 'index_contribution' ? `:${body.ranking}` : '';
    return updateCapabilitySubscription(
        'unsubscribe',
        capability,
        `${capability}:${contract.code}${suffix}`,
        body,
    );
}

export function scannerSubscriptionBody(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    return {
        scanner:
            scanner === 'simtrade' || scanner === 'suspend'
                ? scanner
                : { kind: 'preset_rule', id: scanner },
        region: 'TW',
        security_type: 'STK',
        exchange,
    };
}

export function subscribeMarketSignal(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    const body = scannerSubscriptionBody(scanner, exchange);
    return updateCapabilitySubscription(
        'subscribe',
        'scanner',
        `scanner:${exchange}:${scanner}`,
        body,
    );
}

export function unsubscribeMarketSignal(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    const body = scannerSubscriptionBody(scanner, exchange);
    return updateCapabilitySubscription(
        'unsubscribe',
        'scanner',
        `scanner:${exchange}:${scanner}`,
        body,
    );
}

// ---- orders ----

// R1/R2 continuous-month aliases are data-only — orders must target the
// resolved real contract (target_code, e.g. TXFR1 → TXFF6), otherwise the
// exchange rejects them (issue #1: TXFR1 下單 Failed)
function orderableKey(c: ContractBase) {
    const key = contractKey(c);
    if (c.target_code && /R[12]$/.test(c.code)) {
        return { ...key, code: c.target_code };
    }
    return key;
}

// place_order can return HTTP 200 with an immediately-rejected trade:
// status "Failed" and the real reason only in status.msg（CA 問題、未簽署、
// 價格不合法…）。Turn that into a thrown error so every order path's
// existing error handling surfaces it（issue #1: 只顯示 Failed 沒有原因）
function ensureAccepted<
    T extends { status: { status: string; msg?: string } },
>(t: T): T {
    if (t.status?.status === 'Failed') {
        throw new Error(t.status.msg || '委託被拒絕（Failed）');
    }
    return t;
}

// `account` routes the order to an explicit account (split orders / 分倉);
// omitted keeps the existing behavior — the store's selected account.
export function placeStockOrder(
    contract: ContractBase,
    order: StockOrderReq,
    account?: Account,
) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        stock_order: { ...order, account: account ?? accountFor('S') },
    }).then(ensureAccepted);
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
    account?: Account,
) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: orderableKey(contract),
        futures_order: { ...order, account: account ?? accountFor('F') },
    }).then(ensureAccepted);
}

export function cancelOrder(tradeId: string) {
    return apiPost<Trade>('/api/v1/order/cancel_order', { trade_id: tradeId });
}

export function updateOrderPrice(tradeId: string, price: number) {
    return apiPost<Trade>('/api/v1/order/update_price', {
        trade_id: tradeId,
        price,
    });
}

export function updateOrderQty(tradeId: string, quantity: number) {
    return apiPost<Trade>('/api/v1/order/update_qty', {
        trade_id: tradeId,
        quantity,
    });
}

// explicit account selector — omitted falls back to the store's selected
// account (then the server default). 全部帳戶 mode fans out one request per
// account and merges client-side.
export interface AccountSelector {
    broker_id: string;
    account_id: string;
}

function accountBody(accountType: AccountTypeName, account?: AccountSelector) {
    const acc = account ?? accountFor(accountType as 'S' | 'F');
    return {
        account_type: accountType,
        broker_id: acc?.broker_id,
        account_id: acc?.account_id,
    };
}

export function fetchTrades(
    accountType: AccountTypeName,
    account?: AccountSelector,
) {
    return apiPost<Trade[]>(
        '/api/v1/order/trades',
        accountBody(accountType, account),
    );
}

// ---- portfolio ----

export function fetchPositions(
    accountType: AccountTypeName,
    account?: AccountSelector,
) {
    // stocks use Share unit so odd lots aren't truncated (issue #2);
    // futures stay in contracts (Common)
    return apiPost<(StockPosition | FuturePosition)[]>(
        '/api/v1/portfolio/position_unit',
        {
            ...accountBody(accountType, account),
            unit: accountType === 'S' ? 'Share' : 'Common',
        },
    );
}

export function fetchAccountBalance() {
    return apiPost<AccountBalance>(
        '/api/v1/portfolio/account_balance',
        accountBody('S'),
    );
}

export function fetchMargin() {
    return apiPost<Margin>('/api/v1/portfolio/margin', accountBody('F'));
}

export interface Settlement {
    date: string;
    amount: number;
    /** T 日偏移：0=今日、1=T+1、2=T+2 */
    T: number;
}

export function fetchSettlements() {
    return apiPost<Settlement[]>(
        '/api/v1/portfolio/settlements',
        accountBody('S'),
    );
}

// ---- realized P&L 已實現損益（帳務/交割 tab）----
// 模擬環境 profit_loss 會切到 paper endpoint（有真資料）；profitloss_sum
// 則回空 summary＋全 0 total — 呼叫端要能拿列表自行加總當 fallback

export interface StockProfitLoss {
    id: number;
    code: string;
    quantity: number;
    pnl: number;
    /** YYYYMMDD，如 "20260724" */
    date: string;
    dseq: string;
    price: number;
    pr_ratio: number;
    cond: string;
    seqno: string;
}

export interface FutureProfitLoss {
    id: number;
    code: string;
    quantity: number;
    pnl: number;
    date: string;
    direction: 'Buy' | 'Sell';
    entry_price: number;
    cover_price: number;
    fee: number;
    tax: number;
}

export type ProfitLoss = StockProfitLoss | FutureProfitLoss;

export function fetchProfitLoss(
    accountType: AccountTypeName,
    account?: AccountSelector,
    beginDate = todayStr(),
    endDate = todayStr(),
) {
    return apiPost<ProfitLoss[]>('/api/v1/portfolio/profit_loss', {
        ...accountBody(accountType, account),
        begin_date: beginDate,
        end_date: endDate,
    });
}

export interface ProfitLossTotal {
    entry_amount: number;
    cover_amount: number;
    quantity: number;
    buy_cost: number;
    sell_cost: number;
    pnl: number;
    pr_ratio: number;
}

export interface StockProfitLossSummary {
    code: string;
    quantity: number;
    pnl: number;
    pr_ratio: number;
    entry_price: number;
    cover_price: number;
    entry_cost: number;
    cover_cost: number;
    buy_cost: number;
    sell_cost: number;
    cond: string;
    currency: string;
}

export interface FutureProfitLossSummary {
    code: string;
    quantity: number;
    pnl: number;
    direction: 'Buy' | 'Sell';
    entry_price: number;
    cover_price: number;
    fee: number;
    tax: number;
    currency: string;
}

export type ProfitLossSummary =
    | StockProfitLossSummary
    | FutureProfitLossSummary;

export interface ProfitLossSummaryTotal {
    profitloss_sum: ProfitLossSummary[];
    total: ProfitLossTotal;
}

export function fetchProfitLossSummary(
    accountType: AccountTypeName,
    account?: AccountSelector,
    beginDate = todayStr(),
    endDate = todayStr(),
) {
    return apiPost<ProfitLossSummaryTotal>(
        '/api/v1/portfolio/profitloss_sum',
        {
            ...accountBody(accountType, account),
            begin_date: beginDate,
            end_date: endDate,
        },
    );
}

// 交易額度：股票帳戶限定，交易日 08:30-15:00 才有值；模擬環境回全 0
export interface TradingLimits {
    trading_limit: number;
    trading_used: number;
    trading_available: number;
    margin_limit: number;
    margin_used: number;
    margin_available: number;
    short_limit: number;
    short_used: number;
    short_available: number;
}

export function fetchTradingLimits(account?: AccountSelector) {
    return apiPost<TradingLimits>(
        '/api/v1/portfolio/trading_limits',
        accountBody('S', account),
    );
}

// ---- 預收券款/圈存（查詢類 only）----
// reserve_stock / reserve_earmarking 申請屬下單類動作，刻意不在這裡實作。
// 模擬環境不支援預收，回空 stocks 或錯誤 — 呼叫端 catch 後顯示提示

export interface ReserveStockSummaryRow {
    contract: ContractBase;
    available_share: number;
    reserved_share: number;
}

export interface ReserveStocksSummary {
    stocks: ReserveStockSummaryRow[];
    account: Account;
}

export function fetchStockReserveSummary(account?: AccountSelector) {
    return apiPost<ReserveStocksSummary>(
        '/api/v1/order/stock_reserve_summary',
        accountBody('S', account),
    );
}

export interface ReserveStockDetailRow {
    contract: ContractBase;
    share: number;
    order_datetime: string;
    status: boolean;
    info: string;
}

export interface ReserveStocksDetail {
    stocks: ReserveStockDetailRow[];
    account: Account;
}

export function fetchStockReserveDetail(account?: AccountSelector) {
    return apiPost<ReserveStocksDetail>(
        '/api/v1/order/stock_reserve_detail',
        accountBody('S', account),
    );
}

export interface EarmarkStockDetailRow {
    contract: ContractBase;
    share: number;
    price: number;
    amount: number;
    order_datetime: string;
    status: boolean;
    info: string;
}

export interface EarmarkStocksDetail {
    stocks: EarmarkStockDetailRow[];
    account: Account;
}

export function fetchEarmarkingDetail(account?: AccountSelector) {
    return apiPost<EarmarkStocksDetail>(
        '/api/v1/order/earmarking_detail',
        accountBody('S', account),
    );
}

// ---- combo (spread) orders ----

export interface ComboLeg {
    action: 'Buy' | 'Sell';
    security_type: SecurityType;
    exchange: string | null;
    code: string;
    target_code?: string | null;
}

export type ComboType =
    | 'PriceSpread'
    | 'TimeSpread'
    | 'Straddle'
    | 'Strangle'
    | 'ConversionReversal'
    | 'WeeklyTimeSpread';

export interface ComboOrderReq {
    action: 'Buy' | 'Sell';
    price: number;
    quantity: number;
    price_type: 'LMT' | 'MKT' | 'MKP';
    order_type: 'ROD' | 'IOC' | 'FOK';
    octype?: 'Auto' | 'New' | 'Cover' | 'DayTrade';
    // explicit strategy type — the server can't always auto-derive it from
    // the legs（issue #1: 期貨轉倉 400 combo_type could not be auto-derived）
    combo_type?: ComboType | null;
}

export interface ComboTrade {
    contract: { legs: (ComboLeg & { [k: string]: unknown })[] };
    order: {
        id: string;
        seqno: string;
        action: 'Buy' | 'Sell';
        price: number;
        quantity: number;
    };
    status: { id: string; status: string; msg?: string; [k: string]: unknown };
}

export function placeComboOrder(legs: ComboLeg[], order: ComboOrderReq) {
    const acc = accountFor('F');
    // R1/R2 alias legs must order the resolved real contract too
    const resolved = legs.map((l) =>
        l.target_code && /R[12]$/.test(l.code)
            ? { ...l, code: l.target_code, target_code: null }
            : l,
    );
    return apiPost<ComboTrade>('/api/v1/order/place_comboorder', {
        combo_contract: { legs: resolved },
        order: { ...order, account: acc },
    }).then(ensureAccepted);
}

export function cancelComboOrder(tradeId: string) {
    return apiPost<ComboTrade>('/api/v1/order/cancel_comboorder', {
        trade_id: tradeId,
    });
}

export function fetchComboTrades() {
    return apiPost<ComboTrade[]>(
        '/api/v1/order/combotrades',
        accountBody('F'),
    );
}

// ---- server watchlists ----

export interface ServerWatchlist {
    id: string;
    name: string;
    contracts: { security_type: SecurityType; exchange: string; code: string }[];
}

export function fetchWatchlists() {
    return apiGet<ServerWatchlist[]>('/api/v1/watchlist');
}

export function createWatchlist(
    name: string,
    contracts: ContractBase[],
) {
    return apiPost<ServerWatchlist>('/api/v1/watchlist', {
        name,
        contracts: contracts.map(contractKey),
    });
}

export function syncWatchlist(id: string, contracts: ContractBase[]) {
    return apiPut<ServerWatchlist>(`/api/v1/watchlist/${id}`, {
        contracts: contracts.map(contractKey),
    });
}

export function addWatchlistContracts(id: string, contracts: ContractBase[]) {
    return apiPost<ServerWatchlist>(`/api/v1/watchlist/${id}/contracts`, {
        contracts: contracts.map(contractKey),
    });
}

export function removeWatchlistContracts(id: string, contracts: ContractBase[]) {
    return apiDelete<ServerWatchlist>(`/api/v1/watchlist/${id}/contracts`, {
        contracts: contracts.map(contractKey),
    });
}

export function deleteWatchlist(id: string) {
    return apiDelete<unknown>(`/api/v1/watchlist/${id}`);
}

// the server has no rename endpoint (PUT ignores `name`) — recreate the
// list under the new name with the same contracts, then drop the old id.
// Contracts are already in wire format so they round-trip untouched.
export async function renameWatchlist(list: ServerWatchlist, name: string) {
    const created = await apiPost<ServerWatchlist>('/api/v1/watchlist', {
        name,
        contracts: list.contracts,
    });
    await apiDelete<unknown>(`/api/v1/watchlist/${list.id}`);
    return created;
}
