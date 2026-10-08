// 隱私模式＋遮金額：閃電下單的帳戶選單不露完整帳號，持倉列不露數量、成本、損益
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ notify: vi.fn() }));
const accounts: Account[] = ['9816502', '9151121'].map(account_id => ({ account_type: 'S', broker_id: '9A95', account_id, signed: true, person_id: '', username: '王小明' }));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: undefined }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 2400 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMode: () => true, usePrivacyMoney: () => true }));
import { FlashOrder } from './flash-order';

it('masks account ids, names and the position row in privacy mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const contract = { code: '2330', name: '台積電', exchange: 'TSE', security_type: 'STK', reference: 2400 } as ContractInfo;
    const positions = [{ account: accounts[0]!, id: 1, code: '2330', direction: 'Buy' as const, quantity: 8006, price: 2398.98, last_price: 2540, pnl: 1127993, cond: 'Cash' }];
    let view!: ReactTestRenderer;
    try {
        await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions })); });
        // visible text + tooltips only (option values are internal keys, not shown)
        const json = view.root.findAll(() => true).flatMap(n => [...n.children.filter(c => typeof c === 'string'), typeof n.props.title === 'string' ? n.props.title : '']).join('|');
        expect(json).not.toMatch(/9816502|9151121|王小明/);
        expect(json).toContain('•••••02');
        expect(json).not.toMatch(/1,127,993|2,398\.98|8張/);
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
