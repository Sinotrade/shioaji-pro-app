// src/lib/conditional/flatten.ts — 全平並取消 (#226). In this order, for a
// chosen scope (此商品／此帳戶／全部帳戶):
// 1. stop the conditional orders (nothing new can be sent by them);
// 2. cancel the working orders (authoritative order listing) and wait for
//    every cancel to be confirmed;
// 3. read the positions again (fills that happened meanwhile count) and close
//    exactly what is held: futures with 範圍市價 + 平倉 (Cover), stocks (現股
//    only) with market lots and a limit-price odd remainder.
// It never opens a position: every order closes a position that was just
// read, never more; a product whose cancel is not confirmed is not closed.

import { createAccountQuery } from '../account-query';
import { canTrade } from '../account-tradable';
import { getAccountState } from '../account-store';
import type { AccountRef } from '../bracket-core';
import { ensureContract } from '../contracts-cache';
import { cancelVerifiedOrder, fetchPositions, fetchTrades } from '../shioaji';
import { captureServerMode, type ServerModeGuard } from '../server-info-store';
import { placeQuickOrder } from '../trade';
import type { AccountedPosition, Account } from '../types/portfolio';
import type { Trade } from '../types/order';
import { remainingWorkingOrderQuantity } from '../working-order-quantity';

export type FlattenScope =
    | { type: 'code'; codes: string[]; account: AccountRef | null }
    | { type: 'account'; account: AccountRef }
    | { type: 'all' };

export interface FlattenOrder {
    account: AccountRef;
    code: string;
    action: 'Buy' | 'Sell';
    /** contracts (futures) or shares (stocks) */
    quantity: number;
    market: 'stock' | 'futures';
}

export interface FlattenPlan {
    orders: FlattenOrder[];
    skipped: { code: string; account: AccountRef; reason: string }[];
}

const sameAccount = (a: Pick<AccountRef, 'account_type' | 'broker_id' | 'account_id'> | null | undefined, b: AccountRef | null | undefined) =>
    !!a && !!b && a.account_type === b.account_type && a.broker_id === b.broker_id && a.account_id === b.account_id;

export function inScope(scope: FlattenScope, account: AccountRef | null | undefined, code: string | null | undefined): boolean {
    if (scope.type === 'all') return true;
    if (scope.type === 'account') return sameAccount(account, scope.account);
    return (!scope.account || sameAccount(account, scope.account)) && !!code && scope.codes.includes(code);
}

/** What closing the positions in scope takes. Pure: one order per held
 * position, the exact held quantity, the opposite side. */
export function planFlatten(positions: readonly AccountedPosition[], scope: FlattenScope): FlattenPlan {
    const plan: FlattenPlan = { orders: [], skipped: [] };
    const groups = new Map<string, { account: AccountRef; code: string; market: 'stock' | 'futures'; buy: number; sell: number; credit: boolean; bad: boolean }>();
    for (const p of positions) {
        const a = p.account;
        if (!a || (a.account_type !== 'S' && a.account_type !== 'F') || !a.broker_id || !a.account_id) continue;
        const account: AccountRef = { account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id };
        if (!inScope(scope, account, p.code)) continue;
        const key = `${a.account_type}:${a.broker_id}:${a.account_id}:${p.code}`;
        const g = groups.get(key) ?? { account, code: p.code, market: a.account_type === 'S' ? 'stock' as const : 'futures' as const,
            buy: 0, sell: 0, credit: false, bad: false };
        if (!Number.isSafeInteger(p.quantity) || p.quantity < 0 || (p.direction !== 'Buy' && p.direction !== 'Sell')) g.bad = true;
        else if (p.direction === 'Buy') g.buy += p.quantity;
        else g.sell += p.quantity;
        if (g.market === 'stock' && 'cond' in p && p.cond && p.cond !== 'Cash') g.credit = true;
        groups.set(key, g);
    }
    for (const g of groups.values()) {
        if (g.bad) { plan.skipped.push({ code: g.code, account: g.account, reason: '持倉數量或方向不明，未平倉' }); continue; }
        if (g.credit) { plan.skipped.push({ code: g.code, account: g.account, reason: '信用部位（融資券）請在持倉分開處理' }); continue; }
        if (g.buy > 0 && g.sell > 0) { plan.skipped.push({ code: g.code, account: g.account, reason: '同商品同時有多空部位，請手動處理' }); continue; }
        const held = g.buy || g.sell;
        if (held <= 0) continue;
        plan.orders.push({ account: g.account, code: g.code, action: g.buy > 0 ? 'Sell' : 'Buy', quantity: held, market: g.market });
    }
    return plan;
}

/** Working orders in scope (orders not yet filled or cancelled). */
export function workingInScope(trades: readonly Trade[], scope: FlattenScope): Trade[] {
    return trades.filter(t => {
        if (remainingWorkingOrderQuantity(t) <= 0) return false;
        const a = t.order.account;
        const account = a && (a.account_type === 'S' || a.account_type === 'F')
            ? { account_type: a.account_type as 'S' | 'F', broker_id: a.broker_id ?? '', account_id: a.account_id } : null;
        const code = t.contract.target_code || t.contract.code;
        return inScope(scope, account, code) || inScope(scope, account, t.contract.code);
    });
}

export interface FlattenHooks {
    /** step 1: stop the conditional orders in scope; returns how many */
    stopConditional(): Promise<{ stopped: number; failed: string[] }>;
    /** wait until no conditional order in scope is still sending; false: still sending */
    waitInFlight?(): Promise<boolean>;
}

export interface FlattenResult {
    stopped: number;
    cancelled: number;
    cancelFailed: string[];
    sent: { code: string; action: 'Buy' | 'Sell'; quantity: number; market: 'stock' | 'futures' }[];
    notSent: string[];
    skipped: string[];
}

function accountsFor(scope: FlattenScope): Account[] {
    const all = getAccountState().accounts.filter(a => canTrade(a) && (a.account_type === 'S' || a.account_type === 'F'));
    if (scope.type === 'all') return all;
    if (scope.account) return all.filter(a => sameAccount(a as AccountRef, scope.account));
    return all;
}

/** Runs the three steps. Every request is authoritative (refresh); nothing
 * is retried automatically. */
export async function executeFlatten(scope: FlattenScope, hooks: FlattenHooks): Promise<FlattenResult> {
    const result: FlattenResult = { stopped: 0, cancelled: 0, cancelFailed: [], sent: [], notSent: [], skipped: [] };
    // bound to the server / mode it started on: any switch stops it before the next request
    const sameServer = captureServerMode();
    const switched = () => {
        result.notSent.push('伺服器或模擬／正式模式已切換，已停止（未再刪單或平倉）');
        return result;
    };
    const stop = await hooks.stopConditional();
    result.stopped = stop.stopped;
    if (stop.failed.length) {
        // one still armed could fire after the close: stop here
        result.notSent.push(...stop.failed, '條件單沒有全部停止，未刪單也未平倉；請處理後再試');
        return result;
    }
    if (hooks.waitInFlight && !(await hooks.waitInFlight())) {
        result.notSent.push('有條件單剛觸發、委託仍在送出中，未刪單也未平倉；請稍後再試');
        return result;
    }
    if (hooks.waitInFlight) {
        // an order that just went out may have armed new protection: stop again
        const again = await hooks.stopConditional();
        result.stopped += again.stopped;
        if (again.failed.length) {
            result.notSent.push(...again.failed, '條件單沒有全部停止，未刪單也未平倉；請處理後再試');
            return result;
        }
    }
    if (!sameServer()) return switched();
    const accounts = accountsFor(scope);
    const query = createAccountQuery();
    // 2. cancel working orders, per account, and wait for each answer
    const blocked = new Set<string>(); // account:code with an unconfirmed cancel
    for (const account of accounts) {
        const type = account.account_type as 'S' | 'F';
        let trades: Trade[];
        try {
            trades = await query.read(type, account, current => fetchTrades(type, current, { refresh: true }));
        } catch (e) {
            result.cancelFailed.push(`${account.account_type === 'F' ? '期貨' : '證券'}帳戶委託查詢失敗：${e instanceof Error ? e.message : String(e)}`);
            blocked.add(`${account.account_type}:${account.account_id}:*`);
            continue;
        }
        const working = workingInScope(trades.map(t => ({ ...t, order: { ...t.order, account: t.order.account ?? account } })), scope);
        if (!working.length) continue;
        if (!sameServer()) return switched();
        // each cancel targets the row just read (verified, not resolved by id from older state)
        const answers = await Promise.allSettled(working.map(t => cancelVerifiedOrder(t, account, {
            beforeSend: () => { if (!sameServer()) throw new Error('伺服器或模擬／正式模式已切換，未刪單'); },
        })));
        answers.forEach((r, i) => {
            const t = working[i]!;
            const code = t.contract.target_code || t.contract.code;
            if (r.status === 'fulfilled' && r.value.status.status === 'Cancelled') result.cancelled += 1;
            else {
                blocked.add(`${account.account_type}:${account.account_id}:${code}`);
                result.cancelFailed.push(`${code} 刪單未確認${r.status === 'rejected' ? `（${r.reason instanceof Error ? r.reason.message : String(r.reason)}）` : ''}`);
            }
        });
    }
    // 3. read positions again and close exactly what is held
    if (!sameServer()) return switched();
    for (const account of accounts) {
        const type = account.account_type as 'S' | 'F';
        if (blocked.has(`${type}:${account.account_id}:*`)) continue;
        let rows: AccountedPosition[];
        try {
            const raw = await query.read(type, account, current => fetchPositions(type, current));
            rows = raw.map(r => ({ ...r, account }));
        } catch (e) {
            result.notSent.push(`${type === 'F' ? '期貨' : '證券'}帳戶持倉查詢失敗，未平倉：${e instanceof Error ? e.message : String(e)}`);
            continue;
        }
        const plan = planFlatten(rows, scope);
        result.skipped.push(...plan.skipped.map(s => `${s.code}：${s.reason}`));
        for (const o of plan.orders) {
            if (blocked.has(`${type}:${account.account_id}:${o.code}`)) {
                result.notSent.push(`${o.code}：刪單未確認，未平倉；請核對委託後再試`);
                continue;
            }
            try {
                await sendClose(o, account, sameServer);
                result.sent.push({ code: o.code, action: o.action, quantity: o.quantity, market: o.market });
            } catch (e) {
                const notStarted = (e as { mutationNotStarted?: boolean })?.mutationNotStarted;
                result.notSent.push(`${o.code}：${notStarted ? '未送出' : '結果不明，請核對委託，勿直接重送'}（${e instanceof Error ? e.message : String(e)}）`);
            }
        }
    }
    return result;
}

async function sendClose(o: FlattenOrder, account: Account, serverMode: ServerModeGuard) {
    const contract = await ensureContract(o.code) as Awaited<ReturnType<typeof ensureContract>> & { limit_up?: number; limit_down?: number };
    if (o.market === 'futures') {
        // 範圍市價 + 平倉: the broker refuses closing more than is open
        await placeQuickOrder(contract, o.action, null, o.quantity, {
            source: 'auto', bypassRisk: true, account, ocType: 'Cover', serverMode,
            ...(contract.security_type === 'FUT' || contract.security_type === 'OPT' ? { futuresPriceType: 'MKP' as const } : {}),
        });
        return;
    }
    // stocks (現股): whole lots at market, the odd remainder as an
    // IntradayOdd limit at the price limit (零股沒有市價)
    const lots = Math.floor(o.quantity / 1000);
    const odd = o.quantity % 1000;
    if (lots > 0) await placeQuickOrder(contract, o.action, null, lots, { source: 'auto', bypassRisk: true, account, serverMode });
    if (odd > 0) {
        const limit = o.action === 'Sell' ? contract.limit_down : contract.limit_up;
        if (!limit || !(limit > 0)) throw Object.assign(new Error(`零股 ${odd} 股需要漲跌停價，未送出`), { mutationNotStarted: lots === 0 });
        await placeQuickOrder(contract, o.action, limit, odd, { source: 'auto', bypassRisk: true, account, orderLot: 'IntradayOdd', serverMode });
    }
}
