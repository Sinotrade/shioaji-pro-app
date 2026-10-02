import { externalEntryPending } from './core';
// src/lib/execution/native-view.ts — pure mapping between the native
// execution engine (#201, desktop, experimental) and the existing trigger /
// bracket UI. No I/O: native.ts talks to the Tauri host; this file decides
// what a native program looks like in the pending-trigger list, the chart
// lines and the bracket panel, and builds the programs new triggers /
// brackets become when the native engine owns them.
//
// Ownership is decided once, at creation: a trigger or bracket is created
// either in the TS runtime (trigger-engine.ts / bracket.ts) or as a native
// program — never both. Rows built here carry `native` and ids prefixed
// `native:`, which the TS runtime never stores, so the TS executor cannot
// evaluate or send for them, and native commands never touch a TS trigger.

import type { BracketExit, BracketPlan, ExitStatus } from '../bracket-core';
import type { RestoreReason as TriggerRestoreReason, TriggerOrder } from '../trigger-engine';
import { accountRef, envKeyOf, programFromBracket, programsFromTriggers } from './adapter';
import type { LegName, Level, OrderProgram, OrderSlot, SlotStatus } from './model';

export const NATIVE_ID_PREFIX = 'native:';

export interface NativeRef {
    programId: string;
    levelId: string;
    version: number;
    leg: LegName;
}

export type NativeTriggerOrder = TriggerOrder & { native: NativeRef };
export type NativeBracketPlan = BracketPlan & {
    native: { programId: string; levelId: string; version: number; status: OrderProgram['status'];
        hold: OrderProgram['hold']; phase: Level['phase'];
        /** The entry stayed open across a trade-id epoch: its fills cannot be
         * matched any more; the user confirms the total (at least `known`). */
        entryAcrossDay: { known: number } | null; entryUnconfirmed?: boolean };
};

export function isNativeTrigger(t: TriggerOrder): t is NativeTriggerOrder {
    return 'native' in t && !!(t as NativeTriggerOrder).native;
}

export function isNativeId(id: string): boolean {
    return id.startsWith(NATIVE_ID_PREFIX);
}

export function nativeRowId(programId: string, levelId: string, leg: LegName): string {
    return `${NATIVE_ID_PREFIX}${programId}:${levelId}:${leg}`;
}

const restoreReason = (r: string | undefined): TriggerRestoreReason =>
    r === 'disconnect' || r === 'env' || r === 'unknownNotSent' ? r : 'restart';

/** A stop sells below / buys above; a take the other way round (the chart
 * infers the direction the same way when it creates them). */
function triggerKind(condition: 'below' | 'above', action: 'Buy' | 'Sell'): 'stop' | 'take' {
    return (condition === 'below') === (action === 'Sell') ? 'stop' : 'take';
}

function row(p: OrderProgram, lv: Level, leg: LegName, fields: Pick<TriggerOrder, 'condition' | 'price' | 'action'
    | 'quantity' | 'kind'> & { bracketId?: string }): NativeTriggerOrder {
    const b = p.binding;
    const pending = lv.pending && lv.pending.leg === leg
        ? { price: lv.pending.price ?? fields.price, at: lv.pending.ts, reason: restoreReason(lv.pending.reason) }
        : undefined;
    return {
        id: nativeRowId(p.id, lv.id, leg),
        code: b.contract.quoteCode,
        env: envKeyOf(b),
        account: accountRef(b.account),
        orderCode: b.contract.orderCode,
        createdAt: p.createdAt,
        ...fields,
        ...(pending ? { pending } : {}),
        ...(lv.recross.includes(leg) ? { awaitingRecross: true } : {}),
        native: { programId: p.id, levelId: lv.id, version: p.version, leg },
    };
}

/** Armed native legs as trigger rows (pending list, chart lines). Fired,
 * finished or stopped legs are not triggers any more (their orders show in
 * the orders list), exactly like a fired TS trigger disappears. */
export function triggerRowsFromPrograms(programs: readonly OrderProgram[]): NativeTriggerOrder[] {
    const out: NativeTriggerOrder[] = [];
    for (const p of programs) {
        if (p.status === 'stopped' || p.status === 'stopping') continue;
        for (const lv of p.levels) {
            if (p.kind === 'trigger' && lv.entry.type === 'touch' && (lv.phase === 'idle' || lv.phase === 'needsConfirm')) {
                const e = lv.entry;
                out.push(row(p, lv, 'entry', { condition: e.condition, price: e.price, action: lv.side, quantity: lv.qty,
                    kind: triggerKind(e.condition, lv.side) }));
            }
            if (p.kind === 'bracket' && lv.exit?.type === 'oco' && lv.position > 0
                && (lv.phase === 'holding' || lv.phase === 'needsConfirm')) {
                const exit = lv.exit;
                const action = lv.side === 'Buy' ? 'Sell' : 'Buy';
                for (const [leg, touch] of [['stop', exit.stop], ['take', exit.take]] as const) {
                    if (!touch) continue;
                    out.push(row(p, lv, leg, { condition: touch.condition, price: touch.price, action, quantity: lv.position,
                        kind: leg, bracketId: p.id }));
                }
            }
        }
    }
    return out;
}

const EXIT_STATUS: Record<SlotStatus, ExitStatus> = {
    pendingSubmit: 'sending',
    working: 'working',
    filled: 'filled',
    ended: 'incomplete',
    notSent: 'not-sent',
    unknown: 'unknown',
};

/** Native bracket programs in the bracket panel's shape. */
export function bracketPlansFromPrograms(programs: readonly OrderProgram[]): NativeBracketPlan[] {
    const out: NativeBracketPlan[] = [];
    for (const p of programs) {
        if (p.kind !== 'bracket') continue;
        const lv = p.levels[0];
        if (!lv || lv.entry.type !== 'external') continue;
        const b = p.binding;
        const entry = lv.orders.find(o => o.role === 'entry');
        const exitSlot: OrderSlot | undefined = [...lv.orders].reverse().find(o => o.role === 'exit');
        const oco = lv.exit?.type === 'oco' ? lv.exit : null;
        const exit: BracketExit | null = exitSlot ? {
            status: EXIT_STATUS[exitSlot.status],
            kind: exitSlot.leg === 'take' ? 'take' : 'stop',
            quantity: exitSlot.qty,
            filled: exitSlot.filled,
            fills: { ...exitSlot.fills },
            fillTs: { ...exitSlot.fillTs },
            orderId: exitSlot.orderId ?? undefined,
            detail: exitSlot.detail ?? undefined,
            acknowledged: exitSlot.acknowledged,
            at: p.updatedAt,
        } : null;
        out.push({
            id: p.id,
            env: envKeyOf(b),
            account: accountRef(b.account),
            market: b.contract.market,
            orderId: entry?.orderId ?? lv.entry.orderId,
            seqno: entry?.seqno ?? lv.entry.seqno ?? '',
            ...((entry?.ordno ?? lv.entry.ordno) ? { ordno: entry?.ordno ?? lv.entry.ordno } : {}),
            quoteCode: b.contract.quoteCode,
            orderCode: b.contract.orderCode,
            securityType: b.contract.securityType,
            exchange: '',
            action: lv.side,
            quantity: lv.qty,
            stopPrice: oco?.stop?.price ?? null,
            takePrice: oco?.take?.price ?? null,
            group: p.id,
            fills: { ...(entry?.fills ?? {}) },
            fillTs: { ...(entry?.fillTs ?? {}) },
            filled: lv.entryFilled,
            entryClosed: !entry || (entry.status !== 'working' && entry.status !== 'pendingSubmit'),
            exit,
            issues: p.issues.map(i => ({ code: 'report-mismatch' as const, detail: i.detail, at: i.ts })),
            dismissed: p.status === 'stopped' && programFinished(p),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            native: { programId: p.id, levelId: lv.id, version: p.version, status: p.status, hold: p.hold, phase: lv.phase,
                entryUnconfirmed: entry?.unconfirmed ?? false,
                entryAcrossDay: externalEntryPending(lv)
                    ? { known: entry?.filled ?? 0 } : null },
        });
    }
    return out;
}

/** The program a new stop / take trigger becomes (null: not mappable —
 * alerts and triggers without a fixed env / account / order code). */
export function programForNewTrigger(t: TriggerOrder): OrderProgram | null {
    return programsFromTriggers([t])[0] ?? null;
}

export interface NativeBracketSpec {
    env: string;
    account: BracketPlan['account'];
    orderId: string;
    seqno: string;
    ordno?: string;
    quoteCode: string;
    orderCode: string;
    securityType: BracketPlan['securityType'];
    exchange: string;
    action: BracketPlan['action'];
    quantity: number;
    stopPrice: number | null;
    takePrice: number | null;
}

/** The program a new bracket becomes: the entry was sent by the order
 * ticket (external entry tracked by order id), the OCO exit is native. */
export function programForNewBracket(spec: NativeBracketSpec, id: string, at: number): OrderProgram | null {
    const plan: BracketPlan = {
        ...spec,
        id,
        market: spec.account.account_type === 'F' ? 'futures' : 'stock',
        group: id,
        fills: {},
        filled: 0,
        entryClosed: false,
        exit: null,
        issues: [],
        createdAt: at,
        updatedAt: at,
    };
    return programFromBracket(plan);
}

/** Finished and safe to drop from the native store: stopped, or every level
 * done / disabled with nothing working, no unacknowledged unknown and no
 * position left. */
export function programFinished(p: OrderProgram): boolean {
    const busy = p.levels.some(lv => lv.position > 0 || lv.unprotected > 0 || lv.orders.some(o =>
        o.status === 'pendingSubmit' || o.status === 'working' || (o.status === 'unknown' && !o.acknowledged)));
    if (busy) return false;
    return p.status === 'stopped' || p.levels.every(lv => lv.phase === 'done' || lv.phase === 'disabled');
}
