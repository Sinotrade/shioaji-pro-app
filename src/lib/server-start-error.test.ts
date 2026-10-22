import { describe, expect, it } from 'vitest';
import { classifyServerStart, lastLogLines, redactLogLine, serverStartErrorCopy, SIDECAR_ERROR_MARKER, type ServerStartError } from './server-start-error';

const nativeMissing = (reason: string, binary = 'shioaji', path = '/Users/dev/app/target/debug/shioaji') =>
    `啟動失敗：內建 ${binary} 無法執行：${path}（檔案不存在）\n${SIDECAR_ERROR_MARKER}${JSON.stringify({ kind: 'sidecar_missing', binary, path, reason })}`;

describe('classifyServerStart', () => {
    it('reads the native marker for a sidecar that was never copied', () => {
        const error = classifyServerStart({ output: nativeMissing('not_found'), stage: 'spawn', port: 21322 });
        expect(error).toEqual({ kind: 'sidecar_missing', binary: 'shioaji', path: '/Users/dev/app/target/debug/shioaji', reason: 'not_found' });
    });
    it('keeps a 0-byte binary distinct from a missing one', () => {
        const error = classifyServerStart({ output: nativeMissing('empty', 'mkcert', '/A/mkcert'), stage: 'spawn', port: 1 });
        expect(error).toMatchObject({ kind: 'sidecar_missing', binary: 'mkcert', reason: 'empty' });
        expect(serverStartErrorCopy(error).body).toContain('0 bytes');
        expect(serverStartErrorCopy(error).title).toBe('找不到內建的憑證工具');
    });
    it('ignores a garbled marker and falls back to the log', () => {
        const error = classifyServerStart({ output: `${SIDECAR_ERROR_MARKER}{not json\nboom`, stage: 'died', port: 1 });
        expect(error.kind).toBe('sidecar_exited');
    });
    it.each([
        ['Error: Failed to start server: Address already in use (os error 48)', 'died'],
        ['Failed to start HTTP server: os error 10048', 'died'],
        ['隔離測試連接埠已被占用；不切換至其他伺服器', 'precheck'],
        [':21322 已有一個 shioaji server（版本不符），且無法自動停止。', 'precheck'],
    ] as const)('port in use: %s', (output, stage) => {
        expect(classifyServerStart({ output, stage, port: 21322 })).toMatchObject({ kind: 'port_in_use', port: 21322 });
    });
    it('a process that exits early carries its last log lines', () => {
        const log = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\npanicked at src/main.rs:1';
        const error = classifyServerStart({ output: log, stage: 'died', port: 1 });
        expect(error).toEqual({ kind: 'sidecar_exited', lastLines: ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'panicked at src/main.rs:1'] });
    });
    it('login rejection is an auth failure with the specific hint', () => {
        const error = classifyServerStart({ output: 'ERROR Failed to initialize server state: Authentication failed: auth rejected: api key not exist', stage: 'died', port: 1 });
        expect(error.kind).toBe('auth_failed');
        expect(serverStartErrorCopy(error).body).toContain('API Key 不存在');
    });
    it('a Solace timeout wrapped as an auth failure is a network problem', () => {
        const error = classifyServerStart({ output: 'Authentication failed: Shioaji connect error: connection timed out', stage: 'died', port: 1 });
        expect(error).toMatchObject({ kind: 'network', timeout: true });
    });
    it('sign-data timeout stays a login problem (#326)', () => {
        expect(classifyServerStart({ output: 'Authentication failed: Sign data is timeout', stage: 'died', port: 1 }).kind).toBe('auth_failed');
    });
    it('no answer within the wait is a timeout', () => {
        const error = classifyServerStart({ output: 'INFO logging in\n啟動逾時（45 秒未就緒）', stage: 'timeout', port: 1 });
        expect(error).toMatchObject({ kind: 'network', timeout: true });
        expect(serverStartErrorCopy(error).title).toBe('連線逾時');
    });
    it('CA and TLS problems are certificate errors', () => {
        expect(classifyServerStart({ output: 'Error: Ca Password Incorrect', stage: 'died', port: 1 }).kind).toBe('ca_cert');
        expect(classifyServerStart({ output: 'Failed to start HTTP server: invalid TLS certificate: no keys found', stage: 'died', port: 1 }).kind).toBe('ca_cert');
        // a missing .pfx is not blamed on the API key
        const pfx = classifyServerStart({ output: 'CA error: /x/Sinopac.pfx not exist', stage: 'died', port: 1 });
        expect(pfx.kind).toBe('ca_cert');
        expect(serverStartErrorCopy(pfx).body).not.toContain('API Key');
        // a missing TLS file is not a login failure either
        expect(classifyServerStart({ output: 'Failed to start HTTP server: TLS certificate file does not exist', stage: 'died', port: 1 }).kind).toBe('ca_cert');
    });
    it('a binary the OS refuses to run keeps its path', () => {
        const error = classifyServerStart({ output: nativeMissing('cannot_execute'), stage: 'spawn', port: 1 });
        expect(error).toMatchObject({ kind: 'sidecar_missing', reason: 'cannot_execute' });
        expect(serverStartErrorCopy(error).body).toContain('損毀');
    });
    it('a CA activation warning alone does not explain a failed start', () => {
        const output = 'WARN Failed to activate CA certificate: Ca has expired!\nthread main panicked';
        expect(classifyServerStart({ output, stage: 'died', port: 1 }).kind).toBe('sidecar_exited');
    });
    it('account setup refusals are named as such', () => {
        expect(classifyServerStart({ output: '請先完成帳號設定並選擇使用中的帳號', stage: 'precheck', port: 1 })).toEqual({ kind: 'account_setup', message: '請先完成帳號設定並選擇使用中的帳號' });
        expect(classifyServerStart({ output: '啟動失敗：無法存取系統憑證庫，請確認憑證服務可用且已解鎖後重試', stage: 'spawn', port: 1 }).kind).toBe('account_setup');
    });
    it('anything else keeps its own message', () => {
        const error = classifyServerStart({ output: '啟動失敗：仍有 native Agent runtime 執行中', stage: 'spawn', port: 1 });
        expect(error).toMatchObject({ kind: 'unknown', message: '啟動失敗：仍有 native Agent runtime 執行中' });
    });
});

describe('credential safety', () => {
    it('masks credential-shaped values in log lines', () => {
        expect(redactLogLine('SJ_API_KEY=abcd1234 secret_key: "zzz" CA_PASSWD=hunter2')).toBe('SJ_API_KEY=*** secret_key: *** CA_PASSWD=***');
        expect(redactLogLine('Authorization: Bearer eyJhbGciOi.x.y')).toBe('Authorization: Bearer ***');
        expect(redactLogLine('person A123456789 rejected')).toBe('person ********** rejected');
    });
    it('never shows a credential from the log in any message', () => {
        const output = 'api_key=SECRETVALUE\npassword=PW123\nAuthentication failed: auth rejected';
        const error = classifyServerStart({ output, stage: 'died', port: 1 });
        const copy = serverStartErrorCopy(error);
        const text = JSON.stringify(copy);
        expect(text).not.toContain('SECRETVALUE');
        expect(text).not.toContain('PW123');
    });
    it('drops the marker line from the log tail', () => {
        expect(lastLogLines(`a\n${SIDECAR_ERROR_MARKER}{}`)).toEqual(['a']);
    });
});

describe('serverStartErrorCopy', () => {
    const all: ServerStartError[] = [
        { kind: 'sidecar_missing', binary: 'shioaji', path: '/p/shioaji', reason: 'not_executable' },
        { kind: 'port_in_use', port: 21322, lastLines: [] },
        { kind: 'sidecar_exited', lastLines: ['x'] },
        { kind: 'auth_failed', hint: null, lastLines: [] },
        { kind: 'account_setup', message: '' },
        { kind: 'ca_cert', hint: null, lastLines: [] },
        { kind: 'network', timeout: false, hint: null, lastLines: [] },
        { kind: 'unknown', message: '', lastLines: [] },
    ];
    it('gives every kind its own title and a body', () => {
        const titles = all.map((e) => serverStartErrorCopy(e).title);
        expect(new Set(titles).size).toBe(all.length);
        for (const e of all) expect(serverStartErrorCopy(e).body.length).toBeGreaterThan(8);
    });
    it('shows the searched path for a missing sidecar', () => {
        expect(serverStartErrorCopy(all[0]!)).toMatchObject({ detail: ['/p/shioaji'], detailLabel: '已搜尋的路徑' });
        expect(serverStartErrorCopy(all[0]!).body).toContain('沒有執行權限');
    });
    it('names the port', () => {
        expect(serverStartErrorCopy(all[1]!).body).toContain('port 21322');
    });
});
