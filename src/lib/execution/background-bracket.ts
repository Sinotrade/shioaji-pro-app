// src/lib/execution/background-bracket.ts — the order ticket's side of a
// background bracket (#201 ②): which executor protects a new bracket, and
// the request sent once the entry order was accepted. Pure helpers; the
// commands live in background.ts, the contract in bracket-contract.ts.
//
// One owner per bracket, decided before the entry is sent: setting off →
// the window's bracket (bracket.ts, unchanged); on → futures / options
// brackets run in the background; stocks always stay in the window.

import type { AccountRef } from '../bracket-core';
import { accountKey, parseEnvKey } from './adapter';
import type { CreateBracketRequest } from './bracket-contract';

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
        entry: { tradeId: spec.tradeId, seqno: blank(spec.seqno), ordno: blank(spec.ordno) },
    };
}
