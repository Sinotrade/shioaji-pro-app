import { afterEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ fetch: vi.fn(), execute: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { sidecar: () => ({ execute: native.execute }) } }));
vi.mock('./runtime', async original => ({ ...await original<object>(), isTauri: true }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
import { serverStatus } from './tauri';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('does not probe or adopt the formal default server when the isolated dev service is down', async () => {
    vi.stubEnv('DEV', true); vi.stubEnv('VITE_DEV_SERVER_PORT', '21323');
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    // HTTP 探測優先走 WebView fetch；兩條路徑都隔離，不接觸本機執行中的服務。
    vi.stubGlobal('fetch', native.fetch);
    native.fetch.mockImplementation(async (url: string) => new Response('{}', { status: url.includes(':21322/') ? 200 : 503 }));
    expect(await serverStatus()).toEqual({ running: false });
    expect(native.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(native.fetch.mock.calls.every(([url]) => String(url).includes(':21323/'))).toBe(true);
    expect(native.execute).not.toHaveBeenCalled();
});
it('QA bundle (qa mode, DEV=false) never probes the formal 21322 or legacy 8080 servers', async () => {
    vi.stubEnv('DEV', false); vi.stubEnv('MODE', 'qa'); vi.stubEnv('VITE_DEV_SERVER_PORT', '21323');
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', native.fetch);
    native.fetch.mockImplementation(async (url: string) => new Response('{}', { status: /:(21322|8080)\//.test(url) ? 200 : 503 }));
    expect(await serverStatus()).toEqual({ running: false });
    expect(native.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(native.fetch.mock.calls.every(([url]) => String(url).includes(':21323/'))).toBe(true);
    expect(native.execute).not.toHaveBeenCalled();
});
