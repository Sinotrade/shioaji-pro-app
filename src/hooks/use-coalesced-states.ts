// src/hooks/use-coalesced-states.ts — 合併短時間內陸續到達的串流狀態

import { useEffect, useRef, useState } from 'react';

// 群組內排行每個產業各自一包、到達時間錯開；把短時間內的多包合併成一次
// 版面重算（節流 delayMs，下鑽時暫停）。狀態物件本身沒換時不觸發。
// scope（指數＋投影）一換就直接用新狀態，不沿用舊快照（避免舊指標的值
// 套到新投影上）。
export function useCoalescedStates<T>(
    states: readonly T[],
    scope: string,
    delayMs: number,
    paused: boolean,
): readonly T[] {
    const [snapshot, setSnapshot] = useState({ scope, states });
    const latest = useRef({ scope, states });
    latest.current = { scope, states };
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sameScope = snapshot.scope === scope;
    // scope 換了：render 當下就把快照換成新 scope 的狀態（React 會在
    // commit 前重跑），來回切換也不會回到更早的舊快照
    if (!sameScope) setSnapshot({ scope, states });
    const changed =
        !sameScope ||
        states.length !== snapshot.states.length ||
        states.some((state, i) => state !== snapshot.states[i]);
    // 每次 commit 後檢查：有新資料且沒有排程中的計時器就排一個 —
    // 計時器觸發後若又有新包，下一次 commit 會再排，不會卡住
    useEffect(() => {
        if (!changed || paused || timer.current) return;
        timer.current = setTimeout(() => {
            timer.current = null;
            // 計時器排程後才暫停：不發布，恢復後下一次 commit 會再排
            if (pausedRef.current) return;
            setSnapshot(latest.current);
        }, delayMs);
    });
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );
    return sameScope ? snapshot.states : states;
}
