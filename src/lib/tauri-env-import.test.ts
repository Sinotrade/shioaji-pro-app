import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(), readDir: vi.fn(), readTextFile: vi.fn(), invoke: vi.fn() }));
vi.mock('./runtime', async importOriginal => ({
    ...(await importOriginal<typeof import('./runtime')>()), isTauri: true,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mocks.readDir, readTextFile: mocks.readTextFile }));

import { envCandidates, importEnvCandidate, pickEnvFile } from './tauri';

const files = (...names: string[]) => names.map(name => ({ name, isFile: true }));
const fixture = { profiles: [{ id: 'imported-profile' }], configured: true, agentHarnessEnabled: true };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(fixture);
});

describe('.env import', () => {
    it('filters and sorts the supported names, with exact .env first', () => {
        expect(envCandidates(['z.env', '.env.local', '.env', 'a.env', '.envfoo', 'other.txt', 'x.env.bak']))
            .toEqual(['.env', '.env.local', 'a.env', 'z.env']);
    });

    it('opens a file picker and reports the imported Windows file name', async () => {
        mocks.open.mockResolvedValue('C:\\Keys\\s_multi.env');
        expect(await pickEnvFile('file')).toEqual({
            kind: 'imported', fileName: 's_multi.env', settings: fixture, profileId: 'imported-profile',
        });
        expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: false, multiple: false }));
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: 'C:\\Keys\\s_multi.env' }));
    });

    it('finds a single hidden .env through the directory picker on Windows', async () => {
        mocks.open.mockResolvedValue('C:\\Keys\\');
        mocks.readDir.mockResolvedValue([...files('.env'), { name: 'nested.env', isFile: false }]);
        expect(await pickEnvFile('directory')).toEqual({
            kind: 'imported', fileName: '.env', settings: fixture, profileId: 'imported-profile',
        });
        expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: 'C:\\Keys\\.env' }));
    });

    it('joins a Windows drive root without dropping its separator', async () => {
        mocks.open.mockResolvedValue('C:\\');
        mocks.readDir.mockResolvedValue(files('s_multi.env'));
        await pickEnvFile('directory');
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: 'C:\\s_multi.env' }));
    });

    it('keeps a backslash inside a POSIX directory name', async () => {
        mocks.open.mockResolvedValue('/tmp/keys\\backup');
        mocks.readDir.mockResolvedValue(files('s_multi.env'));
        await pickEnvFile('directory');
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: '/tmp/keys\\backup/s_multi.env' }));
    });

    it('treats a trailing POSIX backslash as part of the directory name', async () => {
        mocks.open.mockResolvedValue('/tmp/keys\\');
        mocks.readDir.mockResolvedValue(files('s_multi.env'));
        await pickEnvFile('directory');
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: '/tmp/keys\\/s_multi.env' }));

        mocks.invoke.mockClear();
        mocks.readDir.mockResolvedValue(files('.env', 's_multi.env'));
        const result = await pickEnvFile('directory');
        if (result?.kind !== 'choose') throw new Error('expected selection');
        await importEnvCandidate(result.selection, 's_multi.env');
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: '/tmp/keys\\/s_multi.env' }));
    });

    it('reports the full POSIX file name when it contains a backslash', async () => {
        mocks.open.mockResolvedValue('/tmp/a\\b.env');
        expect(await pickEnvFile('file')).toMatchObject({ kind: 'imported', fileName: 'a\\b.env' });
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: '/tmp/a\\b.env' }));
    });

    it('lists multiple candidates without reading until the user selects one', async () => {
        mocks.open.mockResolvedValue('C:\\Keys');
        mocks.readDir.mockResolvedValue(files('b.env', '.env', 'a.env'));
        const result = await pickEnvFile('directory');
        expect(result).toEqual({ kind: 'choose', selection: {
            directory: 'C:\\Keys', candidates: ['.env', 'a.env', 'b.env'],
        } });
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.readTextFile).not.toHaveBeenCalled();
        if (result?.kind !== 'choose') throw new Error('expected selection');
        expect(await importEnvCandidate(result.selection, 'b.env')).toMatchObject({ kind: 'imported', fileName: 'b.env' });
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('credentials_import_env', expect.objectContaining({ path: 'C:\\Keys\\b.env' }));
    });

    it('identifies each checked file when no supported file or key is found', async () => {
        mocks.open.mockResolvedValue('/tmp/project');
        mocks.readDir.mockResolvedValue(files('readme.txt', 'notes.conf'));
        expect(await pickEnvFile('directory')).toEqual({
            kind: 'error', error: '資料夾裡沒有 .env 檔案。已檢查檔案：notes.conf、readme.txt',
        });
        mocks.open.mockResolvedValue('/tmp/project/s_multi.env');
        mocks.invoke.mockRejectedValueOnce('API Key／Secret Key 格式錯誤，請使用完整的 base58 金鑰');
        expect(await pickEnvFile('file')).toEqual({
            kind: 'error', error: 'API Key／Secret Key 格式錯誤，請使用完整的 base58 金鑰',
        });
        mocks.open.mockResolvedValue('/tmp/project/readme.txt');
        expect(await pickEnvFile('file')).toEqual({
            kind: 'error', error: 'readme.txt 不是 .env 檔案。已檢查檔案：readme.txt',
        });
    });

    it('reports the selected name on read failure without revealing file content', async () => {
        mocks.open.mockResolvedValue('/tmp/project/s_multi.env');
        mocks.invoke.mockRejectedValueOnce(new Error('fixture-secret'));
        expect(await pickEnvFile('file')).toEqual({
            kind: 'error', error: '無法匯入 .env；請確認金鑰格式與系統憑證庫。',
        });
    });
    it.each([
        '無法存取系統憑證庫，請解鎖憑證庫後重試；原有資料已保留',
        '憑證資料超過 Windows 憑證庫的 2560 UTF-16 bytes 上限，請縮短憑證密碼',
    ])('preserves the fixed native error for candidate imports: %s', async error => {
        mocks.invoke.mockRejectedValueOnce(error);
        expect(await importEnvCandidate({ directory: '/fixture', candidates: ['test.env'] }, 'test.env'))
            .toEqual({ kind: 'error', error });
    });
});
