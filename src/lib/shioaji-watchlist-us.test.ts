// 自選 API 的美股 wire 格式：region US＋實際交易所；台股照舊帶 region TW
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('./api', async (original) => ({
    ...await original<object>(),
    apiPost: mocks.post,
    apiPut: mocks.put,
    apiDelete: mocks.del,
}));

const { addWatchlistContracts, removeWatchlistContracts, syncWatchlist } = await import('./shioaji');
const { toUsContractInfo } = await import('./us/us-contracts');

const aapl = toUsContractInfo('AAPL', { code: 'AAPL', exchange: 'NASDAQ', reference: '187.5', fetchedOn: '2026-11-18' });
const tw = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };

beforeEach(() => {
    for (const m of [mocks.post, mocks.put, mocks.del]) m.mockReset().mockResolvedValue({ id: 'w', name: 'W', contracts: [] });
});

it('add sends region US and the real exchange for a US contract', async () => {
    await addWatchlistContracts('w', [tw, aapl]);
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/watchlist/w/contracts', {
        contracts: [
            { security_type: 'STK', region: 'TW', exchange: 'TSE', code: '2330', target_code: null },
            { security_type: 'STK', region: 'US', exchange: 'NASDAQ', code: 'AAPL', target_code: null },
        ],
    });
});

it('remove and sync keep the US region', async () => {
    await removeWatchlistContracts('w', [aapl]);
    expect(mocks.del.mock.calls[0]![1]).toEqual({ contracts: [expect.objectContaining({ region: 'US', exchange: 'NASDAQ', code: 'AAPL' })] });
    await syncWatchlist('w', [aapl, tw]);
    expect(mocks.put.mock.calls[0]![1].contracts.map((c: { region: string; code: string }) => `${c.region}:${c.code}`))
        .toEqual(['US:AAPL', 'TW:2330']);
});

it('refuses a US contract without an exchange', () => {
    expect(() => addWatchlistContracts('w', [toUsContractInfo('ZZZ')])).toThrow('交易所');
    expect(mocks.post).not.toHaveBeenCalled();
});
