import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getApiBase, getApiPort, getDevServerPort, getServerPid, getStreamBase } from './runtime';

beforeEach(() => {
    const saved: Record<string, string> = { 'sj-pro-api-port': '21322', 'sj-pro-server-port': '21322', 'sj-pro-server-pid': '999' };
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved[key] ?? null });
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_DEV_SERVER_PORT', '21323');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('isolates the native port from saved production state and rejects conflicting REST overrides', () => {
    expect(getApiPort()).toBe(21323);
    expect(getServerPid()).toBeNull();
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:21322');
    expect(() => getApiBase()).toThrow('不一致');
});
it('does not apply development isolation settings in a release build', () => {
    vi.stubEnv('DEV', false);
    expect(getDevServerPort()).toBeUndefined();
    expect(getApiPort()).toBe(21322);
});
it('permits the dev same-origin SSE proxy but refuses a saved formal-server SSE override', () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5187' });
    vi.stubEnv('VITE_STREAM_BASE', 'http://127.0.0.1:21322');
    expect(() => getStreamBase()).toThrow('SSE');
    vi.stubEnv('VITE_STREAM_BASE', 'http://127.0.0.1:5187');
    expect(getStreamBase()).toBe('http://127.0.0.1:5187');
});
it('rejects an invalid isolated port instead of silently adopting the default server', () => {
    vi.stubEnv('VITE_DEV_SERVER_PORT', 'invalid');
    expect(() => getApiPort()).toThrow('1024');
});
it('keeps the QA bundle (release build in qa mode) on the isolated port', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'qa');
    expect(getDevServerPort()).toBe(21323);
    expect(getApiPort()).toBe(21323);
    expect(getServerPid()).toBeNull();
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:21322');
    expect(() => getApiBase()).toThrow('不一致');
});
it('refuses to start a QA bundle without an isolated port instead of falling back to 21322', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'qa');
    vi.stubEnv('VITE_DEV_SERVER_PORT', '');
    expect(() => getDevServerPort()).toThrow('VITE_DEV_SERVER_PORT');
    expect(() => getApiPort()).toThrow('VITE_DEV_SERVER_PORT');
});
