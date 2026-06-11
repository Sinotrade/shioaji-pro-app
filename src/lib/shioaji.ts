// src/lib/shioaji.ts

import { accountFor } from './account-store';
import { apiGet, apiPost, apiPut } from './api';
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

export function placeStockOrder(contract: ContractBase, order: StockOrderReq) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        stock_order: { ...order, account: accountFor('S') },
    });
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        futures_order: { ...order, account: accountFor('F') },
    });
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
    return apiPost<(StockPosition | FuturePosition)[]>(
        '/api/v1/portfolio/position_unit',
        { ...accountBody(accountType), unit: 'Common' },
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
