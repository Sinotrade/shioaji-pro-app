import { beforeEach, describe, expect, it, vi } from 'vitest';

// 這個模組在 import 時就會讀 localStorage，所以 stub 必須早於 import
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
});
vi.mock('./stream', () => ({ onAnyTick: vi.fn() }));
vi.mock('./trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn() }));
vi.mock('./contracts-cache', () => ({ ensureContract: vi.fn() }));

const {
    addTrigger,
    cancelProtectiveTriggers,
    getTriggers,
    removeTrigger,
    updateTriggerPrice,
    wouldFireAt,
} = await import('./trigger-engine');

beforeEach(() => {
    for (const t of getTriggers()) removeTrigger(t.id);
    store.clear();
});

const stop = () =>
    addTrigger({
        code: 'TXFR1',
        condition: 'below',
        price: 23000,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
    });

describe('拖曳改價', () => {
    it('只改價，condition 與數量原封不動', () => {
        const t = stop();
        const after = updateTriggerPrice(t.id, 22900);
        expect(after).toMatchObject({
            price: 22900,
            condition: 'below',
            action: 'Sell',
            quantity: 1,
            kind: 'stop',
        });
        expect(getTriggers()[0]!.price).toBe(22900);
    });

    it('寫回 localStorage — 重開 App 後還在新價位', () => {
        const t = stop();
        updateTriggerPrice(t.id, 22800);
        const saved = JSON.parse(store.get('sj-pro-triggers')!);
        expect(saved[0].price).toBe(22800);
    });

    it('改不存在的單回 null，不會憑空長出一筆', () => {
        expect(updateTriggerPrice('nope', 100)).toBeNull();
        expect(getTriggers()).toHaveLength(0);
    });

    it('只動指定的那一筆', () => {
        const a = stop();
        const b = stop();
        updateTriggerPrice(a.id, 22000);
        expect(getTriggers().find((t) => t.id === b.id)!.price).toBe(23000);
    });
});

describe('「放手就觸發」的判斷', () => {
    // 停損（below）被拖到現價之上，放手當下條件就成立 —— 等於立刻市價出場。
    // 呼叫端據此把價位退回去，不是拿來擋掉整個拖曳。
    it('below 在現價之上就會立刻觸發', () => {
        expect(wouldFireAt('below', 23100, 23050)).toBe(true);
        expect(wouldFireAt('below', 22900, 23050)).toBe(false);
    });

    it('above 在現價之下就會立刻觸發', () => {
        expect(wouldFireAt('above', 23000, 23050)).toBe(true);
        expect(wouldFireAt('above', 23100, 23050)).toBe(false);
    });

    it('剛好等於現價算觸發 — 引擎用的是 <= / >=，兩邊要一致', () => {
        expect(wouldFireAt('below', 23050, 23050)).toBe(true);
        expect(wouldFireAt('above', 23050, 23050)).toBe(true);
    });
});

describe('平倉後撤掉保護單', () => {
    const add = (over: Partial<Parameters<typeof addTrigger>[0]> = {}) =>
        addTrigger({
            code: 'TXFI6',
            condition: 'below',
            price: 23000,
            action: 'Sell',
            quantity: 1,
            kind: 'stop',
            ...over,
        });

    it('撤掉停損與停利 — 部位沒了還留著會開出反向新倉', () => {
        add({ kind: 'stop' });
        add({ kind: 'take', condition: 'above', price: 23500 });
        const removed = cancelProtectiveTriggers(['TXFI6']);
        expect(removed).toHaveLength(2);
        expect(getTriggers()).toHaveLength(0);
    });

    it('警示留著 — 那只是通知，不會送單', () => {
        add({ kind: 'alert' });
        add({ kind: 'stop' });
        cancelProtectiveTriggers(['TXFI6']);
        expect(getTriggers().map((t) => t.kind)).toEqual(['alert']);
    });

    it('不碰其他商品的保護單', () => {
        add({ code: 'TXFI6' });
        add({ code: 'MXFI6' });
        cancelProtectiveTriggers(['TXFI6']);
        expect(getTriggers().map((t) => t.code)).toEqual(['MXFI6']);
    });

    it('一次收多個代碼 — 連續月別名與月份合約指同一個部位', () => {
        add({ code: 'TXFR1' });
        add({ code: 'TXFI6' });
        expect(cancelProtectiveTriggers(['TXFI6', 'TXFR1', ''])).toHaveLength(2);
        expect(getTriggers()).toHaveLength(0);
    });

    it('沒有可撤的就回空陣列，不寫 localStorage', () => {
        add({ code: 'TXFI6', kind: 'alert' });
        store.delete('sj-pro-triggers');
        expect(cancelProtectiveTriggers(['TXFI6'])).toEqual([]);
        expect(store.has('sj-pro-triggers')).toBe(false);
    });
});
