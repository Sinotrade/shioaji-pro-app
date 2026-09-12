import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from './use-query';

const api = vi.hoisted(() => ({ base: 'http://fixture' }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => api.base }));
type Snapshot = ReturnType<typeof useQuery<string>>;
const roots: ReactTestRenderer[] = [];
let counter = 0;
function deferred() { let resolve!: (v: string) => void; let reject!: (e: Error) => void; const promise = new Promise<string>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function Probe({ fetcher, scope, receive, enabled = true }: { fetcher: () => Promise<string>; scope: string; receive: (v: Snapshot) => void; enabled?: boolean }) {
    receive(useQuery(fetcher, scope, enabled));
    return null;
}
async function mount(props: Parameters<typeof Probe>[0]) { let root!: ReactTestRenderer; await act(async () => { root = create(createElement(Probe, props)); }); roots.push(root); return root; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1789200000000); api.base = `http://fixture-${++counter}`; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('session shared query', () => {
    it('loads once with no idle polling, and reuses its snapshot after remount', async () => {
        const fetcher = vi.fn(async () => 'snapshot'); let value!: Snapshot;
        const root = await mount({ fetcher, scope: 'same', receive: v => { value = v; } });
        expect(value.data).toBe('snapshot');
        await act(async () => { vi.advanceTimersByTime(3_600_000); });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { root.unmount(); });
        await mount({ fetcher, scope: 'same', receive: v => { value = v; } });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(value.data).toBe('snapshot');
    });
    it('coalesces components and manual clicks, with no trailing request after completion', async () => {
        const pending = deferred(); const fetcher = vi.fn(() => pending.promise); let a!: Snapshot; let b!: Snapshot;
        await mount({ fetcher, scope: 'same', receive: v => { a = v; } });
        await mount({ fetcher, scope: 'same', receive: v => { b = v; } });
        expect(fetcher).toHaveBeenCalledTimes(1);
        let first!: Promise<void>; let second!: Promise<void>;
        await act(async () => { first = a.refresh(); second = b.refresh(); });
        expect(first).toBe(second);
        await act(async () => { pending.resolve('shared'); await first; });
        expect(a.data).toBe('shared'); expect(b.data).toBe('shared');
        await act(async () => { await a.refresh(); vi.advanceTimersByTime(1500); });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await act(async () => { await b.refresh(); });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('keeps late results in their account scope', async () => {
        const old = deferred(); let value!: Snapshot;
        const receive = (v: Snapshot) => { value = v; };
        const root = await mount({ fetcher: () => old.promise, scope: 'account-A', receive });
        await act(async () => { root.update(createElement(Probe, { fetcher: async () => 'B', scope: 'account-B', receive })); });
        await act(async () => { old.resolve('A'); });
        expect(value.data).toBe('B');
    });
    it('separates server scopes even for the same key', async () => {
        let value!: Snapshot; const receive = (v: Snapshot) => { value = v; };
        const root = await mount({ fetcher: async () => 'server-A', scope: 'same', receive });
        api.base = 'http://another-server';
        await act(async () => { root.update(createElement(Probe, { fetcher: async () => 'server-B', scope: 'same', receive })); });
        expect(value.data).toBe('server-B');
    });
    it('retains data and timestamp when refresh fails, including synchronous throws', async () => {
        let value!: Snapshot; const fetcher = vi.fn<() => Promise<string>>().mockResolvedValueOnce('last').mockImplementationOnce(() => { throw new Error('offline'); });
        await mount({ fetcher, scope: 'same', receive: v => { value = v; } });
        const timestamp = value.updatedAt;
        await act(async () => { vi.advanceTimersByTime(1500); await value.refresh(); });
        expect(value).toMatchObject({ data: 'last', updatedAt: timestamp, error: 'offline', loading: false });
    });
    it('does not fetch or expose a disabled scope until enabled', async () => {
        let value!: Snapshot; const fetcher = vi.fn(async () => 'enabled'); const receive = (v: Snapshot) => { value = v; };
        const root = await mount({ fetcher, scope: 'same', receive, enabled: false });
        await act(async () => { await value.refresh(); });
        expect(fetcher).not.toHaveBeenCalled(); expect(value.data).toBeUndefined();
        await act(async () => { root.update(createElement(Probe, { fetcher, scope: 'same', receive, enabled: true })); });
        expect(value.data).toBe('enabled');
    });
});
