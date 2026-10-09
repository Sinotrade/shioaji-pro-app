// src/lib/execution/pending-confirm.test.ts — 待確認 store, notifications,
// mock backend and the Tauri adapter (#201 ③). Nothing here places orders.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    notify: vi.fn(),
    main: true,
    invoke: vi.fn(),
    listen: vi.fn(),
    unlisten: vi.fn(),
}));

vi.mock('../trade', () => ({ notify: m.notify }));
vi.mock('../window-role', () => ({ isChildWindow: () => !m.main }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: m.listen }));

const store = await import('./pending-confirm');
const { mockPendingConfirmItem, mockPendingConfirmSnapshot } = await import('./pending-confirm-mock');
const { PENDING_CONFIRM_CHANGED_EVENT } = await import('./pending-confirm-contract');

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    m.notify.mockReset();
    m.invoke.mockReset();
    m.listen.mockReset();
    m.unlisten.mockReset();
    m.main = true;
});
afterEach(() => store.resetPendingConfirmForTest());

describe('pending confirm store', () => {
    it('stays empty with no backend installed (current paths unchanged)', async () => {
        await store.refreshPendingConfirm();
        expect(store.getPendingConfirmState()).toMatchObject({ snapshot: null, error: null, loading: false });
    });

    it('loads the snapshot and notifies once per new item', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            uncleanShutdown: true,
            items: [mockPendingConfirmItem({ id: 'a' }), mockPendingConfirmItem({ id: 'b', state: 'expired', expiredAt: Date.now() })],
        }));
        store.installPendingConfirmBackend(backend);
        await flush();
        const state = store.getPendingConfirmState();
        expect(state.snapshot?.items.map(i => i.id)).toEqual(['a', 'b']);
        expect(m.notify).toHaveBeenCalledTimes(2);
        expect(m.notify.mock.calls[0]![0]).toMatchObject({ kind: 'err', title: '委託待確認' });
        expect(m.notify.mock.calls[0]![0].body).toContain('不會自動重送');
        expect(m.notify.mock.calls[1]![0]).toMatchObject({ kind: 'info', title: '委託已失效' });
        await store.refreshPendingConfirm();
        expect(m.notify).toHaveBeenCalledTimes(2);
    });

    it('surfaces a malformed snapshot as an error instead of hiding items', async () => {
        store.installPendingConfirmBackend({ list: async () => ({ version: 1, items: 'x' }), resolve: async () => null });
        await flush();
        const state = store.getPendingConfirmState();
        expect(state.error).toMatch(/待確認清單/);
        expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err' }));
    });

    it('keeps the last good snapshot when a later refresh fails', async () => {
        let fail = false;
        const good = mockPendingConfirmSnapshot({ items: [mockPendingConfirmItem({ id: 'a' })] });
        store.installPendingConfirmBackend({
            list: async () => { if (fail) throw new Error('boom'); return good; },
            resolve: async () => null,
        });
        await flush();
        fail = true;
        await store.refreshPendingConfirm();
        const state = store.getPendingConfirmState();
        expect(state.snapshot?.items).toHaveLength(1);
        expect(state.error).toContain('boom');
    });

    it('resolves through the backend with the item revision', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            items: [mockPendingConfirmItem({ id: 'a', revision: 7 })],
        }));
        const resolve = vi.spyOn(backend, 'resolve');
        store.installPendingConfirmBackend(backend);
        await flush();
        const item = store.getPendingConfirmState().snapshot!.items[0]!;
        await store.resolvePendingConfirm(item, 'confirmedNotSent');
        expect(resolve).toHaveBeenCalledWith({ id: 'a', revision: 7, resolution: 'confirmedNotSent' });
        expect(store.getPendingConfirmState().snapshot?.items).toEqual([]);
    });

    it('refuses a resolution that does not fit the state, before calling the backend', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            items: [mockPendingConfirmItem({ id: 'a' })],
        }));
        const resolve = vi.spyOn(backend, 'resolve');
        store.installPendingConfirmBackend(backend);
        await flush();
        const item = store.getPendingConfirmState().snapshot!.items[0]!;
        await expect(store.resolvePendingConfirm(item, 'acknowledgeExpired')).rejects.toThrow();
        expect(resolve).not.toHaveBeenCalled();
    });

    it('only the main window may resolve', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            items: [mockPendingConfirmItem({ id: 'a' })],
        }));
        store.installPendingConfirmBackend(backend);
        await flush();
        m.main = false;
        const item = store.getPendingConfirmState().snapshot!.items[0]!;
        await expect(store.resolvePendingConfirm(item, 'confirmedSent')).rejects.toThrow(/主視窗/);
        expect(store.getPendingConfirmState().snapshot?.items).toHaveLength(1);
    });

    it('a stale revision is refused and the fresh snapshot is adopted', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            items: [mockPendingConfirmItem({ id: 'a', revision: 1 })],
        }));
        store.installPendingConfirmBackend(backend);
        await flush();
        const item = store.getPendingConfirmState().snapshot!.items[0]!;
        backend.replace(mockPendingConfirmSnapshot({ items: [mockPendingConfirmItem({ id: 'a', revision: 2 })] }));
        await expect(store.resolvePendingConfirm(item, 'confirmedSent')).rejects.toThrow(/已更新/);
        expect(store.getPendingConfirmState().snapshot?.items[0]?.revision).toBe(2);
    });
});

describe('ordering and transport changes', () => {
    const deferred = <T,>() => {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>(r => { resolve = r; });
        return { promise, resolve };
    };

    it('a slow older read never overwrites a newer resolve result', async () => {
        const item = mockPendingConfirmItem({ id: 'a' });
        const reads: ReturnType<typeof deferred<unknown>>[] = [];
        const backend = {
            list: () => { const d = deferred<unknown>(); reads.push(d); return d.promise; },
            resolve: async () => ({ ok: true, snapshot: mockPendingConfirmSnapshot({ sequence: 3, items: [] }) }),
        };
        store.installPendingConfirmBackend(backend);
        reads[0]!.resolve(mockPendingConfirmSnapshot({ sequence: 1, items: [item] }));
        await flush();
        const slow = store.refreshPendingConfirm(); // starts before the resolve
        await store.resolvePendingConfirm(store.getPendingConfirmState().snapshot!.items[0]!, 'confirmedSent');
        expect(store.getPendingConfirmState().snapshot?.items).toEqual([]);
        reads[1]!.resolve(mockPendingConfirmSnapshot({ sequence: 2, items: [item] }));
        await slow;
        expect(store.getPendingConfirmState().snapshot?.items).toEqual([]);
        expect(store.getPendingConfirmState().snapshot?.sequence).toBe(3);
    });

    it('a new engine run replaces the old one, and the old run cannot come back', async () => {
        const reads: ReturnType<typeof deferred<unknown>>[] = [];
        store.installPendingConfirmBackend({
            list: () => { const d = deferred<unknown>(); reads.push(d); return d.promise; },
            resolve: async () => null,
        });
        reads[0]!.resolve(mockPendingConfirmSnapshot({ runId: 'old', sequence: 9, items: [mockPendingConfirmItem({ id: 'a' })] }));
        await flush();
        void store.refreshPendingConfirm();
        void store.refreshPendingConfirm();
        reads[1]!.resolve(mockPendingConfirmSnapshot({ runId: 'new', sequence: 1, items: [] }));
        await flush();
        reads[2]!.resolve(mockPendingConfirmSnapshot({ runId: 'old', sequence: 10, items: [mockPendingConfirmItem({ id: 'a' })] }));
        await flush();
        expect(store.getPendingConfirmState().snapshot).toMatchObject({ runId: 'new', items: [] });
    });

    it('a resolve whose backend was replaced meanwhile is reported as unconfirmed', async () => {
        const item = mockPendingConfirmItem({ id: 'a' });
        const pending = deferred<unknown>();
        store.installPendingConfirmBackend({
            list: async () => mockPendingConfirmSnapshot({ items: [item] }),
            resolve: () => pending.promise,
        });
        await flush();
        const done = store.resolvePendingConfirm(store.getPendingConfirmState().snapshot!.items[0]!, 'confirmedNotSent');
        store.installPendingConfirmBackend(store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({ items: [item] })));
        pending.resolve({ ok: true, snapshot: mockPendingConfirmSnapshot({ sequence: 5, items: [] }) });
        await expect(done).rejects.toThrow(/未確認/);
        await flush();
        expect(store.getPendingConfirmState().snapshot?.items).toHaveLength(1);
    });

    it('a card from a replaced transport cannot be decided against the new one', async () => {
        const snap = mockPendingConfirmSnapshot({ items: [mockPendingConfirmItem({ id: 'a' })] });
        store.installPendingConfirmBackend(store.createMockPendingConfirmBackend(snap));
        await flush();
        const old = store.getPendingConfirmState().snapshot!.items[0]!;
        const gen = store.getPendingConfirmState().generation;
        const next = store.createMockPendingConfirmBackend(snap);
        const resolve = vi.spyOn(next, 'resolve');
        store.installPendingConfirmBackend(next);
        await flush();
        expect(store.getPendingConfirmState().generation).not.toBe(gen);
        await expect(store.resolvePendingConfirm(old, 'confirmedNotSent')).rejects.toThrow(/重新核對/);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('a failed subscription is visible', async () => {
        store.installPendingConfirmBackend({
            list: async () => mockPendingConfirmSnapshot(),
            resolve: async () => null,
            subscribe: (_changed, onError) => { onError?.(new Error('no ipc')); return () => undefined; },
        });
        expect(store.getPendingConfirmState().subscriptionError).toMatch(/不會自動更新/);
    });

    it('with nothing shown yet, a late answer from an older request cannot bring an old run back', async () => {
        const reads: ReturnType<typeof deferred<unknown>>[] = [];
        store.installPendingConfirmBackend({
            list: () => { const d = deferred<unknown>(); reads.push(d); return d.promise; },
            resolve: async () => null,
        });
        void store.refreshPendingConfirm(); // e.g. the listener-ready re-list
        reads[1]!.resolve(mockPendingConfirmSnapshot({ runId: 'new', sequence: 1, items: [mockPendingConfirmItem({ id: 'n' })] }));
        await flush();
        reads[0]!.resolve(mockPendingConfirmSnapshot({ runId: 'old', sequence: 50, items: [] }));
        await flush();
        expect(store.getPendingConfirmState().snapshot).toMatchObject({ runId: 'new' });
        void store.refreshPendingConfirm();
        reads[2]!.resolve(mockPendingConfirmSnapshot({ runId: 'new', sequence: 2, items: [] }));
        await flush();
        expect(store.getPendingConfirmState().snapshot).toMatchObject({ runId: 'new', sequence: 2 });
    });

    it('a listener failure survives later successful reads', async () => {
        store.installPendingConfirmBackend({
            list: async () => mockPendingConfirmSnapshot(),
            resolve: async () => null,
            subscribe: (_changed, onError) => { setTimeout(() => onError?.(new Error('no ipc')), 0); return () => undefined; },
        });
        await flush();
        await store.refreshPendingConfirm();
        expect(store.getPendingConfirmState().subscriptionError).toMatch(/不會自動更新/);
        expect(store.getPendingConfirmState().error).toBeNull();
    });

    it('reinstalling the same backend object drops answers to the old install', async () => {
        const reads: ReturnType<typeof deferred<unknown>>[] = [];
        const same = {
            list: () => { const d = deferred<unknown>(); reads.push(d); return d.promise; },
            resolve: async () => null,
        };
        const uninstallFirst = store.installPendingConfirmBackend(same);
        store.installPendingConfirmBackend(same);
        reads[0]!.resolve(mockPendingConfirmSnapshot({ items: [mockPendingConfirmItem({ id: 'old' })] }));
        await flush();
        expect(store.getPendingConfirmState().snapshot).toBeNull();
        uninstallFirst(); // the first install's cleanup must not tear down the second
        reads[1]!.resolve(mockPendingConfirmSnapshot({ items: [] }));
        await flush();
        expect(store.getPendingConfirmState().snapshot).not.toBeNull();
    });

    it('a resolve answer older than the shown list is reported as unconfirmed', async () => {
        const item = mockPendingConfirmItem({ id: 'a' });
        const pending = deferred<unknown>();
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({ sequence: 5, items: [item] }));
        store.installPendingConfirmBackend({ ...backend, resolve: () => pending.promise });
        await flush();
        const done = store.resolvePendingConfirm(store.getPendingConfirmState().snapshot!.items[0]!, 'confirmedSent');
        pending.resolve({ ok: true, snapshot: mockPendingConfirmSnapshot({ sequence: 4, items: [] }) });
        await expect(done).rejects.toThrow(/未確認/);
    });

    it('the mock moves the sequence forward on resolve', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({ sequence: 3, items: [mockPendingConfirmItem({ id: 'a' })] }));
        const result = await backend.resolve({ id: 'a', revision: 1, resolution: 'confirmedSent' }) as { snapshot: { sequence: number } };
        expect(result.snapshot.sequence).toBe(4);
    });

    it('a reinstalled backend notifies again for the same ids', async () => {
        const snap = mockPendingConfirmSnapshot({ items: [mockPendingConfirmItem({ id: 'a' })] });
        store.installPendingConfirmBackend(store.createMockPendingConfirmBackend(snap));
        await flush();
        store.installPendingConfirmBackend(store.createMockPendingConfirmBackend(snap));
        await flush();
        expect(m.notify).toHaveBeenCalledTimes(2);
    });

    it('a read error after a newer list arrived is ignored', async () => {
        const reads: ReturnType<typeof deferred<unknown>>[] = [];
        store.installPendingConfirmBackend({
            list: () => { const d = deferred<unknown>(); reads.push(d); return d.promise; },
            resolve: async () => null,
        });
        const failing = store.refreshPendingConfirm();
        reads[0]!.resolve(mockPendingConfirmSnapshot({ items: [] }));
        await flush();
        reads[1]!.resolve(Promise.reject(new Error('late')) as never);
        await failing;
        expect(store.getPendingConfirmState().error).toBeNull();
    });

    it('notifications use the order unit (口／張／股)', async () => {
        store.installPendingConfirmBackend(store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            items: [mockPendingConfirmItem({ id: 's', order: { ...mockPendingConfirmItem().order, code: '2330', quantity: 30, quantityUnit: 'share' } })],
        })));
        await flush();
        expect(m.notify.mock.calls[0]![0].body).toContain('30 股');
    });
});

describe('mock backend', () => {
    it('never exposes a resend resolution', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            items: [mockPendingConfirmItem({ id: 'a' })],
        }));
        const result = await backend.resolve({ id: 'a', revision: 1, resolution: 'resend' as never });
        expect(result).toMatchObject({ ok: false, reason: 'invalidForState' });
    });
});

describe('tauri backend adapter', () => {
    it('calls the contract command names and event', async () => {
        m.invoke.mockResolvedValue({ version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [] });
        m.listen.mockResolvedValue(m.unlisten);
        const backend = store.createTauriPendingConfirmBackend();
        await backend.list();
        expect(m.invoke).toHaveBeenCalledWith('execution_list_pending_confirm');
        await backend.resolve({ id: 'a', revision: 2, resolution: 'confirmedSent' });
        expect(m.invoke).toHaveBeenCalledWith('execution_resolve_pending', {
            request: { id: 'a', revision: 2, resolution: 'confirmedSent' },
        });
        const cb = vi.fn();
        const stop = backend.subscribe!(cb);
        await flush();
        expect(m.listen).toHaveBeenCalledWith(PENDING_CONFIRM_CHANGED_EVENT, expect.any(Function));
        // once listening, it re-lists so nothing between list and listen is lost
        expect(cb).toHaveBeenCalledTimes(1);
        m.listen.mock.calls[0]![1]();
        expect(cb).toHaveBeenCalledTimes(2);
        stop();
        await flush();
        expect(m.unlisten).toHaveBeenCalled();
    });

    it('rearm sends the confirmed quantity, and is refused by a v1 engine', async () => {
        const item = mockPendingConfirmItem({ id: 'x', state: 'expired', expiredAt: Date.now(),
            order: { ...mockPendingConfirmItem().order, triggerCondition: 'below' } });
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({ version: 2, items: [item] }));
        const resolve = vi.spyOn(backend, 'resolve');
        store.installPendingConfirmBackend(backend);
        await vi.waitFor(() => expect(store.getPendingConfirmState().snapshot?.items).toHaveLength(1));
        await store.resolvePendingConfirm(store.getPendingConfirmState().snapshot!.items[0]!, 'rearmInNewSession', { quantity: 2 });
        expect(resolve).toHaveBeenCalledWith({ id: 'x', revision: 1, resolution: 'rearmInNewSession', quantity: 2 });
        const old = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({ version: 1, items: [item] }));
        store.installPendingConfirmBackend(old);
        await vi.waitFor(() => expect(store.getPendingConfirmState().snapshot?.items).toHaveLength(1));
        await expect(store.resolvePendingConfirm(store.getPendingConfirmState().snapshot!.items[0]!, 'rearmInNewSession', { quantity: 2 }))
            .rejects.toThrow(/不支援/);
        await expect(store.resolvePendingConfirm(store.getPendingConfirmState().snapshot!.items[0]!, 'rearmInNewSession'))
            .rejects.toThrow();
    });
});
