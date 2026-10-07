import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { useStockPicker, type PickerSide } from './use-stock-picker';

const mocks = vi.hoisted(() => ({ research: true, items: [] as {contract: ContractInfo}[],
    daily: vi.fn(), cached: vi.fn(), scanner: vi.fn(), snapshots: vi.fn(), resolve: vi.fn(),
    score: vi.fn(), short: vi.fn() }));
vi.mock('./use-watchlist', () => ({ useWatchlist: () => ({ items: mocks.items }) }));
vi.mock('../lib/workspace', () => ({ get V9_RESEARCH_MODE() { return mocks.research; } }));
vi.mock('../lib/daily-candles', () => ({ getDailyCandles: mocks.daily, readCachedDailyCandles: mocks.cached }));
vi.mock('../lib/shioaji', () => ({ fetchScanner: mocks.scanner, fetchSnapshots: mocks.snapshots }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: mocks.resolve }));
vi.mock('../lib/stock-picker', () => ({ scoreStock: mocks.score, scoreStockShort: mocks.short }));

const contract = (code: string, security_type: ContractInfo['security_type'] = 'STK') => ({
    code, security_type, region: 'TW', exchange: security_type === 'STK' ? 'TSE' : 'TAIFEX', target_code: null,
    name: `測試${code}` } as ContractInfo);
const bar = (day: string): Candle => ({ time: Date.parse(`${day}T00:00:00Z`) / 1000,
    open: 100, high: 102, low: 99, close: 101, volume: 100 });
let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useStockPicker>;
function Probe({ side = 'long', enabled = true }: { side?: PickerSide; enabled?: boolean }) {
    result = useStockPicker(side, enabled); return null;
}
beforeEach(() => {
    vi.clearAllMocks(); mocks.research = true; mocks.items = [{ contract: contract('2330') }];
    mocks.daily.mockResolvedValue([bar('2026-10-01'), bar('2026-10-02')]);
    mocks.cached.mockResolvedValue([bar('2026-10-01'), bar('2026-10-02'), bar('2026-10-05')]);
    mocks.scanner.mockResolvedValue([]); mocks.snapshots.mockResolvedValue([]);
    mocks.resolve.mockImplementation((code: string) => Promise.resolve(contract(code, code === 'IX0001' ? 'IND' : 'STK')));
    mocks.score.mockReturnValue(null); mocks.short.mockReturnValue(null);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T09:30:00+08:00'));
});
afterEach(async () => {
    if (renderer) await act(async () => renderer!.unmount()); renderer = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('reuse the original stock scan for independent daily research', () => {
    it('keeps insufficient legacy scores visible and filters unclosed/future cache dates without a second download', async () => {
        await act(async () => { renderer = create(<Probe />); });
        expect(result.rows).toEqual([]);
        expect(result.dailyRows).toEqual([{ contract: mocks.items[0]!.contract, daily: [bar('2026-10-01')] }]);
        expect(mocks.cached).toHaveBeenCalledExactlyOnceWith(mocks.items[0]!.contract, {
            stockRegularCloseOnly: true, nowMs: Date.parse('2026-10-02T09:30:00+08:00'),
        });
        expect(mocks.daily).toHaveBeenCalledTimes(2); // original stock + original index only
        expect(mocks.scanner).toHaveBeenCalledTimes(3);
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
    });
    it('does not evaluate stock research in formal mode or read its new cache view', async () => {
        mocks.research = false;
        await act(async () => { renderer = create(<Probe />); });
        expect(result.dailyRows).toEqual([]); expect(mocks.cached).not.toHaveBeenCalled();
        expect(mocks.daily).toHaveBeenCalledTimes(2);
    });
    it('retains failed stocks as waiting for data and never feeds futures into dailyRows', async () => {
        mocks.items = [{ contract: contract('2330') }, { contract: contract('TXFR1', 'FUT') }];
        mocks.daily.mockImplementation((c: ContractInfo) => c.code === '2330' ? Promise.reject(new Error('fixture offline')) : Promise.resolve([]));
        await act(async () => { renderer = create(<Probe />); });
        expect(result.dailyRows).toEqual([{ contract: mocks.items[0]!.contract, daily: [] }]);
        expect(mocks.cached).not.toHaveBeenCalled();
    });
    it('shares the 40-contract limit and keeps the three existing scanner request counts unchanged', async () => {
        mocks.items = Array.from({ length: 45 }, (_, i) => ({ contract: contract(String(2000 + i)) }));
        await act(async () => { renderer = create(<Probe />); });
        expect(result.dailyRows).toHaveLength(40); expect(mocks.cached).toHaveBeenCalledTimes(40);
        expect(mocks.daily).toHaveBeenCalledTimes(41); // one existing index request
        expect(mocks.scanner).toHaveBeenCalledTimes(3);
        expect(new Set(result.dailyRows.map(row => row.contract.code)).size).toBe(40);
    });
    it.each([
        { research: true, side: 'long' as const, flags: [true, true, true] },
        { research: true, side: 'short' as const, flags: [true, false, true] },
        { research: false, side: 'long' as const, flags: [false, false, false] },
        { research: false, side: 'short' as const, flags: [false, true, false] },
    ])('uses verified scanner direction only in research=$research side=$side, preserving formal behavior', async ({ research, side, flags }) => {
        mocks.research = research;
        await act(async () => { renderer = create(<Probe side={side} />); });
        expect(mocks.scanner.mock.calls).toEqual([
            ['VolumeRank', 25, flags[0]],
            ['ChangePercentRank', 20, flags[1]],
            ['AmountRank', 20, flags[2]],
        ]);
        expect(mocks.daily).toHaveBeenCalledTimes(2);
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
    });
    it('does not start the legacy scan while its view is disabled, in either research or formal mode', async () => {
        for (const research of [true, false]) {
            mocks.research = research;
            await act(async () => { renderer = create(<Probe enabled={false} />); });
            expect(mocks.scanner).not.toHaveBeenCalled(); expect(mocks.daily).not.toHaveBeenCalled();
            expect(mocks.snapshots).not.toHaveBeenCalled(); expect(mocks.cached).not.toHaveBeenCalled();
            await act(async () => renderer!.unmount()); renderer = undefined;
        }
    });
});
