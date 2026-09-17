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

const { addTrigger, getTriggers, removeTrigger, updateTriggerPrice, wouldFireAt } = await import(
    './trigger-engine'
);

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
