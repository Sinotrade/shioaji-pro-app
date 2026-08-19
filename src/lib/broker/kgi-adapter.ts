// src/lib/broker/kgi-adapter.ts

import type { ContractBase, ContractInfo, SecurityType } from '../types/contract';
import type { Health } from '../types/health';
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
} from '../types/market';
import type { FuturesOrderReq, StockOrderReq, Trade } from '../types/order';
import type {
    Account,
    AccountBalance,
    AccountTypeName,
    FuturePosition,
    Margin,
    StockPosition,
} from '../types/portfolio';
import type { HistoryTicks } from '../types/tick';
import { kgiDelete, kgiGet, kgiPost, kgiPut } from './backend';
import type {
    BrokerContractsQueryResponse,
    BrokerInfo,
    BrokerSettlement,
    BrokerTradingLimits,
    BrokerWatchlist,
    ComboTrade,
    DealsBySymbol,
    EarmarkStocksDetail,
    ProfitLoss,
    ProfitLossSummaryTotal,
    ReserveStocksDetail,
    ReserveStocksSummary,
} from './types';

function query(params: Record<string, string | number | undefined>) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') qs.set(key, String(value));
    }
    return qs.size ? `?${qs.toString()}` : '';
}

function contractBody(contract: ContractBase) {
    return {
        region: contract.region ?? 'TW',
        exchange: contract.exchange,
        code: contract.code,
        security_type: contract.security_type,
        target_code: contract.target_code ?? null,
    };
}

export function fetchHealth(): Promise<Health> {
    return kgiGet<Health>('/api/v1/health');
}

export function fetchInfo(): Promise<BrokerInfo> {
    return kgiGet<BrokerInfo>('/api/v1/info');
}

export function fetchAccounts(): Promise<Account[]> {
    return kgiGet<Account[]>('/api/v1/auth/accounts');
}

export function fetchCaExpire(personId: string) {
    return Promise.resolve({
        person_id: personId,
        expire_time: '2099-12-31T00:00:00+08:00',
    });
}

export function subscribeTradeEvents() {
    return Promise.resolve({ success: true });
}

export function fetchContractBase(
    code: string,
    securityType?: SecurityType,
): Promise<ContractBase> {
    return kgiGet<ContractBase>(
        `/api/v1/data/contracts/${encodeURIComponent(code)}${query({
            security_type: securityType ?? undefined,
        })}`,
    );
}

export function fetchContractInfo(
    code: string,
    securityType?: SecurityType,
): Promise<ContractInfo> {
    return kgiGet<ContractInfo>(
        `/api/v1/data/contracts/${encodeURIComponent(code)}/info${query({
            security_type: securityType ?? undefined,
        })}`,
    );
}

export function fetchContracts(
    securityType: Exclude<SecurityType, null>,
    page?: number,
    pageSize?: number,
): Promise<BrokerContractsQueryResponse> {
    return kgiGet<BrokerContractsQueryResponse>(
        `/api/v1/data/contracts${query({
            security_type: securityType,
            page,
            page_size: pageSize,
        })}`,
    );
}

export function fetchFutures(
    filters: {
        root?: string;
        underlyingCode?: string;
        deliveryMonth?: string;
    } = {},
) {
    return kgiGet<ContractInfo[]>(
        `/api/v1/data/contracts/futures${query({
            root: filters.root,
            underlying_code: filters.underlyingCode,
            delivery_month: filters.deliveryMonth,
        })}`,
    );
}

export function fetchFuturesRoots() {
    return kgiGet<{ root: string; name: string }[]>(
        '/api/v1/data/contracts/futures/roots',
    );
}

export function fetchOptions(
    root?: string,
    filters: {
        deliveryMonth?: string;
        optionRight?: 'C' | 'P';
        strikeMin?: number;
        strikeMax?: number;
        expiryWeekday?: string;
    } = {},
) {
    return kgiGet<ContractInfo[]>(
        `/api/v1/data/contracts/options${query({
            root,
            delivery_month: filters.deliveryMonth,
            option_right: filters.optionRight,
            strike_min: filters.strikeMin,
            strike_max: filters.strikeMax,
            expiry_weekday: filters.expiryWeekday,
        })}`,
    );
}

export function fetchOptionRoots() {
    return kgiGet<{ root: string; name: string }[]>(
        '/api/v1/data/contracts/options/roots',
    );
}

export function fetchWarrants(
    underlyingCode?: string,
    filters: {
        code?: string;
        callPut?: 'C' | 'P';
        strikeMin?: number;
        strikeMax?: number;
        expiryFrom?: string;
        expiryTo?: string;
    } = {},
) {
    return kgiGet<ContractInfo[]>(
        `/api/v1/data/contracts/warrants${query({
            underlying_code: underlyingCode,
            code: filters.code,
            call_put: filters.callPut,
            strike_min: filters.strikeMin,
            strike_max: filters.strikeMax,
            expiry_from: filters.expiryFrom,
            expiry_to: filters.expiryTo,
        })}`,
    );
}

export function fetchWarrantUnderlyings() {
    return kgiGet<
        { underlying_code: string; name?: string | null; warrant_count?: number }[]
    >('/api/v1/data/contracts/warrants/underlyings');
}

export function fetchSnapshots(contracts: ContractBase[]): Promise<Snapshot[]> {
    return kgiPost<Snapshot[]>('/api/v1/data/snapshots', {
        contracts: contracts.map(contractBody),
    });
}

export function fetchKbars(
    contract: ContractBase,
    start: string,
    end: string,
    minute = 1,
): Promise<KBars> {
    return kgiPost<KBars>('/api/v1/data/kbars', {
        contract: contractBody(contract),
        start,
        end,
        minute,
    });
}

export function fetchHistoryTicks(
    contract: ContractBase,
    date?: string,
): Promise<HistoryTicks> {
    return kgiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: contractBody(contract),
        date,
    });
}

export function fetchLastTicks(
    contract: ContractBase,
    count: number,
    date?: string,
): Promise<HistoryTicks> {
    return kgiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: contractBody(contract),
        date,
        query_type: 'LastCount',
        last_cnt: count,
    });
}

export function fetchScanner(
    scannerType: ScannerType,
    count: number,
    ascending: boolean,
): Promise<ScannerItem[]> {
    return kgiPost<ScannerItem[]>('/api/v1/data/scanner', {
        scanner_type: scannerType,
        count,
        ascending,
    });
}

export function subscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
): Promise<SubscriptionResponse> {
    return kgiPost<SubscriptionResponse>('/api/v1/stream/subscribe', {
        ...contractBody(contract),
        quote_type: quoteType,
        intraday_odd: false,
    });
}

export function unsubscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
): Promise<SubscriptionResponse> {
    return kgiPost<SubscriptionResponse>('/api/v1/stream/unsubscribe', {
        ...contractBody(contract),
        quote_type: quoteType,
        intraday_odd: false,
    });
}

export function subscribeEnrichedIndex(
    capability: 'calculated_index' | 'index_contribution' | 'industry_contribution',
    contract: ContractBase,
    ranking?: ContributionRanking,
) {
    return kgiPost<{ success: boolean; message: string }>(
        '/api/v1/stream/subscribe/enriched_index',
        {
            capability,
            contract: contractBody(contract),
            ranking,
        },
    );
}

export function unsubscribeEnrichedIndex(
    capability: 'calculated_index' | 'index_contribution' | 'industry_contribution',
    contract: ContractBase,
    ranking?: ContributionRanking,
) {
    return kgiPost<{ success: boolean; message: string }>(
        '/api/v1/stream/unsubscribe/enriched_index',
        {
            capability,
            contract: contractBody(contract),
            ranking,
        },
    );
}

export function subscribeMarketSignal(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    return kgiPost<{ success: boolean; message: string }>(
        '/api/v1/stream/subscribe/market_signal',
        { scanner, exchange },
    );
}

export function unsubscribeMarketSignal(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    return kgiPost<{ success: boolean; message: string }>(
        '/api/v1/stream/unsubscribe/market_signal',
        { scanner, exchange },
    );
}

export function placeStockOrder(
    contract: ContractBase,
    order: StockOrderReq,
): Promise<Trade> {
    return kgiPost<Trade>('/api/v1/order/place_order', {
        contract: contractBody(contract),
        stock_order: order,
        client_request_id: order.client_request_id,
    });
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
): Promise<Trade> {
    return kgiPost<Trade>('/api/v1/order/place_order', {
        contract: contractBody(contract),
        futures_order: order,
    });
}

export function cancelOrder(orderId: string, clientRequestId: string): Promise<Trade> {
    return kgiPost<Trade>('/api/v1/order/cancel_order', {
        order_id: orderId,
        client_request_id: clientRequestId,
    });
}

export function updateOrderPrice(orderId: string, price: number, clientRequestId: string): Promise<Trade> {
    return kgiPost<Trade>('/api/v1/order/update_price', {
        order_id: orderId,
        price,
        client_request_id: clientRequestId,
    });
}

export function updateOrderQty(orderId: string, quantity: number, clientRequestId: string): Promise<Trade> {
    return kgiPost<Trade>('/api/v1/order/update_qty', {
        order_id: orderId,
        quantity,
        client_request_id: clientRequestId,
    });
}

export function fetchTrades(accountType: AccountTypeName): Promise<Trade[]> {
    return kgiPost<Trade[]>('/api/v1/order/trades', {
        account_type: accountType,
    });
}

export function fetchDeals(accountType?: AccountTypeName): Promise<DealsBySymbol> {
    return kgiPost<DealsBySymbol>('/api/v1/order/deals', {
        account_type: accountType,
    });
}

export function fetchPositions(
    accountType: AccountTypeName,
): Promise<(StockPosition | FuturePosition)[]> {
    return kgiPost<(StockPosition | FuturePosition)[]>(
        '/api/v1/portfolio/position_unit',
        {
        account_type: accountType,
        unit: accountType === 'S' ? 'Share' : 'Common',
        },
    );
}

export function fetchAccountBalance(): Promise<AccountBalance> {
    return kgiPost<AccountBalance>('/api/v1/portfolio/account_balance', {
        account_type: 'S',
    });
}

export function fetchMargin(): Promise<Margin> {
    return kgiPost<Margin>('/api/v1/portfolio/margin', { account_type: 'S' });
}

export function fetchSettlements(): Promise<BrokerSettlement[]> {
    return kgiPost<BrokerSettlement[]>('/api/v1/portfolio/settlements', {
        account_type: 'S',
    });
}

export function fetchProfitLoss(
    accountType?: AccountTypeName,
    beginDate?: string,
    endDate?: string,
): Promise<ProfitLoss[]> {
    return kgiPost<ProfitLoss[]>('/api/v1/portfolio/profit_loss', {
        account_type: accountType,
        begin_date: beginDate,
        end_date: endDate,
    });
}

export function fetchProfitLossSummary(
    accountType?: AccountTypeName,
    beginDate?: string,
    endDate?: string,
): Promise<ProfitLossSummaryTotal> {
    return kgiPost<ProfitLossSummaryTotal>(
        '/api/v1/portfolio/profitloss_sum',
        { account_type: accountType, begin_date: beginDate, end_date: endDate },
    );
}

export function fetchTradingLimits(): Promise<BrokerTradingLimits> {
    return kgiPost<BrokerTradingLimits>('/api/v1/portfolio/trading_limits', {
        account_type: 'S',
    });
}

export function fetchStockReserveSummary(): Promise<ReserveStocksSummary> {
    return kgiPost<ReserveStocksSummary>(
        '/api/v1/order/stock_reserve_summary',
        {},
    );
}

export function fetchStockReserveDetail(): Promise<ReserveStocksDetail> {
    return kgiPost<ReserveStocksDetail>(
        '/api/v1/order/stock_reserve_detail',
        {},
    );
}

export function fetchEarmarkingDetail(): Promise<EarmarkStocksDetail> {
    return kgiPost<EarmarkStocksDetail>(
        '/api/v1/order/earmarking_detail',
        {},
    );
}

export function placeComboOrder(): Promise<ComboTrade> {
    return kgiPost<ComboTrade>('/api/v1/order/place_comboorder', {});
}

export function cancelComboOrder(): Promise<ComboTrade> {
    return kgiPost<ComboTrade>('/api/v1/order/cancel_comboorder', {});
}

export function fetchComboTrades(): Promise<ComboTrade[]> {
    return kgiPost<ComboTrade[]>('/api/v1/order/combotrades', {});
}

export function fetchWatchlists(): Promise<BrokerWatchlist[]> {
    return kgiGet<BrokerWatchlist[]>('/api/v1/watchlist');
}

export function createWatchlist(
    name: string,
    contracts: ContractBase[],
): Promise<BrokerWatchlist> {
    return kgiPost<BrokerWatchlist>('/api/v1/watchlist', {
        name,
        contracts: contracts.map(contractBody),
    });
}

export function syncWatchlist(
    id: string,
    contracts: ContractBase[],
): Promise<BrokerWatchlist> {
    return kgiPut<BrokerWatchlist>(`/api/v1/watchlist/${id}`, {
        contracts: contracts.map(contractBody),
    });
}

export function addWatchlistContracts(
    id: string,
    contracts: ContractBase[],
): Promise<BrokerWatchlist> {
    return kgiPost<BrokerWatchlist>(`/api/v1/watchlist/${id}/contracts`, {
        contracts: contracts.map(contractBody),
    });
}

export function removeWatchlistContracts(
    id: string,
    contracts: ContractBase[],
): Promise<BrokerWatchlist> {
    return kgiDelete<BrokerWatchlist>(`/api/v1/watchlist/${id}/contracts`, {
        contracts: contracts.map(contractBody),
    });
}

export function deleteWatchlist(id: string) {
    return kgiDelete<unknown>(`/api/v1/watchlist/${id}`);
}

export async function renameWatchlist(list: BrokerWatchlist, name: string) {
    const created = await createWatchlist(
        name,
        list.contracts.map((contract) => ({
            region: 'TW',
            exchange: contract.exchange as ContractBase['exchange'],
            code: contract.code,
            security_type: contract.security_type,
            target_code: null,
        })),
    );
    await deleteWatchlist(list.id);
    return created;
}
