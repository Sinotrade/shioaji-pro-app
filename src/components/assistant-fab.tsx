// src/components/assistant-fab.tsx — 首次設定的 AI 助理：圓形浮鈕，按下展開面板。
//
// 面板一直掛著（只用 hidden 收起），收合再打開時對話不會消失。
// 位置：
// - 一般：浮鈕在視窗右下角，面板從浮鈕上方展開。
// - docked（申請視窗蓋住主視窗右側）：右側看不到，浮鈕停在導覽卡內容區右下，
//   面板蓋住導覽卡下半部（上方仍看得到步驟標題與進度）。

import { Bot, ChevronDown, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import * as a from './assistant-fab.css';
import { tokens } from './apply-guide.css';

const GAP = 16;

function useRect(ref: RefObject<HTMLElement | null> | undefined, active: boolean) {
    const [rect, setRect] = useState<DOMRect | null>(null);
    // 導覽換步驟時內容區可能換成另一個元素（ref 物件不變）：每次 render 後對一次，
    // 換了就重新量、重新觀察，不要一直量已經拿掉的舊元素
    const [el, setEl] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
        const current = ref?.current ?? null;
        if (current !== el) setEl(current);
    });
    useLayoutEffect(() => {
        if (!active || !el) { setRect(null); return; }
        const update = () => setRect(el.getBoundingClientRect());
        update();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined;
        observer?.observe(el);
        window.addEventListener('resize', update);
        return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
    }, [el, active]);
    return rect;
}

export function AssistantFab({ open, onOpenChange, docked, anchorRef, showHint, onDismissHint, children }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    docked: boolean;
    /** docked 時對齊的區塊（導覽卡內容區）。 */
    anchorRef?: RefObject<HTMLElement | null>;
    /** 浮鈕旁的「有問題？問 AI 助理」提示。 */
    showHint?: boolean;
    onDismissHint?: () => void;
    children: ReactNode;
}) {
    const fabRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const rect = useRect(anchorRef, docked);
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { onOpenChange(false); fabRef.current?.focus(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onOpenChange]);
    useEffect(() => { if (open) panelRef.current?.focus(); }, [open]);

    let fabStyle: CSSProperties = { right: 24, bottom: 24 };
    let panelStyle: CSSProperties = {
        right: 24, bottom: 24 + a.FAB_SIZE + 12,
        width: 'min(26rem, calc(100vw - 48px))', height: `min(40rem, calc(100vh - ${24 + a.FAB_SIZE + 12 + 24}px))`,
    };
    if (docked && rect) {
        fabStyle = { left: rect.right - a.FAB_SIZE - GAP, top: rect.bottom - a.FAB_SIZE - GAP };
        const top = Math.max(rect.top + 8, rect.bottom - Math.max(rect.height * 0.72, 320));
        panelStyle = { left: rect.left + 8, width: rect.width - 16, top, height: rect.bottom - a.FAB_SIZE - GAP - 12 - top };
    }
    const hintStyle: CSSProperties = docked && rect
        ? { right: window.innerWidth - (rect.right - a.FAB_SIZE - GAP - 10), top: rect.bottom - a.FAB_SIZE - GAP + 8 }
        : { right: 24 + a.FAB_SIZE + 12, bottom: 24 + 8 };

    return <div className={`${tokens} ${a.root}`}>
        <div ref={panelRef} className={a.panel} style={panelStyle} hidden={!open}
            role="dialog" aria-label="AI 助理" tabIndex={-1}>
            <div className={a.panelHeader}>
                <span className={a.panelIcon}><Bot size={20} aria-hidden /></span>
                <p className={a.panelTitle}>AI 助理</p>
                <button className={a.panelClose} onClick={() => { onOpenChange(false); fabRef.current?.focus(); }}>
                    <ChevronDown size={18} aria-hidden />收合
                </button>
            </div>
            <div className={a.panelBody}>{children}</div>
        </div>
        {showHint && !open && <div className={a.hint} style={hintStyle}>
            <button className={a.hintOpen} onClick={() => onOpenChange(true)}>有問題？問 AI 助理</button>
            <button className={a.hintClose} aria-label="不再顯示提示" onClick={onDismissHint}><X size={18} aria-hidden /></button>
        </div>}
        <button ref={fabRef} className={a.fab} style={fabStyle} aria-expanded={open}
            aria-label={open ? '收合 AI 助理' : '打開 AI 助理'} title={open ? '收合 AI 助理' : 'AI 助理'}
            onClick={() => onOpenChange(!open)}>
            {open ? <X size={26} aria-hidden /> : <Bot size={28} aria-hidden />}
        </button>
    </div>;
}
