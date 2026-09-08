// src/lib/feedback.ts — 診斷面板「回報問題」：組診斷區塊、套表單 URL 模板。
// 純函式，不碰 DOM / Tauri，讓 debug-panel 只剩黏合層，也方便測試。
//
// 設計取捨：不自動送出任何資料。按鈕只做「複製診斷 + 開表單」，使用者到
// 表單後自己決定貼什麼。零後端、不碰截圖隱私、開源版不用塞永豐專用端點。

export interface FeedbackContext {
    ver: string; // app version，未知為 ''
    os: string; // host_info 或 navigator.platform
    env: 'sim' | 'prod' | 'unknown';
    tier: string;
    stream: string; // LIVE / SYNC / LOST
    heartbeatAge: number | null; // 秒
    rate: string; // 筆/秒
    serverVersion: string; // 'v1.7.1'，未知為 ''
    tokenHours: number | null;
    apiBase: string; // '' 代表同源
}

/** 三行診斷區塊。第一行與 server-manager 的「複製診斷資訊」同格式，上游一眼認得。 */
export function formatDiagnostics(c: FeedbackContext): string {
    const hb = c.heartbeatAge === null ? '—' : `${c.heartbeatAge}s ago`;
    const token = c.tokenHours === null ? '—' : `${c.tokenHours}h`;
    return [
        `Shioaji Pro v${c.ver || '?'} · ${c.os}`,
        `tier: ${c.tier} · stream: ${c.stream} · heartbeat: ${hb} · rate: ${c.rate}/s`,
        `server: ${c.serverVersion || '—'} (${c.env}) · token: ${token} · api: ${c.apiBase || '(same-origin)'}`,
    ].join('\n');
}

const PLACEHOLDER = /\{(diag|ver|os|env|tier)\}/g;

/**
 * 把模板裡的 {diag} {ver} {os} {env} {tier} 換成 URL-encoded 值。
 * 沒有占位符就原樣回傳，所以任何表單平台的連結都能直接當模板。
 */
export function buildFeedbackUrl(
    template: string,
    c: FeedbackContext,
    diag: string,
): string {
    const vars: Record<string, string> = {
        diag,
        ver: c.ver,
        os: c.os,
        env: c.env,
        tier: c.tier,
    };
    return template.replace(PLACEHOLDER, (_, key: string) =>
        encodeURIComponent(vars[key] ?? ''),
    );
}
