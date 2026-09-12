import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import metrics from '../lib/__fixtures__/monitor-175.json';
const mocks = vi.hoisted(() => ({ get: vi.fn(), invoke: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: mocks.get }));
vi.mock('../lib/runtime', () => ({ isTauri: true, getApiBase: () => 'http://127.0.0.1:21322' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { ServerMonitor } from './server-monitor';
const usage = { connections: 3, bytes: 29637667, limit_bytes: 2147483648, remaining_bytes: 2117845981 };
const subscriptions = { total: 71, market_data: 71, trade_accounts: 0, by_type: { tick: 35, bidask: 35, quote: 1 }, partial: false, unavailable: false, items: [{}] };
describe('server monitor view and collection lifecycle', () => {
    let renderer: ReactTestRenderer;
    let visibility: string;
    let changed: () => void;
    beforeEach(() => {
        vi.useFakeTimers(); visibility = 'visible';
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('document', { get visibilityState() { return visibility; }, addEventListener: (_: string, fn: () => void) => { changed = fn; }, removeEventListener: vi.fn() });
        mocks.get.mockReset().mockImplementation(async (path: string) => path.includes('/usage') ? usage : path.includes('/subscriptions') ? subscriptions : metrics);
        mocks.invoke.mockReset().mockResolvedValue(true);
    });
    afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
    const mount = async () => { await act(async () => { renderer = create(createElement(ServerMonitor)); }); };
    const button = (label: string) => renderer.root.findAllByType('button').find(n => n.children.join('').includes(label))!;
    const text = () => JSON.stringify(renderer.toJSON());
    it('uses actual quota and global subscriptions, with evidence caveats', async () => {
        await mount();
        expect(text()).toContain('1.4%'); expect(text()).toContain('71');
        expect(text()).toContain('未開啟，無明細'); expect(text()).toContain('並非券商限流桶');
        expect(text()).toContain('4 筆觀測');
        expect(mocks.get.mock.calls.every(([, options]) => options.headers['X-Shioaji-Activity'] === 'dashboard')).toBe(true);
    });
    it('keeps failed or malformed resources unknown instead of crashing or reporting zero', async () => {
        mocks.get.mockRejectedValue(new Error('not logged in')); await mount();
        expect(text()).toContain('監控無法取得'); expect(text()).toContain('not logged in'); expect(text()).toContain('額度未知');
        expect(renderer.root.findByProps({ role: 'meter' }).props['aria-valuenow']).toBeUndefined();
        await act(async () => renderer.unmount());
        mocks.get.mockResolvedValue({}); await mount();
        expect(text()).toContain('格式不相容');
    });
    it('pauses reads and unmounts the dashboard when hidden, collapsed or paused', async () => {
        await mount();
        await act(async () => button('官方').props.onClick());
        expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
        const signals = mocks.get.mock.calls.map(([, options]) => options.signal as AbortSignal);
        await act(async () => { visibility = 'hidden'; changed(); });
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
        const count = mocks.get.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(mocks.get).toHaveBeenCalledTimes(count); expect(signals.every(s => s.aborted)).toBe(true);
        await act(async () => { visibility = 'visible'; changed(); });
        expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
        await act(async () => button('收合').props.onClick());
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
        await act(async () => button('暫停').props.onClick());
        expect(text()).toContain('上次觀測');
        const pausedCount = mocks.get.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(mocks.get).toHaveBeenCalledTimes(pausedCount);
        await act(async () => button('繼續').props.onClick());
        expect(mocks.get.mock.calls.length).toBeGreaterThan(pausedCount);
    });
    it('revokes embedded access when ownership disappears', async () => {
        await mount(); await act(async () => button('官方').props.onClick());
        mocks.invoke.mockResolvedValue(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
        expect(button('官方')).toBeUndefined();
    });
    it('does not stack reads while requests are pending and aborts at the deadline', async () => {
        mocks.get.mockImplementation(() => new Promise(() => {})); await mount();
        const count = mocks.get.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(mocks.get).toHaveBeenCalledTimes(count);
        expect(mocks.get.mock.calls.every(([, opts]) => opts.signal.aborted)).toBe(true);
    });
    it('does not overlap slow ownership queries', async () => {
        mocks.invoke.mockImplementation(() => new Promise(() => {})); await mount();
        await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
    });
});
