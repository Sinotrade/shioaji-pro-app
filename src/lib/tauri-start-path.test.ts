// src/lib/tauri-start-path.test.ts — serverStart wiring of the #142 start
// path shortcuts against mocked native commands: a dead remembered spawn is
// skipped and its PID never reaches kill_shioaji; boot's probe is reused;
// the post-stop port wait only applies right after our own stop.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), fetch: vi.fn(), readTextFile: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { sidecar: () => ({ execute: native.execute }) } }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: native.readTextFile, exists: async () => false }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/home', join: async (...p: string[]) => p.join('/') }));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: true }));
vi.mock('./trade', () => ({ notify: vi.fn() }));

const storage = new Map<string, string>();
const settings = { credentialRevision: 'native-revision', production: false };
let listening: Set<number>; // ports a sidecar answers on
let bound: Set<number>; // ports find_free_port sees as taken

import * as tauri from './tauri';
import { EXPECTED_SERVER_VERSION } from './runtime';

// resolve the mocked native modules once up front: concurrent FIRST dynamic
// imports of a mocked module (tauri.ts fans probes out) can race past the
// mock in vitest and hit the real Tauri bindings
beforeAll(async () => {
    await import('@tauri-apps/api/core');
    await import('@tauri-apps/plugin-http');
});

// each test starts a minute later, so an earlier test's own stop is never
// "recent" (tauri.ts keeps lastOwnStopAt at module level)
let clock = Date.UTC(2026, 8, 25);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += 60_000;
    vi.setSystemTime(clock);
    vi.clearAllMocks();
    native.readTextFile.mockResolvedValue('');
    storage.clear();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
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
            case 'sidecar_server_status': return { running: false };
            case 'process_alive': return false; // the previous App's sidecar is gone
            case 'find_free_port': {
                let p = args.preferred as number;
                while (bound.has(p)) p++;
                return p;
            }
            case 'kill_shioaji': return false;
            case 'spawn_server': listening.add(args.port as number); bound.add(args.port as number); return { pid: 777, credentialRevision: args.credentialRevision };
            case 'agent_harness_sidecar_owned': return true;
            case 'agent_runtime_list': return [];
            default: throw new Error(`unexpected ${cmd}`);
        }
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const calls = (cmd: string) => native.invoke.mock.calls.filter(c => c[0] === cmd).map(c => c[1]);

describe('serverStart start path', () => {
    it('reads Pro stdout/stderr capture after startup failure when SDK 1.7.9 also announces daily logs', async () => {
        vi.useFakeTimers();
        const output = 'Shioaji server log: /home/.shioaji/logs/server-21322/server.<UTC date>.log\nError: Sign data is timeout.';
        native.readTextFile.mockResolvedValue(output);
        const invoke = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
            cmd === 'spawn_server' ? { pid: 777, credentialRevision: 'native-revision' } : invoke(cmd, args));
        const starting = tauri.serverStart(settings);
        await vi.waitFor(() => expect(calls('spawn_server')).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(3000); // process_alive is throttled to 1.5 seconds
        const result = await starting;
        expect(result).toMatchObject({ ok: false, output });
        expect(native.readTextFile).toHaveBeenCalledExactlyOnceWith('/home/.shioaji/sjpro-server-21322.log');
    });

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
        const spawn = calls('spawn_server')[0];
        expect(spawn).toMatchObject({ port: 21322, credentialRevision: 'native-revision' });
        for (const key of ['SJ_API_KEY', 'SJ_SEC_KEY', 'SJ_CA_PATH', 'SJ_CA_PASSWD']) expect(spawn.env).not.toHaveProperty(key);
        expect(storage.get('sj-pro-spawn-keys')).toBe('native-revision');
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
        expect(native.invoke).toHaveBeenCalledWith('sidecar_server_status');
        expect(native.execute).not.toHaveBeenCalled();
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
            if (cmd === 'spawn_server') { listening.add(args.port as number); return { pid: 778, credentialRevision: args.credentialRevision }; }
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

// #285 — a server this App did not start (no spawn record for its port)
describe('serverStart and another program\'s server', () => {
    // 21322 answers as another App's server: environment and account per test
    function foreignOn21322(info: { simulation: boolean }, personId?: string) {
        listening.add(21322); bound.add(21322);
        native.fetch.mockImplementation(async (url: string) => {
            const port = Number(/:(\d+)\//.exec(url)![1]);
            if (!listening.has(port) || url.startsWith('https')) throw new Error('connection refused');
            if (url.endsWith('/info')) return new Response(JSON.stringify({ version: EXPECTED_SERVER_VERSION, simulation: port === 21322 ? info.simulation : true }));
            if (url.endsWith('/auth/accounts')) return new Response(JSON.stringify(port === 21322 && personId ? [{ person_id: personId }] : []));
            return new Response(JSON.stringify({ status: 'healthy' }));
        });
    }

    it('another App\'s production server is neither used nor stopped: this App starts its own on a free port', async () => {
        foreignOn21322({ simulation: false });
        // This is the onboarding account-change path before serverStart.
        expect((await tauri.serverStop({ stopAgents: true, ownedOnly: true })).ok).toBe(true);
        expect(listening.has(21322)).toBe(true);
        const res = await tauri.serverStart(settings); // simulation
        expect(res).toMatchObject({ ok: true, attached: false, port: 21323,
            foreign: { port: 21322, simulation: false, text: expect.stringContaining('正式伺服器與本 App 設定（模擬）不符') } });
        expect(calls('kill_shioaji').some(k => k.port === 21322)).toBe(false);
        expect(calls('spawn_server')[0]).toMatchObject({ port: 21323 });
    });

    it('the same environment on an account that cannot be confirmed is not used either', async () => {
        foreignOn21322({ simulation: true }, 'B987654321');
        const res = await tauri.serverStart(settings);
        expect(res.attached).toBe(false);
        expect(res.foreign?.text).toContain('無法確認是同一個帳號');
        expect(calls('kill_shioaji').some(k => k.port === 21322)).toBe(false);
    });

    it('another account is not used', async () => {
        const { hashPerson, recordOwnIdentity } = await import('./server-adoption');
        recordOwnIdentity(settings.credentialRevision, await hashPerson('A123456789'));
        foreignOn21322({ simulation: true }, 'B987654321');
        const res = await tauri.serverStart(settings);
        expect(res.attached).toBe(false);
        expect(res.foreign?.text).toContain('登入的是另一個帳號');
    });

    it('the same environment and the account this App\'s own server had: used, and said so', async () => {
        const { hashPerson, recordOwnIdentity } = await import('./server-adoption');
        recordOwnIdentity(settings.credentialRevision, await hashPerson('A123456789'));
        foreignOn21322({ simulation: true }, 'A123456789');
        const res = await tauri.serverStart(settings);
        expect(res.foreign).toBeUndefined();
        expect(res).toMatchObject({ ok: true, attached: true, attachedExternal: true, port: 21322 });
        expect(res.output).toContain('另一個程式啟動的模擬伺服器');
        expect(calls('spawn_server')).toHaveLength(0);
    });

    it('a spawn record left by a sidecar that exited does not make another App\'s server ours', async () => {
        storage.set('sj-pro-server-port', '21322');
        storage.set('sj-pro-server-pid', '4242'); // gone (process_alive → false)
        foreignOn21322({ simulation: false });
        const owned = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
            cmd === 'agent_harness_sidecar_owned' ? false : owned(cmd, args));
        const res = await tauri.serverStart(settings);
        expect(res.attached).toBe(false);
        expect(res.foreign?.port).toBe(21322);
        expect(calls('kill_shioaji').some(k => k.port === 21322)).toBe(false);
        expect(calls('spawn_server')[0]).toMatchObject({ port: 21323 });
    });

    it('reclaim never kills a server that answers, on any of its ports', async () => {
        storage.set('sj-pro-api-port', '21323'); // last port: another program's server answers there too
        foreignOn21322({ simulation: false });
        listening.add(21323); bound.add(21323);
        const res = await tauri.serverStart(settings);
        expect(calls('kill_shioaji').filter(k => k.port === 21322 || k.port === 21323)).toEqual([]);
        expect(res.port).toBe(21324);
    });

    it('this App\'s own server in the wrong mode is still stopped and replaced', async () => {
        storage.set('sj-pro-server-port', '21322');
        foreignOn21322({ simulation: false });
        const invoke = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
            if (cmd === 'kill_shioaji' && args.port === 21322) { listening.delete(21322); bound.delete(21322); return true; }
            return invoke(cmd, args);
        });
        await tauri.serverStart(settings);
        expect(calls('kill_shioaji').some(k => k.port === 21322)).toBe(true);
    });
});

// #285 customer report (v0.1.53): the user's own `shioaji server start`
// (CLI at EXPECTED_SERVER_VERSION, same as the bundled sidecar) on 8080, Agent Harness on.
// Pro used to try to stop it, get refused, and never start its own server.
describe('customer: same-version CLI server on 8080 with Agent Harness on', () => {
    function cliOn8080(personId: string) {
        listening.add(8080); bound.add(8080);
        native.fetch.mockImplementation(async (url: string) => {
            const port = Number(/:(\d+)\//.exec(url)![1]);
            if (!listening.has(port) || url.startsWith('https')) throw new Error('connection refused');
            if (url.endsWith('/info')) return new Response(JSON.stringify({ version: EXPECTED_SERVER_VERSION, simulation: true, agent_harness_enabled: false }));
            if (url.endsWith('/auth/accounts')) return new Response(JSON.stringify([{ person_id: personId }]));
            return new Response(JSON.stringify({ status: 'healthy' }));
        });
        const base = native.invoke.getMockImplementation()!;
        // the native shell owns only what it spawned (never the CLI on 8080)
        native.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
            cmd === 'agent_harness_sidecar_owned' ? args.port !== 8080 && listening.has(args.port as number) : base(cmd, args));
    }

    it('even on the same account: never stops 8080, starts its own on 21322 and says why', async () => {
        const { hashPerson, recordOwnIdentity } = await import('./server-adoption');
        recordOwnIdentity(settings.credentialRevision, await hashPerson('A123456789'));
        cliOn8080('A123456789');
        const status = await tauri.serverStatus();
        expect(EXPECTED_SERVER_VERSION).not.toBe('');
        expect(status).toMatchObject({ running: true, port: 8080, version: EXPECTED_SERVER_VERSION });
        const res = await tauri.serverStart({ ...settings, agentHarnessEnabled: true, knownStatus: status });
        expect(res).toMatchObject({ ok: true, attached: false, port: 21322,
            foreign: { port: 8080, simulation: true } });
        // a clear message in Traditional Chinese, no product brand names
        expect(res.foreign!.text).toContain(':8080 上另一個程式啟動的伺服器');
        expect(res.foreign!.text).toContain('不會停止它');
        expect(res.foreign!.text).not.toMatch(/claude|codex|openai|anthropic/i);
        expect(res.output).toContain('本 App 的伺服器改在 port 21322');
        // 8080 was never touched
        expect(calls('kill_shioaji').some(k => k.port === 8080)).toBe(false);
        expect(calls('spawn_server')).toHaveLength(1);
        expect(calls('spawn_server')[0]).toMatchObject({ port: 21322, agentHarnessEnabled: true });
        expect(listening.has(8080)).toBe(true);
    });

    it('stopping from the App refuses 8080 without any kill', async () => {
        cliOn8080('A123456789');
        const res = await tauri.serverStop();
        expect(res.ok).toBe(false);
        expect(res.output).toContain('不是本 App 啟動的');
        expect(calls('kill_shioaji')).toEqual([]);
    });

    it('21322 already taken by something else: its own server goes to the next free port', async () => {
        cliOn8080('A123456789');
        bound.add(21322); // bound, not a shioaji server
        const res = await tauri.serverStart({ ...settings, agentHarnessEnabled: true });
        expect(res).toMatchObject({ ok: true, port: 21323, foreign: { port: 8080 } });
        expect(calls('kill_shioaji').some(k => k.port === 8080)).toBe(false);
    });
});

describe('page-start reads', () => {
    it('uses the already-working webview for local HTTP even if native probes stall', async () => {
        listening.add(21322);
        vi.stubGlobal('fetch', vi.fn(async (url: string) =>
            new Response(JSON.stringify(url.endsWith('/info')
                ? { version: '1.7.6', simulation: true }
                : { status: 'healthy', session_recovering: false }))));
        native.fetch.mockImplementation(async (_url: string, init?: RequestInit) =>
            new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
        const st = await tauri.serverStatus();
        expect(st).toMatchObject({ running: true, port: 21322, healthy: true });
        expect(native.fetch).not.toHaveBeenCalledWith(expect.stringContaining(':21322/'), expect.anything());
    });

    it('serverStatus returns as soon as the App port answers, without waiting on 8080', async () => {
        listening.add(21322);
        // 8080 hangs until its 5 s probe timeout (a congested plugin-http queue)
        native.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes(':8080/')) {
                return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
            }
            return new Response(JSON.stringify(url.endsWith('/info') ? { version: '1.7.6', simulation: true } : { status: 'healthy' }));
        });
        const t0 = performance.now();
        const st = await tauri.serverStatus();
        expect(st).toMatchObject({ running: true, port: 21322, healthy: true });
        expect(performance.now() - t0).toBeLessThan(1000); // was: ≥ 5 s here
    });

    it('a later candidate still wins only when earlier ones are down', async () => {
        listening.add(8080);
        const st = await tauri.serverStatus();
        expect(st).toMatchObject({ running: true, port: 8080 });
    });
});

describe('candidate order', () => {
    it('both the App port and 8080 answer: the App port wins', async () => {
        listening.add(21322);
        listening.add(8080);
        expect(await tauri.serverStatus()).toMatchObject({ running: true, port: 21322 });
    });

    it('finds a later compatible server when an earlier port answers with the wrong identity', async () => {
        listening.add(21322);
        listening.add(8080);
        const status = await tauri.serverStatus(async (candidate) => candidate.port === 8080);
        expect(status).toMatchObject({ running: true, port: 8080 });
    });
});
