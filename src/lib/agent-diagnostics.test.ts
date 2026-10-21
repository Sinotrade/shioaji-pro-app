import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRuntimeDiagnostics, recordAgentRuntimeFailure, redactAgentRuntimeDetail } from './agent-diagnostics';

afterEach(() => vi.unstubAllGlobals());

describe('Agent runtime copied diagnostics', () => {
    // All inputs from review5's unc.test.ts / unc2.test.ts probes, with
    // assertions replacing console output. Ambiguous unquoted spaces retain
    // the existing best-effort behavior; quoted paths are covered below.
    it.each([
        [String.raw`failed\\n/opt/homebrew/lib/node_modules/x/cli.js:12 real cause here`, 'failed[REDACTED_PATH] real cause here'],
        [String.raw`failed\\nnode_modules/x/cli.js real cause`, 'failed[REDACTED_PATH] real cause'],
        [String.raw`\\server\share`, '[REDACTED_PATH]'],
        [String.raw`\\server\c$\Users\Fixture\x`, '[REDACTED_PATH]'],
        [String.raw`\\192.168.1.5\share\Fixture User\proj more text`, '[REDACTED_PATH] more text'],
        [String.raw`open \\server\share\Fixture User\proj failed: EACCES`, 'open [REDACTED_PATH] failed: EACCES'],
        [String.raw`{"path":"\\\\server\\share\\Fixture User\\p"}`, '{"path":"[REDACTED_PATH]"}'],
        [String.raw`C:\\project\\config.json not found`, '[REDACTED_PATH] not found'],
        ['http://fixture-user@proxy.test:80 and https://github.com/org/repo@v1', 'http://[REDACTED]@proxy.test:80 and https://github.com/org/repo@v1'],
        ['git+ssh://git@github.com/org/repo.git', 'git+ssh://[REDACTED]@github.com/org/repo.git'],
        ['https://host:8080/path?x=a@b.com', 'https://host:8080/path?[REDACTED]'],
        [String.raw`\\.\pipe\codex-Fixture`, '[REDACTED_PATH]'],
        [String.raw`//server/share/Fixture User/p`, '//server/share/Fixture User/p'],
        [String.raw`open \\server\share failed: EACCES`, 'open [REDACTED_PATH] failed: EACCES'],
        [String.raw`open \\?\uNc\server\share\x\y failed: EACCES`, 'open [REDACTED_PATH] failed: EACCES'],
        [String.raw`open \\?\UNC\server\share failed: ENOENT`, 'open [REDACTED_PATH] failed: ENOENT'],
        [String.raw`open \\.\UNC\server\share\Fixture\p failed: EACCES`, 'open [REDACTED_PATH] failed: EACCES'],
        [String.raw`open \\server\My Share\Fixture\p failed: EACCES`, String.raw`open [REDACTED_PATH] Share\Fixture\p failed: EACCES`],
        [String.raw`open \\server\share\Fixture User\p failed: EACCES`, 'open [REDACTED_PATH] failed: EACCES'],
        [String.raw`open \\server\share\Fixture\p\tfailed`, 'open [REDACTED_PATH]'],
        [String.raw`open "\\server\share\Fixture\p" failed`, 'open [REDACTED_PATH] failed'],
        [String.raw`open \\server\share\Fixture\p: EACCES`, 'open [REDACTED_PATH] EACCES'],
        [String.raw`{"message":"open \\\\?\\unc\\server\\share\\Fixture\\p failed: EACCES"}`, '{"message":"open [REDACTED_PATH] failed: EACCES"}'],
        [String.raw`{"message":"open \\\\server\\share failed: EACCES"}`, '{"message":"open [REDACTED_PATH] failed: EACCES"}'],
        [String.raw`{"message":"open \\\\server\\share\\Fixture User\\p failed"}`, '{"message":"open [REDACTED_PATH] failed"}'],
    ])('retains the review probe behavior for %s', (input, expected) => {
        expect(redactAgentRuntimeDetail(input)).toBe(expected);
        expect(JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: input }))).message).toBe(expected);
    });

    it('masks complete paths without consuming the following cause in text and JSON', () => {
        for (const [path, cause] of [
            [String.raw`"\\server\share\Client Secret\account.json"`, 'failed: EACCES'],
            [String.raw`'\\server\Client Share\Client Secret\account.json'`, 'failed: EACCES'],
            [String.raw`"\\?\unc\server\share\Client Secret\account.json"`, 'failed: EACCES'],
            [String.raw`"C:\Client Secret\account.json"`, 'failed: EACCES'],
            [String.raw`\\server\share\Fixture User\p`, 'failed'],
            [String.raw`\\server\share`, 'access denied'],
            [String.raw`\\?\UnC\server\share`, 'access denied'],
            [String.raw`C:\\project\\config.json`, 'not found'],
            [String.raw`\\server\share\O'Brien\account.json`, 'failed: EACCES'],
            [String.raw`\\O'Brien\share\account.json`, 'failed: EACCES'],
            [String.raw`\\server\O'Brien\account.json`, 'failed: EACCES'],
            [String.raw`\\?\uNc\server\share\O'Brien\account.json`, 'failed: EACCES'],
            [String.raw`C:\O'Brien\account.json`, 'failed: EACCES'],
            [String.raw`C:/O'Brien/account.json`, 'failed: EACCES'],
            [String.raw`\\server\share\Fixture O'Brien\account.json`, 'failed: EACCES'],
            [String.raw`C:\Fixture O'Brien\account.json`, 'failed: EACCES'],
            [String.raw`"\\server\Client Share\O'Brien\account.json"`, 'failed: EACCES'],
            [String.raw`"C:\Client Secret\O'Brien\account.json"`, 'failed: EACCES'],
            [String.raw`'C:\Client Secret\account.json'`, 'failed: EACCES'],
        ]) {
            const detail = `open ${path} ${cause}`;
            const redacted = redactAgentRuntimeDetail(detail);
            expect(redacted).toBe(`open [REDACTED_PATH] ${cause}`);
            expect(JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: detail }))).message).toBe(redacted);
        }
    });

    it('masks case variants of UNC paths while retaining the following cause in text and JSON', () => {
        for (const path of [
            String.raw`\\server\share\FixtureUser\project`,
            ...['UNC', 'unc', 'UnC'].map(prefix => `\\\\?\\${prefix}\\server\\share\\FixtureUser\\project`),
        ]) {
            const detail = `open ${path} failed: EACCES`;
            const redacted = redactAgentRuntimeDetail(detail);
            expect(redacted).not.toContain('server');
            expect(redacted).not.toContain('FixtureUser');
            expect(redacted).toContain('failed: EACCES');
            const json = JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: detail })));
            expect(json.message).toBe(redacted);
        }
    });

    it('masks proxy accounts with or without passwords', () => {
        for (const proxy of ['http://fixture-user@proxy.test:80', 'socks5://fixture-user@proxy.test:1080', 'http://fixture-user:@proxy.test:80']) {
            expect(redactAgentRuntimeDetail(proxy)).not.toContain('fixture-user');
        }
    });

    it('preserves causes after escaped newlines while masking actual UNC paths', () => {
        for (const detail of [String.raw`failed\\nimportant cause /project/config.json`, String.raw`failed\\nimportant cause \"quoted\"`]) {
            expect(redactAgentRuntimeDetail(detail)).toBe(detail);
            expect(JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: detail }))).message).toBe(detail);
        }
        expect(redactAgentRuntimeDetail(String.raw`failed\\nimportant cause C:\project\config.json`)).toBe(String.raw`failed\\nimportant cause [REDACTED_PATH]`);
        for (const path of [String.raw`\\server\share\Fixture User\project`, String.raw`"\\server\shared folder\Fixture User\project"`, String.raw`\\?\UNC\server\share\Fixture User\project`]) {
            expect(redactAgentRuntimeDetail(path)).not.toContain('Fixture User');
        }
    });
    it('redacts structured credentials, account data and private paths without hiding token limits', () => {
        const detail = [
            JSON.stringify({ nested: [{ Cookie: 'session=fixture-login-cookie', SJ_PERSON_ID: 'fixture-person', email: 'fixture@example.com', custom_key: 'fixture-private-key', max_tokens: 4096 }] }),
            'proxy=http://fixture-user:fixture-pass@proxy.test:80',
            'C:\\Users\\Fixture User\\project',
            JSON.stringify({ message: 'C:\\Users\\Fixture User\\project' }),
            '\\\\host\\Users\\Fixture User\\project',
            '\\\\host\\share\\Fixture User\\project',
            'email=fixture@example.com SJ_PERSON_ID=fixture-person',
        ].join('\n');
        const result = redactAgentRuntimeDetail(detail);
        for (const secret of ['fixture-login-cookie', 'fixture-person', 'fixture@example.com', 'fixture-user', 'fixture-pass', 'Fixture User', 'fixture-private-key']) expect(result).not.toContain(secret);
        expect(result).toContain('"max_tokens":4096');
    });
    it('retains the cause across reloads and redacts credentials before storage', async () => {
        const stored = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
        });
        const cause = 'exit code: 3\nInvalid settings\nAuthorization: Bearer private-token\nAPI_KEY="secret with spaces"\ntoken=hidden\nsk-ant-private12345';
        recordAgentRuntimeFailure('Claude 連線失敗', cause);
        vi.resetModules();
        const reloaded = await import('./agent-diagnostics');
        const copied = reloaded.agentRuntimeDiagnostics();
        expect(copied).toContain('exit code: 3\nInvalid settings');
        for (const secret of ['private-token', 'secret with spaces', 'hidden', 'sk-ant-private12345']) {
            expect(copied).not.toContain(secret);
            expect([...stored.values()].join('')).not.toContain(secret);
        }
    });

    it('works when storage is unavailable', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(recordAgentRuntimeFailure('failed', 'exit code: 3')).toContain('exit code: 3');
        expect(agentRuntimeDiagnostics()).toBe('');
    });
});
