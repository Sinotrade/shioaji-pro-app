// issue #139 — web build: flash popouts of the same code open as separate
// browser windows (named by their window id) and carry no account id
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: false }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
import { openPopout } from './tauri';

const open = vi.fn();
beforeEach(() => { open.mockReset(); vi.stubGlobal('window', { open, location: { pathname: '/' } }); });
afterEach(() => vi.unstubAllGlobals());

it('names each flash popout window by its window id', async () => {
    await openPopout('flash', 'TMF', { win: 'w1' });
    await openPopout('flash', 'TMF', { win: 'w2' });
    const [first, second] = open.mock.calls;
    expect(first![1]).not.toBe(second![1]);
    expect(first![1]).toBe('sj-popout-flash-TMF-w1');
    expect(first![0]).toBe('/?popout=flash&code=TMF&win=w1');
});

it('keeps the existing single-window naming for other popouts', async () => {
    await openPopout('chart', 'TMF');
    expect(open.mock.calls[0]![1]).toBe('sj-popout-chart-TMF');
});
