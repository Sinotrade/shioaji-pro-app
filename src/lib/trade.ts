// src/lib/trade.ts — one-shot order helper + in-app notification channel

import { trackActivity } from './agent/activity';
import { checkOrderAllowed } from './risk';
import {
    cancelOrder,
    fetchTrades,
    placeFuturesOrder,
    placeStockOrder,
} from './shioaji';
import { getStreamStatus } from './stream';
import type { ContractBase } from './types/contract';
import {
    ACTIVE_ORDER_STATUSES,
    type Action,
    type StockOrderLot,
    type Trade,
} from './types/order';

export interface AppNotice {
    kind: 'ok' | 'err' | 'info';
    title: string;
    body: string;
}

const noticeListeners = new Set<(n: AppNotice) => void>();

export function onNotice(listener: (n: AppNotice) => void) {
    noticeListeners.add(listener);
    return () => {
        noticeListeners.delete(listener);
    };
}

// ---- persistent notice log (通知中心) ----

export interface LoggedNotice extends AppNotice {
    ts: number;
}

const LOG_LIMIT = 200;
let noticeLog: LoggedNotice[] = [];
const logListeners = new Set<() => void>();

// record without raising a toast (order events already toast elsewhere)
export function logNotice(n: AppNotice) {
    noticeLog = [...noticeLog.slice(-(LOG_LIMIT - 1)), { ...n, ts: Date.now() }];
    logListeners.forEach((l) => l());
}

export function subscribeNoticeLog(listener: () => void) {
    logListeners.add(listener);
    return () => {
        logListeners.delete(listener);
    };
}

export function getNoticeLog(): LoggedNotice[] {
    return noticeLog;
}

export function clearNoticeLog() {
    noticeLog = [];
    logListeners.forEach((l) => l());
}

export function notify(n: AppNotice) {
    logNotice(n);
    noticeListeners.forEach((l) => l(n));
}

export function isFuturesContract(contract: ContractBase): boolean {
    return (
        contract.security_type === 'FUT' || contract.security_type === 'OPT'
    );
}

// price === null → market order (futures MKT/IOC, stocks MKT/IOC)
// hard safety net: never let an order through while the quote feed is not
// LIVE — a dead/reconnecting connection silently drops orders, and users
// (esp. with real money on the line) must not think a click went through
// when it didn't (issue #2). UI also disables the buttons; this backs it up.
export function assertTradingLive() {
    if (getStreamStatus() !== 'live') {
        throw new Error('行情未連線（非 LIVE）— 為避免誤單已暫停下單，請待連線恢復');
    }
}

export async function placeQuickOrder(
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    opts?: { bypassRisk?: boolean; orderLot?: StockOrderLot },
): Promise<Trade> {
    assertTradingLive();
    if (!opts?.bypassRisk) {
        const blocked = checkOrderAllowed(quantity);
        if (blocked) throw new Error(blocked);
    }
    trackActivity(
        '下單',
        `${contract.code} ${action === 'Buy' ? '買' : '賣'} ${quantity} @${price ?? '市價'}`,
    );
    const market = price === null;
    return sendOrder(contract, action, price, quantity, market, opts?.orderLot);
}

async function sendOrder(
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    market: boolean,
    orderLot?: StockOrderLot,
): Promise<Trade> {
    const trade = isFuturesContract(contract)
        ? await placeFuturesOrder(contract, {
              action,
              price: price ?? 0,
              quantity,
              price_type: market ? 'MKT' : 'LMT',
              order_type: market ? 'IOC' : 'ROD',
              octype: 'Auto',
          })
        : await placeStockOrder(contract, {
              action,
              price: price ?? 0,
              quantity,
              price_type: market ? 'MKT' : 'LMT',
              order_type: market ? 'IOC' : 'ROD',
              order_lot: orderLot ?? 'Common',
          });
    return trade;
}

// close/flip a stock position counted in SHARES: whole lots go out as a
// market Common order (張); the odd remainder as an IntradayOdd LIMIT at
// the price limit (盤中零股 only accepts LMT — the limit price acts as a
// marketable order)
export async function placeStockExitByShares(
    contract: ContractBase & { limit_up?: number; limit_down?: number },
    action: Action,
    shares: number,
): Promise<Trade[]> {
    assertTradingLive();
    const lots = Math.floor(shares / 1000);
    const odd = shares % 1000;
    const out: Trade[] = [];
    if (lots > 0) {
        out.push(await placeQuickOrder(contract, action, null, lots));
    }
    if (odd > 0) {
        const limitPrice =
            action === 'Sell' ? contract.limit_down : contract.limit_up;
        if (!limitPrice) {
            throw new Error('零股需要漲跌停價作為限價，無法取得');
        }
        out.push(
            await placeQuickOrder(contract, action, limitPrice, odd, {
                orderLot: 'IntradayOdd',
            }),
        );
    }
    return out;
}

// cancel every working order across stock + futures accounts
export async function cancelAllOrders(): Promise<number> {
    trackActivity('全刪委託');
    const [st, fu] = await Promise.allSettled([
        fetchTrades('S'),
        fetchTrades('F'),
    ]);
    const all: Trade[] = [
        ...(st.status === 'fulfilled' ? st.value : []),
        ...(fu.status === 'fulfilled' ? fu.value : []),
    ];
    const working = all.filter((t) =>
        ACTIVE_ORDER_STATUSES.has(t.status.status),
    );
    const results = await Promise.allSettled(
        working.map((t) => cancelOrder(t.order.id)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    notify({
        kind: ok === working.length ? 'ok' : 'err',
        title: '🚨 全部刪單',
        body: `已送出 ${ok}/${working.length} 筆刪單`,
    });
    return ok;
}
