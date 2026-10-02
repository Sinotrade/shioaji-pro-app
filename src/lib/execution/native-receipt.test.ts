import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Separate WebView modules, shared storage, and the real main-only setter gate.
// Status contains only the receipt actually applied by that main-only setter.
function fixture() {
    const store = new Map<string, string>([['sj-pro-native-execution', '1']]);
    let receipt: string | null = null;
    let enabled = false;
    let rejectStatus = false;
    let holdStatus: (() => Promise<unknown>) | null = null;
    const calls: string[] = [];
    const health = () => ({ enabled, enableReceipt: receipt, state: 'live', env: 'simulation', serverId: 'mock-sidecar', programs: 0, revision: 1 });
    const source = readFileSync(new URL('./native.ts', import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    function attach(main: boolean) {
        const module = { exports: {} as typeof import('./native') };
        const handlers: ((event: { key: string; newValue: string | null }) => void)[] = [];
        const mockWindow = { __TAURI_INTERNALS__: {}, addEventListener: (_: string, callback: typeof handlers[number]) => handlers.push(callback) };
        vm.runInNewContext(code, { module, exports: module.exports, console, setTimeout, clearTimeout,
            window: mockWindow, localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
            require(name: string) {
                const mocks: Record<string, unknown> = {
                    react: { useSyncExternalStore() {} }, '../main-window-commands': { isMainWindow: () => main },
                    '../trade': { notify() {} }, '../protection-env': { currentProtectionEnv: () => 'mock-sidecar|simulation', onProtectionEnvChange() {} },
                    '../contracts-cache': { ensureContract: async () => ({}) }, '../quote-ownership': { retainQuote: () => () => {} },
                    './adapter': { envKeyOf: () => 'mock-sidecar|simulation' }, './model': { EXECUTION_SCHEMA_VERSION: 'execution-v1' }, './native-view': { programFinished: () => false },
                };
                if (!(name in mocks)) throw Error(name);
                return mocks[name];
            },
        });
        const api = module.exports;
        api.__setNativeInvokeForTest(async <T>(command: string, args?: Record<string, unknown>) => {
            calls.push(`${main ? 'main' : 'popout'}:${command}`);
            if (command === 'execution_set_enabled') {
                if (!main) throw Error('main-only setter');
                enabled = args?.enabled === true;
                receipt = args?.desiredReceipt as string;
                return health() as T;
            }
            if (command === 'execution_programs') return { revision: 1, programs: [], lastPrices: {} } as T;
            if (command === 'execution_status') {
                if (rejectStatus) throw Error('status unavailable');
                if (holdStatus) return await holdStatus() as T;
                return health() as T;
            }
            throw Error(command);
        }, { enabled: store.get('sj-pro-native-execution') === '1', desktop: true });
        return api;
    }
    return { attach, calls, store, health, restart: () => { receipt = null; }, reject: () => { rejectStatus = true; }, hold: (callback: () => Promise<unknown>) => { holdStatus = callback; } };
}
const env = 'mock-sidecar|simulation';
it('r35 fresh/reloaded popouts use readonly exact current receipt; main-only mutation stays closed', async () => {
    const f = fixture();const main = f.attach(true);await main.refreshNative();main.ensureNativeHost(env);
    for (let i = 0; i < 2; i++) { const popup = f.attach(false);await popup.refreshNative();expect(() => popup.ensureNativeHost(env)).not.toThrow(); }
    expect(f.calls.some(call => call === 'popout:execution_set_enabled')).toBe(false);
});
it('r35 enabled/live cached status without a receipt cannot admit a popout after host restart', async () => {
    const f = fixture();const main = f.attach(true);await main.refreshNative();f.restart();const popup = f.attach(false);await popup.refreshNative();expect(() => popup.ensureNativeHost(env)).toThrow('尚未啟用完成');
});
it('r35 off/on/off and pending/failed status never reuse a prior desired receipt', async () => {
    const f = fixture();const main = f.attach(true);await main.refreshNative();const popup = f.attach(false);await popup.refreshNative();
    main.setNativeExecutionEnabled(false);main.setNativeExecutionEnabled(true);main.setNativeExecutionEnabled(false);
    expect(() => popup.ensureNativeHost(env)).toThrow();await popup.refreshNative();expect(() => popup.ensureNativeHost(env)).toThrow();
    main.setNativeExecutionEnabled(true);await main.refreshNative();await popup.refreshNative();expect(() => popup.ensureNativeHost(env)).not.toThrow();
    main.setNativeExecutionEnabled(false);main.setNativeExecutionEnabled(true);f.reject();await popup.refreshNative();expect(() => popup.ensureNativeHost(env)).toThrow();
});
it('r35 a held old status cannot authorize a setting changed while it was pending', async () => {
    const f = fixture();const main = f.attach(true);await main.refreshNative();const popup = f.attach(false);
    const old = f.health();let release!: (value: unknown) => void;const held = new Promise(r => { release = r; });f.hold(() => held);
    const refresh = popup.refreshNative();await Promise.resolve();main.setNativeExecutionEnabled(false);main.setNativeExecutionEnabled(true);release(old);await refresh;
    expect(() => popup.ensureNativeHost(env)).toThrow();
});
