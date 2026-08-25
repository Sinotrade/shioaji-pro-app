// src/lib/types/contract.ts

export type Region = 'TW' | 'US' | 'HK' | 'JP';
export type Exchange = 'TSE' | 'OTC' | 'OES' | 'TAIFEX' | null;
export type SecurityType = 'IND' | 'STK' | 'FUT' | 'OPT' | 'WRT' | null;
export type Currency = 'TWD' | 'USD' | 'CNY';
export type DayTrade = 'Yes' | 'OnlyBuy' | 'No' | '';

export interface ContractBase {
    region?: Region;
    exchange: Exchange;
    code: string;
    security_type: SecurityType;
    target_code: string | null;
}

// managed 組合商品（跨月價差等）的行情身分：行情 API（訂閱/快照/
// ticks/kbars）需以腳陣列呼叫，一般合約沒有此欄位。code（如
// TXFI6/J6）同時是 SSE 事件的身分。
export interface ContractComboMeta {
    code: string;
    legs: {
        security_type: SecurityType;
        region: string;
        exchange: string | null;
        code: string;
        target_code: string | null;
    }[];
    combo_type: string;
}

export interface Contract extends ContractBase {
    name: string;
    currency: Currency;
}

export interface ContractInfo extends Contract {
    limit_up: number;
    limit_down: number;
    reference: number;
    day_trade: DayTrade;
    update_date: string;
    category: string;
    margin_trading_balance: number;
    short_selling_balance: number;
    // futures/options: contract multiplier from the API (e.g. TXF 200,
    // stock futures 2000); options carry strike/right for payoff math
    multiplier?: number;
    contract_size?: number;
    size_unit?: string;
    strike_price?: number;
    option_right?: string;
    delivery_month?: string;
    delivery_date?: string;
    last_trading_date?: string;
    root?: string;
    underlying_code?: string;
    // 'I' index, 'S' stock, 'E' FX, 'C' commodity (TAIFEX 1.7 metadata)
    underlying_kind?: string;
    spec_kind?: string;
    tick_rule?: string;
    tick?: number;
    tick_value?: number;
    call_put?: string;
    expiry_date?: string;
    exercise_ratio?: number;
    listing_date?: string;
    issue_size?: number;
    financial?: string;
    // 組合商品的合成合約（見 ContractComboMeta）— 有此欄位的合約
    // 走組合行情路徑，且不可用一般下單面板下單
    combo?: ContractComboMeta;
}
