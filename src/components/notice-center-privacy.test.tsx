// #268 — 通知中心與 toast 保留產生當下的文字：之後才打開隱私／遮金額時，
// 已顯示的金額、持倉量與帳號（含伺服器錯誤訊息裡的帳號）都要立即重遮。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

type Notice = { kind: 'ok' | 'err' | 'info'; title: string; body: string };
const h = vi.hoisted(() => ({
    log: [] as (Notice & { ts: number })[],
    logListeners: new Set<() => void>(),
    noticeListeners: new Set<(n: Notice) => void>(),
}));
const accounts: Account[] = [{ account_type: 'S', broker_id: '9A95', account_id: '9816502', signed: true, person_id: '', username: '王小明' }];
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: null }) }));
vi.mock('../lib/trade', () => ({
    getNoticeLog: () => h.log,
    subscribeNoticeLog: (l: () => void) => { h.logListeners.add(l); return () => h.logListeners.delete(l); },
    clearNoticeLog: () => undefined,
    onNotice: (l: (n: Notice) => void) => { h.noticeListeners.add(l); return () => h.noticeListeners.delete(l); },
}));
vi.mock('../lib/stream', () => ({ onOrderEvent: () => () => undefined }));
vi.mock('../lib/sounds', () => ({ playAlert: vi.fn(), playDeal: vi.fn(), playError: vi.fn(), playOrder: vi.fn() }));
vi.mock('../lib/toast-prefs', () => ({ useToastScale: () => 1 }));

const privacy = await import('../lib/privacy');
const { NoticeCenter } = await import('./notice-center');
const { EventToasts } = await import('./event-toasts');

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');

function notices(): Notice[] {
    // 隱私都關著時產生：當日虧損、平倉量、分倉帳號，以及伺服器原文裡的帳號
    return [
        { kind: 'err', title: '風控阻擋', body: `當日虧損 ${privacy.secretMoney(-35000)} 已達上限 -${privacy.secretMoney(30000)}，下單封鎖` },
        { kind: 'ok', title: '平倉單已送出', body: `2330 市價賣 ${privacy.secretMoney('8 張')}` },
        { kind: 'err', title: '分倉買進 2330', body: `成功 0/1 戶\n9A95-${privacy.secretAccount('9816502')}: 失敗` },
        { kind: 'err', title: '下單失敗', body: 'account 9816502 is not signed' },
    ];
}

let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    privacy.setPrivacyMode(false);
    privacy.setPrivacyMoney(false);
    h.log = [];
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    privacy.setPrivacyMode(false);
    privacy.setPrivacyMoney(false);
    vi.unstubAllGlobals();
});

it('通知中心：開隱私前產生的金額、持倉量與帳號在打開後重遮，關掉後還原', async () => {
    h.log = notices().map((n, i) => ({ ...n, ts: 1_700_000_000_000 + i }));
    await act(async () => { view = create(createElement(NoticeCenter)); });
    const shown = () => text(view!.root);
    expect(shown()).toContain('當日虧損 -35000 已達上限 -30000');
    expect(shown()).toContain('9A95-9816502');

    await act(async () => { privacy.setPrivacyMoney(true); privacy.setPrivacyMode(true); });
    expect(shown()).not.toMatch(/35000|30000|8 張|9816502/);
    expect(shown()).toContain('當日虧損 ••••• 已達上限 -•••••');
    expect(shown()).toContain('2330 市價賣 •••••');
    expect(shown()).toContain('9A95-•••••02');
    expect(shown()).toContain('account •••••02 is not signed');

    await act(async () => { privacy.setPrivacyMoney(false); privacy.setPrivacyMode(false); });
    expect(shown()).toContain('2330 市價賣 8 張');
    // 不顯示的標記字元不會留在畫面上
    expect(shown()).not.toMatch(/[⁡-⁣]/);
});

it('toast：顯示期間才打開遮金額／隱私也會立即遮', async () => {
    await act(async () => { view = create(createElement(EventToasts)); });
    await act(async () => { for (const n of notices()) h.noticeListeners.forEach(l => l(n)); });
    const shown = () => text(view!.root);
    expect(shown()).toContain('2330 市價賣 8 張');
    await act(async () => { privacy.setPrivacyMoney(true); privacy.setPrivacyMode(true); });
    expect(shown()).not.toMatch(/35000|30000|8 張|9816502/);
    expect(shown()).toContain('9A95-•••••02');
});

it('guard: notice center and toasts never render the invisible marker characters (text or title), in any toggle state', async () => {
    h.log = notices().map((n, i) => ({ ...n, ts: 1_700_000_000_000 + i }));
    await act(async () => { view = create(createElement('div', null, createElement(NoticeCenter), createElement(EventToasts))); });
    await act(async () => { for (const n of notices()) h.noticeListeners.forEach(l => l(n)); });
    const dom = () => JSON.stringify(view!.toJSON());
    for (const [priv, money] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        await act(async () => { privacy.setPrivacyMode(priv); privacy.setPrivacyMoney(money); });
        expect(dom()).not.toMatch(/[\u2061-\u2063]/);
    }
});
