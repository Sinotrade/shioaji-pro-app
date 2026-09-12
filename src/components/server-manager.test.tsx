import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), start: vi.fn(), stop: vi.fn(), status: vi.fn(), env: vi.fn(), notify: vi.fn(), info: vi.fn() }));
vi.mock('../lib/tauri', () => ({
    isTauri: true, appVersion: async () => 'dev · test',
    loadDesktopSettings: mocks.load, saveDesktopSettings: mocks.save,
    serverStart: mocks.start, serverStop: mocks.stop, serverStatus: mocks.status,
    pickEnvFile: mocks.env, pickCaFile: vi.fn(),
    subscribeAgentHarnessEnabled: () => () => {}, subscribeAppUpdateState: () => () => {},
    getAppUpdateState: () => updateState, checkForUpdates: vi.fn(), ensureLocalTlsCert: vi.fn(),
    openLatestRelease: vi.fn(), reloadWhenHealthy: vi.fn(), restartAndInstallUpdate: vi.fn(),
}));
vi.mock('../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../lib/shioaji', () => ({ fetchHealth: async () => null, fetchInfo: mocks.info, fetchAccounts: async () => [], fetchCaExpire: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify }));
const updateState = { phase: 'idle' };
import { ServerManager } from './server-manager';
import { ServerSettingsDialog } from './server-settings-dialog';
const initial = { apiKey: 'test-key', secretKey: 'test-secret', production: false, caPath: '', caPasswd: '', autoStart: true, httpsEnabled: false, agentHarnessEnabled: true };

describe('server settings edit and apply workflow', () => {
    let view: ReactTestRenderer;
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', new EventTarget());
        vi.clearAllMocks();
        mocks.load.mockResolvedValue({ ...initial }); mocks.save.mockResolvedValue(undefined);
        mocks.status.mockResolvedValue({ running: true, healthy: true, simulation: false, scheme: 'http', port: 21322 });
        mocks.start.mockResolvedValue({ ok: true, output: '', port: 21322, attached: true });
        mocks.stop.mockResolvedValue({ ok: true, output: '' }); mocks.info.mockResolvedValue({ simulation: false });
    });
    afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
    const text = () => JSON.stringify(view.toJSON());
    const button = (label: string) => view.root.findAllByType('button').find(node => node.children.filter(x => typeof x === 'string').join('').includes(label))!;
    const open = async () => { await act(async () => { view = create(createElement(ServerManager, { open: true, onToggle: vi.fn() })); }); await act(async () => button('完整設定').props.onClick()); };
    const changeKey = async (value: string) => { await act(async () => view.root.findByType(ServerSettingsDialog).findAllByType('input')[0]!.props.onChange({ target: { value } })); };
    it('keeps edits and .env imports in draft; cancelling leaves saved credentials and server alone', async () => {
        await open(); await changeKey('changed-key');
        mocks.env.mockResolvedValue({ secretKey: 'imported-secret' });
        await act(async () => button('從 .env').props.onClick());
        expect(text()).toContain('尚未儲存');
        expect(mocks.save).not.toHaveBeenCalled();
        await act(async () => button('取消變更').props.onClick());
        expect(view.root.findAllByType(ServerSettingsDialog)).toHaveLength(0);
        await act(async () => button('完整設定').props.onClick());
        expect(view.root.findByType(ServerSettingsDialog).findAllByType('input')[0]!.props.value).toBe('test-key');
        expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
    });
    it('saves once without restarting and preserves other panels’ latest Harness/TLS settings', async () => {
        await open(); await changeKey('changed-key');
        mocks.load.mockResolvedValue({ ...initial, agentHarnessEnabled: false, httpsEnabled: true });
        await act(async () => button('僅儲存').props.onClick());
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...initial, apiKey: 'changed-key', agentHarnessEnabled: false, httpsEnabled: true });
        expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
        expect(text()).toContain('下次啟動或重啟伺服器時套用');
    });
    it('does not save or stop a running server when apply validation fails', async () => {
        await open(); await changeKey('');
        await act(async () => button('儲存並重啟').props.onClick());
        expect(text()).toContain('缺少 API 金鑰');
        expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    });
    it('keeps the draft and reports a storage failure without restarting', async () => {
        await open(); await changeKey('changed-key'); mocks.save.mockRejectedValue(new Error('磁碟無法寫入'));
        await act(async () => button('儲存並重啟').props.onClick());
        expect(text()).toContain('磁碟無法寫入');
        expect(view.root.findByType(ServerSettingsDialog).findAllByType('input')[0]!.props.value).toBe('changed-key');
        expect(mocks.stop).not.toHaveBeenCalled();
    });
    it('does not start after stop fails, and makes partial apply failure visible', async () => {
        await open(); mocks.stop.mockResolvedValue({ ok: false, output: 'owned server busy' });
        await act(async () => button('儲存並重啟').props.onClick());
        expect(mocks.save).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
        expect(text()).toContain('設定已儲存，但伺服器未能套用');
    });
    it('locks draft saves and duplicate logout while the server stop is pending', async () => {
        await open();
        let finishStop!: (result: { ok: boolean; output: string }) => void;
        mocks.stop.mockImplementation(() => new Promise(resolve => { finishStop = resolve; }));
        await act(async () => button('登出並清除金鑰').props.onClick());
        await act(async () => button('確認登出並清除金鑰').props.onClick());
        expect(view.root.findByType(ServerSettingsDialog).props.busy).toBe(true);
        expect(button('儲存並重啟').props.disabled).toBe(true);
        await expect(view.root.findByType(ServerSettingsDialog).props.onSave(initial, false)).rejects.toThrow('正在登出');
        await act(async () => button('登出並清除金鑰').props.onClick());
        expect(mocks.stop).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
        await act(async () => finishStop({ ok: false, output: 'stop failed' }));
        expect(mocks.save).not.toHaveBeenCalled();
        expect(view.root.findByType(ServerSettingsDialog).props.busy).toBe(false);
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '登出未完成' }));
    });
    it('does not call an unknown server environment production during diagnostics', async () => {
        await open(); mocks.info.mockRejectedValue(new Error('offline'));
        await act(async () => button('檢查目前帳戶').props.onClick());
        expect(text()).toContain('環境：未知'); expect(text()).not.toContain('環境：⚠ 正式');
    });
});
