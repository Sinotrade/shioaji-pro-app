/**
 * pivot-levels.ts — 樞紐中樞＋黃金比例 1.382/1.618
 *
 * 用「前一交易日」最高／最低／收盤，計算隔日的中間價、強勢價、弱勢價三條關卡，
 * 再以「隔日開盤價」落點分區，做盤前計畫與開盤預警。口徑與 Python 端
 * backtest_pivot.py 完全一致；僅供研究顯示，不產生任何委託、不觸發下單。
 */
export interface PivotLevels {
    mid: number;
    strong: number;
    weak: number;
}
export type PivotZone = 1 | 2 | 3 | 4 | 5 | 6;
export type PivotTone = 'long' | 'short' | 'neutral';

/** 中間價 M=(H+L)/2。
 *  M>=C（收盤偏弱）：強勢 L+(H-L)*1.382、弱勢 H-(H-L)*1.618；
 *  M< C（收盤偏強）：強勢 L+(H-L)*1.618、弱勢 H-(H-L)*1.382。 */
export function pivotLevels(prevHigh: number, prevLow: number, prevClose: number): PivotLevels {
    const range = prevHigh - prevLow;
    const mid = (prevHigh + prevLow) / 2;
    if (mid >= prevClose) {
        return { mid, strong: prevLow + range * 1.382, weak: prevHigh - range * 1.618 };
    }
    return { mid, strong: prevLow + range * 1.618, weak: prevHigh - range * 1.382 };
}

/** 開盤價由高到低落六分區：>強、強~昨高、昨高~中、中~昨低、昨低~弱、<弱。 */
export function pivotZone(price: number, lv: PivotLevels, prevHigh: number, prevLow: number): PivotZone {
    if (price > lv.strong) return 1;
    if (price > prevHigh) return 2;
    if (price > lv.mid) return 3;
    if (price > prevLow) return 4;
    if (price > lv.weak) return 5;
    return 6;
}

export const PIVOT_ZONE_LABEL: Record<PivotZone, string> = {
    1: '一 · 開盤>強勢價',
    2: '二 · 強勢價~昨高',
    3: '三 · 昨高~中間價',
    4: '四 · 中間價~昨低',
    5: '五 · 昨低~弱勢價',
    6: '六 · 開盤<弱勢價',
};

export interface PivotSignal {
    tone: PivotTone;
    title: string;
    text: string;
}

/** 只有極端區（一做多、六做空）給順勢訊號；中間分區於回測為負期望、一律不操作。 */
export function pivotSignal(zone: PivotZone): PivotSignal {
    if (zone === 1) {
        return {
            tone: 'long', title: '極強跳空 → 順勢做多',
            text: '開盤已越過強勢價，順勢做多 1 單位、死抱 13:25，盤中不加減碼。',
        };
    }
    if (zone === 6) {
        return {
            tone: 'short', title: '極弱跳空 → 順勢做空',
            text: '開盤已跌破弱勢價，順勢做空 1 單位、死抱 13:25，盤中不加減碼。',
        };
    }
    return {
        tone: 'neutral', title: '非極端落點 → 不操作',
        text: '開盤未越強勢價、也未破弱勢價；中間分區回測為負期望，今日無訊號。',
    };
}
