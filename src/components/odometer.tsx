// src/components/odometer.tsx — a number whose digits roll like a counter.
//
// Each digit is a reel of 0–9 moved with a CSS transform (an overshooting
// curve gives the settle), staggered right to left. While a reel travels it
// gets a vertical-only blur scaled by how far it moves. Characters are keyed
// from the right so units stay put when the number gains a digit. The first
// render rolls up from zero. Under prefers-reduced-motion the text just
// changes. Screen readers get the plain text; the reels are hidden from them.

import { useEffect, useRef, useState } from 'react';
import * as s from './odometer.css';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const STAGGER_MS = 40;
const BLUR_MS = 460;
/** Vertical blur levels (stdDeviation y); reels pick one by distance. */
const BLUR_LEVELS = [0.2, 0.4, 0.7];
const FILTER_PREFIX = 'sj-odometer-blur-';

let defsReady = false;
function ensureBlurDefs() {
    if (defsReady || typeof document === 'undefined') return;
    defsReady = true;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    const defs = document.createElementNS(ns, 'defs');
    BLUR_LEVELS.forEach((y, i) => {
        const filter = document.createElementNS(ns, 'filter');
        filter.setAttribute('id', `${FILTER_PREFIX}${i}`);
        filter.setAttribute('x', '-10%');
        filter.setAttribute('y', '-50%');
        filter.setAttribute('width', '120%');
        filter.setAttribute('height', '200%');
        const blur = document.createElementNS(ns, 'feGaussianBlur');
        blur.setAttribute('stdDeviation', `0 ${y}`);
        filter.appendChild(blur);
        defs.appendChild(filter);
    });
    svg.appendChild(defs);
    document.body.appendChild(svg);
}

/** Blur level for a reel that moves `distance` digits, or null for none. */
export function blurLevel(distance: number): number | null {
    const d = Math.abs(distance);
    if (d === 0) return null;
    return d <= 2 ? 0 : d <= 5 ? 1 : 2;
}

export function Odometer({ text, reducedMotion, className }: { text: string; reducedMotion: boolean; className?: string }) {
    const chars = [...text];
    // roll up from zero on the first paint
    const [ready, setReady] = useState(reducedMotion);
    useEffect(() => {
        if (ready) return;
        if (typeof requestAnimationFrame !== 'function') {
            setReady(true);
            return;
        }
        let raf = requestAnimationFrame(() => {
            raf = requestAnimationFrame(() => setReady(true));
        });
        return () => cancelAnimationFrame(raf);
    }, [ready]);

    // per-position blur while reels travel
    const prev = useRef<string[]>([]);
    const [blur, setBlur] = useState<Map<number, number>>(new Map());
    useEffect(() => {
        const now = [...text].reverse();
        const before = prev.current.length > 0 ? prev.current : now.map((c) => (DIGITS.includes(c) ? '0' : c));
        prev.current = now;
        if (reducedMotion) return;
        ensureBlurDefs();
        const next = new Map<number, number>();
        now.forEach((c, pos) => {
            if (!DIGITS.includes(c)) return;
            const b = before[pos];
            const level = blurLevel(Number(c) - (b && DIGITS.includes(b) ? Number(b) : 0));
            if (level !== null) next.set(pos, level);
        });
        if (next.size > 0) setBlur(next);
    }, [text, reducedMotion]);
    // the clear is keyed to the blur itself, so nothing (a quick second
    // change, a remount) can cancel it and leave a reel smeared
    useEffect(() => {
        if (blur.size === 0) return;
        const timer = setTimeout(() => setBlur(new Map()), BLUR_MS + blur.size * STAGGER_MS);
        return () => clearTimeout(timer);
    }, [blur]);

    const count = chars.length;
    return (
        <span className={`${s.root} ${className ?? ''}`}>
            <span className={s.srOnly}>{text}</span>
            {chars.map((c, i) => {
                const pos = count - 1 - i;
                if (!DIGITS.includes(c)) {
                    return (
                        <span key={`g${pos}`} className={s.glyph} aria-hidden='true'>
                            {/* a bare space would collapse inside the flex row */}
                            {c === ' ' ? '\u00a0' : c}
                        </span>
                    );
                }
                const d = ready ? Number(c) : 0;
                const level = blur.get(pos);
                return (
                    <span key={`d${pos}`} className={s.digit} aria-hidden='true'>
                        <span
                            className={`${s.reel} ${reducedMotion ? s.still : ''}`}
                            style={{
                                transform: `translateY(${-d * 10}%)`,
                                transitionDelay: reducedMotion ? undefined : `${pos * STAGGER_MS}ms`,
                                filter: level !== undefined && !reducedMotion ? `url(#${FILTER_PREFIX}${level})` : undefined,
                            }}
                        >
                            {DIGITS.map((n) => (
                                <span key={n} className={s.cell}>
                                    {n}
                                </span>
                            ))}
                        </span>
                    </span>
                );
            })}
        </span>
    );
}
