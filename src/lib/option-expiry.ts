// src/lib/option-expiry.ts — 臺指選擇權 T 字報價的到期契約（issue #152）
//
// 月選（TXO）與週選在合約資料裡是不同的商品代碼（TX1/TX5 週三、
// TXU/TXY 週五…），所以一個「到期契約」以 (root, delivery_date) 為鍵，
// 不能再只用 delivery_month 分組。週選代碼由 options/roots 動態發現，
// 再以合約的 underlying_code 與月選比對，避免誤收其他指數選擇權。

import type { ContractInfo } from './types/contract';

export const MONTHLY_ROOT = 'TXO';

// 交易所預留、尚未掛牌的週選只有零星占位合約；少於此數的到期不列出
export const MIN_EXPIRY_CONTRACTS = 10;

export type ExpiryKind = 'monthly' | 'wed' | 'fri' | 'weekly';

export interface ChainContract extends ContractInfo {
    delivery_month: string;
    delivery_date: string;
    strike_price: number;
    option_right: string;
    expiry_weekday?: string;
    week_of_month?: number;
}

export interface OptionExpiry {
    key: string; // `${root}:${delivery_date}`
    root: string;
    date: string; // YYYY-MM-DD
    month: string; // YYYYMM（到期日所在月份，用於分組）
    kind: ExpiryKind;
    daysLeft: number;
    contracts: number;
}

export const KIND_LABEL: Record<ExpiryKind, string> = {
    monthly: '月',
    wed: '週三',
    fri: '週五',
    weekly: '週',
};

export const KIND_TITLE: Record<ExpiryKind, string> = {
    monthly: '月選',
    wed: '週三週選',
    fri: '週五週選',
    weekly: '週選',
};

export function expiryKey(root: string, date: string): string {
    return `${root}:${date}`;
}

/** 台北當地日期 YYYY-MM-DD（UTC+8，無日光節約）。 */
export function taipeiToday(now: number = Date.now()): string {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
    return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function daysBetween(from: string, to: string): number {
    return dayNumber(to) - dayNumber(from);
}

/**
 * 從 options/roots 挑出可能屬於臺指選擇權家族的商品代碼（月選＋週選）。
 * roots 只帶 root/name：以月選的名稱前綴或 TX? 三碼慣例判斷，最終
 * 是否納入仍由合約的 underlying_code 決定（見 buildExpiries）。
 */
export function pickChainRoots(
    roots: { root: string; name?: string }[],
    monthlyRoot: string = MONTHLY_ROOT,
): string[] {
    const monthlyName = roots.find((r) => r.root === monthlyRoot)?.name?.trim();
    const prefix = monthlyRoot.slice(0, 2);
    const picked = roots
        .filter(
            (r) =>
                r.root === monthlyRoot ||
                (monthlyName && r.name?.trim().startsWith(monthlyName)) ||
                (r.root.length === monthlyRoot.length &&
                    r.root.startsWith(prefix)),
        )
        .map((r) => r.root);
    return [monthlyRoot, ...new Set(picked.filter((r) => r !== monthlyRoot))];
}

export function isChainContract(c: ContractInfo): c is ChainContract {
    return (
        c.security_type === 'OPT' &&
        typeof c.delivery_month === 'string' &&
        typeof c.delivery_date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(c.delivery_date) &&
        typeof c.strike_price === 'number' &&
        typeof c.option_right === 'string'
    );
}

function kindOf(c: ChainContract, monthlyRoot: string): ExpiryKind {
    if (c.root === monthlyRoot) return 'monthly';
    const wd = (c.expiry_weekday ?? '').toLowerCase();
    if (wd.startsWith('wed')) return 'wed';
    if (wd.startsWith('fri')) return 'fri';
    return 'weekly';
}

/**
 * 依 (root, delivery_date) 分組成到期契約，排除已到期與只有占位合約的，
 * 依到期日排序（同日月選在前）。underlying 與月選不同的合約不納入。
 */
export function buildExpiries(
    contracts: ChainContract[],
    today: string,
    monthlyRoot: string = MONTHLY_ROOT,
): OptionExpiry[] {
    const underlying = contracts.find(
        (c) => c.root === monthlyRoot && c.underlying_code,
    )?.underlying_code;
    const groups = new Map<string, OptionExpiry>();
    for (const c of contracts) {
        const root = c.root ?? monthlyRoot;
        if (underlying && c.underlying_code && c.underlying_code !== underlying)
            continue;
        if (c.delivery_date < today) continue;
        const key = expiryKey(root, c.delivery_date);
        const g = groups.get(key);
        if (g) {
            g.contracts += 1;
            continue;
        }
        groups.set(key, {
            key,
            root,
            date: c.delivery_date,
            month: c.delivery_date.slice(0, 7).replace('-', ''),
            kind: kindOf({ ...c, root }, monthlyRoot),
            daysLeft: daysBetween(today, c.delivery_date),
            contracts: 1,
        });
    }
    return [...groups.values()]
        .filter((g) => g.contracts >= MIN_EXPIRY_CONTRACTS)
        .sort(
            (a, b) =>
                a.date.localeCompare(b.date) ||
                Number(b.kind === 'monthly') - Number(a.kind === 'monthly') ||
                a.root.localeCompare(b.root),
        );
}

/** 記住的選擇仍在列表中就沿用，否則（已到期／下架）改選最近到期的。 */
export function resolveExpiry(
    expiries: OptionExpiry[],
    saved: string | null | undefined,
): string {
    if (saved && expiries.some((e) => e.key === saved)) return saved;
    return expiries[0]?.key ?? '';
}

export function contractsForExpiry(
    contracts: ChainContract[],
    key: string,
    monthlyRoot: string = MONTHLY_ROOT,
): ChainContract[] {
    return contracts.filter(
        (c) => expiryKey(c.root ?? monthlyRoot, c.delivery_date) === key,
    );
}

export function groupByMonth(
    expiries: OptionExpiry[],
): { month: string; items: OptionExpiry[] }[] {
    const out: { month: string; items: OptionExpiry[] }[] = [];
    for (const e of expiries) {
        const last = out[out.length - 1];
        if (last && last.month === e.month) last.items.push(e);
        else out.push({ month: e.month, items: [e] });
    }
    return out;
}

export function daysLeftLabel(days: number): string {
    return days <= 0 ? '今日' : `${days}天`;
}

export function expiryTitle(e: OptionExpiry): string {
    const [y, m, d] = e.date.split('-');
    return `${y}/${m}/${d} 到期 · ${KIND_TITLE[e.kind]}（${e.root}）· ${
        e.daysLeft <= 0 ? '今日到期' : `剩 ${e.daysLeft} 天`
    }`;
}
