import { afterEach, expect, it, vi } from 'vitest';
import type { ConfigEnv, UserConfig } from 'vite';
import config from '../vite.config';

const resolve = (env: ConfigEnv) => (config as (e: ConfigEnv) => UserConfig)(env);
afterEach(() => { vi.unstubAllEnvs(); });

it('fails the QA frontend build when no isolated port is set', () => {
    vi.stubEnv('VITE_DEV_SERVER_PORT', '');
    expect(() => resolve({ command: 'build', mode: 'qa' })).toThrow('VITE_DEV_SERVER_PORT');
});
it('validates the isolated port in qa mode like vite dev does', () => {
    vi.stubEnv('VITE_DEV_SERVER_PORT', '80');
    expect(() => resolve({ command: 'build', mode: 'qa' })).toThrow('1024');
    vi.stubEnv('VITE_DEV_SERVER_PORT', '21323');
    expect(() => resolve({ command: 'build', mode: 'qa' })).not.toThrow();
});
it('leaves the production build untouched', () => {
    vi.stubEnv('VITE_DEV_SERVER_PORT', '');
    expect(() => resolve({ command: 'build', mode: 'production' })).not.toThrow();
});
