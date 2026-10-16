// src/hooks/use-board-tier.ts：報價看板的階梯（指數、個股共用），量面板大小，挑「標題加看板不超過 1/5」內最豐富的一級。
// 做法：由豐富到精簡逐級把 data-tier 設到看板上、讀實際排版高度與是否橫向溢出，放得下就停
// （不寫死各級尺寸，字級縮放或內容寬度變動都自動跟上）。樣式由 quote-board.css 依 data-tier 切換。

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
    boardBudget,
    effectiveTier,
    nextBoardMode,
    parseBoardMode,
    pickBoardTier,
    type BoardMode,
    type BoardTier,
} from '../lib/board-tier';

// 收合／展開是使用者的全域偏好，指數與個股各自一個 key（sj-index-board-mode、sj-stock-board-mode）：
// 同一種看板（含彈出視窗）共用並即時同步。比照 limit-style-prefs：模組層讀一次、
// 常駐監聽其他視窗的變更（含整個清空時 key 為 null）
interface ModeStore {
    current: BoardMode;
    listeners: Set<() => void>;
    subscribe: (listener: () => void) => () => void;
    read: () => BoardMode;
}

function readStored(key: string): BoardMode {
    try {
        return parseBoardMode(localStorage.getItem(key));
    } catch {
        return 'auto';
    }
}

const modeStores = new Map<string, ModeStore>();

function modeStore(key: string): ModeStore {
    let store = modeStores.get(key);
    if (!store) {
        const created: ModeStore = {
            current: readStored(key),
            listeners: new Set(),
            subscribe: (listener) => {
                created.listeners.add(listener);
                return () => {
                    created.listeners.delete(listener);
                };
            },
            read: () => created.current,
        };
        modeStores.set(key, created);
        store = created;
    }
    return store;
}

try {
    window.addEventListener('storage', (e) => {
        for (const [key, store] of modeStores) {
            if (e.key !== key && e.key !== null) continue;
            const next = readStored(key);
            if (next === store.current) continue;
            store.current = next;
            store.listeners.forEach((listener) => listener());
        }
    });
} catch {
    // 非瀏覽器環境
}

function writeMode(key: string, mode: BoardMode) {
    const store = modeStore(key);
    store.current = mode;
    try {
        if (mode === 'auto') localStorage.removeItem(key);
        else localStorage.setItem(key, mode);
    } catch {
        // 私密視窗或被封鎖時只在本次連線生效
    }
    store.listeners.forEach((listener) => listener());
}

// contentKey：顯示文字長度的摘要。數字變長（例如資料剛到、家數跨過百位）時看板外框不一定變，
// ResizeObserver 收不到，要靠它觸發重新判斷；只比長度，不會每跳一次報價就重量
export function useBoardTier(
    boardRef: RefObject<HTMLElement | null>,
    enabled: boolean,
    contentKey: string,
    modeKey: string,
) {
    const store = modeStore(modeKey);
    const mode = useSyncExternalStore(store.subscribe, store.read, () => 'auto' as const);
    const [autoTier, setAutoTier] = useState<BoardTier>('wide');
    const refit = useRef<(() => void) | null>(null);

    useLayoutEffect(() => {
        const board = boardRef.current;
        const panel = board?.parentElement;
        if (!enabled || !board || !panel || typeof ResizeObserver === 'undefined') return;
        let current: BoardTier | undefined;
        const fit = () => {
            const panelHeight = panel.clientHeight;
            if (panelHeight <= 0) return; // 尚未排版
            let above = 0;
            for (let s = board.previousElementSibling; s; s = s.previousElementSibling) {
                above += s.getBoundingClientRect().height;
            }
            const overflows = (el: Element) => el.scrollWidth > el.clientWidth + 1;
            // 寬度升級緩衝：約一個大字（1.5rem 等寬字）的寬度，跟著字級縮放；
            // 漲跌跨過 +100、家數跨過百位都只差一個字，這樣才擋得住來回閃爍
            const widthSlack = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.9;
            const measure = (t: BoardTier, upgrading: boolean) => {
                board.dataset.tier = t;
                // 升級時暫時把右側留白加寬，等於要求內容多留一個字寬才算放得下
                // （放得下時 scrollWidth 等於 clientWidth，不能直接拿來加緩衝比較）
                if (upgrading) {
                    board.style.paddingRight = `${parseFloat(getComputedStyle(board).paddingRight) + widthSlack}px`;
                }
                // 單行階梯不換行：看板或其中任一區塊橫向放不下（被裁切、擠出）就算放不下
                const fits = !overflows(board) && ![...board.children].some(overflows);
                const height = board.offsetHeight;
                board.style.paddingRight = '';
                return fits ? height : Infinity;
            };
            const auto = pickBoardTier(measure, boardBudget(panelHeight, above), current);
            current = auto;
            board.dataset.tier = effectiveTier(mode, auto);
            setAutoTier(auto);
        };
        fit();
        refit.current = fit;
        // 面板縮放、看板內容（價格位數）變動造成的尺寸變化都重新判斷。
        // 延到下一個影格再量：回呼裡直接改被觀察元素的尺寸會觸發瀏覽器的 ResizeObserver loop 警告
        let frame = 0;
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(fit);
        };
        const observer = new ResizeObserver(schedule);
        observer.observe(panel);
        observer.observe(board);
        // 網頁字型晚到時字寬會變，但看板外框不變、ResizeObserver 收不到
        const fonts = document.fonts;
        fonts?.ready.then(schedule).catch(() => undefined);
        fonts?.addEventListener('loadingdone', schedule);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            fonts?.removeEventListener('loadingdone', schedule);
            refit.current = null;
            // 同一個看板元素換商品時會沿用，階梯屬性與量測用的留白都要清掉
            delete board.dataset.tier;
            board.style.paddingRight = '';
        };
        // modeKey 代表看板種類（指數／個股）：換種類時重新從頭判斷，不沿用上一種的階梯與緩衝狀態
    }, [boardRef, enabled, mode, modeKey]);

    useLayoutEffect(() => {
        refit.current?.();
    }, [contentKey]);

    const toggle = useCallback(
        () => writeMode(modeKey, nextBoardMode(mode, autoTier)),
        [modeKey, mode, autoTier],
    );

    // 目前階梯由模式與自動結果算出，不另存一份狀態（模式一改，按鈕標示立即跟著變）
    return { tier: effectiveTier(mode, autoTier), toggle };
}
