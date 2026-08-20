// src/lib/stream-health.ts — 盤中「假 LIVE」偵測（issue #28）。
// LIVE 只證明 webview 到本機 sidecar 的 SSE 通；sidecar 對上游的行情
// session 死掉時 heartbeat 照發、燈照綠。這裡用「同商品的 REST 快照
// datetime 有前進、SSE 端卻沒有任何更新」的相對背離當失聯證據：快照與
// 串流同源（同一顆 sidecar、同一個上游），快照會前進代表市場開著且上游
// 可達，此時 SSE 靜止只可能是行情串流側失聯。夜盤冷清、休市、颱風假時
// 快照同樣不前進，自然落在「不判定」分支，毋須交易時段表與假日特判。
//
// 這裡同時是快照的唯一輪詢者：最新結果放進可訂閱 store 供 MarketBar
// 顯示（原本 MarketBar 自己每 10 秒輪詢同兩檔，共用後 API 用量不變）。

import { ensureContract } from './contracts-cache';
import { fetchSnapshots, withTimeout } from './shioaji';
import {
    getLastUpstreamDataAt,
    getQuote,
    getStreamStatus,
    markStreamStale,
    onContractEvent,
} from './stream';
import { isTauri } from './runtime';
import { notify } from './trade';
import type { SecurityType } from './types/contract';
import type { Snapshot } from './types/market';

// 與 MarketBar 相同的基準商品（contracts-cache 已常駐訂閱其行情）：
// 加權指數盤中每 5 秒固定發布、台指期日盤實測每分鐘皆有成交。
// 快照回傳的 code 實測就是請求的顯示代碼（TXFR1 原樣回傳），直接比對。
const CANARY_CODES: ReadonlyArray<{ code: string; type: SecurityType }> = [
    { code: 'IX0001', type: 'IND' },
    { code: 'TXFR1', type: 'FUT' },
];

const POLL_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
// 連續兩輪背離（約 20 秒）才判定，單輪可能撞上訂閱重放的空窗
const STALE_ROUNDS = 2;
// hold（無新證據）連續超過此輪數就把累積歸零：兩次相隔數小時的
// 單輪背離（收盤瞬間、開盤重放空窗）不可以被湊成「連續」
const HOLD_RESET_ROUNDS = 3;
// SSE 重連（onopen 必發 RECONNECT）與維護窗後的緩衝：訂閱重放逐筆
// 序列進行、warmup 期會 hang（shioaji.ts 註解記載的實案），期間快照
// 前進而 SSE 靜止是合法過渡，不能當失聯證據。開機首次連線同樣適用。
const RECONNECT_GRACE_MS = 60_000;

export interface CanaryBaseline {
    snapshotDt: string; // 快照的 datetime（同格式字串可直接比大小）
    seq: number; // stream store 的更新序號（任何 tick/bidask/index 都會動）
}

export type HealthVerdict = 'stale' | 'ok' | 'hold';

// 純判定函式（供測試）。背離＝至少一個基準商品的快照 datetime 前進、
// 且所有基準商品的 SSE seq 都沒動。seq 有動＝串流活著（ok，歸零重計）；
// 快照與 seq 都沒動＝市場安靜或休市，證據不足（hold）。
export function compareBaselines(
    prev: ReadonlyMap<string, CanaryBaseline>,
    next: ReadonlyMap<string, CanaryBaseline>,
): HealthVerdict {
    let snapshotAdvanced = false;
    for (const [code, current] of next) {
        const before = prev.get(code);
        if (!before) continue;
        if (current.seq > before.seq) return 'ok';
        if (current.snapshotDt > before.snapshotDt) snapshotAdvanced = true;
    }
    return snapshotAdvanced ? 'stale' : 'hold';
}

export interface EvidenceState {
    streak: number; // 連續背離輪數
    holdRun: number; // 連續無證據輪數
}

// 純累積函式（供測試）：stale 累積、ok 全歸零、hold 連續太久也歸零
export function advanceEvidence(
    state: EvidenceState,
    verdict: HealthVerdict,
): EvidenceState {
    if (verdict === 'ok') return { streak: 0, holdRun: 0 };
    if (verdict === 'stale') return { streak: state.streak + 1, holdRun: 0 };
    const holdRun = state.holdRun + 1;
    return {
        streak: holdRun >= HOLD_RESET_ROUNDS ? 0 : state.streak,
        holdRun,
    };
}

// ---- 快照 store（MarketBar 顯示與偵測共用同一條輪詢）----

let latestSnapshots: Snapshot[] | undefined;
const snapshotListeners = new Set<() => void>();

export function subscribeSnapshotStore(listener: () => void) {
    snapshotListeners.add(listener);
    ensurePolling();
    return () => {
        snapshotListeners.delete(listener);
    };
}

export function getLatestSnapshots(): Snapshot[] | undefined {
    return latestSnapshots;
}

// ---- 偵測引擎 ----

let pollingStarted = false;
let alarmEnabled = false;

let prev: Map<string, CanaryBaseline> | null = null;
let evidence: EvidenceState = { streak: 0, holdRun: 0 };
let noticed = false;
let graceUntil = 0;
let lastSeenDataAt = 0;
let ticking = false;

function resetEvidence() {
    prev = null;
    evidence = { streak: 0, holdRun: 0 };
}

async function tick() {
    // async tick 不可重入（repo 慣例，見 boot.ts 的 overlapping-ticks）
    if (ticking) return;
    ticking = true;
    try {
        let snapshots: Snapshot[];
        try {
            const contracts = await withTimeout(
                Promise.all(
                    CANARY_CODES.map((c) => ensureContract(c.code, c.type)),
                ),
                SNAPSHOT_TIMEOUT_MS,
                '合約解析',
            );
            snapshots = await withTimeout(
                fetchSnapshots(contracts),
                SNAPSHOT_TIMEOUT_MS,
                '快照請求',
            );
        } catch {
            // 快照失敗可能是本機斷網或 sidecar/token 層問題，證據不足：
            // 不累積也不歸零（多等一輪的成本遠低於誤判）
            return;
        }
        latestSnapshots = snapshots;
        snapshotListeners.forEach((l) => l());

        if (!alarmEnabled) return;
        // 只在 live/stale 時判定；down/connecting 由既有重連迴圈負責
        const status = getStreamStatus();
        if (status !== 'live' && status !== 'stale') {
            resetEvidence();
            noticed = false;
            return;
        }
        // 背景視窗（WebView2 節流 timer）與斷網（本機問題）不累積證據
        if (document.hidden || navigator.onLine === false) return;

        // 任何 SSE 行情有進來（不限基準商品）就是串流活著的鐵證，
        // 也擋掉「基準商品訂閱卡住但其他訂閱正常」的誤判
        const dataAt = getLastUpstreamDataAt();
        const dataFlowed = dataAt !== lastSeenDataAt;
        lastSeenDataAt = dataAt;

        const next = new Map<string, CanaryBaseline>();
        for (const snapshot of snapshots) {
            if (!snapshot.datetime) continue;
            if (!CANARY_CODES.some((c) => c.code === snapshot.code)) continue;
            next.set(snapshot.code, {
                snapshotDt: snapshot.datetime,
                seq: getQuote(snapshot.code)?.seq ?? 0,
            });
        }
        const verdict: HealthVerdict = dataFlowed
            ? 'ok'
            : prev
              ? compareBaselines(prev, next)
              : 'hold';
        prev = next;

        if (Date.now() < graceUntil) {
            // 重連/開機緩衝期：訂閱重放中，背離是合法過渡
            evidence = { streak: 0, holdRun: 0 };
            return;
        }
        evidence = advanceEvidence(evidence, verdict);

        if (verdict === 'ok' && noticed) {
            noticed = false;
            notify({
                kind: 'ok',
                title: '行情串流已恢復',
                body: '即時行情已重新抵達，恢復 LIVE。',
            });
        }
        if (evidence.streak >= STALE_ROUNDS) {
            // 每輪重標（冪等）：本機 SSE 重連的 onopen 會把狀態洗回
            // live，其他視窗也可能各自被洗掉，靠重標與重廣播拉回
            markStreamStale();
            if (!noticed) {
                noticed = true;
                notify({
                    kind: 'err',
                    title: '行情串流疑似失聯',
                    body:
                        '快照持續更新但即時行情靜止，上游行情連線可能已中斷，下單已暫停保護。' +
                        (isTauri
                            ? '請點頂部「伺服器」開啟面板，按「重啟」重建連線。'
                            : '請重新整理頁面，或檢查 shioaji server 的行情連線。'),
                });
            }
        }
    } finally {
        ticking = false;
    }
}

function ensurePolling() {
    if (pollingStarted) return;
    pollingStarted = true;
    void tick();
    setInterval(() => {
        void tick();
    }, POLL_MS);
}

export function startStreamHealthWatch() {
    // 與 boot.ts 相同的主視窗判斷：popout/閃電視窗不跑偵測（它們經
    // BroadcastChannel 接收主視窗的 stale），也不主動輪詢快照（若其
    // 版面有 MarketBar，訂閱 store 時才會就地啟動輪詢，成本與改動前
    // MarketBar 自己輪詢相同）
    if (new URLSearchParams(window.location.search).has('popout')) return;
    alarmEnabled = true;

    // SSE 每次 onopen 必發 RECONNECT、維護窗發 MAINTENANCE：兩者都代表
    // 訂閱正在重放，清掉舊基準並給緩衝期，把「剛恢復的串流」誤判成
    // 失聯的窗口關掉。開機首次連線同樣走這裡（等於開機緩衝）。
    onContractEvent((event) => {
        if (event.action === 'RECONNECT' || event.action === 'MAINTENANCE') {
            resetEvidence();
            graceUntil = Date.now() + RECONNECT_GRACE_MS;
        }
    });

    // 視窗被遮蔽時 WebView2 會節流 timer，回前景後基準已過期，重置重計
    document.addEventListener('visibilitychange', () => {
        resetEvidence();
    });

    ensurePolling();
}
