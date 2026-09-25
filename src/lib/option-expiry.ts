// src/lib/option-expiry.ts — 臺指選擇權 T 字報價的到期契約（issue #152）
//
// 月選（TXO）與週選在合約資料裡是不同的商品代碼（TX1/TX5 週三、
// TXU/TXY 週五…），所以一個「到期契約」以 (root, delivery_date) 為鍵，
// 不能再只用 delivery_month 分組。週選代碼由 options/roots 動態發現，
// 再以合約的 underlying_code 與月選比對，避免誤收其他指數選擇權。

import type { ContractInfo } from './types/contract';

export const MONTHLY_ROOT = 'TXO';
// roots 沒有月選名稱時用來辨識臺指選擇權家族的名稱前綴
export const FAMILY_NAME = '臺指選擇權';

// 交易所預留、尚未掛牌的週選只有零星占位合約；少於此數的到期不列出
export const MIN_EXPIRY_CONTRACTS = 10;

// 到期日一般盤 13:45 收盤後，該到期就不再列出（台北時間，分鐘）
export const DAY_SESSION_CLOSE = 13 * 60 + 45;

export type ExpiryKind = 'monthly' | 'wed' | 'fri' | 'weekly';

export interface ChainContract extends ContractInfo {
    delivery_month: string;
    delivery_date: string;
    strike_price: number;
    option_right: string;
}

export interface OptionExpiry {
    key: string; // `${root}:${delivery_date}`
    root: string;
    date: string; // YYYY-MM-DD
    month: string; // YYYYMM（到期日所在月份，用於分組）
    deliveryMonth: string; // 合約的 delivery_month（舊版記憶值遷移用）
    kind: ExpiryKind;
    weekday: number; // delivery_date 的實際星期（0=日）
    // 原定到期星期與實際不同（遇假日調整）時為原定星期，否則 null
    shiftedFrom: number | null;
    daysLeft: number;
    contracts: number;
}

/** 台北當地的日期與時刻（UTC+8，無日光節約）。 */
export interface ExpiryClock {
    date: string; // YYYY-MM-DD
    minutes: number; // 當日第幾分鐘
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

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_EN = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function expiryKey(root: string, date: string): string {
    return `${root}:${date}`;
}

const TAIPEI_OFFSET = 8 * 3600_000;

export function taipeiClock(now: number = Date.now()): ExpiryClock {
    const t = new Date(now + TAIPEI_OFFSET);
    return {
        date: t.toISOString().slice(0, 10),
        minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
    };
}

export function taipeiToday(now: number = Date.now()): string {
    return taipeiClock(now).date;
}

/** 距離下一個會改變到期列表的時刻（13:45 收盤或台北午夜）的毫秒數。 */
export function msUntilNextBoundary(now: number = Date.now()): number {
    const local = now + TAIPEI_OFFSET;
    const dayStart = Math.floor(local / 86_400_000) * 86_400_000;
    const close = dayStart + DAY_SESSION_CLOSE * 60_000;
    const next = local < close ? close : dayStart + 86_400_000;
    return next - local;
}

function dayNumber(date: string): number {
    return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function daysBetween(from: string, to: string): number {
    return dayNumber(to) - dayNumber(from);
}

function weekdayOf(date: string): number {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function parseWeekday(s: string | undefined): number | null {
    if (!s) return null;
    const i = WEEKDAY_EN.indexOf(s.trim().slice(0, 3).toLowerCase());
    return i >= 0 ? i : null;
}

/** 到期日一般盤收盤前仍列出；之後視為已到期。 */
export function isLiveExpiry(date: string, clock: ExpiryClock): boolean {
    return (
        date > clock.date ||
        (date === clock.date && clock.minutes < DAY_SESSION_CLOSE)
    );
}

/**
 * 從 options/roots 挑出臺指選擇權家族的商品代碼（月選＋週選）。
 * 有名稱時必須以月選名稱（臺指選擇權）開頭；沒有名稱才用 TX? 三碼
 * 慣例。最終是否納入仍由合約的 underlying_code 決定（見 buildExpiries）。
 */
export function pickChainRoots(
    roots: { root: string; name?: string | null }[],
    monthlyRoot: string = MONTHLY_ROOT,
): string[] {
    const familyName =
        roots.find((r) => r.root === monthlyRoot)?.name?.trim() || FAMILY_NAME;
    const pattern = new RegExp(`^${monthlyRoot.slice(0, 2)}[0-9A-Z]$`);
    const picked = roots
        .filter((r) => {
            if (r.root === monthlyRoot) return false;
            const name = r.name?.trim();
            return name ? name.startsWith(familyName) : pattern.test(r.root);
        })
        .map((r) => r.root);
    return [monthlyRoot, ...new Set(picked)];
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

/** 月選的 underlying；月選沒載到時取週選中最多的 underlying。 */
export function chainUnderlying(
    contracts: ChainContract[],
    monthlyRoot: string = MONTHLY_ROOT,
): string | undefined {
    const monthly = contracts.find(
        (c) => c.root === monthlyRoot && c.underlying_code,
    )?.underlying_code;
    if (monthly) return monthly;
    const counts = new Map<string, number>();
    for (const c of contracts)
        if (c.underlying_code)
            counts.set(c.underlying_code, (counts.get(c.underlying_code) ?? 0) + 1);
    let best: string | undefined;
    let bestN = 0;
    for (const [code, n] of counts)
        if (n > bestN) {
            best = code;
            bestN = n;
        }
    return best;
}

/**
 * 依 (root, delivery_date) 分組成到期契約，排除已到期（含到期日收盤後）
 * 與只有占位合約的，依到期日排序（同日月選在前）。underlying 與月選不同
 * 或缺 underlying 的合約不納入。
 */
export function buildExpiries(
    contracts: ChainContract[],
    clock: ExpiryClock | string,
    monthlyRoot: string = MONTHLY_ROOT,
): OptionExpiry[] {
    const now: ExpiryClock =
        typeof clock === 'string' ? { date: clock, minutes: 0 } : clock;
    const underlying = chainUnderlying(contracts, monthlyRoot);
    const groups = new Map<string, OptionExpiry>();
    for (const c of contracts) {
        const root = c.root ?? monthlyRoot;
        if (underlying && c.underlying_code !== underlying) continue;
        if (!isLiveExpiry(c.delivery_date, now)) continue;
        const key = expiryKey(root, c.delivery_date);
        const g = groups.get(key);
        if (g) {
            g.contracts += 1;
            continue;
        }
        const weekday = weekdayOf(c.delivery_date);
        const scheduled = parseWeekday(c.expiry_weekday);
        const kindDay = scheduled ?? weekday;
        groups.set(key, {
            key,
            root,
            date: c.delivery_date,
            month: c.delivery_date.slice(0, 7).replace('-', ''),
            deliveryMonth: c.delivery_month,
            kind:
                root === monthlyRoot
                    ? 'monthly'
                    : kindDay === 3
                      ? 'wed'
                      : kindDay === 5
                        ? 'fri'
                        : 'weekly',
            weekday,
            shiftedFrom:
                scheduled !== null && scheduled !== weekday ? scheduled : null,
            daysLeft: daysBetween(now.date, c.delivery_date),
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

/** 舊版只記月份（YYYYMM）：對應到該月的月選到期；找不到回 null。 */
export function migrateLegacyMonth(
    expiries: OptionExpiry[],
    month: string | null | undefined,
): string | null {
    if (!month) return null;
    return (
        expiries.find((e) => e.kind === 'monthly' && e.deliveryMonth === month)
            ?.key ?? null
    );
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
    return [
        `${y}/${m}/${d}（${WEEKDAY_ZH[e.weekday]}）到期`,
        `${KIND_TITLE[e.kind]}（${e.root}）`,
        e.shiftedFrom !== null
            ? `原定週${WEEKDAY_ZH[e.shiftedFrom]}，遇假日調整為週${WEEKDAY_ZH[e.weekday]}`
            : null,
        e.daysLeft <= 0 ? '今日到期' : `剩 ${e.daysLeft} 天`,
    ]
        .filter(Boolean)
        .join(' · ');
}

export interface AtmReference {
    label: string;
    value: number;
    change?: number;
}

/** 依序取第一個有效的價格作為 T 字置中基準（標的指數 → 台指期 → 無）。 */
export function chooseAtmReference(
    candidates: {
        label: string;
        value: number | null | undefined;
        change?: number | null;
    }[],
): AtmReference | null {
    for (const c of candidates)
        if (typeof c.value === 'number' && Number.isFinite(c.value) && c.value > 0)
            return {
                label: c.label,
                value: c.value,
                ...(typeof c.change === 'number' && Number.isFinite(c.change)
                    ? { change: c.change }
                    : {}),
            };
    return null;
}

/** 標的指數的簡短顯示名稱。 */
export function underlyingLabel(code: string): string {
    return code === 'IX0001' ? '加權' : code;
}
