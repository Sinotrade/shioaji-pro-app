// 30 日已實現損益：券商 TKAP01／r6 暫時性錯誤灰字＋重試；其他錯誤紅字
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

const m = vi.hoisted(() => ({ result: { data: undefined as unknown, loading: false, error: null as string | null }, refresh: vi.fn(), simulation: false }));
const accounts: Account[] = [{ account_type: 'F', broker_id: 'BR', account_id: 'X', signed: true, person_id: '', username: '' }];
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ loaded: true, accounts }) }));
vi.mock('../hooks/use-query', () => ({ useQuery: () => ({ ...m.result, refresh: m.refresh }) }));
vi.mock('../lib/server-info-store', async orig => ({ ...await orig<object>(), useServerInfo: () => ({ simulation: m.simulation }) }));

import { PnlPanel } from './pnl-panel';

let view: ReactTestRenderer | undefined;
const text = () => JSON.stringify(view!.toJSON());
const retry = () => view!.root.findAll(node => node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('重試')));
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); m.refresh.mockReset(); m.simulation = false; });
const render = async (result: typeof m.result) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.result = result;
    await act(async () => { view = create(createElement(PnlPanel)); });
};

it.each(['500 Internal Server Error', '503 Service Unavailable', '500 TKAP01 6044 無法取得交易狀態'])(
    '沒有資料時遇到 %s：灰字＋重試、原文在 title', async (error) => {
        await render({ data: undefined, loading: false, error });
        expect(text()).toContain('券商暫時查不到資料，稍後再試');
        expect(text()).not.toContain('查詢失敗');
        expect(view!.root.findAll(node => node.type === 'span' && node.props.title === error)).toHaveLength(1);
        retry()[0]!.props.onClick();
        expect(m.refresh).toHaveBeenCalledTimes(1);
    });

it('已有資料時暫時性錯誤：保留資料、灰字，不顯示原文', async () => {
    await render({ data: [{ date: '2026-11-01', pnl: 300 }, { date: '2026-11-02', pnl: 200 }], loading: false, error: '500 Internal Server Error' });
    expect(text()).toContain('+500');
    expect(text()).toContain('券商暫時查不到資料');
    expect(text()).not.toContain('查詢失敗');
});

it('其他錯誤仍是紅字＋原因＋重試；有資料時狀態列照舊', async () => {
    await render({ data: undefined, loading: false, error: '500 Query error: session disconnected' });
    expect(text()).toContain('損益資訊查詢失敗：500 Query error: session disconnected');
    expect(text()).not.toContain('稍後再試');
    expect(retry()).toHaveLength(1);
    await act(async () => view!.unmount()); view = undefined;
    await render({ data: [{ date: '2026-11-01', pnl: 300 }], loading: false, error: '500 Query error: session disconnected' });
    expect(text()).toContain('查詢失敗，保留上次資料');
});

it('模擬環境不分類：裸 500 照舊紅字', async () => {
    m.simulation = true;
    await render({ data: undefined, loading: false, error: '500 Internal Server Error' });
    expect(text()).toContain('損益資訊查詢失敗：500 Internal Server Error');
    expect(text()).not.toContain('稍後再試');
});
