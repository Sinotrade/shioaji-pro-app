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

// Popout windows are not part of the workspace, so each popout gets a window
// id (URL `win`) and its choice is kept in localStorage under that id. The
// opening panel seeds the entry before the window loads — the URL carries
// only the opaque id, never an account number. Afterwards the popout's own
// choices overwrite the entry, so a reload keeps them.
const POPOUT_STORAGE_KEY = 'sj-pro-flash-popout-windows';
// bound the map — ids of closed popouts are never reused
const POPOUT_MAX_ENTRIES = 50;

interface PopoutEntry { keys: FlashAccountKeys; at: number }

function isKeys(v: unknown): v is FlashAccountKeys {
    return !!v && typeof v === 'object' && Object.entries(v).every(([k, s]) => (k === 'S' || k === 'F') && typeof s === 'string');
}

function readPopoutEntries(): Record<string, PopoutEntry> {
    try {
        const all: unknown = JSON.parse(localStorage.getItem(POPOUT_STORAGE_KEY) ?? '{}');
        if (!all || typeof all !== 'object') return {};
        const out: Record<string, PopoutEntry> = {};
        for (const [id, e] of Object.entries(all as Record<string, unknown>)) {
            const entry = e as Partial<PopoutEntry> | null;
            if (entry && isKeys(entry.keys)) out[id] = { keys: entry.keys, at: Number(entry.at) || 0 };
        }
        return out;
    } catch {
        return {};
    }
}

function writePopoutEntry(id: string, keys: FlashAccountKeys): void {
    try {
        const all = readPopoutEntries();
        all[id] = { keys, at: Date.now() };
        const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, POPOUT_MAX_ENTRIES);
        localStorage.setItem(POPOUT_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch { /* best effort */ }
}

export function newPopoutWindowId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Opener side: hand the panel's choice (`{}` = follow main) to a new popout. */
export function seedPopoutFlashAccounts(windowId: string, keys: FlashAccountKeys): void {
    writePopoutEntry(windowId, { ...keys });
}

/** Popout side: its saved choice, or follow-main when there is none. */
export function loadPopoutFlashAccounts(windowId: string | null): FlashAccountKeys {
    if (!windowId) return {};
    return readPopoutEntries()[windowId]?.keys ?? {};
}

export function savePopoutFlashAccounts(windowId: string | null, keys: FlashAccountKeys): void {
    if (windowId) writePopoutEntry(windowId, keys);
}

/**
 * URL params for a flash popout opened from a panel: the panel's choice is
 * used as-is on first open (`{}` = follow main), even if an older popout
 * stored something else. Only the opaque window id goes into the URL.
 */
export function flashPopoutParams(panelKeys: FlashAccountKeys | undefined): { win: string } {
    const win = newPopoutWindowId();
    seedPopoutFlashAccounts(win, panelKeys ?? {});
    return { win };
}
