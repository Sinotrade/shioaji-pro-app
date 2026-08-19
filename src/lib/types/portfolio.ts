// src/lib/types/portfolio.ts — account/position shapes

export type AccountTypeName = 'S' | 'F';

export interface Account {
    account_type: string;
    person_id: string;
    broker_id: string;
    account_id: string;
    signed: boolean;
    username: string;
}

export interface StockPosition {
    id: number;
    code: string;
    name?: string;
    direction: 'Buy' | 'Sell';
    // Canonical stock unit from the KGI bridge is shares. UI formatters may
    // display whole lots as 張 and odd-lot remainders as 股.
    quantity: number;
    quantity_unit?: 'shares';
    price: number;
    last_price: number;
    market_value?: number | null;
    pnl: number;
    pnl_pct?: number | null;
    yd_quantity: number;
    cond?: string;
    position_type?: 'cash' | 'margin' | 'short' | 'lending';
    position_type_label?: string;
    // Shares within `quantity` that came from odd-lot (零股) executions.
    // Odd-lot holdings settle into the same cash bucket as round lots in
    // Taiwan, so this is a breakdown of the cash row, not a separate
    // position — do not add it to `quantity`.
    odd_lot_quantity?: number;
}

export interface FuturePosition {
    id: number;
    code: string;
    direction: 'Buy' | 'Sell';
    quantity: number;
    price: number;
    last_price: number;
    pnl: number;
}

export type Position = StockPosition | FuturePosition;

// position_unit 回應不含帳戶欄位 — 多帳戶合併查詢時由呼叫端標上來源帳戶，
// dock 分帳戶檢視／帳戶範圍篩選都靠這個 tag
export type AccountedPosition = Position & { account?: Account };

export interface AccountBalance {
    // Today's settlement TRIAL net amount (KGI Account.SettleAmtTrial) —
    // real when KGI has something to trial-settle today, null when it
    // doesn't (most days). This is NOT a running cash balance; see
    // bank_balance below for why no such balance exists in this SDK.
    acc_balance: number | null;
    available_balance?: number | null;
    // KGI's Account API (kgisuperpy 2.1.0) has no linked bank-account
    // balance field anywhere — verified by calling every method main.py
    // wires onto api.Account. Always null; kept as an explicit field so
    // the UI can render "API 未提供" from a real backend fact instead of
    // a frontend assumption.
    bank_balance?: number | null;
    buying_power?: number | null;
    total_assets?: number | null;
    stock_market_value?: number | null;
    realized_pnl?: number | null;
    date: string;
    errmsg: string;
    raw_fields?: Record<string, string[]> | string[];
    unavailable_fields?: string[];
}

export interface Margin {
    yesterday_balance: number;
    today_balance: number;
    deposit_withdrawal: number;
    fee: number;
    tax: number;
    initial_margin: number;
    maintenance_margin: number;
    margin_call: number;
    risk_indicator: number;
    royalty_revenue_expenditure: number;
    equity: number;
    equity_amount: number;
    option_openbuy_market_value: number;
    option_opensell_market_value: number;
    option_open_position: number;
    option_settle_profitloss: number;
    future_open_position: number;
    today_future_open_position: number;
    future_settle_profitloss: number;
    available_margin: number;
    plus_margin: number;
    plus_margin_indicator: number;
    security_collateral_amount: number;
    order_margin_premium: number;
    collateral_amount: number;
}
