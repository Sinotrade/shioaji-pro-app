// src/lib/chain-flow-feed.ts — live feed for 產業鏈資金流向.
//
// Request budget (see PR #355, design v3):
// - Overview: the realtime 1-minute K-bar stream for each chain/theme's
//   leading members only (top 8 by market cap, ~190 codes → one subscribe
//   POST of ≤300 four-digit codes; the sidecar caps a body at 64 KB and
//   rejects other codes). No request is sent per minute: bars arrive on the
//   App's existing aggregate SSE.
// - Drill: the selected group's remaining members, under their own key that
//   never includes overview codes, so releasing it cannot drop them.
// - Ticks the App already receives for other panels (watchlist, chart …)
//   update the price of overlapping codes faster. This module never
//   subscribes ticks itself.
// - Snapshots only seed the reference price and session-to-date turnover,
//   once per code per trading day, ≤300 per request, skipping codes another
//   panel already fetched into the shared snapshot store.
// - Subscriptions are ref-counted by the capability registry (shared across
//   panels, replayed after a reconnect) and released on unmount.
// - Data layer: a bar may carry a server-side signed flow (`net`), which then
//   replaces the sign estimate (future quotex inner/outer money flow).

import { useEffect, useRef, useState } from 'react';
import { FlowBook, marketSeconds, minuteSlot, normDate, parseKbarEvent, SESSION_SLOTS, SESSION_START_MIN } from './chain-flow';
import { isKbarCode } from './chain-map';
import { getMarketSnapshot } from './market-snapshot-store';
import { fetchSnapshots, subscribeKbars, unsubscribeKbars } from './shioaji';
import { onAnyTick, onStreamEvent } from './stream';
import type { ContractBase } from './types/contract';
import type { Snapshot } from './types/market';

export const FEED_BATCH = 300;
const NOTIFY_MS = 400;

export interface FeedStatus {
    /** Overview codes the K-bar stream was asked for. */
    kbarCodes: number;
    /** Extra codes subscribed for the drilled-in group. */
    drillCodes: number;
    /** Batches confirmed by the sidecar. */
    subscribed: number;
    batches: number;
    kbarError: string | null;
    seeding: boolean;
    seedError: string | null;
    /** Wall-clock ms of the latest bar received. */
    lastBarAt: number | null;
}

export const chainFlowBook = new FlowBook();

export type FeedScope = 'overview' | 'drill';

interface Connection {
    scope: FeedScope;
    codes: number;
    batches: number;
    subscribed: number;
    error: string | null;
    members: readonly FeedMember[];
}

const connections = new Set<Connection>();
const status = {
    seeding: false,
    seedError: null as string | null,
    lastBarAt: null as number | null,
};
let revision = 0;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function chainFlowStatus(): Readonly<FeedStatus> {
    let kbarCodes = 0;
    let drillCodes = 0;
    let subscribed = 0;
    let batches = 0;
    let kbarError: string | null = null;
    for (const c of connections) {
        if (c.scope === 'drill') drillCodes += c.codes;
        else kbarCodes += c.codes;
        subscribed += c.subscribed;
        batches += c.batches;
        kbarError ??= c.error;
    }
    return { kbarCodes, drillCodes, subscribed, batches, kbarError, ...status };
}

export function chainFlowRevision() {
    return revision;
}

/** Coalesce bursts (every code closes its bar at the same second). */
export function notifyChainFlow(immediate = false) {
    revision += 1;
    if (immediate) {
        if (notifyTimer) clearTimeout(notifyTimer);
        notifyTimer = null;
        listeners.forEach((listener) => listener());
        return;
    }
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
        notifyTimer = null;
        listeners.forEach((listener) => listener());
    }, NOTIFY_MS);
}

export function subscribeChainFlow(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export interface FeedMember {
    code: string;
    contract: ContractBase;
    shares: number | null;
}

/** Stable batches of four-digit codes, sorted so every panel builds the same keys. */
export function kbarBatches(members: readonly FeedMember[], size = FEED_BATCH, scope: FeedScope = 'overview') {
    const sorted = members.filter((m) => isKbarCode(m.code)).sort((a, b) => a.code.localeCompare(b.code));
    const batches: { key: string; contracts: ContractBase[] }[] = [];
    for (let i = 0; i < sorted.length; i += size) {
        const slice = sorted.slice(i, i + size);
        batches.push({
            key: `chainflow:${scope === 'drill' ? 'drill:' : ''}${slice[0]!.code}-${slice[slice.length - 1]!.code}:${slice.length}`,
            contracts: slice.map((m) => m.contract),
        });
    }
    return batches;
}

/** Adopt the newest session date among `rows` before seeding any of them (order-independent). */
function adoptDate(rows: readonly Snapshot[]) {
    let newest: string | null = null;
    for (const row of rows) {
        const date = normDate(row.datetime);
        if (date && (newest === null || date > newest)) newest = date;
    }
    // a stock that has not traded today carries an older datetime: never let
    // it roll the book back a day
    if (newest && (chainFlowBook.date === null || newest > chainFlowBook.date)) chainFlowBook.ensureDate(newest);
}

function seedFrom(code: string, snapshot: Snapshot, shares: number | null) {
    adoptDate([snapshot]);
    const date = normDate(snapshot.datetime);
    const close = snapshot.close > 0 ? snapshot.close : null;
    if (date && chainFlowBook.date && date < chainFlowBook.date) {
        // last traded on an earlier session (suspended, illiquid): its
        // turnover and minutes belong to that day. Keep only the reference:
        // that session's close is this session's previous close.
        chainFlowBook.seed(code, { ref: close, close, totalAmount: 0, shares, slot: 0 });
        return;
    }
    const ref = close !== null && Number.isFinite(snapshot.change_price) ? close - snapshot.change_price : null;
    const time = snapshot.datetime?.slice(11) ?? '';
    const slot = minuteSlot(time);
    const seconds = marketSeconds(time);
    // minutes before the snapshot's own are fully covered; that minute is
    // covered pro rata (09:40:12 → 20 % of minute 40 is already in the
    // turnover, the rest arrives with its bar); after the close the whole
    // session is covered; before the open nothing is
    const covered = slot !== null ? slot : seconds !== null && seconds >= 13 * 3600 ? SESSION_SLOTS : 0;
    const fraction = slot !== null && seconds !== null ? (seconds - (SESSION_START_MIN + slot) * 60) / 60 : 0;
    chainFlowBook.seed(code, {
        ref: ref && ref > 0 ? ref : null,
        close,
        totalAmount: snapshot.total_amount || 0,
        shares,
        slot: covered,
        fraction,
        ...(seconds !== null ? { at: seconds } : {}),
    });
}

export type FeedPhase = 'waiting' | 'live' | 'stalled' | 'closed';

/** No bar for this long while the market is open: the stream is stalled. */
export const BAR_STALE_MS = 3 * 60_000;
const OPEN_SECONDS = SESSION_START_MIN * 60;
/** The closing-auction bar may be stamped up to 13:34 and arrive a little later. */
const LIVE_UNTIL_SECONDS = (13 * 60 + 36) * 60;

/**
 * Whether the minute-bar feed is live, from the Taipei clock, the session
 * date and feed freshness, never from the last bar alone (which stops
 * changing once bars stop, e.g. after the close or when the stream stalls).
 */
export function feedPhase(input: {
    now: number;
    /** Session date of the book (null before anything arrived). */
    session: string | null;
    lastBarAt: number | null;
    lastSlot: number | null;
}): FeedPhase {
    const today = taipeiDate(input.now);
    const seconds = taipeiSeconds(input.now);
    if (input.session !== null && input.session < today) return 'closed';
    if (input.lastSlot !== null && input.lastSlot >= SESSION_SLOTS - 1) return 'closed';
    if (seconds >= LIVE_UNTIL_SECONDS) return 'closed';
    if (seconds < OPEN_SECONDS || input.lastBarAt === null) return 'waiting';
    return input.now - input.lastBarAt > BAR_STALE_MS ? 'stalled' : 'live';
}

/** Today's date in Taipei as YYYY-MM-DD (the session date before any bar arrives). */
export function taipeiDate(now = Date.now()): string {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** Seconds since midnight in Taipei. */
export function taipeiSeconds(now = Date.now()): number {
    return Math.floor(((now / 1000 + 8 * 3600) % 86400 + 86400) % 86400);
}

const CLOSE_SECONDS = (13 * 60 + 30) * 60;
/** How far behind the feed start a cached snapshot may be and still seed it. */
export const SNAPSHOT_FRESH_SEC = 60;

/**
 * A cached snapshot is usable when it belongs to the book's session (or
 * today's, before any bar) and is recent relative to now: the bars between
 * an older snapshot and this feed's start were never received, so seeding
 * from it would lose that turnover. A past session must be cached after its
 * close. (A stock that simply has not traded since is refetched: one cheap
 * request, and fetched rows are taken as they are.)
 */
function isCurrent(snapshot: Snapshot, now = Date.now()): boolean {
    const date = normDate(snapshot.datetime);
    const session = chainFlowBook.date ?? taipeiDate(now);
    if (date === null || date !== session) return false;
    const at = marketSeconds(snapshot.datetime.slice(11));
    if (at === null) return false;
    const until = session < taipeiDate(now) ? CLOSE_SECONDS : Math.min(taipeiSeconds(now), CLOSE_SECONDS);
    return at >= until - SNAPSHOT_FRESH_SEC;
}

/** Codes seeded for `seededDate`. */
const seeded = new Set<string>();
let seededDate: string | null = null;
let seedQueue: Promise<void> = Promise.resolve();
let seedPending = 0;
/** Bumped when the last panel closes: seeds queued before that are dropped. */
let seedGeneration = 0;

async function seed(members: readonly FeedMember[]) {
    const startDate = chainFlowBook.date;
    try {
        await seedOnce(members);
    } finally {
        // a newer session among the fetched rows rolled the book, dropping
        // codes seeded under the old date: seed every connection again
        if (startDate !== null && chainFlowBook.date !== startDate) {
            for (const c of connections) startSeed(c.members);
        }
    }
}

async function seedOnce(members: readonly FeedMember[]) {
    if (seededDate !== chainFlowBook.date) {
        seeded.clear();
        seededDate = chainFlowBook.date;
    }
    const todo = members.filter((m) => !seeded.has(m.code));
    if (todo.length === 0) return;
    status.seeding = true;
    status.seedError = null;
    notifyChainFlow(true);
    const missing: FeedMember[] = [];
    for (const member of todo) {
        seeded.add(member.code);
        chainFlowBook.setShares(member.code, member.shares);
        const shared = getMarketSnapshot(member.contract);
        // a snapshot cached on an earlier trading day (app left open over a
        // rollover) must not seed today: fetch a fresh one
        if (shared && isCurrent(shared)) seedFrom(member.code, shared, member.shares);
        else missing.push(member);
    }
    // sequential batches, never a burst against 50 req / 5 s
    for (let i = 0; i < missing.length; i += FEED_BATCH) {
        const batch = missing.slice(i, i + FEED_BATCH);
        try {
            const rows = await fetchSnapshots(batch.map((m) => m.contract));
            adoptDate(rows);
            const byCode = new Map(rows.map((row) => [row.code, row]));
            for (const member of batch) {
                const row = byCode.get(member.code);
                if (row) seedFrom(member.code, row, member.shares);
            }
        } catch (error) {
            for (const member of batch) seeded.delete(member.code);
            status.seedError = error instanceof Error ? error.message : String(error);
        }
        notifyChainFlow();
    }
    // the first seed adopted today's date: remember it for these codes
    if (seededDate === null && chainFlowBook.date !== null) seededDate = chainFlowBook.date;
}

function startSeed(members: readonly FeedMember[]) {
    if (members.length === 0) return;
    const generation = seedGeneration;
    seedPending += 1;
    seedQueue = seedQueue
        // every panel closed before this seed ran: marking its codes seeded
        // would make the next open skip the snapshots it needs
        .then(() => (generation === seedGeneration ? seed(members) : undefined))
        .catch(() => undefined)
        .finally(() => {
            seedPending -= 1;
            if (seedPending === 0) {
                status.seeding = false;
                notifyChainFlow(true);
            }
        });
}

let streamRefs = 0;
let detachStream: (() => void) | null = null;

function attachStream() {
    const offBar = onStreamEvent('kbar', (raw) => {
        const bars = parseKbarEvent(raw);
        if (bars.length === 0) return;
        const before = chainFlowBook.date;
        for (const bar of bars) chainFlowBook.addBar(bar);
        // a new trading day dropped yesterday's seed: seed again
        if (before !== null && before !== chainFlowBook.date) {
            for (const c of connections) startSeed(c.members);
        }
        status.lastBarAt = Date.now();
        notifyChainFlow();
    });
    const offTick = onAnyTick((tick) => {
        if (tick.intraday_odd) return;
        const flow = chainFlowBook.codes.get(tick.code);
        if (!flow) return;
        const date = normDate(tick.date);
        if (date && chainFlowBook.date && date !== chainFlowBook.date) return;
        const close = Number(tick.close);
        const total = tick.total_amount !== undefined ? Number(tick.total_amount) : NaN;
        chainFlowBook.tick(tick.code, close, Number.isFinite(total) ? total : null, marketSeconds(tick.time));
        notifyChainFlow();
    });
    return () => {
        offBar();
        offTick();
    };
}

/**
 * Start the feed for `members` (overview leaders, or a drilled-in group's
 * extra codes). Returns the release function, which unsubscribes this
 * connection's K-bar batches.
 */
export function connectChainFlow(members: readonly FeedMember[], scope: FeedScope = 'overview'): () => void {
    streamRefs += 1;
    if (streamRefs === 1) detachStream = attachStream();
    const batches = kbarBatches(members, FEED_BATCH, scope);
    const conn: Connection = {
        scope,
        codes: batches.reduce((n, b) => n + b.contracts.length, 0),
        batches: batches.length,
        subscribed: 0,
        error: null,
        members,
    };
    connections.add(conn);
    let released = false;
    for (const batch of batches) {
        subscribeKbars(batch.key, batch.contracts).then(
            () => {
                if (released) return;
                conn.subscribed += 1;
                notifyChainFlow();
            },
            (error) => {
                if (released) return;
                conn.error = error instanceof Error ? error.message : String(error);
                notifyChainFlow(true);
            },
        );
    }
    startSeed(members);
    notifyChainFlow(true);
    return () => {
        if (released) return;
        released = true;
        connections.delete(conn);
        for (const batch of batches) void unsubscribeKbars(batch.key, batch.contracts).catch(() => undefined);
        streamRefs -= 1;
        if (streamRefs === 0) {
            detachStream?.();
            detachStream = null;
            // nothing is received while no panel is open: the next open must
            // seed again from fresh snapshots to cover the minutes in between
            seeded.clear();
            seededDate = null;
            seedGeneration += 1;
        }
        notifyChainFlow(true);
    };
}

/**
 * Revision of the book for rendering. While `paused` (panel hidden or
 * scrolled away) the component is not re-rendered; it catches up on resume.
 */
export function useChainFlowRevision(paused: boolean): number {
    const [value, setValue] = useState(revision);
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    useEffect(
        () =>
            subscribeChainFlow(() => {
                if (!pausedRef.current) setValue(revision);
            }),
        [],
    );
    useEffect(() => {
        if (!paused) setValue(revision);
    }, [paused]);
    return value;
}

/** Test hook: forget the session (book, seed, status). */
export function resetChainFlowForTest() {
    chainFlowBook.reset(null);
    seeded.clear();
    seededDate = null;
    seedQueue = Promise.resolve();
    seedPending = 0;
    connections.clear();
    status.seeding = false;
    status.seedError = null;
    status.lastBarAt = null;
}

/** Test hook: wait for queued seeds. */
export function chainFlowSeedIdle() {
    return seedQueue;
}
