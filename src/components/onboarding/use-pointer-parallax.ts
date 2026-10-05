import { useEffect, type RefObject } from 'react';

const EASE = 0.12;

// writes --login-px/--login-py (-1..1, eased) on the element; layers read them via calc()
export function usePointerParallax(ref: RefObject<HTMLElement | null>, enabled = true) {
    useEffect(() => {
        const el = ref.current;
        if (!enabled || !el || typeof document === 'undefined' || typeof window.matchMedia !== 'function') return;
        const still = window.matchMedia('(prefers-reduced-motion: reduce), (pointer: coarse)');
        let x = 0, y = 0, tx = 0, ty = 0, frame = 0;
        const paused = () => still.matches || window.innerWidth < 720 || document.hidden
            || !!document.activeElement?.matches('input, textarea, select');
        const write = () => {
            el.style.setProperty('--login-px', x.toFixed(3));
            el.style.setProperty('--login-py', y.toFixed(3));
        };
        const tick = () => {
            frame = 0;
            const [gx, gy] = paused() ? [0, 0] : [tx, ty];
            x += (gx - x) * EASE;
            y += (gy - y) * EASE;
            const settled = Math.abs(gx - x) < 0.001 && Math.abs(gy - y) < 0.001;
            if (settled || still.matches) [x, y] = [gx, gy];
            write();
            if (!settled && !still.matches) frame = requestAnimationFrame(tick);
        };
        const kick = () => { if (!frame) frame = requestAnimationFrame(tick); };
        const onMove = (e: PointerEvent) => {
            tx = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1));
            ty = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1));
            kick();
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('focusin', kick);
        document.addEventListener('visibilitychange', kick);
        return () => {
            window.removeEventListener('pointermove', onMove);
            document.removeEventListener('focusin', kick);
            document.removeEventListener('visibilitychange', kick);
            cancelAnimationFrame(frame);
        };
    }, [ref, enabled]);
}
