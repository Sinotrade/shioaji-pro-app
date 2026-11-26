import { afterEach, describe, expect, it, vi } from 'vitest';

const rootStyle = { props: new Map<string, string>(), setProperty(k: string, v: string) { this.props.set(k, v); }, removeProperty(k: string) { this.props.delete(k); } } as { props: Map<string, string>; setProperty(k: string, v: string): void; removeProperty(k: string): void; [k: string]: unknown };

async function loadWith(saved: unknown) {
    rootStyle.props.clear();
    vi.resetModules();
    const store = new Map<string, string>();
    if (saved !== undefined) store.set('sj-pro-theme', JSON.stringify(saved));
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('document', { documentElement: { classList: { add() {}, remove() {} }, style: rootStyle } });
    vi.doMock('../theme.css', () => ({ themeClasses: {}, vars: { color: { accent: 'var(--accent)', up: 'var(--up)' } } }));
    const mod = await import('./theme-store');
    return mod;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../theme.css');
});

describe('theme settings migration', () => {
    it('defaults to dark with the standard (enlarged) font size', async () => {
        const m = await loadWith(undefined);
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'dark', convention: 'tw', fontScale: 1.15 });
    });

    it('follows the system appearance on first launch only', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: light)' }));
        const fresh = await loadWith(undefined);
        fresh.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!).mode).toBe('light');
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: light)' }));
        const saved = await loadWith({ mode: 'dark', convention: 'tw', fontScale: 1.15 });
        saved.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!).mode).toBe('dark');
    });

    it('maps the old 純黑 mode to dark and the removed 0.85 size to the smallest', async () => {
        const m = await loadWith({ mode: 'midnight', convention: 'intl', fontScale: 0.85 });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'dark', convention: 'intl', fontScale: 1 });
    });

    it('keeps an existing size and light mode as saved', async () => {
        const m = await loadWith({ mode: 'light', convention: 'tw', fontScale: 1.3 });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'light', convention: 'tw', fontScale: 1.3 });
    });

    it('overrides the color variables for a custom theme and clears them when switching back', async () => {
        const custom = { base: 'dark', background: '#0b1628', panel: '#132238', foreground: '#dfe7f5', accent: '#4da3ff', red: '#ff4d5e', green: '#22c997' };
        const m = await loadWith({ mode: 'custom', convention: 'intl', fontScale: 1.15, custom });
        m.initTheme();
        expect(rootStyle.props.get('--accent')).toBe('#4da3ff');
        expect(rootStyle.props.get('--up')).toBe('#22c997'); // 綠漲紅跌
        expect(m.getChartColors({ mode: 'custom', convention: 'tw', fontScale: 1.15, custom: custom as never }).up).toBe('#ff4d5e');
        m.setThemeSettings({ mode: 'dark' });
        expect(rootStyle.props.has('--accent')).toBe(false);
        // 切回深色仍保留自訂配色，之後可再切回
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!).custom).toEqual(custom);
    });

    it('falls back to dark when a saved custom theme is invalid', async () => {
        const m = await loadWith({ mode: 'custom', convention: 'tw', fontScale: 1.15, custom: { base: 'dark', background: 'red' } });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!).mode).toBe('dark');
    });
});
