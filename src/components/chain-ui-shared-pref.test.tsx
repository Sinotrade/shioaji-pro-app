// useSharedPref: a panel's own setting wins; clearing it re-reads the shared
// (last-choice) preference during render, so no committed render shows the
// value read at mount.
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useSharedPref } from './chain-ui';

type View = 'rank' | 'rotation' | 'heat';

describe('useSharedPref', () => {
    it('re-reads the shared choice when the panel setting is cleared', () => {
        let shared: View = 'rank';
        const committed: (View | undefined)[] = [];
        function Probe({ panel }: { panel?: View }) {
            const [saved] = useSharedPref<View>(panel, () => shared);
            const value = panel ?? saved;
            // layout effects run only for committed renders, before any later effect
            useLayoutEffect(() => {
                committed.push(value);
            });
            return null;
        }
        let r!: ReactTestRenderer;
        act(() => {
            r = create(createElement(Probe, { panel: 'heat' }));
        });
        expect(committed.at(-1)).toBe('heat');
        // another panel changes the shared choice while this one has its own
        shared = 'rotation';
        committed.length = 0;
        act(() => {
            r.update(createElement(Probe, {}));
        });
        // the stale mount-time 'rank' never reaches a render's output
        expect(committed).not.toContain('rank');
        expect(committed.at(-1)).toBe('rotation');
        act(() => r.unmount());
    });

    it('keeps the local choice while the panel setting stays unset', () => {
        let setLocal!: (v: View) => void;
        let value: View | undefined;
        function Probe() {
            const [saved, set] = useSharedPref<View>(undefined, () => 'rank');
            setLocal = set;
            value = saved;
            return null;
        }
        let r!: ReactTestRenderer;
        act(() => {
            r = create(createElement(Probe));
        });
        act(() => setLocal('heat'));
        act(() => r.update(createElement(Probe)));
        expect(value).toBe('heat');
        act(() => r.unmount());
    });
});
