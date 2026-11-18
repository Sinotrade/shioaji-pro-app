// src/lib/us/us-api.ts — 美股（H 帳戶）HTTP 呼叫
//
// 全部沿用台股 route（SDK beta）：
//   GET  /data/contracts?security_type=STK&region=US     代碼清單（無名稱）
//   GET  /data/contracts/{code}/info?region=US           名稱、前一日參考價
//   POST /order/place_order    {contract, stock_order{…, time_in_force, account{account_type:"H"}}}
//   POST /order/cancel_order   {trade_id}
//   POST /order/update_qty     {trade_id, quantity}  ← quantity 是「要減掉的股數」
//   POST /order/trades         {account_type:"H", …, refresh}
//   POST /order/trade_cache_health
//   POST /portfolio/position_unit （feat/intl-portfolio；能力未確認前要能失敗）
//
// 每個帳戶請求都明確帶 account_type "H"：H 與 S 可能共用 broker／account id。
// 美股不呼叫 observeTradeResponse：台股委託狀態只收 S／F。

import { createAccountQuery } from '../account-query';
import { apiGet, apiPost } from '../api';
import { sendOrderMutation } from '../shioaji';
import type { Account } from '../types/portfolio';
import type { TradeCacheHealth } from '../types/order';
import type { IntlPosition, UsContractInfo, UsContractRecord, UsOrderReq, UsTrade } from '../types/us';

export interface UsContractsResponse {
    contracts: UsContractRecord[];
    security_type?: string;
    region?: string;
    total?: number;
    page?: number;
    page_size?: number;
    max_page?: number;
}

export function fetchUsContractList(opts?: { signal?: AbortSignal }) {
    return apiGet<UsContractsResponse>('/api/v1/data/contracts?security_type=STK&region=US', opts);
}

export function fetchUsContractInfo(code: string, opts?: { signal?: AbortSignal }) {
    return apiGet<UsContractInfo>(`/api/v1/data/contracts/${encodeURIComponent(code.trim().toUpperCase())}/info?region=US`, opts);
}

/** 送單用的合約 key：exchange 一定要帶（NASDAQ／NYSE／BATS／TXSE） */
export function usContractKey(c: { code: string; exchange: string | null }) {
    return { security_type: 'STK', region: 'US', exchange: c.exchange, code: c.code, target_code: null };
}

/** 送單 wire 帳戶：只帶身分欄位，account_type 永遠是 H */
function wireAccount(account: Account) {
    return { account_type: 'H', person_id: account.person_id, broker_id: account.broker_id, account_id: account.account_id };
}

function requireH(account: Account | undefined): Account {
    if (!account || account.account_type !== 'H') {
        throw Object.assign(new Error('美股只能用複委託（H）帳戶下單'), { mutationNotStarted: true as const });
    }
    return account;
}

/** 美股委託被拒時 place_order 可能回 200＋Failed：把 msg 原文丟出 */
function ensureUsAccepted(t: UsTrade): UsTrade {
    if (t?.status?.status === 'Failed') {
        throw Object.assign(new Error(t.status.msg || '委託被拒絕（券商未說明原因）'), { mutationNotStarted: true as const, usRejected: true as const });
    }
    return t;
}

export function placeUsOrder(
    contract: { code: string; exchange: string | null },
    order: UsOrderReq,
    account: Account,
    opts?: { beforeDispatch?: () => void },
): Promise<UsTrade> {
    let h: Account;
    try { h = requireH(account); } catch (e) { return Promise.reject(e); }
    if (!contract.exchange) return Promise.reject(Object.assign(new Error('缺少美股交易所，未送出'), { mutationNotStarted: true as const }));
    // 明確列欄位：絕不夾帶 order_lot／order_cond／daytrade_short／custom_field
    const stockOrder = {
        action: order.action,
        price: order.price,
        quantity: order.quantity,
        price_type: order.price_type,
        time_in_force: order.time_in_force,
        account: wireAccount(h),
    };
    return sendOrderMutation<UsTrade>('/api/v1/order/place_order', {
        contract: usContractKey(contract),
        stock_order: stockOrder,
    }, h, opts).then(ensureUsAccepted);
}

export function cancelUsOrder(tradeId: string, account: Account, opts?: { beforeDispatch?: () => void }): Promise<UsTrade> {
    let h: Account;
    try { h = requireH(account); } catch (e) { return Promise.reject(e); }
    if (!tradeId) return Promise.reject(Object.assign(new Error('缺少委託編號，未送出刪單'), { mutationNotStarted: true as const }));
    return sendOrderMutation<UsTrade>('/api/v1/order/cancel_order', { trade_id: tradeId }, h, opts);
}

/** reduceBy：要減掉的股數（1..剩餘），不是減量後的數量 */
export function reduceUsOrderQty(tradeId: string, reduceBy: number, account: Account): Promise<UsTrade> {
    let h: Account;
    try { h = requireH(account); } catch (e) { return Promise.reject(e); }
    if (!Number.isSafeInteger(reduceBy) || reduceBy < 1) {
        return Promise.reject(Object.assign(new Error('減量股數至少 1 股'), { mutationNotStarted: true as const }));
    }
    return sendOrderMutation<UsTrade>('/api/v1/order/update_qty', { trade_id: tradeId, quantity: reduceBy }, h);
}

export function hQuery<T>(path: string, account: Account, extra: Record<string, unknown> = {}): Promise<T> {
    const query = createAccountQuery();
    return query.read('H', account, current => apiPost<T>(path, {
        ...extra,
        account_type: 'H',
        broker_id: current.broker_id,
        account_id: current.account_id,
    }, { beforeDispatch: query.assertCurrent }));
}

/** refresh:true 跑 update_status（權威對帳）；false 只讀 sidecar 快取 */
export function fetchUsTrades(account: Account, refresh = true): Promise<UsTrade[]> {
    return hQuery<UsTrade[]>('/api/v1/order/trades', account, { refresh });
}

export function fetchUsTradeCacheHealth(account: Account): Promise<TradeCacheHealth> {
    return hQuery<TradeCacheHealth>('/api/v1/order/trade_cache_health', account);
}

/** feat/intl-portfolio 的美股庫存；SDK 沒帶這支時會失敗或回台股形狀 */
export function fetchUsPositions(account: Account): Promise<unknown> {
    return hQuery<unknown>('/api/v1/portfolio/position_unit', account, { region: 'US' });
}

/** API 錯誤字串去掉前面的 HTTP 狀態碼，拒單訊息照原文顯示 */
export function usErrorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^\d{3}\s+/, '').trim() || message;
}

export type { IntlPosition };
