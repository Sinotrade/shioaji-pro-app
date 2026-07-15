// src/components/webview-panel.tsx — 自訂網頁面板：把任意 http(s) 頁面嵌進 workspace
//
// 用例：自架 dashboard／內網監控頁／TradingView 等外部工具，跟行情面板同一個版面。
// URL 存在 Block.url（隨 workspace/版面 profile 一起持久化）。
// 連動：URL 含 {code} 佔位符 → 代入面板目前商品代碼（跟隨全域選股或釘選），
// 選股切換時 iframe 以新網址重載；靜態 URL 不受影響。
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

// {code} 在 URL path 段會被 URL 序列化成 %7Bcode%7D（query 段保持原樣），兩種都代換。
function isTemplate(url: string): boolean {
    return url.includes('{code}') || url.includes('%7Bcode%7D');
}

function fillTemplate(url: string, code: string): string {
    return url.replaceAll('{code}', code).replaceAll('%7Bcode%7D', code);
}

export function WebviewPanel({
    url,
    code,
    onUrlChange,
}: {
    url: string | null;
    code: string | null;
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
                    僅支援 http/https。URL 含 {'{code}'}{' '}
                    會代入目前商品代碼並跟著選股連動。目標網站若禁止內嵌
                    （X-Frame-Options / frame-ancestors）將無法顯示。
                </p>
            </div>
        );
    }

    if (isTemplate(url) && !code) {
        return (
            <div className={css.setup}>
                <p className={css.hint}>
                    等待商品…（URL 含 {'{code}'}，選擇商品後載入）
                </p>
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
        );
    }
    const src = code ? fillTemplate(url, code) : url;

    return (
        <div className={css.wrap}>
            <div className={css.toolbar}>
                <span className={css.urlText} title={src}>
                    {src}
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
                key={`${reloadKey}:${src}`}
                className={css.frame}
                src={src}
                title='自訂網頁'
                sandbox='allow-scripts allow-same-origin allow-forms allow-popups'
                referrerPolicy='no-referrer'
            />
        </div>
    );
}
