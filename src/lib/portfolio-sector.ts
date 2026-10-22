// src/lib/portfolio-sector.ts — 持股 × 族群資金：把庫存股票對到族群（官方產業別）、
// 產業鏈（含上中下游）或題材，並用 產業鏈資金流向 的同一本 1 分 K 帳（chainFlowBook）
// 算出每個分組與每檔持股的即時資金流。
//
// 資料來源（不新增輪詢）：
// - 庫存：useTradingState().positions（既有持倉查詢＋成交回報本機估算），只取現股多單。
// - 價格：chainFlowBook 的最新價（1 分 K 收盤或其他面板既有 tick），沒有時用持倉的 last_price。
// - 分組：shioaji-data tw/cards（官方產業別、主要產業鏈與位置、主要題材）＋ tw/themes。
// - 不在產業鏈／題材成分內的持股，由面板以 drill scope 補訂 1 分 K（通常 1 個 POST）。

import { useEffect, useMemo, useState } from 'react';
import { codePct, groupFlow, type FlowBook, type GroupFlow } from './chain-flow';
import { themeCodes } from './chain-map';
import { icKeyOf } from './sector-flow-ic';
import { companyData } from './company-data';
import type { ChainTier, Theme } from './company-data/types';
import { useTradingState } from './trading-state';
import type { Trade } from './types/order';
import type { AccountedPosition } from './types/portfolio';

export type Grouping = 'sector' | 'chain' | 'theme';
export const GROUPINGS = ['sector', 'chain', 'theme'] as const;
export const GROUPING_LABEL: Record<Grouping, string> = { sector: '族群', chain: '產業鏈', theme: '題材' };

/** Minutes of the "近期" window every variant reads (matches 輪動). */
export const RECENT_MIN = 10;

// ── holdings source ─────────────────────────────────────────────────────────

export interface RawHolding {
    code: string;
    /** Shares (not lots). */
    shares: number;
    /** Average cost per share. */
    cost: number;
    /** Last price from the positions query (fallback when the book has none). */
    last: number;
    /**
     * Shares still held that were bought today at a known price, and what they
     * cost (Σ shares × fill price). Every other share moves from the reference.
     */
    todayShares: number;
    todayCost: number;
}

const LOT = 1000;

/** Taipei calendar day of an epoch timestamp in seconds, ms or ns. */
function taipeiDay(ts: number): number {
    const ms = ts > 1e17 ? ts / 1e6 : ts > 1e14 ? ts / 1e3 : ts > 1e11 ? ts : ts * 1000;
    return Math.floor((ms + 8 * 3_600_000) / 86_400_000);
}

type AccountRef = { broker_id: string; account_id: string } | null | undefined;

/** Per-account key: today's buys only reclassify shares of the account that bought them. */
export function buyKey(account: AccountRef, code: string): string {
    return `${account?.broker_id ?? ''}|${account?.account_id ?? ''}|${code}`;
}

/**
 * Today's cash buy fills per account and code from the orders query plus deal reports
 * (useTradingState().trades): shares (lots × 1000 unless odd lot) and the
 * volume-weighted fill price. Margin buys and other conditions are a
 * different position and are left out, like the positions rows.
 */
export function todayBuys(trades: readonly (Trade & { account?: AccountRef })[], nowMs = Date.now()): Map<string, { shares: number; avg: number }> {
    const today = taipeiDay(nowMs);
    const acc = new Map<string, { shares: number; cost: number }>();
    for (const t of trades) {
        const o = t.order;
        if (o.action !== 'Buy' || (o.account && o.account.account_type !== 'S')) continue;
        if ((o.order_cond ?? 'Cash') !== 'Cash' || o.daytrade_short) continue;
        const code = buyKey(t.account ?? o.account, t.contract.code);
        const unit = o.order_lot === 'Odd' || o.order_lot === 'IntradayOdd' ? 1 : LOT;
        for (const d of t.status?.deals ?? []) {
            if (!(d.quantity > 0) || !(d.price > 0)) continue;
            if (d.ts && taipeiDay(d.ts) !== today) continue;
            const e = acc.get(code) ?? { shares: 0, cost: 0 };
            e.shares += d.quantity * unit;
            e.cost += d.quantity * unit * d.price;
            acc.set(code, e);
        }
    }
    const out = new Map<string, { shares: number; avg: number }>();
    for (const [code, e] of acc) if (e.shares > 0) out.set(code, { shares: e.shares, avg: e.cost / e.shares });
    return out;
}

/**
 * Today's P&L of a holding. Shares carried from yesterday move from the
 * reference price; shares bought today move from their fill price (a stock
 * bought today at 105 with reference 100 and last 106 made 1, not 6).
 */
export function dayPnlOf(h: RawHolding, last: number, ref: number | null): number {
    if (!ref) return 0;
    const today = Math.min(h.shares, h.todayShares);
    const todayCost = h.todayShares > 0 ? (h.todayCost * today) / h.todayShares : 0;
    return (h.shares - today) * (last - ref) + today * last - todayCost;
}

/**
 * Shares of one position row bought today at a known price: today's buy fills
 * of that account capped by the row; without fills, a row new today
 * (yd_quantity 0) at its average cost (= the fill price). A row that only
 * added to yesterday's shares without fills moves from the reference.
 */
function rowToday(quantity: number, yd: number | null, cost: number, buy: { shares: number; avg: number } | undefined) {
    if (buy) {
        const shares = Math.min(quantity, buy.shares);
        return { shares, cost: shares * buy.avg };
    }
    if (yd === 0 && cost > 0) return { shares: quantity, cost: quantity * cost };
    return { shares: 0, cost: 0 };
}

/** Long cash stock rows merged by code across accounts (weighted average cost). */
export function fromPositions(
    positions: readonly AccountedPosition[],
    trades: readonly (Trade & { account?: AccountRef })[] = [],
    nowMs = Date.now(),
): RawHolding[] {
    const buys = todayBuys(trades, nowMs);
    const byCode = new Map<string, RawHolding>();
    for (const p of positions) {
        // stock rows carry yd_quantity; long cash only (margin and short sales are a different exposure)
        if (!('yd_quantity' in p) || p.direction !== 'Buy' || !(p.quantity > 0)) continue;
        if ((p.cond ?? 'Cash') !== 'Cash') continue;
        const yd = Number.isFinite(p.yd_quantity) ? Math.max(0, p.yd_quantity) : null;
        const today = rowToday(p.quantity, yd, p.price, buys.get(buyKey(p.account, p.code)));
        const prev = byCode.get(p.code);
        if (prev) {
            const shares = prev.shares + p.quantity;
            prev.cost = (prev.cost * prev.shares + p.price * p.quantity) / shares;
            prev.shares = shares;
            prev.last = p.last_price || prev.last;
            prev.todayShares += today.shares;
            prev.todayCost += today.cost;
        } else {
            byCode.set(p.code, {
                code: p.code,
                shares: p.quantity,
                cost: p.price,
                last: p.last_price,
                todayShares: today.shares,
                todayCost: today.cost,
            });
        }
    }
    return [...byCode.values()];
}

export interface HoldingsState {
    phase: 'loading' | 'ready' | 'failed';
    holdings: RawHolding[];
    error: string | null;
}

/**
 * With an error, show whatever is held (partial or retained rows, with the
 * error noted) or else the failure — never "no holdings" and never an endless
 * loading: a failed refresh keeps the last timestamp, and a first refresh
 * where one account failed has none.
 */
export function holdingsPhase(updatedAt: number | null | undefined, error: string | null, count: number): HoldingsState['phase'] {
    if (error) return count > 0 ? 'ready' : 'failed';
    return updatedAt ? 'ready' : 'loading';
}

/** Stock holdings across every account in view (no extra request). */
export function useHoldings(): HoldingsState {
    const trading = useTradingState();
    const { positions, trades } = trading;
    const q = trading.queries.positions;
    return useMemo(() => {
        const holdings = fromPositions(positions, trades);
        return { phase: holdingsPhase(q.updatedAt, q.error ?? null, holdings.length), holdings, error: q.error ?? null };
    }, [positions, trades, q.updatedAt, q.error]);
}

// ── company cards: industry, primary chain and tier, main theme ─────────────

export interface CardInfo {
    code: string;
    name: string;
    market: string;
    industry: string | null;
    industryCode: string | null;
    chain: string | null;
    tier: ChainTier | null;
    mainTheme: string | null;
}

let cardsPromise: Promise<Map<string, CardInfo>> | null = null;

function loadCards(): Promise<Map<string, CardInfo>> {
    cardsPromise ??= companyData.getDataset('tw/cards').then(({ data }) => {
        const map = new Map<string, CardInfo>();
        for (const raw of data as Record<string, unknown>[]) {
            const code = typeof raw.code === 'string' ? raw.code : null;
            if (!code) continue;
            const ind = (raw.industry ?? {}) as Record<string, unknown>;
            const stage = (raw.chain_stage ?? null) as Record<string, unknown> | null;
            map.set(code, {
                code,
                name: typeof raw.name === 'string' ? raw.name : code,
                market: typeof raw.market === 'string' ? raw.market : 'twse',
                industry: typeof ind.l0_name === 'string' ? ind.l0_name : null,
                industryCode: typeof ind.l0_code === 'string' ? ind.l0_code : null,
                chain: typeof raw.chain === 'string' ? raw.chain : null,
                tier: stage && typeof stage.tier === 'string' ? (stage.tier as ChainTier) : null,
                mainTheme: typeof raw.main_theme === 'string' ? raw.main_theme : null,
            });
        }
        return map;
    });
    cardsPromise.catch(() => {
        cardsPromise = null;
    });
    return cardsPromise;
}

export function useCards(enabled = true) {
    const [cards, setCards] = useState<Map<string, CardInfo> | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        loadCards().then(
            (m) => alive && setCards(m),
            (e) => alive && setError(e instanceof Error ? e.message : String(e)),
        );
        return () => {
            alive = false;
        };
    }, [enabled]);
    return { cards, error };
}

// ── grouping ────────────────────────────────────────────────────────────────

export interface GroupDef {
    id: string;
    name: string;
    /** Member codes used for the group's flow (all known members). */
    codes: string[];
    /** 族群 only: the industry's groups in the index_components stream (TWSE and TPEx). */
    icKeys?: string[];
}

const UNGROUPED: GroupDef = { id: 'none', name: '未歸類', codes: [] };

/** Primary group of a code under a grouping, plus its chain tier (chain only). */
export interface Assignment {
    group: GroupDef;
    tier: ChainTier | null;
    /** 產業鏈／題材: the stock's other chains or themes (tooltip only, never counted). */
    others: string[];
}

export function buildAssigner(grouping: Grouping, themes: readonly Theme[], cards: ReadonlyMap<string, CardInfo>) {
    const byId = new Map(themes.map((t) => [t.id, t]));
    const defs = new Map<string, GroupDef>();
    const themeDef = (t: Theme) => {
        let d = defs.get(t.id);
        if (!d) {
            d = { id: t.id, name: t.name, codes: themeCodes(t) };
            defs.set(t.id, d);
        }
        return d;
    };
    // industry members, built once
    let industries: Map<string, GroupDef> | null = null;
    const industryDef = (name: string) => {
        if (!industries) {
            industries = new Map();
            for (const c of cards.values()) {
                if (!c.industry) continue;
                const d = industries.get(c.industry) ?? { id: `ind.${c.industryCode ?? c.industry}`, name: c.industry, codes: [], icKeys: [] };
                d.codes.push(c.code);
                const key = icKeyOf(c.market, c.industryCode);
                if (key && !d.icKeys!.includes(key)) d.icKeys!.push(key);
                industries.set(c.industry, d);
            }
        }
        return industries.get(name) ?? UNGROUPED;
    };
    const owners = (code: string, kind: 'chain' | 'theme') =>
        themes.filter((t) => t.kind === kind && t.members.some((m) => m.id === `tw.${code}`));
    const tierIn = (t: Theme, code: string) => t.members.find((m) => m.id === `tw.${code}`)?.tier ?? null;

    const othersOf = (list: readonly Theme[], primary: Theme) => list.filter((x) => x.id !== primary.id).map((x) => x.name);

    return (code: string): Assignment => {
        const card = cards.get(code);
        if (grouping === 'sector') {
            return { group: card?.industry ? industryDef(card.industry) : UNGROUPED, tier: null, others: [] };
        }
        if (grouping === 'chain') {
            const all = owners(code, 'chain');
            const primary = card?.chain ? byId.get(card.chain) : undefined;
            const t = primary && primary.kind === 'chain' ? primary : (all.find((x) => x.id !== 'chain.finance') ?? all[0]);
            if (!t) return { group: UNGROUPED, tier: null, others: [] };
            return { group: themeDef(t), tier: tierIn(t, code) ?? card?.tier ?? null, others: othersOf(all, t) };
        }
        // 題材: the primary theme only (weights add up to 100 %); the others go to the tooltip
        const all = owners(code, 'theme');
        const main = card?.mainTheme ? byId.get(card.mainTheme) : undefined;
        const t = main && main.kind === 'theme' && main.members.some((m) => m.id === `tw.${code}`) ? main : all[0];
        return t ? { group: themeDef(t), tier: null, others: othersOf(all, t) } : { group: UNGROUPED, tier: null, others: [] };
    };
}

/** Tooltip line listing a stock's other chains / themes (empty when none). */
export function othersNote(others: readonly string[], label: string, max = 6): string {
    if (others.length === 0) return '';
    const shown = others.slice(0, max).join('、');
    return `\n其他${label}：${shown}${others.length > max ? ` 等 ${others.length} 個` : ''}`;
}

// ── live figures ────────────────────────────────────────────────────────────

export interface WindowFlow {
    net: number;
    turnover: number;
    /** net ÷ turnover in %, null without turnover. */
    ratio: number | null;
}

function windowOf(net: ArrayLike<number>, turnover: ArrayLike<number>, now: number | null, minutes: number | null): WindowFlow {
    if (now === null) return { net: 0, turnover: 0, ratio: null };
    const start = minutes === null ? 0 : Math.max(0, now - minutes + 1);
    let n = 0;
    let t = 0;
    for (let i = start; i <= now; i += 1) {
        n += net[i]!;
        t += turnover[i]!;
    }
    return { net: n, turnover: t, ratio: t > 0 ? (n / t) * 100 : null };
}

export interface HeldStock {
    code: string;
    name: string;
    shares: number;
    cost: number;
    last: number;
    ref: number | null;
    value: number;
    /** Unrealized P&L since cost. */
    pnl: number;
    pnlPct: number | null;
    /** Today's P&L on the position (shares bought today from their fill price, see dayPnlOf). */
    dayPnl: number;
    dayPct: number | null;
    /** Weight in the portfolio by market value (0–1). */
    weight: number;
    groupId: string;
    tier: ChainTier | null;
    /** Other chains / themes the stock belongs to (tooltip only). */
    others: string[];
    /** The stock's own flow over the recent window and since the panel opened. */
    recent: WindowFlow;
    cum: WindowFlow;
    /** Per-minute net of the stock (for sparklines / particles). */
    netSeries: Float64Array | null;
}

export interface HeldGroup {
    id: string;
    name: string;
    stocks: HeldStock[];
    value: number;
    weight: number;
    dayPnl: number;
    pnl: number;
    /** The whole group's flow (all members in the book). */
    flow: GroupFlow;
    recent: WindowFlow;
    cum: WindowFlow;
    /** Members with K-bars / all members (coverage of the flow figures). */
    covered: number;
    members: number;
}

export interface PortfolioView {
    stocks: HeldStock[];
    groups: HeldGroup[];
    total: number;
    dayPnl: number;
    pnl: number;
    /** Share of market value whose group is a recent net inflow (0–1). */
    alignedShare: number;
}

export function portfolioView(
    holdings: readonly RawHolding[],
    assign: (code: string) => Assignment,
    book: FlowBook,
    now: number | null,
    nameOf: (code: string) => string,
    /** Group flow from another source (族群: index_components); null falls back to the book. */
    flowOf?: (def: GroupDef) => GroupFlow | null,
): PortfolioView {
    const stocks: HeldStock[] = holdings.map((h) => {
        const flow = book.codes.get(h.code);
        const last = flow?.last ?? h.last;
        const ref = flow?.ref ?? null;
        const a = assign(h.code);
        const value = last * h.shares;
        return {
            code: h.code,
            name: nameOf(h.code),
            shares: h.shares,
            cost: h.cost,
            last,
            ref,
            value,
            pnl: (last - h.cost) * h.shares,
            pnlPct: h.cost > 0 ? ((last - h.cost) / h.cost) * 100 : null,
            dayPnl: dayPnlOf(h, last, ref),
            dayPct: codePct(flow),
            weight: 0,
            groupId: a.group.id,
            tier: a.tier,
            others: a.others,
            recent: flow ? windowOf(flow.net, flow.amount, now, RECENT_MIN) : { net: 0, turnover: 0, ratio: null },
            cum: flow ? windowOf(flow.net, flow.amount, now, null) : { net: 0, turnover: 0, ratio: null },
            netSeries: flow?.net ?? null,
        };
    });
    const total = stocks.reduce((s, x) => s + x.value, 0);
    for (const s of stocks) s.weight = total > 0 ? s.value / total : 0;

    const defs = new Map<string, { def: GroupDef; stocks: HeldStock[] }>();
    for (const s of stocks) {
        const def = assign(s.code).group;
        const entry = defs.get(def.id) ?? { def, stocks: [] };
        entry.stocks.push(s);
        defs.set(def.id, entry);
    }
    const groups: HeldGroup[] = [...defs.values()].map(({ def, stocks: list }) => {
        const codes = def.id === 'none' ? list.map((s) => s.code) : def.codes;
        const external = def.id === 'none' ? null : (flowOf?.(def) ?? null);
        const flow = external ?? groupFlow(book, codes, now);
        const value = list.reduce((s, x) => s + x.value, 0);
        let covered = 0;
        if (external) covered = external.count;
        else for (const c of codes) if (book.codes.has(c)) covered += 1;
        return {
            id: def.id,
            name: def.name,
            stocks: list.sort((a, b) => b.value - a.value),
            value,
            weight: total > 0 ? value / total : 0,
            dayPnl: list.reduce((s, x) => s + x.dayPnl, 0),
            pnl: list.reduce((s, x) => s + x.pnl, 0),
            flow,
            recent: windowOf(flow.net, flow.turnover, now, RECENT_MIN),
            cum: windowOf(flow.net, flow.turnover, now, null),
            covered,
            members: external ? external.count : codes.length,
        };
    });
    groups.sort((a, b) => b.value - a.value);
    const aligned = groups.reduce((s, g) => s + (g.recent.net > 0 ? g.value : 0), 0);
    return {
        stocks,
        groups,
        total,
        dayPnl: stocks.reduce((s, x) => s + x.dayPnl, 0),
        pnl: stocks.reduce((s, x) => s + x.pnl, 0),
        alignedShare: total > 0 ? aligned / total : 0,
    };
}

// ── alerts: a held group turns from net inflow to net outflow ───────────────

export interface FlipAlert {
    groupId: string;
    name: string;
    slot: number;
    /** 'out' = turned to outflow, 'in' = turned to inflow. */
    to: 'out' | 'in';
    held: number;
}

/**
 * Compare each held group's recent-window sign with the previous minute.
 * A flip needs |ratio| ≥ `deadband` % on the new side, so a group hovering
 * around zero does not alert every minute.
 */
export function detectFlips(
    prev: ReadonlyMap<string, 1 | -1>,
    groups: readonly HeldGroup[],
    slot: number,
    deadband = 3,
): { next: Map<string, 1 | -1>; alerts: FlipAlert[] } {
    const next = new Map<string, 1 | -1>();
    const alerts: FlipAlert[] = [];
    for (const g of groups) {
        const r = g.recent.ratio;
        const before = prev.get(g.id);
        if (r === null) {
            if (before) next.set(g.id, before);
            continue;
        }
        const side: 1 | -1 | 0 = r >= deadband ? 1 : r <= -deadband ? -1 : 0;
        if (side === 0) {
            if (before) next.set(g.id, before);
            continue;
        }
        next.set(g.id, side);
        if (before && before !== side && g.id !== 'none') {
            alerts.push({ groupId: g.id, name: g.name, slot, to: side === -1 ? 'out' : 'in', held: g.stocks.length });
        }
    }
    return { next, alerts };
}
