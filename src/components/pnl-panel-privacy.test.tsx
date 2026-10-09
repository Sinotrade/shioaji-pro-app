// 遮金額：30 日已實現損益、平均獲利／虧損一律遮蔽
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

const m = vi.hoisted(() => ({ money: true }));
const accounts: Account[] = [{ account_type: 'S', broker_id: '9A95', account_id: '9816502', signed: true, person_id: '', username: '' }];
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ loaded: true, accounts }) }));
vi.mock('../hooks/use-query', () => ({
    useQuery: () => ({ data: [{ date: '2026-10-01', pnl: 1127993 }, { date: '2026-10-02', pnl: -45678 }, { date: '2026-10-03', pnl: 23456 }], loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMoney: () => m.money }));

import { PnlPanel } from './pnl-panel';

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

it('masks realized P&L amounts when 遮金額 is on', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let view!: ReactTestRenderer;
    try {
        m.money = true;
        await act(async () => { view = create(createElement(PnlPanel)); });
        const masked = text(view);
        expect(masked).not.toMatch(/1,105,771|1,127,993|575,725|45,678/);
        expect(masked).toContain('•••••');
        m.money = false;
        await act(async () => { view.update(createElement(PnlPanel)); });
        expect(text(view)).toContain('1,105,771');
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
