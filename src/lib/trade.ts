import { canTrade } from './account-tradable';
import { createAccountQuery } from './account-query';
import { remainingWorkingOrderQuantity } from './working-order-quantity';
import { getApiBase } from './runtime';
import { cancellationSummary } from './trade-mutations';
// src/lib/trade.ts — one-shot order helper + in-app notification channel

import { getAccountState } from './account-store';
import { trackActivity } from './activity';
import { accountConfirmLabel, requestOrderConfirm } from './order-confirm';
import { creditLabel, isOddLot, lotLabel, ODD_LOT_TEXT, orderQtyUnit, stockOrderProblem, type CreditLabel } from './odd-lot';
import { futuresOrderProblem, quickOrderNote } from './order-conditions';
import { checkOrderAllowed, getRiskSettings } from './risk';
import {
    cancelOrders,
    fetchTrades,
    placeFuturesOrder,
    placeStockOrder,
} from './shioaji';
import { getStreamStatus } from './stream';
import { getTradingMirrorFresh } from './trading-mirror-lease';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE, type ServerModeGuard } from './server-info-store';
import type { ContractBase, ContractInfo } from './types/contract';
import type { Account } from './types/portfolio';
import {
    type Action,
    type StockOrderCond,
    type StockOrderLot,
    type FuturesOCType,
    type OrderType,
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
    if (getStreamStatus() !== 'live' || !getTradingMirrorFresh()) {
        throw mutationNotStartedError(
            '行情非 LIVE 或主視窗交易狀態未連線，已暫停下單，請待連線恢復',
        );
    }
}

// 手動下單確認被取消 — 呼叫端的錯誤通知會顯示這個訊息
export class OrderConfirmCancelled extends Error {
    // 取消確認＝確定沒有送出
    readonly mutationNotStarted = true as const;
    constructor() {
        super('已取消下單');
        this.name = 'OrderConfirmCancelled';
    }
}

function orderUnit(contract: ContractBase, orderLot?: StockOrderLot): string {
    return orderQtyUnit(isFuturesContract(contract), orderLot);
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
    livePriceCode?: string,
    credit?: string,
    serverMode?: ServerModeGuard,
): Promise<boolean> {
    if (!getRiskSettings().confirmManualOrders) return false;
    const approved = await requestOrderConfirm({
        code: contract.code,
        name: (contract as Partial<ContractInfo>).name,
        action,
        price,
        quantity,
        unit: orderUnit(contract, orderLot),
        // 顯示實際送單的帳戶（閃電下單各視窗可與主畫面選擇不同）
        accountLabel: account ? accountConfirmLabel(account) : undefined,
        note,
        livePriceCode,
        ...(credit ? { credit } : {}),
    }, serverMode ? { serverMode } : undefined);
    if (!approved) throw new OrderConfirmCancelled();
    return true;
}

const CREDIT_NOTE: Record<CreditLabel, string> = { 融資: '融資', 融券: '融券', 借券: '借券', 借券豁免: '借券豁免', 現沖: '現股當沖' };

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
        // 限價單的委託條件（圖表下單設定，#204）；缺省 ROD。市價單一律 IOC
        orderType?: OrderType;
        // 'auto' = 系統觸發（停損/停利等），永不彈手動確認
        source?: 'manual' | 'auto' | 'agent';
        agentCallId?: string;
        agentAuto?: boolean;
        // 呼叫端的帳戶仍是送單帳戶？確認期間改選帳戶就中止（閃電下單各視窗）
        isAccountCurrent?: () => boolean;
        // Runs once at dispatch, after confirmation/risk checks and
        // transport loading. Throwing refuses the order (nothing is sent).
        beforeSend?: () => void;
        // 待確認觸價單在人工確認視窗顯示持續更新的目前成交價。
        confirmLivePriceCode?: string;
        // 委託的 custom_field 標記（整零價差、即時策略用來從委託清單對回自己送出的委託）
        customField?: string;
        // 讀下單回應的標頭（X-Shioaji-Instance，SDK 1.7.8+）
        onResponse?: (res: Response) => void;
        // 整批共用的伺服器模式閘門（外層一次確認、內層多筆送出）
        serverMode?: ServerModeGuard;
        // 股票信用條件（閃電下單，整股）：缺省／Cash＝現股
        orderCond?: StockOrderCond;
        // 現股當沖先賣：只在賣出時帶出；買進（回補）一律是現股買進
        daytradeShort?: boolean;
        // 確認之後、送出之前的非同步最後檢查（例如重新查可否融資券）；丟出錯誤就不送
        afterConfirm?: () => Promise<void>;
        // 期貨市價單的價別：市價（缺省）或範圍市價 MKP；一律 IOC
        futuresPriceType?: 'MKT' | 'MKP';
    },
): Promise<Trade> {
    const startedBase = getApiBase();
    // 伺服器模式代次：確認期間模擬重啟成正式（同一位址）也不送
    const sameServerMode = opts?.serverMode ?? captureServerMode();
    const capturedAccount = opts?.account ?? (isFuturesContract(contract) ? getAccountState().selectedFutures : getAccountState().selectedStock) ?? undefined;
    assertTradingLive();
    if (contract.security_type === 'IND') {
        throw mutationNotStartedError('指數商品僅提供行情，不可下單');
    }
    const expectedAccountType = isFuturesContract(contract) ? 'F' : 'S';
    if (!capturedAccount || !canTrade(capturedAccount) || capturedAccount.account_type !== expectedAccountType
        || !getAccountState().accounts.some(a => canTrade(a) && a.account_type === expectedAccountType
            && a.broker_id === capturedAccount.broker_id && a.account_id === capturedAccount.account_id)) {
        throw mutationNotStartedError('缺少有效且符合商品市場的下單帳戶，請重新選擇帳戶');
    }
    const odd = !isFuturesContract(contract) && isOddLot(opts?.orderLot);
    // 零股沒有市價單（#204）；需要立即成交的呼叫端自行帶漲跌停限價
    if (odd && price === null) throw mutationNotStartedError(ODD_LOT_TEXT.priceType);
    // 信用條件（閃電，整股）：照下單面板現行規則在確認前就檢查，送單時
    // placeStockOrder 會再檢查一次 — 任何路徑都不會把不支援的組合送出
    const orderCond = opts?.orderCond && opts.orderCond !== 'Cash' ? opts.orderCond : undefined;
    const daytradeShort = opts?.daytradeShort === true && action === 'Sell';
    // 委託條件（效期、價別、期貨倉別）同樣在確認前用下單面板的同一套規則檢查
    const futuresPriceType = price === null && opts?.futuresPriceType === 'MKP' ? 'MKP' : 'MKT';
    if (isFuturesContract(contract)) {
        if (orderCond || opts?.daytradeShort) throw mutationNotStartedError('信用條件（融資、融券、當沖先賣）只適用股票');
        const problem = futuresOrderProblem({
            price_type: price === null ? futuresPriceType : 'LMT',
            order_type: price === null ? 'IOC' : (opts?.orderType ?? 'ROD'),
            octype: opts?.ocType ?? 'Auto',
        });
        if (problem) throw mutationNotStartedError(problem);
    } else {
        if (opts?.futuresPriceType === 'MKP') throw mutationNotStartedError('範圍市價（MKP）只適用期貨');
        const problem = stockOrderProblem({
            quantity,
            price_type: price === null ? 'MKT' : 'LMT',
            order_type: price === null ? 'IOC' : (opts?.orderType ?? 'ROD'),
            order_lot: opts?.orderLot ?? 'Common',
            order_cond: orderCond,
            daytrade_short: daytradeShort,
            action,
            day_trade: (contract as Partial<ContractInfo>).day_trade,
        });
        if (problem) throw mutationNotStartedError(problem);
    }
    const credit = isFuturesContract(contract) ? undefined : creditLabel(action, orderCond, daytradeShort);
    if (!opts?.bypassRisk) {
        const blocked = checkOrderAllowed(quantity, odd ? opts?.orderLot : undefined);
        if (blocked) throw mutationNotStartedError(blocked);
    }
    if ((opts?.source ?? 'manual') === 'manual') {
        await confirmManualOrder(
            contract,
            action,
            price,
            quantity,
            opts?.orderLot,
            quickOrderNote({
                market: price === null,
                futures: isFuturesContract(contract),
                priceType: futuresPriceType,
                orderType: opts?.orderType,
                octype: opts?.ocType,
                credit: credit ? CREDIT_NOTE[credit] : undefined,
                oddLotLabel: odd ? lotLabel(opts?.orderLot) : undefined,
            }),
            capturedAccount,
            opts?.confirmLivePriceCode,
            credit,
            // 開始時模式未知（冷啟動）：在按下確認的當下，以確認視窗顯示的模式為準
            sameServerMode,
        );
    }
    assertTradingLive();
    if (getApiBase() !== startedBase) throw mutationNotStartedError('確認期間伺服器已切換，請重新確認');
    if (!sameServerMode()) throw mutationNotStartedError(SERVER_MODE_CHANGED_MESSAGE);
    if (opts?.afterConfirm) {
        try {
            await opts.afterConfirm();
        } catch (e) {
            throw mutationNotStartedError(e instanceof Error ? e.message : String(e));
        }
        assertTradingLive();
        if (getApiBase() !== startedBase) throw mutationNotStartedError('確認期間伺服器已切換，請重新確認');
        if (!sameServerMode()) throw mutationNotStartedError(SERVER_MODE_CHANGED_MESSAGE);
    }
    if (opts?.isAccountCurrent && !opts.isAccountCurrent()) throw mutationNotStartedError('確認期間帳戶已變更，請重新確認');
    if (capturedAccount && !getAccountState().accounts.some(a => canTrade(a) && a.account_type === capturedAccount.account_type && a.broker_id === capturedAccount.broker_id && a.account_id === capturedAccount.account_id)) throw mutationNotStartedError('帳戶已不可用，請重新確認');
    if (!opts?.bypassRisk) { const blocked = checkOrderAllowed(quantity, odd ? opts?.orderLot : undefined); if (blocked) throw mutationNotStartedError(blocked); }
    const beforeDispatch = () => {
        if (!sameServerMode()) throw mutationNotStartedError(SERVER_MODE_CHANGED_MESSAGE);
        try {
            opts?.beforeSend?.();
        } catch (e) {
            // refused by the caller before sending: nothing was sent
            throw mutationNotStartedError(e instanceof Error ? e.message : String(e));
        }
    };
    trackActivity(
        '下單',
        `${contract.code} ${credit ?? ''}${action === 'Buy' ? '買' : '賣'} ${quantity}${odd ? '股（零股）' : ''} @${price ?? '市價'}`,
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
        opts?.orderType,
        opts?.customField,
        opts?.onResponse,
        beforeDispatch,
        { orderCond, daytradeShort, futuresPriceType },
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
    orderType: OrderType = 'ROD',
    customField?: string,
    onResponse?: (res: Response) => void,
    beforeDispatch?: () => void,
    credit?: { orderCond?: StockOrderCond; daytradeShort?: boolean; futuresPriceType?: 'MKT' | 'MKP' },
): Promise<Trade> {
    if (contract.security_type === 'IND') {
        throw new Error('指數商品僅提供行情，不可下單');
    }
    const trade = isFuturesContract(contract)
        ? await placeFuturesOrder(contract, {
              action,
              price: price ?? 0,
              quantity,
              price_type: market ? (credit?.futuresPriceType ?? 'MKT') : 'LMT',
              order_type: market ? 'IOC' : orderType,
              octype: ocType,
              ...(customField ? { custom_field: customField } : {}),
          }, account, { agentInitiated, ...agentContext, ...(beforeDispatch ? { beforeDispatch } : {}) })
        : await placeStockOrder(contract, {
              action,
              price: price ?? 0,
              quantity,
              price_type: market ? 'MKT' : 'LMT',
              order_type: market ? 'IOC' : orderType,
              order_lot: orderLot ?? 'Common',
              ...(credit?.orderCond ? { order_cond: credit.orderCond } : {}),
              ...(credit?.daytradeShort ? { daytrade_short: true } : {}),
              ...(customField ? { custom_field: customField } : {}),
          }, account, { agentInitiated, ...agentContext, ...(onResponse ? { onResponse } : {}), ...(beforeDispatch ? { beforeDispatch } : {}) });
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
    opts?: { isAccountCurrent?: () => boolean; beforeSend?: () => void },
): Promise<Trade[]> {
    const capturedAccount = account ?? getAccountState().selectedStock ?? undefined;
    const base = getApiBase();
    // 一次確認、兩腳送出：整批用同一個伺服器模式閘門，任一腳之前變了就不送
    const serverMode = captureServerMode();
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
        undefined,
        undefined,
        serverMode,
    );
    assertTradingLive();
    if (getApiBase() !== base) throw mutationNotStartedError('確認期間伺服器已切換');
    if (!serverMode()) throw mutationNotStartedError(SERVER_MODE_CHANGED_MESSAGE);
    if (opts?.isAccountCurrent && !opts.isAccountCurrent()) throw mutationNotStartedError('確認期間帳戶已變更，請重新確認');
    const out: Trade[] = [];
    if (lots > 0) {
        out.push(
            await placeQuickOrder(contract, action, null, lots, {
                source: 'auto',
                account: capturedAccount,
                isAccountCurrent: opts?.isAccountCurrent,
                beforeSend: opts?.beforeSend,
                serverMode,
            }),
        );
    }
    if (odd > 0) {
        if (getApiBase() !== base) {
            if (out.length === 0) throw mutationNotStartedError('伺服器已切換，尚未送出任何分單');
            throw new Error('伺服器已切換；整張分單已送出，零股分單未送出');
        }
        if (out.length > 0 && !serverMode()) throw new Error('確認後伺服器或模式已變更：整張分單已送出，零股分單未送出，請核對委託');
        if (!limitPrice) {
            throw new Error('零股需要漲跌停價作為限價，無法取得');
        }
        try {
            out.push(
                await placeQuickOrder(contract, action, limitPrice, odd, {
                    orderLot: 'IntradayOdd',
                    source: 'auto',
                    account: capturedAccount,
                    isAccountCurrent: opts?.isAccountCurrent,
                    beforeSend: opts?.beforeSend,
                    serverMode,
                }),
            );
        } catch (e) {
            // 整張那一腳已送出：這筆不能報成「沒有送出」
            if (out.length > 0) {
                const msg = e instanceof Error ? e.message : String(e);
                // 只有確定沒送出（mutationNotStarted）才說未送出；否則結果未知
                throw new Error((e as { mutationNotStarted?: boolean } | null)?.mutationNotStarted
                    // mutationNotStarted 也包含券商立即回 Failed（已送達但未成立）
                    ? `整張分單已送出，零股分單未成立（未送出或被券商拒絕）：${msg}`
                    : `整張分單已送出，零股分單結果未知，請核對委託，勿直接重送：${msg}`);
            }
            throw e;
        }
    }
    return out;
}

// cancel every working order across stock + futures accounts
export async function cancelAllOrders(): Promise<number> {
    trackActivity('全刪委託');
    const query = createAccountQuery();
    // 與 tradesPoll 同款帳戶 fan-out（issue #19）— dock 看得到的委託，
    // 全刪就必須刪得到；只查選中帳戶會靜默漏掉其他帳戶的掛單，通知
    // 卻顯示 N/N 像是全刪完
    const tradable = getAccountState().accounts.filter(
        (a) => canTrade(a) && (a.account_type === 'S' || a.account_type === 'F'),
    );
    if (!tradable.length) throw new Error('尚未取得可查詢帳戶；未執行全部刪單');
    // Rare, safety-critical: always the authoritative update_status read
    // (refresh:true), never the sidecar cache (ADR 0003).
    const fetches = tradable.map(a => query.read(a.account_type as 'S' | 'F', a,
        current => fetchTrades(current.account_type as 'S' | 'F', current, { refresh: true })));
    const rs = await Promise.allSettled(fetches);
    query.assertCurrent();
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
