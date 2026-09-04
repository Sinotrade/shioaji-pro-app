// src/lib/custom-runtime.ts — compile & run user-written indicator source.
// Pure module (no DOM / app imports) shared by the chart (sync compute) and
// the validation Web Worker. User code runs via new Function against a ctx
// of bar arrays + the ta.* helpers; plot() / hline() collect the outputs.

import * as ta from './ta';
import type { Ser } from './ta';

export interface PlotHint {
    color?: string;
    kind?: 'line' | 'dashed' | 'histogram' | 'points' | 'band';
    signed?: boolean;
    width?: 1 | 2;
    // band only: 上下緣線型
    border?: 'solid' | 'dashed';
}

export interface CustomRunResult {
    outputs: Record<string, Ser>;
    order: string[]; // plot() 呼叫順序
    hints: Record<string, PlotHint>;
    levels: number[];
    error?: string;
}

export interface BarsInput {
    time: number[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
}

const EMPTY: CustomRunResult = { outputs: {}, order: [], hints: {}, levels: [] };

type Compiled = (ctx: Record<string, unknown>) => void;
const cache = new Map<string, Compiled>();

// destructure the ctx so user code reads like Pine: close / p.len / ta.sma()
const PREAMBLE =
    'const {bars,time,open,high,low,close,volume,hl2,hlc3,ohlc4,p,ta,plot,hline,band}=ctx;';

function compile(source: string): Compiled {
    let fn = cache.get(source);
    if (!fn) {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        fn = new Function(
            'ctx',
            `"use strict";${PREAMBLE}\n${source}`,
        ) as Compiled;
        cache.set(source, fn);
    }
    return fn;
}

export function runCustom(
    source: string,
    bars: BarsInput,
    params: Record<string, number>,
): CustomRunResult {
    const n = bars.close.length;
    const outputs: Record<string, Ser> = {};
    const order: string[] = [];
    const hints: Record<string, PlotHint> = {};
    const levels: number[] = [];

    const hl2: number[] = new Array(n);
    const hlc3: number[] = new Array(n);
    const ohlc4: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = bars.open[i]!;
        const h = bars.high[i]!;
        const l = bars.low[i]!;
        const c = bars.close[i]!;
        hl2[i] = (h + l) / 2;
        hlc3[i] = (h + l + c) / 3;
        ohlc4[i] = (o + h + l + c) / 4;
    }

    const plot = (name: unknown, series: unknown, opts?: PlotHint) => {
        if (typeof name !== 'string' || name.trim() === '') {
            throw new Error('plot() 第一個參數要是輸出名稱字串');
        }
        if (!Array.isArray(series)) {
            throw new Error(`plot('${name}') 第二個參數要是序列（陣列）`);
        }
        const ser: Ser = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
            const v = (series as unknown[])[i];
            ser[i] =
                typeof v === 'number' && Number.isFinite(v) ? v : null;
        }
        if (!(name in outputs)) order.push(name);
        outputs[name] = ser;
        if (opts && typeof opts === 'object') {
            hints[name] = {
                ...(typeof opts.color === 'string'
                    ? { color: opts.color }
                    : {}),
                ...(opts.kind ? { kind: opts.kind } : {}),
                ...(opts.signed ? { signed: true } : {}),
                ...(opts.width ? { width: opts.width } : {}),
            };
        }
    };

    const hline = (v: unknown) => {
        if (typeof v === 'number' && Number.isFinite(v)) levels.push(v);
    };

    // band('名稱', 上緣序列或常數, 下緣序列或常數, opts) — 主圖價格帶。
    // 常數自動展開成整條序列；下緣存到 `<name>_lo`（不進 order，
    // 由 chart 的 band 分支一起取用）。
    const band = (
        name: unknown,
        upper: unknown,
        lower: unknown,
        opts?: PlotHint,
    ) => {
        if (typeof name !== 'string' || name.trim() === '') {
            throw new Error('band() 第一個參數要是輸出名稱字串');
        }
        const toSer = (v: unknown, which: string): Ser => {
            if (typeof v === 'number' && Number.isFinite(v)) {
                return new Array<number | null>(n).fill(v);
            }
            if (!Array.isArray(v)) {
                throw new Error(
                    `band('${name}') ${which}要是序列（陣列）或數字`,
                );
            }
            const ser: Ser = new Array(n).fill(null);
            for (let i = 0; i < n; i++) {
                const x = (v as unknown[])[i];
                ser[i] =
                    typeof x === 'number' && Number.isFinite(x) ? x : null;
            }
            return ser;
        };
        if (!(name in outputs)) order.push(name);
        outputs[name] = toSer(upper, '上緣');
        outputs[`${name}_lo`] = toSer(lower, '下緣');
        hints[name] = {
            kind: 'band',
            ...(opts && typeof opts.color === 'string'
                ? { color: opts.color }
                : {}),
            ...(opts?.border ? { border: opts.border } : {}),
            ...(opts?.width ? { width: opts.width } : {}),
        };
    };

    const ctx = {
        bars,
        time: bars.time,
        open: bars.open,
        high: bars.high,
        low: bars.low,
        close: bars.close,
        volume: bars.volume,
        hl2,
        hlc3,
        ohlc4,
        p: params,
        ta,
        plot,
        hline,
        band,
    };

    try {
        compile(source)(ctx);
    } catch (e) {
        return {
            ...EMPTY,
            error: e instanceof Error ? e.message : String(e),
        };
    }
    if (order.length === 0) {
        return {
            ...EMPTY,
            error: '程式碼沒有呼叫 plot() / band() — 至少要輸出一條序列',
        };
    }
    return { outputs, order, hints, levels };
}
