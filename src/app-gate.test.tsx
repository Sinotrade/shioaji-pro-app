import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    load: vi.fn(),
    focus: vi.fn(async () => undefined),
    search: '',
    label: null as string | null,
}));

vi.mock('./App', () => ({ default: () => 'APP' }));
vi.mock('./components/onboarding-setup', () => ({ OnboardingSetup: () => 'ONBOARDING' }));
vi.mock('./lib/tauri', () => ({ isTauri: true, loadDesktopSettings: mocks.load }));
vi.mock('./lib/window-role', async (importOriginal) => {
    const real = await importOriginal<typeof import('./lib/window-role')>();
    return {
        ...real,
        isChildWindow: () => real.isChildWindow(mocks.search, mocks.label),
        focusMainWindow: mocks.focus,
    };
});

import { AppGate } from './app-gate';
import { cacheDesktopConfigured } from './lib/desktop-setup-state';

class MemoryStorage {
    private data = new Map<string, string>();
    getItem(key: string) { return this.data.get(key) ?? null; }
    setItem(key: string, value: string) { this.data.set(key, value); }
    removeItem(key: string) { this.data.delete(key); }
}

let view: ReactTestRenderer | undefined;
const text = () => JSON.stringify(view?.toJSON() ?? null);

async function mount() {
    await act(async () => { view = create(createElement(AppGate)); });
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new MemoryStorage());
    const target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { location: { search: '' } }));
    mocks.search = '';
    mocks.label = null;
    mocks.load.mockReset();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('child windows never read settings.json', () => {
    it.each([
        ['?popout=chart&code=2330', null],
        ['?popout=traypanel', 'tray'],
        ['?popout=flash&code=TXFR1', 'popout-flashtile-3'],
        ['', 'popout-chart-9'], // native child window without the query
    ])('%s (%s) renders the app from the non-secret flag', async (search, label) => {
        mocks.search = search;
        mocks.label = label;
        cacheDesktopConfigured(true);
        await mount();
        expect(text()).toContain('APP');
        expect(mocks.load).not.toHaveBeenCalled();
    });

    it('shows the main-window setup notice until the main window finishes setup', async () => {
        mocks.search = '?popout=traypanel';
        mocks.label = 'tray';
        await mount();
        expect(text()).toContain('請在主視窗完成設定');
        expect(text()).not.toContain('APP');
        expect(mocks.load).not.toHaveBeenCalled();

        await act(async () => view!.root.findByType('button').props.onClick());
        expect(mocks.focus).toHaveBeenCalledTimes(1);

        // the main window saves keys → only the boolean is published
        await act(async () => { cacheDesktopConfigured(true); });
        expect(text()).toContain('APP');
        expect(localStorage.getItem('sj-desktop-configured')).toBe('true');
    });

    it('treats a published "not configured" flag as setup pending', async () => {
        mocks.search = '?popout=chart';
        cacheDesktopConfigured(false);
        await mount();
        expect(text()).toContain('請在主視窗完成設定');
        expect(mocks.load).not.toHaveBeenCalled();
    });
});

describe('main window still loads settings', () => {
    it('opens the dashboard when keys exist', async () => {
        mocks.label = 'main';
        mocks.load.mockResolvedValue({ apiKey: 'k', secretKey: 's' });
        await mount();
        expect(mocks.load).toHaveBeenCalledTimes(1);
        expect(text()).toContain('APP');
    });

    it('opens first-run setup when keys are missing', async () => {
        mocks.label = 'main';
        mocks.load.mockResolvedValue({ apiKey: '', secretKey: '' });
        await mount();
        expect(mocks.load).toHaveBeenCalledTimes(1);
        expect(text()).toContain('ONBOARDING');
    });
});
