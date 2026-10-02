// src/lib/execution/adapter.ts — express the EXISTING web trigger engine
// (trigger-engine.ts) and bracket runtime (bracket.ts / bracket-core.ts) as
// order programs (#201). Read-only mapping: the web runtime keeps its own
// behaviour; this is what the native executor imports when protection moves
// to the desktop layer, and what the adapter tests use to pin that both
// describe the same semantics.
//
// Mapping:
// - stop / take trigger            → program{kind:'trigger'}, 1 level, touch entry
// - manual triggers sharing a group → one program with ocoLevels (first fire
//                                      cancels the others, like processedGroups)
// - bracket plan + its OCO pair     → program{kind:'bracket'}, 1 level:
//                                      external entry (plan.orderId), oco exit
// - price alerts                    → not a program (they never send orders)
// - a trigger without fixed env/account/orderCode (legacy) → not mappable

import { accountRefKey, type AccountRef, type BracketExit, type BracketPlan } from '../bracket-core';
import type { ExitRecord, TriggerOrder } from '../trigger-engine';
import type { FuturesOCType } from '../types/order';
import { EXECUTION_SCHEMA_VERSION, type AccountKey, type Binding, type ContractKey, type Env, type Level, type OrderProgram,
    type OrderSlot, type OrderSpec, type RestoreReason, type SlotStatus } from './model';

export { EXECUTION_SCHEMA_VERSION };

/** `<apiBase>|simulation` → { env, serverId }. Null when the mode is unknown. */
export function parseEnvKey(envKey: string): { env: Env; serverId: string } | null {
    const i = envKey.lastIndexOf('|');
    if (i < 0) return null;
    const mode = envKey.slice(i + 1);
    if (mode !== 'simulation' && mode !== 'production') return null;
    return { env: mode, serverId: envKey.slice(0, i) };
}

export function envKeyOf(b: Pick<Binding, 'env' | 'serverId'>): string {
    return `${b.serverId}|${b.env}`;
}

export function accountKey(a: AccountRef): AccountKey {
    return { accountType: a.account_type, brokerId: a.broker_id, accountId: a.account_id };
}

export function accountRef(a: AccountKey): AccountRef {
    return { account_type: a.accountType, broker_id: a.brokerId, account_id: a.accountId };
}

export const DEFAULT_SESSION: OrderProgram['session'] = { resumeRule: 'confirm', longDisconnectMs: 60_000, silentStallMs: 90_000 };
const NO_BOUNDS: OrderProgram['bounds'] = { upper: null, lower: null, onBreakUpper: 'none', onBreakLower: 'none' };
const ONE_SHOT: OrderProgram['cycle'] = { rearmAfterExit: false, maxCycles: null, partialFill: 'immediate' };

/** The order a firing trigger sends today (trade.ts placeQuickOrder with
 * price null): market IOC; futures carry the trigger's octype (bracket
 * exits: Cover; omitted = server default), stocks a Common lot. */
export function triggerOrderSpec(octype: FuturesOCType | undefined, market: 'stock' | 'futures'): OrderSpec {
    if (market === 'stock') return { priceType: 'MKT', timeInForce: 'IOC', stockLot: 'Common' };
    return octype ? { priceType: 'MKT', timeInForce: 'IOC', octype } : { priceType: 'MKT', timeInForce: 'IOC' };
}

function contractOf(t: { code: string; orderCode?: string; account?: AccountRef; securityType?: 'STK' | 'FUT' | 'OPT' }): ContractKey {
    const futures = t.securityType !== 'STK';
    return { market: futures ? 'futures' : 'stock', quoteCode: t.code, orderCode: t.orderCode ?? t.code,
        securityType: t.securityType! /* actual type established by levelFromTrigger */ };
}

function baseLevel(id: string, over: Partial<Level> & Pick<Level, 'side' | 'qty' | 'entry' | 'exit'>): Level {
    return { id, phase: 'idle', check: null, recross: [], pending: null, orders: [], position: 0, entryFilled: 0,
        unprotected: 0, cycles: 0, detail: null, ...over };
}

function baseProgram(id: string, kind: OrderProgram['kind'], binding: Binding, levels: Level[], at: number): OrderProgram {
    return { id, kind, binding, version: 1, status: 'running', pauseReason: null, hold: null, ocoLevels: false, levels,
        generator: null, cycle: ONE_SHOT, bounds: NO_BOUNDS, session: DEFAULT_SESSION, risk: { maxWorkingEntries: null },
        hooks: [], intentSeq: 0, issues: [], createdAt: at, updatedAt: at };
}

const pendingReason = (r: string | undefined): RestoreReason =>
    r === 'disconnect' || r === 'env' ? r : 'restart';

/** One level for one order-sending trigger (not a bracket leg). */
export function levelFromTrigger(t: TriggerOrder): Level | null {
    if (t.kind === 'alert' || t.suspended || t.bracketId || !t.env || !t.account || !t.orderCode || !t.securityType) return null;
    if (t.account.account_type === 'F' ? t.securityType !== 'FUT' && t.securityType !== 'OPT' : t.securityType !== 'STK') return null;
    const market = t.account.account_type === 'F' ? 'futures' : 'stock';
    return baseLevel(t.id, {
        side: t.action,
        qty: t.quantity,
        entry: { type: 'touch', condition: t.condition, price: t.price, order: triggerOrderSpec(t.octype, market) },
        exit: null,
        phase: t.pending ? 'needsConfirm' : 'idle',
        pending: t.pending ? { leg: 'entry', price: t.pending.price, ts: t.pending.at, reason: pendingReason(t.pending.reason) } : null,
        recross: t.awaitingRecross ? ['entry'] : [],
    });
}

/** Manual stop / take triggers → programs. Triggers of one OCO group (same
 * env) become one program with `ocoLevels`. Alerts, bracket legs and legacy
 * triggers without a fixed context are skipped. */
export function programsFromTriggers(triggers: TriggerOrder[]): OrderProgram[] {
    const groups = new Map<string, TriggerOrder[]>();
    for (const t of triggers) {
        if (!levelFromTrigger(t)) continue;
        const key = t.group ? `${t.env}|${t.group}` : `single|${t.id}`;
        groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    const out: OrderProgram[] = [];
    for (const members of groups.values()) {
        const first = members[0]!;
        const env = parseEnvKey(first.env!);
        if (!env) continue;
        const binding: Binding = { ...env, account: accountKey(first.account!), contract: contractOf(first) };
        const levels = members.map(t => levelFromTrigger(t)!);
        const p = baseProgram(first.group ? `grp:${first.group}` : `trg:${first.id}`, 'trigger', binding, levels, first.createdAt ?? 0);
        p.ocoLevels = !!first.group;
        out.push(p);
    }
    return out;
}

const EXIT_STATUS: Record<BracketExit['status'], SlotStatus> = {
    sending: 'pendingSubmit',
    working: 'working',
    filled: 'filled',
    incomplete: 'ended',
    'not-sent': 'notSent',
    unknown: 'unknown',
};

function slotFromExit(programId: string, levelId: string, exit: BracketExit): OrderSlot {
    const leg = exit.kind === 'stop' ? 'stop' : 'take';
    return { key: `${programId}/${levelId}/${leg}/0/legacy`, role: 'exit', leg, cycle: 0, qty: exit.quantity,
        status: EXIT_STATUS[exit.status], orderId: exit.orderId ?? null, filled: exit.filled, fills: { ...exit.fills },
        fillTs: { ...(exit.fillTs ?? {}) }, detail: exit.detail ?? null, acknowledged: !!exit.acknowledged, cancel: null };
}

/** A bracket plan (and, when armed, its OCO trigger pair) as one program.
 * `pair` carries the 待確認 / keep state of the pair's legs, if any. */
export function programFromBracket(plan: BracketPlan, pair: TriggerOrder[] = []): OrderProgram | null {
    const env = parseEnvKey(plan.env);
    if (!env) return null;
    const binding: Binding = { ...env, account: accountKey(plan.account),
        contract: { market: plan.market, quoteCode: plan.quoteCode, orderCode: plan.orderCode, securityType: plan.securityType } };
    const programId = `brk:${plan.id}`;
    const stopCond = plan.action === 'Buy' ? 'below' : 'above';
    const takeCond = plan.action === 'Buy' ? 'above' : 'below';
    const octype: FuturesOCType | undefined = plan.market === 'futures' ? 'Cover' : undefined;
    const filled = Math.min(plan.filled, plan.quantity);
    const entry: OrderSlot = {
        key: `${programId}/L1/entry/0/ext`, role: 'entry', leg: 'entry', cycle: 0, qty: plan.quantity,
        status: plan.entryClosed ? (plan.filled >= plan.quantity ? 'filled' : 'ended') : 'working',
        orderId: plan.orderId, filled: plan.filled, fills: { ...plan.fills }, fillTs: { ...(plan.fillTs ?? {}) },
        detail: null, acknowledged: false, cancel: null,
    };
    const orders: OrderSlot[] = [entry];
    let position = filled;
    let unprotected = 0;
    if (plan.exit) {
        orders.push(slotFromExit(programId, 'L1', plan.exit));
        position = filled - plan.exit.filled;
        // entry fills beyond what the exit covered are unprotected (bracket-core unprotectedQuantity)
        const counted = plan.exit.status === 'not-sent' ? 0 : plan.exit.status === 'incomplete' ? plan.exit.filled : plan.exit.quantity;
        unprotected = Math.max(0, filled - counted);
    }
    const held = pair.find(t => t.pending);
    const level = baseLevel('L1', {
        side: plan.action,
        qty: plan.quantity,
        entry: { type: 'external', orderId: plan.orderId,
            ...(plan.seqno?.trim() ? { seqno: plan.seqno.trim() } : {}),
            ...(plan.ordno?.trim() ? { ordno: plan.ordno.trim() } : {}) },
        exit: { type: 'oco',
            stop: plan.stopPrice === null ? null : { price: plan.stopPrice, condition: stopCond },
            take: plan.takePrice === null ? null : { price: plan.takePrice, condition: takeCond },
            order: triggerOrderSpec(octype, plan.market) },
        orders,
        entryFilled: plan.filled,
        position,
        unprotected,
        phase: bracketLevelPhase(plan, position, !!held),
        pending: held?.pending ? { leg: held.kind === 'stop' ? 'stop' : 'take', price: held.pending.price, ts: held.pending.at,
            reason: pendingReason(held.pending.reason) } : null,
        recross: pair.filter(t => t.awaitingRecross).map(t => t.kind === 'stop' ? 'stop' as const : 'take' as const),
    });
    return baseProgram(programId, 'bracket', binding, [level], plan.createdAt);
}

function bracketLevelPhase(plan: BracketPlan, position: number, held: boolean): Level['phase'] {
    if (held) return 'needsConfirm';
    if (plan.exit) {
        switch (plan.exit.status) {
            case 'sending': case 'working': return 'exiting';
            case 'filled': return 'done';
            case 'unknown': return plan.exit.acknowledged ? 'disabled' : 'unknown';
            default: return 'disabled';
        }
    }
    if (position > 0) return 'holding';
    return plan.entryClosed ? 'done' : 'working';
}

/** Exit records (outside brackets) keep reserving quantity per
 * env/account/product/side until resolved; the native executor reads this
 * key to share the reservation across programs. */
export function reservationKey(rec: Pick<ExitRecord, 'env' | 'account' | 'orderCode' | 'action'>): string {
    return `${rec.env}|${accountRefKey(rec.account)}|${rec.orderCode}|${rec.action}`;
}
