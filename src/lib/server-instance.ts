// src/lib/server-instance.ts — sidecar 程序身分（SDK 1.7.8+ 的 instance id）。
//
// 1.7.8 起 /api/v1/info 與 /health 會帶 instance_id，每個 HTTP 回應也帶
// X-Shioaji-Instance 標頭。送出下單／刪單後比對回應標頭與送出前驗證時的 instance：
// - 標頭不存在（舊版 SDK）→ absent：不做任何事（沿用串流世代等既有檢查）。
// - 相同 → match。
// - 不同，或送出前沒有可比對的 instance → mismatch：這個回應可能來自另一個 sidecar
//   程序，結果視為不明並觸發完整重新驗證。

export const INSTANCE_HEADER = 'X-Shioaji-Instance';

export type InstanceCheck = 'absent' | 'match' | 'mismatch';

export function instanceFromResponse(res: { headers: { get(name: string): string | null } }): string | null {
    const v = res.headers.get(INSTANCE_HEADER);
    return v && v.trim() ? v.trim() : null;
}

export function checkInstance(expected: string | null | undefined, got: string | null): InstanceCheck {
    if (got === null) return 'absent';
    return expected && expected === got ? 'match' : 'mismatch';
}
