import { useCallback, useRef } from 'react';

// 必須維持模組層級的穩定函式：寫成行內 ref callback 會在每次 render 重跑，輸入時焦點會被搶回來。
/** 讓步驟的第一個可操作元素取得焦點；精靈所在的分頁被隱藏時（如切到 API Key 登入）不搶焦點。 */
export const autofocus = (node: HTMLElement | null): void => {
    if (!node || node.closest?.('[hidden]')) return;
    node.focus({ preventScroll: true });
};

/** autofocus 加上 ref：驗證失敗時可以把焦點送回有問題的欄位。 */
export function useAutofocusRef<T extends HTMLElement>() {
    const node = useRef<T | null>(null);
    const attach = useCallback((element: T | null) => {
        node.current = element;
        autofocus(element);
    }, []);
    return { node, attach };
}
