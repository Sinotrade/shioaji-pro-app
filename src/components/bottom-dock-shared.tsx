// src/components/bottom-dock-shared.tsx — dock 三 tab 共用：偏好持久化、
// 面板量寬、帳戶歸屬推斷、arm-lock 與兩段式確認按鈕

import { Lock, Unlock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { maskAccountId } from '../lib/privacy';
import type { AccountedTrade, Trade } from '../lib/types/order';
import type {
    Account,
    AccountedPosition,
    Position,
    StockPosition,
} from '../lib/types/portfolio';
import { vars } from '../theme.css';
import * as styles from './bottom-dock.css';

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
    'PendingSubmit',
    'PreSubmitted',
    'Submitted',
    'PartFilled',
]);

export function statusKind(status: string): 'ok' | 'pending' | 'bad' {
    if (status === 'Filled') return 'ok';
    if (ACTIVE_STATUSES.has(status)) return 'pending';
    return 'bad';
}

// stock positions carry yd_quantity; futures ones don't
export function isStockPosition(p: Position): p is StockPosition {
    return 'yd_quantity' in p;
}

export type MarketFilter = 'all' | 'S' | 'F';
export type ViewMode = 'merged' | 'grouped';
export type SizeClass = 'narrow' | 'mid' | 'wide';

// ---- 偏好（模式/篩選）持久化，key 前綴 sj-pro-dock- ----

const PREF_PREFIX = 'sj-pro-dock-';

export function useDockPref<T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T,
): [T, (v: T) => void] {
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = localStorage.getItem(PREF_PREFIX + key);
            return allowed.includes(raw as T) ? (raw as T) : fallback;
        } catch {
            return fallback;
        }
    });
    const set = useCallback(
        (v: T) => {
            setValue(v);
            try {
                localStorage.setItem(PREF_PREFIX + key, v);
            } catch {
                // session-only
            }
        },
        [key],
    );
    return [value, set];
}

// ---- 量寬：面板在 react-grid-layout 裡尺寸任意，欄位佈局跟著實寬走 ----

const NARROW_MAX = 480;
const WIDE_MIN = 760;

export function sizeClassOf(width: number): SizeClass {
    if (width <= 0) return 'wide'; // 未量到前先給全欄，避免首繪抖動
    if (width < NARROW_MAX) return 'narrow';
    if (width < WIDE_MIN) return 'mid';
    return 'wide';
}

export function useMeasuredWidth(): {
    ref: (el: HTMLElement | null) => void;
    width: number;
} {
    const [width, setWidth] = useState(0);
    const roRef = useRef<ResizeObserver | null>(null);
    const ref = useCallback((el: HTMLElement | null) => {
        roRef.current?.disconnect();
        roRef.current = null;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setWidth(entry.contentRect.width);
            }
        });
        ro.observe(el);
        roRef.current = ro;
        setWidth(el.clientWidth);
    }, []);
    useEffect(() => () => roRef.current?.disconnect(), []);
    return { ref, width };
}

// ---- 帳戶歸屬：position/trade → 所屬帳戶（缺欄位時以市場別回推） ----

export interface AccountRef {
    type: 'S' | 'F';
    broker_id: string;
    account_id: string;
}

export function refKey(r: AccountRef | null): string {
    return r ? `${r.broker_id}-${r.account_id}` : '';
}

export function accountToRef(a: Account): AccountRef {
    return {
        type: a.account_type === 'S' ? 'S' : 'F',
        broker_id: a.broker_id,
        account_id: a.account_id,
    };
}

export interface AccountFallback {
    stock: Account | null;
    futures: Account | null;
}

export function positionMarket(p: Position): 'S' | 'F' {
    return isStockPosition(p) ? 'S' : 'F';
}

export function positionAccountRef(
    p: AccountedPosition,
    fallback: AccountFallback,
): AccountRef | null {
    if (p.account) return accountToRef(p.account);
    const acc = isStockPosition(p) ? fallback.stock : fallback.futures;
    return acc ? accountToRef(acc) : null;
}

export function tradeMarket(t: Trade): 'S' | 'F' {
    const at = t.order.account?.account_type;
    if (at === 'S' || at === 'F') return at;
    const st = t.contract.security_type;
    return st === 'FUT' || st === 'OPT' ? 'F' : 'S';
}

export function tradeAccountRef(
    t: Trade,
    fallback: AccountFallback,
): AccountRef | null {
    const type = tradeMarket(t);
    // fan-out 標籤優先 — 帳號格式與 /auth/accounts 清單一致，scope
    // 篩選的 refKey 比對不會因 order.account 的格式差異落空（issue #19）
    const tagged = (t as AccountedTrade).account;
    if (tagged?.broker_id && tagged.account_id) {
        return {
            type,
            broker_id: tagged.broker_id,
            account_id: tagged.account_id,
        };
    }
    const oa = t.order.account;
    if (oa?.broker_id && oa.account_id) {
        return { type, broker_id: oa.broker_id, account_id: oa.account_id };
    }
    const acc = type === 'S' ? fallback.stock : fallback.futures;
    return acc ? accountToRef(acc) : null;
}

// [證] 9A95-9816502（隱私模式遮帳號尾碼以外的字元）
export function accountRefLabel(r: AccountRef | null, priv: boolean): string {
    if (!r) return '未知帳戶';
    const tag = r.type === 'S' ? '[證]' : '[期]';
    return `${tag} ${r.broker_id}-${maskAccountId(r.account_id, priv)}`;
}

// ---- arm-lock：批次平倉/刪單與單筆平/反共用的防誤觸鎖 ----

export function ArmLockButton({
    armed,
    onToggle,
    hint,
}: {
    armed: boolean;
    onToggle: () => void;
    hint: string;
}) {
    return (
        <button
            className={styles.cancelBtn}
            title={armed ? `鎖定${hint}（防誤觸）` : `${hint}預設鎖定 — 點此解鎖`}
            style={
                armed
                    ? {
                          color: vars.color.danger,
                          borderColor: vars.color.danger,
                      }
                    : undefined
            }
            onClick={onToggle}
        >
            {armed ? <Unlock size={10} /> : <Lock size={10} />}
        </button>
    );
}

// 兩段式確認：第一擊變成「確認 …？」並於 3 秒後自動復原，第二擊才執行
export function ConfirmButton({
    label,
    confirmLabel,
    disabled,
    title,
    onConfirm,
}: {
    label: string;
    confirmLabel: string;
    disabled?: boolean;
    title?: string;
    onConfirm: () => void;
}) {
    const [confirming, setConfirming] = useState(false);
    useEffect(() => {
        if (!confirming) return;
        const t = setTimeout(() => setConfirming(false), 3000);
        return () => clearTimeout(t);
    }, [confirming]);
    useEffect(() => {
        if (disabled) setConfirming(false);
    }, [disabled]);
    return (
        <button
            className={styles.batchExec[confirming ? 'confirm' : 'idle']}
            disabled={disabled}
            title={title}
            onClick={() => {
                if (confirming) {
                    setConfirming(false);
                    onConfirm();
                } else {
                    setConfirming(true);
                }
            }}
        >
            {confirming ? confirmLabel : label}
        </button>
    );
}
