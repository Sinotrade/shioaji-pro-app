// src/lib/chain-flow.ts — minute money-flow book for 產業鏈資金流向.
//
// Fed by the realtime 1-minute K-bar stream (one complete bar per stock at
// each minute close), seeded once from snapshots (reference price and
// session-to-date turnover), and nudged by ticks the App already receives
// for other panels. Pure: no I/O, no React — aggregates are unit-tested.
//
// Metrics
// - turnover: Σ bar amount per minute.
// - net (淨流入, estimate): Σ amount × sign(bar close − previous close). The
//   classic money-flow proxy: money traded on up-moves minus down-moves.
// - flow5 / turnover5: the last five completed minutes.
// - accel (量能倍數): turnover5 ÷ (session average per minute × 5).
// - pct: market-cap-weighted change (previous-close caps).

/** 09:00 … 13:30 inclusive: 271 one-minute slots. */
export const SESSION_START_MIN = 9 * 60;
export const SESSION_SLOTS = 271;
export const WINDOW = 5;

/** Wall-clock "HH:MM[:SS[.ffffff]]" (tick, snapshot) → slot index, or null outside the session. */
export function minuteSlot(time: string | undefined | null): number | null {
    const match = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
    if (!match) return null;
    const slot = Number(match[1]) * 60 + Number(match[2]) - SESSION_START_MIN;
    return slot >= 0 && slot < SESSION_SLOTS ? slot : null;
}

/** The closing auction may be stamped a few minutes after 13:30 (cf. intraday-session CLOSE_GRACE). */
const CLOSE_GRACE_MIN = 4;

/**
 * Stream bar label → slot. The 1-minute K-bar stream stamps each bar with its
 * minute END, like every Shioaji 1-minute K: the 09:00–09:01 bar arrives at
 * about 09:01:02 as `time: "09:01:00"`. Label L therefore holds minute L − 1;
 * the closing auction (13:30–13:34 labels) folds into the 13:30 slot.
 */
export function barSlot(time: string | undefined | null): number | null {
    const match = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
    if (!match) return null;
    const label = Number(match[1]) * 60 + Number(match[2]) - SESSION_START_MIN;
    if (label < 1 || label > SESSION_SLOTS - 1 + CLOSE_GRACE_MIN) return null;
    return Math.min(label - 1, SESSION_SLOTS - 1);
}

/** Wall-clock "HH:MM[:SS[.ffffff]]" → seconds since midnight, or null. */
export function marketSeconds(time: string | undefined | null): number | null {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?/.exec(time ?? '');
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) + Number(match[4] ?? 0);
}

/** Market time (seconds since midnight) of a bar's close: the end of its minute. */
export function barEndSeconds(slot: number): number {
    return (SESSION_START_MIN + slot + 1) * 60;
}

export function slotLabel(slot: number): string {
    const minutes = SESSION_START_MIN + slot;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Normalised YYYY-MM-DD (accepts YYYY/MM/DD). */
export function normDate(date: string | undefined | null): string | null {
    const match = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(date ?? '');
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export interface KBarEvent {
    code: string;
    date: string | null;
    slot: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    amount: number;
    /**
     * Signed flow supplied by the source (e.g. a future server-side tick
     * inner/outer split). When present it replaces the sign estimate.
     */
    net?: number;
}

const toNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);

function parseRow(row: unknown, fallbackDate: string | null): KBarEvent | null {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code : null;
    // `time` is the bar's minute END; some payloads carry a combined datetime/ts
    const timeText =
        typeof r.time === 'string'
            ? r.time
            : typeof r.datetime === 'string'
              ? r.datetime.slice(11)
              : typeof r.ts === 'string'
                ? r.ts.slice(11)
                : null;
    const slot = barSlot(timeText);
    const close = toNum(r.close);
    const amount = toNum(r.amount);
    if (!code || slot === null || !Number.isFinite(close) || close <= 0 || !Number.isFinite(amount)) return null;
    const date =
        normDate(typeof r.date === 'string' ? r.date : typeof r.datetime === 'string' ? r.datetime : typeof r.ts === 'string' ? r.ts : null) ??
        fallbackDate;
    const open = toNum(r.open);
    const high = toNum(r.high);
    const low = toNum(r.low);
    const volume = toNum(r.volume);
    const net = toNum(r.net);
    return {
        ...(Number.isFinite(net) ? { net } : {}),
        code,
        date,
        slot,
        open: Number.isFinite(open) ? open : close,
        high: Number.isFinite(high) ? high : close,
        low: Number.isFinite(low) ? low : close,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
        amount: Math.max(0, amount),
    };
}

/**
 * Parse one SSE `kbar` event. Tolerates a single bar object, an array of
 * bars, or `{ rows | bars | data: [...] }` (the wire batches one message per
 * code prefix).
 */
export function parseKbarEvent(raw: string | unknown): KBarEvent[] {
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    const rows: unknown[] = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
          ? (['rows', 'bars', 'data', 'kbars'] as const)
                .map((k) => (value as Record<string, unknown>)[k])
                .find(Array.isArray) ?? [value]
          : [];
    const fallbackDate =
        value && typeof value === 'object' && !Array.isArray(value)
            ? normDate((value as Record<string, unknown>).date as string)
            : null;
    return rows.map((row) => parseRow(row, fallbackDate)).filter((r): r is KBarEvent => r !== null);
}

// ── book ───────────────────────────────────────────────────────────────────

export interface CodeFlow {
    /** Previous close (reference); null until seeded. */
    ref: number | null;
    /** Shares outstanding (shioaji-data), for cap weights. */
    shares: number | null;
    amount: Float64Array;
    close: Float64Array;
    /** Signed money flow per bar, kept in step with amount/close. */
    net: Float64Array;
    /** Slots whose net came from the source rather than the sign estimate. */
    given: Uint8Array;
    /** Latest price from a tick, bar or seed. */
    last: number | null;
    /** Market time (seconds since midnight) of `last`; an older price never replaces it. */
    lastAt: number;
    /** Session-to-date turnover at seed time, and the first slot it does not fully cover. */
    seedAmount: number;
    seedSlot: number;
    /**
     * Share of `seedSlot` already inside `seedAmount` (snapshot taken mid-minute,
     * e.g. 0.2 at 09:40:12). That minute's bar only adds the remaining share.
     */
    seedFrac: number;
    /** Price at seed time: the baseline of the first bar when the panel opens mid-session. */
    seedClose: number | null;
    /** Latest cumulative turnover seen on a tick. */
    tickAmount: number;
}

export interface SeedInput {
    ref: number | null;
    close: number | null;
    totalAmount: number;
    shares: number | null;
    /** First slot not fully covered by the snapshot (bars from this slot on are new). */
    slot: number;
    /** Share of `slot` already inside `totalAmount` (0 = none, the default). */
    fraction?: number;
    /** Market time (seconds since midnight) of `close`. */
    at?: number;
}

export class FlowBook {
    date: string | null = null;
    readonly codes = new Map<string, CodeFlow>();
    /** Earliest / latest bar slot received this session. */
    firstSlot: number | null = null;
    lastSlot: number | null = null;
    version = 0;

    private entry(code: string): CodeFlow {
        let flow = this.codes.get(code);
        if (!flow) {
            const close = new Float64Array(SESSION_SLOTS).fill(NaN);
            flow = {
                ref: null,
                shares: null,
                amount: new Float64Array(SESSION_SLOTS),
                close,
                net: new Float64Array(SESSION_SLOTS),
                given: new Uint8Array(SESSION_SLOTS),
                last: null,
                lastAt: -Infinity,
                seedAmount: 0,
                seedSlot: 0,
                seedFrac: 0,
                seedClose: null,
                tickAmount: 0,
            };
            this.codes.set(code, flow);
        }
        return flow;
    }

    /** Start a new trading day: drop all bars. */
    reset(date: string | null) {
        this.date = date;
        this.codes.clear();
        this.firstSlot = null;
        this.lastSlot = null;
        this.version += 1;
    }

    /** Adopt the first date seen; roll to a new day when it changes. */
    ensureDate(date: string | null) {
        if (!date || this.date === date) return;
        if (this.date === null) this.date = date;
        else this.reset(date);
    }

    setShares(code: string, shares: number | null) {
        if (shares && shares > 0) this.entry(code).shares = shares;
    }

    seed(code: string, input: SeedInput) {
        const flow = this.entry(code);
        if (input.ref && input.ref > 0) flow.ref = input.ref;
        if (input.close && input.close > 0) {
            flow.seedClose = input.close;
            if (flow.last === null) flow.last = input.close;
            else if (input.at !== undefined && input.at > flow.lastAt) flow.last = input.close;
            if (input.at !== undefined && input.at > flow.lastAt) flow.lastAt = input.at;
        }
        flow.seedAmount = Math.max(0, input.totalAmount || 0);
        flow.seedSlot = Math.max(0, Math.min(SESSION_SLOTS, input.slot));
        const fraction = input.fraction ?? 0;
        flow.seedFrac = flow.seedSlot < SESSION_SLOTS && fraction > 0 ? Math.min(1, fraction) : 0;
        // the first bar's direction depends on the baseline just installed
        const first = firstFilled(flow.close, 0);
        if (first !== null && !flow.given[first]) flow.net[first] = computeNet(flow, first);
        if (input.shares && input.shares > 0) flow.shares = input.shares;
        this.version += 1;
    }

    addBar(bar: KBarEvent): boolean {
        if (bar.date) this.ensureDate(bar.date);
        const flow = this.entry(bar.code);
        flow.amount[bar.slot] = bar.amount;
        flow.close[bar.slot] = bar.close;
        flow.given[bar.slot] = bar.net !== undefined ? 1 : 0;
        flow.net[bar.slot] = bar.net ?? computeNet(flow, bar.slot);
        // the next bar's previous close may have changed
        const next = firstFilled(flow.close, bar.slot + 1);
        if (next !== null && !flow.given[next]) flow.net[next] = computeNet(flow, next);
        // a bar (or a delayed one) never moves the price backwards in time,
        // neither past a newer bar nor past a newer tick
        const at = barEndSeconds(bar.slot);
        if (at >= flow.lastAt) {
            flow.last = bar.close;
            flow.lastAt = at;
        }
        if (this.firstSlot === null || bar.slot < this.firstSlot) this.firstSlot = bar.slot;
        if (this.lastSlot === null || bar.slot > this.lastSlot) this.lastSlot = bar.slot;
        this.version += 1;
        return true;
    }

    /** `at` = the trade's market time (seconds since midnight); unknown ticks are taken as newest. */
    tick(code: string, close: number, totalAmount: number | null, at: number | null = null) {
        const flow = this.codes.get(code);
        if (!flow || !(close > 0)) return;
        if (at === null || at >= flow.lastAt) {
            flow.last = close;
            if (at !== null) flow.lastAt = at;
        }
        if (totalAmount && totalAmount > flow.tickAmount) flow.tickAmount = totalAmount;
        this.version += 1;
    }
}

function lastFilled(series: Float64Array, from: number): number | null {
    for (let i = from; i >= 0; i -= 1) if (!Number.isNaN(series[i]!)) return i;
    return null;
}

function firstFilled(series: Float64Array, from: number): number | null {
    for (let i = from; i < series.length; i += 1) if (!Number.isNaN(series[i]!)) return i;
    return null;
}

/** Signed money flow of one bar (cached on the flow). */
export function barNet(flow: CodeFlow, slot: number): number {
    return flow.net[slot]!;
}

/** amount × sign(close − previous close); the first bar compares with the reference. */
function computeNet(flow: CodeFlow, slot: number): number {
    const close = flow.close[slot]!;
    if (Number.isNaN(close)) return 0;
    const prevSlot = slot > 0 ? lastFilled(flow.close, slot - 1) : null;
    // baseline of the first observed bar: the previous minute's close is
    // unknown when the panel opens mid-session, so use the snapshot price
    // taken just before; only the 09:00 bar compares with the reference
    // (yesterday's close). Without either the direction is unknown (0).
    // (the snapshot's own minute when taken mid-minute, else the minute just before it)
    const seedBase =
        flow.seedClose !== null && slot >= flow.seedSlot - (flow.seedFrac > 0 ? 0 : 1) ? flow.seedClose : null;
    const prev = prevSlot !== null ? flow.close[prevSlot]! : (seedBase ?? (slot === 0 ? flow.ref : null));
    if (!prev) return 0;
    const amount = flow.amount[slot]!;
    return close > prev ? amount : close < prev ? -amount : 0;
}

/**
 * Session-to-date turnover: seed + bars after the seed (the snapshot's own
 * minute pro rata: only the part after the snapshot time is new), or the
 * latest tick total.
 */
export function sessionTurnover(flow: CodeFlow): number {
    let bars = 0;
    for (let i = flow.seedSlot; i < SESSION_SLOTS; i += 1) {
        bars += i === flow.seedSlot ? flow.amount[i]! * (1 - flow.seedFrac) : flow.amount[i]!;
    }
    let all = 0;
    for (let i = 0; i < SESSION_SLOTS; i += 1) all += flow.amount[i]!;
    return Math.max(flow.seedAmount + bars, all, flow.tickAmount);
}

export function codePct(flow: CodeFlow | undefined): number | null {
    if (!flow || !flow.ref || !flow.last) return null;
    return ((flow.last - flow.ref) / flow.ref) * 100;
}

export interface Breadth {
    up: number;
    flat: number;
    down: number;
}

export interface GroupFlow {
    count: number;
    turnover: Float64Array;
    net: Float64Array;
    /** Cumulative net over observed minutes. */
    cumNet: Float64Array;
    flow5: number;
    turnover5: number;
    /** 量能倍數; null before enough history. */
    accel: number | null;
    /** Session-to-date turnover (seed + bars). */
    total: number;
    pct: number | null;
    breadth: Breadth;
}

/** Aggregate a group of codes over the book. `now` = latest completed slot. */
export function groupFlow(book: FlowBook, codes: Iterable<string>, now = book.lastSlot): GroupFlow {
    const turnover = new Float64Array(SESSION_SLOTS);
    const net = new Float64Array(SESSION_SLOTS);
    const breadth: Breadth = { up: 0, flat: 0, down: 0 };
    let count = 0;
    let total = 0;
    let wSum = 0;
    let wPct = 0;
    for (const code of codes) {
        count += 1;
        const flow = book.codes.get(code);
        if (!flow) continue;
        for (let i = 0; i < SESSION_SLOTS; i += 1) {
            const a = flow.amount[i]!;
            if (a > 0) {
                turnover[i] = turnover[i]! + a;
                net[i] = net[i]! + barNet(flow, i);
            }
        }
        total += sessionTurnover(flow);
        const pct = codePct(flow);
        if (pct !== null) {
            if (pct > 0) breadth.up += 1;
            else if (pct < 0) breadth.down += 1;
            else breadth.flat += 1;
            const w = flow.shares && flow.ref ? flow.shares * flow.ref : 1;
            wSum += w;
            wPct += w * pct;
        }
    }
    const cumNet = new Float64Array(SESSION_SLOTS);
    let run = 0;
    for (let i = 0; i < SESSION_SLOTS; i += 1) {
        run += net[i]!;
        cumNet[i] = run;
    }
    let flow5 = 0;
    let turnover5 = 0;
    let accel: number | null = null;
    if (now !== null) {
        for (let i = Math.max(0, now - WINDOW + 1); i <= now; i += 1) {
            flow5 += net[i]!;
            turnover5 += turnover[i]!;
        }
        const elapsed = now + 1;
        const avg = total / elapsed;
        if (elapsed >= WINDOW * 2 && avg > 0) accel = turnover5 / (avg * Math.min(WINDOW, elapsed));
    }
    return {
        count,
        turnover,
        net,
        cumNet,
        flow5,
        turnover5,
        accel,
        total,
        pct: wSum > 0 ? wPct / wSum : null,
        breadth,
    };
}

/**
 * Stage share shift: how much of the chain's turnover each stage took in the
 * last `window` minutes versus the whole observed session, in percentage
 * points. Positive = money rotating into the stage.
 */
export function shareShift(stages: GroupFlow[], now: number | null, window = 15): number[] {
    if (now === null) return stages.map(() => 0);
    const recent = stages.map((s) => {
        let sum = 0;
        for (let i = Math.max(0, now - window + 1); i <= now; i += 1) sum += s.turnover[i]!;
        return sum;
    });
    const session = stages.map((s) => s.turnover.reduce((a, b) => a + b, 0));
    const rTotal = recent.reduce((a, b) => a + b, 0);
    const sTotal = session.reduce((a, b) => a + b, 0);
    return stages.map((_, i) =>
        rTotal > 0 && sTotal > 0 ? (recent[i]! / rTotal - session[i]! / sTotal) * 100 : 0,
    );
}

export interface Leader {
    code: string;
    flow5: number;
    turnover5: number;
    pct: number | null;
}

/** Codes ranked by 5-minute net flow (absolute), strongest first. */
export function leaders(book: FlowBook, codes: Iterable<string>, limit = 5, now = book.lastSlot): Leader[] {
    if (now === null) return [];
    const rows: Leader[] = [];
    for (const code of codes) {
        const flow = book.codes.get(code);
        if (!flow) continue;
        let f = 0;
        let t = 0;
        for (let i = Math.max(0, now - WINDOW + 1); i <= now; i += 1) {
            f += barNet(flow, i);
            t += flow.amount[i]!;
        }
        if (t > 0) rows.push({ code, flow5: f, turnover5: t, pct: codePct(flow) });
    }
    return rows.sort((a, b) => Math.abs(b.flow5) - Math.abs(a.flow5)).slice(0, limit);
}

export interface MemberFlow {
    code: string;
    net: number;
    turnover: number;
    pct: number | null;
}

/**
 * Each code's net inflow and turnover over the last `minutes` minutes ending
 * at `now` (null = every observed minute). Codes without turnover in the
 * window are left out.
 */
export function memberFlows(book: FlowBook, codes: Iterable<string>, minutes: number | null, now = book.lastSlot): MemberFlow[] {
    if (now === null) return [];
    const start = minutes === null ? 0 : Math.max(0, now - minutes + 1);
    const rows: MemberFlow[] = [];
    for (const code of codes) {
        const flow = book.codes.get(code);
        if (!flow) continue;
        let net = 0;
        let turnover = 0;
        for (let i = start; i <= now; i += 1) {
            const a = flow.amount[i]!;
            if (a > 0) {
                net += barNet(flow, i);
                turnover += a;
            }
        }
        if (turnover > 0) rows.push({ code, net, turnover, pct: codePct(flow) });
    }
    return rows;
}
