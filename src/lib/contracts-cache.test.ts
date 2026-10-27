import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo, SecurityType } from './types/contract';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), alias: vi.fn(), bands: vi.fn() }));
vi.mock('./shioaji', () => ({ resolveContract: mocks.resolve }));
vi.mock('./stream', () => ({ registerCodeAlias: mocks.alias }));
vi.mock('./tick-bands', () => ({ prefetchTickBands: mocks.bands }));
let view: ReactTestRenderer | undefined;

function contract(code: string, type: SecurityType, patch: Partial<ContractInfo> = {}): ContractInfo {
    return {
        code, name: `${type} 測試商品`, security_type: type, exchange: type === 'IND' ? 'OTC' : type === 'FUT' ? 'TAIFEX' : 'TSE',
        target_code: null, currency: 'TWD', reference: 100, limit_up: 110, limit_down: 90, day_trade: '', update_date: '',
        category: '', margin_trading_balance: 0, short_selling_balance: 0, ...patch,
    };
}

beforeEach(() => {
    vi.resetModules();
    mocks.resolve.mockReset();
    mocks.alias.mockReset();
    mocks.bands.mockReset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('商品快取型別隔離', () => {
    it('Gemini F02 複核：同碼混合刷新部分失敗保留有效值，重試只更新正確型別', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const index = contract('SHARED', 'IND');
        const newStock = contract('SHARED', 'STK', { reference: 120 });
        const newIndex = contract('SHARED', 'IND', { reference: 200 });
        api.primeContract(stock);
        api.primeContract(index);
        mocks.resolve.mockImplementation(async (_code: string, type: SecurityType) => {
            if (type === 'STK') throw new Error('Synthetic 503 stock');
            return newIndex;
        });
        await api.refreshCachedContracts();
        expect(api.getCachedContract('SHARED')).toBe(newIndex);
        expect(await api.ensureContract('SHARED', 'STK')).toBe(stock);
        expect(await api.ensureContract('SHARED', 'IND')).toBe(newIndex);
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
        mocks.resolve.mockResolvedValue(newStock);
        await api.refreshCachedContracts('STK');
        expect(await api.ensureContract('SHARED', 'STK')).toBe(newStock);
        expect(await api.ensureContract('SHARED', 'IND')).toBe(newIndex);
        expect(api.getCachedContract('SHARED')).toBe(newIndex);
        expect(mocks.resolve).toHaveBeenCalledTimes(3);
    });

    it('同碼不同型別不誤命中，typed 命中也不切換 code-only 顯示身分', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const future = contract('SHARED', 'FUT');
        api.primeContract(stock);
        mocks.resolve.mockResolvedValue(future);
        expect(await api.ensureContract('SHARED', 'FUT')).toBe(future);
        expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('SHARED', 'FUT');
        expect(await api.ensureContract('SHARED', 'STK')).toBe(stock);
        expect(api.getCachedContract('SHARED')).toBe(future);
        expect(await api.ensureContract('SHARED')).toBe(future);
        expect(mocks.resolve).toHaveBeenCalledTimes(1);
    });

    it('同型別 pending 去重，不同型別並行並各自保留快取', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const future = contract('SHARED', 'FUT');
        const complete = new Map<SecurityType, (value: ContractInfo) => void>();
        mocks.resolve.mockImplementation((_code: string, type: SecurityType) => new Promise((resolve) => { complete.set(type, resolve); }));
        const stock1 = api.ensureContract('SHARED', 'STK');
        const stock2 = api.ensureContract('SHARED', 'STK');
        const futures = api.ensureContract('SHARED', 'FUT');
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
        complete.get('FUT')!(future);
        expect(await futures).toBe(future);
        complete.get('STK')!(stock);
        expect(await stock1).toBe(stock);
        expect(await stock2).toBe(stock);
        expect(await api.ensureContract('SHARED', 'FUT')).toBe(future);
        expect(await api.ensureContract('SHARED', 'STK')).toBe(stock);
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
    });

    it.each([true, false])('AUTO 與 typed pending 不混用，AUTO 先完成：%s', async (autoFirst) => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const index = contract('SHARED', 'IND');
        const complete = new Map<string, (value: ContractInfo) => void>();
        mocks.resolve.mockImplementation((_code: string, type?: SecurityType) => new Promise((resolve) => { complete.set(type ?? 'AUTO', resolve); }));
        const auto = api.ensureContract('SHARED');
        const typed = api.ensureContract('SHARED', 'IND');
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
        if (autoFirst) {
            complete.get('AUTO')!(stock);
            expect(await auto).toBe(stock);
            complete.get('IND')!(index);
        } else {
            complete.get('IND')!(index);
            expect(await typed).toBe(index);
            complete.get('AUTO')!(stock);
        }
        expect(await auto).toBe(stock);
        expect(await typed).toBe(index);
        expect(await api.ensureContract('SHARED', 'IND')).toBe(index);
        expect(await api.ensureContract('SHARED', 'STK')).toBe(stock);
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
        expect(api.getCachedContract('SHARED')).toBe(autoFirst ? index : stock);
    });

    it('typed 查詢回錯型別不污染快取，pending 清理後可重試', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const index = contract('SHARED', 'IND');
        api.primeContract(stock);
        mocks.resolve.mockResolvedValueOnce(stock).mockResolvedValueOnce(index);
        await expect(api.ensureContract('SHARED', 'IND')).rejects.toThrow('型別不是 IND');
        expect(api.getCachedContract('SHARED')).toBe(stock);
        expect(await api.ensureContract('SHARED', 'IND')).toBe(index);
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
    });

    it('typed 請求失敗後重試，不影響其他型別的既有快取', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const future = contract('SHARED', 'FUT');
        api.primeContract(stock);
        mocks.resolve.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(future);
        await expect(api.ensureContract('SHARED', 'FUT')).rejects.toThrow('503');
        expect(await api.ensureContract('SHARED', 'STK')).toBe(stock);
        expect(await api.ensureContract('SHARED', 'FUT')).toBe(future);
        expect(mocks.resolve).toHaveBeenCalledTimes(2);
    });

    it('型別刷新不把 code-only 顯示從另一型別換走，但 typed 仍取得新資料', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const index = contract('SHARED', 'IND');
        const refreshed = contract('SHARED', 'STK', { reference: 120 });
        api.primeContract(stock);
        api.primeContract(index);
        mocks.resolve.mockResolvedValue(refreshed);
        await api.refreshCachedContracts('STK');
        expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('SHARED', 'STK');
        expect(api.getCachedContract('SHARED')).toBe(index);
        expect(await api.ensureContract('SHARED', 'STK')).toBe(refreshed);
        expect(await api.ensureContract('SHARED', 'IND')).toBe(index);
        expect(mocks.resolve).toHaveBeenCalledTimes(1);
    });

    it('原始代碼與標準代碼的 typed 別名均會刷新，失敗不覆蓋舊值', async () => {
        const api = await import('./contracts-cache');
        const index = contract('IX0043', 'IND');
        const refreshed = contract('IX0043', 'IND', { reference: 200 });
        mocks.resolve.mockResolvedValueOnce(index).mockResolvedValueOnce(refreshed).mockRejectedValueOnce(new Error('503'));
        expect(await api.ensureContract('LEGACY', 'IND')).toBe(index);
        await api.refreshCachedContracts('IND');
        expect(await api.ensureContract('LEGACY', 'IND')).toBe(refreshed);
        expect(await api.ensureContract('IX0043', 'IND')).toBe(refreshed);
        expect(api.getCachedContract('LEGACY')).toBe(refreshed);
        await api.refreshCachedContracts('IND');
        expect(api.getCachedContract('LEGACY')).toBe(refreshed);
        expect(await api.ensureContract('IX0043', 'IND')).toBe(refreshed);
        expect(mocks.resolve).toHaveBeenCalledTimes(3);
    });

    it('保留 code-only getter、行情別名及期貨 tick bands 預取', async () => {
        const api = await import('./contracts-cache');
        const future = contract('TXFR1', 'FUT', { target_code: 'TXFJ6', tick_rule: 'TAIFEX' });
        api.primeContract(future);
        expect(api.getCachedContract('TXFR1')).toBe(future);
        expect(await api.ensureContract('TXFR1')).toBe(future);
        expect(mocks.alias).toHaveBeenCalledWith('TXFJ6', 'TXFR1');
        expect(mocks.bands).toHaveBeenCalledWith('TAIFEX', 'FUT');
        expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it('useContract 繼續追隨 code-only 身分，隱藏型別刷新不切走畫面', async () => {
        const api = await import('./contracts-cache');
        const stock = contract('SHARED', 'STK');
        const index = contract('SHARED', 'IND');
        const newStock = contract('SHARED', 'STK', { reference: 120 });
        const newIndex = contract('SHARED', 'IND', { reference: 200 });
        let shown: ContractInfo | undefined;
        function Probe() {
            shown = api.useContract('SHARED');
            return null;
        }
        api.primeContract(stock);
        act(() => { view = create(createElement(Probe)); });
        expect(shown).toBe(stock);
        act(() => api.primeContract(index));
        expect(shown).toBe(index);
        mocks.resolve.mockImplementation(async (_code: string, type: SecurityType) => type === 'STK' ? newStock : newIndex);
        await act(async () => { await api.refreshCachedContracts(); });
        expect(shown).toBe(newIndex);
        expect(api.getCachedContract('SHARED')).toBe(newIndex);
        expect(await api.ensureContract('SHARED', 'STK')).toBe(newStock);
        expect(mocks.resolve.mock.calls).toEqual([['SHARED', 'STK'], ['SHARED', 'IND']]);
    });
});
