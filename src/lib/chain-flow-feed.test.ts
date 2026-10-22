import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase } from './types/contract';
import type { Snapshot } from './types/market';

const mocks = vi.hoisted(() => ({
    subscribe: vi.fn(async (_key: string, _contracts: unknown[]) => ({ success: true, message: '' })),
    unsubscribe: vi.fn(async (_key: string, _contracts: unknown[]) => ({ success: true, message: '' })),
    snapshots: vi.fn(async (_contracts: { code: string }[]): Promise<Snapshot[]> => []),
    shared: new Map<string, Snapshot>(),
    named: new Map<string, Set<(raw: string) => void>>(),
    ticks: new Set<(tick: Record<string, unknown>) => void>(),
}));

vi.mock('./shioaji', () => ({
    subscribeKbars: mocks.subscribe,
    unsubscribeKbars: mocks.unsubscribe,
    fetchSnapshots: mocks.snapshots,
}));
vi.mock('./market-snapshot-store', () => ({
    getMarketSnapshot: (c: ContractBase) => mocks.shared.get(c.code),
}));
vi.mock('./stream', () => ({
    onStreamEvent: (name: string, listener: (raw: string) => void) => {
        const set = mocks.named.get(name) ?? new Set();
        set.add(listener);
        mocks.named.set(name, set);
        return () => set.delete(listener);
    },
    onAnyTick: (listener: (tick: Record<string, unknown>) => void) => {
        mocks.ticks.add(listener);
        return () => mocks.ticks.delete(listener);
    },
}));

import { sessionTurnover } from './chain-flow';
import {
    chainFlowBook,
    chainFlowSeedIdle,
    chainFlowStatus,
    connectChainFlow,
    FEED_BATCH,
    feedPhase,
    kbarBatches,
    resetChainFlowForTest,
    type FeedMember,
} from './chain-flow-feed';

const contract = (code: string): ContractBase => ({ security_type: 'STK', exchange: 'TSE', code, target_code: null });
const member = (code: string): FeedMember => ({ code, contract: contract(code), shares: 1000 });
const snapshot = (code: string, close: number, change: number, datetime = '2026-10-21 09:40:12.000000'): Snapshot =>
    ({ code, close, change_price: change, total_amount: 5e7, datetime }) as Snapshot;

function emitBar(raw: unknown) {
    mocks.named.get('kbar')?.forEach((listener) => listener(JSON.stringify(raw)));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    // session date of the fixtures (cached snapshots are checked against it)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T02:00:00Z'));
    resetChainFlowForTest();
    mocks.subscribe.mockClear();
    mocks.unsubscribe.mockClear();
    mocks.snapshots.mockReset();
    mocks.snapshots.mockImplementation(async (contracts) => contracts.map((c) => snapshot(c.code, 101, 1)));
    mocks.shared.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('kbarBatches', () => {
    it('keeps four-digit codes only, sorted into stable batches of ≤300', () => {
        const members = [...Array.from({ length: 650 }, (_, i) => member(String(9999 - i))), member('00878'), member('910861')];
        const batches = kbarBatches(members);
        expect(batches.map((b) => b.contracts.length)).toEqual([FEED_BATCH, FEED_BATCH, 50]);
        expect(batches[0]!.contracts[0]!.code).toBe('9350');
        expect(batches.flatMap((b) => b.contracts).some((c) => c.code.length !== 4)).toBe(false);
        // the same universe in another order builds the same keys (shared ref-count)
        expect(kbarBatches([...members].reverse()).map((b) => b.key)).toEqual(batches.map((b) => b.key));
    });
});

describe('connectChainFlow', () => {
    it('subscribes K-bars once per batch, seeds once, and unsubscribes on release', async () => {
        const members = Array.from({ length: 620 }, (_, i) => member(String(2000 + i)));
        members.push(member('00878'));
        const release = connectChainFlow(members);
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.subscribe).toHaveBeenCalledTimes(3);
        // 621 codes, ≤300 per snapshot request, sequential
        expect(mocks.snapshots.mock.calls.map(([batch]) => batch.length)).toEqual([300, 300, 21]);
        expect(chainFlowStatus()).toMatchObject({ kbarCodes: 620, batches: 3, subscribed: 3, seeding: false });
        expect(chainFlowBook.codes.get('2000')!.ref).toBe(100);
        // 09:40:12 covers minutes before 40 fully and 20 % of minute 40
        expect(chainFlowBook.codes.get('2000')!.seedSlot).toBe(40);
        expect(chainFlowBook.codes.get('2000')!.seedFrac).toBeCloseTo(0.2);

        // a second panel: same subscriptions (ref-counted downstream), no second seed
        const second = connectChainFlow(members);
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.snapshots).toHaveBeenCalledTimes(3);
        second();
        release();
        expect(mocks.unsubscribe).toHaveBeenCalledTimes(6);
        expect(mocks.named.get('kbar')?.size ?? 0).toBe(0);
        expect(mocks.ticks.size).toBe(0);
    });

    it('reuses snapshots another panel already fetched', async () => {
        mocks.shared.set('2330', snapshot('2330', 1010, 10, '2026-10-21 09:59:50.000000'));
        const release = connectChainFlow([member('2330'), member('2317')]);
        await flush();
        await chainFlowSeedIdle();
        release();
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
        expect(mocks.snapshots.mock.calls[0]![0].map((c) => c.code)).toEqual(['2317']);
        expect(chainFlowBook.codes.get('2330')!.ref).toBe(1000);
    });

    it('does not let a stock that has not traded today roll the book back a day', async () => {
        mocks.snapshots.mockImplementation(async () => [
            snapshot('2330', 101, 1, '2026-10-21 10:00:00'),
            snapshot('1101', 50, 0, '2026-10-17 13:30:00'),
        ]);
        const release = connectChainFlow([member('2330'), member('1101')]);
        await flush();
        await chainFlowSeedIdle();
        expect(chainFlowBook.date).toBe('2026-10-21');
        expect(chainFlowBook.codes.get('2330')!.ref).toBe(100);
        expect(chainFlowBook.codes.get('1101')!.ref).toBe(50);
        release();
    });

    it('feeds 1-minute bars and existing ticks into the book', async () => {
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        emitBar({ code: '2330', date: '2026/10/21', time: '09:42:00.000000', open: 101, high: 102, low: 101, close: 102, volume: 3, amount: 306000 });
        const flow = chainFlowBook.codes.get('2330')!;
        expect(flow.amount[41]).toBe(306000);
        expect(flow.net[41]).toBe(306000); // 102 above the 100 reference
        expect(chainFlowStatus().lastBarAt).not.toBeNull();
        mocks.ticks.forEach((listener) => listener({ code: '2330', date: '2026/10/21', close: '103.5', total_amount: '90000000' }));
        expect(flow.last).toBe(103.5);
        expect(flow.tickAmount).toBe(9e7);
        // odd-lot ticks and unknown codes are ignored
        mocks.ticks.forEach((listener) => listener({ code: '2330', date: '2026/10/21', close: '1', intraday_odd: true }));
        mocks.ticks.forEach((listener) => listener({ code: '9999', date: '2026/10/21', close: '1' }));
        expect(flow.last).toBe(103.5);
        expect(chainFlowBook.codes.has('9999')).toBe(false);
        release();
    });

    it('reports a failed K-bar subscription without throwing', async () => {
        mocks.subscribe.mockRejectedValueOnce(new Error('413 Payload Too Large'));
        const release = connectChainFlow([member('2330')]);
        await flush();
        expect(chainFlowStatus().kbarError).toBe('413 Payload Too Large');
        release();
    });

    it('drills into a group with its own key and seeds only new codes', async () => {
        const overview = connectChainFlow([member('2330'), member('2317')]);
        await flush();
        await chainFlowSeedIdle();
        mocks.snapshots.mockClear();
        const drill = connectChainFlow([member('3711'), member('2330')], 'drill');
        await flush();
        await chainFlowSeedIdle();
        const drillKey = mocks.subscribe.mock.calls.at(-1)![0];
        expect(drillKey.startsWith('chainflow:drill:')).toBe(true);
        expect(mocks.snapshots.mock.calls.map(([batch]) => batch.map((c) => c.code))).toEqual([['3711']]);
        expect(chainFlowStatus()).toMatchObject({ kbarCodes: 2, drillCodes: 2, batches: 2, subscribed: 2 });
        drill();
        expect(mocks.unsubscribe.mock.calls.map(([key]) => key)).toEqual([drillKey]);
        expect(chainFlowStatus()).toMatchObject({ kbarCodes: 2, drillCodes: 0, batches: 1 });
        // the stream stays attached for the overview
        expect(mocks.named.get('kbar')?.size).toBe(1);
        overview();
    });

    it('lets a server-side signed flow replace the sign estimate', async () => {
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        emitBar({ code: '2330', date: '2026/10/21', time: '09:42:00.000000', open: 101, high: 102, low: 101, close: 102, volume: 3, amount: 306000, net: -120000 });
        expect(chainFlowBook.codes.get('2330')!.net[41]).toBe(-120000);
        release();
    });

    it('counts the snapshot minute once, pro rata, without losing trading after the snapshot', async () => {
        // snapshot at 09:40:12 already holds the first 12 s of minute 40,
        // whose bar is stamped 09:41 (minute end): only its remaining 48 s are
        // new; the 09:42 bar is new
        mocks.snapshots.mockImplementation(async () => [{ ...snapshot('2330', 101, 1), total_amount: 1_000_000 } as Snapshot]);
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        emitBar({ code: '2330', date: '2026/10/21', time: '09:41:00.000000', open: 101, high: 101, low: 101, close: 101, volume: 1, amount: 60_000 });
        emitBar({ code: '2330', date: '2026/10/21', time: '09:42:00.000000', open: 101, high: 102, low: 101, close: 102, volume: 1, amount: 40_000 });
        expect(sessionTurnover(chainFlowBook.codes.get('2330')!)).toBeCloseTo(1_000_000 + 60_000 * 0.8 + 40_000);
        release();
    });

    it('refetches a cached snapshot left over from an earlier trading day', async () => {
        mocks.shared.set('2330', snapshot('2330', 999, 9, '2026-10-20 13:30:00.000000'));
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.snapshots.mock.calls.map(([batch]) => batch.map((c) => c.code))).toEqual([['2330']]);
        expect(chainFlowBook.codes.get('2330')!.ref).toBe(100);
        release();
    });

    it('reseeds after a day rollover without reusing the old cache', async () => {
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        // the shared store still holds today's (now yesterday's) snapshot
        mocks.shared.set('2330', snapshot('2330', 101, 1));
        mocks.snapshots.mockClear();
        mocks.snapshots.mockImplementation(async () => [snapshot('2330', 120, 2, '2026-10-22 09:30:00.000000')]);
        vi.setSystemTime(new Date('2026-10-22T01:31:00Z'));
        emitBar({ code: '2330', date: '2026/10/22', time: '09:31:00.000000', open: 120, high: 120, low: 120, close: 120, volume: 1, amount: 1000 });
        await flush();
        await chainFlowSeedIdle();
        expect(chainFlowBook.date).toBe('2026-10-22');
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
        expect(chainFlowBook.codes.get('2330')!.ref).toBe(118);
        release();
    });

    it('refetches a cached snapshot of today that is older than the feed start', async () => {
        // cached at 09:05 by another panel; the panel opens at 10:00: the
        // minutes in between were never received as bars
        mocks.shared.set('2330', snapshot('2330', 1010, 10, '2026-10-21 09:05:00.000000'));
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.snapshots.mock.calls.map(([batch]) => batch.map((c) => c.code))).toEqual([['2330']]);
        release();
    });

    it('seeds again from fresh snapshots after every panel closed and one reopens', async () => {
        mocks.snapshots.mockImplementation(async () => [{ ...snapshot('2330', 101, 1, '2026-10-21 09:59:50.000000'), total_amount: 1e6 } as Snapshot]);
        const first = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        first();
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
        // an hour later: the cached 09:59 snapshot is stale and bars were missed
        mocks.shared.set('2330', snapshot('2330', 101, 1, '2026-10-21 09:59:50.000000'));
        vi.setSystemTime(new Date('2026-10-21T03:00:00Z'));
        mocks.snapshots.mockImplementation(async () => [{ ...snapshot('2330', 103, 3, '2026-10-21 10:59:58.000000'), total_amount: 9e6 } as Snapshot]);
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.snapshots).toHaveBeenCalledTimes(2);
        const flow = chainFlowBook.codes.get('2330')!;
        expect(flow.seedAmount).toBe(9e6);
        expect(flow.seedSlot).toBe(119);
        expect(sessionTurnover(flow)).toBe(9e6);
        release();
    });

    it("keeps only the reference from a stock that last traded on an earlier session, whatever the order", async () => {
        mocks.snapshots.mockImplementation(async () => [
            { ...snapshot('1101', 50, 2, '2026-10-17 13:30:00'), total_amount: 8e8 } as Snapshot,
            snapshot('2330', 101, 1, '2026-10-21 10:00:00'),
        ]);
        const release = connectChainFlow([member('1101'), member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        expect(chainFlowBook.date).toBe('2026-10-21');
        const old = chainFlowBook.codes.get('1101')!;
        // that session's close is today's reference; none of its turnover counts
        expect(old.ref).toBe(50);
        expect(old.seedAmount).toBe(0);
        expect(old.seedSlot).toBe(0);
        expect(sessionTurnover(old)).toBe(0);
        expect(chainFlowBook.codes.get('2330')!.ref).toBe(100);
        release();
    });

    it('drops a seed queued by a panel that closed before it ran', async () => {
        connectChainFlow([member('2330')])();
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.snapshots).not.toHaveBeenCalled();
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
        release();
    });

    it('does not let a delayed bar overwrite a newer tick price', async () => {
        const release = connectChainFlow([member('2330')]);
        await flush();
        await chainFlowSeedIdle();
        mocks.ticks.forEach((listener) => listener({ code: '2330', date: '2026/10/21', time: '09:42:30.000000', close: '103.5' }));
        // the 09:41–09:42 bar arrives late, after the 09:42:30 tick
        emitBar({ code: '2330', date: '2026/10/21', time: '09:42:00.000000', open: 101, high: 102, low: 101, close: 102, volume: 3, amount: 306000 });
        expect(chainFlowBook.codes.get('2330')!.last).toBe(103.5);
        release();
    });
});

describe('feedPhase', () => {
    // 2026-10-21 in Taipei (UTC+8)
    const at = (hhmm: string, day = '2026-10-21') => Date.parse(`${day}T${hhmm}:00+08:00`);
    const base = { session: '2026-10-21', lastSlot: 100 };

    it('is live during the session while bars keep arriving', () => {
        expect(feedPhase({ ...base, now: at('10:41'), lastBarAt: at('10:41') - 20_000 })).toBe('live');
    });

    it('stops at the close even when the last bar was not the closing one', () => {
        // last bar 13:00 (slot 240): without the clock it would count down forever
        expect(feedPhase({ session: '2026-10-21', lastSlot: 240, now: at('13:40'), lastBarAt: at('13:01') })).toBe('closed');
        expect(feedPhase({ session: '2026-10-21', lastSlot: 240, now: at('20:00'), lastBarAt: at('13:01') })).toBe('closed');
    });

    it('treats an earlier session as closed (app left open overnight)', () => {
        expect(feedPhase({ ...base, now: at('08:30', '2026-10-22'), lastBarAt: at('13:31') })).toBe('closed');
        expect(feedPhase({ ...base, now: at('09:00', '2026-10-22'), lastBarAt: at('13:31') })).toBe('closed');
    });

    it('reports a stalled stream and waits before the first bar or the open', () => {
        expect(feedPhase({ ...base, now: at('11:00'), lastBarAt: at('10:50') })).toBe('stalled');
        expect(feedPhase({ session: null, lastSlot: null, now: at('09:00'), lastBarAt: null })).toBe('waiting');
        expect(feedPhase({ session: null, lastSlot: null, now: at('08:50'), lastBarAt: null })).toBe('waiting');
    });

    it('is closed once the closing-auction bar arrived', () => {
        expect(feedPhase({ session: '2026-10-21', lastSlot: 270, now: at('13:32'), lastBarAt: at('13:32') })).toBe('closed');
    });
});
