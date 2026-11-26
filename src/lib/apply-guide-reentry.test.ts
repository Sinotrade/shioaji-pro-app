import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openOrThrow: vi.fn(), open: vi.fn() }));
vi.mock('./runtime', () => ({ isTauri: true }));
vi.mock('./tauri', () => ({ openExternalUrl: mocks.open, openExternalUrlOrThrow: mocks.openOrThrow }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
import {
    GUIDE_COPY, TASK_ORDER, guideCardOf, guideCopyOf, guideProgressText, nextGuideStep, previousGuideStep, progressStepsOf,
} from './apply-guide-config';
import { parseApplyGuideEvent, setApplyCaTarget, setApplyImportEnvironment, setApplySaveCa } from './apply-guide-native';
import { onApplyGuideRequest, requestApplyGuide } from './apply-guide-reentry';

beforeEach(() => { vi.clearAllMocks(); });

describe('in-app guide tasks', () => {
    it('keep the first-run order and give each task its own steps', () => {
        expect(TASK_ORDER.apply).toEqual(['start', 'login', 'sign', 'list', 'verify', 'form', 'success', 'imported']);
        expect(TASK_ORDER.production.at(-1)).toBe('ca');
        expect(TASK_ORDER.ca).toEqual(['start', 'login', 'ca']);
        expect(TASK_ORDER.sign).toEqual(['start', 'login', 'sign']);
        expect(nextGuideStep('imported')).toBe('imported');
        expect(nextGuideStep('imported', 'production')).toBe('ca');
        expect(nextGuideStep('login', 'ca')).toBe('ca');
        expect(previousGuideStep('ca', 'ca')).toBe('login');
        expect(nextGuideStep('sign', 'sign')).toBe('sign');
        // 首次設定的「完成」不算一步；App 裡的任務每一步都算
        expect(progressStepsOf('apply').total).toBe(6);
        expect(progressStepsOf('ca')).toEqual({ steps: ['login', 'ca'], total: 2 });
        expect(guideProgressText('ca', 'ca')).toBe('第 2 步，共 2 步：CA 憑證');
        expect(guideProgressText('imported')).toBe('全部完成');
    });

    it('recommends 正式環境 on the form only for the production key', () => {
        const simulation = GUIDE_COPY.form.points.find(p => p.target === 'perm-prod')!;
        expect(simulation.tone).toBe('caution');
        expect(simulation.body).toContain('只能登入模擬環境');
        const production = guideCopyOf('production', 'form').points.find(p => p.target === 'perm-prod')!;
        expect(production.tone).toBe('recommend');
        expect(production.body).toContain('請勾選');
        expect(production.body).toContain('真實資金');
        expect(guideCopyOf('production', 'form').points.find(p => p.target === 'key-name')!.body).toContain('ShioajiProProd');
        expect(guideCopyOf('production', 'success').lead).toContain('正式帳號');
        expect(guideCopyOf('production', 'imported').title).toBe('正式金鑰已載入');
        // 其他任務照首次設定
        expect(guideCopyOf('ca', 'form')).toBe(GUIDE_COPY.form);
        expect(guideCopyOf('sign', 'sign')).toBe(GUIDE_COPY.sign);
    });

    it('puts the production copy on the page card, and 下載憑證 on the CA step', () => {
        const opts = { canPrev: true, canNext: true, theme: 'dark' as const, large: false };
        const form = guideCardOf('form', opts, 'production');
        expect(form.points.find(p => p.targets.includes('perm-prod'))!.tone).toBe('recommend');
        const ca = guideCardOf('ca', opts, 'ca');
        expect(ca.points.map(p => p.targets)).toEqual([['download-ca']]);
        expect(ca.progress).toContain('CA 憑證');
        // 正式金鑰的完成頁不另外列首次設定的「之後要正式交易」
        expect(guideCardOf('imported', opts, 'production').points).toHaveLength(0);
        expect(guideCardOf('imported', opts).points.some(p => p.targets.includes('download-ca'))).toBe(true);
    });
});

describe('in-app guide native bridge', () => {
    it('parses the certificate events without any file content', () => {
        expect(parseApplyGuideEvent('apply-guide:ca-attached', { profileId: 'p2', name: '正式', fileName: 'Sinopac.pfx', hasCaPassword: false }))
            .toEqual({ kind: 'ca-attached', profileId: 'p2', name: '正式', fileName: 'Sinopac.pfx', hasCaPassword: false });
        expect(parseApplyGuideEvent('apply-guide:ca-attached', { profileId: 'p2', name: '正式', fileName: 'Sinopac.pfx' })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:ca-failed', { message: '格式不符' })).toEqual({ kind: 'ca-failed', message: '格式不符' });
        expect(parseApplyGuideEvent('apply-guide:ca-failed', {})).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:imported', { profileId: 'p2', name: 'K', environment: 'production' }))
            .toEqual({ kind: 'imported', profileId: 'p2', name: 'K', duplicate: false, environment: 'production' });
        expect(parseApplyGuideEvent('apply-guide:imported', { profileId: 'p2', name: 'K', environment: 'live' })).toBeNull();
    });

    it('requires the production environment to reach the shell, never silently importing as simulation', async () => {
        mocks.invoke.mockResolvedValue(null);
        await setApplyImportEnvironment('production');
        expect(mocks.invoke).toHaveBeenCalledWith('apply_window_set_import_environment', { environment: 'production' });
        mocks.invoke.mockRejectedValue('Command apply_window_set_import_environment not found');
        await expect(setApplyImportEnvironment('production')).rejects.toThrow('請更新 App');
        // 模擬是原生端的預設：舊版沒有指令也沒關係
        await expect(setApplyImportEnvironment('simulation')).resolves.toBeUndefined();
    });

    it('names the CA target profile and passes on why it was refused', async () => {
        mocks.invoke.mockResolvedValue('正式帳號');
        await expect(setApplyCaTarget('p2')).resolves.toBe('正式帳號');
        expect(mocks.invoke).toHaveBeenCalledWith('apply_window_set_ca_target', { profileId: 'p2' });
        mocks.invoke.mockRejectedValue('CA 憑證只能存到正式環境的帳號');
        await expect(setApplyCaTarget('p1')).rejects.toThrow('CA 憑證只能存到正式環境的帳號');
        mocks.invoke.mockResolvedValue(null);
        await expect(setApplyCaTarget(null)).resolves.toBeNull();
        expect(mocks.invoke).toHaveBeenLastCalledWith('apply_window_set_ca_target', { profileId: null });
        await setApplySaveCa(true);
        expect(mocks.invoke).toHaveBeenLastCalledWith('apply_window_set_save_ca', { save: true });
    });
});

describe('requestApplyGuide', () => {
    it('reaches the panel host only while one is mounted', () => {
        expect(requestApplyGuide('production')).toBe(false);
        const seen: unknown[] = [];
        const off = onApplyGuideRequest(task => seen.push(task));
        expect(requestApplyGuide('production')).toBe(true);
        expect(requestApplyGuide()).toBe(true);
        off();
        expect(requestApplyGuide('ca')).toBe(false);
        expect(seen).toEqual(['production', null]);
    });
});
