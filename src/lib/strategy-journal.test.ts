import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRATEGY_ENGINE_VERSION, type StrategyFrame } from './strategy-lab-types';
import type { Candle } from './types/market';

// Small transactional IDB test double, not a persistence fallback. Stores survive
// connection close / module reload; transactions serialize and roll back writes.
// Browser IDB behavior still requires the separate browser integration check.
type Row = { id: string; [key: string]: unknown };
class Request<T = unknown> {
    result!: T;
    error: DOMException | null = null;
    onsuccess?: () => void;
    onerror?: () => void;
}
function fakeIndexedDb() {
    let stores = new Map<string, Map<string, Row>>();
    let opened = false;
    let closed = 0;
    let writesBeforeFailure = Infinity;
    let active = false;
    const waiting: (() => void)[] = [];
    const startNext = () => { if (!active && waiting.length) { active = true; waiting.shift()!(); } };
    const database = {
        objectStoreNames: { contains: (name: string) => stores.has(name) },
        createObjectStore: (name: string) => { stores.set(name, new Map()); },
        close: () => { closed++; },
        onversionchange: undefined as (() => void) | undefined,
        transaction(names: string[] | string, mode: string) {
            const scope = Array.isArray(names) ? names : [names];
            let local = new Map<string, Map<string, Row>>();
            let running = false;
            let done = false;
            let scheduled = false;
            const queue: (() => void)[] = [];
            const tx = {
                error: null as DOMException | null,
                oncomplete: undefined as (() => void) | undefined,
                onabort: undefined as (() => void) | undefined,
                onerror: undefined as (() => void) | undefined,
                abort() {
                    if (done) return;
                    done = true;
                    queueMicrotask(() => { tx.onabort?.(); active = false; startNext(); });
                },
                objectStore(name: string) {
                    if (!scope.includes(name)) throw new Error('store outside transaction scope');
                    const request = <T>(operation: (rows: Map<string, Row>) => T, write = false): Request<T> => {
                        const req = new Request<T>();
                        queue.push(() => {
                            if (done) return;
                            try {
                                if (write && writesBeforeFailure-- <= 0) throw new DOMException('full', 'QuotaExceededError');
                                req.result = structuredClone(operation(local.get(name)!));
                                req.onsuccess?.();
                            } catch (e) {
                                req.error = e instanceof DOMException ? e : new DOMException(String(e), 'UnknownError');
                                tx.error = req.error;
                                req.onerror?.(); tx.onerror?.(); tx.abort();
                            }
                        });
                        schedule();
                        return req;
                    };
                    return {
                        get: (id: string) => request((rows) => rows.get(id)),
                        getAll: () => request((rows) => [...rows.values()]),
                        count: () => request((rows) => rows.size),
                        add: (row: Row) => request((rows) => {
                            if (rows.has(row.id)) throw new DOMException('duplicate', 'ConstraintError');
                            rows.set(row.id, structuredClone(row)); return row.id;
                        }, true),
                        put: (row: Row) => request((rows) => { rows.set(row.id, structuredClone(row)); return row.id; }, true),
                    };
                },
            };
            const schedule = () => {
                if (!running || scheduled || done) return;
                scheduled = true;
                queueMicrotask(() => {
                    scheduled = false;
                    if (done) return;
                    const next = queue.shift();
                    if (next) { next(); schedule(); return; }
                    done = true;
                    if (mode === 'readwrite') for (const name of scope) stores.set(name, local.get(name)!);
                    tx.oncomplete?.(); active = false; startNext();
                });
            };
            waiting.push(() => { local = structuredClone(stores); running = true; schedule(); });
            queueMicrotask(startNext);
            return tx;
        },
    };
    return {
        factory: {
            open: vi.fn((name: string, version: number) => {
                expect(name).toBe('v9-strategy-journal-v1');
                expect(version).toBe(1);
                const req = new Request<typeof database>() as Request<typeof database> & { onupgradeneeded?: () => void; onblocked?: () => void };
                req.result = database;
                queueMicrotask(() => { if (!opened) { opened = true; req.onupgradeneeded?.(); } req.onsuccess?.(); });
                return req;
            }),
        },
        rows: (name: string) => stores.get(name)!,
        closeCount: () => closed,
        failWritesAfter: (count: number) => { writesBeforeFailure = count; },
    };
}
const base = Date.parse('2026-10-07T00:00:00Z') / 1000;
const candle = (time: number): Candle => ({ time, open: 100, high: 102, low: 99, close: 101, volume: 10 });
function fixture(id = 'scan-1'): StrategyFrame {
    return {
        schemaVersion: 1, engineVersion: STRATEGY_ENGINE_VERSION, id,
        capturedAt: Date.parse('2026-10-07T09:40:30+08:00'),
        sourceKey: 'http://127.0.0.1:21322|TW:STK|taipei-minute-close-v1',
        poolCodes: ['2330'], warnings: ['僅研究，不下單'],
        decisions: [{ code: '2330', kind: 'observation', side: 'long', reasons: ['盤中資料不足'] }],
        indexChangeRate: 0.2, indexAsOf: Date.parse('2026-10-07T09:40:25+08:00'),
        inputs: [{
            contract: {
                region: 'TW', security_type: 'STK', exchange: 'TSE', code: '2330', target_code: null,
                name: '台積電', currency: 'TWD', day_trade: 'Yes', update_date: '2026-10-07',
                limit_up: 110, limit_down: 90, reference: 100, category: '24',
                margin_trading_balance: 0, short_selling_balance: 0,
                unit: 1000, trading_suspended: false, disposition_level: 0,
                attention_flag: false, settlement_type: '', sbl_shortable: true,
            },
            daily: [candle(base - 86400 * 2), candle(base - 86400)],
            minutes: [candle(base - 86400 + 9 * 3600), candle(base + 9 * 3600), candle(base + 9 * 3600 + 60)],
            snapshot: {
                code: '2330', exchange: 'TSE', datetime: '2026-10-07T09:40:25+08:00',
                open: 100, high: 102, low: 99, close: 101, average_price: 100.5,
                buy_price: 100.5, buy_volume: 10, sell_price: 101.5, sell_volume: 12,
                volume: 100, total_volume: 8000, amount: 100000, total_amount: 850000000,
                change_price: 1, change_rate: 1, change_type: '1', tick_type: '1', volume_ratio: 1.5, yesterday_volume: 3000,
            },
            shortSource: { quantity: 100, datetime: '2026-10-07T09:40:25+08:00' },
        }],
    };
}
const bundle = (...frames: StrategyFrame[]) => JSON.stringify({ schemaVersion: 1, frames });

describe('durable research journal', () => {
    let fake: ReturnType<typeof fakeIndexedDb>;
    beforeEach(() => {
        vi.resetModules();
        fake = fakeIndexedDb();
        vi.stubGlobal('indexedDB', fake.factory);
        vi.stubGlobal('BroadcastChannel', undefined);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

    it('persists immutable captures across closed connections and module reloads', async () => {
        const journal = await import('./strategy-journal');
        const frame = fixture();
        const expected = structuredClone(frame);
        const write = journal.appendStrategyFrame(frame);
        frame.inputs[0]!.daily[0]!.close = 99;
        frame.decisions[0]!.reasons.push('later mutation');
        await write;
        expect(fake.closeCount()).toBe(1);
        vi.resetModules();
        const reopened = await import('./strategy-journal');
        expect(await reopened.loadStrategyFrame(frame.id)).toEqual(expected);
        expect(await reopened.listStrategyFrames()).toEqual([{ id: frame.id, capturedAt: frame.capturedAt, sourceKey: frame.sourceKey, poolSize: 1, warnings: frame.warnings }]);
        const loaded = await reopened.loadStrategyFrame(frame.id);
        loaded.warnings.push('caller mutation');
        expect((await reopened.loadStrategyFrame(frame.id)).warnings).toEqual(expected.warnings);
    });

    it('deduplicates prior daily/minute-day chunks, but retains each distinct scan', async () => {
        const journal = await import('./strategy-journal');
        const first = fixture();
        await journal.appendStrategyFrame(first);
        expect(fake.rows('chunks').size).toBe(3);
        const second = fixture('scan-2');
        second.capturedAt += 60_000;
        second.inputs[0]!.minutes.push(candle(base + 9 * 3600 + 120));
        await journal.appendStrategyFrame(second);
        expect(fake.rows('chunks').size).toBe(4);
        expect(await journal.listStrategyFrames()).toHaveLength(2);
        expect(await journal.loadStrategyFrame(first.id)).toEqual(first);
        expect(await journal.loadStrategyFrame(second.id)).toEqual(second);
    });

    it('makes same-ID same-content imports idempotent and rejects conflicting batches atomically', async () => {
        const journal = await import('./strategy-journal');
        const frame = fixture();
        expect(await journal.importStrategyJournal(bundle(frame, frame))).toBe(1);
        expect(await journal.importStrategyJournal(bundle(frame))).toBe(0);
        const modified = structuredClone(frame); modified.warnings.push('different');
        await expect(journal.importStrategyJournal(bundle(fixture('new'), modified))).rejects.toThrow('拒絕覆蓋');
        expect(await journal.listStrategyFrames()).toHaveLength(1);
        expect(await journal.loadStrategyFrame(frame.id)).toEqual(frame);
        await expect(journal.importStrategyJournal(bundle(modified, frame))).rejects.toThrow('同一 ID');
    });

    it('round-trips self-contained JSON with timestamps, inputs and decisions intact', async () => {
        const journal = await import('./strategy-journal');
        const frame = fixture(); await journal.appendStrategyFrame(frame);
        const text = await journal.exportStrategyJournal([frame.id, frame.id]);
        expect(JSON.parse(text)).toEqual({ schemaVersion: 1, frames: [frame] });
        fake = fakeIndexedDb(); vi.stubGlobal('indexedDB', fake.factory);
        expect(await journal.importStrategyJournal(text)).toBe(1);
        expect(await journal.loadStrategyFrame(frame.id)).toEqual(frame);
    });

    it('whitelists every nested object and never exports unknown credentials/order fields', async () => {
        const journal = await import('./strategy-journal');
        const clean = fixture();
        const dirty = structuredClone(clean);
        Object.assign(dirty, { api_key: 'TOP_SECRET', account: { id: 'TOP_SECRET' }, order: 'TOP_SECRET' });
        Object.assign(dirty.inputs[0]!, { accessToken: 'TOP_SECRET' });
        Object.assign(dirty.inputs[0]!.contract, { certificate: 'TOP_SECRET', account_id: 'TOP_SECRET' });
        Object.assign(dirty.inputs[0]!.daily[0]!, { password: 'TOP_SECRET' });
        Object.assign(dirty.inputs[0]!.snapshot!, { authorization: 'TOP_SECRET' });
        Object.assign(dirty.inputs[0]!.shortSource!, { secret: 'TOP_SECRET' });
        Object.assign(dirty.decisions[0]!, { execute: 'TOP_SECRET' });
        await journal.importStrategyJournal(bundle(dirty));
        const text = await journal.exportStrategyJournal([dirty.id]);
        expect(text).not.toContain('TOP_SECRET');
        expect(JSON.parse(text).frames[0]).toEqual(clean);
    });

    it('validates engines, OHLC, numeric values, pool membership and limits before writing', async () => {
        const journal = await import('./strategy-journal');
        const invalidFrames = [
            { ...fixture(), schemaVersion: 2 },
            { ...fixture(), engineVersion: 'future-engine' },
            { ...fixture(), capturedAt: -1 },
            { ...fixture(), sourceKey: 'https://user:password@localhost' },
            { ...fixture(), sourceKey: 'http://localhost?token=secret' },
            { ...fixture(), inputs: Array.from({ length: 41 }, () => fixture().inputs[0]) },
            { ...fixture(), poolCodes: ['2330', '2330'] },
            { ...fixture(), decisions: [{ code: '9999', kind: 'excluded', reasons: [] }] },
        ];
        for (const frame of invalidFrames) await expect(journal.importStrategyJournal(JSON.stringify({ schemaVersion: 1, frames: [frame] }))).rejects.toThrow('研究日誌');
        const badOhlc = fixture(); badOhlc.inputs[0]!.daily[0]!.high = 50;
        await expect(journal.appendStrategyFrame(badOhlc)).rejects.toThrow('OHLC');
        const badNumber = fixture(); badNumber.inputs[0]!.daily[0]!.volume = NaN;
        await expect(journal.appendStrategyFrame(badNumber)).rejects.toThrow('volume');
        const tooMany = fixture(); tooMany.inputs[0]!.daily = Array.from({ length: 50001 }, (_, i) => candle(i));
        await expect(journal.appendStrategyFrame(tooMany)).rejects.toThrow('50,000');
        await expect(journal.importStrategyJournal('{bad')).rejects.toThrow('JSON');
        await expect(journal.importStrategyJournal(bundle(...Array.from({ length: 501 }, () => fixture())))).rejects.toThrow('500');
        expect(fake.factory.open).not.toHaveBeenCalled();
    });

    it('rejects oversized imports and mixed-source bundles without touching storage', async () => {
        const journal = await import('./strategy-journal');
        await expect(journal.importStrategyJournal(' '.repeat(50 * 1024 * 1024 + 1))).rejects.toThrow('50 MiB');
        const other = fixture('other'); other.sourceKey = 'another-source';
        await expect(journal.importStrategyJournal(bundle(fixture(), other))).rejects.toThrow('不同資料來源');
        expect(fake.factory.open).not.toHaveBeenCalled();
    });

    it('does not silently fall back when IndexedDB is unavailable', async () => {
        const journal = await import('./strategy-journal');
        vi.stubGlobal('indexedDB', undefined);
        await expect(journal.appendStrategyFrame(fixture())).rejects.toThrow('未改用暫存記憶體');
        await expect(journal.listStrategyFrames()).rejects.toThrow('IndexedDB');
    });

    it('rolls back chunks, manifests and capacity metadata together on quota failure', async () => {
        const journal = await import('./strategy-journal');
        const first = fixture(); await journal.appendStrategyFrame(first);
        const before = structuredClone([...fake.rows('metadata').values()]);
        fake.failWritesAfter(1);
        const second = fixture('scan-2'); second.inputs[0]!.minutes.push(candle(base + 9 * 3600 + 120));
        await expect(journal.appendStrategyFrame(second)).rejects.toThrow('儲存空間不足');
        expect(fake.rows('frames').size).toBe(1);
        expect(fake.rows('chunks').size).toBe(3);
        expect([...fake.rows('metadata').values()]).toEqual(before);
        expect(await journal.loadStrategyFrame(first.id)).toEqual(first);
    });

    it('checks the shared 128 MiB cap in the transaction and preserves prior records', async () => {
        const journal = await import('./strategy-journal');
        const frame = fixture(); await journal.appendStrategyFrame(frame);
        fake.rows('metadata').set('totals', { id: 'totals', bytes: 128 * 1024 * 1024 });
        await expect(journal.appendStrategyFrame(fixture('new'))).rejects.toThrow('128 MiB');
        expect(await journal.loadStrategyFrame(frame.id)).toEqual(frame);
        expect(fake.rows('frames').size).toBe(1);
    });

    it('serializes overlapping connections at the 500-frame boundary, not with an in-memory mutex', async () => {
        const journal = await import('./strategy-journal');
        await journal.appendStrategyFrame(fixture());
        const seed = fake.rows('frames').get('scan-1')!;
        for (let i = 1; i < 499; i++) fake.rows('frames').set(`seed-${i}`, { ...seed, id: `seed-${i}` });
        const attempts = await Promise.allSettled([journal.appendStrategyFrame(fixture('new-1')), journal.appendStrategyFrame(fixture('new-2'))]);
        expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(fake.rows('frames').size).toBe(500);
    });

    it('notifies only after commit and closes cross-tab subscriptions when unused', async () => {
        const channels: { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onmessage?: (event: { data: string }) => void }[] = [];
        vi.stubGlobal('BroadcastChannel', class {
            postMessage = vi.fn(); close = vi.fn(); onmessage?: (event: { data: string }) => void;
            constructor() { channels.push(this); }
        });
        const journal = await import('./strategy-journal');
        const notified = vi.fn(() => expect(fake.rows('frames').size).toBeGreaterThan(0));
        const unsubscribe = journal.subscribeStrategyJournal(notified);
        await journal.appendStrategyFrame(fixture());
        expect(notified).toHaveBeenCalledTimes(1);
        expect(channels[0]!.postMessage).toHaveBeenCalledWith('committed');
        await journal.appendStrategyFrame(fixture());
        expect(notified).toHaveBeenCalledTimes(1);
        channels[0]!.onmessage?.({ data: 'committed' });
        expect(notified).toHaveBeenCalledTimes(2);
        fake.failWritesAfter(0);
        await expect(journal.appendStrategyFrame(fixture('failed'))).rejects.toThrow();
        expect(notified).toHaveBeenCalledTimes(2);
        unsubscribe();
        expect(channels[0]!.close).toHaveBeenCalledTimes(1);
    });

    it('fails closed for missing or tampered historical chunks', async () => {
        const journal = await import('./strategy-journal');
        await journal.appendStrategyFrame(fixture());
        await expect(journal.loadStrategyFrame('absent')).rejects.toThrow('找不到');
        const [id, chunk] = [...fake.rows('chunks')][0]!;
        fake.rows('chunks').set(id, { ...chunk, json: `${chunk.json} ` });
        await expect(journal.loadStrategyFrame('scan-1')).rejects.toThrow('校驗失敗');
        fake.rows('chunks').delete(id);
        await expect(journal.loadStrategyFrame('scan-1')).rejects.toThrow('缺少歷史區塊');
    });
});
