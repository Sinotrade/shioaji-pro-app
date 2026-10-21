// src/lib/privacy.ts — privacy mode masks account identifiers everywhere
// in the UI (screenshots, screen sharing, streaming). Persisted.

import { useSyncExternalStore } from 'react';

const KEY = 'sj-pro-privacy-mode';

let on = false;
try {
    on = localStorage.getItem(KEY) === '1';
} catch {
    // storage unavailable — default off
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getPrivacyMode(): boolean {
    return on;
}

export function setPrivacyMode(v: boolean) {
    on = v;
    try {
        localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
        // session-only
    }
    listeners.forEach((l) => l());
}

export function usePrivacyMode(): boolean {
    return useSyncExternalStore(subscribe, getPrivacyMode);
}

// 9816502 → •••••02 — keep the tail so multiple accounts stay apart
export function maskAccountId(id: string, priv: boolean): string {
    if (!priv) return id;
    if (id.length <= 2) return '•'.repeat(id.length);
    return '•'.repeat(id.length - 2) + id.slice(-2);
}

export function maskName(name: string, priv: boolean): string {
    return priv ? '•••' : name;
}

// ---- 遮金額 (issue #2): hide amounts in screenshots — separate toggle ----

const MONEY_KEY = 'sj-pro-privacy-money';

let moneyOn = false;
try {
    moneyOn = localStorage.getItem(MONEY_KEY) === '1';
} catch {
    // storage unavailable — default off
}

const moneyListeners = new Set<() => void>();

export function getPrivacyMoney(): boolean {
    return moneyOn;
}

export function setPrivacyMoney(v: boolean) {
    moneyOn = v;
    try {
        localStorage.setItem(MONEY_KEY, v ? '1' : '0');
    } catch {
        // session-only
    }
    moneyListeners.forEach((l) => l());
}

export function usePrivacyMoney(): boolean {
    return useSyncExternalStore((l) => {
        moneyListeners.add(l);
        return () => {
            moneyListeners.delete(l);
        };
    }, getPrivacyMoney);
}

// Cross-window sync (#85 B-2): popouts share localStorage but not module
// state, so a toggle in one window must reach already-open popouts. The
// `storage` event fires only in the other windows. `key === null` is a
// storage clear.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key === KEY || e.key === null) {
            const next = e.key === null ? false : e.newValue === '1';
            if (next !== on) {
                on = next;
                listeners.forEach((l) => l());
            }
        }
        if (e.key === MONEY_KEY || e.key === null) {
            const next = e.key === null ? false : e.newValue === '1';
            if (next !== moneyOn) {
                moneyOn = next;
                moneyListeners.forEach((l) => l());
            }
        }
    });
}

export function maskMoney(text: string, priv: boolean): string {
    return priv ? '•••••' : text;
}

// ---- 產生當下就組好的文字（通知、toast、錯誤訊息）(#268) ----
//
// 通知中心與 toast 保留產生當下的字串；之後才打開隱私／遮金額時，
// 這些字串也要能重新遮蔽。敏感片段用不顯示的 Unicode 格式字元包起來，
// 由 revealText 在「畫面渲染時」依目前開關遮蔽或還原。
// 產生當下若開關已開，直接輸出遮罩（不留原值），不會比原本更容易漏。

const MONEY_START = '⁡';
const ACCOUNT_START = '⁢';
const SECRET_END = '⁣';
const SECRET_RE = /([⁡⁢])([^⁡⁢⁣]*)⁣/g;

/** 金額／損益／持倉量等「遮金額」片段：開關已開就直接遮，否則標記成渲染時可重遮 */
export function secretMoney(text: string | number): string {
    const s = String(text);
    return moneyOn ? maskMoney(s, true) : `${MONEY_START}${s}${SECRET_END}`;
}

/** 帳號片段：隱私模式已開就直接遮，否則標記成渲染時可重遮 */
export function secretAccount(id: string): string {
    return on ? maskAccountId(id, true) : `${ACCOUNT_START}${id}${SECRET_END}`;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 渲染時把產生當下組好的文字套用目前的隱私開關。
 * - secretMoney／secretAccount 標記的片段依開關遮或還原；
 * - 隱私模式開啟時，文字中出現的已知帳號（例如伺服器錯誤訊息、啟動 log）
 *   一律遮成末兩碼。
 */
export function revealText(
    text: string,
    opts: { priv: boolean; privMoney: boolean; accountIds?: readonly string[] },
): string {
    let out = text.replace(SECRET_RE, (_m, kind: string, value: string) =>
        kind === MONEY_START ? maskMoney(value, opts.privMoney) : maskAccountId(value, opts.priv),
    );
    if (opts.priv && opts.accountIds?.length) {
        const ids = [...new Set(opts.accountIds.filter(id => id.length >= 4))].sort((a, b) => b.length - a.length);
        if (ids.length) {
            const re = new RegExp(`(?<![0-9A-Za-z])(?:${ids.map(escapeRe).join('|')})(?![0-9A-Za-z])`, 'g');
            out = out.replace(re, id => maskAccountId(id, true));
        }
    }
    return out;
}

/** 移除標記、保留原值（複製到剪貼簿等不經過畫面遮蔽的出口用） */
export function plainText(text: string): string {
    return text.replace(SECRET_RE, (_m, _kind: string, value: string) => value);
}
