import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), invoke: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: mocks.get }));
vi.mock('../lib/runtime', () => ({ isTauri: true, getApiBase: () => 'http://127.0.0.1:21322' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { ServerMonitor } from './server-monitor';

describe('server monitor collection lifecycle', () => {
    let renderer: ReactTestRenderer;
    let visibility: string;
    let changed: () => void;
    beforeEach(() => {
        vi.useFakeTimers();
        visibility = 'visible';
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('document', {
            get visibilityState() { return visibility; },
            addEventListener: (_: string, callback: () => void) => { changed = callback; },
            removeEventListener: vi.fn(),
        });
        mocks.get.mockReset().mockResolvedValue({ connections: 2, bytes: 1048576, limit_bytes: 10485760, remaining_bytes: 9437184 });
        mocks.invoke.mockReset().mockResolvedValue(true);
    });
    afterEach(async () => {
        if (renderer) await act(async () => renderer.unmount());
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
    const mount = async () => { await act(async () => { renderer = create(createElement(ServerMonitor)); }); };
    it('keeps unavailable values unknown instead of reporting zero', async () => {
        mocks.get.mockRejectedValue(new Error('not logged in'));
        await mount();
        expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain('not logged in');
        expect(renderer.root.findAllByType('span').filter(node => node.children.join('') === '—')).toHaveLength(4);
    });
    it('rejects incompatible payloads instead of displaying invalid usage', async () => {
        mocks.get.mockResolvedValue({ connections: 1, bytes: null, limit_bytes: 3, remaining_bytes: 2 });
        await mount();
        expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain('用量格式不相容');
    });
    it('unmounts dashboard when collapsed or hidden and pauses usage polling', async () => {
        await mount();
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
        await act(async () => renderer.root.findByType('button').props.onClick());
        expect(renderer.root.findByType('iframe').props.src).toBe('http://127.0.0.1:21322/');
        await act(async () => { visibility = 'hidden'; changed(); });
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(mocks.get).toHaveBeenCalledTimes(1);
        await act(async () => { visibility = 'visible'; changed(); });
        expect(mocks.get).toHaveBeenCalledTimes(2);
        expect(renderer.root.findAllByType('iframe')).toHaveLength(1);
        await act(async () => renderer.root.findByType('button').props.onClick());
        expect(renderer.root.findAllByType('iframe')).toHaveLength(0);
    });
    it('does not offer a dashboard for an externally attached server', async () => {
        mocks.invoke.mockResolvedValue(false);
        await mount();
        expect(renderer.root.findAllByType('button')).toHaveLength(0);
        expect(mocks.invoke).toHaveBeenCalledWith('agent_harness_sidecar_owned', { port: 21322 });
    });
});
