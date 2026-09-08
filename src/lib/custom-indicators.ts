// src/lib/custom-indicators.ts — user-defined indicator store + registry.
// Custom indicators are written in the in-app editor (JS + ta.* helpers),
// persisted to localStorage, and registered into DEF_BY_TYPE as dynamic
// IndicatorDefs（type = "custom:<id>"）so the picker / settings modal /
// legend / pane rendering all work unchanged.
//
// Importing this module registers all saved customs synchronously — the
// chart imports it before loadInstances() runs, so persisted instances of
// custom types survive the DEF_BY_TYPE.has() filter.

import { runCustom, type BarsInput, type CustomRunResult } from './custom-runtime';
import {
    DEF_BY_TYPE,
    type IndicatorDef,
    type OutputDef,
    type ParamDef,
} from './indicator-defs';
import type { IndicatorPoint } from './indicators';
import type { Candle } from './types/market';

export interface CustomIndicator {
    id: string;
    name: string; // 顯示名稱，e.g. "我的動能"
    short: string; // legend 縮寫
    desc: string;
    category: 'overlay' | 'pane';
    params: ParamDef[];
    outputs: OutputDef[]; // 驗證時偵測 + 使用者微調
    levels?: number[];
    source: string;
    updatedAt: number;
}

const STORE_KEY = 'sj-pro-custom-inds-v1';
export const CUSTOM_PREFIX = 'custom:';
export const customType = (id: string) => `${CUSTOM_PREFIX}${id}`;

// 驗證/偵測輸出時分配的預設色序
export const CUSTOM_PALETTE = [
    '#e0a43c',
    '#3d8bff',
    '#1fd286',
    '#b06fff',
    '#ff8a3d',
    '#19b6c9',
    '#ff4d6a',
    '#8b94a7',
];

function load(): CustomIndicator[] {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) return JSON.parse(raw) as CustomIndicator[];
    } catch {
        // fresh
    }
    return [];
}

function persist() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(customs));
    } catch {
        // storage full/unavailable — keep in-memory
    }
}

let customs: CustomIndicator[] = load();

const listeners = new Set<() => void>();
export function subscribeCustoms(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
function notify() {
    for (const l of listeners) l();
}

export function listCustoms(): CustomIndicator[] {
    return customs;
}

export function getCustom(id: string): CustomIndicator | undefined {
    return customs.find((c) => c.id === id);
}

export function newCustomId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function toBarsInput(bars: Candle[]): BarsInput {
    const n = bars.length;
    const time = new Array<number>(n);
    const open = new Array<number>(n);
    const high = new Array<number>(n);
    const low = new Array<number>(n);
    const close = new Array<number>(n);
    const volume = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        const b = bars[i]!;
        time[i] = b.time;
        open[i] = b.open;
        high[i] = b.high;
        low[i] = b.low;
        close[i] = b.close;
        volume[i] = b.volume;
    }
    return { time, open, high, low, close, volume };
}

function toDef(c: CustomIndicator): IndicatorDef {
    const outputs: OutputDef[] =
        c.outputs.length > 0
            ? c.outputs
            : [{ key: 'plot', label: '輸出', kind: 'line', color: CUSTOM_PALETTE[0]! }];
    return {
        type: customType(c.id),
        label: c.name,
        short: c.short || c.name,
        desc: c.desc || '自訂指標',
        aliases: ['custom', '自訂', c.name, c.short].filter(Boolean),
        category: c.category,
        params: c.params,
        outputs,
        ...(c.levels && c.levels.length > 0 ? { levels: c.levels } : {}),
        compute: (bars, p) => {
            // 儲存前已在 worker 驗證過；這裡同步跑（呼叫端有 try/catch）
            const res = runCustom(c.source, toBarsInput(bars), p);
            if (res.error) throw new Error(res.error);
            const out: Record<string, IndicatorPoint[]> = {};
            for (const o of outputs) {
                // band 輸出多帶一條下緣序列 `<key>_lo`
                const keys =
                    o.kind === 'band' ? [o.key, `${o.key}_lo`] : [o.key];
                for (const k of keys) {
                    const ser = res.outputs[k];
                    if (!ser) continue;
                    out[k] = bars.map((b, i) =>
                        ser[i] === null || ser[i] === undefined
                            ? { time: b.time }
                            : { time: b.time, value: ser[i]! },
                    );
                }
            }
            return out;
        },
    };
}

export function saveCustom(c: CustomIndicator) {
    const idx = customs.findIndex((x) => x.id === c.id);
    if (idx >= 0) customs = customs.map((x) => (x.id === c.id ? c : x));
    else customs = [...customs, c];
    persist();
    DEF_BY_TYPE.set(customType(c.id), toDef(c));
    notify();
}

export function deleteCustom(id: string) {
    customs = customs.filter((c) => c.id !== id);
    persist();
    DEF_BY_TYPE.delete(customType(id));
    notify();
}

// ---- validation（Web Worker + 逾時，擋無窮迴圈）----

// deterministic sample bars（seeded LCG random walk）for validation runs
export function sampleBars(count = 300): BarsInput {
    let seed = 42;
    const rnd = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };
    const time: number[] = [];
    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const volume: number[] = [];
    let price = 1000;
    const t0 = 1735689600; // 固定起點，驗證結果可重現
    for (let i = 0; i < count; i++) {
        const o = price;
        const c = o * (1 + (rnd() - 0.5) * 0.02);
        const h = Math.max(o, c) * (1 + rnd() * 0.005);
        const l = Math.min(o, c) * (1 - rnd() * 0.005);
        time.push(t0 + i * 60);
        open.push(o);
        high.push(h);
        low.push(l);
        close.push(c);
        volume.push(Math.round(rnd() * 500) + 10);
        price = c;
    }
    return { time, open, high, low, close, volume };
}

const VALIDATE_TIMEOUT_MS = 2000;

export function validateCustom(
    source: string,
    params: Record<string, number>,
    bars?: BarsInput,
): Promise<CustomRunResult> {
    const input = bars ?? sampleBars();
    return new Promise((resolve) => {
        let worker: Worker;
        try {
            worker = new Worker(
                new URL('./custom-worker.ts', import.meta.url),
                { type: 'module' },
            );
        } catch {
            // worker 不可用 — 退回主執行緒（沒有逾時保護）
            resolve(runCustom(source, input, params));
            return;
        }
        const fail = (error: string) =>
            resolve({ outputs: {}, order: [], hints: {}, levels: [], error });
        const timer = setTimeout(() => {
            worker.terminate();
            fail(`執行超過 ${VALIDATE_TIMEOUT_MS / 1000} 秒 — 檢查是否有無窮迴圈`);
        }, VALIDATE_TIMEOUT_MS);
        worker.onmessage = (e: MessageEvent<CustomRunResult>) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(e.data);
        };
        worker.onerror = (e) => {
            clearTimeout(timer);
            worker.terminate();
            fail(e.message || '程式碼執行錯誤');
        };
        worker.postMessage({ source, bars: input, params });
    });
}

// register everything saved from previous sessions（module import 時同步跑）
for (const c of customs) {
    DEF_BY_TYPE.set(customType(c.id), toDef(c));
}
