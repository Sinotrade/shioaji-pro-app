import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openOrThrow: vi.fn(), open: vi.fn() }));
vi.mock('./runtime', () => ({ isTauri: true }));
vi.mock('./tauri', () => ({ openExternalUrl: mocks.open, openExternalUrlOrThrow: mocks.openOrThrow }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import { openApplyWindow } from './apply-guide-native';

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
