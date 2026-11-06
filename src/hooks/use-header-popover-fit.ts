// src/hooks/use-header-popover-fit.ts：頂欄選單掛在按鈕下方、右緣對齊按鈕（桌面原設計）
//
// 頂欄換行讓按鈕跑到左側時，右緣對齊會超出視窗左緣：依可見範圍往內收、必要時
// 縮寬（同 K 線工具列的 fitPopover）。放得下時不加任何樣式，桌面外觀不變。開著時
// 每個 frame 看按鈕位置，依開啟時的原寬重算：頂欄換行時按鈕可能換列，但列數與各元素
// 尺寸都沒變，ResizeObserver 看不到；位置沒變就不更新 state。

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { fitPopover, visibleClipRect } from '../lib/popover-fit';

export function useHeaderPopoverFit(
    open: boolean,
    wrapRef: RefObject<HTMLElement | null>,
    popRef: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
    const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
    useLayoutEffect(() => {
        const wrap = wrapRef.current;
        const pop = popRef.current;
        const win = wrap?.ownerDocument?.defaultView;
        if (!open || !wrap || !pop || !win || typeof wrap.getBoundingClientRect !== 'function') {
            setStyle(undefined);
            return;
        }
        // Measured before any fit style applies: the menu's own width.
        const width = pop.offsetWidth;
        let placed: CSSProperties | undefined;
        const place = () => {
            const anchor = wrap.getBoundingClientRect();
            const start = anchor.right - width;
            // Height is not fitted: the header menus are short.
            const fit = fitPopover({ left: start, bottom: anchor.bottom }, { width, height: 0 }, visibleClipRect(wrap));
            // Offsets are relative to the wrapper, the popover's containing block.
            const left = start + fit.left - anchor.left;
            const next: CSSProperties | undefined = fit.left === 0 && fit.maxWidth === undefined ? undefined
                : { left, right: 'auto', ...(fit.maxWidth !== undefined ? { width: fit.maxWidth } : {}) };
            if (next?.left === placed?.left && next?.width === placed?.width) return;
            placed = next;
            setStyle(next);
        };
        let frame = 0;
        const follow = () => {
            place();
            frame = win.requestAnimationFrame(follow);
        };
        follow();
        return () => win.cancelAnimationFrame(frame);
    }, [open, wrapRef, popRef]);
    return style;
}
