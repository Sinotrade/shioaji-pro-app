// 圖表元件測試共用：lightweight-charts 假實作與 1 分 K fixture
import { vi } from 'vitest';

export interface FakeSeries {
    kind: string;
    setData: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    last: unknown[];
    // applyOptions 合併後的選項（baseValue 等）與建立過的 price line
    options: Record<string, any>;
    priceLines: Record<string, any>[];
}

export const created: FakeSeries[] = [];

function chain(): any {
    const f: any = function () {
        return chain();
    };
    return new Proxy(f, {
        get: (_t, p) => {
            if (p === 'then') return undefined;
            if (p === Symbol.toPrimitive) return () => 0;
            if (p === 'getVisibleLogicalRange' || p === 'getVisibleRange')
                return () => null;
            if (p === 'coordinateToPrice' || p === 'priceToCoordinate')
                return () => null;
            if (p === 'panes') return () => [chain(), chain()];
            if (p === 'width' || p === 'height') return () => 500;
            return chain();
        },
        apply: () => chain(),
    });
}

export function makeSeries(kind: string): any {
    const s: FakeSeries = {
        kind,
        last: [],
        setData: vi.fn((d: unknown[]) => {
            s.last = d;
        }),
        update: vi.fn(),
        options: {},
        priceLines: [],
    };
    created.push(s);
    return new Proxy(s as any, {
        get: (t, p) => {
            if (p in t) return t[p];
            if (p === 'data') return () => s.last;
            if (p === 'dataByIndex') return () => null;
            if (p === 'applyOptions')
                return (o: Record<string, any>) => Object.assign(s.options, o);
            if (p === 'createPriceLine')
                return (o: Record<string, any>) => {
                    s.priceLines.push(o);
                    return chain();
                };
            return chain();
        },
    });
}

export function makeChart(): any {
    return new Proxy(
        {},
        {
            get: (_t, p) => {
                if (p === 'addSeries')
                    return (type: { kind: string }) => makeSeries(type.kind);
                if (p === 'then') return undefined;
                return chain();
            },
        },
    );
}

export function lwMock() {
    const k = (kind: string) => ({ kind });
    return {
        createChart: () => makeChart(),
        BarSeries: k('Bar'),
        BaselineSeries: k('Baseline'),
        CandlestickSeries: k('Candlestick'),
        HistogramSeries: k('Histogram'),
        LineSeries: k('Line'),
        AreaSeries: k('Area'),
        ColorType: { Solid: 'solid' },
        LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
        CrosshairMode: { Normal: 0, Magnet: 1, Hidden: 2 },
        PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2 },
        TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
        LastPriceAnimationMode: { Disabled: 0 },
        LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
        createSeriesMarkers: () => chain(),
    };
}

// ---- fixtures ----
const pad = (n: number) => String(n).padStart(2, '0');
export function isoFrom(sec: number) {
    const d = new Date(sec * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}
export const T = (s: string) => Date.parse(`${s}Z`) / 1000;

// 1-min kbars at labels (fromExcl, toIncl], price fn by label
export function kbars(
    ranges: [string, string, (t: number) => number][],
) {
    const k = {
        datetime: [] as string[],
        Open: [] as number[],
        High: [] as number[],
        Low: [] as number[],
        Close: [] as number[],
        Volume: [] as number[],
        Amount: [] as number[],
    };
    for (const [a, b, px] of ranges) {
        for (let t = T(a) + 60; t <= T(b); t += 60) {
            const p = px(t);
            k.datetime.push(isoFrom(t).replace('T', ' '));
            k.Open.push(p);
            k.High.push(p);
            k.Low.push(p);
            k.Close.push(p);
            k.Volume.push(10);
            k.Amount.push(p * 10);
        }
    }
    return k;
}
