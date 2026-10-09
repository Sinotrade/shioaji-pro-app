// 「背景持續執行（實驗）」 setting (#201 ①-3): off by default, plain words,
// changes go to the App (which stores them).

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    health: null as null | { enabled: boolean; state: string; env: string | null; lastError: string | null },
    saved: null as boolean | null,
    set: vi.fn(async () => undefined),
}));

vi.mock('../lib/execution/background', () => ({
    useBackgroundHealth: () => m.health,
    useBackgroundSetting: () => m.saved,
    useBackgroundPrograms: () => [],
    refreshBackground: async () => undefined,
    setBackgroundEnabled: m.set,
}));

const { BackgroundExecutionSetting } = await import('./background-execution-setting');

function render(): ReactTestRenderer {
    let r!: ReactTestRenderer;
    act(() => { r = create(createElement(BackgroundExecutionSetting)); });
    return r;
}
const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());
const toggle = (r: ReactTestRenderer) => r.root.findByProps({ 'aria-label': '背景持續執行（實驗）' });

it('is off until the App says on, and says so without jargon', () => {
    m.health = null;
    m.saved = false;
    const r = render();
    expect(toggle(r).props['aria-pressed']).toBe(false);
    expect(toggle(r).props.disabled).toBe(true); // no status: cannot change it
    expect(text(r)).toContain('預設關閉');
    expect(text(r)).not.toContain('原生');
});

it('can be turned off even when the engine is not running', async () => {
    m.health = null;
    m.saved = true;
    const r = render();
    expect(toggle(r).props.disabled).toBe(false);
    expect(text(r)).toContain('背景執行目前無法使用');
    await act(async () => { toggle(r).props.onClick(); });
    expect(m.set).toHaveBeenLastCalledWith(false);
});

it('turning it on asks the App', async () => {
    m.health = { enabled: false, state: 'idle', env: null, lastError: null };
    m.saved = false;
    const r = render();
    await act(async () => { toggle(r).props.onClick(); });
    expect(m.set).toHaveBeenCalledWith(true);
});
