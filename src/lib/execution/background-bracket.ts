// src/lib/execution/background-bracket.ts — the order ticket's side of a
// background bracket (#201 ②): which executor protects a new bracket, and
// the request sent once the entry order was accepted. Pure helpers; the
// commands live in background.ts, the contract in bracket-contract.ts.
//
// One owner per bracket, decided before the entry is sent: setting off →
// the window's bracket (bracket.ts, unchanged); on → futures / options
// brackets run in the background; stocks always stay in the window.

import type { AccountRef } from '../bracket-core';
import type { BracketEntryPlan, TriggerSend, TriggerValidity } from '../trigger-engine';
import { accountKey, parseEnvKey } from './adapter';
import type { CreateBracketRequest } from './bracket-contract';
import type { OrderSpec, TickBand } from './model';

export interface BackgroundBracketSpec {
    env: string; // protection env key `${serverId}|simulation|production`
    account: AccountRef;
    quoteCode: string;
    orderCode: string;
    securityType: 'FUT' | 'OPT';
    action: 'Buy' | 'Sell';
    quantity: number;
    stopPrice: number | null;
    takePrice: number | null;
    /** The accepted entry order. */
    tradeId: string;
    seqno: string | null;
    ordno: string | null;
    /** ms epoch the entry was sent. */
    sentAt: number;
}

/** Futures / options only (the engine refuses the rest). */
export function backgroundBracketEligible(isFutures: boolean, securityType: string | null | undefined): boolean {
    return isFutures && (securityType === 'FUT' || securityType === 'OPT');
}

let seq = 0;
/** A fresh bracket id (the engine never accepts one it saw before). */
export function newBracketId(now = Date.now()): string {
    seq = (seq + 1) % 1_000_000;
    const rand = Math.floor(Math.random() * 36 ** 4).toString(36);
    return `bkt-${now.toString(36)}-${seq.toString(36)}${rand}`;
}

/** The engine request, or null when the entry cannot be described. */
export function bracketRequestFor(spec: BackgroundBracketSpec, id = newBracketId()): CreateBracketRequest | null {
    const env = parseEnvKey(spec.env);
    if (!env || !spec.tradeId || !spec.account.broker_id || !spec.account.account_id) return null;
    if (!Number.isSafeInteger(spec.quantity) || spec.quantity <= 0) return null;
    const blank = (v: string | null | undefined) => (v && v.trim() ? v : null);
    return {
        id,
        binding: {
            env: env.env,
            serverId: env.serverId,
            account: accountKey(spec.account),
            contract: { market: 'futures', quoteCode: spec.quoteCode, orderCode: spec.orderCode, securityType: spec.securityType },
        },
        side: spec.action,
        qty: spec.quantity,
        stop: spec.stopPrice,
        take: spec.takePrice,
        entry: { tradeId: spec.tradeId, seqno: blank(spec.seqno), ordno: blank(spec.ordno), sentAt: spec.sentAt },
    };
}

/** #226 a panel bracket in the background: its tiers (priced in the engine
 * from the actual fill price) and either the window's accepted entry order
 * or a 觸價 entry the engine fires itself (an opening order). */
export interface PanelBackgroundSpec {
    env: string;
    account: AccountRef;
    quoteCode: string;
    orderCode: string;
    /** STK: 現股 整股 (its exits close in cash); WRT: a warrant, the same
     * (the engine prices it on the warrant tick table) */
    securityType: 'FUT' | 'OPT' | 'STK' | 'WRT';
    action: 'Buy' | 'Sell';
    plan: BracketEntryPlan;
    tickTable: TickBand[];
    entry: { tradeId: string; seqno: string | null; ordno: string | null; sentAt: number }
        | { trigger: { condition: 'below' | 'above'; price: number; send: TriggerSend; validity?: TriggerValidity;
            /** futures: the entry opens a new position only (#216 新倉) */
            octype?: 'New' } };
}

/** The order a 觸價 entry sends, by its send style. */
function triggerOrder(send: TriggerSend, stock: boolean, octype?: 'New'): OrderSpec {
    const cash = stock ? { stockCond: 'Cash' as const, stockLot: 'Common' as const } : {};
    const oc = octype && !stock ? { octype } : {};
    if (send.type === 'MKP' && !stock) return { priceType: 'MKP', timeInForce: 'IOC', ...oc };
    if (send.type === 'LMT') return { priceType: 'LMT', timeInForce: 'ROD', ...cash, ...oc };
    return { priceType: 'MKT', timeInForce: 'IOC', ...cash, ...oc };
}

export function panelBracketRequest(spec: PanelBackgroundSpec, id = newBracketId()): CreateBracketRequest | null {
    const env = parseEnvKey(spec.env);
    const qty = spec.plan.tiers.reduce((n, t) => n + t.quantity, 0);
    if (!env || !spec.account.broker_id || !spec.account.account_id || !Number.isSafeInteger(qty) || qty <= 0) return null;
    const blank = (v: string | null | undefined) => (v && v.trim() ? v : null);
    const e = spec.entry;
    const stock = spec.securityType === 'STK' || spec.securityType === 'WRT';
    return {
        id,
        binding: {
            env: env.env,
            serverId: env.serverId,
            account: accountKey(spec.account),
            contract: { market: stock ? 'stock' : 'futures', quoteCode: spec.quoteCode, orderCode: spec.orderCode,
                securityType: spec.securityType },
        },
        side: spec.action,
        qty,
        stop: null,
        take: null,
        ...('trigger' in e
            ? { trigger: { condition: e.trigger.condition, price: e.trigger.price, order: triggerOrder(e.trigger.send, stock, e.trigger.octype),
                ...(e.trigger.send.type === 'LMT' ? { limitTicks: e.trigger.send.ticks } : {}),
                ...(e.trigger.validity ? { validity: { type: e.trigger.validity.type, until: e.trigger.validity.until } } : {}) } }
            : e.tradeId ? { entry: { tradeId: e.tradeId, seqno: blank(e.seqno), ordno: blank(e.ordno), sentAt: e.sentAt } } : {}),
        plan: { tiers: spec.plan.tiers.map(t => ({ quantity: t.quantity, takeTicks: t.takeTicks })), stopTicks: spec.plan.stopTicks,
            trail: spec.plan.trail, breakeven: spec.plan.breakeven },
        tickTable: spec.tickTable,
    };
}
