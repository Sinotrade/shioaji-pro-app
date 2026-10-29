// src/lib/broadcast/broadcast-hub.test.ts — 中樞的訂閱生命週期。
//
// 這裡測的是**整合層**：訂閱、解除訂閱、移除商品後還會不會繼續播報。
// 純函式層（broadcast-rule / broadcast-queue）測不到這一段 —— 而這正是
// 「移除播報商品後仍然持續播報」這個 bug 藏身的地方。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../types/contract';

const mocks = vi.hoisted(() => ({
    listeners: new Map<string, Set<() => void>>(),
    quotes: new Map<string, unknown>(),
    contracts: new Map<string, unknown>(),
    /** 目前被 retain 住的行情訂閱數 */
    retained: 0,
    speak: vi.fn(async () => {}),
}));

vi.mock('../stream', () => ({
    getQuote: (code: string) => mocks.quotes.get(code),
    onOrderEvent: () => () => undefined,
    subscribeQuoteStore: (code: string, cb: () => void) => {
        let set = mocks.listeners.get(code);
        if (!set) {
            set = new Set();
            mocks.listeners.set(code, set);
        }
        set.add(cb);
        return () => {
            set!.delete(cb);
        };
    },
}));

vi.mock('../contracts-cache', () => ({
    ensureContract: async (code: string) => {
        const c = mocks.contracts.get(code);
        if (!c) throw new Error(`unknown contract: ${code}`);
        return c;
    },
    getCachedContract: (code: string) => mocks.contracts.get(code),
}));

vi.mock('../quote-ownership', () => ({
    retainQuote: () => {
        mocks.retained++;
        return () => {
            mocks.retained--;
        };
    },
}));

vi.mock('../trade', () => ({
    onNotice: () => () => undefined,
}));

vi.mock('../tts', () => ({
    getTtsEngine: () => ({
        id: 'test',
        available: true,
        reason: undefined,
        speaking: false,
        listVoices: () => [],
        cancelAll: () => undefined,
        probe: async () => ({ available: true }),
        speak: mocks.speak,
    }),
}));

// 面板填的是近月代號（TXFR1），實際合約代碼是 TXFK6 —— 代號不一致是常見情況。
const contract: ContractInfo = {
    code: 'TXFK6',
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: 'TXFR1',
    name: '臺股期貨 近月',
    currency: 'TWD',
    limit_up: 0,
    limit_down: 0,
    reference: 0,
    day_trade: '',
    update_date: '',
    category: '',
    margin_trading_balance: 0,
    short_selling_balance: 0,
};

function fireTick(code: string) {
    mocks.listeners.get(code)?.forEach((cb) => cb());
}

function setTick(code: string, price: number) {
    mocks.quotes.set(code, { tick: { close: price, high: price, low: price } });
}

async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('broadcast-hub 的訂閱生命週期', () => {
    beforeEach(async () => {
        vi.resetModules();
        mocks.listeners.clear();
        mocks.quotes.clear();
        mocks.contracts.clear();
        mocks.speak.mockClear();
        mocks.retained = 0;
        mocks.contracts.set('TXFR1', contract);
    });

    it('移除商品後就不再播報（即使還有其他元件持有這檔商品的行情訂閱）', async () => {
        const hub = await import('./broadcast-hub');
        const settings = await import('./broadcast-settings');
        settings.setBroadcastSettings({
            enabled: true,
            quoteEnabled: true,
            cooldownSec: 0,
        });

        hub.setBroadcastQuoteCodes(['TXFR1']);
        await flush();

        // 第一筆 tick 只定基準、不播報
        setTick('TXFK6', 100);
        fireTick('TXFK6');
        await flush();
        expect(mocks.speak).not.toHaveBeenCalled();

        // 第二筆 tick → 播報
        setTick('TXFK6', 101);
        fireTick('TXFK6');
        await flush();
        expect(mocks.speak).toHaveBeenCalledTimes(1);

        // 移除商品
        hub.setBroadcastQuoteCodes([]);
        await flush();

        // 之後的 tick 不應再播報。
        // 關鍵：自選清單可能還持有這檔商品的行情訂閱 → tick 仍會進來。
        // 移除後的第一筆 tick 只會重設基準（不播報），所以要送兩筆才看得出來：
        // 第二筆會再次觸發「最高價」狀態 → 被移除的商品又開始播報。
        setTick('TXFK6', 102);
        fireTick('TXFK6');
        await flush();
        setTick('TXFK6', 103);
        fireTick('TXFK6');
        await flush();
        expect(mocks.speak).toHaveBeenCalledTimes(1);
    });

    it('移除商品時會解除行情 store 的訂閱（不留 listener 洩漏）', async () => {
        const hub = await import('./broadcast-hub');
        const settings = await import('./broadcast-settings');
        settings.setBroadcastSettings({
            enabled: true,
            quoteEnabled: true,
            cooldownSec: 0,
        });

        hub.setBroadcastQuoteCodes(['TXFR1']);
        await flush();
        expect(mocks.listeners.get('TXFK6')?.size).toBe(1);
        expect(mocks.retained).toBe(1);

        hub.setBroadcastQuoteCodes([]);
        await flush();

        expect(mocks.listeners.get('TXFK6')?.size ?? 0).toBe(0);
        expect(mocks.retained).toBe(0);
    });

    it('移除商品後重新加入會從新的基準開始（不會沿用舊的水位標竿）', async () => {
        const hub = await import('./broadcast-hub');
        const settings = await import('./broadcast-settings');
        settings.setBroadcastSettings({
            enabled: true,
            quoteEnabled: true,
            cooldownSec: 0,
        });

        hub.setBroadcastQuoteCodes(['TXFR1']);
        await flush();
        setTick('TXFK6', 100);
        fireTick('TXFK6');
        await flush();

        hub.setBroadcastQuoteCodes([]);
        await flush();

        hub.setBroadcastQuoteCodes(['TXFR1']);
        await flush();

        // 重新加入後的第一筆 tick 只定基準 → 不播報
        setTick('TXFK6', 200);
        fireTick('TXFK6');
        await flush();
        expect(mocks.speak).not.toHaveBeenCalled();
    });
});
