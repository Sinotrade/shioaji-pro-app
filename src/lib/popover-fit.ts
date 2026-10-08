// src/lib/popover-fit.ts — 掛在按鈕下方的彈出面板留在可見範圍內
// （面板邊界與視窗的交集）：從按鈕左緣往右長放不下就往左收；可見範圍比
// 彈出層還窄就縮寬；下方不夠高就限高（彈出層內捲動）。

export interface FitRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface PopoverFit {
    /** 相對按鈕左緣的位移（px） */
    left: number;
    maxWidth?: number;
    maxHeight?: number;
}

const MARGIN = 6;
const GAP = 4;
const MIN_HEIGHT = 120;

export function fitPopover(
    anchor: { left: number; bottom: number },
    pop: { width: number; height: number },
    clip: FitRect,
): PopoverFit {
    const availW = Math.max(0, clip.right - clip.left - MARGIN * 2);
    const width = Math.min(pop.width, availW);
    let x = anchor.left;
    if (x + width > clip.right - MARGIN) x = clip.right - MARGIN - width;
    if (x < clip.left + MARGIN) x = clip.left + MARGIN;
    const out: PopoverFit = { left: x - anchor.left };
    if (width < pop.width) out.maxWidth = width;
    const availH = clip.bottom - MARGIN - (anchor.bottom + GAP);
    if (pop.height > availH) out.maxHeight = Math.max(MIN_HEIGHT, availH);
    return out;
}

/** 最近一層會裁切內容的祖先（overflow 不是 visible）與視窗的交集 */
export function visibleClipRect(el: Element): FitRect {
    const win = el.ownerDocument.defaultView!;
    let r: FitRect = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
    for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = win.getComputedStyle(p);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
            const b = p.getBoundingClientRect();
            r = {
                left: Math.max(r.left, b.left),
                top: Math.max(r.top, b.top),
                right: Math.min(r.right, b.right),
                bottom: Math.min(r.bottom, b.bottom),
            };
        }
    }
    return r;
}
