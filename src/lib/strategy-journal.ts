import type { DaytradeInput } from './daytrade-picker';
import { STRATEGY_ENGINE_VERSIONS, type JournalSummary, type StrategyDecision, type StrategyEngineVersion, type StrategyFrame } from './strategy-lab-types';
import type { ContractInfo } from './types/contract';
import type { Candle, Snapshot } from './types/market';

// Deliberately separate from quote caches / accounts. Never evict an earlier
// observation, migrate another DB, fetch market data, or invoke trading APIs.
const DB_NAME = 'v9-strategy-journal-v1';
const STORES = ['frames', 'chunks', 'metadata'];
const MAX_FRAMES = 500;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
const encoder = new TextEncoder();
type Obj = Record<string, unknown>;
type StoredInput = Omit<DaytradeInput, 'daily' | 'minutes'> & { daily: string[]; minutes: string[] };
type Manifest = Omit<StrategyFrame, 'inputs'> & { inputs: StoredInput[] };
type FrameRecord = { id: string; fingerprint: string; manifest: Manifest; bytes: number };
type Chunk = { id: string; json: string; bytes: number };
type Prepared = { record: FrameRecord; chunks: Map<string, Chunk> };
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function invalid(field: string): never { throw new Error(`研究日誌資料格式不正確：${field}。`); }
function object(value: unknown, field: string): Obj {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(field);
    return value as Obj;
}
function str(value: unknown, field: string, max = 256, empty = false): string {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f]/.test(value)) invalid(field);
    return value;
}
function num(value: unknown, field: string, min = -Infinity, max = Infinity): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(field);
    return value;
}
function timestamp(value: unknown, field: string): number {
    const n = num(value, field, 0, 8.64e15);
    if (!Number.isSafeInteger(n)) invalid(field);
    return n;
}
function choice<T extends string | null>(value: unknown, values: readonly T[], field: string): T {
    if (!values.includes(value as T)) invalid(field);
    return value as T;
}
function strings(value: unknown, field: string, max: number, itemLength: number): string[] {
    if (!Array.isArray(value) || value.length > max) invalid(field);
    return value.map((v) => str(v, field, itemLength));
}

// Rebuild every object in a fixed key order. Unknown properties (including
// account/API credentials, order instructions, and prototype keys) never reach
// IndexedDB or an export. No spread of an untrusted input object is permitted.
function contract(value: unknown): ContractInfo {
    const v = object(value, 'contract');
    const result: Obj = {};
    if (v.region !== undefined) result.region = choice(v.region, ['TW', 'US', 'HK', 'JP'], 'region');
    result.exchange = choice(v.exchange, ['TSE', 'OTC', 'OES', 'TAIFEX', null], 'exchange');
    result.code = str(v.code, 'code', 64);
    result.security_type = choice(v.security_type, ['IND', 'STK', 'FUT', 'OPT', 'WRT', null], 'security_type');
    result.target_code = v.target_code === null ? null : str(v.target_code, 'target_code', 64, true);
    result.name = str(v.name, 'name', 256, true);
    result.currency = choice(v.currency, ['TWD', 'USD', 'CNY'], 'currency');
    for (const key of ['limit_up', 'limit_down', 'reference', 'margin_trading_balance', 'short_selling_balance']) result[key] = num(v[key], key, 0);
    result.day_trade = choice(v.day_trade, ['Yes', 'OnlyBuy', 'No', ''], 'day_trade');
    result.update_date = str(v.update_date, 'update_date', 64, true);
    result.category = str(v.category, 'category', 128, true);
    for (const key of ['unit', 'disposition_level', 'multiplier', 'contract_size', 'strike_price', 'tick', 'tick_value', 'exercise_ratio', 'issue_size']) {
        if (v[key] !== undefined) result[key] = num(v[key], key, 0);
    }
    for (const key of ['trading_suspended', 'attention_flag', 'below_ref_shortable', 'margin_shortable', 'sbl_shortable']) {
        if (v[key] !== undefined) {
            if (typeof v[key] !== 'boolean') invalid(key);
            result[key] = v[key];
        }
    }
    for (const key of ['settlement_type', 'size_unit', 'option_right', 'delivery_month', 'delivery_date', 'last_trading_date', 'root', 'underlying_code', 'underlying_kind', 'spec_kind', 'tick_rule', 'call_put', 'expiry_date', 'listing_date', 'financial']) {
        if (v[key] !== undefined) result[key] = str(v[key], key, 256, true);
    }
    if (v.combo !== undefined) {
        const c = object(v.combo, 'combo');
        if (!Array.isArray(c.legs) || !c.legs.length || c.legs.length > 8) invalid('combo.legs');
        result.combo = {
            code: str(c.code, 'combo.code', 64),
            legs: c.legs.map((raw) => {
                const leg = object(raw, 'combo.leg');
                return {
                    security_type: choice(leg.security_type, ['IND', 'STK', 'FUT', 'OPT', 'WRT', null], 'combo.security_type'),
                    region: str(leg.region, 'combo.region', 16),
                    exchange: leg.exchange === null ? null : str(leg.exchange, 'combo.exchange', 32),
                    code: str(leg.code, 'combo.code', 64),
                    target_code: leg.target_code === null ? null : str(leg.target_code, 'combo.target_code', 64, true),
                };
            }),
            combo_type: str(c.combo_type, 'combo_type', 64),
        };
    }
    return result as unknown as ContractInfo;
}
function candles(value: unknown, field: string): Candle[] {
    if (!Array.isArray(value) || value.length > 50_000) invalid(`${field}（最多 50,000 根）`);
    let previous = -1;
    return value.map((raw) => {
        const v = object(raw, field);
        const time = timestamp(v.time, `${field}.time`);
        if (time > 8.64e12 || time <= previous) invalid(`${field} 時間必須遞增且不可重複`);
        previous = time;
        const b = { time, open: num(v.open, 'open', Number.MIN_VALUE), high: num(v.high, 'high', Number.MIN_VALUE), low: num(v.low, 'low', Number.MIN_VALUE), close: num(v.close, 'close', Number.MIN_VALUE), volume: num(v.volume, 'volume', 0) };
        if (b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close, b.high)) invalid(`${field}.OHLC`);
        return b;
    });
}
function snapshot(value: unknown, code: string): Snapshot {
    const v = object(value, 'snapshot');
    const result: Obj = {};
    result.code = str(v.code, 'snapshot.code', 64);
    if (result.code !== code) invalid('snapshot 合約代碼不一致');
    for (const key of ['exchange', 'datetime', 'change_type', 'tick_type']) result[key] = str(v[key], `snapshot.${key}`, 100, key !== 'datetime');
    for (const key of ['open', 'high', 'low', 'close', 'average_price', 'buy_price', 'buy_volume', 'sell_price', 'sell_volume', 'volume', 'total_volume', 'amount', 'total_amount', 'volume_ratio', 'yesterday_volume']) result[key] = num(v[key], `snapshot.${key}`, 0);
    for (const key of ['change_price', 'change_rate']) result[key] = num(v[key], `snapshot.${key}`);
    return result as unknown as Snapshot;
}
function canonicalFrame(value: unknown): StrategyFrame {
    const v = object(value, 'frame');
    if (v.schemaVersion !== 1) invalid('schemaVersion（僅支援 1）');
    if (typeof v.engineVersion !== 'string' || !STRATEGY_ENGINE_VERSIONS.includes(v.engineVersion as StrategyEngineVersion)) invalid('engineVersion（不支援此判斷引擎版本）');
    const sourceKey = str(v.sourceKey, 'sourceKey', 512);
    if (/https?:\/\/[^/\s]*@|[?&#]|(?:token|password|secret|api[_-]?key)\s*[:=]/i.test(sourceKey)) invalid('sourceKey 不可含認證資訊或 URL 參數');
    const poolCodes = strings(v.poolCodes, 'poolCodes', 40, 64);
    if (new Set(poolCodes).size !== poolCodes.length) invalid('poolCodes 重複代碼');
    if (!Array.isArray(v.inputs) || v.inputs.length > 40) invalid('inputs（最多 40 檔）');
    const codes = new Set<string>();
    const inputs: DaytradeInput[] = v.inputs.map((raw) => {
        const input = object(raw, 'input');
        const c = contract(input.contract);
        if (codes.has(c.code) || !poolCodes.includes(c.code)) invalid('inputs 代碼重複或不在股票池');
        codes.add(c.code);
        const clean: DaytradeInput = { contract: c, daily: candles(input.daily, 'daily'), minutes: candles(input.minutes, 'minutes') };
        if (input.snapshot !== undefined) clean.snapshot = snapshot(input.snapshot, c.code);
        if (input.shortSource !== undefined) {
            const s = object(input.shortSource, 'shortSource');
            clean.shortSource = { quantity: num(s.quantity, 'shortSource.quantity', 0), datetime: str(s.datetime, 'shortSource.datetime', 100) };
        }
        return clean;
    });
    if (!Array.isArray(v.decisions) || v.decisions.length > 120) invalid('decisions（最多 120 列）');
    const decisions: StrategyDecision[] = v.decisions.map((raw) => {
        const d = object(raw, 'decision');
        const code = str(d.code, 'decision.code', 64);
        if (!poolCodes.includes(code)) invalid('decision 不在股票池');
        const decision: StrategyDecision = { code, kind: choice(d.kind, ['confirmed', 'observation', 'excluded'], 'decision.kind'), reasons: strings(d.reasons, 'decision.reasons', 64, 2048) };
        if (d.side !== undefined) decision.side = choice(d.side, ['long', 'short'] as const, 'decision.side');
        return decision;
    });
    const result: StrategyFrame = { schemaVersion: 1, engineVersion: v.engineVersion as StrategyEngineVersion, id: str(v.id, 'id', 128), capturedAt: timestamp(v.capturedAt, 'capturedAt'), sourceKey, inputs, poolCodes, warnings: strings(v.warnings, 'warnings', 200, 2048), decisions };
    if (v.indexChangeRate !== undefined) result.indexChangeRate = num(v.indexChangeRate, 'indexChangeRate');
    if (v.indexAsOf !== undefined) result.indexAsOf = timestamp(v.indexAsOf, 'indexAsOf');
    return result;
}
async function digest(value: string): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('研究日誌無法使用 SHA-256；本次未保存，請使用安全的本機瀏覽器環境。');
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function prepare(frame: StrategyFrame): Promise<Prepared> {
    const chunks = new Map<string, Chunk>();
    const inputs: StoredInput[] = [];
    for (const input of frame.inputs) {
        const contractKey = [input.contract.region ?? 'TW', input.contract.security_type, input.contract.exchange, input.contract.code];
        const makeChunk = async (kind: string, bars: Candle[], day?: number) => {
            const json = JSON.stringify({ sourceKey: frame.sourceKey, contractKey, kind, day, candles: bars });
            const id = await digest(json);
            chunks.set(id, { id, json, bytes: encoder.encode(json).byteLength });
            return id;
        };
        const daily = input.daily.length ? [await makeChunk('daily', input.daily)] : [];
        const groups = new Map<number, Candle[]>();
        for (const bar of input.minutes) {
            // Candle timestamps use the adapter's exchange-session day labels.
            const day = Math.floor(bar.time / 86_400);
            const group = groups.get(day) ?? [];
            group.push(bar);
            groups.set(day, group);
        }
        const minutes: string[] = [];
        for (const [day, bars] of groups) minutes.push(await makeChunk('minutes', bars, day));
        const stored: StoredInput = { contract: input.contract, daily, minutes };
        if (input.snapshot) stored.snapshot = input.snapshot;
        if (input.shortSource) stored.shortSource = input.shortSource;
        inputs.push(stored);
    }
    const manifest: Manifest = { ...frame, inputs };
    const json = JSON.stringify(manifest);
    return { record: { id: frame.id, fingerprint: await digest(json), manifest, bytes: encoder.encode(json).byteLength }, chunks };
}
function storageError(error: unknown): Error {
    if (error instanceof Error && error.message.startsWith('研究日誌')) return error;
    const quota = error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError';
    return new Error(quota ? '研究日誌儲存空間不足；本次未保存，既有日誌保留。請先匯出備份並確認瀏覽器儲存空間。' : '研究日誌無法讀寫 IndexedDB；本次未保存，未改用暫存記憶體。請確認瀏覽器儲存權限後重試。');
}
function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(storageError(undefined)); return; }
        let failed = false;
        let req: IDBOpenDBRequest;
        try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(storageError(e)); return; }
        req.onupgradeneeded = () => {
            for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
        };
        req.onerror = () => reject(storageError(req.error));
        req.onblocked = () => { failed = true; reject(new Error('研究日誌資料庫被其他視窗占用，請關閉舊研究視窗後重試；本次未保存。')); };
        req.onsuccess = () => {
            if (failed) { req.result.close(); return; }
            req.result.onversionchange = () => req.result.close();
            resolve(req.result);
        };
    });
}
function emit(): void {
    for (const listener of listeners) { try { listener(); } catch { /* A UI listener must not turn a committed write into failure. */ } }
}
function broadcast(): void {
    emit();
    try {
        if (channel) channel.postMessage('committed');
        else if (typeof BroadcastChannel !== 'undefined') {
            const oneShot = new BroadcastChannel(DB_NAME);
            oneShot.postMessage('committed');
            oneShot.close();
        }
    } catch { /* Notifications are best-effort; durable commit is already complete. */ }
}
export function subscribeStrategyJournal(listener: () => void): () => void {
    listeners.add(listener);
    if (!channel && typeof BroadcastChannel !== 'undefined') {
        try { channel = new BroadcastChannel(DB_NAME); channel.onmessage = (event) => { if (event.data === 'committed') emit(); }; } catch { /* Local subscription still works. */ }
    }
    return () => { listeners.delete(listener); if (!listeners.size) { channel?.close(); channel = undefined; } };
}

async function persist(prepared: Prepared[]): Promise<number> {
    const unique = new Map<string, Prepared>();
    for (const item of prepared) {
        const previous = unique.get(item.record.id);
        if (previous && previous.record.fingerprint !== item.record.fingerprint) throw new Error('研究日誌同一 ID 出現不同內容；拒絕整批匯入，既有日誌未變更。');
        unique.set(item.record.id, item);
    }
    if (!unique.size) return 0;
    const db = await openDatabase();
    try {
        const added = await new Promise<number>((resolve, reject) => {
            // All content hashing has completed. Capacity checks and inserts are
            // in this single shared readwrite transaction, including across tabs.
            const tx = db.transaction(STORES, 'readwrite');
            const frames = tx.objectStore('frames');
            const chunks = tx.objectStore('chunks');
            const meta = tx.objectStore('metadata');
            let failure: Error | undefined;
            let inserted = 0;
            const abort = (message: string) => { failure = new Error(message); tx.abort(); };
            tx.onabort = () => reject(failure ?? storageError(tx.error));
            tx.onerror = () => { /* Default request error handling atomically aborts. */ };
            tx.oncomplete = () => resolve(inserted);
            const countReq = frames.count();
            const totalReq = meta.get('totals');
            const newFrames: Prepared[] = [];
            let pending = unique.size + 2;
            const ready = () => {
                if (--pending || failure) return;
                const count = countReq.result;
                const totals = totalReq.result as { bytes: number } | undefined;
                if ((count && !totals) || (totals && (!Number.isSafeInteger(totals.bytes) || totals.bytes < 0))) { abort('研究日誌容量紀錄損壞，停止寫入並保留既有資料。'); return; }
                if (count + newFrames.length > MAX_FRAMES) { abort('研究日誌已達 500 筆上限；本次未保存，既有日誌保留。請先匯出備份。'); return; }
                if (!newFrames.length) return;
                const candidates = new Map<string, Chunk>();
                for (const item of newFrames) for (const [id, chunk] of item.chunks) candidates.set(id, chunk);
                const missing: Chunk[] = [];
                const finish = () => {
                    const bytes = (totals?.bytes ?? 0) + newFrames.reduce((sum, f) => sum + f.record.bytes, 0) + missing.reduce((sum, c) => sum + c.bytes, 0);
                    if (bytes > MAX_BYTES) { abort('研究日誌已達 128 MiB 容量上限；本次未保存，既有日誌保留。請先匯出備份。'); return; }
                    for (const chunk of missing) chunks.add(chunk);
                    for (const item of newFrames) frames.add(item.record);
                    meta.put({ id: 'totals', bytes });
                    inserted = newFrames.length;
                };
                let remaining = candidates.size;
                if (!remaining) { finish(); return; }
                for (const [id, chunk] of candidates) {
                    const req = chunks.get(id);
                    req.onsuccess = () => {
                        if (failure) return;
                        if (req.result === undefined) missing.push(chunk);
                        else if ((req.result as Chunk).json !== chunk.json) { abort('研究日誌歷史區塊校驗不一致，停止寫入並保留既有資料。'); return; }
                        if (!--remaining) finish();
                    };
                }
            };
            countReq.onsuccess = ready;
            totalReq.onsuccess = ready;
            for (const item of unique.values()) {
                const req = frames.get(item.record.id);
                req.onsuccess = () => {
                    if (failure) return;
                    const previous = req.result as FrameRecord | undefined;
                    if (previous && previous.fingerprint !== item.record.fingerprint) { abort('研究日誌 ID 已存在但內容不同；拒絕覆蓋，既有日誌未變更。'); return; }
                    if (!previous) newFrames.push(item);
                    ready();
                };
            }
        });
        if (added) broadcast();
        return added;
    } catch (e) { throw storageError(e); } finally { db.close(); }
}

export async function appendStrategyFrame(frame: StrategyFrame): Promise<void> {
    // Clone/validate synchronously before any await so callers cannot mutate a
    // capture while SHA-256 / IDB are pending.
    const clean = canonicalFrame(frame);
    await persist([await prepare(clean)]);
}
export async function listStrategyFrames(): Promise<JournalSummary[]> {
    const db = await openDatabase();
    try {
        return await new Promise<JournalSummary[]>((resolve, reject) => {
            const tx = db.transaction('frames', 'readonly');
            const req = tx.objectStore('frames').getAll();
            tx.onabort = () => reject(storageError(tx.error));
            tx.oncomplete = () => resolve((req.result as FrameRecord[]).map(({ manifest: f }) => ({ id: f.id, capturedAt: f.capturedAt, sourceKey: f.sourceKey, poolSize: f.poolCodes.length, warnings: [...f.warnings] })).sort((a, b) => b.capturedAt - a.capturedAt || a.id.localeCompare(b.id)));
        });
    } catch (e) { throw storageError(e); } finally { db.close(); }
}
export async function loadStrategyFrame(id: string): Promise<StrategyFrame> {
    str(id, 'id', 128);
    const db = await openDatabase();
    let record: FrameRecord | undefined;
    const chunks = new Map<string, Chunk>();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['frames', 'chunks'], 'readonly');
            const req = tx.objectStore('frames').get(id);
            tx.onabort = () => reject(storageError(tx.error));
            tx.oncomplete = () => resolve();
            req.onsuccess = () => {
                record = req.result as FrameRecord | undefined;
                if (!record) return;
                const ids = new Set(record.manifest.inputs.flatMap((i) => [...i.daily, ...i.minutes]));
                for (const key of ids) {
                    const read = tx.objectStore('chunks').get(key);
                    read.onsuccess = () => { if (read.result) chunks.set(key, read.result as Chunk); };
                }
            };
        });
    } catch (e) { throw storageError(e); } finally { db.close(); }
    if (!record) throw new Error('研究日誌找不到指定紀錄；未使用目前行情代替。');
    for (const chunk of chunks.values()) if (await digest(chunk.json) !== chunk.id) throw new Error('研究日誌歷史區塊校驗失敗；停止回放。');
    const bars = (ids: string[]): Candle[] => ids.flatMap((key) => {
        const chunk = chunks.get(key);
        if (!chunk) throw new Error('研究日誌缺少歷史區塊；停止回放，未補抓目前行情。');
        return (JSON.parse(chunk.json) as { candles: Candle[] }).candles;
    });
    const frame = canonicalFrame({ ...record.manifest, inputs: record.manifest.inputs.map((input) => ({ ...input, daily: bars(input.daily), minutes: bars(input.minutes) })) });
    if ((await prepare(frame)).record.fingerprint !== record.fingerprint) throw new Error('研究日誌內容校驗失敗；停止回放。');
    return frame;
}
function oneSource(frames: StrategyFrame[]): void {
    if (new Set(frames.map((f) => f.sourceKey)).size > 1) throw new Error('研究日誌不可在同一檔案混合不同資料來源；請依來源分批匯入或匯出。');
}
export async function exportStrategyJournal(ids: string[]): Promise<string> {
    if (!Array.isArray(ids) || ids.length > MAX_FRAMES) invalid('匯出筆數');
    const frames: StrategyFrame[] = [];
    let bytes = 0;
    for (const id of new Set(ids)) {
        const frame = await loadStrategyFrame(id);
        bytes += encoder.encode(JSON.stringify(frame)).byteLength;
        if (bytes > MAX_TRANSFER_BYTES - 1024) throw new Error('研究日誌匯出超過 50 MiB，請減少勾選筆數後分批匯出。');
        frames.push(frame);
    }
    oneSource(frames);
    return JSON.stringify({ schemaVersion: 1, frames });
}
export async function importStrategyJournal(text: string): Promise<number> {
    if (typeof text !== 'string' || text.length > MAX_TRANSFER_BYTES || encoder.encode(text).byteLength > MAX_TRANSFER_BYTES) throw new Error('研究日誌匯入上限為 50 MiB；請使用較小的分批備份檔。');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('研究日誌 JSON 無法解析；未寫入任何資料。'); }
    const bundle = object(parsed, 'bundle');
    if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.frames) || bundle.frames.length > MAX_FRAMES) invalid('bundle schemaVersion 或筆數（最多 500 筆）');
    const frames = bundle.frames.map(canonicalFrame);
    oneSource(frames);
    const prepared: Prepared[] = [];
    for (const frame of frames) prepared.push(await prepare(frame));
    return persist(prepared);
}
