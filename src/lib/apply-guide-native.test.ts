import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openOrThrow: vi.fn(), open: vi.fn() }));
vi.mock('./runtime', () => ({ isTauri: true }));
vi.mock('./tauri', () => ({ openExternalUrl: mocks.open, openExternalUrlOrThrow: mocks.openOrThrow }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { clearApplySiteData, openApplyWindow, setApplyGuideCard, setApplySaveEnv, showApplySignPage } from './apply-guide-native';
import { guideCardOf } from './apply-guide-config';

beforeEach(() => { vi.clearAllMocks(); });

describe('openApplyWindow', () => {
    it('uses the native window and reports where the shell placed it', async () => {
        mocks.invoke.mockResolvedValue('beside');
        await expect(openApplyWindow()).resolves.toBe('beside');
        mocks.invoke.mockResolvedValue('overlay');
        await expect(openApplyWindow()).resolves.toBe('overlay');
        // 舊版原生端不回傳位置：當作 overlay，導覽照舊靠左
        mocks.invoke.mockResolvedValue(null);
        await expect(openApplyWindow()).resolves.toBe('overlay');
        mocks.invoke.mockResolvedValue('elsewhere');
        await expect(openApplyWindow()).resolves.toBe('overlay');
        expect(mocks.openOrThrow).not.toHaveBeenCalled();
    });

    it('falls back to the system browser on an older shell', async () => {
        mocks.invoke.mockRejectedValue('Command apply_window_open not found');
        mocks.openOrThrow.mockResolvedValue(undefined);
        await expect(openApplyWindow()).resolves.toBe('browser');
        expect(mocks.openOrThrow).toHaveBeenCalledWith('https://www.sinotrade.com.tw/newweb/PythonAPIKey/');
    });

    it('reports a failed browser fallback instead of claiming the site opened', async () => {
        mocks.invoke.mockRejectedValue('Command apply_window_open not found');
        mocks.openOrThrow.mockRejectedValue(new Error('找不到預設瀏覽器'));
        await expect(openApplyWindow()).rejects.toThrow('找不到預設瀏覽器');
    });

    it('passes on why the native window failed', async () => {
        mocks.invoke.mockRejectedValue('無法建立申請視窗');
        await expect(openApplyWindow()).rejects.toThrow('無法建立申請視窗');
        expect(mocks.openOrThrow).not.toHaveBeenCalled();
    });
});

describe('clearApplySiteData', () => {
    it('asks the shell to close the apply window and wipe its site data', async () => {
        mocks.invoke.mockResolvedValue(null);
        await expect(clearApplySiteData()).resolves.toBe('cleared');
        expect(mocks.invoke).toHaveBeenCalledWith('apply_window_clear_site_data');
    });

    it('treats an older shell (nothing kept) as unsupported, not as an error', async () => {
        mocks.invoke.mockRejectedValue('Command apply_window_clear_site_data not found');
        await expect(clearApplySiteData()).resolves.toBe('unsupported');
    });

    it('does not report a logout when the shell refuses the command', async () => {
        mocks.invoke.mockRejectedValue('Command apply_window_clear_site_data not allowed by ACL');
        await expect(clearApplySiteData()).rejects.toThrow('not allowed');
    });

    it('passes on why the wipe failed', async () => {
        mocks.invoke.mockRejectedValue('清除官網資料逾時，請再試一次');
        await expect(clearApplySiteData()).rejects.toThrow('清除官網資料逾時，請再試一次');
    });
});

describe('setApplySaveEnv', () => {
    it('passes the opt-in to the shell and ignores an older shell', async () => {
        mocks.invoke.mockResolvedValue(null);
        await setApplySaveEnv(true);
        expect(mocks.invoke).toHaveBeenCalledWith('apply_window_set_save_env', { save: true });
        mocks.invoke.mockRejectedValue('Command apply_window_set_save_env not found');
        await expect(setApplySaveEnv(false)).resolves.toBeUndefined();
    });
});

describe('setApplyGuideCard', () => {
    it('sends the card (or null to remove it) and ignores an older shell', async () => {
        mocks.invoke.mockResolvedValue(null);
        const card = guideCardOf('list', { canPrev: true, canNext: true, theme: 'dark', large: false });
        await setApplyGuideCard(card);
        expect(mocks.invoke).toHaveBeenCalledWith('apply_window_set_card', { card });
        await setApplyGuideCard(null);
        expect(mocks.invoke).toHaveBeenLastCalledWith('apply_window_set_card', { card: null });
        mocks.invoke.mockRejectedValue('Command apply_window_set_card not found');
        await expect(setApplyGuideCard(null)).resolves.toBeUndefined();
    });
});

describe('showApplySignPage', () => {
    it('passes only the market code to the shell', async () => {
        mocks.invoke.mockResolvedValue(null);
        await showApplySignPage('H');
        expect(mocks.invoke).toHaveBeenCalledWith('apply_window_show_sign_page', { market: 'H' });
    });

    it('opens the signing page in the browser on an older shell', async () => {
        mocks.invoke.mockRejectedValue('Command apply_window_show_sign_page not found');
        mocks.openOrThrow.mockResolvedValue(undefined);
        await showApplySignPage('F');
        expect(mocks.openOrThrow).toHaveBeenCalledWith('https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/');
    });

    it('passes on why the signing page could not open', async () => {
        mocks.invoke.mockRejectedValue('apply window is gone');
        await expect(showApplySignPage('S')).rejects.toThrow('無法打開簽署頁：apply window is gone');
    });
});
