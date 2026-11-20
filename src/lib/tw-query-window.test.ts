import { describe, expect, it } from 'vitest';
import { TRADING_LIMITS_WINDOW, twQueryWindowState, windowLabel } from './tw-query-window';

// 台北時間 → epoch ms（UTC+8）
const tw = (iso: string) => Date.parse(`${iso}+08:00`);

describe('twQueryWindowState（交易額度 08:30–15:00）', () => {
    const W = TRADING_LIMITS_WINDOW;
    it('標籤沿用既有提示文字', () => {
        expect(windowLabel(W)).toBe('交易日 08:30–15:00');
    });
    it('交易日時段內：開放，帶當天台北日期，下一次變化是 15:00', () => {
        const s = twQueryWindowState(tw('2026-11-20T10:00:00'), W); // 週五
        expect(s).toEqual({ open: true, sessionDate: '2026-11-20', nextChangeMs: tw('2026-11-20T15:00:00') });
    });
    it('深夜（截圖 01:54）關閉，下一次是當天 08:30', () => {
        const s = twQueryWindowState(tw('2026-11-20T01:54:00'), W);
        expect(s).toEqual({ open: false, sessionDate: null, nextChangeMs: tw('2026-11-20T08:30:00') });
    });
    it('邊界：08:30 整開、15:00 整關、14:59:59.999 仍開、08:29:59.999 未開', () => {
        expect(twQueryWindowState(tw('2026-11-20T08:30:00'), W).open).toBe(true);
        expect(twQueryWindowState(tw('2026-11-20T08:29:59.999'), W).open).toBe(false);
        expect(twQueryWindowState(tw('2026-11-20T14:59:59.999'), W).open).toBe(true);
        const close = twQueryWindowState(tw('2026-11-20T15:00:00'), W);
        expect(close.open).toBe(false);
        // 週五收盤後下一次是週一 08:30
        expect(close.nextChangeMs).toBe(tw('2026-11-23T08:30:00'));
    });
    it('週末整天關閉，下一次是週一 08:30', () => {
        for (const t of ['2026-11-21T10:00:00', '2026-11-22T23:59:59', '2026-11-22T00:00:00']) {
            expect(twQueryWindowState(tw(t), W)).toEqual({ open: false, sessionDate: null, nextChangeMs: tw('2026-11-23T08:30:00') });
        }
    });
    it('平日收盤後，下一次是隔天 08:30', () => {
        expect(twQueryWindowState(tw('2026-11-18T20:00:00'), W).nextChangeMs).toBe(tw('2026-11-19T08:30:00'));
    });
    it('與本機時區無關：台北日期以 UTC+8 算（UTC 前一天 23:00 是台北 07:00）', () => {
        const s = twQueryWindowState(Date.parse('2026-11-19T23:00:00Z'), W);
        expect(s.open).toBe(false);
        expect(s.nextChangeMs).toBe(tw('2026-11-20T08:30:00'));
        expect(twQueryWindowState(Date.parse('2026-11-20T02:00:00Z'), W).sessionDate).toBe('2026-11-20');
    });
});
