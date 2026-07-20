// src/lib/trade.ts — one-shot order helper + in-app notification channel

import { trackActivity } from './activity';
import {
    executeExitLegs,
    isTerminalTrade,
    type LegError,
    type PlacedLegs,
    planStockExitLegs,
    summarizeTerminalOutcomes,
    statusText,
    summarizeTimeout,
    tradeToOutcome,
    type TradeOutcome,
} from './exit-plan';
import { checkOrderAllowed } from './risk';
import {
    cancelOrder,
    fetchTrades,
    placeFuturesOrder,
    placeStockOrder,
} from './shioaji';
import { getStreamStatus } from './stream';
import type { ContractBase, DayTrade } from './types/contract';
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
// market Common order (張); today-bought lots as daytrade_short (集保 T+2
// 未入帳); the odd remainder as an IntradayOdd LIMIT at the price limit.
// 拆腿與驗證邏輯在 exit-plan.ts（純函式）— 所有前置驗證都在送出任何一腿之前
// 完成，送不出去的腿具名跳過（不 throw、也不擋住送得出去的腿）；開始送單後
// 逐腿 catch。已送出與沒送出的腿分開回傳，caller 必須對 placed 啟動
// watchTradesToTerminal、對 errors 明確告知哪一腿沒送出。
export async function placeStockExitByShares(
    contract: ContractBase & {
        limit_up?: number;
        limit_down?: number;
        day_trade?: DayTrade;
    },
    action: Action,
    opts: {
        closeShares: number;
        openShares: number;
        ydShares?: number;
        cond?: string;
    },
): Promise<PlacedLegs<Trade>> {
    assertTradingLive();
    const { legs, skipped } = planStockExitLegs({
        action,
        closeShares: opts.closeShares,
        openShares: opts.openShares,
        ydShares: opts.ydShares,
        cond: opts.cond,
        limits: contract,
    });
    const { placed, errors } = await executeExitLegs(legs, (leg) =>
        placeQuickOrder(contract, action, leg.price, leg.quantity, {
            orderLot: leg.orderLot,
            daytradeShort: leg.daytradeShort,
        }),
    );
    // 刻意跳過的腿與送出失敗的腿走同一條回報路徑 — 兩者都是「這一腿沒送出去」，
    // 終態彙總靠它們才不會把「只平了一半」講成「全部成交」
    return { placed, errors: [...skipped, ...errors] };
}

// 送單後追蹤到終態。模擬盤常「已送出（Submitted）」後才非同步補終態，退件
// （例如集保餘股不足）時 SSE 事件未必會來 — 送出成功的綠色 toast 會讓人以為
// 平倉完成，其實單子死了沒人講（2026-07-16 6244 平倉事件）。
// 終態判讀在 exit-plan.ts 的純函式：只有每腿 Filled 且足量、且沒有任何一腿在
// 送出階段就失敗（unsentLegs）才報成功；其餘一律紅色警示附各腿明細。
// unsentLegs 必須傳進來 —— 只把送出成功的腿餵進彙總，every() 會對縮小過的
// 集合成立而報出假的「全部成交」。
export async function watchTradesToTerminal(
    accountType: 'S' | 'F',
    placed: Trade[],
    label: string,
    unsentLegs: LegError[] = [],
): Promise<void> {
    const ids = new Set(placed.map((t) => t.order.id));
    if (ids.size === 0) {
        // 一腿都沒送出去也要講 — 靜默 return 會讓使用者只看到「傳送中」沒有下文
        if (unsentLegs.length > 0) {
            notify(summarizeTerminalOutcomes(label, [], unsentLegs));
        }
        return;
    }
    if (ids.size !== placed.length) {
        // 兩腿拿到同一個 order id → 會被縮成一腿判讀而誤報足量，寧可交人工
        notify({
            kind: 'err',
            title: `⚠️ ${label} 委託編號重複，無法逐腿對帳`,
            body: '請到「委託」分頁自行確認每筆委託與剩餘部位',
        });
        return;
    }
    const toOutcome = (t: Trade) => tradeToOutcome(t, accountType);
    // 盤中零股是 LMT+ROD、撮合有週期，30 秒往往還沒到終態；等太短會把同批
    // 整張腿的退件原因一起埋掉，只剩一則沒有資訊的逾時通知
    const hasOddLeg = placed.some((t) => t.order.order_lot === 'IntradayOdd');
    const deadline = Date.now() + (hasOddLeg ? 240_000 : 30_000);
    let lastKnown: TradeOutcome[] = [];
    const alerted = new Set<string>();
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
        lastKnown = mine.map(toOutcome);
        const done = mine.every(isTerminalTrade);
        if (!done) {
            // 有腿已經確定沒平到就先講，別讓它被還在撮合的零股腿壓到 4 分鐘後
            // 才出現。零成交的 Cancelled 也算（市價 IOC 遇薄簿很常見）；帶部分
            // 成交的取消留給最後的彙總講，這裡用退件語氣反而誤導
            for (const t of mine) {
                const o = toOutcome(t);
                const dead =
                    o.status === 'Failed' ||
                    o.status === 'Inactive' ||
                    (o.status === 'Cancelled' && o.dealQty === 0);
                if (!dead || alerted.has(t.order.id)) continue;
                alerted.add(t.order.id);
                notify({
                    kind: 'err',
                    title: `❌ ${label} 有一腿未成交`,
                    body: `${o.orderQty} ${o.unit}：${o.msg || statusText(o.status)} — 其餘腿仍在撮合，完整結果稍後通知`,
                });
            }
            continue;
        }
        notify(summarizeTerminalOutcomes(label, lastKnown, unsentLegs));
        return;
    }
    notify(summarizeTimeout(label, lastKnown, unsentLegs));
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
