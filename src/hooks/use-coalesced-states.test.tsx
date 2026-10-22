import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCoalescedStates } from './use-coalesced-states';

let seen: readonly string[] = [];
function Probe(props: { states: string[]; scope: string; paused?: boolean }) {
    seen = useCoalescedStates(props.states, props.scope, 250, props.paused ?? false);
    return null;
}
let view!: ReactTestRenderer;
const render = (states: string[], scope = 's', paused = false) =>
    act(() => {
        if (view) view.update(createElement(Probe, { states, scope, paused }));
        else view = create(createElement(Probe, { states, scope, paused }));
    });

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    view = undefined as unknown as ReactTestRenderer;
});
afterEach(() => {
    act(() => view?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('短時間內多包合併成一次更新', () => {
    render(['a0', 'b0']);
    render(['a1', 'b0']);
    render(['a1', 'b1']);
    expect(seen).toEqual(['a0', 'b0']);
    act(() => {
        vi.advanceTimersByTime(250);
    });
    expect(seen).toEqual(['a1', 'b1']);
});

it('計時器觸發後再來的新包仍會更新（不會卡住）', () => {
    render(['a0']);
    for (let i = 1; i <= 5; i++) {
        render([`a${i}`]);
        act(() => {
        vi.advanceTimersByTime(250);
    });
        expect(seen).toEqual([`a${i}`]);
    }
});

it('scope 改變時立即使用新狀態，不沿用舊快照', () => {
    render(['amount-a']);
    render(['contrib-a'], 'other');
    expect(seen).toEqual(['contrib-a']);
});

it('暫停時不更新，恢復後補上', () => {
    render(['a0']);
    render(['a1'], 's', true);
    act(() => {
        vi.advanceTimersByTime(1000);
    });
    expect(seen).toEqual(['a0']);
    render(['a1'], 's', false);
    act(() => {
        vi.advanceTimersByTime(250);
    });
    expect(seen).toEqual(['a1']);
});

it('計時器排程後才暫停：暫停期間不發布', () => {
    render(['a0']);
    render(['a1']);
    render(['a1'], 's', true);
    act(() => {
        vi.advanceTimersByTime(1000);
    });
    expect(seen).toEqual(['a0']);
    render(['a2'], 's', false);
    act(() => {
        vi.advanceTimersByTime(250);
    });
    expect(seen).toEqual(['a2']);
});

it('A → B → A 來回切換不會回到 A 的舊快照', () => {
    render(['a0'], 'A');
    render(['b0'], 'B');
    render(['a1'], 'A');
    expect(seen).toEqual(['a1']);
});
