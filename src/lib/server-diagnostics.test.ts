// src/lib/server-diagnostics.test.ts

import { describe, expect, it } from 'vitest';
import { diagnoseOutput } from './server-diagnostics';

describe('diagnoseOutput', () => {
    it('network timeout wrapped as auth failure → network message, not keys', () => {
        // 實際案例：熱點斷線時 Solace 連線逾時，上游包成 Authentication
        // failed — 不能誤導使用者去檢查金鑰/簽署/連線上限
        const log = [
            "SDK NOTICE solClient.c:10959 Connect attempt for host '210.59.255.161:80' for session '(c0,s1)_sinopac' timed out",
            'ERROR shioaji::cli::server: Failed to initialize server state: Authentication failed: Shioaji connect error',
            'Error: Authentication failed: Shioaji connect error',
        ].join('\n');
        expect(diagnoseOutput(log)).toMatch(/網路/);
        expect(diagnoseOutput(log)).not.toMatch(/約定書/);
    });

    it('plain auth failure without network noise → keys/signing message', () => {
        const log =
            'ERROR shioaji::cli::server: Failed to initialize server state: Authentication failed: login validation error';
        expect(diagnoseOutput(log)).toMatch(/約定書/);
    });

    it('connection refused → network message', () => {
        expect(
            diagnoseOutput('Error: Connection refused (os error 61)'),
        ).toMatch(/網路/);
    });

    it('bad key format keeps its specific message', () => {
        expect(diagnoseOutput('invalid api_key: base58 decode')).toMatch(
            /金鑰格式/,
        );
    });

    it('unknown output → null', () => {
        expect(diagnoseOutput('some harmless INFO line')).toBeNull();
    });
});
