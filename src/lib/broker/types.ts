// src/lib/broker/types.ts

import type { ContractBase, ContractInfo, SecurityType } from '../types/contract';
import type { Health } from '../types/health';
import type {
    KBars,
    QuoteTypeName,
    ScannerItem,
    ScannerType,
    Snapshot,
    SubscriptionResponse,
} from '../types/market';
import type { Deal, Trade } from '../types/order';
import type {
    Account,
    AccountBalance,
    AccountTypeName,
    FuturePosition,
    Margin,
    StockPosition,
} from '../types/portfolio';

export interface BrokerInfo {
    name: string;
    version: string;
    description: string;
    protocols: string[];
    simulation: boolean;
}

export interface BrokerContractsQueryResponse {
    // The bulk /api/v1/data/contracts response actually carries the full
    // normalized contract row (name, category, limit_up/down, reference,
    // ...) — the same normalize_contract() shape used for single-contract
    // lookups, not just the bare ContractBase identity fields. Typing it
    // as ContractInfo lets catalog consumers (e.g. stock-index.ts) read
    // name/category straight off this one bulk call instead of re-fetching
    // per symbol.
    contracts: ContractInfo[];
    security_type: Exclude<SecurityType, null>;
    region: string;
    total: number;
    page?: number;
    page_size?: number;
    max_page?: number;
}

export interface BrokerContractRoot {
    root: string;
    name: string;
}

export interface BrokerWarrantUnderlying {
    underlying_code: string;
    name?: string | null;
    warrant_count?: number;
}

export interface BrokerSettlement {
    date: string;
    amount: number | null;
    T: number;
}

export interface BrokerAccountSelector {
    broker_id: string;
    account_id: string;
}

export interface BrokerTradingLimits {
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

export interface BrokerWatchlist {
    id: string;
    name: string;
    contracts: { security_type: SecurityType; exchange: string; code: string }[];
}

export type DealsBySymbol = Record<string, Deal[]>;

export interface StockProfitLoss {
    id: number;
    code: string;
    name?: string;
    quantity: number;
    quantity_unit?: 'shares';
    pnl: number;
    date: string;
    trade_date?: string;
    dseq: string;
    price: number;
    cost?: number;
    fee?: number;
    tax?: number;
    pr_ratio: number;
    cond: string;
    descript?: string;
    seqno: string;
    // KGI RealizePL's BS (buy/sell) field, when present — '' when the
    // upstream row didn't carry a recognizable direction.
    direction?: 'Buy' | 'Sell' | '';
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

export interface ReserveStockSummaryRow {
    contract: ContractBase;
    available_share: number;
    reserved_share: number;
}

export interface ReserveStocksSummary {
    stocks: ReserveStockSummaryRow[];
    account: Account;
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

export interface BrokerAdapter {
    readonly id: 'kgi';
    readonly mock: boolean;
    fetchHealth(): Promise<Health>;
    fetchInfo(): Promise<BrokerInfo>;
    fetchAccounts(): Promise<Account[]>;
    fetchContracts(
        securityType: Exclude<SecurityType, null>,
        page?: number,
        pageSize?: number,
    ): Promise<BrokerContractsQueryResponse>;
    fetchContractBase(
        code: string,
        securityType?: SecurityType,
    ): Promise<ContractBase>;
    fetchContractInfo(
        code: string,
        securityType?: SecurityType,
    ): Promise<ContractInfo>;
    fetchSnapshots(contracts: ContractBase[]): Promise<Snapshot[]>;
    fetchKbars(
        contract: ContractBase,
        start: string,
        end: string,
        minute?: number,
    ): Promise<KBars>;
    fetchHistoryTicks(
        contract: ContractBase,
        date: string,
    ): Promise<import('../types/tick').HistoryTicks>;
    fetchLastTicks(
        contract: ContractBase,
        count: number,
        date: string,
    ): Promise<import('../types/tick').HistoryTicks>;
    subscribeQuote(
        contract: ContractBase,
        quoteType: QuoteTypeName,
    ): Promise<SubscriptionResponse>;
    unsubscribeQuote(
        contract: ContractBase,
        quoteType: QuoteTypeName,
    ): Promise<SubscriptionResponse>;
    fetchTrades(accountType: AccountTypeName): Promise<Trade[]>;
    fetchDeals(accountType?: AccountTypeName): Promise<DealsBySymbol>;
    fetchPositions(
        accountType: AccountTypeName,
    ): Promise<(StockPosition | FuturePosition)[]>;
    fetchAccountBalance(): Promise<AccountBalance>;
    fetchMargin(): Promise<Margin>;
    fetchScanner(
        scannerType: ScannerType,
        count: number,
        ascending: boolean,
    ): Promise<ScannerItem[]>;
}
