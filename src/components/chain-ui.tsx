// src/components/chain-ui.tsx — shared pieces of the 產業鏈資金流向 panel:
// preferences, direction tokens, canvas plumbing, visibility pause and
// reduced-motion detection.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SESSION_SLOTS, type GroupFlow } from '../lib/chain-flow';
import { feedPhase, type FeedPhase } from '../lib/chain-flow-feed';
import * as s from './chain-map.css';

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    try {
        const value = localStorage.getItem(key);
        return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
    } catch {
        return fallback;
    }
}

/**
 * The shared (last-choice) preference behind a panel's own setting. When the
 * panel setting is cleared, re-read the shared choice during render, so no
 * effect ever sees the value read at mount.
 */
export function useSharedPref<T extends string>(panelValue: T | undefined, read: () => T): [T, (value: T) => void] {
    const [saved, setSaved] = useState<T>(read);
    const [prevPanel, setPrevPanel] = useState(panelValue);
    if (prevPanel !== panelValue) {
        setPrevPanel(panelValue);
        if (panelValue === undefined) setSaved(read());
    }
    return [saved, setSaved];
}

export function writePref(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: preference lasts for this session only
    }
}

export function dir(value: number | null | undefined): 'up' | 'down' | 'flat' {
    return value === null || value === undefined || value === 0 ? 'flat' : value > 0 ? 'up' : 'down';
}

// resolve a vanilla-extract `var(--x)` reference to a concrete colour for canvas
export function cssColor(el: HTMLElement, ref: string): string {
    if (!ref.startsWith('var(')) return ref;
    return getComputedStyle(el).getPropertyValue(ref.slice(4, -1)).trim() || '#888';
}

export function useBoxSize<T extends HTMLElement>() {
    const [element, setElement] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        if (!element || typeof ResizeObserver === 'undefined') return;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            setSize({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);
    return { ref: setElement, element, size };
}

/** Paused while the document is hidden or the panel is scrolled out of view. */
export function usePaused(element: HTMLElement | null) {
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
    const [offscreen, setOffscreen] = useState(false);
    useEffect(() => {
        const onVisibility = () => setHidden(document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);
    useEffect(() => {
        if (!element || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (entry) setOffscreen(!entry.isIntersecting);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);
    return hidden || offscreen;
}

/** DPR-aware canvas that repaints when `deps` or its size change. */
export function useCanvas(
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number, el: HTMLCanvasElement) => void,
    deps: unknown[],
) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const [seq, setSeq] = useState(0);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => setSeq((n) => n + 1));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === 0 || h === 0) return;
        const dpr = window.devicePixelRatio || 1;
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (el.width !== pw) el.width = pw;
        if (el.height !== ph) el.height = ph;
        const ctx = el.getContext?.('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        draw(ctx, w, h, el);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, seq]);
    return ref;
}

export const slotX = (slot: number, w: number) => ((slot + 0.5) / SESSION_SLOTS) * w;

export function Segment<T extends string>({
    value,
    options,
    onChange,
    label,
}: {
    value: T;
    options: { value: T; label: string; title?: string }[];
    onChange: (value: T) => void;
    label: string;
}) {
    return (
        <span className={s.segmentGroup} role='group' aria-label={label}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type='button'
                    className={s.segment[option.value === value ? 'on' : 'off']}
                    aria-pressed={option.value === value}
                    title={option.title}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </span>
    );
}

/** True when the viewer asked the OS for reduced motion. */
export function useReducedMotion() {
    const query = '(prefers-reduced-motion: reduce)';
    const [reduced, setReduced] = useState(
        () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    );
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia(query);
        const update = () => setReduced(media.matches);
        media.addEventListener?.('change', update);
        return () => media.removeEventListener?.('change', update);
    }, []);
    return reduced;
}

/** One chain or theme with its aggregate flow. */
export interface FlowRow {
    theme: import('../lib/company-data/types').Theme;
    codes: string[];
    flow: GroupFlow;
}

/** Re-check interval of {@link useFeedPhase} (clock-driven changes: close, stall). */
const PHASE_CHECK_MS = 5_000;

/**
 * Live / closed state of the minute-bar feed, re-evaluated against the
 * Taipei clock while the panel is visible, so it flips at the close (or when
 * bars stop arriving) even though no new bar triggers a render.
 */
export function useFeedPhase(session: string | null, lastBarAt: number | null, lastSlot: number | null, paused: boolean): FeedPhase {
    const phase = feedPhase({ now: Date.now(), session, lastBarAt, lastSlot });
    // holds the last clock-checked phase: setting an unchanged value does not re-render
    const [, setChecked] = useState(phase);
    useEffect(() => {
        if (paused || phase === 'closed') return;
        const timer = setInterval(() => setChecked(feedPhase({ now: Date.now(), session, lastBarAt, lastSlot })), PHASE_CHECK_MS);
        return () => clearInterval(timer);
    }, [paused, phase, session, lastBarAt, lastSlot]);
    return phase;
}

/**
 * Seconds until the next minute bar closes, as a small ring. Re-renders only
 * itself, once a second, and only while `live`.
 */
export function NextBar({ live }: { live: boolean }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live]);
    if (!live) return null;
    const left = 60 - new Date(now).getSeconds();
    const r = 5;
    const c = 2 * Math.PI * r;
    return (
        <span className={s.nextBar} title='距離下一根 1 分 K 收盤'>
            <svg width={14} height={14} viewBox='0 0 14 14' aria-hidden='true'>
                <circle className={s.nextBarTrack} cx={7} cy={7} r={r} />
                <circle
                    className={s.nextBarArc}
                    cx={7}
                    cy={7}
                    r={r}
                    strokeDasharray={c}
                    strokeDashoffset={(c * left) / 60}
                    transform='rotate(-90 7 7)'
                />
            </svg>
            {left}s
        </span>
    );
}
