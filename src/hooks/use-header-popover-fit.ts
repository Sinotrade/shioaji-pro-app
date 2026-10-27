// src/hooks/use-header-popover-fit.ts：頂欄選單掛在按鈕下方、右緣對齊按鈕（桌面原設計）
//
// 頂欄換行讓按鈕跑到左側時，右緣對齊會超出視窗左緣：依可見範圍往內收、必要時
// 縮寬（同 K 線工具列的 fitPopover）。放得下時不加任何樣式，桌面外觀不變。

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
        if (!open || !wrap || !pop || typeof wrap.getBoundingClientRect !== 'function') {
            setStyle(undefined);
            return;
        }
        const anchor = wrap.getBoundingClientRect();
        const width = pop.offsetWidth;
        const start = anchor.right - width;
        const fit = fitPopover({ left: start, bottom: anchor.bottom }, { width, height: pop.scrollHeight }, visibleClipRect(wrap));
        if (fit.left === 0 && fit.maxWidth === undefined) return;
        // Offsets are relative to the wrapper, the popover's containing block.
        setStyle({
            left: start + fit.left - anchor.left,
            right: 'auto',
            ...(fit.maxWidth !== undefined ? { width: fit.maxWidth, boxSizing: 'border-box' } : {}),
        });
    }, [open, wrapRef, popRef]);
    return style;
}
