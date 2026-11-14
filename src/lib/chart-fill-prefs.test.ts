// src/lib/chart-fill-prefs.test.ts — K 線成交標記樣式與帳戶範圍偏好（全域、跨視窗同步）
import { afterEach, describe, expect, it, vi } from 'vitest';

const STYLE = 'sj-pro-chart-fill-style';
const SCOPE = 'sj-pro-chart-fill-scope';
// 每個偏好各掛一個 storage 監聽；storage() 模擬其他視窗改值
const storageListeners: ((e: { key: string | null }) => void)[] = [];
const storage = (key: string | null) => storageListeners.forEach((fn) => fn({ key }));

async function loadWith(saved: Record<string, string> = {}, broken = false) {
    vi.resetModules();
    const store = new Map(Object.entries(saved));
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => { if (broken) throw new Error('denied'); return store.get(k) ?? null; },
        setItem: (k: string, v: string) => { if (broken) throw new Error('denied'); store.set(k, v); },
    });
    vi.stubGlobal('window', {
        addEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
            if (type === 'storage') storageListeners.push(fn);
        },
    });
    const mod = await import('./chart-fill-prefs');
    return { mod, store };
}

afterEach(() => {
    vi.unstubAllGlobals();
    storageListeners.length = 0;
});

describe('chart fill prefs', () => {
    it('預設：價格、目前帳戶', async () => {
        const { mod } = await loadWith();
        expect(mod.getChartFillStyle()).toBe('price');
        expect(mod.getChartFillScope()).toBe('active');
    });

    it('讀回已存的值；不合法值與讀取失敗退回預設', async () => {
        expect((await loadWith({ [STYLE]: 'dot', [SCOPE]: 'all' })).mod.getChartFillStyle()).toBe('dot');
        expect((await loadWith({ [STYLE]: 'side' })).mod.getChartFillStyle()).toBe('side');
        expect((await loadWith({ [SCOPE]: 'all' })).mod.getChartFillScope()).toBe('all');
        const bad = (await loadWith({ [STYLE]: 'arrow', [SCOPE]: 'everyone' })).mod;
        expect([bad.getChartFillStyle(), bad.getChartFillScope()]).toEqual(['price', 'active']);
        const broken = (await loadWith({ [STYLE]: 'dot', [SCOPE]: 'all' }, true)).mod;
        expect([broken.getChartFillStyle(), broken.getChartFillScope()]).toEqual(['price', 'active']);
    });

    it('切換即時通知訂閱者並寫回 localStorage；兩個偏好各自獨立', async () => {
        const { mod, store } = await loadWith();
        const seen: string[] = [];
        mod.subscribeChartFillStyle(() => seen.push(`style:${mod.getChartFillStyle()}`));
        mod.subscribeChartFillScope(() => seen.push(`scope:${mod.getChartFillScope()}`));
        mod.setChartFillStyle('dot');
        mod.setChartFillScope('all');
        expect(seen).toEqual(['style:dot', 'scope:all']);
        expect(store.get(STYLE)).toBe('dot');
        expect(store.get(SCOPE)).toBe('all');
    });

    it('寫入失敗仍在這個工作階段生效', async () => {
        const { mod } = await loadWith({}, true);
        mod.setChartFillStyle('side');
        expect(mod.getChartFillStyle()).toBe('side');
    });

    it('其他視窗改設定（storage 事件）時同步；無關的 key 不觸發，清空全部（key 為 null）時重讀', async () => {
        const { mod, store } = await loadWith();
        const seen: string[] = [];
        mod.subscribeChartFillStyle(() => seen.push(`style:${mod.getChartFillStyle()}`));
        mod.subscribeChartFillScope(() => seen.push(`scope:${mod.getChartFillScope()}`));
        store.set(STYLE, 'side');
        storage(STYLE);
        expect(mod.getChartFillStyle()).toBe('side');
        store.set(SCOPE, 'all');
        storage('other');
        expect(seen).toEqual(['style:side']);
        store.clear();
        storage(null);
        expect(seen).toEqual(['style:side', 'style:price']); // 範圍一直是 active，沒變不通知
        expect(mod.getChartFillScope()).toBe('active');
    });
    it('顏色：預設藍買橘賣（和 K 棒的紅綠、十字線的藍都不同），可改成同 K 棒；不合法的值退回預設', async () => {
        const { mod, store } = await loadWith({ 'sj-pro-chart-fill-color': 'rainbow' });
        expect(mod.getChartFillColor()).toBe('distinct');
        const candle = { up: '#f23645', down: '#16b389' };
        for (const base of ['dark', 'light'] as const) {
            const c = mod.chartFillColors(base, candle, 'distinct');
            expect([c.buy, c.sell].some((x) => [candle.up, candle.down, '#3d8bff', '#2962ff'].includes(x))).toBe(false);
            expect(c.buy).not.toBe(c.sell);
        }
        expect(mod.chartFillColors('dark', candle, 'candle')).toEqual({ buy: candle.up, sell: candle.down });
        mod.setChartFillColor('candle');
        expect([mod.getChartFillColor(), store.get('sj-pro-chart-fill-color')]).toEqual(['candle', 'candle']);
    });
    it('深淺色組看標籤底色亮度：淺底用深一階；淺色的賣色離台股漲紅夠遠', async () => {
        const { mod } = await loadWith();
        expect([mod.isLightColor('#f7f8fa'), mod.isLightColor('#10131a'), mod.isLightColor('rgba(0,0,0,1)')]).toEqual([true, false, null]);
        const light = mod.chartFillColors('light', { up: '#d6213a', down: '#0a8a66' }, 'distinct');
        expect(light).toEqual({ buy: '#0369a1', sell: '#8a5a00' });
    });
});
