// src/lib/execution/pending-confirm-contract.ts — App ↔ background engine
// contract for 委託待確認 (#201 ③, A 方案). The Rust side (①-3) implements
// exactly these commands, event and payloads; this file is the single source
// of truth for both sides and validates every payload it receives.
//
// A 方案 (user decision, 2026-10-08):
// - An order the background engine sent but could not confirm — the App
//   crashed / restarted mid-submit, no response, no trade_id, and the full
//   order listing never showed its tag — becomes `needsConfirm`. It is NEVER
//   resent automatically.
// - The user checks the order list and either confirms it was sent / filled
//   (`confirmedSent`) or that it was not sent (`confirmedNotSent`, the owning
//   trigger is cancelled). There is no resend resolution: to order again the
//   user goes to an order ticket and places it themselves.
// - An order whose trading session has changed (台股／期貨委託不跨盤別) is
//   not put up for confirmation: the engine reports it as `expired` and the
//   user only acknowledges it (`acknowledgeExpired`).
//
// Commands (Tauri `invoke`):
//   execution_list_pending_confirm()            -> PendingConfirmSnapshot
//       Read-only. Allowed from the main window and popouts.
//   execution_resolve_pending({ request })      -> ResolvePendingResult
//       Main window only (backend rejects others with `windowNotAllowed`).
//       `request.revision` must equal the item's current revision, otherwise
//       `stale` (the item changed since the user looked at it). A resolution
//       that does not fit the item's state is `invalidForState`. No
//       resolution ever places, resends or cancels a broker order; it only
//       records the user's decision and ends the engine's tracking.
//       Every result carries the fresh snapshot.
// Event (Tauri `listen`):
//   execution://pending-confirm-changed         (payload ignored; re-list)

export const PENDING_CONFIRM_CONTRACT_VERSION = 1 as const;

export const PENDING_CONFIRM_COMMAND = {
    list: 'execution_list_pending_confirm',
    resolve: 'execution_resolve_pending',
} as const;

export const PENDING_CONFIRM_CHANGED_EVENT = 'execution://pending-confirm-changed';

/** `needsConfirm`: outcome unknown, the user decides. `expired`: its trading
 * session ended, so it cannot be working any more (it may have filled). */
export type PendingConfirmState = 'needsConfirm' | 'expired';

export type PendingResolution = 'confirmedSent' | 'confirmedNotSent' | 'acknowledgeExpired';

export interface PendingOwner {
    kind: 'trigger' | 'bracket';
    id: string; // trigger id / bracket plan id
    leg: 'stop' | 'take' | null; // which exit; null = plain trigger entry
}

export interface PendingOrderSpec {
    code: string; // order contract code
    name: string | null; // display name when the engine knows it
    action: 'Buy' | 'Sell';
    quantity: number; // positive integer
    priceType: 'LMT' | 'MKT';
    price: number | null; // required for LMT, null for MKT
    orderType: 'ROD' | 'IOC' | 'FOK';
    triggerPrice: number | null; // the trigger level that fired, if any
}

export interface PendingConfirmItem {
    id: string; // engine idempotency key; stable for the item's life
    revision: number; // bumps on every change; echoed back on resolve
    state: PendingConfirmState;
    owner: PendingOwner;
    order: PendingOrderSpec;
    account: { accountType: 'F' | 'S' | 'H'; accountId: string };
    env: string; // `${apiBase}|simulation|production` (same as protection env)
    tag: string; // custom_field tag the engine searched the listing for
    submittedAt: number; // ms epoch: the place request was written / sent
    session: { tradingDay: string; period: 'day' | 'night' }; // YYYY-MM-DD
    listingChecks: number; // complete listings that did not contain the tag
    lastCheckedAt: number | null; // ms epoch of the last complete listing
    expiredAt: number | null; // ms epoch; required when state = expired
}

export interface PendingConfirmSnapshot {
    version: typeof PENDING_CONFIRM_CONTRACT_VERSION;
    /** The previous App run did not shut down cleanly. */
    uncleanShutdown: boolean;
    items: PendingConfirmItem[];
}

export interface ResolvePendingRequest {
    id: string;
    revision: number;
    resolution: PendingResolution;
}

export type ResolvePendingRefusal = 'notFound' | 'stale' | 'invalidForState' | 'windowNotAllowed';

export type ResolvePendingResult =
    | { ok: true; snapshot: PendingConfirmSnapshot }
    | { ok: false; reason: ResolvePendingRefusal; snapshot: PendingConfirmSnapshot };

const RESOLUTIONS: Record<PendingConfirmState, readonly PendingResolution[]> = {
    needsConfirm: ['confirmedSent', 'confirmedNotSent'],
    expired: ['acknowledgeExpired'],
};

export function resolutionAllowed(state: PendingConfirmState, resolution: PendingResolution): boolean {
    return RESOLUTIONS[state].includes(resolution);
}

// ---- validation (fail closed: a malformed payload is an error, never a
// silently shorter list) ----

class ContractError extends Error {
    constructor(path: string, why: string) {
        super(`${path}: ${why}`);
        this.name = 'PendingConfirmContractError';
    }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown, path: string): Obj => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ContractError(path, 'not an object');
    return v as Obj;
};
const str = (v: unknown, path: string): string => {
    if (typeof v !== 'string' || v === '') throw new ContractError(path, 'not a non-empty string');
    return v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => {
    if (typeof v !== 'string' || !allowed.includes(v as T)) throw new ContractError(path, `not one of ${allowed.join('|')}`);
    return v as T;
};
const num = (v: unknown, path: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(path, 'not a finite number');
    return v;
};
const nonNegInt = (v: unknown, path: string): number => {
    const n = num(v, path);
    if (!Number.isSafeInteger(n) || n < 0) throw new ContractError(path, 'not a non-negative integer');
    return n;
};
const nullable = <T>(v: unknown, path: string, f: (v: unknown, path: string) => T): T | null =>
    v === null ? null : f(v, path);
const bool = (v: unknown, path: string): boolean => {
    if (typeof v !== 'boolean') throw new ContractError(path, 'not a boolean');
    return v;
};

function parseItem(raw: unknown, path: string): PendingConfirmItem {
    const o = obj(raw, path);
    const owner = obj(o.owner, `${path}.owner`);
    const order = obj(o.order, `${path}.order`);
    const account = obj(o.account, `${path}.account`);
    const session = obj(o.session, `${path}.session`);
    const quantity = nonNegInt(order.quantity, `${path}.order.quantity`);
    if (quantity === 0) throw new ContractError(`${path}.order.quantity`, 'must be positive');
    const priceType = oneOf(order.priceType, ['LMT', 'MKT'] as const, `${path}.order.priceType`);
    const price = nullable(order.price, `${path}.order.price`, num);
    if (priceType === 'LMT' && price === null) throw new ContractError(`${path}.order.price`, 'required for LMT');
    const tradingDay = str(session.tradingDay, `${path}.session.tradingDay`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) throw new ContractError(`${path}.session.tradingDay`, 'not YYYY-MM-DD');
    const state = oneOf(o.state, ['needsConfirm', 'expired'] as const, `${path}.state`);
    const expiredAt = nullable(o.expiredAt, `${path}.expiredAt`, num);
    if (state === 'expired' && expiredAt === null) throw new ContractError(`${path}.expiredAt`, 'required when expired');
    return {
        id: str(o.id, `${path}.id`),
        revision: nonNegInt(o.revision, `${path}.revision`),
        state,
        owner: {
            kind: oneOf(owner.kind, ['trigger', 'bracket'] as const, `${path}.owner.kind`),
            id: str(owner.id, `${path}.owner.id`),
            leg: owner.leg === null ? null : oneOf(owner.leg, ['stop', 'take'] as const, `${path}.owner.leg`),
        },
        order: {
            code: str(order.code, `${path}.order.code`),
            name: nullable(order.name, `${path}.order.name`, str),
            action: oneOf(order.action, ['Buy', 'Sell'] as const, `${path}.order.action`),
            quantity,
            priceType,
            price: priceType === 'MKT' ? null : price,
            orderType: oneOf(order.orderType, ['ROD', 'IOC', 'FOK'] as const, `${path}.order.orderType`),
            triggerPrice: nullable(order.triggerPrice, `${path}.order.triggerPrice`, num),
        },
        account: {
            accountType: oneOf(account.accountType, ['F', 'S', 'H'] as const, `${path}.account.accountType`),
            accountId: str(account.accountId, `${path}.account.accountId`),
        },
        env: str(o.env, `${path}.env`),
        tag: str(o.tag, `${path}.tag`),
        submittedAt: num(o.submittedAt, `${path}.submittedAt`),
        session: { tradingDay, period: oneOf(session.period, ['day', 'night'] as const, `${path}.session.period`) },
        listingChecks: nonNegInt(o.listingChecks, `${path}.listingChecks`),
        lastCheckedAt: nullable(o.lastCheckedAt, `${path}.lastCheckedAt`, num),
        expiredAt,
    };
}

export function parsePendingConfirmSnapshot(raw: unknown): PendingConfirmSnapshot {
    const o = obj(raw, 'snapshot');
    if (o.version !== PENDING_CONFIRM_CONTRACT_VERSION) {
        throw new ContractError('snapshot.version', `expected ${PENDING_CONFIRM_CONTRACT_VERSION}`);
    }
    if (!Array.isArray(o.items)) throw new ContractError('snapshot.items', 'not an array');
    const items = o.items.map((it, i) => parseItem(it, `snapshot.items[${i}]`));
    const ids = new Set<string>();
    for (const it of items) {
        if (ids.has(it.id)) throw new ContractError('snapshot.items', `duplicate id ${it.id}`);
        ids.add(it.id);
    }
    return { version: PENDING_CONFIRM_CONTRACT_VERSION, uncleanShutdown: bool(o.uncleanShutdown, 'snapshot.uncleanShutdown'), items };
}

export function parseResolvePendingResult(raw: unknown): ResolvePendingResult {
    const o = obj(raw, 'result');
    const snapshot = parsePendingConfirmSnapshot(o.snapshot);
    if (o.ok === true) return { ok: true, snapshot };
    if (o.ok !== false) throw new ContractError('result.ok', 'not a boolean');
    return {
        ok: false,
        reason: oneOf(o.reason, ['notFound', 'stale', 'invalidForState', 'windowNotAllowed'] as const, 'result.reason'),
        snapshot,
    };
}
