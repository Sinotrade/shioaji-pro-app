import { afterEach, expect, it, vi } from 'vitest';

vi.stubGlobal('window', new EventTarget());
const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
const { plainText, revealText, setPrivacyMoney } = await import('./privacy');
const { checkOrderAllowed, getDailyPnlKnown, reportDailyPnl, setRiskSettings, subscribeRiskSettings } = await import('./risk');

afterEach(() => {
    setPrivacyMoney(false);
    reportDailyPnl(0);
    setRiskSettings({ enabled: false, maxDailyLoss: 0 });
});

it('masks the daily-loss amounts in the block reason when 遮金額 is on', () => {
    setRiskSettings({ enabled: true, maxDailyLoss: 3000 });
    reportDailyPnl(-3500);
    const before = checkOrderAllowed(1)!;
    expect(plainText(before)).toBe('當日虧損 -3500 已達上限 -3000，下單封鎖');
    // #268: 先產生、之後才開遮金額 — 通知中心／toast 渲染時要重遮
    expect(revealText(before, { priv: false, privMoney: true })).toBe('當日虧損 ••••• 已達上限 -•••••，下單封鎖');
    setPrivacyMoney(true);
    const reason = checkOrderAllowed(1)!;
    expect(reason).toContain('下單封鎖');
    expect(reason).not.toMatch(/3500|3000/);
});

it('tells subscribers about every change of the settings and the daily PnL', () => {
    const seen = vi.fn();
    const off = subscribeRiskSettings(seen);
    setRiskSettings({ locked: true });
    reportDailyPnl(-10);
    off();
    setRiskSettings({ locked: false });
    expect(seen).toHaveBeenCalledTimes(2);
});

it('knows whether the daily PnL was read or is only the starting zero', () => {
    reportDailyPnl(0, false);
    expect(getDailyPnlKnown()).toBe(false);
    reportDailyPnl(0);
    expect(getDailyPnlKnown()).toBe(true);
});
