// src/hooks/use-tw-query-window.ts — 追蹤台股帳務查詢的服務時段（見
// lib/tw-query-window.ts）。不輪詢：只排一個計時器到下一次開／關的邊界；
// 電腦睡眠時計時器可能延後，所以回到前景（visibilitychange/focus）時重算一次。

import { useEffect, useState } from 'react';
import { twQueryWindowState, type TwQueryWindow, type TwQueryWindowState } from '../lib/tw-query-window';

// setTimeout 上限約 24.8 天；最長的關閉期（週五收盤到週一開盤）遠小於此，保險起見仍夾住
const MAX_DELAY_MS = 2 ** 31 - 1;
// 邊界後多等一點，避免計時器提早幾毫秒觸發又算成「還沒開」
const BOUNDARY_SLACK_MS = 50;

export function useTwQueryWindow(w: TwQueryWindow): TwQueryWindowState {
    const [state, setState] = useState(() => twQueryWindowState(Date.now(), w));
    useEffect(() => {
        const recompute = () => {
            const next = twQueryWindowState(Date.now(), w);
            setState(prev => prev.open === next.open && prev.sessionDate === next.sessionDate
                && prev.nextChangeMs === next.nextChangeMs ? prev : next);
        };
        recompute();
        const delay = Math.min(MAX_DELAY_MS, Math.max(0, state.nextChangeMs - Date.now()) + BOUNDARY_SLACK_MS);
        const timer = setTimeout(recompute, delay);
        const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') recompute(); };
        const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
        const hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
        if (hasWindow) window.addEventListener('focus', onVisible);
        if (hasDocument) document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearTimeout(timer);
            if (hasWindow) window.removeEventListener('focus', onVisible);
            if (hasDocument) document.removeEventListener('visibilitychange', onVisible);
        };
    }, [w, state.nextChangeMs]);
    return state;
}
