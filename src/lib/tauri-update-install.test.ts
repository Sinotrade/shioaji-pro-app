import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    invoke: vi.fn(),
    check: vi.fn(),
    close: vi.fn(),
    relaunch: vi.fn(),
    notify: vi.fn(),
    channels: [] as Array<{ onmessage?: (event: unknown) => void }>,
}));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: native.invoke,
    Channel: class {
        onmessage?: (event: unknown) => void;
        constructor() {
            native.channels.push(this);
        }
    },
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: native.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: native.relaunch }));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: true }));
vi.mock('./trade', () => ({ notify: native.notify }));

async function loadReadyUpdate() {
    const tauri = await import('./tauri');
    await tauri.checkForUpdates(true);
    return tauri;
}

describe('in-app update goes through the App so it can stop the local server first', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        native.channels.length = 0;
        vi.stubEnv('DEV', false);
        native.check.mockResolvedValue({ version: '0.2.0', close: native.close });
        native.close.mockResolvedValue(undefined);
        native.invoke.mockImplementation(async (command: string, args?: { onEvent?: { onmessage?: (event: unknown) => void } }) => {
            if (command === 'supports_in_app_update') return true;
            if (command === 'app_update_download') {
                args?.onEvent?.onmessage?.({ event: 'Started', data: { contentLength: 100 } });
                args?.onEvent?.onmessage?.({ event: 'Progress', data: { chunkLength: 40 } });
                return '0.2.0';
            }
            if (command === 'app_update_install') return undefined;
            throw new Error(`unexpected command ${command}`);
        });
    });
    afterEach(() => vi.unstubAllEnvs());

    it('downloads through the App, not the plugin handle, and reports progress', async () => {
        const tauri = await import('./tauri');
        const phases: string[] = [];
        tauri.subscribeAppUpdateState(() => phases.push(tauri.getAppUpdateState().phase));
        await tauri.checkForUpdates(true);
        expect(native.invoke).toHaveBeenCalledWith('app_update_download', { onEvent: native.channels[0] });
        expect(native.close).toHaveBeenCalled();
        expect(phases).toContain('downloading');
        expect(tauri.getAppUpdateState()).toEqual({ phase: 'ready', version: '0.2.0' });
    });

    it('installs through the App and relaunches when the install returns', async () => {
        const tauri = await loadReadyUpdate();
        await tauri.restartAndInstallUpdate();
        expect(native.invoke).toHaveBeenCalledWith('app_update_install');
        expect(native.relaunch).toHaveBeenCalled();
    });

    it('keeps the download and stays ready when the server or Agents cannot be stopped', async () => {
        const tauri = await loadReadyUpdate();
        const implementation = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
            if (command === 'app_update_install') {
                throw { kind: 'stopFailed', message: 'Agent 尚未停止，未安裝更新。' };
            }
            return implementation(command, ...args);
        });
        await tauri.restartAndInstallUpdate();
        expect(native.relaunch).not.toHaveBeenCalled();
        expect(tauri.getAppUpdateState()).toEqual({ phase: 'ready', version: '0.2.0' });
        expect(native.notify).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'err',
            body: 'Agent 尚未停止，未安裝更新。',
        }));
        // the user can try again without downloading again
        native.invoke.mockImplementation(implementation);
        await tauri.restartAndInstallUpdate();
        expect(native.relaunch).toHaveBeenCalled();
    });

    it('drops the download when the install itself fails', async () => {
        const tauri = await loadReadyUpdate();
        const implementation = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
            if (command === 'app_update_install') throw { kind: 'installFailed', message: 'disk full' };
            return implementation(command, ...args);
        });
        await tauri.restartAndInstallUpdate();
        expect(tauri.getAppUpdateState()).toEqual({ phase: 'error', version: '0.2.0', error: 'disk full' });
        expect(native.relaunch).not.toHaveBeenCalled();
    });

    it('treats an up-to-date answer from the App as no update', async () => {
        const implementation = native.invoke.getMockImplementation()!;
        native.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
            if (command === 'app_update_download') return null;
            return implementation(command, ...args);
        });
        const tauri = await import('./tauri');
        await tauri.checkForUpdates(true);
        expect(tauri.getAppUpdateState()).toEqual({ phase: 'idle' });
    });
});
