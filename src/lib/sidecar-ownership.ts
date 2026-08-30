// Agent Harness sidecar ownership rules. The harness signing boundary is
// process-local (SERVER_PID/SERVER_GENERATION live in the native host), so
// a healthy daemon ADOPTED from a previous app instance — the normal outcome
// after a crash/force-quit, where kill-on-exit never ran — can serve plain
// trading but can never carry harness capabilities: the new process holds a
// different signing secret and cannot prove the spawn. Recovery is always
// "respawn through the native path", never "adopt harder".

export function harnessOwnershipCompatible(
    agentHarnessEnabled: boolean,
    nativeOwned: boolean,
): boolean {
    return !agentHarnessEnabled || nativeOwned;
}

// Structural types so this module stays dependency-free (tauri.ts imports us).
export interface HarnessRecoveryStart {
    ok: boolean;
    output: string;
    portChanged: boolean;
}

export interface HarnessRecoveryDeps<R extends HarnessRecoveryStart> {
    nativeOwned: () => Promise<boolean>;
    loadSettings: () => Promise<{ apiKey: string; secretKey: string }>;
    // must restart through the native spawn path with the harness flag on —
    // the serverStart harnessMismatch branch stops the unowned daemon only
    // with full is-shioaji ownership proof (fail-closed for foreign servers)
    restart: () => Promise<R>;
}

// Returns null when the sidecar is already owned (nothing done), the restart
// result when a respawn recovered ownership, and throws when recovery is
// impossible (no credentials / restart failed / still unowned after respawn).
export async function recoverHarnessOwnership<R extends HarnessRecoveryStart>(
    deps: HarnessRecoveryDeps<R>,
): Promise<R | null> {
    if (await deps.nativeOwned()) return null;
    const settings = await deps.loadSettings();
    if (!settings.apiKey || !settings.secretKey) {
        throw new Error(
            'Agent Harness 需要本 App 啟動的伺服器，但尚未設定 API 金鑰，' +
                '無法自動重啟 — 請先到「設定 → 連線」完成登入',
        );
    }
    const res = await deps.restart();
    if (!res.ok) {
        throw new Error(
            `伺服器重啟失敗，無法建立 Agent Harness：${res.output || '未知錯誤'}`,
        );
    }
    if (!(await deps.nativeOwned())) {
        throw new Error(
            '伺服器已重啟，但 Agent Harness 仍未取得 sidecar 所有權 — ' +
                '請到「伺服器」面板手動重啟',
        );
    }
    return res;
}
