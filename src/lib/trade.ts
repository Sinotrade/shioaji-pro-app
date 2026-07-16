// src/lib/trade.ts — one-shot order helper + in-app notification channel

import { trackActivity } from './activity';
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
    opts?: {
        bypassRisk?: boolean;
        orderLot?: StockOrderLot;
        daytradeShort?: boolean;
    },
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
    return sendOrder(
        contract,
        action,
        price,
        quantity,
        market,
        opts?.orderLot,
        opts?.daytradeShort,
    );
}

async function sendOrder(
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    market: boolean,
    orderLot?: StockOrderLot,
    daytradeShort?: boolean,
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
              ...(daytradeShort ? { daytrade_short: true } : {}),
          });
    return trade;
}

// close/flip a stock position counted in SHARES: whole lots go out as a
// market Common order (張); the odd remainder as an IntradayOdd LIMIT at
// the price limit (盤中零股 only accepts LMT — the limit price acts as a
// marketable order)
// ydShares＝昨日庫存股數（Position.yd_quantity）。賣出超過昨日庫存的部分是
// 今日買進 — 集保 T+2 還沒入帳，普通現股賣出會被「集保賣出餘股數不足」退件
// （2026-07-16 6244 平倉事件），超出的整張改掛現股當沖賣（daytrade_short）。
// 盤中零股不可現沖，今日買進的零股賣不掉 — 先把原因說清楚而不是送必死單。
export async function placeStockExitByShares(
    contract: ContractBase & { limit_up?: number; limit_down?: number },
    action: Action,
    shares: number,
    ydShares?: number,
): Promise<Trade[]> {
    assertTradingLive();
    const yd =
        action === 'Sell' && ydShares !== undefined
            ? ydShares
            : Number.POSITIVE_INFINITY;
    const dtShares = Math.max(0, shares - yd);
    if (dtShares % 1000 > 0) {
        throw new Error(
            '今日買進含零股 — 盤中零股不可現股當沖賣出，零股請留倉隔日再賣',
        );
    }
    const dtLots = dtShares / 1000;
    const plainShares = shares - dtShares;
    const lots = Math.floor(plainShares / 1000);
    const odd = plainShares % 1000;
    const out: Trade[] = [];
    if (lots > 0) {
        out.push(await placeQuickOrder(contract, action, null, lots));
    }
    if (dtLots > 0) {
        out.push(
            await placeQuickOrder(contract, action, null, dtLots, {
                daytradeShort: true,
            }),
        );
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

// 送單後追蹤到終態。模擬盤常「已送出（Submitted）」後才非同步補終態，退件
// （例如集保餘股不足）時 SSE 事件未必會來 — 送出成功的綠色 toast 會讓人以為
// 平倉完成，其實單子死了沒人講（2026-07-16 6244 平倉事件）。輪詢 30 秒兜底：
// 全成交 → ok、有退件 → err 附退件原因、逾時仍掛著 → 提示去委託分頁看。
export async function watchTradesToTerminal(
    accountType: 'S' | 'F',
    placed: Trade[],
    label: string,
): Promise<void> {
    const ids = new Set(placed.map((t) => t.order.id));
    if (ids.size === 0) return;
    const TERMINAL = new Set(['Filled', 'Failed', 'Cancelled']);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        let mine: Trade[];
        try {
            mine = (await fetchTrades(accountType)).filter((t) =>
                ids.has(t.order.id),
            );
        } catch {
            continue; // transient — keep polling until the deadline
        }
        if (mine.length !== ids.size) continue;
        if (!mine.every((t) => TERMINAL.has(t.status.status))) continue;
        const failed = mine.filter((t) => t.status.status === 'Failed');
        const dealt = mine.reduce((s, t) => s + t.status.deal_quantity, 0);
        if (failed.length > 0) {
            notify({
                kind: 'err',
                title: `❌ ${label} 委託被退件`,
                body: failed
                    .map((t) => t.status.msg || 'Failed（無退件原因）')
                    .join('；'),
            });
        } else if (dealt === 0) {
            notify({ kind: 'info', title: `${label} 已取消（未成交）`, body: '' });
        } else {
            notify({ kind: 'ok', title: `✅ ${label} 成交`, body: '' });
        }
        return;
    }
    notify({
        kind: 'info',
        title: `⏳ ${label} 逾 30 秒未有結果`,
        body: '委託仍掛著（模擬盤撮合可能延遲）— 到「委託」分頁確認或刪單',
    });
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
