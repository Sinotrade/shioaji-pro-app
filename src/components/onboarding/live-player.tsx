// src/components/onboarding/live-player.tsx — DEV 即時畫面：右下角的圓形按鈕（類似 Messenger），預設收合，想看的人才打開。
// 伺服器送 MJPEG（multipart/x-mixed-replace），<img> 原生就能播；只在展開時掛 <img>，收合就斷線、伺服器停止擷圖。
// 非 modal 的 disclosure：不搶焦點、不鎖焦點、點外面不會關（使用者要邊看邊在表單輸入），只有按鈕或 Esc 能收合。

import { MonitorPlay, MoveDiagonal2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ONBOARDING_API_BASE } from '../../lib/sinopac-onboarding/api';
import * as styles from './live-player.css';

const LIVE_URL = `${ONBOARDING_API_BASE}/live`;

// src 由 ref 接上、卸載前拿掉：只把 <img> 移出 DOM 不會中斷 multipart 請求（實測 Chrome），拿掉 src 才會。
// 不寫成 JSX 的 src：StrictMode 會先跑一次 cleanup 再重接，src 要跟著接回去。
function attachStream(img: HTMLImageElement | null) {
    if (!img) return;
    img.src = LIVE_URL;
    return () => img.removeAttribute('src');
}

export const LIVE_DEFAULT_WIDTH = 384;
const MIN_WIDTH = 240;
const LARGE_WIDTH = 768;
const KEY_STEP = 32;

/** 視窗放得下的寬度：左右各留 16px，高度扣掉按鈕與邊距後仍維持 16:10（live-player.css.ts 的 panel 用同一組上限）。 */
function clampWidth(width: number) {
    const max = Math.min(window.innerWidth - 32, (window.innerHeight - 140) * 1.6);
    return Math.round(Math.max(MIN_WIDTH, Math.min(width, max)));
}

/** 面板左上角的把手：拖曳自由調整；點一下在預設與大尺寸間切換（不必拖曳也能調整）；方向鍵微調。 */
function ResizeHandle({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
    const dragged = useRef(false);

    function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        // 只認第一根手指／主按鍵：第二個觸控點不會再掛一組監聽
        if (event.button !== 0 || !event.isPrimary) return;
        const handle = event.currentTarget;
        // 起點用和 CSS 同一組上限夾過的寬度（視窗縮小後 state 可能比實際寬度大）
        const start = { x: event.clientX, y: event.clientY, width: clampWidth(width) };
        // 超過門檻的那一刻鎖定軸向，之後只用該軸：對角線附近來回拖不會讓寬度瞬間跳動
        let axis: 'x' | 'y' | null = null;
        dragged.current = false;
        handle.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) => {
            if (e.pointerId !== event.pointerId) return;
            // 面板固定在右下角：往左、往上拉是放大；高度跟著 16:10，垂直位移換算成寬度
            const dx = start.x - e.clientX;
            const dy = (start.y - e.clientY) * 1.6;
            if (!axis) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) <= 3) return;
                axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                dragged.current = true;
            }
            onWidthChange(clampWidth(start.width + (axis === 'x' ? dx : dy)));
        };
        const end = (e: PointerEvent) => {
            if (e.pointerId !== event.pointerId) return;
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            handle.removeEventListener('pointercancel', end);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    return (
        <button
            type='button'
            className={styles.resize}
            aria-label='調整即時畫面大小'
            title='拖曳調整大小；點一下切換大小；方向鍵微調'
            onPointerDown={onPointerDown}
            onClick={() => {
                // 拖曳結束也會觸發 click：那次不算切換
                if (dragged.current) {
                    dragged.current = false;
                    return;
                }
                // 兩個目標和目前寬度都先夾進視窗：矮或窄的視窗上限低於預設的中點時，仍然能來回切換
                const small = clampWidth(LIVE_DEFAULT_WIDTH);
                const large = clampWidth(LARGE_WIDTH);
                onWidthChange(clampWidth(width) < (small + large) / 2 ? large : small);
            }}
            onKeyDown={(event) => {
                const step = { ArrowLeft: KEY_STEP, ArrowUp: KEY_STEP, ArrowRight: -KEY_STEP, ArrowDown: -KEY_STEP }[event.key];
                if (step === undefined) return;
                event.preventDefault();
                onWidthChange(clampWidth(clampWidth(width) + step));
            }}
        >
            <MoveDiagonal2 size={12} aria-hidden='true' />
        </button>
    );
}

export function LivePlayer({
    working,
    open,
    onOpenChange,
    width,
    onWidthChange,
}: {
    working: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    width: number;
    onWidthChange: (width: number) => void;
}) {
    const panelId = useId();
    const titleId = useId();
    // 串流斷掉（例如 Vite 重啟）時不顯示破圖；重新打開就重連
    const [broken, setBroken] = useState(false);
    const panelRef = useRef<HTMLElement>(null);
    const bubbleRef = useRef<HTMLButtonElement>(null);

    // window 層級：焦點停在被面板蓋住的地方時也能用鍵盤收合
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            // 注音等輸入法組字中按 Esc 是取消組字，不收合
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            // 焦點在面板內（調整大小的把手）時，面板一卸載焦點就掉到 body：先交還給圓鈕。焦點在別處（表單）維持不動
            if (panelRef.current?.contains(document.activeElement)) bubbleRef.current?.focus();
            onOpenChange(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onOpenChange]);

    return (
        // 按鈕在前、面板在後（launcher 用 column-reverse 把面板畫在上方）：報讀器按下按鈕後往下讀就是面板
        <div className={styles.launcher}>
            <button
                type='button'
                ref={bubbleRef}
                className={styles.bubble}
                aria-label='即時畫面'
                title='即時畫面'
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                onClick={() => {
                    setBroken(false);
                    onOpenChange(!open);
                }}
            >
                <span className={styles.icon}>
                    <MonitorPlay size={20} aria-hidden='true' />
                    {/* 有點 = 機器人正在操作；沒有點 = 等你輸入（不只靠顏色區分） */}
                    {working && <span className={styles.badge} aria-hidden='true' />}
                </span>
            </button>
            {open && (
                <section ref={panelRef} id={panelId} className={styles.panel} aria-labelledby={titleId} style={{ '--live-w': `${width}px` } as CSSProperties}>
                    <ResizeHandle width={width} onWidthChange={onWidthChange} />
                    <p className={styles.caption}>
                        <span id={titleId} className={styles.title}>
                            即時畫面
                        </span>
                        {working ? '本機瀏覽器正在操作永豐金證券官網' : '等待你在表單中輸入'}
                    </p>
                    <div className={styles.screen}>
                        {/* 墊在畫面底下：第一格畫出來就蓋掉它，不靠 MJPEG 的 load 事件（各瀏覽器不一定會發）。
                            串流正常時由 <img> 的 alt 代表內容，墊底文字不給報讀器唸；中斷時才播報 */}
                        {broken ? (
                            <p className={styles.placeholder} role='status'>
                                畫面中斷，收合後再打開即可重新連線
                            </p>
                        ) : (
                            <>
                                <p className={styles.placeholder} aria-hidden='true'>
                                    正在連線畫面…
                                </p>
                                <img ref={attachStream} className={styles.frame} alt='本機瀏覽器目前的畫面' onError={() => setBroken(true)} />
                            </>
                        )}
                    </div>
                </section>
            )}
        </div>
    );
}
