import { createElement } from 'react';
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
vi.mock('../lib/risk', () => ({ getDailyPnl: () => 0, setRiskSettings: vi.fn(), useRiskSettings: () => ({}) }));
vi.mock('../lib/tauri', () => ({
    openExternalUrl: fixture.open,
    isAgentHarnessEnabled: () => false,
    setAgentHarnessEnabled: vi.fn(),
}));

import { setPrivacyMode } from '../lib/privacy';
import { AccountsSection } from './settings-dialog';

let view: ReactTestRenderer | undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
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
