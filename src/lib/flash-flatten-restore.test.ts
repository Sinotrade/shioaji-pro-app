// 閃電平倉沒有成交時，對仍持有的部位恢復原本的停損停利：重查持倉、以可平倉量
// 與原保護量為上限、只做一次、不送單；已穿價的那一邊不恢復；查不到持倉或恢復
// 失敗就明確標示未受保護。
import { describe, expect, it, vi } from 'vitest';
import { restoreAfterUnfilledClose, restorePlan, restoreTriggers, warnIfStillHeld, withFlattenLock } from './flash-flatten-restore';

const snap = { exitAction: 'Sell' as const, stop: 95, take: 110, quantity: 2 };
const noSleep = async () => undefined;

describe('restorePlan', () => {
    it('caps by what is still held, largest protection first', () => {
        expect(restorePlan([snap, { ...snap, stop: 96, quantity: 1 }], 2, 100).legs).toEqual([{ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 }]);
        expect(restorePlan([snap], 5, 100).legs[0]!.quantity).toBe(2);
        expect(restorePlan([snap], 0, 100).legs).toEqual([]);
    });
    it('a leg already crossed is not put back (it would fire at once); both crossed: nothing', () => {
        const p = restorePlan([snap], 2, 94);
        expect(p.legs).toEqual([{ exitAction: 'Sell', stop: null, take: 110, quantity: 2 }]);
        expect(p.skipped[0]).toContain('停損 95 已穿價');
        expect(restorePlan([{ exitAction: 'Buy', stop: 105, take: 90, quantity: 1 }], 1, 89).legs[0]).toMatchObject({ stop: 105, take: null });
    });
});

describe('restoreTriggers', () => {
    it('protective stop / take as one OCO; futures close only; one leg alone', () => {
        const t = restoreTriggers({ exitAction: 'Buy', stop: 105, take: 90, quantity: 3 }, { code: 'TXFR1', futures: true, odd: false, group: 'g' });
        expect(t).toEqual([
            { code: 'TXFR1', action: 'Buy', quantity: 3, octype: 'Cover', condition: 'above', price: 105, kind: 'stop', group: 'g', ocoMode: 'trigger' },
            { code: 'TXFR1', action: 'Buy', quantity: 3, octype: 'Cover', condition: 'below', price: 90, kind: 'take', group: 'g', ocoMode: 'trigger' },
        ]);
        expect(restoreTriggers({ exitAction: 'Sell', stop: null, take: 110, quantity: 1 }, { code: '2330', futures: false, odd: false, group: 'g' }))
            .toEqual([{ code: '2330', action: 'Sell', quantity: 1, condition: 'above', price: 110, kind: 'take' }]);
    });
});

describe('restoreAfterUnfilledClose', () => {
    const run = (o: { close?: ({ final: boolean; filled: number } | null)[]; held?: (number | null)[]; restore?: (leg: unknown) => Promise<boolean>; last?: number | null;
        env?: boolean; snaps?: typeof snap[] } = {}) => {
        const notify = vi.fn();
        const closes = [...(o.close ?? [{ final: true, filled: 0 }])];
        const reads = [...(o.held ?? [2])];
        const restore = vi.fn(o.restore ?? (async () => true));
        const readHeld = vi.fn(async () => (reads.length ? reads.shift()! : null));
        const readClose = vi.fn(async () => (closes.length > 1 ? closes.shift()! : closes[0] ?? null));
        return { notify, restore, readHeld, readClose, done: restoreAfterUnfilledClose(2, o.snaps ?? [snap], 'TXFR1', '口',
            { readClose, readHeld, last: () => (o.last === undefined ? 100 : o.last), envOk: () => o.env ?? true, restore, notify, sleep: noSleep }) };
    };

    it('the close filled: nothing restored, nothing said, the position not even read', async () => {
        const r = run({ close: [{ final: true, filled: 2 }] });
        expect(await r.done).toBe('closed');
        expect(r.restore).not.toHaveBeenCalled();
        expect(r.readHeld).not.toHaveBeenCalled();
        expect(r.notify).not.toHaveBeenCalled();
    });

    it('nothing is restored while the close is still working (it may still fill); flagged unprotected', async () => {
        const r = run({ close: [{ final: false, filled: 0 }] });
        expect(await r.done).toBe('unknown');
        expect(r.restore).not.toHaveBeenCalled();
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 平倉結果尚未確定，停損停利未恢復' }));
    });

    it('final and unfilled: put back once for what is held, with a clear warning', async () => {
        const r = run({ close: [{ final: false, filled: 0 }, { final: true, filled: 0 }] });
        expect(await r.done).toBe('restored');
        expect(r.restore).toHaveBeenCalledTimes(1);
        expect(r.restore).toHaveBeenCalledWith({ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 });
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 平倉未成交，已恢復停損停利', body: expect.stringMatching(/仍持有 \u2061?2 口/) }));
    });

    it('partly filled: only what the close left (never more than held, never more than before − filled)', async () => {
        const r = run({ close: [{ final: true, filled: 1 }], held: [2] });
        expect(await r.done).toBe('restored');
        expect(r.restore).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
    });

    it('flat or the other way round after the close: nothing (never a position we did not hold)', async () => {
        expect(await run({ held: [0] }).done).toBe('closed');
        expect(await run({ held: [-1] }).done).toBe('closed');
    });

    it('a protection of the other direction is never put back for this position', async () => {
        const r = run({ snaps: [{ ...snap, exitAction: 'Buy' as never }] });
        expect(await r.done).toBe('failed');
        expect(r.restore).not.toHaveBeenCalled();
    });

    it('the position cannot be read, the environment changed, or no price of this product: nothing, flagged unprotected', async () => {
        const unreadable = run({ held: [] });
        expect(await unreadable.done).toBe('unknown');
        expect(unreadable.restore).not.toHaveBeenCalled();
        const env = run({ env: false });
        expect(await env.done).toBe('failed');
        expect(env.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('模擬／正式模式已切換') }));
        const price = run({ last: null });
        expect(await price.done).toBe('failed');
        expect(price.restore).not.toHaveBeenCalled();
    });

    it('a read that never answers counts as unreadable (the flow ends, flagged unprotected)', async () => {
        vi.useFakeTimers();
        const notify = vi.fn();
        const p = restoreAfterUnfilledClose(2, [snap], 'TXFR1', '口', { readClose: () => new Promise(() => undefined), readHeld: async () => 2,
            last: () => 100, envOk: () => true, restore: async () => true, notify, sleep: noSleep, delays: [0] });
        await vi.advanceTimersByTimeAsync(6_000);
        expect(await p).toBe('unknown');
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 平倉結果尚未確定，停損停利未恢復' }));
        vi.useRealTimers();
    });

    it('the environment is checked before every leg: a switch midway stops the rest', async () => {
        let ok = true;
        const restore = vi.fn(async () => { ok = false; return true; });
        const notify = vi.fn();
        const out = await restoreAfterUnfilledClose(3, [snap, { ...snap, stop: 96, quantity: 1 }], 'TXFR1', '口', { readClose: async () => ({ final: true, filled: 0 }),
            readHeld: async () => 3, last: () => 100, envOk: () => ok, restore, notify, sleep: noSleep });
        expect(out).toBe('partly');
        expect(restore).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('模擬／正式模式已切換') }));
    });

    it('the restore is refused: flagged unprotected, not retried', async () => {
        const restore = vi.fn(async () => { throw new Error('主視窗沒有回應'); });
        const r = run({ restore });
        expect(await r.done).toBe('failed');
        expect(restore).toHaveBeenCalledTimes(1);
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 平倉未成交，停損停利未恢復（未受保護）' }));
    });

    it('a crossed stop: only the take comes back, and the warning says so', async () => {
        const r = run({ last: 94 });
        expect(await r.done).toBe('partly');
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('停損 95 已穿價') }));
    });
});

describe('warnIfStillHeld (stocks: nothing put back)', () => {
    it('shares still held (any number, odd lots too): an unprotected warning; flat: silent', async () => {
        const notify = vi.fn();
        expect(await warnIfStillHeld(1500, '2330', { readHeld: async () => 500, notify, sleep: noSleep })).toBe(true);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringMatching(/仍持有 \u2061?500 股/) }));
        const quiet = vi.fn();
        expect(await warnIfStillHeld(1500, '2330', { readHeld: async () => 0, notify: quiet, sleep: noSleep })).toBe(false);
        expect(quiet).not.toHaveBeenCalled();
    });
});

describe('withFlattenLock', () => {
    it('one 平倉 per account + product at a time; released afterwards', async () => {
        let release!: () => void;
        const first = withFlattenLock('k', () => new Promise<void>(r => { release = r; }));
        expect(await withFlattenLock('k', async () => undefined)).toBe(false);
        expect(await withFlattenLock('other', async () => undefined)).toBe(true);
        release();
        expect(await first).toBe(true);
        expect(await withFlattenLock('k', async () => undefined)).toBe(true);
    });
});
