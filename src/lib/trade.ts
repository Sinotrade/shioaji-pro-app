import { remainingWorkingOrderQuantity } from './working-order-quantity';
import { getApiBase } from './runtime';
import { cancellationSummary } from './trade-mutations';
// src/lib/trade.ts — one-shot order helper + in-app notification channel

import { getAccountState } from './account-store';
import { trackActivity } from './activity';
import { accountConfirmLabel, requestOrderConfirm } from './order-confirm';
import { checkOrderAllowed, getRiskSettings } from './risk';
import {
    cancelOrders,
    fetchTrades,
    placeFuturesOrder,
    placeStockOrder,
} from './shioaji';
import { getStreamStatus } from './stream';
import type { ContractBase, ContractInfo } from './types/contract';
import type { Account } from './types/portfolio';
import {
    type Action,
    type StockOrderLot,
    type FuturesOCType,
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

function mutationNotStartedError(message: string): Error & {
    mutationNotStarted: true;
} {
    return Object.assign(new Error(message), {
        mutationNotStarted: true as const,
    });
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
        throw mutationNotStartedError(
            '行情未連線（非 LIVE）— 為避免誤單已暫停下單，請待連線恢復',
        );
    }
}

// 手動下單確認被取消 — 呼叫端的錯誤通知會顯示這個訊息
export class OrderConfirmCancelled extends Error {
    constructor() {
        super('已取消下單');
        this.name = 'OrderConfirmCancelled';
    }
}

function orderUnit(contract: ContractBase, orderLot?: StockOrderLot): string {
    if (isFuturesContract(contract)) return '口';
    return orderLot === 'IntradayOdd' || orderLot === 'Odd' ? '股' : '張';
}

// 可視化委託確認（RiskSettings.confirmManualOrders opt-in）— 只攔手動
// 路徑；自動路徑（trigger-engine/bracket）觸發時使用者可能不在場，
// 彈窗＝錯過行情，一律 source:'auto' 跳過
async function confirmManualOrder(
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    orderLot?: StockOrderLot,
    note?: string,
    account?: Account,
): Promise<void> {
    if (!getRiskSettings().confirmManualOrders) return;
    const approved = await requestOrderConfirm({
        code: contract.code,
        name: (contract as Partial<ContractInfo>).name,
        action,
        price,
        quantity,
        unit: orderUnit(contract, orderLot),
        // the account the order is bound to, not whatever is selected now
        accountLabel: account ? accountConfirmLabel(account) : undefined,
        note,
    });
    if (!approved) throw new OrderConfirmCancelled();
}

export async function placeQuickOrder(
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    opts?: {
        bypassRisk?: boolean;
        orderLot?: StockOrderLot;
        account?: Account;
        ocType?: FuturesOCType;
        // 'auto' = 系統觸發（停損/停利等），永不彈手動確認
        source?: 'manual' | 'auto' | 'agent';
        agentCallId?: string;
        agentAuto?: boolean;
        // runs synchronously after confirmation and risk checks, right
        // before sending; throwing refuses the order (nothing is sent)
        beforeSend?: () => void;
    },
): Promise<Trade> {
    const startedBase = getApiBase();
    const capturedAccount = opts?.account ?? (isFuturesContract(contract) ? getAccountState().selectedFutures : getAccountState().selectedStock) ?? undefined;
    assertTradingLive();
    if (contract.security_type === 'IND') {
        throw mutationNotStartedError('指數商品僅提供行情，不可下單');
    }
    const expectedAccountType = isFuturesContract(contract) ? 'F' : 'S';
    if (!capturedAccount || !capturedAccount.signed || capturedAccount.account_type !== expectedAccountType
        || !getAccountState().accounts.some(a => a.signed && a.account_type === expectedAccountType
            && a.broker_id === capturedAccount.broker_id && a.account_id === capturedAccount.account_id)) {
        throw mutationNotStartedError('缺少有效且符合商品市場的下單帳戶，請重新選擇帳戶');
    }
    if (!opts?.bypassRisk) {
        const blocked = checkOrderAllowed(quantity);
        if (blocked) throw mutationNotStartedError(blocked);
    }
    if ((opts?.source ?? 'manual') === 'manual') {
        await confirmManualOrder(
            contract,
            action,
            price,
            quantity,
            opts?.orderLot,
            undefined,
            capturedAccount,
        );
    }
    assertTradingLive();
    if (getApiBase() !== startedBase) throw mutationNotStartedError('確認期間伺服器已切換，請重新確認');
    if (capturedAccount && !getAccountState().accounts.some(a => a.signed && a.account_type === capturedAccount.account_type && a.broker_id === capturedAccount.broker_id && a.account_id === capturedAccount.account_id)) throw mutationNotStartedError('帳戶已不可用，請重新確認');
    if (!opts?.bypassRisk) { const blocked = checkOrderAllowed(quantity); if (blocked) throw mutationNotStartedError(blocked); }
    if (opts?.beforeSend) {
        try {
            opts.beforeSend();
        } catch (e) {
            // refused by the caller before sending: nothing was sent
            throw mutationNotStartedError(e instanceof Error ? e.message : String(e));
        }
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
        opts?.source === 'agent',
        capturedAccount,
        opts?.agentCallId
            ? { agentCallId: opts.agentCallId, agentAuto: opts.agentAuto }
            : undefined,
        opts?.ocType,
    );
}

async function sendOrder(
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    market: boolean,
    orderLot?: StockOrderLot,
    agentInitiated = false,
    account?: Account,
    agentContext?: { agentCallId?: string; agentAuto?: boolean },
    ocType: FuturesOCType = 'Auto',
): Promise<Trade> {
    if (contract.security_type === 'IND') {
        throw new Error('指數商品僅提供行情，不可下單');
    }
    const trade = isFuturesContract(contract)
        ? await placeFuturesOrder(contract, {
              action,
              price: price ?? 0,
              quantity,
              price_type: market ? 'MKT' : 'LMT',
              order_type: market ? 'IOC' : 'ROD',
              octype: ocType,
          }, account, { agentInitiated, ...agentContext })
        : await placeStockOrder(contract, {
              action,
              price: price ?? 0,
              quantity,
              price_type: market ? 'MKT' : 'LMT',
              order_type: market ? 'IOC' : 'ROD',
              order_lot: orderLot ?? 'Common',
          }, account, { agentInitiated, ...agentContext });
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
    account?: Account,
): Promise<Trade[]> {
    const capturedAccount = account ?? getAccountState().selectedStock ?? undefined;
    const base = getApiBase();
    assertTradingLive();
    if (!capturedAccount || capturedAccount.account_type !== 'S') throw mutationNotStartedError('缺少股票平倉帳戶');
    if (contract.security_type !== 'STK') throw mutationNotStartedError('股票股數平倉僅支援股票');
    if (!Number.isSafeInteger(shares) || shares <= 0) throw mutationNotStartedError('平倉股數必須是正整數');
    const lots = Math.floor(shares / 1000);
    const odd = shares % 1000;
    const limitPrice = action === 'Sell' ? contract.limit_down : contract.limit_up;
    if (odd && (!Number.isFinite(limitPrice) || !limitPrice || limitPrice <= 0)) throw mutationNotStartedError('零股需要有效漲跌停價，尚未送出任何分單');
    // 拆單前先做一次合併的手動確認（整張市價＋零股限價兩腳只問一次，
    // 內層 placeQuickOrder 一律 source:'auto' 免得連問兩次）
    await confirmManualOrder(
        contract,
        action,
        null,
        shares,
        'IntradayOdd',
        lots > 0 && odd > 0
            ? `拆為 ${lots} 張市價＋${odd} 股盤中零股限價`
            : undefined,
        capturedAccount,
    );
    assertTradingLive();
    if (getApiBase() !== base) throw mutationNotStartedError('確認期間伺服器已切換');
    const out: Trade[] = [];
    if (lots > 0) {
        out.push(
            await placeQuickOrder(contract, action, null, lots, {
                source: 'auto',
                account: capturedAccount,
            }),
        );
    }
    if (odd > 0) {
        if (getApiBase() !== base) throw new Error('伺服器已切換；先前分單可能已送出，剩餘分單未送出');
        if (!limitPrice) {
            throw new Error('零股需要漲跌停價作為限價，無法取得');
        }
        out.push(
            await placeQuickOrder(contract, action, limitPrice, odd, {
                orderLot: 'IntradayOdd',
                source: 'auto',
                account: capturedAccount,
            }),
        );
    }
    return out;
}

// cancel every working order across stock + futures accounts
export async function cancelAllOrders(): Promise<number> {
    trackActivity('全刪委託');
    // 與 tradesPoll 同款帳戶 fan-out（issue #19）— dock 看得到的委託，
    // 全刪就必須刪得到；只查選中帳戶會靜默漏掉其他帳戶的掛單，通知
    // 卻顯示 N/N 像是全刪完
    const tradable = getAccountState().accounts.filter(
        (a) => a.signed && (a.account_type === 'S' || a.account_type === 'F'),
    );
    // Rare, safety-critical: always the authoritative update_status read
    // (refresh:true), never the sidecar cache (ADR 0003).
    const fetches =
        tradable.length > 0
            ? tradable.map((a) =>
                  fetchTrades(a.account_type as 'S' | 'F', a, { refresh: true }),
              )
            : [fetchTrades('S', undefined, { refresh: true }), fetchTrades('F', undefined, { refresh: true })];
    const rs = await Promise.allSettled(fetches);
    const failedAccounts = rs.filter(r => r.status === 'rejected').length;
    const merged = rs.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
    );
    // server 可能每呼叫回整份快取 — 以委託 id 去重，空 id 不合併
    const seen = new Set<string>();
    const all: Trade[] = [];
    for (const t of merged) {
        const k = t.order.id;
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        all.push(t);
    }
    const working = all.filter((t) =>
        remainingWorkingOrderQuantity(t) > 0,
    );
    const results = await cancelOrders(working.map((t) => t.order.id));
    const summary = cancellationSummary(results);
    const ok = results.filter(r => r.status === 'fulfilled' && r.value.status.status === 'Cancelled').length;
    notify({
        kind: failedAccounts ? 'err' : summary.kind,
        title: '🚨 全部刪單',
        body: `${summary.body}${failedAccounts ? ` ${failedAccounts} 個帳戶委託查詢失敗，該範圍未執行刪單。` : ''}`,
    });
    return ok;
}
