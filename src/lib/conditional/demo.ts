// src/lib/conditional/demo.ts — dev-only sample data for the 條件單管理面板
// (#226): `?condDemo` in a dev build shows the design's rows without any
// order, trigger or server state. The panel reads these rows instead of the
// engines; its buttons then act on nothing (the engines do not know these
// ids). Never part of a release build. Accounts and prices are made up.

import type { BracketPlan } from '../bracket-core';
import { primeContract } from '../contracts-cache';
import type { BracketView } from '../execution/bracket-contract';
import type { PendingConfirmItem } from '../execution/pending-confirm-contract';
import type { EndedTrigger, ExitRecord, TriggerOrder } from '../trigger-engine';
import type { ContractInfo } from '../types/contract';
import type { Sources } from './rows';

export const DEMO_ENV = 'http://demo.invalid|simulation';

export function conditionalDemoActive(): boolean {
    return import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('condDemo');
}

/** `?condDemo=empty`: the empty state. */
export function conditionalDemoEmpty(): boolean {
    return conditionalDemoActive() && new URLSearchParams(location.search).get('condDemo') === 'empty';
}

export const DEMO_PRICES: Record<string, number> = { TXFJ6: 48212, MXFJ6: 48212, 2330: 1072, 2317: 203.5, 2454: 1498 };

const F = { account_type: 'F' as const, broker_id: 'DEMO-F', account_id: '9804567' };
const S = { account_type: 'S' as const, broker_id: 'DEMO-S', account_id: '0418812' };

function contract(code: string, name: string, security_type: 'FUT' | 'STK', tick: number): ContractInfo {
    return { code, name, symbol: code, security_type, exchange: security_type === 'FUT' ? 'TAIFEX' : 'TSE', category: '',
        currency: 'TWD', limit_up: 0, limit_down: 0, reference: 0, day_trade: 'Yes', update_date: '', margin_trading_balance: 0,
        short_selling_balance: 0, tick, target_code: code } as unknown as ContractInfo;
}

let primed = false;
function primeDemoContracts() {
    if (primed) return;
    primed = true;
    primeContract(contract('TXFJ6', '台指期 10月', 'FUT', 1));
    primeContract(contract('MXFJ6', '小台 10月', 'FUT', 1));
    primeContract(contract('2330', '台積電', 'STK', 5));
    primeContract(contract('2317', '鴻海', 'STK', 0.5));
    primeContract(contract('2454', '聯發科', 'STK', 5));
}

export function conditionalDemoSources(now: number): Sources {
    primeDemoContracts();
    const t0 = now - 4 * 3600_000;
    const at = (min: number) => t0 + min * 60_000;
    const base = { env: DEMO_ENV, createdAt: at(0) };
    const triggers: TriggerOrder[] = [
        { ...base, id: 'demo-t1', code: 'TXFJ6', orderCode: 'TXFJ6', account: F, condition: 'below', price: 47900, action: 'Sell',
            quantity: 1, kind: 'stop', role: 'entry', history: [
                { at: at(1), text: '建立 · 現價 ≤ 48,000 時賣出 1 口' },
                { at: at(82), text: '修改觸發價 48,000 → 47,900' },
                { at: at(125), text: '連線中斷，暫停盯價', tone: 'warn' },
                { at: at(125.1), text: '重新連線，對帳完成' },
                { at: at(125.2), text: '盯價中', tone: 'ok' },
            ] },
        { ...base, id: 'demo-t2', code: '2330', orderCode: '2330', account: S, condition: 'below', price: 1080, action: 'Sell',
            quantity: 2, kind: 'stop', pending: { price: 1072, at: at(200), reason: 'restart' },
            history: [{ at: at(2), text: '建立 · 現價 ≤ 1,080 時賣出 2 張' }, { at: at(200), text: 'App 重新開啟時已穿價，未自動送出', tone: 'err' }] },
        { ...base, id: 'demo-t3', code: '2454', orderCode: '2454', account: S, condition: 'above', price: 1520, action: 'Buy',
            quantity: 1, kind: 'stop', role: 'entry', paused: true,
            history: [{ at: at(5), text: '建立 · 現價 ≥ 1,520 時買進 1 張' }, { at: at(90), text: '已暫停，不再盯價', tone: 'warn' }] },
    ];
    const bracket: BracketPlan = {
        id: 'demo-b1', env: DEMO_ENV, account: S, market: 'stock', orderId: 'demo-o1', seqno: '1', quoteCode: '2317', orderCode: '2317',
        securityType: 'STK', exchange: 'TSE', action: 'Buy', quantity: 500, orderLot: 'IntradayOdd', stopPrice: 196, takePrice: 212,
        group: 'demo-g1', fills: { a: 500 }, filled: 500, entryClosed: true, exit: null, issues: [], createdAt: at(10), updatedAt: at(12),
    };
    const legs: TriggerOrder[] = [
        { ...base, id: 'demo-l1', code: '2317', orderCode: '2317', account: S, condition: 'below', price: 196, action: 'Sell', quantity: 500,
            kind: 'stop', bracketId: 'demo-b1', group: 'demo-g1', orderLot: 'IntradayOdd' },
        { ...base, id: 'demo-l2', code: '2317', orderCode: '2317', account: S, condition: 'above', price: 212, action: 'Sell', quantity: 500,
            kind: 'take', bracketId: 'demo-b1', group: 'demo-g1', orderLot: 'IntradayOdd' },
    ];
    const confirm: PendingConfirmItem = {
        id: 'demo-c1', revision: 1, state: 'needsConfirm', owner: { kind: 'bracket', id: 'demo-b0', leg: null },
        order: { code: 'TXFJ6', name: '台指期 10月', action: 'Buy', quantity: 3, quantityUnit: 'contract', priceType: 'LMT', price: 48150,
            orderType: 'ROD', triggerPrice: null, triggerCondition: null },
        account: { accountType: 'F', accountId: F.account_id, brokerId: F.broker_id }, env: DEMO_ENV, tag: 'DEMO01',
        submittedAt: at(-30), session: { tradingDay: '2026-10-09', period: 'day' }, listingChecks: 3, lastCheckedAt: at(-20),
        expiredAt: null, rearmed: null,
    };
    const firedTrigger: TriggerOrder = { ...base, id: 'demo-e1', code: 'TXFJ6', orderCode: 'TXFJ6', account: F, condition: 'above', price: 48300,
        action: 'Sell', quantity: 1, kind: 'take', history: [{ at: at(20), text: '建立' }] };
    const exits: ExitRecord[] = [{ id: 'ex-demo-e1', triggerId: 'demo-e1', env: DEMO_ENV, account: F, market: 'futures', orderCode: 'TXFJ6',
        action: 'Sell', reserveKey: 'demo', requested: 1, kind: 'take', quantity: 1, filled: 1, fills: { x: 1 }, status: 'filled', at: at(150) }];
    const ended: EndedTrigger[] = [
        { id: 'demo-e1', trigger: firedTrigger, reason: 'fired', at: at(150), detail: '現價 48,300' },
        { id: 'demo-e2', trigger: { ...firedTrigger, id: 'demo-e2', code: '2330', orderCode: '2330', account: S, condition: 'above', price: 1100,
            action: 'Buy', kind: 'stop', role: 'entry' }, reason: 'cancelled', at: at(60) },
    ];
    const lapsed: BracketView = {
        programId: 'bkt-demo', levelId: 'l0', rearm: false, env: DEMO_ENV, account: { accountType: 'F', brokerId: F.broker_id, accountId: F.account_id },
        quoteCode: 'MXFJ6', orderCode: 'MXFJ6', side: 'Buy', quantity: 2, stop: 47950, take: 48500, state: 'lapsed', paused: false, held: null,
        entryFilled: 2, position: 2, unprotected: 0, exit: null, pendingLeg: null, attention: true,
        actions: { markHandled: true, rearm: true, decide: false, pause: false, resume: false, remove: false },
        detail: 'sessionEnded', createdAt: at(-60), updatedAt: at(-1),
    };
    if (conditionalDemoEmpty()) {
        return { triggers: [], brackets: [], exits: [], ended: [], pendingConfirm: [], feedMissing: [], executing: true,
            envNow: DEMO_ENV, streamLive: true, now };
    }
    return {
        triggers: [...triggers, ...legs], brackets: [bracket], exits, ended, pendingConfirm: [confirm], bgBrackets: [lapsed], feedMissing: [],
        executing: true, envNow: DEMO_ENV, streamLive: true, now,
    };
}
