import { describe, expect, it } from 'vitest';
import { fitPopover } from './popover-fit';

// 窄 K 線面板（約 540px）右側的「圖表下單設定」：面板寬 304px、從按鈕左緣往右
// 長會超出面板右邊界被裁掉 → 要往左收、留在面板裡；太窄就縮寬；太矮就限高捲動
describe('彈出面板留在可見範圍內（面板邊界與視窗）', () => {
    const clip = { left: 272, top: 48, right: 797, bottom: 906 };

    it('放得下時貼齊按鈕左緣、不改大小', () => {
        expect(fitPopover({ left: 300, bottom: 260 }, { width: 304, height: 280 }, clip)).toEqual({ left: 0 });
    });

    it('按鈕靠右邊界時往左收，右緣留 6px', () => {
        const r = fitPopover({ left: 697, bottom: 274 }, { width: 304, height: 280 }, clip);
        expect(r.left).toBe(797 - 6 - 304 - 697);
        expect(r.maxWidth).toBeUndefined();
    });

    it('面板比彈出層還窄：縮寬、左右各留 6px', () => {
        const narrow = { left: 272, top: 48, right: 472, bottom: 906 };
        const r = fitPopover({ left: 400, bottom: 274 }, { width: 304, height: 280 }, narrow);
        expect(r.maxWidth).toBe(200 - 12);
        expect(400 + r.left).toBe(272 + 6);
    });

    it('下方空間不夠時限高（面板內捲動），至少留 120px', () => {
        const r = fitPopover({ left: 300, bottom: 700 }, { width: 304, height: 400 }, clip);
        expect(r.maxHeight).toBe(906 - 6 - (700 + 4));
        const tiny = fitPopover({ left: 300, bottom: 880 }, { width: 304, height: 400 }, clip);
        expect(tiny.maxHeight).toBe(120);
    });
});
