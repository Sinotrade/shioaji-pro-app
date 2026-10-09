// src/lib/conditional/bracket-policy.ts — the 括號單規則 of 條件單設定
// (#226): the background engine's BracketPolicy (contract v2), read and
// saved through the App. Available on the desktop with the background engine
// reachable; the main window saves. 全部暫停 in this window follows the same
// pauseStopsExits value.

import { useEffect, useState } from 'react';
import { backgroundSupported, getBracketPolicy, setBracketPolicy, useBackgroundHealth } from '../execution/background';
import type { BracketPolicy } from '../execution/bracket-contract';
import { isMainWindow } from '../main-window-commands';
import { setConditionalSettings } from './settings';

export interface PolicyState {
    policy: BracketPolicy | null;
    /** why the switches are not usable (null: usable) */
    unavailable: string | null;
    error: string | null;
    busy: boolean;
    save: (patch: Partial<BracketPolicy>) => void;
}

export function useBracketPolicy(): PolicyState {
    const health = useBackgroundHealth();
    const [policy, setPolicy] = useState<BracketPolicy | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const reachable = backgroundSupported() && health !== null;
    useEffect(() => {
        // a new connection reads again; nothing saved from a stale copy meanwhile
        setPolicy(null);
        if (!reachable) { setConditionalSettings({ pauseStopsExits: false }); return; }
        let alive = true;
        getBracketPolicy().then(p => {
            if (!alive) return;
            setPolicy(p);
            setError(null);
            setConditionalSettings({ pauseStopsExits: p.pauseStopsExits });
        }, e => { if (alive) { setPolicy(null); setError(e instanceof Error ? e.message : String(e)); } });
        return () => { alive = false; };
    }, [reachable]);
    const unavailable = !backgroundSupported() ? '只在桌面版提供'
        : !reachable ? '背景執行目前無法使用，暫時不能設定'
            : !isMainWindow() ? '請在主視窗設定'
                : policy === null ? (error ? `設定無法讀取（${error}）` : '讀取中…') : null;
    const save = (patch: Partial<BracketPolicy>) => {
        if (!policy || unavailable) return;
        setBusy(true);
        setError(null);
        setBracketPolicy({ ...policy, ...patch }).then(saved => {
            setPolicy(saved);
            setConditionalSettings({ pauseStopsExits: saved.pauseStopsExits });
        }, e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
    };
    return { policy, unavailable, error, busy, save };
}
