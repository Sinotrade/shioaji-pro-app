import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    };
    return {
        tauri: { value: false },
        open: vi.fn(async () => undefined),
        cancelAll: vi.fn(async () => undefined),
        notify: vi.fn(),
        accounts: [
            { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: '', username: '測試甲' },
            { account_type: 'F', broker_id: 'F002000', account_id: '7654321', signed: false, person_id: '', username: '測試乙' },
        ],
    };
});

vi.mock('../lib/account-store', () => ({
    useAccounts: () => ({ accounts: fixture.accounts, selectedStock: fixture.accounts[0], selectedFutures: null, loaded: true }),
    ensureAccounts: () => undefined,
    refreshAccounts: async () => undefined,
    selectAccount: vi.fn(),
}));
vi.mock('../lib/runtime', async (orig) => ({
    ...(await orig<typeof import('../lib/runtime')>()),
    get isTauri() { return fixture.tauri.value; },
}));
vi.mock('../lib/risk', () => ({ getDailyPnl: () => 0, setRiskSettings: vi.fn(), useRiskSettings: () => ({}), getRiskSettings: () => ({ escCancelAll: true }) }));
vi.mock('../lib/tauri', () => ({
    openExternalUrl: fixture.open,
    isAgentHarnessEnabled: () => false,
    setAgentHarnessEnabled: vi.fn(),
}));
// 所有資料與交易邊界皆 stub，掛載真實測試單與全域熱鍵不發請求。
vi.mock('../hooks/use-stream', async orig => ({ ...(await orig<object>()), useQuote: () => ({ tick: { close: '21.5' } }), useTradingLive: () => true }));
vi.mock('../hooks/use-query', () => ({ useQuery: () => ({ data: undefined, error: null, refresh: vi.fn() }) }));
vi.mock('../lib/product-search', () => ({ searchProducts: vi.fn(async () => []) }));
vi.mock('../lib/trade', () => ({ cancelAllOrders: fixture.cancelAll, notify: fixture.notify, placeQuickOrder: vi.fn() }));

import { setPrivacyMode } from '../lib/privacy';
import { AccountsSection, SettingsDialog } from './settings-dialog';
import { useEscClose } from '../hooks/use-esc-close';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from '../lib/server-info-store';
import { useHotkeys } from '../hooks/use-hotkeys';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { getApiBase } from '../lib/runtime';

let view: ReactTestRenderer | undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); forgetServerInfo(getApiBase()); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    setPrivacyMode(false);
    fixture.tauri.value = false;
    fixture.open.mockClear();
});

const text = () => JSON.stringify(view!.toJSON());
const render = async () => { await act(async () => { view = create(createElement(AccountsSection)); }); };

it('labels signed=false as 未簽署或未測試 with a consistent tooltip', async () => {
    await render();
    expect(text()).toContain('未簽署或未測試（無法下單）');
    expect(text()).not.toMatch(/未簽署（無法下單）|未簽署 API 約定書/);
    const unsigned = view!.root.findAll((n) => n.type === 'button' && n.props.disabled === true);
    expect(unsigned).toHaveLength(1);
    expect(unsigned[0]!.props.title).toBe('尚未完成 API 約定書簽署或模擬測試，無法下單');
});
it('enables unsigned accounts and updates signing copy when simulation info arrives (#228)', async () => {
    await render();
    const unsignedButton = () => view!.root.findAllByType('button').find(n => n.props.title?.includes('模擬測試'))!;
    expect(unsignedButton().props.disabled).toBe(true);
    await act(async () => {
        observeServerInfo(beginServerInfoRequest(), { simulation: true } as import('../lib/shioaji').ServerInfo);
    });
    const label = '模擬可下單；正式交易需完成簽署與模擬測試';
    expect(unsignedButton().props.disabled).toBe(false);
    expect(unsignedButton().props.title).toBe(label);
    expect(text()).toContain(label);
    expect(text()).not.toContain('無法下單');
    expect(text()).not.toContain('無法選為下單帳戶');
    expect(fixture.accounts[1]!.signed).toBe(false);
    await act(async () => {
        observeServerInfo(beginServerInfoRequest(), { simulation: false } as import('../lib/shioaji').ServerInfo);
    });
    expect(unsignedButton().props.disabled).toBe(true);
    expect(text()).toContain('未簽署或未測試（無法下單）');
});

it('links the API management page and only the signing page for the unsigned account type', async () => {
    await render();
    expect(text()).toContain('尚未完成 API');
    const links = view!.root.findAllByType('a');
    expect(links.map((a) => a.props.href)).toEqual([
        'https://www.sinotrade.com.tw/newweb/PythonAPIKey/',
        'https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/',
    ]);
    for (const a of links) {
        expect(a.props.target).toBe('_blank');
        expect(a.props.rel).toContain('noopener');
    }
    // browser build: default navigation (new tab), no shell call
    const ev = { preventDefault: vi.fn() };
    links[0]!.props.onClick(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
});

it('opens links in the system browser on desktop', async () => {
    fixture.tauri.value = true;
    await render();
    const link = view!.root.findAllByType('a')[1]!;
    const ev = { preventDefault: vi.fn() };
    link.props.onClick(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(fixture.open).toHaveBeenCalledWith('https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/');
});

it('hides the link block when every account is usable', async () => {
    fixture.accounts[1]!.signed = true;
    try {
        await render();
        expect(view!.root.findAllByType('a')).toHaveLength(0);
        expect(text()).not.toContain('未簽署或未測試');
    } finally {
        fixture.accounts[1]!.signed = false;
    }
});

it('masks account ids and holder names in privacy mode', async () => {
    await render();
    expect(text()).toContain('1234567');
    expect(text()).toContain('測試甲');
    await act(async () => { setPrivacyMode(true); });
    expect(text()).not.toContain('1234567');
    expect(text()).not.toContain('7654321');
    expect(text()).not.toContain('測試甲');
    expect(text()).not.toContain('測試乙');
    expect(text()).toContain('•••••67');
    expect(text()).toContain('•••');
});

it('shows the test-order block only once the server reports simulation mode', async () => {
    await render();
    expect(text()).not.toContain('測試（買進）');
    await act(async () => {
        observeServerInfo(beginServerInfoRequest(), { simulation: true } as import('../lib/shioaji').ServerInfo);
    });
    expect(text()).toContain('測試（買進）');
    await act(async () => {
        observeServerInfo(beginServerInfoRequest(), { simulation: false } as import('../lib/shioaji').ServerInfo);
    });
    expect(text()).not.toContain('測試（買進）');
});

it('real hotkeys ignore search cancellation, confirmation overlays and the Esc closing settings', async () => {
    const listeners: { fn: (e: KeyboardEvent) => void; capture: boolean }[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fixture.cancelAll.mockClear(); fixture.notify.mockClear(); resetEscCancelArm();
    vi.stubGlobal('window', {
        addEventListener: (type: string, fn: (e: KeyboardEvent) => void, capture = false) => { if (type === 'keydown') listeners.push({ fn, capture }); },
        removeEventListener: (_type: string, fn: (e: KeyboardEvent) => void, capture = false) => {
            const i = listeners.findIndex(l => l.fn === fn && l.capture === capture); if (i >= 0) listeners.splice(i, 1);
        },
    });
    let active: unknown = null;
    vi.stubGlobal('document', { get activeElement() { return active; } });
    const esc = () => {
        const e = { key: 'Escape', repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        // 真正 DOM 的事件順序：先 capture，再 bubble。
        for (const l of [...listeners].sort((a, b) => Number(b.capture) - Number(a.capture))) l.fn(e as unknown as KeyboardEvent);
        return e;
    };
    const closed = vi.fn(); const confirmed = vi.fn();
    function Confirmation() { useEscClose(confirmed); return null; }
    function Harness({ confirmation = false }: { confirmation?: boolean }) {
        useHotkeys({ onOpenPalette: () => undefined, onAfterCancelAll: () => undefined });
        const [open, setOpen] = useState(true);
        return createElement('div', null,
            createElement(SettingsDialog, { open, onClose: () => { closed(); setOpen(false); }, onResetWorkspace: vi.fn(), onOpenLayoutLibrary: vi.fn() }),
            confirmation && createElement(Confirmation));
    }
    try {
        await act(async () => { observeServerInfo(beginServerInfoRequest(), { simulation: true } as import('../lib/shioaji').ServerInfo); });
        await act(async () => { view = create(createElement(Harness), { createNodeMock: el => el.type === 'input' ? { focus() { active = this; }, select() {}, tagName: 'INPUT' } : null }); });
        const label = (n: import('react-test-renderer').ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : label(c)).join('');
        await act(async () => view!.root.findAllByType('button').find(b => label(b) === '帳號')!.props.onClick());
        const product = () => view!.root.findByProps({ 'aria-label': '證券商品' });
        await act(async () => product().props.onChange({ target: { value: '搜尋中' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        // 確認疊層用真正 useEscClose，搜尋仍在其下。
        await act(async () => view!.update(createElement(Harness, { confirmation: true })));
        expect(esc().defaultPrevented).toBe(true);
        expect(confirmed).toHaveBeenCalledTimes(1); expect(closed).not.toHaveBeenCalled();
        expect(product().props.value).toBe('搜尋中');
        await act(async () => view!.update(createElement(Harness, { confirmation: false })));
        await act(async () => { expect(esc().defaultPrevented).toBe(true); });
        expect(product().props.value).toBe('永豐金'); expect(closed).not.toHaveBeenCalled();
        active = null;
        await act(async () => { expect(esc().defaultPrevented).toBe(true); });
        expect(closed).toHaveBeenCalledTimes(1);
        // 關設定的 Esc 後立刻再按一下，不能湊成 Esc×2 刪單。
        expect(esc().defaultPrevented).toBe(false);
        expect(fixture.cancelAll).not.toHaveBeenCalled();
        expect(fixture.notify).toHaveBeenCalledTimes(1);
        // 正向對照：兩下真正未被介面用掉的 Esc 會到交易 stub，證明熱鍵確實掛載。
        await act(async () => { esc(); await Promise.resolve(); });
        expect(fixture.cancelAll).toHaveBeenCalledTimes(1);
    } finally {
        await act(async () => view?.unmount()); view = undefined;
        resetEscCancelArm(); vi.useRealTimers(); vi.unstubAllGlobals();
    }
});
