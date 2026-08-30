import { describe, expect, it } from 'vitest';
import {
    harnessOwnershipCompatible,
    recoverHarnessOwnership,
} from './sidecar-ownership';

describe('Agent Harness sidecar ownership', () => {
    it('rejects an orphan daemon when a new App instance enables Harness', () => {
        expect(harnessOwnershipCompatible(true, false)).toBe(false);
    });

    it('accepts only the current native-owned sidecar for Harness', () => {
        expect(harnessOwnershipCompatible(true, true)).toBe(true);
        expect(harnessOwnershipCompatible(false, false)).toBe(true);
    });
});

describe('recoverHarnessOwnership', () => {
    const settings = { apiKey: 'k', secretKey: 's' };
    const started = { ok: true, output: '', portChanged: false };

    it('is a no-op when the sidecar is already owned', async () => {
        let restarts = 0;
        const res = await recoverHarnessOwnership({
            nativeOwned: async () => true,
            loadSettings: async () => settings,
            restart: async () => {
                restarts += 1;
                return started;
            },
        });
        expect(res).toBeNull();
        expect(restarts).toBe(0);
    });

    it('respawns an adopted orphan and returns the start result', async () => {
        const owned = [false, true]; // unowned → restart → owned
        let restarts = 0;
        const res = await recoverHarnessOwnership({
            nativeOwned: async () => owned.shift() ?? false,
            loadSettings: async () => settings,
            restart: async () => {
                restarts += 1;
                return { ...started, portChanged: true };
            },
        });
        expect(restarts).toBe(1);
        expect(res?.portChanged).toBe(true);
    });

    it('refuses to restart without credentials (fail-closed)', async () => {
        let restarts = 0;
        await expect(
            recoverHarnessOwnership({
                nativeOwned: async () => false,
                loadSettings: async () => ({ apiKey: '', secretKey: '' }),
                restart: async () => {
                    restarts += 1;
                    return started;
                },
            }),
        ).rejects.toThrow('API 金鑰');
        expect(restarts).toBe(0);
    });

    it('surfaces a failed restart instead of pretending ownership', async () => {
        await expect(
            recoverHarnessOwnership({
                nativeOwned: async () => false,
                loadSettings: async () => settings,
                restart: async () => ({
                    ok: false,
                    output: 'port 被外部 server 佔用',
                    portChanged: false,
                }),
            }),
        ).rejects.toThrow('port 被外部 server 佔用');
    });

    it('fails when the respawn still is not owned (never false-positive)', async () => {
        await expect(
            recoverHarnessOwnership({
                nativeOwned: async () => false,
                loadSettings: async () => settings,
                restart: async () => started,
            }),
        ).rejects.toThrow('所有權');
    });
});
