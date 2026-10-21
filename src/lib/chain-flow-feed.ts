// src/lib/chain-flow-feed.ts — live feed for 產業鏈資金流向.
//
// Request budget (see PR #355):
// - Primary feed: the realtime 1-minute K-bar stream. One subscribe POST per
//   batch of ≤300 four-digit codes (the sidecar caps a request body at 64 KB
//   and rejects other codes), ~800 codes → 3 POSTs. The broker maps them onto
//   ~57 prefix topics. Subscriptions cost no traffic quota and no request is
//   sent per minute: bars arrive on the App's existing aggregate SSE.
// - Ticks the App already receives for other panels (watchlist, chart …)
//   update the price of overlapping codes faster. This module never
//   subscribes ticks itself.
// - Snapshots only seed the reference price and session-to-date turnover,
//   once per trading day, ≤300 per request, skipping codes another panel
//   already fetched into the shared snapshot store.
// - Subscriptions are ref-counted by the capability registry (shared across
//   panels, replayed after a reconnect) and released when the last panel
//   unmounts.

import { useEffect, useRef, useState } from 'react';
import { FlowBook, minuteSlot, normDate, parseKbarEvent, SESSION_SLOTS } from './chain-flow';
import { isKbarCode } from './chain-map';
import { getMarketSnapshot } from './market-snapshot-store';
import { fetchSnapshots, subscribeKbars, unsubscribeKbars } from './shioaji';
import { onAnyTick, onStreamEvent } from './stream';
import type { ContractBase } from './types/contract';
import type { Snapshot } from './types/market';

export const FEED_BATCH = 300;
const NOTIFY_MS = 400;

export interface FeedStatus {
    /** Codes the K-bar stream was asked for. */
    kbarCodes: number;
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
const status: FeedStatus = {
    kbarCodes: 0,
    subscribed: 0,
    batches: 0,
    kbarError: null,
    seeding: false,
    seedError: null,
    lastBarAt: null,
};
let revision = 0;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function chainFlowStatus(): Readonly<FeedStatus> {
    return status;
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
export function kbarBatches(members: readonly FeedMember[], size = FEED_BATCH) {
    const sorted = members.filter((m) => isKbarCode(m.code)).sort((a, b) => a.code.localeCompare(b.code));
    const batches: { key: string; contracts: ContractBase[] }[] = [];
    for (let i = 0; i < sorted.length; i += size) {
        const slice = sorted.slice(i, i + size);
        batches.push({
            key: `chainflow:${slice[0]!.code}-${slice[slice.length - 1]!.code}:${slice.length}`,
            contracts: slice.map((m) => m.contract),
        });
    }
    return batches;
}

function seedFrom(code: string, snapshot: Snapshot, shares: number | null) {
    // a stock that has not traded today carries an older datetime: never let
    // it roll the book back a day
    const date = normDate(snapshot.datetime);
    if (date && (chainFlowBook.date === null || date > chainFlowBook.date)) chainFlowBook.ensureDate(date);
    const close = snapshot.close > 0 ? snapshot.close : null;
    const ref = close !== null && Number.isFinite(snapshot.change_price) ? close - snapshot.change_price : null;
    const time = snapshot.datetime?.slice(11) ?? '';
    const slot = minuteSlot(time);
    const minutes = /^(\d{1,2}):(\d{2})/.exec(time);
    // after the close the whole session is covered; before the open nothing is
    const covered =
        slot !== null ? slot : minutes && Number(minutes[1]) >= 13 ? SESSION_SLOTS : 0;
    chainFlowBook.seed(code, {
        ref: ref && ref > 0 ? ref : null,
        close,
        totalAmount: snapshot.total_amount || 0,
        shares,
        slot: covered,
    });
}

let seededFor: string | null = null;
let seedRun: Promise<void> | null = null;

async function seed(members: readonly FeedMember[]) {
    status.seeding = true;
    status.seedError = null;
    notifyChainFlow(true);
    const missing: FeedMember[] = [];
    for (const member of members) {
        chainFlowBook.setShares(member.code, member.shares);
        const shared = getMarketSnapshot(member.contract);
        if (shared) seedFrom(member.code, shared, member.shares);
        else missing.push(member);
    }
    // sequential batches: at most 3 requests, never a burst against 50 req / 5 s
    for (let i = 0; i < missing.length; i += FEED_BATCH) {
        const batch = missing.slice(i, i + FEED_BATCH);
        try {
            const rows = await fetchSnapshots(batch.map((m) => m.contract));
            const byCode = new Map(rows.map((row) => [row.code, row]));
            for (const member of batch) {
                const row = byCode.get(member.code);
                if (row) seedFrom(member.code, row, member.shares);
            }
        } catch (error) {
            status.seedError = error instanceof Error ? error.message : String(error);
        }
        notifyChainFlow();
    }
    seededFor = chainFlowBook.date;
    status.seeding = false;
    notifyChainFlow(true);
}

let lastMembers: readonly FeedMember[] = [];

function startSeed() {
    if (seedRun || lastMembers.length === 0) return;
    if (seededFor !== null && seededFor === chainFlowBook.date) return;
    seedRun = seed(lastMembers).finally(() => {
        seedRun = null;
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
            seededFor = null;
            startSeed();
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
        chainFlowBook.tick(tick.code, close, Number.isFinite(total) ? total : null);
        notifyChainFlow();
    });
    return () => {
        offBar();
        offTick();
    };
}

/**
 * Start the feed for `members` (all chain and theme members). Returns the
 * release function; the last release unsubscribes the K-bar batches.
 */
export function connectChainFlow(members: readonly FeedMember[]): () => void {
    streamRefs += 1;
    if (streamRefs === 1) detachStream = attachStream();
    const batches = kbarBatches(members);
    status.kbarCodes = batches.reduce((n, b) => n + b.contracts.length, 0);
    status.batches = batches.length;
    status.subscribed = 0;
    status.kbarError = null;
    let released = false;
    for (const batch of batches) {
        subscribeKbars(batch.key, batch.contracts).then(
            () => {
                if (released) return;
                status.subscribed += 1;
                notifyChainFlow();
            },
            (error) => {
                if (released) return;
                status.kbarError = error instanceof Error ? error.message : String(error);
                notifyChainFlow(true);
            },
        );
    }
    lastMembers = members;
    startSeed();
    return () => {
        if (released) return;
        released = true;
        for (const batch of batches) void unsubscribeKbars(batch.key, batch.contracts).catch(() => undefined);
        streamRefs -= 1;
        if (streamRefs === 0) {
            detachStream?.();
            detachStream = null;
        }
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
    seededFor = null;
    seedRun = null;
    lastMembers = [];
    status.kbarCodes = 0;
    status.subscribed = 0;
    status.batches = 0;
    status.kbarError = null;
    status.seeding = false;
    status.seedError = null;
    status.lastBarAt = null;
}
