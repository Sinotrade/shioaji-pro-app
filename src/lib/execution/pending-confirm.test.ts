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
vi.mock('../main-window-commands', () => ({ isMainWindow: () => m.main }));
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
        expect(store.getPendingConfirmState()).toEqual({ snapshot: null, error: null, loading: false });
    });

    it('loads the snapshot and notifies once per new item', async () => {
        const backend = store.createMockPendingConfirmBackend(mockPendingConfirmSnapshot({
            uncleanShutdown: true,
            items: [mockPendingConfirmItem({ id: 'a' }), mockPendingConfirmItem({ id: 'b', state: 'expired', expiredAt: 2 })],
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
        m.invoke.mockResolvedValue({ version: 1, uncleanShutdown: false, items: [] });
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
        stop();
        await flush();
        expect(m.unlisten).toHaveBeenCalled();
    });
});
