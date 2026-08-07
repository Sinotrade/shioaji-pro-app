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
    direction: 'Buy' | 'Sell';
    quantity: number;
    price: number;
    last_price: number;
    pnl: number;
    yd_quantity: number;
    cond?: string;
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
    acc_balance: number;
    date: string;
    errmsg: string;
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
