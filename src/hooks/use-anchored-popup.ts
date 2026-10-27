// src/hooks/use-anchored-popup.ts：錨定在元素旁的浮層，portal 到錨點所在文件的 body
//
// 浮層以 fixed 定位，不被面板的 overflow 裁切，也不受 grid 的 transform 影響
// （獨立視窗亦同）。視窗縮放與任何捲動都重新擺放。給了 onDismiss 時，在浮層
// 與錨點以外按下指標（例如開始拖動面板）或移入焦點（例如打開命令面板），或
// 錨點整個離開可視範圍，就請擁有者收起浮層，不會停在錯的位置。

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface PopupViewport {
    width: number;
    height: number;
}

function sameStyle(current: CSSProperties | undefined, next: CSSProperties): boolean {
    if (!current) return false;
    const keys = Object.keys(next) as (keyof CSSProperties)[];
    return keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]);
}

export function useAnchoredPopup({ anchor, place, popup, onDismiss }: {
    /** Null while the popup is closed: nothing is measured or observed. */
    anchor: HTMLElement | null;
    place: (anchor: HTMLElement, viewport: PopupViewport) => CSSProperties;
    /** The popup element; presses and focus inside it never dismiss. */
    popup?: RefObject<HTMLElement | null>;
    onDismiss?: () => void;
}): { style: CSSProperties | undefined; portal: (node: ReactNode) => ReactNode } {
    const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
    const latest = useRef({ place, onDismiss });
    latest.current = { place, onDismiss };
    const dismissible = !!onDismiss;

    useLayoutEffect(() => {
        const doc = anchor?.ownerDocument;
        const win = doc?.defaultView;
        if (!anchor || !doc || !win) return;
        const update = () => {
            const next = latest.current.place(anchor, { width: win.innerWidth, height: win.innerHeight });
            // Scrolling the popup itself lands here too; an unchanged place skips the render.
            setStyle((current) => (sameStyle(current, next) ? current : next));
        };
        update();
        win.addEventListener('resize', update);
        win.addEventListener('scroll', update, true);
        if (!dismissible) {
            return () => {
                win.removeEventListener('resize', update);
                win.removeEventListener('scroll', update, true);
            };
        }
        const outside = (event: Event) => {
            const target = event.target as Node | null;
            if (target && (anchor.contains(target) || popup?.current?.contains(target))) return;
            latest.current.onDismiss?.();
        };
        doc.addEventListener('pointerdown', outside, true);
        doc.addEventListener('focusin', outside, true);
        // Ancestor clipping counts: an anchor scrolled out of its panel is not visible.
        const Observer = (win as typeof globalThis).IntersectionObserver;
        const observer = Observer && new Observer((entries) => {
            if (entries.some((entry) => !entry.isIntersecting)) latest.current.onDismiss?.();
        });
        observer?.observe(anchor);
        return () => {
            win.removeEventListener('resize', update);
            win.removeEventListener('scroll', update, true);
            doc.removeEventListener('pointerdown', outside, true);
            doc.removeEventListener('focusin', outside, true);
            observer?.disconnect();
        };
    }, [anchor, popup, dismissible]);

    // Without a document (tests), render in place.
    const host = anchor?.ownerDocument?.body;
    return { style, portal: (node) => (host ? createPortal(node, host) : node) };
}
