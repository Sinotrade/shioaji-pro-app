import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { sidecar: () => ({ execute: native.execute }) } }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: true }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
import { serverStop } from './tauri';

describe('real desktop serverStop orchestration', () => {
    let agentRunning: boolean;
    let serverRunning: boolean;
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', { setTimeout, clearTimeout });
        agentRunning = true;
        serverRunning = true;
        native.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
            url.endsWith('/info') ? { version: '1.7.5', simulation: false } : { status: 'ok' }
        ), { status: serverRunning && url.includes(':21322/') ? 200 : 503 }));
        native.execute.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
        native.invoke.mockImplementation(async (command: string) => {
            if (command === 'agent_runtime_list') return [{ runtimeId: 'idle-codex', status: agentRunning ? 'running' : 'stopped' }];
            if (command === 'agent_runtime_stop') { agentRunning = false; return true; }
            if (command === 'kill_shioaji') {
                if (agentRunning) throw new Error('仍有 native Agent runtime 執行中；請先停止所有 Agent 才能停止伺服器');
                serverRunning = false;
                return true;
            }
            throw new Error(`unexpected command ${command}`);
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('stops an idle native Agent before an explicitly requested server restart', async () => {
        const result = await serverStop({ stopAgents: true });
        expect(result.ok).toBe(true);
        expect(native.invoke.mock.calls.map(call => call[0])).toContain('agent_runtime_stop');
        expect(serverRunning).toBe(false);
        expect(native.execute).not.toHaveBeenCalled();
    }, 10000);

    it('leaves the server untouched when stopping an Agent fails', async () => {
        const implementation = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
            if (command === 'agent_runtime_stop') throw new Error('native effect still pending');
            return implementation(command, ...args);
        });
        const result = await serverStop({ stopAgents: true });
        expect(result.ok).toBe(false);
        expect(result.output).toContain('native effect still pending');
        expect(native.invoke.mock.calls.some(call => call[0] === 'kill_shioaji')).toBe(false);
        expect(native.execute).not.toHaveBeenCalled();
        expect(serverRunning).toBe(true);
    });

    it('refuses to kill if an Agent is still running after stop', async () => {
        const implementation = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
            if (command === 'agent_runtime_stop') return false;
            return implementation(command, ...args);
        });
        const result = await serverStop({ stopAgents: true });
        expect(result.ok).toBe(false);
        expect(result.output).toContain('Agent 尚未停止');
        expect(native.invoke.mock.calls.some(call => call[0] === 'kill_shioaji')).toBe(false);
    });

    it('fails closed if a new Agent appears after the preflight', async () => {
        const implementation = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
            if (command === 'kill_shioaji') agentRunning = true;
            return implementation(command, ...args);
        });
        const result = await serverStop({ stopAgents: true });
        expect(result.ok).toBe(false);
        expect(result.output).toContain('native Agent runtime');
        expect(native.execute).not.toHaveBeenCalled();
        expect(serverRunning).toBe(true);
    });

    it('preserves external servers when native ownership is refused', async () => {
        agentRunning = false;
        native.invoke.mockRejectedValue('port 21322 上是外部啟動的 shioaji server（PID 99），不是本 App 啟動的');
        native.execute.mockImplementation(async () => { serverRunning = false; return { code: 0, stdout: '', stderr: '' }; });
        const result = await serverStop({});
        expect(result.ok).toBe(false);
        expect(result.output).toContain('外部啟動');
        expect(native.execute).not.toHaveBeenCalled();
        expect(serverRunning).toBe(true);
    });

    it('never retries an unknown native IPC error through the CLI', async () => {
        agentRunning = false;
        native.invoke.mockRejectedValue(new Error('IPC disconnected'));
        const result = await serverStop({});
        expect(result.ok).toBe(false);
        expect(native.execute).not.toHaveBeenCalled();
    });

    it('never bypasses a native lifecycle refusal through CLI fallback', async () => {
        const result = await serverStop({});
        expect(result.ok).toBe(false);
        expect(native.execute).not.toHaveBeenCalled();
        expect(serverRunning).toBe(true);
    }, 10000);
});
