// src/lib/types/market.ts — market data shapes (REST + SSE)

// REST /api/v1/data/snapshots — prices are JSON numbers
export interface Snapshot {
    code: string;
    exchange: string;
    datetime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    average_price: number;
    buy_price: number;
    buy_volume: number;
    sell_price: number;
    sell_volume: number;
    volume: number;
    total_volume: number;
    amount: number;
    total_amount: number;
    change_price: number;
    change_rate: number;
    change_type: string;
    tick_type: string;
    volume_ratio: number;
    yesterday_volume: number;
}

// REST /api/v1/data/kbars — column arrays
export interface KBars {
    datetime: string[];
    Open: number[];
    High: number[];
    Low: number[];
    Close: number[];
    Volume: number[];
    Amount: number[];
    capability?: {
        historical?: 'ok' | 'denied' | 'unavailable';
        live?: 'available' | 'pending' | 'unavailable';
        message?: string;
        upstream_code?: string | null;
    };
}

export interface Candle {
    time: number; // unix seconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface CalculatedIndexEvent {
    code: string;
    date: string;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    total_amount: number;
    price_chg: number;
    pct_chg: number;
    simtrade: boolean;
}

export type ContributionRanking =
    'top10' | 'abs10' | 'positive25' | 'negative25';

export interface IndexContributionEntry {
    code: string;
    price: number;
    reference: number;
    price_chg: number;
    pct_chg: number;
    points: number;
}

export interface IndexContributionEvent {
    ranking: ContributionRanking;
    code: string;
    date: string;
    time: string;
    entries: IndexContributionEntry[];
    simtrade: boolean;
}

export interface IndustryContributionEntry {
    category: string;
    points: number;
}

export interface IndustryContributionEvent {
    code: string;
    date: string;
    time: string;
    entries: IndustryContributionEntry[];
    simtrade: boolean;
    index_close: number;
    index_price_chg: number;
}

export type ScannerRule =
    | 'bid_near_limit_up'
    | 'bid_touch_limit_up'
    | 'limit_up_unlocked'
    | 'ask_near_limit_down'
    | 'ask_touch_limit_down'
    | 'limit_down_unlocked'
    | 'trade_price_surge'
    | 'trade_price_drop'
    | 'bid_price_surge'
    | 'ask_price_drop'
    | 'volume_burst'
    | 'simtrade'
    | 'suspend';

export type ScannerExchange = 'TSE' | 'OTC';

export interface ScannerQuote {
    code: string;
    date: string;
    time: string;
    open?: string;
    high?: string;
    low?: string;
    close?: string;
    amount_sum?: string;
    vol_sum?: number;
    diff_price?: string;
    simtrade?: boolean;
}

export type ScannerExtra = Record<string, string | number | null | undefined>;

export interface ScannerSignalEvent {
    scanner: ScannerRule;
    region: 'TW';
    security_type: 'STK';
    exchange: ScannerExchange;
    quote: ScannerQuote;
    extra: ScannerExtra;
    received_at: number;
}

export interface ScannerGapEvent {
    dropped_count: number;
    first_time: string;
    last_time: string;
    subscriptions: unknown[];
    received_at: number;
}

// REST /api/v1/data/scanner
export interface ScannerItem {
    code: string;
    name: string;
    date: string;
    close: number;
    open: number;
    high: number;
    low: number;
    change_price: number;
    change_rate?: number;
    change_type: number;
    average_price: number;
    price_range: number;
    rank_value: number;
    total_volume: number;
    total_amount: number;
    volume_ratio: number;
    yesterday_volume: number;
    tick_type: number;
    buy_price: number;
    sell_price: number;
}

export type ScannerType =
    | 'ChangePercentRank'
    | 'ChangePriceRank'
    | 'DayRangeRank'
    | 'VolumeRank'
    | 'AmountRank'
    | 'TickCountRank';

// SSE tick events (tick_stk / tick_fop) — Decimal fields arrive as strings
export interface SseTick {
    code: string;
    date: string;
    time: string;
    open: string;
    high: string;
    low: string;
    close: string;
    avg_price?: string;
    volume: number;
    total_volume: number;
    amount?: string;
    total_amount?: string;
    tick_type: number; // 1=buy 2=sell 0=unknown
    chg_type?: number;
    price_chg?: string;
    pct_chg?: string;
    bid_side_total_vol?: number;
    ask_side_total_vol?: number;
    underlying_price?: string;
    intraday_odd?: boolean;
    simtrade?: boolean;
}

// SSE bidask events (bidask_stk / bidask_fop)
export interface SseBidAsk {
    code: string;
    date: string;
    time: string;
    bid_price: string[];
    bid_volume: number[];
    ask_price: string[];
    ask_volume: number[];
    diff_bid_vol?: number[];
    diff_ask_vol?: number[];
    intraday_odd?: boolean;
    simtrade?: boolean;
}

// SSE kbar events (kbar)
export interface SseKBar {
    code: string;
    date: string;
    time: string;
    timeframe: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: number;
    total_amount?: string;
}

// Normalized SSE index quote event. stream.ts converts upstream payloads into
// this lower-case frontend shape.
// Only standard price fields are guaranteed for every exchange index.
export interface SseIndexQuote {
    code: string;
    exchange: string;
    date: string;
    time: string;
    datetime?: string;
    reference: string;
    change_price?: string;
    change_rate?: string;
    open: string;
    high: string;
    low: string;
    close: string;
    amount_sum?: string;
    amount?: string;
    volume?: number;
    vol_sum?: number;
    count?: number;
    count_sum?: number;
    no_trade?: number;
    limit_up_count?: number;
    raise_count?: number;
    flat_count?: number;
    fall_count?: number;
    limit_down_count?: number;
    estimate_amount_sum?: string;
}

export type QuoteTypeName = 'Tick' | 'BidAsk' | 'Quote';

export interface SubscriptionResponse {
    success: boolean;
    message?: string;
    subscription?: unknown;
}
