// 共用登出（伺服器管理的「登出」與應用程式鎖第 10 次輸錯）：順序與停不下來時的路徑
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ calls: [] as string[], stop: vi.fn(), logout: vi.fn(), remove: vi.fn() }));
vi.mock('./tauri', () => ({ serverStop: m.stop, logoutCredentialProfile: m.logout, deleteCredentialProfile: m.remove }));
vi.mock('./server-identity', () => ({ setServerIdentityVerified: (v: boolean) => void m.calls.push(`identity:${v}`) }));
vi.mock('./spawn-keys', () => ({ clearStoredSpawnKeyHash: () => void m.calls.push('clear-spawn-hash') }));
import { logoutAndReload } from './logout';

const reload = vi.fn(() => void m.calls.push('reload'));
beforeEach(() => {
    m.calls.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal('window', { location: { reload } });
    m.stop.mockImplementation(async (opts: unknown) => { m.calls.push(`stop:${JSON.stringify(opts)}`); return { ok: true, output: '' }; });
    // 登出後回傳剩下的帳號（使用中的已經清掉）
    m.logout.mockImplementation(async () => { m.calls.push('logout'); return { profiles: [{ id: 'a' }, { id: 'b' }] }; });
    m.remove.mockImplementation(async (id: string) => void m.calls.push(`delete:${id}`));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('先停本 App 的 Agent 與伺服器，再清金鑰、spawn hash，最後 beforeReload 與重新載入', async () => {
    await logoutAndReload(() => void m.calls.push('before-reload'));
    expect(m.calls).toEqual([
        'identity:false',
        'stop:{"stopAgents":true,"ownedOnly":true}',
        'logout', 'clear-spawn-hash', 'before-reload', 'reload',
    ]);
});

it('allProfiles（應用程式鎖第 10 次輸錯）：剩下的帳號也逐一刪掉，之後才 beforeReload', async () => {
    await logoutAndReload(() => void m.calls.push('before-reload'), true);
    expect(m.calls.slice(2)).toEqual(['logout', 'delete:a', 'delete:b', 'clear-spawn-hash', 'before-reload', 'reload']);
});

it('allProfiles 刪帳號失敗：不呼叫 beforeReload、不重新載入（應用程式鎖保持鎖住）', async () => {
    m.remove.mockRejectedValue(new Error('系統憑證庫已鎖定'));
    const beforeReload = vi.fn();
    await expect(logoutAndReload(beforeReload, true)).rejects.toThrow('系統憑證庫已鎖定');
    expect(beforeReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
});

it('伺服器停不下來：不清金鑰、不呼叫 beforeReload，排定重新載入並丟出原因', async () => {
    vi.useFakeTimers();
    m.stop.mockResolvedValue({ ok: false, output: 'Agent 尚未停止' });
    const beforeReload = vi.fn();
    await expect(logoutAndReload(beforeReload)).rejects.toThrow('Agent 尚未停止');
    expect(m.logout).not.toHaveBeenCalled();
    expect(beforeReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(reload).toHaveBeenCalledOnce();
});
