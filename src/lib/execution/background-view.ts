// src/lib/execution/background-view.ts — pure mapping between the background
// execution engine (#201 ①-3, desktop, 「背景持續執行（實驗）」) and the
// existing trigger UI. No I/O: background.ts talks to the Tauri host.
//
// One owner per trigger, decided once at creation: a trigger is created
// either in the window's trigger engine (trigger-engine.ts) or as a
// background program — never both, and switching the setting never moves
// one. Rows built here carry `background` and ids prefixed `bg:`, which the
// window's trigger engine never stores, so it can never evaluate or send
// them, and a background command never touches a window trigger.

import type { ContractBase } from '../types/contract';
import type { NewTrigger, RestoreReason as TriggerRestoreReason, TriggerOrder } from '../trigger-engine';
import { accountRef, envKeyOf, programsFromTriggers } from './adapter';
import type { Level, OrderProgram } from './model';

export const BACKGROUND_ID_PREFIX = 'bg:';

export interface BackgroundRef {
    programId: string;
    levelId: string;
}

export type BackgroundTriggerOrder = TriggerOrder & { background: BackgroundRef };

export function isBackgroundId(id: string): boolean {
    return id.startsWith(BACKGROUND_ID_PREFIX);
}

export function backgroundRowId(programId: string, levelId: string): string {
    return `${BACKGROUND_ID_PREFIX}${programId}:${levelId}`;
}

/** First version: futures / options stop and take triggers only (no OCO
 * group, no odd lot, no alert, no bracket leg), with the contract known. */
export function backgroundEligible(t: NewTrigger, contract: ContractBase | undefined): boolean {
    if (t.kind !== 'stop' && t.kind !== 'take') return false;
    if (t.group || t.bracketId || (t.orderLot && t.orderLot !== 'Common')) return false;
    if (t.account?.account_type !== 'F' || !t.env || !t.orderCode) return false;
    return contract?.security_type === 'FUT' || contract?.security_type === 'OPT';
}

/** The program a new stop / take trigger becomes (null: not mappable). */
export function programForNewTrigger(t: TriggerOrder, contract: ContractBase): OrderProgram | null {
    const p = programsFromTriggers([t])[0];
    if (!p || (contract.security_type !== 'FUT' && contract.security_type !== 'OPT')) return null;
    const at = t.createdAt ?? Date.now();
    return { ...p, binding: { ...p.binding, contract: { ...p.binding.contract, securityType: contract.security_type } },
        createdAt: at, updatedAt: at };
}

const restoreReason = (r: string | undefined): TriggerRestoreReason =>
    r === 'disconnect' || r === 'env' ? r : r === 'resume' ? 'disconnect' : 'restart';

/** A stop sells below / buys above; a take the other way round. */
const kindOf = (condition: 'below' | 'above', action: 'Buy' | 'Sell'): 'stop' | 'take' =>
    (condition === 'below') === (action === 'Sell') ? 'stop' : 'take';

function row(p: OrderProgram, lv: Level): BackgroundTriggerOrder | null {
    if (lv.entry.type !== 'touch') return null;
    const e = lv.entry;
    const b = p.binding;
    // an order whose outcome is unknown is decided on the 委託待確認 card
    const pending = lv.phase === 'needsConfirm' && lv.pending && lv.pending.reason !== 'unknownNotSent'
        ? { price: lv.pending.price ?? e.price, at: lv.pending.ts, reason: restoreReason(lv.pending.reason) }
        : undefined;
    if (lv.phase !== 'idle' && !pending) return null;
    return {
        id: backgroundRowId(p.id, lv.id),
        code: b.contract.quoteCode,
        condition: e.condition,
        price: e.price,
        action: lv.side,
        quantity: lv.qty,
        kind: kindOf(e.condition, lv.side),
        env: envKeyOf(b),
        account: accountRef(b.account),
        orderCode: b.contract.orderCode,
        createdAt: p.createdAt,
        ...(pending ? { pending } : {}),
        ...(lv.recross.includes('entry') ? { awaitingRecross: true } : {}),
        background: { programId: p.id, levelId: lv.id },
    };
}

/** Armed (or 待確認) background triggers as trigger rows: the pending list
 * and the chart lines. Fired, finished or stopped ones are not triggers any
 * more (their orders show in the orders list), like a fired window trigger. */
export function triggerRowsFromPrograms(programs: readonly OrderProgram[]): BackgroundTriggerOrder[] {
    const out: BackgroundTriggerOrder[] = [];
    for (const p of programs) {
        if (p.kind !== 'trigger' || p.status === 'stopped' || p.status === 'stopping') continue;
        for (const lv of p.levels) {
            const r = row(p, lv);
            if (r) out.push(r);
        }
    }
    return out;
}

/** Safe to drop: nothing working, no unknown outcome, no position, and
 * stopped or every level done / disabled. */
export function programFinished(p: OrderProgram): boolean {
    const busy = p.levels.some(lv => lv.position > 0 || lv.unprotected > 0 || lv.orders.some(o =>
        o.status === 'pendingSubmit' || o.status === 'working' || (o.status === 'unknown' && !o.acknowledged)));
    if (busy) return false;
    return p.status === 'stopped' || p.levels.every(lv => lv.phase === 'done' || lv.phase === 'disabled');
}
