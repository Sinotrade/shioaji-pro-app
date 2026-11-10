import { FUTURES_OCTYPES, ORDER_TYPES } from './order-conditions';
import { normalizeFlashProtect, normalizeTriggerSend, type FlashProtect, type FlashTriggerSend } from './flash-trigger';
import type { FuturesOCType, OrderType } from './types/order';
import { canTrade } from './account-tradable';
import { sanitizeFlashQtySetting, type FlashQtySetting } from './flash-qty-memory';
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
// Each flash panel/popout keeps its own account per market. In the main
// window a market with no saved key follows the app-wide selection until the
// user picks one; popouts never follow (see pinnedFlashAccounts) — a market
// with no pinned key there has no account until the user picks one.

export type FlashMarket = 'S' | 'F';
export type FlashAccountKeys = Partial<Record<FlashMarket, string>>;

export function flashAccountKey(a: AccountIdentity): string {
    return `${a.account_type}:${a.broker_id}:${a.account_id}`;
}

export interface ResolvedFlashAccount {
    account: Account | undefined;
    // true = no panel choice yet, mirroring the app-wide selection
    following: boolean;
    // a saved choice that is no longer a tradable account of this market —
    // never silently replaced by another account
    missing: boolean;
    // no saved key and following is not allowed (popout) — user must pick
    unset: boolean;
}

export function resolveFlashAccount(accounts: Account[], market: FlashMarket, savedKey: string | undefined, globalAccount: Account | null | undefined, followMain = true): ResolvedFlashAccount {
    const eligible = accounts.filter(a => canTrade(a) && a.account_type === market);
    if (savedKey) {
        const account = eligible.find(a => flashAccountKey(a) === savedKey);
        return { account, following: false, missing: !account, unset: false };
    }
    if (!followMain) return { account: undefined, following: false, missing: false, unset: true };
    return { account: eligible.find(a => accountMatches(a, globalAccount)), following: true, missing: false, unset: false };
}

// Popout windows are not part of the workspace, so each popout gets a window
// id (URL `win`) and its choice is kept in localStorage under that id. The
// opening panel seeds the entry before the window loads — the URL carries
// only the opaque id, never an account number. Afterwards the popout's own
// choices overwrite the entry, so a reload keeps them.
const POPOUT_STORAGE_KEY = 'sj-pro-flash-popout-windows';
// bound the map — the least recently seen records (by open, reload, change or
// the open-window heartbeat) go first
const POPOUT_MAX_ENTRIES = 50;

// 閃電下單面板自己的單位（整股／盤中零股）— 依面板記憶，換股票不變
export type FlashLot = 'Common' | 'IntradayOdd';
export function isFlashLot(v: unknown): v is FlashLot {
    return v === 'Common' || v === 'IntradayOdd';
}

// 閃電下單面板自己的信用條件（整股）：與下單面板相同的 現股／融資／融券／
// 借券／借券豁免＋現股當沖先賣。換股票不變；零股與期貨時不適用（面板設定
// 保留，回到整股股票時恢復）。
export type FlashCond = 'Cash' | 'MarginTrading' | 'ShortSelling' | 'SBLShort' | 'SBLShortPriceExempt';
const FLASH_CONDS: ReadonlySet<string> = new Set(['Cash', 'MarginTrading', 'ShortSelling', 'SBLShort', 'SBLShortPriceExempt']);
export interface FlashCredit { cond: FlashCond; daytradeShort: boolean }
export const CASH_CREDIT: FlashCredit = { cond: 'Cash', daytradeShort: false };

/** 讀存檔的信用條件：未知條件丟掉；當沖先賣只限現股 */
export function normalizeFlashCredit(v: unknown): FlashCredit | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const { cond, daytradeShort } = v as { cond?: unknown; daytradeShort?: unknown };
    if (typeof cond !== 'string' || !FLASH_CONDS.has(cond)) return undefined;
    return { cond: cond as FlashCond, daytradeShort: cond === 'Cash' && daytradeShort === true };
}

// qty: 記住數量（false = 使用者關閉；沒有這個欄位 = 預設開啟、尚未記住）
// 閃電下單面板自己的委託條件（同下單面板的清單）：點價限價單的效期、
// 期貨倉別、期貨市價鈕的價別。換商品不變；不適用的商品類別（零股只能
// ROD、股票沒有倉別與範圍市價）時暫不套用，回來恢復。
export interface FlashOrderOpts {
    orderType: OrderType;
    octype: FuturesOCType;
    futuresPriceType: 'MKT' | 'MKP';
    /** #216 自動停損停利 (absent: off, defaults) */
    protect?: FlashProtect;
    /** #216 觸價單觸發後的送出方式 (absent: 市價) */
    triggerSend?: FlashTriggerSend;
    /** #216 how triggers are placed: outer 觸買／觸賣 columns (absent) or Alt＋點 */
    triggerLayout?: 'columns' | 'modifier';
    /** 委託合計列「買 N（成交）／賣 N（成交）／待回補」(absent: 顯示) */
    showTotals?: false;
}
export const DEFAULT_ORDER_OPTS: FlashOrderOpts = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT' };

/** 讀存檔的委託條件：缺的或不認得的欄位用預設 */
export function normalizeFlashOrderOpts(v: unknown): FlashOrderOpts | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    return {
        orderType: ORDER_TYPES.includes(o.orderType as OrderType) ? o.orderType as OrderType : 'ROD',
        octype: FUTURES_OCTYPES.some(x => x.value === o.octype) ? o.octype as FuturesOCType : 'Auto',
        futuresPriceType: o.futuresPriceType === 'MKP' ? 'MKP' : 'MKT',
        ...(normalizeFlashProtect(o.protect) ? { protect: normalizeFlashProtect(o.protect) } : {}),
        ...(normalizeTriggerSend(o.triggerSend) ? { triggerSend: normalizeTriggerSend(o.triggerSend) } : {}),
        ...(o.triggerLayout === 'modifier' ? { triggerLayout: 'modifier' as const } : {}),
        ...(o.showTotals === false ? { showTotals: false as const } : {}),
    };
}

interface PopoutEntry { keys: FlashAccountKeys; at: number; source?: string; lot?: FlashLot; qty?: FlashQtySetting; credit?: FlashCredit; order?: FlashOrderOpts }

/** The opening panel's own settings handed to its popout. */
export interface FlashPanelSeed { lot?: FlashLot; qty?: FlashQtySetting; credit?: FlashCredit; order?: FlashOrderOpts }

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
            if (entry && isKeys(entry.keys)) out[id] = {
                keys: entry.keys,
                at: Number(entry.at) || 0,
                ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                ...(isFlashLot(entry.lot) ? { lot: entry.lot } : {}),
                ...(entry.qty !== undefined ? { qty: sanitizeFlashQtySetting(entry.qty) } : {}),
                ...(normalizeFlashCredit(entry.credit) ? { credit: normalizeFlashCredit(entry.credit) } : {}),
                ...(normalizeFlashOrderOpts(entry.order) ? { order: normalizeFlashOrderOpts(entry.order) } : {}),
            };
        }
        return out;
    } catch {
        return {};
    }
}

// Read-modify-write of the shared map: always re-read right before writing
// (never from a cached copy) and change only this window's entry. Another
// window's entry can only be lost if both writes land in the same instant —
// localStorage has no transactions, and each write is synchronous.
// panel: only the fields present are changed; a present `qty: undefined`
// removes the entry's quantities (back to the default)
function writePopoutEntry(id: string, keys: FlashAccountKeys, source?: string, panel?: FlashPanelSeed): void {
    try {
        const all = readPopoutEntries();
        const next: PopoutEntry = { ...all[id], ...(source ? { source } : {}), keys, at: Date.now() };
        if (panel?.lot) next.lot = panel.lot;
        if (panel?.credit) next.credit = { ...panel.credit };
        if (panel?.order) next.order = { ...panel.order };
        if (panel && 'qty' in panel) {
            if (panel.qty === undefined) delete next.qty;
            else next.qty = panel.qty;
        }
        all[id] = next;
        const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, POPOUT_MAX_ENTRIES);
        localStorage.setItem(POPOUT_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch { /* best effort */ }
}

export function newPopoutWindowId(): string {
    return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Opener side: hand the pinned accounts (and the panel's unit) to a new popout. */
export function seedPopoutFlashAccounts(windowId: string, keys: FlashAccountKeys, panel?: FlashPanelSeed): void {
    writePopoutEntry(windowId, { ...keys }, undefined, panel);
}

/**
 * Popout side: its pinned/saved choice (`{}` when none — the user must pick
 * one; popouts never follow the main window). Loading
 * also marks the record as recently seen, so eviction drops the popouts
 * that were closed longest ago, not the ones merely unchanged for a while.
 */
export function loadPopoutFlashAccounts(windowId: string | null): FlashAccountKeys {
    if (!windowId) return {};
    const keys = readPopoutEntries()[windowId]?.keys;
    if (keys) writePopoutEntry(windowId, keys);
    return keys ?? {};
}

/** Keep an open popout's record fresh (called periodically while open). */
export function touchPopoutFlashAccounts(windowId: string | null): void {
    if (!windowId) return;
    const keys = readPopoutEntries()[windowId]?.keys;
    if (keys) writePopoutEntry(windowId, keys);
}

export function savePopoutFlashAccounts(windowId: string | null, keys: FlashAccountKeys): void {
    if (windowId) writePopoutEntry(windowId, keys);
}

/** The popout's own unit; undefined = never chosen (use the 設為預設 unit). */
export function loadPopoutFlashLot(windowId: string | null): FlashLot | undefined {
    return windowId ? readPopoutEntries()[windowId]?.lot : undefined;
}

export function savePopoutFlashLot(windowId: string | null, lot: FlashLot): void {
    if (!windowId) return;
    writePopoutEntry(windowId, readPopoutEntries()[windowId]?.keys ?? {}, undefined, { lot });
}

/** The popout's 記住數量 setting; undefined = never saved (default on, nothing remembered). */
export function loadPopoutFlashQty(windowId: string | null): FlashQtySetting | undefined {
    return windowId ? readPopoutEntries()[windowId]?.qty : undefined;
}

export function savePopoutFlashQty(windowId: string | null, qty: FlashQtySetting): void {
    if (!windowId) return;
    writePopoutEntry(windowId, readPopoutEntries()[windowId]?.keys ?? {}, undefined, { qty });
}

/** The popout's own credit condition; undefined = never chosen (現股). */
export function loadPopoutFlashCredit(windowId: string | null): FlashCredit | undefined {
    return windowId ? readPopoutEntries()[windowId]?.credit : undefined;
}

/** The popout's own order conditions; undefined = never chosen (defaults). */
export function loadPopoutFlashOrder(windowId: string | null): FlashOrderOpts | undefined {
    return windowId ? readPopoutEntries()[windowId]?.order : undefined;
}

export function savePopoutFlashOrder(windowId: string | null, order: FlashOrderOpts): void {
    if (!windowId) return;
    writePopoutEntry(windowId, readPopoutEntries()[windowId]?.keys ?? {}, undefined, { order });
}

export function savePopoutFlashCredit(windowId: string | null, credit: FlashCredit): void {
    if (!windowId) return;
    writePopoutEntry(windowId, readPopoutEntries()[windowId]?.keys ?? {}, undefined, { credit });
}

export interface GlobalFlashSelection {
    S?: Account | null;
    F?: Account | null;
}

/**
 * Popouts cannot follow the main window live (each window has its own
 * account store), so a popout pins its accounts when it opens: the panel's
 * own choice, or — for a market where the panel follows main — the main
 * selection at that moment. Unavailable / wrong-market accounts are never pinned.
 */
export function pinnedFlashAccounts(panelKeys: FlashAccountKeys | undefined, global: GlobalFlashSelection): FlashAccountKeys {
    const out: FlashAccountKeys = {};
    for (const market of ['S', 'F'] as const) {
        const own = panelKeys?.[market];
        const main = global[market];
        if (own) out[market] = own;
        else if (main && canTrade(main) && main.account_type === market) out[market] = flashAccountKey(main);
    }
    return out;
}

/**
 * URL params for a flash popout. Each panel/tile is one stable popout source;
 * reopening it (including after an App restart) reuses its window id.
 * Different panels of the same product remain independent. Only the opaque
 * window id goes into the URL.
 */
export function flashPopoutParams(panelKeys: FlashAccountKeys | undefined, global: GlobalFlashSelection, source?: string, panel?: FlashPanelSeed): { win: string } {
    if (source) {
        const old = Object.entries(readPopoutEntries()).find(([, entry]) => entry.source === source);
        if (old) {
            return { win: old[0] };
        }
    }
    const win = newPopoutWindowId();
    writePopoutEntry(win, pinnedFlashAccounts(panelKeys, global), source, panel);
    return { win };
}

/**
 * Called only when the opener has confirmed that it created a window. A panel
 * passes its unit so the popout opens on it; a tile (no panel) passes none and
 * keeps the unit its window last used. The popout's 記住數量 setting is its own:
 * only a brand-new window id is seeded with the panel's (flashPopoutParams).
 */
export function reseedPopoutFlashAccounts(windowId: string, panelKeys: FlashAccountKeys | undefined, global: GlobalFlashSelection, panel?: Pick<FlashPanelSeed, 'lot' | 'credit' | 'order'>): void {
    const seed: FlashPanelSeed = {
        ...(panel?.lot ? { lot: panel.lot } : {}),
        ...(panel?.credit ? { credit: panel.credit } : {}),
        ...(panel?.order ? { order: panel.order } : {}),
    };
    seedPopoutFlashAccounts(windowId, pinnedFlashAccounts(panelKeys, global), Object.keys(seed).length ? seed : undefined);
}
