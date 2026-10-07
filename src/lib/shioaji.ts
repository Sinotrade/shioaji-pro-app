import { canTrade } from './account-tradable';
import { createAccountQuery } from './account-query';
import { getApiBase } from './runtime';
import { remainingWorkingOrderQuantity } from './working-order-quantity';
import { noteMutationIntent } from './mutation-intent';
import { isOddLot, ODD_LOT_NO_PRICE_UPDATE, stockOrderProblem } from './odd-lot';
import { markConfirmedCancellation, observeTradeMutation } from './trade-mutations';
import { createCancelBatch, readMark, sharedAuthoritativeTrades, verifyCancellation, type CancelBatchMember } from './cancel-verification';
import { observeMarketSnapshots } from './market-snapshot-store';
import { observeTradeResponse } from './trade-observations';
import { beginServerInfoRequest, observeServerInfo } from './server-info-store';
// src/lib/shioaji.ts

import { accountFor, getAccountState } from './account-store';
import { apiDelete, apiGet, apiPost, apiPut } from './api';
import {
    registerCapabilitySubscription,
    registerSubscription,
    registerSubscriptionRaw,
    unregisterCapabilitySubscription,
    unregisterSubscription,
} from './stream';
import type {
    ContractBase,
    ContractInfo,
    SecurityType,
    TickBandsResponse,
} from './types/contract';
import type { Health } from './types/health';
import type {
    ContributionRanking,
    KBars,
    QuoteTypeName,
    ScannerExchange,
    ScannerItem,
    ScannerRule,
    ScannerType,
    Snapshot,
    SubscriptionResponse,
} from './types/market';
import type {
    FuturesOrderReq,
    StockOrderReq,
    Trade,
    TradeCacheHealth,
} from './types/order';
import type {
    Account,
    AccountBalance,
    AccountTypeName,
    FuturePosition,
    Margin,
    StockPosition,
} from './types/portfolio';
import type { HistoryTicks } from './types/tick';
import { todayStr } from './utils/date';

export interface ServerInfo {
    name: string;
    version: string;
    description: string;
    protocols: string[];
    simulation: boolean;
    /** SDK 1.7.8+：sidecar 程序的 instance id（每次啟動不同） */
    instance_id?: string;
    agent_harness?: Health['agent_harness'];
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

// 行情 API 的 contract 參數：組合商品（帶 combo meta 的合成合約）
// 需送腳陣列，一般合約送 flat key — 訂閱/快照/ticks/kbars 共用
function marketDataContract(c: ContractBase) {
    const combo = (c as { combo?: { legs: unknown; combo_type: unknown } })
        .combo;
    return combo
        ? { legs: combo.legs, combo_type: combo.combo_type }
        : contractKey(c);
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

// signal: lets a poller abort a hung probe so attempts never overlap
export function fetchHealth(opts?: { signal?: AbortSignal }) {
    return apiGet<Health>('/api/v1/health', opts);
}

export function fetchInfo() {
    // Ordered per API base so a slow or failed earlier call cannot overwrite
    // a newer response; the caller still gets its own result/error unchanged.
    const request = beginServerInfoRequest();
    return apiGet<ServerInfo>('/api/v1/info').then(info => {
        observeServerInfo(request, info);
        return info;
    }, error => {
        observeServerInfo(request, undefined);
        throw error;
    });
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

export async function subscribeTradeEvents(account: {
    broker_id: string;
    account_id: string;
    account_type: string;
}) {
    const query = createAccountQuery();
    const current = query.account(account.account_type as AccountTypeName, account);
    return apiPost<unknown>('/api/v1/auth/subscribe_trade', {
        broker_id: current.broker_id,
        account_id: current.account_id,
        account_type: current.account_type,
    }, { beforeDispatch: query.assertCurrent });
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

// FUT/OPT 跳動級距表 — rule 名稱來自 contract info 的 tick_rule
export function fetchTickBands(rule: string, securityType: 'FUT' | 'OPT') {
    return apiGet<TickBandsResponse>(
        `/api/v1/data/contracts/tick-bands/${encodeURIComponent(rule)}${contractQuery(
            { security_type: securityType, region: 'TW' },
        )}`,
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
    opts?: { signal?: AbortSignal },
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
        opts,
    );
}

export function fetchOptionRoots(opts?: { signal?: AbortSignal }) {
    return apiGet<ContractRoot[]>(
        '/api/v1/data/contracts/options/roots?region=TW',
        opts,
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
    return observeMarketSnapshots(contracts, apiPost<Snapshot[]>('/api/v1/data/snapshots', {
        contracts: contracts.map(marketDataContract),
    }));
}

// 開盤壅塞時 kbars 可能懸住（無回應非錯誤）— 每次 10s timeout，
// timeout/網路/5xx 以 2/4/8s 退避重試，4xx（參數/權限）直接拋出。
// 比照 capability 訂閱懸住的修法；下單路徑絕不套用這種 abort。
const KBARS_RETRY_DELAYS = [2000, 4000, 8000];

export async function fetchKbars(
    contract: ContractBase,
    start: string,
    end: string,
    opts?: { timeoutMs?: number },
): Promise<KBars> {
    const body = { contract: marketDataContract(contract), start, end };
    for (let attempt = 0; ; attempt++) {
        try {
            return await apiPost<KBars>('/api/v1/data/kbars', body, {
                timeoutMs: opts?.timeoutMs ?? 10_000,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // 4xx（參數/權限）不重試；( |$) 涵蓋無 reason phrase 的裸狀態碼
            const is4xx = /^4\d\d( |$)/.test(msg);
            if (is4xx || attempt >= KBARS_RETRY_DELAYS.length) throw e;
            await new Promise((r) =>
                setTimeout(r, KBARS_RETRY_DELAYS[attempt]),
            );
        }
    }
}

export function fetchHistoryTicks(contract: ContractBase, date: string) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: marketDataContract(contract),
        date,
    });
}

export function fetchLastTicks(
    contract: ContractBase,
    count: number,
    date = todayStr(),
) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: marketDataContract(contract),
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

export interface QuoteSubscribeOptions {
    /** 盤中零股行情（intraday_odd）— 與整股是兩個獨立訂閱（#204） */
    oddLot?: boolean;
}

export function subscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
    options?: QuoteSubscribeOptions,
) {
    const oddLot = options?.oddLot === true;
    // 組合商品走巢狀腳訂閱（flat code 如 TXFI6/J6 server 不認）
    const comboMeta = (contract as { combo?: unknown }).combo;
    if (comboMeta) {
        if (oddLot) return Promise.reject(new Error('組合商品沒有零股行情'));
        return subscribeComboQuote(
            comboMeta as Parameters<typeof subscribeComboQuote>[0],
            quoteType,
        );
    }
    const body = {
        ...contractKey(contract),
        // empty string must become null — the server 500s on target_code ""
        target_code: contract.target_code || null,
        quote_type: quoteType,
        intraday_odd: oddLot,
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
    options?: QuoteSubscribeOptions,
) {
    const oddLot = options?.oddLot === true;
    const comboMeta = (contract as { combo?: unknown }).combo;
    if (comboMeta && !oddLot) {
        return unsubscribeComboQuote(
            comboMeta as Parameters<typeof unsubscribeComboQuote>[0],
            quoteType,
        );
    }
    return apiPost<SubscriptionResponse>('/api/v1/stream/unsubscribe', {
        ...contractKey(contract),
        quote_type: quoteType,
        intraday_odd: oddLot,
    }).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '取消行情訂閱失敗');
        }
        unregisterSubscription(contract.code, quoteType, oddLot);
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
// wrong (unsupported code, bad ranking) and retrying can't help. A request
// rejected before dispatch must also stop, rather than retry in another mode.
function isPermanentApiError(reason: unknown): boolean {
    return reason instanceof Error && (/^4\d\d\b/.test(reason.message)
        || (reason as { subscriptionNotStarted?: boolean }).subscriptionNotStarted === true);
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

// index_components projection 訂閱（1.7.4）— 一條 (指數, 投影) 一個
// capability key，ref-count／重連重播沿用既有 capability 基建。
// projKey 由 index-components store 產生（同一投影必須產生同一 key）。
export function subscribeIndexComponents(
    contract: ContractBase,
    projection: Record<string, unknown>,
    projKey: string,
) {
    return updateCapabilitySubscription(
        'subscribe',
        'index_components',
        `index_components:${contract.code}:${projKey}`,
        { index: streamContractKey(contract), projection },
    );
}

export function unsubscribeIndexComponents(
    contract: ContractBase,
    projection: Record<string, unknown>,
    projKey: string,
) {
    return updateCapabilitySubscription(
        'unsubscribe',
        'index_components',
        `index_components:${contract.code}:${projKey}`,
        { index: streamContractKey(contract), projection },
    );
}

// index_components 權威建底查詢 — 呼叫紀律見 docs/adr/0001：
// 僅限首次與日切，429（日額度）不得重試，503（暖機）可退避重試
export function fetchIndexComponents<T>(contract: ContractBase) {
    return apiPost<T>('/api/v1/data/index_components', {
        contract: contractKey(contract),
    });
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

/** Every mutation shares this dispatch gate. Re-read the wire account from
 * the current list and the current mode, including after transport loading. */
function sendOrderMutation<T>(
    path: string,
    body: unknown,
    account: Account | undefined,
    opts?: Parameters<typeof apiPost>[2],
) {
    const base = getApiBase();
    const assertAccountCurrent = () => {
        const current = account && getAccountState().accounts.find(a =>
            a.account_type === account.account_type && a.broker_id === account.broker_id && a.account_id === account.account_id);
        if (base !== getApiBase() || !canTrade(current)) {
            throw Object.assign(new Error('伺服器模式或帳戶已變更，帳戶不可交易；未送出此筆'),
                { mutationNotStarted: true as const, tradingGateRejected: true as const });
        }
    };
    try { assertAccountCurrent(); }
    catch (error) { return Promise.reject(error); }
    const beforeDispatch = () => {
        assertAccountCurrent();
        opts?.beforeDispatch?.();
    };
    return apiPost<T>(path, body, { ...opts, beforeDispatch });
}

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
        throw Object.assign(
            new Error(t.status.msg || '委託被拒絕（Failed）'),
            { mutationNotStarted: true as const },
        );
    }
    return t;
}

// `account` routes the order to an explicit account (split orders / 分倉);
// omitted keeps the existing behavior — the store's selected account.
export function placeStockOrder(
    contract: ContractBase,
    order: StockOrderReq,
    account?: Account,
    opts?: { agentInitiated?: boolean; agentCallId?: string; agentAuto?: boolean; beforeDispatch?: () => void; onResponse?: (res: Response) => void },
) {
    // 零股不支援的組合（融資券／當沖／市價／IOC／超過 999 股）一律在送出前擋下（#204）
    const problem = stockOrderProblem(order);
    if (problem) return Promise.reject(Object.assign(new Error(problem), { mutationNotStarted: true as const }));
    const selected = account ?? accountFor('S');
    return sendOrderMutation<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        stock_order: { ...order, account: selected },
    }, selected, opts).then(ensureAccepted).then(trade => observeTradeResponse(trade, selected));
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
    account?: Account,
    opts?: { agentInitiated?: boolean; agentCallId?: string; agentAuto?: boolean; beforeDispatch?: () => void },
) {
    const selected = account ?? accountFor('F');
    return sendOrderMutation<Trade>('/api/v1/order/place_order', {
        contract: orderableKey(contract),
        futures_order: { ...order, account: selected },
    }, selected, opts).then(ensureAccepted).then(trade => observeTradeResponse(trade, selected));
}

/** Preflight for cancel/update. Shioaji 1.7.6 fixed Sinotrade/Shioaji#235
 * (production futures cache lacked ordno), so the temporary same-account
 * update_status before every futures mutation is gone. The request still
 * needs one unambiguous local order of a tradable account whose market matches
 * the product, on the server that is still current.
 *
 * trade_id only exists in the sidecar process that observed the order. When
 * the App has no authoritative baseline on the current sidecar instance (e.g.
 * it restarted outside the App), run ONE authoritative update_status for that
 * account and re-resolve the trade_id by the order's known identifiers. No
 * polling, no retry; any doubt refuses before dispatch.
 */
// trading-state imports this module; load it lazily, once, and share the
// promise so concurrent mutations (a cancel-all batch) resolve the same module.
let tradingStateModule: Promise<typeof import('./trading-state')> | null = null;
const loadTradingState = () => (tradingStateModule ??= import('./trading-state'));

async function prepareOrderMutation(tradeId: string): Promise<{ base: string; tradeId: string; trade: Trade; account: Account; tradingState: typeof import('./trading-state') }> {
    const base = getApiBase();
    const query = createAccountQuery();
    const requestedMark = readMark();
    const refuse = (message: string): never => { throw Object.assign(new Error(message), { mutationNotStarted: true }); };
    const tradingState = await loadTradingState();
    const { getTradingState, hasOrdersBaseline } = tradingState;
    if (base !== getApiBase()) refuse('伺服器已切換，未送出改刪單');
    const matches = getTradingState().trades.filter(t => t.order.id === tradeId);
    if (matches.length !== 1) refuse('委託或帳戶歸屬不明，請先手動更新委託；未送出改刪單');
    const trade = matches[0]!;
    if (trade.account && trade.order.account && (['account_type', 'broker_id', 'account_id'] as const).some(
        key => trade.account![key] !== trade.order.account![key])) refuse('委託帳戶資料矛盾，未送出改刪單');
    const reference = trade.account ?? trade.order.account;
    const account = getAccountState().accounts.find(a => canTrade(a) && reference
        && a.account_type === reference.account_type && a.broker_id === reference.broker_id && a.account_id === reference.account_id);
    if (!account) refuse('缺少已驗證的委託帳戶，未送出改刪單');
    const futures = ['FUT', 'OPT'].includes(trade.contract.security_type ?? '');
    if (account!.account_type !== (futures ? 'F' : 'S')) refuse('商品與委託帳戶不符，未送出改刪單');
    if (hasOrdersBaseline()) return { base, tradeId, trade, account: account!, tradingState };
    const seqno = trade.order.seqno?.trim();
    const ordno = trade.order.ordno?.trim();
    if (!seqno && !ordno) refuse('伺服器委託基準未建立且委託缺少序號，請先手動更新委託；未送出改刪單');
    // The read only has to find trade_ids on the current sidecar instance, so
    // any authoritative read of this account started after the baseline was
    // lost is shared (one per account per baseline loss, e.g. a whole popout
    // cancel-all). Only an order missing from that read gets one fresh read.
    const read = async (mark: number) => {
        try { return await query.read(account!.account_type as 'S' | 'F', account!, current =>
            sharedAuthoritativeTrades(`${base}|mode:${query.version}`, current, mark,
                () => fetchTrades(current.account_type as 'S' | 'F', current, { refresh: true }))); }
        catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { mutationNotStarted: true }); }
    };
    const code = (t: Trade) => t.contract.target_code || t.contract.code;
    const resolveId = (rows: Trade[]) => {
        query.assertCurrent();
        const candidates = rows.filter(r => (!r.order.account || (r.order.account.broker_id === account!.broker_id && r.order.account.account_id === account!.account_id))
            && ((seqno && r.order.seqno === seqno) || (ordno && r.order.ordno === ordno)));
        const found = candidates[0];
        if (candidates.length !== 1 || !found
            || (seqno && found.order.seqno && found.order.seqno !== seqno) || (ordno && found.order.ordno && found.order.ordno !== ordno)
            || found.order.action !== trade.order.action || code(found) !== code(trade)
            || remainingWorkingOrderQuantity(found) <= 0 || !found.order.id) return null;
        return found;
    };
    const lostMark = tradingState.ordersBaselineLostMark();
    let found = resolveId(await read(lostMark));
    if (!found && lostMark < requestedMark) found = resolveId(await read(requestedMark));
    if (base !== getApiBase()) refuse('對帳期間伺服器已切換，未送出改刪單');
    if (!found) refuse('伺服器重新對帳後找不到可操作的同筆委託，未送出改刪單');
    return { base, tradeId: found!.order.id, trade, account: account!, tradingState };
}

/** Resolves only with a read-back-confirmed cancellation (#120/#116): the
 *  order's own account row is Cancelled and cancel_quantity covers what was
 *  remaining. Otherwise rejects with CANCEL_UNCONFIRMED (mutationOutcomeUnknown)
 *  — the cancel was sent, its effect is unknown, and it is never resent. */
export function cancelOrder(
    tradeId: string,
    opts?: {
        agentInitiated?: boolean; agentCallId?: string; agentAuto?: boolean; batch?: CancelBatchMember;
        onResponse?: (res: Response) => void;
        // runs synchronously right before the HTTP cancel is sent; throwing
        // refuses it (mutationNotStarted) — e.g. the caller's bound environment changed
        beforeSend?: () => void;
    },
) {
    const { batch, beforeSend, ...requestOpts } = opts ?? {};
    // A batch member that fails before verification still arrives, so the
    // batch's shared confirmation read is not held back.
    return observeCancel(tradeId, requestOpts, batch, beforeSend).finally(() => batch?.arrive());
}

/**
 * Cancel an order identified by a row the caller has just read from the server
 * (POST /order/trades on the current sidecar, under the caller's verified server
 * identity). Unlike cancelOrder, nothing is resolved through the App's local
 * trading-state rows: a stale local row carrying the same trade_id (e.g. a trade
 * id reused by another order after a sidecar restart) can never redirect the
 * cancel. The trade_id and the quantities used for confirmation all come from
 * the supplied server row; confirmation reads the same sidecar's cache.
 */
export function cancelVerifiedOrder(
    row: Trade,
    account: Account,
    opts?: { beforeSend?: () => void; onResponse?: (res: Response) => void },
): Promise<Trade> {
    const tradeId = row.order.id;
    return observeTradeMutation(tradeId, async () => {
        const base = getApiBase();
        const refuse = (message: string): never => { throw Object.assign(new Error(message), { mutationNotStarted: true }); };
        if (!tradeId) refuse('缺少委託編號，未送出刪單');
        const type = account.account_type as 'S' | 'F';
        const query = createAccountQuery();
        await sendOrderMutation<Trade>('/api/v1/order/cancel_order', { trade_id: tradeId }, account, {
            onResponse: opts?.onResponse,
            beforeDispatch: () => {
                try {
                    opts?.beforeSend?.();
                    query.account(type, account);
                } catch (e) {
                    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { mutationNotStarted: true });
                }
            }
        });
        const { trade } = await verifyCancellation(row, account, {
            scope: `${base}|mode:${query.version}`,
            // The row came from this sidecar's own cache just now: its cache is the reference.
            cacheTrusted: () => true,
            locallyCancelled: () => false,
            guard: () => {
                if (base !== getApiBase()) throw new Error('刪單後伺服器已切換');
                query.assertCurrent();
            },
            readTrades: refresh => query.read(type, account, current => fetchTrades(type, current, { refresh })),
            readHealth: () => query.read(type, account, current => fetchTradeCacheHealth(type, current)),
        });
        query.assertCurrent();
        return markConfirmedCancellation({ ...trade, account });
    });
}

/** Cancel several orders: every request is sent first, then each account's
 *  cancels share one authoritative confirmation read (refresh:true) instead of
 *  one per order. Used by every batch path (flash 全刪, 鋪單全撤, 全部刪單,
 *  batch cancel). Single cancels use cancelOrder. */
export function cancelOrders(tradeIds: string[], onSettled?: () => void, beforeSend?: () => void, onResponse?: (res: Response) => void): Promise<PromiseSettledResult<Trade>[]> {
    const batch = createCancelBatch(tradeIds.length);
    return Promise.allSettled(tradeIds.map(id => cancelOrder(id, { batch: batch.member(), beforeSend, onResponse }).finally(() => onSettled?.())));
}

/** #244: an order placed outside this sidecar (e.g. iLeader) is known to it
 *  only from its active New report, whose account carries no person_id. The
 *  sidecar signs a cancel with that empty person_id and refuses it locally
 *  ("400 CA not activated for: ") before contacting the broker. */
function isUnsignableReportTrade(error: unknown): boolean {
    return error instanceof Error && (error as { status?: unknown }).status === 400
        && /^400 CA not activated for:$/.test(error.message.trim());
}

/** One authoritative update_status for the order's account: the sidecar
 *  rebuilds the row from the broker and fills the account from its login
 *  accounts, so the cancel can be signed. The first request never reached the
 *  broker; if the row is still unsignable, nothing more is sent. */
async function hydrateReportTrade(base: string, tradeId: string, account: Account) {
    const notStarted = (message: string) => Object.assign(new Error(message), { mutationNotStarted: true as const });
    const type = account.account_type as 'S' | 'F';
    const query = createAccountQuery();
    let rows: Trade[];
    try {
        rows = await query.read(type, account, current => sharedAuthoritativeTrades(`${base}|mode:${query.version}`, current,
            readMark(), () => fetchTrades(type, current, { refresh: true })));
    } catch (error) {
        throw notStarted(`此委託來自其他下單軟體，伺服器需先同步委託才能刪單，但同步失敗（${error instanceof Error ? error.message : String(error)}）；未送出刪單`);
    }
    if (base !== getApiBase()) throw notStarted('對帳期間伺服器已切換，未送出刪單');
    query.assertCurrent();
    const row = rows.filter(r => r.order.id === tradeId && (!r.order.account
        || (r.order.account.broker_id === account.broker_id && r.order.account.account_id === account.account_id)));
    if (row.length !== 1 || !row[0]!.order.account?.person_id) {
        throw notStarted('此委託來自其他下單軟體，伺服器同步後仍缺少簽章所需的帳戶資料；未送出刪單，請改在原下單軟體刪單');
    }
}

function observeCancel(
    tradeId: string,
    opts: { agentInitiated?: boolean; agentCallId?: string; agentAuto?: boolean; onResponse?: (res: Response) => void },
    batch: CancelBatchMember | undefined,
    beforeSend?: () => void,
) {
    return observeTradeMutation(tradeId, async () => {
        const target = await prepareOrderMutation(tradeId);
        const { account } = target;
        const { cancelCacheTrusted, locallyCancelled } = target.tradingState;
        if (target.base !== getApiBase()) throw Object.assign(new Error('伺服器已切換，未送出改刪單'), { mutationNotStarted: true });
        const send = () => sendOrderMutation<Trade>(
            '/api/v1/order/cancel_order',
            { trade_id: target.tradeId },
            account,
            { ...opts, beforeDispatch: () => {
                try {
                    beforeSend?.();
                } catch (e) {
                    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { mutationNotStarted: true });
                }
            } },
        );
        try {
            await send();
        } catch (error) {
            if (!isUnsignableReportTrade(error)) throw error;
            await hydrateReportTrade(target.base, target.tradeId, account);
            await send();
        }
        // Quantities come from the local order at the start; the id is the one
        // the current sidecar knows (re-resolved when there was no baseline).
        const before: Trade = { ...target.trade, order: { ...target.trade.order, id: target.tradeId } };
        const type = account.account_type as 'S' | 'F';
        const query = createAccountQuery();
        query.account(type, account);
        const { trade } = await verifyCancellation(before, account, {
            scope: `${target.base}|mode:${query.version}`,
            // A re-resolved trade_id means no continuous baseline: skip the cache.
            cacheTrusted: () => target.tradeId === tradeId && cancelCacheTrusted(),
            locallyCancelled: () => locallyCancelled(tradeId, account),
            guard: () => {
                if (target.base !== getApiBase()) throw new Error('刪單後伺服器已切換');
                query.assertCurrent();
            },
            readTrades: refresh => query.read(type, account, current => fetchTrades(type, current, { refresh })),
            readHealth: () => query.read(type, account, current => fetchTradeCacheHealth(type, current)),
            batch,
        });
        query.assertCurrent();
        // A trade_id re-resolved after a sidecar restart is the same order the
        // caller named; report it under the caller's id so the App's row and
        // the Agent's order_id match. Status and quantities are the broker's.
        const confirmed = target.tradeId === tradeId ? trade : { ...trade, order: { ...trade.order, id: tradeId } };
        return markConfirmedCancellation({ ...confirmed, account });
    });
}

export function updateOrderPrice(tradeId: string, price: number) {
    return observeTradeMutation(tradeId, async () => {
        const target = await prepareOrderMutation(tradeId);
        if (target.base !== getApiBase()) throw Object.assign(new Error('伺服器已切換，未送出改刪單'), { mutationNotStarted: true });
        // 零股委託只能減量（#204）— 任何改價路徑都在送出前擋下
        if (isOddLot(target.trade.order.order_lot)) throw Object.assign(new Error(ODD_LOT_NO_PRICE_UPDATE), { mutationNotStarted: true });
        noteMutationIntent(tradeId, { kind: 'price', price });
        return sendOrderMutation<Trade>('/api/v1/order/update_price', {
        trade_id: target.tradeId,
        price,
    }, target.account); });
}

export function updateOrderQty(tradeId: string, quantity: number) {
    return observeTradeMutation(tradeId, async () => {
        const target = await prepareOrderMutation(tradeId);
        if (target.base !== getApiBase()) throw Object.assign(new Error('伺服器已切換，未送出改刪單'), { mutationNotStarted: true });
        noteMutationIntent(tradeId, { kind: 'qty', quantity });
        return sendOrderMutation<Trade>('/api/v1/order/update_qty', {
        trade_id: target.tradeId,
        quantity,
    }, target.account); });
}

// Explicit account selector — omitted resolves the store's selected account.
// Missing/unqualified accounts never fall through to a server default.
// 全部帳戶 mode fans out one request per
// account and merges client-side.
export interface AccountSelector {
    broker_id: string;
    account_id: string;
}

function accountQueryPost<T>(path: string, type: AccountTypeName, selector?: AccountSelector, extra: Record<string, unknown> = {}): Promise<T> {
    const query = createAccountQuery();
    return query.read(type, selector, account => apiPost<T>(path, {
        ...extra,
        account_type: type,
        broker_id: account.broker_id,
        account_id: account.account_id,
    }, { beforeDispatch: query.assertCurrent }));
}

export interface FetchTradesOptions {
    /** Shioaji 1.7.6+. `false` reads only this sidecar's process-local Trade
     *  cache (no upstream call, no accounting quota); `true` runs
     *  update_status(account) — the authoritative reconciliation. Omitted keeps
     *  the server default (`true`). Cache rows are not a reconciliation. */
    refresh?: boolean;
}

export function fetchTrades(
    accountType: AccountTypeName,
    account?: AccountSelector,
    options?: FetchTradesOptions,
) {
    return accountQueryPost<Trade[]>('/api/v1/order/trades', accountType, account,
        options?.refresh === undefined ? {} : { refresh: options.refresh });
}

/** Shioaji 1.7.6+: health of the sidecar's process-local Trade cache for one
 *  account. Cache-only (no broker call); still an HTTP request, so callers
 *  must trigger it from events (reconnect, detected gap, manual), not timers. */
export function fetchTradeCacheHealth(
    accountType: 'S' | 'F',
    account?: AccountSelector,
) {
    return accountQueryPost<TradeCacheHealth>('/api/v1/order/trade_cache_health', accountType, account);
}

// ---- portfolio ----

export function fetchPositions(
    accountType: AccountTypeName,
    account?: AccountSelector,
) {
    // stocks use Share unit so odd lots aren't truncated (issue #2);
    // futures stay in contracts (Common)
    return accountQueryPost<(StockPosition | FuturePosition)[]>('/api/v1/portfolio/position_unit', accountType, account,
        { unit: accountType === 'S' ? 'Share' : 'Common' });
}

export function fetchAccountBalance(account?: AccountSelector) {
    return accountQueryPost<AccountBalance>('/api/v1/portfolio/account_balance', 'S', account);
}

export function fetchMargin(account?: AccountSelector) {
    return accountQueryPost<Margin>('/api/v1/portfolio/margin', 'F', account);
}

export interface Settlement {
    date: string;
    amount: number;
    /** T 日偏移：0=今日、1=T+1、2=T+2 */
    T: number;
}

export function fetchSettlements(account?: AccountSelector) {
    return accountQueryPost<Settlement[]>('/api/v1/portfolio/settlements', 'S', account);
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
    return accountQueryPost<ProfitLoss[]>('/api/v1/portfolio/profit_loss', accountType, account, {
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
    return accountQueryPost<ProfitLossSummaryTotal>(
        '/api/v1/portfolio/profitloss_sum', accountType, account,
        {
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
    return accountQueryPost<TradingLimits>('/api/v1/portfolio/trading_limits', 'S', account);
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
    return accountQueryPost<ReserveStocksSummary>('/api/v1/order/stock_reserve_summary', 'S', account);
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
    return accountQueryPost<ReserveStocksDetail>('/api/v1/order/stock_reserve_detail', 'S', account);
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
    return accountQueryPost<EarmarkStocksDetail>('/api/v1/order/earmarking_detail', 'S', account);
}

// ---- combo (spread) orders ----
// 1.7.3 managed 語意（issue #32）：腳不帶 action，ComboOrder.action 是
// 交易所 BS_Code，腳方向由 server 依組合型別展開。舊 directed 模式
// （腳各帶 action、order action 被忽略）已不再使用 — 兩套 action 並存
// 是誤操作根源。

export interface ComboLeg {
    // managed 下單的腳不帶 action；ComboTrade 回報的腳由 server 展開後
    // 會帶實際方向
    action?: 'Buy' | 'Sell';
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

export interface ManagedComboLegReq {
    security_type: SecurityType;
    region: string;
    exchange: string | null;
    code: string;
    target_code: string | null;
}

// server 驗證後的 managed 組合合約 — code（如 TXFH6/I6）同時是 FOP SSE
// 行情事件的身分，可直接餵 useQuote
export interface ManagedComboContract {
    code: string;
    legs: ManagedComboLegReq[];
    region: string;
    exchange: string;
    combo_type: ComboType;
    managed: boolean;
}

export function comboLegReq(c: ContractBase): ManagedComboLegReq {
    // R1/R2 連續月別名不能當組合腳 — server 會拒絕，先換成真實合約
    const code =
        c.target_code && /R[12]$/.test(c.code) ? c.target_code : c.code;
    return {
        security_type: c.security_type,
        region: c.region ?? 'TW',
        exchange: c.exchange,
        code,
        target_code: null,
    };
}

/** server 端驗證兩腳並回 canonical 組合（期貨限定；反序回 400）。 */
export function buildComboContract(legs: ManagedComboLegReq[]) {
    return apiPost<ManagedComboContract>('/api/v1/data/contracts/combo', {
        legs,
    });
}

/** 枚舉一個期貨家族目前所有可交易的 managed 組合（近月在前）。 */
export function fetchComboFutures(root: string) {
    return apiGet<ManagedComboContract[]>(
        `/api/v1/data/contracts/combo/futures?root=${encodeURIComponent(root)}&region=TW`,
    );
}

function comboStreamBody(
    combo: Pick<ManagedComboContract, 'legs' | 'combo_type'>,
    quoteType: QuoteTypeName,
) {
    return {
        contract: { legs: combo.legs, combo_type: combo.combo_type },
        quote_type: quoteType,
        intraday_odd: false,
    };
}

export function subscribeComboQuote(
    combo: Pick<ManagedComboContract, 'code' | 'legs' | 'combo_type'>,
    quoteType: QuoteTypeName,
) {
    const body = comboStreamBody(combo, quoteType);
    return apiPost<SubscriptionResponse>('/api/v1/stream/subscribe', body).then(
        (response) => {
            if (!response.success) {
                throw new Error(response.message || '組合行情訂閱失敗');
            }
            registerSubscriptionRaw(combo.code, quoteType, body);
            return response;
        },
    );
}

export function unsubscribeComboQuote(
    combo: Pick<ManagedComboContract, 'code' | 'legs' | 'combo_type'>,
    quoteType: QuoteTypeName,
) {
    return apiPost<SubscriptionResponse>(
        '/api/v1/stream/unsubscribe',
        comboStreamBody(combo, quoteType),
    ).then((response) => {
        unregisterSubscription(combo.code, quoteType);
        return response;
    });
}

/** 原生組合商品批次快照（一整個家族一發，rate limit 友善）。 */
export function fetchComboSnapshots(
    combos: Pick<ManagedComboContract, 'legs' | 'combo_type'>[],
) {
    return apiPost<Snapshot[]>('/api/v1/data/snapshots', {
        contracts: combos.map((c) => ({
            legs: c.legs,
            combo_type: c.combo_type,
        })),
    });
}

/** 原生組合商品快照 — 訂閱後簿未變動前的初始畫面。 */
export function fetchComboSnapshot(
    combo: Pick<ManagedComboContract, 'legs' | 'combo_type'>,
) {
    return fetchComboSnapshots([combo]).then((arr) => arr[0] ?? null);
}

export interface ComboOrderReq {
    action: 'Buy' | 'Sell';
    price: number;
    quantity: number;
    price_type: 'LMT' | 'MKT' | 'MKP';
    order_type: 'ROD' | 'IOC' | 'FOK';
    octype?: 'Auto' | 'New' | 'Cover' | 'DayTrade';
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

/**
 * managed 組合下單：actionless 腳＋整體 action。combo_type 僅在必要時
 * 傳（曖昧 C+P 由使用者選、期貨用 server 驗證回的值）；未傳時 server
 * 以 Contract V2 Info 推導（含 WeeklyTimeSpread 變體）。
 */
export function placeComboOrder(
    combo: { legs: ManagedComboLegReq[]; combo_type?: ComboType | null },
    order: ComboOrderReq,
    // explicit account captured by the caller; omitted = current selection
    account?: Account,
) {
    const acc = account ?? accountFor('F');
    return sendOrderMutation<ComboTrade>('/api/v1/order/place_comboorder', {
        combo_contract: {
            legs: combo.legs,
            ...(combo.combo_type ? { combo_type: combo.combo_type } : {}),
        },
        order: { ...order, account: acc },
    }, acc).then(ensureAccepted);
}

export function cancelComboOrder(tradeId: string) {
    return sendOrderMutation<ComboTrade>('/api/v1/order/cancel_comboorder', {
        trade_id: tradeId,
    }, accountFor('F'));
}

export function fetchComboTrades() {
    return accountQueryPost<ComboTrade[]>('/api/v1/order/combotrades', 'F');
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
