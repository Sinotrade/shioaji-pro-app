// src/hooks/use-header-popover-fit.ts：頂欄選單掛在按鈕下方、右緣對齊按鈕（桌面原設計）
//
// 頂欄換行讓按鈕跑到左側時，右緣對齊會超出視窗左緣：依可見範圍往內收、必要時
// 縮寬（同 K 線工具列的 fitPopover）。放得下時不加任何樣式，桌面外觀不變。開著時
// 視窗縮放或頂欄重新換行（按鈕文字變長）都依開啟時的原寬重算。

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
        const place = () => {
            const anchor = wrap.getBoundingClientRect();
            const start = anchor.right - width;
            // Height is not fitted: the header menus are short.
            const fit = fitPopover({ left: start, bottom: anchor.bottom }, { width, height: 0 }, visibleClipRect(wrap));
            // Offsets are relative to the wrapper, the popover's containing block.
            const left = start + fit.left - anchor.left;
            setStyle(prev => (fit.left === 0 && fit.maxWidth === undefined ? undefined
                : prev?.left === left && prev?.width === fit.maxWidth ? prev
                : { left, right: 'auto', ...(fit.maxWidth !== undefined ? { width: fit.maxWidth } : {}) }));
        };
        place();
        win.addEventListener('resize', place);
        const Observer = (win as typeof globalThis).ResizeObserver;
        const observer = Observer ? new Observer(place) : null;
        observer?.observe(wrap);
        if (wrap.parentElement) observer?.observe(wrap.parentElement);
        return () => {
            win.removeEventListener('resize', place);
            observer?.disconnect();
        };
    }, [open, wrapRef, popRef]);
    return style;
}
