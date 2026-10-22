// src/hooks/use-box-size.ts — 量測元素尺寸（ResizeObserver）
//
// callback ref：條件渲染的量測目標（下鑽磚牆）晚於元件 mount 才出現，
// useRef+空依賴 effect 會掛不到 observer — 以元素 state 驅動重掛。
// 尺寸變動時回報 resizing（約 250ms），tile transition 跟著縮短。
import { useEffect, useState } from 'react';

export function useBoxSize<T extends HTMLElement>() {
    const [element, setElement] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [resizing, setResizing] = useState(false);
    useEffect(() => {
        if (!element || typeof ResizeObserver === 'undefined') return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let first = true;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            const next = { width: Math.floor(width), height: Math.floor(height) };
            setSize((current) =>
                current.width === next.width && current.height === next.height
                    ? current
                    : next,
            );
            if (first) {
                first = false;
                return;
            }
            setResizing(true);
            clearTimeout(timer);
            timer = setTimeout(() => setResizing(false), 250);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [element]);
    return { ref: setElement, size, resizing };
}
