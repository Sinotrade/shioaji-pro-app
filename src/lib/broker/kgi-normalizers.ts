// src/lib/broker/kgi-normalizers.ts

import type { ContractInfo, SecurityType } from '../types/contract';
import type { KBars, Snapshot, SseBidAsk, SseTick } from '../types/market';
import type { Trade } from '../types/order';
import type { Account, Position } from '../types/portfolio';

type UnknownRecord = Record<string, unknown>;

export interface KgiSnapshotRaw extends UnknownRecord {
    exchange?: string;
    datetime?: string;
    price?: number;
    volume?: number;
    total_volume?: number;
    open_price?: number;
    bid_price?: number;
    ask_price?: number;
    bid_volume?: number;
    ask_volume?: number;
    high_price?: number;
    low_price?: number;
    limit_up?: number;
    limit_down?: number;
    reference_price?: number;
}

export interface KgiTickRaw extends UnknownRecord {
    exchange?: string;
    symbol?: string;
    datetime?: string;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    total_volume?: number;
    chg_type?: number;
    price_chg?: number;
    pct_chg?: number;
    simtrade?: number | boolean;
    amount?: number;
}

export interface KgiBidAskRaw extends UnknownRecord {
    exchange?: string;
    symbol?: string;
    datetime?: string;
    bid_prices?: number[];
    bid_volumes?: number[];
    ask_prices?: number[];
    ask_volumes?: number[];
    diff_bid_vol?: number[];
    diff_ask_vol?: number[];
    simtrade?: number | boolean;
}

export interface KgiKbarRaw extends UnknownRecord {
    exchange?: string;
    symbol?: string;
    datetime?: string;
    timeframe?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    total_amount?: number;
}

function num(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function boolish(value: unknown): boolean {
    return value === true || value === 1 || value === '1';
}

function compactDateTime(value: unknown): { date: string; time: string } {
    const raw = String(value ?? '');
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 14) {
        return {
            date: `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`,
            time: `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`,
        };
    }
    if (digits.length >= 12) {
        return {
            date: `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`,
            time: `${digits.slice(8, 10)}:${digits.slice(10, 12)}:00`,
        };
    }
    return { date: '', time: '' };
}

function exchangeFromKgi(value: unknown): ContractInfo['exchange'] {
    const raw = String(value ?? '').toUpperCase();
    if (raw === 'TWSE' || raw === 'TSE') return 'TSE';
    if (raw === 'TPEx'.toUpperCase() || raw === 'OTC') return 'OTC';
    if (raw === 'TAIFEX') return 'TAIFEX';
    return 'TSE';
}

export function normalizeKgiSnapshot(
    symbol: string,
    raw: KgiSnapshotRaw,
): Snapshot {
    const close = num(raw.price);
    const reference = num(raw.reference_price, close);
    const change = close - reference;
    return {
        code: symbol,
        exchange: exchangeFromKgi(raw.exchange) ?? '',
        datetime: String(raw.datetime ?? ''),
        open: num(raw.open_price, close),
        high: num(raw.high_price, close),
        low: num(raw.low_price, close),
        close,
        average_price: close,
        buy_price: num(raw.bid_price),
        buy_volume: num(raw.bid_volume),
        sell_price: num(raw.ask_price),
        sell_volume: num(raw.ask_volume),
        volume: num(raw.volume),
        total_volume: num(raw.total_volume),
        amount: close * num(raw.volume),
        total_amount: close * num(raw.total_volume),
        change_price: change,
        change_rate: reference ? (change / reference) * 100 : 0,
        change_type: change > 0 ? 'Up' : change < 0 ? 'Down' : 'Unchanged',
        // TODO(KGI): official tick/snapshot docs do not expose buy/sell tick
        // direction. Keep the frontend-neutral unknown value until real
        // payloads prove the mapping.
        tick_type: '0',
        volume_ratio: 0,
        yesterday_volume: 0,
    };
}

export function normalizeKgiTick(raw: KgiTickRaw): SseTick {
    const dt = compactDateTime(raw.datetime);
    return {
        code: String(raw.symbol ?? ''),
        date: dt.date,
        time: dt.time,
        open: String(num(raw.open)),
        high: String(num(raw.high)),
        low: String(num(raw.low)),
        close: String(num(raw.close)),
        volume: num(raw.volume),
        total_volume: num(raw.total_volume),
        amount: String(num(raw.amount)),
        total_amount: String(num(raw.close) * num(raw.total_volume)),
        // TODO(KGI): docs list chg_type but no documented trade direction
        // field. Keep unknown rather than inventing a mapping.
        tick_type: 0,
        chg_type: raw.chg_type,
        price_chg:
            raw.price_chg === undefined ? undefined : String(num(raw.price_chg)),
        pct_chg: raw.pct_chg === undefined ? undefined : String(num(raw.pct_chg)),
        intraday_odd: boolish(raw.odd_lot),
        simtrade: boolish(raw.simtrade),
    };
}

export function normalizeKgiBidAsk(raw: KgiBidAskRaw): SseBidAsk {
    const dt = compactDateTime(raw.datetime);
    return {
        code: String(raw.symbol ?? ''),
        date: dt.date,
        time: dt.time,
        bid_price: (raw.bid_prices ?? []).map((price) => String(price)),
        bid_volume: (raw.bid_volumes ?? []).map((volume) => num(volume)),
        ask_price: (raw.ask_prices ?? []).map((price) => String(price)),
        ask_volume: (raw.ask_volumes ?? []).map((volume) => num(volume)),
        diff_bid_vol: raw.diff_bid_vol?.map((volume) => num(volume)),
        diff_ask_vol: raw.diff_ask_vol?.map((volume) => num(volume)),
        intraday_odd: boolish(raw.odd_lot),
        simtrade: boolish(raw.simtrade),
    };
}

export function normalizeKgiKbars(rows: KgiKbarRaw[]): KBars {
    return {
        datetime: rows.map((row) => String(row.datetime ?? '')),
        Open: rows.map((row) => num(row.open)),
        High: rows.map((row) => num(row.high)),
        Low: rows.map((row) => num(row.low)),
        Close: rows.map((row) => num(row.close)),
        Volume: rows.map((row) => num(row.volume)),
        Amount: rows.map((row) => num(row.total_amount)),
    };
}

export function normalizeKgiAccount(raw: UnknownRecord): Account {
    const flag = String(raw.account_flag ?? '');
    const accountType = flag.includes('期') ? 'F' : 'S';
    return {
        account_type: accountType,
        person_id: String(raw.person_id ?? ''),
        broker_id: String(raw.broker_id ?? 'KGI'),
        account_id: String(raw.account ?? raw.account_id ?? ''),
        // TODO(KGI): show_account() does not document API agreement status.
        // Treat listed accounts as selectable in mock/read-only mode, and
        // revisit after real KGI account testing.
        signed: raw.signed === undefined ? true : Boolean(raw.signed),
        username: String(raw.username ?? 'KGI User'),
    };
}

export function normalizeKgiContract(raw: UnknownRecord): ContractInfo {
    const code = String(raw.symbol ?? raw.code ?? '');
    const securityType = (raw.security_type ?? 'STK') as SecurityType;
    return {
        region: 'TW',
        exchange: exchangeFromKgi(raw.market ?? raw.exchange),
        code,
        security_type: securityType,
        target_code: (raw.target_code as string | null | undefined) ?? null,
        name: String(raw.name ?? code),
        currency: 'TWD',
        limit_up: num(raw.bull_limit ?? raw.limit_up),
        limit_down: num(raw.bear_limit ?? raw.limit_down),
        reference: num(raw.ref_price ?? raw.reference),
        day_trade: String(raw.day_trade ?? '') as ContractInfo['day_trade'],
        update_date: String(raw.update_date ?? ''),
        category: String(raw.category ?? ''),
        margin_trading_balance: 0,
        short_selling_balance: 0,
        root: raw.root === undefined ? undefined : String(raw.root),
        underlying_code:
            raw.underlying_code === undefined
                ? undefined
                : String(raw.underlying_code),
        delivery_month:
            raw.delivery_month === undefined
                ? undefined
                : String(raw.delivery_month),
    };
}

export function normalizeKgiPosition(
    code: string,
    raw: UnknownRecord,
): Position | null {
    const td = Array.isArray(raw.quantity_td) ? raw.quantity_td.map(num) : [];
    const yd = Array.isArray(raw.quantity_yd) ? raw.quantity_yd.map(num) : [];
    const prices = Array.isArray(raw.dealPrice_cash)
        ? raw.dealPrice_cash.map(num)
        : [];
    const quantity = td.reduce((sum, value) => sum + value, 0);
    if (!quantity) return null;
    return {
        id: Math.abs([...code].reduce((sum, char) => sum + char.charCodeAt(0), 0)),
        code,
        direction: quantity >= 0 ? 'Buy' : 'Sell',
        quantity: Math.abs(quantity),
        price: prices.find((price) => price > 0) ?? 0,
        last_price: num(raw.lastprice),
        pnl: num(raw.unrealized),
        yd_quantity: yd.reduce((sum, value) => sum + value, 0),
    };
}

export function normalizeKgiTrade(
    id: string,
    raw: UnknownRecord,
    contract: ContractInfo,
): Trade {
    const order = (raw.order as UnknownRecord | undefined) ?? raw;
    const status = (raw.order_status as UnknownRecord | undefined) ?? {};
    const actionText = String(order.action ?? '').toLowerCase();
    const action = actionText.includes('sell') || actionText.includes("'S'")
        ? 'Sell'
        : 'Buy';
    const statusText = String(status.status ?? 'Submitted');
    return {
        contract,
        order: {
            id,
            seqno: String(status.nid ?? ''),
            ordno: String(order.order_id ?? id),
            action,
            price: num(order.price),
            quantity: num(order.quantity),
            order_type: String(order.time_in_force ?? '').includes('IOC')
                ? 'IOC'
                : 'ROD',
            price_type: String(order.price_type ?? ''),
            order_lot: String(order.odd_lot ?? ''),
        },
        status: {
            id: String(status.nid ?? id),
            status: statusText.includes('Filled')
                ? 'Filled'
                : statusText.includes('Cancel')
                  ? 'Cancelled'
                  : 'Submitted',
            status_code: statusText,
            order_quantity: num(order.quantity),
            deal_quantity: 0,
            cancel_quantity: 0,
            modified_price: num(status.modified_price ?? order.price),
            msg: '',
            deals: [],
        },
    };
}
