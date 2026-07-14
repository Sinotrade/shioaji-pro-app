// src/components/webview-panel.tsx — 自訂網頁面板：把任意 http(s) 頁面嵌進 workspace
//
// 用例：自架 dashboard／內網監控頁／TradingView 等外部工具，跟行情面板同一個版面。
// URL 存在 Block.url（隨 workspace/版面 profile 一起持久化）。
// 安全：僅接受 http/https；iframe 帶 sandbox（不給 top-navigation）。目標站若以
// X-Frame-Options / CSP frame-ancestors 拒絕內嵌，瀏覽器會擋下——面板顯示空白屬預期。

import { useState } from 'react';
import * as css from './webview-panel.css';

function normalizeUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const candidate = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `http://${trimmed}`;
    try {
        const u = new URL(candidate);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.href;
    } catch {
        return null;
    }
}

export function WebviewPanel({
    url,
    onUrlChange,
}: {
    url: string | null;
    onUrlChange: (url: string | null) => void;
}) {
    const [editing, setEditing] = useState(url == null);
    const [draft, setDraft] = useState(url ?? '');
    const [reloadKey, setReloadKey] = useState(0);

    const submit = () => {
        const next = normalizeUrl(draft);
        if (!next) return;
        onUrlChange(next);
        setDraft(next);
        setEditing(false);
    };

    if (editing || !url) {
        return (
            <div className={css.setup}>
                <input
                    className={css.input}
                    value={draft}
                    placeholder='http://127.0.0.1:8787 或任何網址'
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                    autoFocus
                />
                <div className={css.setupRow}>
                    <button className={css.btn} onClick={submit}>
                        載入
                    </button>
                    {url ? (
                        <button
                            className={css.btn}
                            onClick={() => {
                                setDraft(url);
                                setEditing(false);
                            }}
                        >
                            取消
                        </button>
                    ) : null}
                </div>
                <p className={css.hint}>
                    僅支援 http/https。目標網站若禁止內嵌（X-Frame-Options /
                    frame-ancestors）將無法顯示。
                </p>
            </div>
        );
    }

    return (
        <div className={css.wrap}>
            <div className={css.toolbar}>
                <span className={css.urlText} title={url}>
                    {url}
                </span>
                <button
                    className={css.btn}
                    onClick={() => setReloadKey((k) => k + 1)}
                >
                    重整
                </button>
                <button
                    className={css.btn}
                    onClick={() => {
                        setDraft(url);
                        setEditing(true);
                    }}
                >
                    變更
                </button>
            </div>
            <iframe
                key={reloadKey}
                className={css.frame}
                src={url}
                title='自訂網頁'
                sandbox='allow-scripts allow-same-origin allow-forms allow-popups'
                referrerPolicy='no-referrer'
            />
        </div>
    );
}
