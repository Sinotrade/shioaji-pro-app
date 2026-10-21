// src/lib/heat-label.ts — 熱力圖 tile 標籤：依 tile 面積挑字級與內容
//
// 依序試字級階梯（大→小），估算文字寬（CJK 一字約 1em、其他約 0.62em）；
// 放得下「名稱＋漲跌」兩行就兩行，否則退到最小字級只放名稱 → 代號 → 不放。

export const LABEL_FONT_STEPS = [28, 20, 15, 12] as const;
export const LABEL_MIN_FONT = 10;

export type HeatLabelMode = 'both' | 'name' | 'code' | 'none';

export interface HeatLabelFit {
    mode: HeatLabelMode;
    /** 名稱字級（px）；漲跌字級為其 0.86 倍 */
    fontSize: number;
}

const isWide = (ch: string) => (ch.codePointAt(0) ?? 0) > 0x2e7f;

/** 估算字寬（px）— CJK 全形 1em、其餘 0.62em */
export function estimateTextWidth(text: string, fontSize: number): number {
    let em = 0;
    for (const ch of text) em += isWide(ch) ? 1 : 0.62;
    return em * fontSize;
}

export const PCT_SCALE = 0.86;

export function fitHeatLabel(
    width: number,
    height: number,
    name: string,
    pctText: string | null,
    code?: string,
): HeatLabelFit {
    for (const fs of LABEL_FONT_STEPS) {
        const pad = fs > 12 ? fs * 2 : 8;
        const nameW = estimateTextWidth(name, fs);
        const pctW = pctText ? estimateTextWidth(pctText, fs * PCT_SCALE) : 0;
        const lines = pctText ? 2.3 : 1.2;
        if (
            width >= Math.max(nameW, pctW) + pad &&
            height >= fs * lines + pad
        ) {
            return { mode: pctText ? 'both' : 'name', fontSize: fs };
        }
    }
    // 兩行放不下：只放名稱（12 → 10px），再退到代號
    for (const fs of [12, LABEL_MIN_FONT]) {
        if (height >= fs + 6 && width >= estimateTextWidth(name, fs) + 6) {
            return { mode: 'name', fontSize: fs };
        }
    }
    const fs = LABEL_MIN_FONT;
    if (
        code &&
        code !== name &&
        height >= fs + 6 &&
        width >= estimateTextWidth(code, fs) + 6
    ) {
        return { mode: 'code', fontSize: fs };
    }
    return { mode: 'none', fontSize: fs };
}
