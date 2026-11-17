// src/lib/chart-fill-prefs.test.ts — K 線成交標記的形狀、標籤、顏色（含自選買賣色）與帳戶範圍偏好（全域、跨視窗同步）
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const STYLE = 'sj-pro-chart-fill-style';
const SHAPE = 'sj-pro-chart-fill-shape';
const SCOPE = 'sj-pro-chart-fill-scope';
const BUY = 'sj-pro-chart-fill-buy';
const SELL = 'sj-pro-chart-fill-sell';
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

// 形狀與自選買賣色只匯出 hook：掛一個只讀 hook 的元件，回傳每次畫出來的值（最後一個是現值，長度看得出有沒有被通知）
const mounted: ReturnType<typeof create>[] = [];
function watch<T>(hook: () => T): T[] {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const seen: T[] = [];
    act(() => { mounted.push(create(createElement(() => { seen.push(hook()); return null; }))); });
    return seen;
}

afterEach(() => {
    act(() => mounted.splice(0).forEach((r) => r.unmount()));
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
    it('形狀：預設三角形；讀回已存的值，不合法值與讀取失敗退回三角形；切換即時生效並寫回 localStorage', async () => {
        const fresh = (await loadWith()).mod;
        expect(fresh.CHART_FILL_SHAPES).toEqual(['triangle', 'arrow', 'circle', 'diamond']);
        expect(watch(fresh.useChartFillShape)).toEqual(['triangle']);
        for (const saved of ['arrow', 'circle', 'diamond']) expect(watch((await loadWith({ [SHAPE]: saved })).mod.useChartFillShape)).toEqual([saved]);
        expect(watch((await loadWith({ [SHAPE]: 'star' })).mod.useChartFillShape)).toEqual(['triangle']);
        expect(watch((await loadWith({ [SHAPE]: 'arrow' }, true)).mod.useChartFillShape)).toEqual(['triangle']);
        const { mod, store } = await loadWith();
        const [shape, style] = [watch(mod.useChartFillShape), watch(mod.useChartFillStyle)];
        act(() => mod.setChartFillShape('diamond'));
        expect([shape, store.get(SHAPE)]).toEqual([['triangle', 'diamond'], 'diamond']);
        expect([style, store.has(STYLE)]).toEqual([['price'], false]); // 形狀和標籤是兩個偏好
    });
    it('自選買賣色：讀回合法色碼（#rrggbb，大小寫都收）；不合法值與讀取失敗退回空字串（＝預設色）', async () => {
        const saved = (await loadWith({ [BUY]: '#26a69a', [SELL]: '#FF7043' })).mod;
        expect([watch(saved.useChartFillBuy), watch(saved.useChartFillSell)]).toEqual([['#26a69a'], ['#FF7043']]);
        for (const bad of ['red', '#abc', '#12345', '#1234567', '#gggggg', 'rgb(1,2,3)', ' #26a69a']) {
            const mod = (await loadWith({ [BUY]: bad, [SELL]: bad })).mod;
            expect([bad, watch(mod.useChartFillBuy), watch(mod.useChartFillSell)]).toEqual([bad, [''], ['']]);
        }
        const broken = (await loadWith({ [BUY]: '#26a69a', [SELL]: '#ff7043' }, true)).mod;
        expect([watch(broken.useChartFillBuy), watch(broken.useChartFillSell)]).toEqual([[''], ['']]);
    });
    it('自選買賣色：寫入即時生效並寫回 localStorage，買賣各自獨立；設成空字串回到預設色，重新載入也是', async () => {
        const { mod, store } = await loadWith();
        const [buy, sell] = [watch(mod.useChartFillBuy), watch(mod.useChartFillSell)];
        expect([buy, sell]).toEqual([[''], ['']]);
        act(() => mod.setChartFillBuy('#26a69a'));
        expect([buy, sell, store.get(BUY), store.has(SELL)]).toEqual([['', '#26a69a'], [''], '#26a69a', false]);
        act(() => mod.setChartFillSell('#ff7043'));
        expect([sell, store.get(SELL)]).toEqual([['', '#ff7043'], '#ff7043']);
        act(() => mod.setChartFillBuy(''));
        expect([buy, store.get(BUY), sell]).toEqual([['', '#26a69a', ''], '', ['', '#ff7043']]);
        const candle = { up: '#f23645', down: '#16b389' };
        expect(mod.chartFillColors('dark', candle, 'distinct', { buy: buy.at(-1), sell: sell.at(-1) })).toEqual({ buy: '#38bdf8', sell: '#ff7043' });
        const again = (await loadWith(Object.fromEntries(store))).mod;
        expect([watch(again.useChartFillBuy), watch(again.useChartFillSell)]).toEqual([[''], ['#ff7043']]);
    });
    it('形狀與自選買賣色也跟其他視窗同步（storage 事件）：無關的 key 不觸發，別的視窗寫了不合法的值就退回預設，清空全部時重讀', async () => {
        const { mod, store } = await loadWith();
        const [shape, buy, sell] = [watch(mod.useChartFillShape), watch(mod.useChartFillBuy), watch(mod.useChartFillSell)];
        store.set(SHAPE, 'circle');
        store.set(BUY, '#26a69a');
        act(() => storage(SHAPE));
        expect([shape, buy, sell]).toEqual([['triangle', 'circle'], [''], ['']]); // 買色的 key 還沒通知
        act(() => storage(BUY));
        expect([buy, sell]).toEqual([['', '#26a69a'], ['']]);
        store.set(SELL, '#ff7043');
        act(() => storage('other'));
        expect(sell).toEqual(['']);
        act(() => storage(SELL));
        expect(sell).toEqual(['', '#ff7043']);
        store.set(SHAPE, 'star');
        store.set(BUY, 'red');
        act(() => { storage(SHAPE); storage(BUY); });
        expect([shape, buy]).toEqual([['triangle', 'circle', 'triangle'], ['', '#26a69a', '']]);
        store.clear();
        act(() => storage(null));
        expect([shape, buy, sell]).toEqual([['triangle', 'circle', 'triangle'], ['', '#26a69a', ''], ['', '#ff7043', '']]); // 沒變的不通知
    });
    it('自選色：只選一邊時另一邊用依主題深淺的預設色；同 K 棒時不看自選色', async () => {
        const { mod } = await loadWith();
        const candle = { up: '#f23645', down: '#16b389' };
        const custom = { buy: '#26a69a', sell: '#ff7043' };
        expect(mod.chartFillColors('dark', candle, 'distinct')).toEqual({ buy: '#38bdf8', sell: '#fb923c' });
        expect(mod.chartFillColors('light', candle, 'distinct', { buy: '', sell: '' })).toEqual({ buy: '#0369a1', sell: '#8a5a00' });
        expect(mod.chartFillColors('dark', candle, 'distinct', { buy: custom.buy })).toEqual({ buy: custom.buy, sell: '#fb923c' });
        expect(mod.chartFillColors('light', candle, 'distinct', { buy: custom.buy, sell: '' })).toEqual({ buy: custom.buy, sell: '#8a5a00' });
        expect(mod.chartFillColors('dark', candle, 'distinct', { sell: custom.sell })).toEqual({ buy: '#38bdf8', sell: custom.sell });
        expect(mod.chartFillColors('light', candle, 'distinct', { buy: '', sell: custom.sell })).toEqual({ buy: '#0369a1', sell: custom.sell });
        for (const base of ['dark', 'light'] as const) {
            expect(mod.chartFillColors(base, candle, 'distinct', custom)).toEqual(custom);
            expect(mod.chartFillColors(base, candle, 'candle', custom)).toEqual({ buy: candle.up, sell: candle.down });
        }
    });
    it('深淺色組看標籤底色亮度：淺底用深一階；淺色的賣色離台股漲紅夠遠', async () => {
        const { mod } = await loadWith();
        expect([mod.isLightColor('#f7f8fa'), mod.isLightColor('#10131a'), mod.isLightColor('rgba(0,0,0,1)')]).toEqual([true, false, null]);
        const light = mod.chartFillColors('light', { up: '#d6213a', down: '#0a8a66' }, 'distinct');
        expect(light).toEqual({ buy: '#0369a1', sell: '#8a5a00' });
    });
});
