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
    QuoteTypeName,
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
import { registerSubscription } from './stream';
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
        exchange: c.exchange,
        code: c.code,
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

export function fetchContract(
    code: string,
    securityType: SecurityType = 'STK',
) {
    const qs = new URLSearchParams({ security_type: securityType ?? '' });
    return apiGet<ContractInfo>(
        `/api/v1/data/contracts/${encodeURIComponent(code)}?${qs.toString()}`,
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
    registerSubscription(body);
    return apiPost<SubscriptionResponse>('/api/v1/stream/subscribe', body);
}

export function unsubscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    return apiPost<SubscriptionResponse>('/api/v1/stream/unsubscribe', {
        ...contractKey(contract),
        target_code: contract.target_code || null,
        quote_type: quoteType,
        intraday_odd: false,
    });
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

export function placeStockOrder(contract: ContractBase, order: StockOrderReq) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        stock_order: { ...order, account: accountFor('S') },
    }).then(ensureAccepted);
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: orderableKey(contract),
        futures_order: { ...order, account: accountFor('F') },
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

function accountBody(accountType: AccountTypeName) {
    const acc = accountFor(accountType as 'S' | 'F');
    return {
        account_type: accountType,
        broker_id: acc?.broker_id,
        account_id: acc?.account_id,
    };
}

export function fetchTrades(accountType: AccountTypeName) {
    return apiPost<Trade[]>('/api/v1/order/trades', accountBody(accountType));
}

// ---- portfolio ----

export function fetchPositions(accountType: AccountTypeName) {
    // stocks use Share unit so odd lots aren't truncated (issue #2);
    // futures stay in contracts (Common)
    return apiPost<(StockPosition | FuturePosition)[]>(
        '/api/v1/portfolio/position_unit',
        {
            ...accountBody(accountType),
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
}

export function fetchSettlements() {
    return apiPost<Settlement[]>(
        '/api/v1/portfolio/settlements',
        accountBody('S'),
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
