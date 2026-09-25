import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    getByLabel: vi.fn(),
    created: [] as string[],
    show: vi.fn(),
    focus: vi.fn(),
}));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: true }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        constructor(label: string) { m.created.push(label); }
        static getByLabel = m.getByLabel;
    },
}));

import { openPopout } from './tauri';

beforeEach(() => {
    m.getByLabel.mockReset().mockResolvedValue(null);
    m.created.length = 0;
    m.show.mockReset();
    m.focus.mockReset();
});

it('focuses the one stable native flash window when its source is opened again', async () => {
    await openPopout('flash', 'TMF', { win: 'stable' });
    expect(m.created).toEqual(['popout-flash-stable']);

    m.getByLabel.mockResolvedValue({ show: m.show.mockResolvedValue(undefined), setFocus: m.focus.mockResolvedValue(undefined) });
    await openPopout('flash', 'TMF', { win: 'stable' });
    expect(m.created).toEqual(['popout-flash-stable']);
    expect(m.show).toHaveBeenCalledOnce();
    expect(m.focus).toHaveBeenCalledOnce();

    m.getByLabel.mockResolvedValue(null);
    await openPopout('flash', 'TMF', { win: 'other-panel' });
    expect(m.created).toEqual(['popout-flash-stable', 'popout-flash-other-panel']);
});
