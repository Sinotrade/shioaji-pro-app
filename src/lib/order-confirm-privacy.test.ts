// 隱私模式：確認視窗的帳號與底部 dock 同規則（只露末兩碼）；關閉時維持只露末四碼
import { describe, expect, it, vi } from 'vitest';

const p = vi.hoisted(() => ({ on: false }));
vi.mock('./privacy', async (orig) => ({ ...(await orig<typeof import('./privacy')>()), getPrivacyMode: () => p.on }));
vi.mock('./runtime', () => ({ getApiBase: () => '' }));
vi.mock('./shioaji', () => ({ fetchInfo: vi.fn() }));

import { accountConfirmLabel } from './order-confirm';

describe('accountConfirmLabel', () => {
    const account = { broker_id: '9A95', account_id: '9816502' };
    it('keeps the last four digits when privacy mode is off', () => {
        p.on = false;
        expect(accountConfirmLabel(account)).toBe('9A95-***6502');
    });
    it('masks like the bottom dock when privacy mode is on', () => {
        p.on = true;
        expect(accountConfirmLabel(account)).toBe('9A95-•••••02');
        expect(accountConfirmLabel(account)).not.toContain('6502');
    });
});
