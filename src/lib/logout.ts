// src/lib/logout.ts — 登出並清除金鑰：伺服器管理的「登出」與應用程式鎖第 10 次輸錯共用。
// 登出要先停掉本 App 的 Agent 與伺服器（#16：不停的話，下次登入會接手仍用舊金鑰登入的
// 伺服器）；外部伺服器由原生的擁有權檢查擋在外面。停不下來時重新載入頁面（boot 會重新
// 確認伺服器身分，期間下單閘門保持關閉）並丟出錯誤，金鑰不清。

import { setServerIdentityVerified } from './server-identity';
import { clearStoredSpawnKeyHash } from './spawn-keys';
import { deleteCredentialProfile, logoutCredentialProfile, serverStop } from './tauri';

/**
 * `beforeReload` 在金鑰清除之後、重新載入之前執行。
 * `allProfiles`：連沒在使用的帳號也刪掉（應用程式鎖第 10 次輸錯；只清使用中那組的話，
 * 登入畫面選另一組就進得去）。伺服器管理的「登出」照舊只清使用中的帳號。
 */
export async function logoutAndReload(beforeReload?: () => void, allProfiles = false): Promise<void> {
    setServerIdentityVerified(false);
    const stopped = await serverStop({ stopAgents: true, ownedOnly: true });
    if (!stopped.ok) {
        setTimeout(() => globalThis.window?.location?.reload?.(), 0);
        throw new Error(stopped.output || '無法停止本機伺服器');
    }
    const settings = await logoutCredentialProfile();
    if (allProfiles) for (const profile of settings.profiles) await deleteCredentialProfile(profile.id);
    clearStoredSpawnKeyHash();
    beforeReload?.();
    window.location.reload();
}
