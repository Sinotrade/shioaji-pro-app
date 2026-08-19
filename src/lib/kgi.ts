import * as adapter from './broker/kgi-adapter';
import type {
    BrokerAccountSelector as AccountSelector,
    BrokerContractsQueryResponse as ContractsQueryResponse,
    BrokerContractRoot as ContractRoot,
    BrokerInfo as ServerInfo,
    BrokerSettlement as Settlement,
    BrokerTradingLimits as TradingLimits,
    BrokerWarrantUnderlying as WarrantUnderlying,
    BrokerWatchlist as ServerWatchlist,
    ComboLeg,
    ComboOrderReq,
    ComboTrade,
    ComboType,
    EarmarkStocksDetail,
    ProfitLoss,
    ProfitLossSummaryTotal,
    ReserveStocksDetail,
    ReserveStocksSummary,
} from './broker/types';
import type {
    ContractBase,
    ContractInfo,
    SecurityType,
} from './types/contract';
import type {
    ContributionRanking,
    QuoteTypeName,
    ScannerExchange,
    ScannerItem,
    ScannerRule,
    ScannerType,
} from './types/market';
import type {
    FuturesOrderReq,
    StockOrderReq,
} from './types/order';
import type { AccountTypeName } from './types/portfolio';
import {
    registerCapabilitySubscription,
    registerSubscription,
    unregisterCapabilitySubscription,
    unregisterSubscription,
} from './stream';

export type {
    AccountSelector,
    ComboLeg,
    ComboOrderReq,
    ComboTrade,
    ComboType,
    ContractRoot,
    ContractsQueryResponse,
    EarmarkStocksDetail,
    ProfitLoss,
    ProfitLossSummaryTotal,
    ReserveStocksDetail,
    ReserveStocksSummary,
    ServerInfo,
    ServerWatchlist,
    Settlement,
    TradingLimits,
    WarrantUnderlying,
};

const INDEX_CODE_ALIASES: Record<string, string> = {
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

export function newClientRequestId(prefix = 'order'): string {
    const random =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
}

function subscriptionBody(contract: ContractBase, quoteType: QuoteTypeName) {
    return {
        security_type: contract.security_type,
        exchange: contract.exchange,
        code: contract.code,
        target_code: contract.target_code || null,
        quote_type: quoteType,
        intraday_odd: false,
    };
}

export function normalizeContractCode(
    code: string,
    securityType?: SecurityType,
) {
    const normalized = code.trim().toUpperCase();
    return securityType === 'IND' || normalized in INDEX_CODE_ALIASES
        ? (INDEX_CODE_ALIASES[normalized] ?? normalized)
        : normalized;
}

export const fetchHealth = adapter.fetchHealth;
export const fetchInfo = adapter.fetchInfo;
export const fetchAccounts = adapter.fetchAccounts;
export const fetchCaExpire = adapter.fetchCaExpire;
export const fetchContracts = adapter.fetchContracts;
export const fetchFutures = adapter.fetchFutures;
export const fetchFuturesRoots = adapter.fetchFuturesRoots;
export const fetchOptions = adapter.fetchOptions;
export const fetchOptionRoots = adapter.fetchOptionRoots;
export const fetchWarrants = adapter.fetchWarrants;
export const fetchWarrantUnderlyings = adapter.fetchWarrantUnderlyings;
export const fetchSnapshots = adapter.fetchSnapshots;
export const fetchKbars = adapter.fetchKbars;
export const fetchHistoryTicks = adapter.fetchHistoryTicks;
export const fetchLastTicks = adapter.fetchLastTicks;
export const fetchScanner = adapter.fetchScanner;
export const fetchAccountBalance = adapter.fetchAccountBalance;
export const fetchMargin = adapter.fetchMargin;
export const fetchSettlements = adapter.fetchSettlements;
export const fetchComboTrades = adapter.fetchComboTrades;
export const fetchWatchlists = adapter.fetchWatchlists;
export const createWatchlist = adapter.createWatchlist;
export const syncWatchlist = adapter.syncWatchlist;
export const addWatchlistContracts = adapter.addWatchlistContracts;
export const removeWatchlistContracts = adapter.removeWatchlistContracts;
export const deleteWatchlist = adapter.deleteWatchlist;
export const renameWatchlist = adapter.renameWatchlist;

export function fetchContractBase(code: string, securityType?: SecurityType) {
    return adapter.fetchContractBase(
        normalizeContractCode(code, securityType),
        securityType,
    );
}

export function fetchContractInfo(code: string, securityType?: SecurityType) {
    return adapter.fetchContractInfo(
        normalizeContractCode(code, securityType),
        securityType,
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
    // The backend has no dedicated /info route — GET /contracts/:code and
    // GET /contracts/:code/info both fall through to the same handler
    // (backend/kgi_bridge/server.py) and return an identical payload, and
    // ContractInfo is already a superset of ContractBase. Fetching both
    // was a duplicate round-trip for every symbol the app ever resolves
    // (watchlist, positions, orders, scanner, heatmap...) — one call does
    // the same job.
    const info = await fetchContractInfo(code, securityType);
    if (info.security_type === 'WRT') {
        return {
            ...info,
            name: info.code,
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
    return info;
}

export function subscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    const body = subscriptionBody(contract, quoteType);
    return adapter.subscribeQuote(contract, quoteType).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '行情訂閱失敗');
        }
        registerSubscription(body);
        return response;
    });
}

export function unsubscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    return adapter.unsubscribeQuote(contract, quoteType).then((response) => {
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

export function subscribeEnrichedIndex(
    capability: 'calculated_index' | 'index_contribution' | 'industry_contribution',
    contract: ContractBase,
    ranking?: ContributionRanking,
) {
    const key = `enriched_index:${capability}:${contract.code}:${ranking ?? ''}`;
    const body = {
        capability,
        contract: subscriptionBody(contract, 'Quote'),
        ranking,
    };
    return adapter.subscribeEnrichedIndex(capability, contract, ranking).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '市場脈動訂閱失敗');
        }
        registerCapabilitySubscription(key, 'enriched_index', body);
        return response;
    });
}

export function unsubscribeEnrichedIndex(
    capability: 'calculated_index' | 'index_contribution' | 'industry_contribution',
    contract: ContractBase,
    ranking?: ContributionRanking,
) {
    const key = `enriched_index:${capability}:${contract.code}:${ranking ?? ''}`;
    return adapter.unsubscribeEnrichedIndex(capability, contract, ranking).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '市場脈動取消訂閱失敗');
        }
        unregisterCapabilitySubscription(key);
        return response;
    });
}

export function subscribeMarketSignal(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    const key = `market_signal:${exchange}:${scanner}`;
    const body = { scanner, exchange };
    return adapter.subscribeMarketSignal(scanner, exchange).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '即時訊號訂閱失敗');
        }
        registerCapabilitySubscription(key, 'market_signal', body);
        return response;
    });
}

export function unsubscribeMarketSignal(
    scanner: ScannerRule,
    exchange: ScannerExchange,
) {
    const key = `market_signal:${exchange}:${scanner}`;
    return adapter.unsubscribeMarketSignal(scanner, exchange).then((response) => {
        if (!response.success) {
            throw new Error(response.message || '即時訊號取消訂閱失敗');
        }
        unregisterCapabilitySubscription(key);
        return response;
    });
}

export function subscribeTradeEvents(_account?: {
    broker_id: string;
    account_id: string;
    account_type: string;
}) {
    return adapter.subscribeTradeEvents();
}

export function placeStockOrder(
    contract: ContractBase,
    order: StockOrderReq,
    _account?: AccountSelector,
) {
    return adapter.placeStockOrder(contract, order);
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
    _account?: AccountSelector,
) {
    return adapter.placeFuturesOrder(contract, order);
}

export function cancelOrder(_tradeId?: string) {
    return adapter.cancelOrder(_tradeId ?? '', newClientRequestId('cancel'));
}

export function updateOrderPrice(_tradeId?: string, _price?: number) {
    return adapter.updateOrderPrice(
        _tradeId ?? '',
        _price ?? 0,
        newClientRequestId('update-price'),
    );
}

export function updateOrderQty(_tradeId?: string, _quantity?: number) {
    return adapter.updateOrderQty(
        _tradeId ?? '',
        _quantity ?? 0,
        newClientRequestId('update-qty'),
    );
}

export function fetchTrades(
    accountType: AccountTypeName,
    _account?: AccountSelector,
) {
    return adapter.fetchTrades(accountType);
}

export function fetchDeals(accountType?: AccountTypeName) {
    return adapter.fetchDeals(accountType);
}

export function fetchPositions(
    accountType: AccountTypeName,
    _account?: AccountSelector,
) {
    return adapter.fetchPositions(accountType);
}

export function fetchProfitLoss(
    accountType?: AccountTypeName,
    _account?: AccountSelector,
    beginDate?: string,
    endDate?: string,
) {
    return adapter.fetchProfitLoss(accountType, beginDate, endDate);
}

export function fetchProfitLossSummary(
    accountType?: AccountTypeName,
    _account?: AccountSelector,
    beginDate?: string,
    endDate?: string,
) {
    return adapter.fetchProfitLossSummary(accountType, beginDate, endDate);
}

export function fetchTradingLimits(_account?: AccountSelector) {
    return adapter.fetchTradingLimits();
}

export function fetchStockReserveSummary(_account?: AccountSelector) {
    return adapter.fetchStockReserveSummary();
}

export function fetchStockReserveDetail(_account?: AccountSelector) {
    return adapter.fetchStockReserveDetail();
}

export function fetchEarmarkingDetail(_account?: AccountSelector) {
    return adapter.fetchEarmarkingDetail();
}

export function placeComboOrder(
    _legs?: ComboLeg[],
    _order?: ComboOrderReq,
) {
    return adapter.placeComboOrder();
}

export function cancelComboOrder(_tradeId?: string) {
    return adapter.cancelComboOrder();
}

export type EnrichedIndexCapability =
    | 'calculated_index'
    | 'index_contribution'
    | 'industry_contribution';
