// src/lib/tauri-start-path.test.ts — serverStart wiring of the #142 start
// path shortcuts against mocked native commands: a dead remembered spawn is
// skipped and its PID never reaches kill_shioaji; boot's probe is reused;
// the post-stop port wait only applies right after our own stop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { sidecar: () => ({ execute: native.execute }) } }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: async () => '', exists: async () => false }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home', join: async (...p: string[]) => p.join('/') }));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: true }));
vi.mock('./trade', () => ({ notify: vi.fn() }));

const storage = new Map<string, string>();
const settings = { apiKey: 'k', secretKey: 's', production: false };
let listening: Set<number>; // ports a sidecar answers on
let bound: Set<number>; // ports find_free_port sees as taken

import * as tauri from './tauri';

// each test starts a minute later, so an earlier test's own stop is never
// "recent" (tauri.ts keeps lastOwnStopAt at module level)
let clock = Date.UTC(2026, 8, 25);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += 60_000;
    vi.setSystemTime(clock);
    vi.clearAllMocks();
    storage.clear();
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    // probeFetch retries https through the webview fetch: never hit the network
    vi.stubGlobal('fetch', async () => { throw new Error('connection refused'); });
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
    });
    listening = new Set();
    bound = new Set();
    native.execute.mockResolvedValue({ code: 0, stdout: '{"running":false}', stderr: '' });
    native.fetch.mockImplementation(async (url: string) => {
        const port = Number(/:(\d+)\//.exec(url)![1]);
        if (!listening.has(port) || url.startsWith('https')) throw new Error('connection refused');
        return new Response(JSON.stringify(url.endsWith('/info') ? { version: '1.7.6', simulation: true } : { status: 'healthy' }));
    });
    native.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
        switch (cmd) {
            case 'process_alive': return false; // the previous App's sidecar is gone
            case 'find_free_port': {
                let p = args.preferred as number;
                while (bound.has(p)) p++;
                return p;
            }
            case 'kill_shioaji': return false;
            case 'spawn_server': listening.add(args.port as number); bound.add(args.port as number); return 777;
            case 'agent_harness_sidecar_owned': return true;
            case 'agent_runtime_list': return [];
            default: throw new Error(`unexpected ${cmd}`);
        }
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const calls = (cmd: string) => native.invoke.mock.calls.filter(c => c[0] === cmd).map(c => c[1]);

describe('serverStart start path', () => {
    it('relaunch: a dead remembered spawn is skipped at once and its PID never reaches kill', async () => {
        storage.set('sj-pro-server-pid', '4242');
        storage.set('sj-pro-server-port', '21322');
        const t0 = Date.now();
        const res = await tauri.serverStart(settings);
        expect(res.ok).toBe(true);
        expect(Date.now() - t0).toBeLessThan(2000); // was a 20 s wait
        expect(calls('process_alive')).toEqual([{ pid: 4242 }]);
        const kills = calls('kill_shioaji');
        expect(kills.length).toBeGreaterThan(0);
        expect(kills.every(k => k.pid === null)).toBe(true);
        expect(calls('spawn_server')[0]).toMatchObject({ port: 21322 });
    });

    it('sweeps only ports something is bound to', async () => {
        bound.add(21325); // bound but not a shioaji server
        await tauri.serverStart(settings);
        const probed = native.fetch.mock.calls.map(c => Number(/:(\d+)\//.exec(c[0])![1]));
        const sweepWindow = [...Array.from({ length: 9 }, (_, i) => 21323 + i), ...Array.from({ length: 5 }, (_, i) => 8081 + i)];
        expect(probed.filter(p => sweepWindow.includes(p))).toEqual([21325, 21325]); // http + https
    });

    it('knownStatus from boot: no second status probe or CLI call', async () => {
        await tauri.serverStart({ ...settings, knownStatus: { running: false } });
        expect(native.execute).not.toHaveBeenCalled();
        const withKnown = native.fetch.mock.calls.length;
        vi.clearAllMocks();
        listening.clear(); bound.clear();
        await tauri.serverStart(settings);
        expect(native.execute).toHaveBeenCalled(); // `server status` fallback
        expect(native.fetch.mock.calls.length).toBeGreaterThan(withKnown);
    });

    it('no recent own stop: one find_free_port check, falls to the next port', async () => {
        bound.add(21322);
        const res = await tauri.serverStart(settings);
        expect(calls('find_free_port').filter(a => a.preferred === 21322)).toHaveLength(1);
        expect(res.port).toBe(21323);
    });

    it('right after our own stop: waits for the port to free instead of moving', async () => {
        // a server of ours on 21322 is stopped …
        storage.set('sj-pro-server-pid', '4242');
        storage.set('sj-pro-server-port', '21322');
        listening.add(21322); bound.add(21322);
        native.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
            if (cmd === 'kill_shioaji') { listening.delete(21322); setTimeout(() => bound.delete(21322), 300); return true; }
            if (cmd === 'find_free_port') { let p = args.preferred as number; while (bound.has(p)) p++; return p; }
            if (cmd === 'spawn_server') { listening.add(args.port as number); return 778; }
            if (cmd === 'agent_harness_sidecar_owned') return true;
            if (cmd === 'process_alive') return false;
            throw new Error(`unexpected ${cmd}`);
        });
        expect((await tauri.serverStop()).ok).toBe(true);
        // … and its port is still bound for another 300 ms
        const res = await tauri.serverStart(settings);
        expect(res.port).toBe(21322);
        expect(calls('find_free_port').filter(a => a.preferred === 21322).length).toBeGreaterThan(1);
    });
});
