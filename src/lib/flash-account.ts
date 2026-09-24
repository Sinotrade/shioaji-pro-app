import type { Account } from './types/portfolio';

type AccountIdentity = Pick<Account, 'account_type' | 'broker_id' | 'account_id'>;
export function accountMatches(a: AccountIdentity | null | undefined, b: AccountIdentity | null | undefined): boolean {
    return !!a && !!b && !!a.broker_id && !!a.account_id && a.account_type === b.account_type
        && a.broker_id === b.broker_id && a.account_id === b.account_id;
}

/** Unknown ownership is never inferred from the currently selected account. */
export function scopedFlashRows<T extends { account?: AccountIdentity; order?: { account?: AccountIdentity } }>(rows: T[], account?: Account): T[] {
    return rows.filter(row => accountMatches(row.account ?? row.order?.account, account)
        && (!row.account || !row.order?.account || accountMatches(row.account, row.order.account)));
}

// ---- per-panel account (issue #139) ----
// Each flash panel/popout keeps its own account per market. A market with no
// saved key follows the app-wide selection until the user picks one.

export type FlashMarket = 'S' | 'F';
export type FlashAccountKeys = Partial<Record<FlashMarket, string>>;

export function flashAccountKey(a: AccountIdentity): string {
    return `${a.account_type}:${a.broker_id}:${a.account_id}`;
}

export interface ResolvedFlashAccount {
    account: Account | undefined;
    // true = no panel choice yet, mirroring the app-wide selection
    following: boolean;
    // a saved choice that is no longer a signed account of this market —
    // never silently replaced by another account
    missing: boolean;
}

export function resolveFlashAccount(accounts: Account[], market: FlashMarket, savedKey: string | undefined, globalAccount: Account | null | undefined): ResolvedFlashAccount {
    const eligible = accounts.filter(a => a.signed && a.account_type === market);
    if (savedKey) {
        const account = eligible.find(a => flashAccountKey(a) === savedKey);
        return { account, following: false, missing: !account };
    }
    return { account: eligible.find(a => accountMatches(a, globalAccount)), following: true, missing: false };
}

// Popout windows are not part of the workspace, so their choice is kept per
// contract code; the popping-out panel may seed it through the URL.
const POPOUT_STORAGE_KEY = 'sj-pro-flash-popout-accounts';

function isKeys(v: unknown): v is FlashAccountKeys {
    return !!v && typeof v === 'object' && Object.entries(v).every(([k, s]) => (k === 'S' || k === 'F') && typeof s === 'string');
}

export function parseFlashAccountKeys(raw: string | null | undefined): FlashAccountKeys | undefined {
    if (!raw) return undefined;
    try {
        const v: unknown = JSON.parse(raw);
        return isKeys(v) ? v : undefined;
    } catch {
        return undefined;
    }
}

export function loadPopoutFlashAccounts(code: string | null, seed?: FlashAccountKeys): FlashAccountKeys {
    let stored: FlashAccountKeys = {};
    try {
        const all: unknown = JSON.parse(localStorage.getItem(POPOUT_STORAGE_KEY) ?? '{}');
        const v = code && all && typeof all === 'object' ? (all as Record<string, unknown>)[code] : undefined;
        if (isKeys(v)) stored = v;
    } catch { /* storage unavailable — fall through to seed/global */ }
    return { ...stored, ...seed };
}

export function savePopoutFlashAccounts(code: string | null, keys: FlashAccountKeys): void {
    if (!code) return;
    try {
        const all: unknown = JSON.parse(localStorage.getItem(POPOUT_STORAGE_KEY) ?? '{}');
        const next = all && typeof all === 'object' ? { ...(all as Record<string, unknown>) } : {};
        next[code] = keys;
        localStorage.setItem(POPOUT_STORAGE_KEY, JSON.stringify(next));
    } catch { /* best effort */ }
}
