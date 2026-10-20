// src/lib/index-components.ts — 指數成分 (index_components, shioaji 1.7.4)
// session 級 store：每條 (指數, 投影) 一份狀態，事件整包替換、
// calculated_at 新者勝。建底查詢紀律見 docs/adr/0001 — 僅「首次＋日切」，
// 日切由串流事件的 date 驅動（不看牆上時鐘）；斷線重連不重查（capability
// registry 會重播訂閱，事件自足）；429 日額度用盡即降級不繞路。

import {
    fetchIndexComponents,
    subscribeIndexComponents,
    unsubscribeIndexComponents,
} from './shioaji';
import {
    ensureStream,
    onStreamEvent,
    streamConnectionEpoch,
} from './stream';
import type { ContractBase } from './types/contract';
import type {
    IcGroupMetric,
    IcGroupRow,
    IcProjection,
    IcProjectionState,
    IcRankingEntry,
} from './types/market';

// ---- wire 型別（1.7.4 實測：decimal 一律字串、ppm/bps 為整數）----

interface RawQueryEntry {
    contract: { code: string };
    category: string;
    price: string;
    reference: string;
    price_chg: string;
    pct_chg: string;
    points: string;
    reference_weight_ppm: number;
    total_amount: number;
    amount_share_bps: number;
    price_source: string;
    trading_status: string;
    data_status: string;
}

interface RawQueryGroup {
    category: string;
    name: string;
    item_count: number;
    equal_weight_pct_chg: string;
    weighted_pct_chg: string;
    points: string;
    reference_weight_ppm: number;
    total_amount: number;
    amount_share_bps: number;
    advance_count: number;
    decline_count: number;
    unchanged_count: number;
    breadth_bps: number;
}

export interface RawIndexComponentsSnapshot {
    contract: { code: string };
    date: string;
    time: string;
    calculated_at: string;
    reference_date: string;
    market_phase: string;
    refresh_state: string;
    simtrade: boolean;
    total_amount: number;
    entries: RawQueryEntry[];
    groups: RawQueryGroup[];
}

interface RawRankingEventEntry {
    code: string;
    category: string;
    value: string;
    price: string;
    reference: string;
    price_chg: string;
    pct_chg: string;
    reference_weight_ppm: number;
    price_source: string;
    trading_status: string;
    data_status: string;
}

interface RawEvent {
    contract: { code: string };
    projection: IcProjection;
    date: string;
    time: string;
    calculated_at: string;
    market_phase: string;
    simtrade: boolean;
    entries?: RawRankingEventEntry[];
    groups?: { category: string; name: string; item_count: number; value: string }[];
}

// ---- 投影 key 與 wire body ----

export function projectionKey(p: IcProjection): string {
    return p.kind === 'group_metric'
        ? `gm:${p.metric}`
        : `rk:${p.metric}:${p.order}:${p.limit}${p.group ? `:g${p.group}` : ''}`;
}

function projectionBody(p: IcProjection): Record<string, unknown> {
    if (p.kind === 'group_metric') {
        return { kind: 'group_metric', metric: p.metric };
    }
    const body: Record<string, unknown> = {
        kind: 'ranking',
        target: p.target,
        metric: p.metric,
        order: p.order,
        limit: p.limit,
    };
    if (p.group !== undefined) body.group = p.group;
    return body;
}

const num = (value: string | number) => Number(value);

// ---- 查詢 snapshot → 投影初始態（官方映射，不從價格重算）----

function groupMetricValue(group: RawQueryGroup, metric: IcGroupMetric): number {
    switch (metric) {
        case 'contribution':
            return num(group.points);
        case 'amount':
            return group.total_amount;
        case 'weighted_performance':
            return num(group.weighted_pct_chg);
        case 'weight':
            return group.reference_weight_ppm / 10_000;
    }
}

export function projectFromSnapshot(
    snapshot: RawIndexComponentsSnapshot,
    projection: IcProjection,
): IcProjectionState {
    const base = {
        date: snapshot.date,
        calculatedAt: snapshot.calculated_at,
        marketPhase: snapshot.market_phase,
        simtrade: snapshot.simtrade,
    };
    if (projection.kind === 'group_metric') {
        const groups: IcGroupRow[] = snapshot.groups.map((group) => ({
            category: group.category,
            name: group.name,
            item_count: group.item_count,
            value: groupMetricValue(group, projection.metric),
        }));
        return { kind: 'group_metric', ...base, groups };
    }
    let rows = snapshot.entries
        .filter(
            (entry) =>
                projection.group === undefined ||
                entry.category === projection.group,
        )
        .map((entry) => ({
            entry,
            value:
                projection.metric === 'amount'
                    ? entry.total_amount
                    : num(entry.points),
        }));
    if (projection.order === 'positive_desc') {
        rows = rows.filter((row) => row.value > 0);
    } else if (projection.order === 'negative_asc') {
        rows = rows.filter((row) => row.value < 0);
    }
    rows.sort((a, b) => {
        const diff =
            projection.order === 'negative_asc'
                ? a.value - b.value
                : projection.order === 'abs_desc'
                  ? Math.abs(b.value) - Math.abs(a.value)
                  : b.value - a.value;
        return diff !== 0
            ? diff
            : a.entry.contract.code < b.entry.contract.code
              ? -1
              : 1;
    });
    const entries: IcRankingEntry[] = rows
        .slice(0, projection.limit)
        .map(({ entry, value }) => ({
            code: entry.contract.code,
            category: entry.category,
            value,
            price: num(entry.price),
            reference: num(entry.reference),
            price_chg: num(entry.price_chg),
            pct_chg: num(entry.pct_chg),
            weight_pct: entry.reference_weight_ppm / 10_000,
            price_source: entry.price_source,
            trading_status: entry.trading_status,
            data_status: entry.data_status,
        }));
    return { kind: 'ranking', ...base, entries };
}

export function parseIcEvent(raw: string): {
    code: string;
    projKey: string;
    state: IcProjectionState;
} | null {
    const event = JSON.parse(raw) as RawEvent;
    if (!event.contract?.code || !event.projection) return null;
    const base = {
        date: event.date,
        calculatedAt: event.calculated_at,
        marketPhase: event.market_phase,
        simtrade: event.simtrade,
    };
    const state: IcProjectionState = event.entries
        ? {
              kind: 'ranking',
              ...base,
              entries: event.entries.map((entry) => ({
                  code: entry.code,
                  category: entry.category,
                  value: num(entry.value),
                  price: num(entry.price),
                  reference: num(entry.reference),
                  price_chg: num(entry.price_chg),
                  pct_chg: num(entry.pct_chg),
                  weight_pct: entry.reference_weight_ppm / 10_000,
                  price_source: entry.price_source,
                  trading_status: entry.trading_status,
                  data_status: entry.data_status,
              })),
          }
        : {
              kind: 'group_metric',
              ...base,
              groups: (event.groups ?? []).map((group) => ({
                  category: group.category,
                  name: group.name,
                  item_count: group.item_count,
                  value: num(group.value),
              })),
          };
    return {
        code: event.contract.code,
        projKey: projectionKey(event.projection),
        state,
    };
}

// ---- store ----

export type IcBootstrapStatus =
    | 'idle'
    | 'pending'
    | 'ready'
    | 'quota'
    | 'error';

type Listener = () => void;

const states = new Map<string, IcProjectionState>(); // `${code}|${projKey}`
const subErrors = new Map<string, string>(); // 訂閱失敗訊息（同 key）
const refs = new Map<string, number>();
const active = new Map<string, Map<string, IcProjection>>(); // code → projKey → projection
const bootstraps = new Map<string, RawIndexComponentsSnapshot>();
const bootstrapStatus = new Map<string, IcBootstrapStatus>();
const bootstrapErrors = new Map<string, string>();
const bootstrapInFlight = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();
let version = 0;
let detachStream: (() => void) | null = null;

function emit() {
    version += 1;
    listeners.forEach((listener) => listener());
}

export function subscribeIcStore(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getIcVersion() {
    return version;
}

export function getIcState(code: string, projKey: string) {
    return states.get(`${code}|${projKey}`);
}

export function getIcSubError(code: string, projKey: string) {
    return subErrors.get(`${code}|${projKey}`);
}

// 群組參考權重（佔指數 %）— 參考市值基準、盤中恆定，由建底快照供應
// （零額外查詢）。用於下鑽層反推「其他成員」的加權漲跌幅。
export function getIcBootstrapGroupWeights(
    code: string,
): ReadonlyMap<string, number> | undefined {
    const snapshot = bootstraps.get(code);
    if (!snapshot) return undefined;
    return new Map(
        snapshot.groups.map((group) => [
            group.category,
            group.reference_weight_ppm / 10_000,
        ]),
    );
}

// ---- 群組加權漲跌依時間配對（#330 下鑽「其他成員」反推）----
//
// 伺服器各投影獨立「內容有變才發布」（群組指標 ≤1 秒、群組內排行 ≤5 秒，
// 皆由同一份 canonical snapshot 投出；無 sequence／replay／retained）。所以
// 排行在 T 更新時，群組漲跌可能沒變、也就沒有 calculated_at＝T 的那一包。
// 正確的配對是 AS-OF：T 時有效的群組漲跌＝calculated_at ≤ T 的最後一包，
// 前提是這段期間持續訂閱、沒有漏包：
// - live 歷史綁定串流連線世代（streamConnectionEpoch）；世代改變（重連，
//   期間可能漏包）或 wperf 投影退訂時清空，從下一包重新累積；
// - 排行早於歷史最早一包 → 無法判定，回 undefined（畫面顯示「—」）。
// 建底快照另存：它的排行投影與群組漲跌同一快照，calculated_at 完全相同
// 時直接配對，不受連線世代影響。
// 時間以奈秒 BigInt 比較，保留伺服器的次秒精度（Date.parse 只到毫秒）。

const WPERF_HISTORY_LIMIT = 900; // ≥15 分鐘的 1 秒包

interface WperfPoint {
    at: bigint;
    groups: ReadonlyMap<string, number>;
}

const bootstrapWperf = new Map<string, WperfPoint>();
const liveWperf = new Map<string, { epoch: number; points: WperfPoint[] }>();

const TIME_RE =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

/** ISO 8601（需帶時區）→ epoch 奈秒；無法解析回 null */
export function parseCalculatedAtNs(value: string | undefined): bigint | null {
    if (!value) return null;
    const match = TIME_RE.exec(value);
    if (!match) return null;
    const zone =
        match[3] === 'Z' || match[3]!.includes(':')
            ? match[3]
            : `${match[3]!.slice(0, 3)}:${match[3]!.slice(3)}`;
    const ms = Date.parse(`${match[1]}${zone}`);
    if (!Number.isFinite(ms)) return null;
    const frac = BigInt((match[2] ?? '').padEnd(9, '0'));
    return BigInt(ms) * 1_000_000n + frac;
}

function toPoint(
    calculatedAt: string,
    groups: readonly { category: string; value: number }[],
): WperfPoint | null {
    const at = parseCalculatedAtNs(calculatedAt);
    if (at === null) return null;
    return {
        at,
        groups: new Map(groups.map((group) => [group.category, group.value])),
    };
}

function recordBootstrapWperf(code: string, snapshot: RawIndexComponentsSnapshot) {
    const point = toPoint(
        snapshot.calculated_at,
        snapshot.groups.map((group) => ({
            category: group.category,
            value: num(group.weighted_pct_chg),
        })),
    );
    if (point) bootstrapWperf.set(code, point);
    else bootstrapWperf.delete(code);
}

function recordLiveWperf(
    code: string,
    calculatedAt: string,
    groups: readonly { category: string; value: number }[],
) {
    const point = toPoint(calculatedAt, groups);
    if (!point) return;
    const epoch = streamConnectionEpoch();
    let history = liveWperf.get(code);
    if (!history || history.epoch !== epoch) {
        history = { epoch, points: [] };
        liveWperf.set(code, history);
    }
    const { points } = history;
    // 依時間插入（亂序到達時仍保持排序）；同刻重送則覆蓋
    let index = points.length;
    while (index > 0 && points[index - 1]!.at > point.at) index -= 1;
    if (index > 0 && points[index - 1]!.at === point.at) {
        points[index - 1] = point;
    } else {
        points.splice(index, 0, point);
    }
    if (points.length > WPERF_HISTORY_LIMIT) {
        points.splice(0, points.length - WPERF_HISTORY_LIMIT);
    }
}

function clearLiveWperf(code: string) {
    liveWperf.delete(code);
}

// 排行 calculated_at 當下有效的群組加權漲跌（AS-OF 配對，規則見上）；
// 無法判定時回 undefined — 呼叫端不得拿別的值湊數。
export function getIcGroupWperfAt(
    code: string,
    category: string,
    calculatedAt: string | undefined,
): number | undefined {
    const at = parseCalculatedAtNs(calculatedAt);
    if (at === null) return undefined;
    const bootstrap = bootstrapWperf.get(code);
    if (bootstrap && bootstrap.at === at) return bootstrap.groups.get(category);
    const epoch = streamConnectionEpoch();
    const history = liveWperf.get(code);
    if (!history || epoch < 0 || history.epoch !== epoch) return undefined;
    const { points } = history;
    let index = points.length - 1;
    while (index >= 0 && points[index]!.at > at) index -= 1;
    if (index < 0) return undefined; // 排行早於歷史涵蓋範圍
    return points[index]!.groups.get(category);
}

export function getIcBootstrapStatus(code: string): {
    status: IcBootstrapStatus;
    error?: string;
} {
    return {
        status: bootstrapStatus.get(code) ?? 'idle',
        error: bootstrapErrors.get(code),
    };
}

const BOOTSTRAP_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];

function isQuotaError(reason: unknown) {
    return reason instanceof Error && /^429\b/.test(reason.message);
}

// 4xx（429 以外）是請求本身錯，重試無益；503 是暖機、其餘視為暫時性
function isPermanentQueryError(reason: unknown) {
    return (
        reason instanceof Error &&
        /^4\d\d\b/.test(reason.message) &&
        !isQuotaError(reason)
    );
}

function applyBootstrap(code: string) {
    const snapshot = bootstraps.get(code);
    const projections = active.get(code);
    if (!snapshot || !projections) return;
    for (const [projKey, projection] of projections) {
        const key = `${code}|${projKey}`;
        const current = states.get(key);
        // 串流事件與建底以 calculated_at 新者勝
        if (current && current.calculatedAt >= snapshot.calculated_at) {
            continue;
        }
        states.set(key, projectFromSnapshot(snapshot, projection));
    }
}

async function runBootstrap(index: ContractBase) {
    const code = index.code;
    bootstrapStatus.set(code, 'pending');
    bootstrapErrors.delete(code);
    emit();
    for (let attempt = 0; ; attempt++) {
        try {
            const snapshot =
                await fetchIndexComponents<RawIndexComponentsSnapshot>(index);
            bootstraps.set(code, snapshot);
            recordBootstrapWperf(code, snapshot);
            bootstrapStatus.set(code, 'ready');
            applyBootstrap(code);
            emit();
            return;
        } catch (reason) {
            const delay = BOOTSTRAP_RETRY_DELAYS_MS[attempt];
            if (isQuotaError(reason)) {
                bootstrapStatus.set(code, 'quota');
                bootstrapErrors.set(code, '今日資料額度已用盡');
                emit();
                return;
            }
            if (delay === undefined || isPermanentQueryError(reason)) {
                bootstrapStatus.set(code, 'error');
                bootstrapErrors.set(
                    code,
                    reason instanceof Error ? reason.message : String(reason),
                );
                emit();
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

function ensureBootstrap(index: ContractBase) {
    const code = index.code;
    if (bootstrapInFlight.has(code)) return;
    const status = bootstrapStatus.get(code) ?? 'idle';
    // ready/quota 維持現狀（quota 到日切才重試）；error 允許下一次 retain 再試
    if (status === 'ready' || status === 'quota' || status === 'pending') {
        return;
    }
    const run = runBootstrap(index).finally(() => {
        bootstrapInFlight.delete(code);
    });
    bootstrapInFlight.set(code, run);
}

// 日切：事件帶著比已知基準更新的交易日 → 該指數重建底一次。基準取
// 「建底 snapshot 的 date」與「最後見過的事件日」較新者 — 日切建底失敗
// （429/error）時 snapshot 仍停在昨日，若只看 snapshot 會被今日的每個
// 事件反覆重觸發、持續打 429（QA11）；以 lastEventDates 封頂後，同一個
// 目標日只嘗試一次，下一個交易日（新額度）才再試。
const lastEventDates = new Map<string, string>();

function maybeRollover(code: string, eventDate: string) {
    const bootstrapDate = bootstraps.get(code)?.date;
    const lastDate = lastEventDates.get(code);
    const knownDate =
        bootstrapDate !== undefined &&
        (lastDate === undefined || bootstrapDate > lastDate)
            ? bootstrapDate
            : lastDate;
    lastEventDates.set(code, eventDate);
    if (knownDate === undefined || eventDate <= knownDate) return;
    if (bootstrapInFlight.has(code)) return;
    const index = indexContracts.get(code);
    if (!index || (active.get(code)?.size ?? 0) === 0) return;
    bootstrapStatus.set(code, 'idle');
    ensureBootstrap(index);
}

const indexContracts = new Map<string, ContractBase>();
const WPERF_PROJECTION: IcProjection = {
    kind: 'group_metric',
    metric: 'weighted_performance',
};

function handleEvent(raw: string) {
    let parsed: ReturnType<typeof parseIcEvent>;
    try {
        parsed = parseIcEvent(raw);
    } catch {
        return;
    }
    if (!parsed) return;
    const key = `${parsed.code}|${parsed.projKey}`;
    if (parsed.projKey === projectionKey(WPERF_PROJECTION)) {
        recordLiveWperf(
            parsed.code,
            parsed.state.calculatedAt,
            parsed.state.groups ?? [],
        );
    }
    const current = states.get(key);
    if (current && current.calculatedAt > parsed.state.calculatedAt) {
        // 過時的包不覆蓋目前狀態，但歷史已記下（可能正好與排行同刻）
        if (parsed.projKey === projectionKey(WPERF_PROJECTION)) emit();
        return;
    }
    states.set(key, parsed.state);
    maybeRollover(parsed.code, parsed.state.date);
    emit();
}

function ensureStreamListener() {
    if (detachStream) return;
    ensureStream();
    detachStream = onStreamEvent('index_components', handleEvent);
}

// 面板 retain 一條 (指數, 投影)：掛串流、HTTP 訂閱（capability 層自帶
// ref-count 與重連重播）、確保建底。release 歸零時退訂；本地狀態保留
// 為 session cache（remount 不重查、不閃空）。
export function retainIndexComponents(
    index: ContractBase,
    projection: IcProjection,
): () => void {
    const code = index.code;
    const projKey = projectionKey(projection);
    const key = `${code}|${projKey}`;
    ensureStreamListener();
    indexContracts.set(code, index);
    let projections = active.get(code);
    if (!projections) {
        projections = new Map();
        active.set(code, projections);
    }
    projections.set(projKey, projection);
    refs.set(key, (refs.get(key) ?? 0) + 1);
    subErrors.delete(key);
    const body = projectionBody(projection);
    void subscribeIndexComponents(index, body, projKey).catch(
        (reason: unknown) => {
            subErrors.set(
                key,
                reason instanceof Error ? reason.message : '訂閱失敗',
            );
            emit();
        },
    );
    ensureBootstrap(index);
    // 建底已就緒時，為新投影立即投出初始態
    if (bootstrapStatus.get(code) === 'ready') {
        applyBootstrap(code);
        emit();
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = (refs.get(key) ?? 1) - 1;
        if (remaining <= 0) {
            refs.delete(key);
            active.get(code)?.delete(projKey);
            // 退訂後可能漏包 — AS-OF 歷史不再可信
            if (projKey === projectionKey(WPERF_PROJECTION)) clearLiveWperf(code);
        } else {
            refs.set(key, remaining);
        }
        void unsubscribeIndexComponents(index, body, projKey).catch(
            () => undefined,
        );
    };
}
