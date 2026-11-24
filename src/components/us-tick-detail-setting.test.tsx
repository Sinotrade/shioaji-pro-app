// 美股成交資料設定：設定 → 行情 的兩個選項，與成交明細標題列「完整」鈕共用同一個設定
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
    return { store };
});

vi.mock('../lib/risk', () => ({ getDailyPnl: () => 0, setRiskSettings: vi.fn(), useRiskSettings: () => ({}) }));
vi.mock('../lib/tauri', () => ({
    openExternalUrl: vi.fn(),
    isAgentHarnessEnabled: () => false,
    setAgentHarnessEnabled: vi.fn(),
}));

import { getUsTickDetail, setUsTickDetail, US_TICK_DETAIL_KEY } from '../lib/us/us-tick-prefs';
import { QuotesSection } from './settings-dialog';
import { UsTickDetailToggle } from './tick-tape';

let view: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    setUsTickDetail('Tick');
});

it('settings 行情: two radio options, 一般成交 checked by default; choosing 完整成交 persists', async () => {
    await act(async () => { view = create(createElement(QuotesSection)); });
    const text = JSON.stringify(view!.toJSON());
    expect(text).toContain('美股成交資料');
    expect(text).toContain('正規盤會更新最新價的成交，加上盤前、盤後、夜盤的整股成交。');
    expect(text).toContain('另外包含碎股與特殊條件成交的每一筆，資料量較大。');
    const radios = view!.root.findAll(n => n.type === 'button' && n.props.role === 'radio');
    expect(radios.map(r => r.props['aria-checked'])).toEqual([true, false]);
    expect(radios[0]!.findAll(n => n.children.includes('一般成交（預設）'))).not.toHaveLength(0);
    expect(radios[1]!.findAll(n => n.children.includes('完整成交'))).not.toHaveLength(0);
    await act(async () => radios[1]!.props.onClick());
    expect(getUsTickDetail()).toBe('TickFull');
    expect(fixture.store.get(US_TICK_DETAIL_KEY)).toBe('TickFull');
    const after = view!.root.findAll(n => n.type === 'button' && n.props.role === 'radio');
    expect(after.map(r => r.props['aria-checked'])).toEqual([false, true]);
});

it('trade list 「完整」 button toggles the same setting and shows the pressed state', async () => {
    await act(async () => { view = create(createElement(UsTickDetailToggle)); });
    const button = () => view!.root.findByType('button');
    expect(button().props['aria-pressed']).toBe(false);
    expect(button().props.children).toBe('完整');
    await act(async () => button().props.onClick());
    expect(getUsTickDetail()).toBe('TickFull');
    expect(button().props['aria-pressed']).toBe(true);
    await act(async () => button().props.onClick());
    expect(getUsTickDetail()).toBe('Tick');
    expect(button().props['aria-pressed']).toBe(false);
    // 從設定切換也會反映在按鈕上
    await act(async () => setUsTickDetail('TickFull'));
    expect(button().props['aria-pressed']).toBe(true);
});
