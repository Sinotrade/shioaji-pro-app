import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { blurLevel, Odometer } from './odometer';

function reels(r: ReactTestRenderer) {
    return r.root.findAll((n) => typeof n.type === 'string' && typeof n.props.style?.transform === 'string');
}

it('keeps the plain text for screen readers and rolls each digit to its value', () => {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(Odometer, { text: '+1,706 億', reducedMotion: true }));
    });
    const text = r.root.findAll((n) => n.type === 'span' && n.children.length === 1 && n.children[0] === '+1,706 億');
    expect(text).toHaveLength(1);
    expect(reels(r).map((n) => n.props.style.transform)).toEqual(['translateY(-10%)', 'translateY(-70%)', 'translateY(0%)', 'translateY(-60%)']);
    // no stagger or blur under reduced motion
    expect(reels(r).every((n) => n.props.style.transitionDelay === undefined && n.props.style.filter === undefined)).toBe(true);
});

it('keys digits from the right so units stay put when the number grows', () => {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(Odometer, { text: '98', reducedMotion: true }));
    });
    act(() => {
        r.update(createElement(Odometer, { text: '102', reducedMotion: true }));
    });
    expect(reels(r)).toHaveLength(3);
    expect(reels(r).at(-1)!.props.style.transform).toBe('translateY(-20%)');
});

it('blurs further-travelling reels more', () => {
    expect(blurLevel(0)).toBeNull();
    expect(blurLevel(1)).toBe(0);
    expect(blurLevel(-4)).toBe(1);
    expect(blurLevel(9)).toBe(2);
});

it('clears the travel blur even when the value changes again mid-roll', () => {
    vi.useFakeTimers();
    try {
        let r!: ReactTestRenderer;
        act(() => {
            r = create(createElement(Odometer, { text: '10', reducedMotion: false }));
        });
        act(() => {
            r.update(createElement(Odometer, { text: '19', reducedMotion: false }));
        });
        expect(reels(r).some((n) => typeof n.props.style.filter === 'string')).toBe(true);
        // a second change that moves nothing must not cancel the clear
        act(() => {
            r.update(createElement(Odometer, { text: '19 ', reducedMotion: false }));
        });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(reels(r).every((n) => n.props.style.filter === undefined)).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});

it('clears the intro blur under StrictMode double effects', () => {
    vi.useFakeTimers();
    try {
        let r!: ReactTestRenderer;
        act(() => {
            r = create(createElement(StrictMode, null, createElement(Odometer, { text: '987', reducedMotion: false })));
        });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(reels(r).every((n) => n.props.style.filter === undefined)).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});
