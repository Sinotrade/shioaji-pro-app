// #268 — 產生當下組好的文字（通知、toast、錯誤訊息）在渲染時依目前開關重新遮蔽
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', new EventTarget());
const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
const { plainText, revealText, secretAccount, secretMoney, setPrivacyMode, setPrivacyMoney } = await import('./privacy');

afterEach(() => {
    setPrivacyMode(false);
    setPrivacyMoney(false);
});

const off = { priv: false, privMoney: false };
const on = { priv: true, privMoney: true };

describe('secretMoney / secretAccount', () => {
    it('created while privacy is off: re-masked when it is turned on later', () => {
        const text = `當日虧損 ${secretMoney(-3500)}｜帳號 9A95-${secretAccount('9816502')}`;
        expect(revealText(text, off)).toBe('當日虧損 -3500｜帳號 9A95-9816502');
        const masked = revealText(text, on);
        expect(masked).toBe('當日虧損 •••••｜帳號 9A95-•••••02');
        expect(masked).not.toMatch(/3500|9816502/);
    });

    it('money and account follow their own toggle', () => {
        const text = `${secretMoney('8 張')} ${secretAccount('9816502')}`;
        expect(revealText(text, { priv: true, privMoney: false })).toBe('8 張 •••••02');
        expect(revealText(text, { priv: false, privMoney: true })).toBe('••••• 9816502');
    });

    it('created while privacy is already on: never keeps the raw value', () => {
        setPrivacyMoney(true);
        setPrivacyMode(true);
        const text = `${secretMoney(1127993)} ${secretAccount('9816502')}`;
        expect(text).not.toMatch(/1127993|9816502/);
        expect(revealText(text, off)).toBe('••••• •••••02');
    });

    it('plainText strips the markers and keeps the values', () => {
        const text = `虧損 ${secretMoney('1,356 元')}`;
        expect(text).not.toBe('虧損 1,356 元');
        expect(plainText(text)).toBe('虧損 1,356 元');
    });
});

describe('revealText known accounts', () => {
    it('masks known account ids inside server text when privacy mode is on', () => {
        const text = 'account 9816502 not signed (9A95-9151121); order 98165020 untouched';
        const ids = ['9816502', '9151121'];
        expect(revealText(text, { priv: true, privMoney: false, accountIds: ids }))
            .toBe('account •••••02 not signed (9A95-•••••21); order 98165020 untouched');
        expect(revealText(text, { priv: false, privMoney: false, accountIds: ids })).toBe(text);
    });

    it('ignores very short ids so ordinary numbers are not masked', () => {
        expect(revealText('成交 12 口', { priv: true, privMoney: false, accountIds: ['12'] })).toBe('成交 12 口');
    });
});
