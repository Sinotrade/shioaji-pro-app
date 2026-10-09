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
//       Every snapshot carries `runId` (new per engine process) and a
//       `sequence` that increases with every change within that run; the App
//       never adopts an older snapshot over a newer one of the same run.
//   execution_resolve_pending({ request })      -> ResolvePendingResult
//       Main window only (backend rejects others with `windowNotAllowed`).
//       `request.revision` must equal the item's current revision, otherwise
//       `stale` (the item changed since the user looked at it). A resolution
//       that does not fit the item's state is `invalidForState`. No
//       resolution ever places, resends or cancels a broker order; it only
//       records the user's decision and ends the engine's tracking.
//       Every result carries the fresh snapshot.
//       Effects per owner:
//         trigger  + confirmedSent     -> the trigger is finished (fired,
//                                         sent per the user); fills are not
//                                         tracked (there is no trade_id).
//         trigger  + confirmedNotSent  -> the trigger is cancelled.
//         bracket leg (②): confirmedSent -> the bracket is treated as exiting
//                                         with an unknown fill (the other leg
//                                         stays cancelled, no re-arm);
//                          confirmedNotSent -> the leg is not re-armed; the
//                                         bracket shows as unprotected so the
//                                         user protects the position by hand.
//         acknowledgeExpired          -> the record is removed.
//       Where the listing never showed the tag, "not found" is not proof of
//       "not sent": the user confirms against orders, deals and positions.
//
// v2 (2026-10-09, user decision: protection does not carry across sessions
// by itself, but can be turned back on):
// - `order.triggerCondition` ('below' | 'above' | null), `account.brokerId`.
// - resolution `rearmInNewSession` for an `expired` trigger item, with
//   `request.quantity` (a positive integer the user confirmed against the
//   current position): the backend ends the old tracking and creates a new
//   trigger with the same settings in the current session. Nothing is sent
//   then; its first tick decides (already past → 待確認). Main window only,
//   setting 「背景持續執行」 on (`notEnabled` otherwise), quantity checked
//   (`invalidRequest`), creation refused → `rearmFailed` (the item stays).
//   `item.rearmed`: an unfinished earlier rearm; a retry replaces it with the
//   new quantity while it has placed nothing, else `rearmInProgress`.
//   Brackets: not yet (②).
// - A v1 snapshot is still read (no condition, no rearm offered).
//
// v3 (2026-10-09, #201 ②): resolution `handledByUser` (「我已自行處理」) is
// allowed in every state: the user handled the order themselves; the engine
// ends its tracking (a bracket: the whole level, its position released).
// Nothing is sent or cancelled. Bracket protection that lapsed with its
// session is turned back on from the bracket itself (bracket-contract.ts),
// not from this card.
// Event (Tauri `listen`):
//   execution://pending-confirm-changed         (payload ignored; re-list)

export const PENDING_CONFIRM_CONTRACT_VERSION = 3 as const;
const READABLE_VERSIONS = [1, 2, 3] as const;
export type PendingConfirmContractVersion = (typeof READABLE_VERSIONS)[number];

export const PENDING_CONFIRM_COMMAND = {
    list: 'execution_list_pending_confirm',
    resolve: 'execution_resolve_pending',
} as const;

export const PENDING_CONFIRM_CHANGED_EVENT = 'execution://pending-confirm-changed';

/** `needsConfirm`: outcome unknown, the user decides. `expired`: its trading
 * session ended, so it cannot be working any more (it may have filled). */
export type PendingConfirmState = 'needsConfirm' | 'expired';

export type PendingResolution = 'confirmedSent' | 'confirmedNotSent' | 'acknowledgeExpired' | 'rearmInNewSession'
    | 'handledByUser';

export interface PendingOwner {
    kind: 'trigger' | 'bracket';
    id: string; // trigger id / bracket plan id
    leg: 'stop' | 'take' | null; // which exit; null = plain trigger entry
}

export interface PendingOrderSpec {
    code: string; // order contract code
    name: string | null; // display name when the engine knows it
    action: 'Buy' | 'Sell';
    quantity: number; // positive integer, in `quantityUnit`
    quantityUnit: 'contract' | 'lot' | 'share'; // 口 (futures/options) / 張 / 股 (odd lot)
    priceType: 'LMT' | 'MKT';
    price: number | null; // required for LMT, null for MKT
    orderType: 'ROD' | 'IOC' | 'FOK';
    triggerPrice: number | null; // the trigger level that fired, if any
    triggerCondition: 'below' | 'above' | null; // v2; null in v1 / unknown
}

export const UNIT_LABEL: Record<PendingOrderSpec['quantityUnit'], string> = { contract: '口', lot: '張', share: '股' };

export interface PendingConfirmItem {
    id: string; // engine idempotency key; stable for the item's life
    revision: number; // bumps on every change; echoed back on resolve
    state: PendingConfirmState;
    owner: PendingOwner;
    order: PendingOrderSpec;
    /** brokerId: v2 (null in v1); positions are matched by broker + account. */
    account: { accountType: 'F' | 'S' | 'H'; accountId: string; brokerId: string | null };
    env: string; // `${apiBase}|simulation|production` (same as protection env)
    tag: string; // custom_field tag the engine searched the listing for
    submittedAt: number; // ms epoch: the place request was written / sent
    session: { tradingDay: string; period: 'day' | 'night' }; // YYYY-MM-DD
    listingChecks: number; // complete listings that did not contain the tag
    lastCheckedAt: number | null; // ms epoch of the last complete listing
    expiredAt: number | null; // ms epoch; required when state = expired
    /** v2: a rearm of this item that did not finish (the App stopped between
     * creating the new trigger and ending this one). `working`: it already
     * placed an order, so it cannot be redone here. */
    rearmed: { programId: string; quantity: number; working: boolean } | null;
}

export interface PendingConfirmSnapshot {
    version: PendingConfirmContractVersion;
    runId: string; // new for every engine process
    sequence: number; // increases on every change within `runId`
    /** The previous App run did not shut down cleanly. */
    uncleanShutdown: boolean;
    items: PendingConfirmItem[];
}

export interface ResolvePendingRequest {
    id: string;
    revision: number;
    resolution: PendingResolution;
    quantity?: number; // rearmInNewSession only
}

export type ResolvePendingRefusal = 'notFound' | 'stale' | 'invalidForState' | 'windowNotAllowed'
    | 'notEnabled' | 'invalidRequest' | 'rearmFailed' | 'rearmInProgress';
const REFUSALS = ['notFound', 'stale', 'invalidForState', 'windowNotAllowed', 'notEnabled', 'invalidRequest', 'rearmFailed',
    'rearmInProgress'] as const;

export type ResolvePendingResult =
    | { ok: true; snapshot: PendingConfirmSnapshot }
    | { ok: false; reason: ResolvePendingRefusal; snapshot: PendingConfirmSnapshot };

const RESOLUTIONS: Record<PendingConfirmState, readonly PendingResolution[]> = {
    needsConfirm: ['confirmedSent', 'confirmedNotSent', 'handledByUser'],
    expired: ['acknowledgeExpired', 'rearmInNewSession', 'handledByUser'],
};

/** 「我已自行處理」 needs a v3 engine. */
export function canMarkHandled(snapshot: Pick<PendingConfirmSnapshot, 'version'>): boolean {
    return snapshot.version >= 3;
}

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
/** ms epoch the UI can render: integer, after 2000-01-01, before 2100. */
const epochMs = (v: unknown, path: string): number => {
    const n = num(v, path);
    if (!Number.isSafeInteger(n) || n < 946_684_800_000 || n > 4_102_444_800_000) throw new ContractError(path, 'not a ms epoch');
    return n;
};
const calendarDay = (v: unknown, path: string): string => {
    const s = str(v, path);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
        throw new ContractError(path, 'not a calendar day YYYY-MM-DD');
    }
    return s;
};
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
    if (priceType === 'LMT' && (price === null || price <= 0)) throw new ContractError(`${path}.order.price`, 'LMT needs a positive price');
    if (priceType === 'MKT' && price !== null) throw new ContractError(`${path}.order.price`, 'MKT must not carry a price');
    const tradingDay = calendarDay(session.tradingDay, `${path}.session.tradingDay`);
    const state = oneOf(o.state, ['needsConfirm', 'expired'] as const, `${path}.state`);
    const expiredAt = nullable(o.expiredAt, `${path}.expiredAt`, epochMs);
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
            quantityUnit: oneOf(order.quantityUnit, ['contract', 'lot', 'share'] as const, `${path}.order.quantityUnit`),
            priceType,
            price,
            orderType: oneOf(order.orderType, ['ROD', 'IOC', 'FOK'] as const, `${path}.order.orderType`),
            triggerPrice: nullable(order.triggerPrice, `${path}.order.triggerPrice`, num),
            triggerCondition: order.triggerCondition === undefined || order.triggerCondition === null ? null
                : oneOf(order.triggerCondition, ['below', 'above'] as const, `${path}.order.triggerCondition`),
        },
        account: {
            accountType: oneOf(account.accountType, ['F', 'S', 'H'] as const, `${path}.account.accountType`),
            accountId: str(account.accountId, `${path}.account.accountId`),
            brokerId: account.brokerId === undefined || account.brokerId === null ? null
                : str(account.brokerId, `${path}.account.brokerId`),
        },
        env: str(o.env, `${path}.env`),
        tag: str(o.tag, `${path}.tag`),
        submittedAt: epochMs(o.submittedAt, `${path}.submittedAt`),
        session: { tradingDay, period: oneOf(session.period, ['day', 'night'] as const, `${path}.session.period`) },
        listingChecks: nonNegInt(o.listingChecks, `${path}.listingChecks`),
        lastCheckedAt: nullable(o.lastCheckedAt, `${path}.lastCheckedAt`, epochMs),
        expiredAt,
        rearmed: o.rearmed === undefined || o.rearmed === null ? null : (() => {
            const r = obj(o.rearmed, `${path}.rearmed`);
            const quantity = nonNegInt(r.quantity, `${path}.rearmed.quantity`);
            return { programId: str(r.programId, `${path}.rearmed.programId`), quantity, working: bool(r.working, `${path}.rearmed.working`) };
        })(),
    };
}

export function parsePendingConfirmSnapshot(raw: unknown): PendingConfirmSnapshot {
    const o = obj(raw, 'snapshot');
    if (!READABLE_VERSIONS.includes(o.version as PendingConfirmContractVersion)) {
        throw new ContractError('snapshot.version', `expected one of ${READABLE_VERSIONS.join('|')}`);
    }
    if (!Array.isArray(o.items)) throw new ContractError('snapshot.items', 'not an array');
    const items = o.items.map((it, i) => parseItem(it, `snapshot.items[${i}]`));
    const ids = new Set<string>();
    for (const it of items) {
        if (ids.has(it.id)) throw new ContractError('snapshot.items', `duplicate id ${it.id}`);
        ids.add(it.id);
    }
    return {
        version: o.version as PendingConfirmContractVersion,
        runId: str(o.runId, 'snapshot.runId'),
        sequence: nonNegInt(o.sequence, 'snapshot.sequence'),
        uncleanShutdown: bool(o.uncleanShutdown, 'snapshot.uncleanShutdown'),
        items,
    };
}

export function parseResolvePendingResult(raw: unknown): ResolvePendingResult {
    const o = obj(raw, 'result');
    const snapshot = parsePendingConfirmSnapshot(o.snapshot);
    if (o.ok === true) return { ok: true, snapshot };
    if (o.ok !== false) throw new ContractError('result.ok', 'not a boolean');
    return {
        ok: false,
        reason: oneOf(o.reason, REFUSALS, 'result.reason'),
        snapshot,
    };
}

/** The card may offer 「在新盤別重新啟用」: a v2 engine, an expired trigger
 * (brackets come with ②) whose trigger side and price are known. */
export function canRearm(snapshot: Pick<PendingConfirmSnapshot, 'version'>, item: PendingConfirmItem): boolean {
    return snapshot.version >= 2 && item.state === 'expired' && item.owner.kind === 'trigger' && !item.rearmed?.working
        && item.order.triggerCondition !== null && item.order.triggerPrice !== null;
}
