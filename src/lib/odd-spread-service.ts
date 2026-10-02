// src/lib/odd-spread-service.ts — 整零價差兩腳送單的主視窗服務。
//
// 執行狀態不放在面板元件裡：面板移除、切換商品都不會中斷追蹤（同觸價單
// 引擎，只在主視窗執行）。每筆執行保存在本機（重新整理後接回），並：
// - 依 odd-spread-exec 狀態機的指令送單／刪單（source:'auto'，整筆價差已在
//   開始前確認；零股帶 IntradayOdd；委託帶 custom_field 標記）。
// - 每筆委託帶唯一標記（custom_field，最多 6 字元：o＋執行代碼 3 碼＋序號 2 碼）；
//   訂閱委託列（trading-state），只以委託編號或「完全相同的標記」對回：成交先於
//   下單回應、結果不明（unknown）事後出現都能接回。沒有標記的委託（投影遺失）
//   絕不自動認領，只列為候選，由使用者在面板指定。
// - 執行綁定開始時的伺服器（API base）與模擬／正式模式；目前連線不同時暫停：
//   不送單、不對帳、回報先保留，同一環境回來後才繼續。
// - 結束的執行保留到當日結束（晚到成交仍會對帳、必要時補第二腳）；本機保存
//   永不丟棄執行中或結果不明的紀錄，只限制已結束紀錄的數量。
// - 第二腳以當下整股／零股委託簿重新定價（repriceHedge）。
//
// 彈出視窗沒有這個服務：關掉視窗就無法追蹤第二腳，所以彈出視窗停用兩腳送單
// （面板顯示原因）；點價單筆下單不受影響。

import { useMemo, useSyncExternalStore } from 'react';
import { displayBook } from './display-book';
import { accountMatches, flashAccountKey } from './flash-account';
import { claimExecutor, isExecutor, isMainWindow } from './main-window-commands';
import { getApiBase } from './runtime';
import { knownServerInfo, subscribeServerInfo } from './server-info-store';
import { SHARES_PER_LOT } from './odd-lot';
import type { LegOrder } from './odd-spread';
import { repriceHedge, type FeeSettings, type SideBook } from './odd-spread';
import {
    execReduce,
    execSummary,
    initExec,
    isTerminalPhase,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type LegKind,
    type OrderSlot,
    type ReportStatus,
    allBrokerFinal,
    restoreAfterReload,
} from './odd-spread-exec';
import { retainContractQuotes } from './quote-ownership';
import { cancelVerifiedOrder, fetchInfo, fetchTrades } from './shioaji';
import { checkInstance, instanceFromResponse, type InstanceCheck } from './server-instance';
import { getLastHeartbeat, getQuote, HEARTBEAT_PERIOD_MS, streamConnectionEpoch, subscribeStatusStore } from './stream';
import { notify, placeQuickOrder } from './trade';
import { getTradingState, subscribeTradingState } from './trading-state';
import { candidateTrades, reconcileEvents, slotTag, tradeReport } from './odd-spread-reconcile';
import type { ContractInfo } from './types/contract';
import type { Trade } from './types/order';
import type { Account } from './types/portfolio';
import { stepPrice } from './utils/ticksize';

const STORE_KEY = 'sj-pro-odd-spread-exec-v1';
const TAG_KEY = 'sj-pro-odd-spread-tags-v1';
/** 已了結紀錄最多保存幾筆（當日內）；未了結的永不丟棄 */
const MAX_TERMINAL = 50;

/** 送單環境：API base＋模擬／正式 */
export interface ExecEnv {
    base: string;
    simulation: boolean;
}

export interface SpreadExecRecord {
    id: string;
    /** 委託標記前綴（3 碼 base36），同日唯一 */
    tagBase: string;
    env: ExecEnv;
    contract: ContractInfo;
    account: Account;
    fees: FeeSettings;
    maxSlipTicks: number;
    startedAt: number;
    state: ExecState;
    /** 使用者已關閉顯示（仍追蹤晚到成交；重新開啟時再顯示） */
    dismissed?: boolean;
    /** 環境不符期間保留的回報，同一環境回來後依序處理 */
    held?: ExecEvent[];
}

let records: SpreadExecRecord[] = [];
const listeners = new Set<() => void>();
const releases = new Map<string, () => void>();
let started = false;
let seq = 0;

function emit() {
    for (const l of listeners) l();
}

/** 台北時間當日 00:00（ms） */
function taipeiDayStart(now: number): number {
    const tw = now + 8 * 3600_000;
    return tw - (tw % 86_400_000) - 8 * 3600_000;
}

/**
 * 已完全了結：已結束、沒有保留中的回報、每筆委託都是券商確認的終態（刪單要有
 * 刪單量對得上；使用者標記「未送出」只是暫定、不算），且兩腳已配對或使用者已
 * 關閉。只有了結的紀錄可以被丟棄。
 */
export function isSettled(r: SpreadExecRecord): boolean {
    if (!isTerminalPhase(r.state.phase) || (r.held?.length ?? 0) > 0) return false;
    if (!allBrokerFinal(r.state)) return false;
    return execSummary(r.state).unhedgedShares === 0 || !!r.dismissed;
}

/** 保存規則：未了結（執行中、結果不明、未配對未處理…）全留；了結的只留當日、最多 MAX_TERMINAL 筆 */
export function pruneRecords(list: SpreadExecRecord[], now = Date.now()): SpreadExecRecord[] {
    const day = taipeiDayStart(now);
    const settled = list.filter(r => isSettled(r) && r.startedAt >= day);
    const keepSettled = new Set(settled.slice(-MAX_TERMINAL).map(r => r.id));
    return list.filter(r => !isSettled(r) || keepSettled.has(r.id));
}

function persist() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(pruneRecords(records)));
    } catch {
        // 本機儲存不可用：只在本次有效
    }
}

// ---- 委託標記 ----

export { slotTag, tradeReport };

function usedTagBases(now: number): { day: number; bases: string[] } {
    try {
        const v = JSON.parse(localStorage.getItem(TAG_KEY) ?? 'null') as { day: number; bases: string[] } | null;
        if (v && v.day === taipeiDayStart(now) && Array.isArray(v.bases)) return v;
    } catch {
        // 讀不到就當作今天還沒用過
    }
    return { day: taipeiDayStart(now), bases: [] };
}

function newTagBase(now: number): string {
    const used = usedTagBases(now);
    const taken = new Set([...used.bases, ...records.map(r => r.tagBase)]);
    let base = '';
    for (let i = 0; i < 1000; i++) {
        base = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0');
        if (!taken.has(base)) break;
    }
    try {
        localStorage.setItem(TAG_KEY, JSON.stringify({ day: used.day, bases: [...used.bases, base] }));
    } catch {
        // 本機儲存不可用：只避開記憶體中的紀錄
    }
    return base;
}

// ---- 環境 ----

export function currentEnv(): { base: string; simulation: boolean | undefined } {
    return { base: getApiBase(), simulation: knownServerInfo()?.simulation };
}

/** 執行的環境與目前連線相同？（模擬／正式未知時視為不同） */
export function envMatches(env: ExecEnv, now: { base: string; simulation: boolean | undefined } = currentEnv()): boolean {
    return env.base === now.base && now.simulation !== undefined && now.simulation === env.simulation;
}

export const ENV_PAUSED_TEXT = '環境已切換，執行暫停';

/** 兩腳送單在此視窗不可用的原因；可用時回 null */
export function oddSpreadExecUnavailable(): string | null {
    if (!isMainWindow()) return '兩腳價差單只能在主視窗執行（彈出視窗關閉後無法繼續追蹤第二腳）';
    if (!isExecutor()) return '另一個主視窗正在執行交易服務，請在該視窗送出價差單';
    return null;
}

function bookOf(rec: SpreadExecRecord, odd: boolean): SideBook {
    const q = getQuote(rec.contract.code, odd);
    const b = displayBook(rec.contract.code, undefined, q?.bidask, rec.contract.target_code);
    return { bids: b?.bids ?? [], asks: b?.asks ?? [] };
}

function contextFor(rec: SpreadExecRecord): ExecContext {
    return {
        currentGen,
        quoteHedge: (leg: LegKind, action, quantity) => {
            const plan = rec.state.plan;
            const odd = leg === 'odd';
            // 計畫中最差的那一檔（買取最高、賣取最低）
            const oddPrices = plan.oddOrders.map(o => o.price);
            const plannedPrice = !odd ? plan.roundPrice
                : oddPrices.length === 0 ? 0
                    : action === 'Buy' ? Math.max(...oddPrices) : Math.min(...oddPrices);
            return repriceHedge({
                book: bookOf(rec, odd),
                odd,
                action,
                quantity,
                plannedPrice,
                netPerShare: plan.netPerShare ?? 0,
                maxSlipTicks: rec.maxSlipTicks,
                step: (p, dir) => stepPrice(rec.contract, p, dir),
                fees: rec.fees,
            });
        },
    };
}

function replace(next: SpreadExecRecord) {
    records = records.map(r => (r.id === next.id ? next : r));
}

function update(id: string, event: ExecEvent) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    // 環境不符：回報先保留，不推進狀態機（避免在別的環境送第二腳）
    if (!envMatches(rec.env)) {
        replace({ ...rec, held: [...(rec.held ?? []), event] });
        persist();
        emit();
        return;
    }
    const before = rec.state;
    const { state, commands } = execReduce(before, event, contextFor(rec));
    if (state === before && commands.length === 0) return;
    // 晚到成交讓已關閉的執行重新需要處理時，恢復顯示
    const next: SpreadExecRecord = { ...rec, state, dismissed: rec.dismissed && isTerminalPhase(state.phase) };
    replace(next);
    persist();
    emit();
    announce(next, before);
    for (const c of commands) run(next, c);
    if (isTerminalPhase(state.phase)) releaseQuotes(id);
    else retainQuotes(next);
}

function announce(rec: SpreadExecRecord, before: ExecState) {
    const { phase } = rec.state;
    if (phase === before.phase) return;
    const code = rec.contract.code;
    const sum = execSummary(rec.state);
    if (phase === 'unknown') {
        notify({ kind: 'err', title: '整零價差：委託結果未確認', body: `${code}：有委託可能已送出但未收到回應，已暫停第二腳，請核對委託；勿直接重送` });
    } else if (phase === 'hedgeDecision') {
        notify({ kind: 'err', title: '整零價差：未配對待處理', body: `${code}：${rec.state.pendingHedge?.reason ?? ''}；請在面板選擇補單或取消` });
    } else if (isTerminalPhase(phase)) {
        notify({
            kind: phase === 'done' ? 'ok' : 'err',
            title: phase === 'done' ? '整零價差完成' : phase === 'cancelled' ? '整零價差已取消' : '整零價差未完成',
            body: `${code}：零股 ${sum.oddFilledShares} 股、整股 ${sum.roundFilledLots} 張${sum.unhedgedShares ? `，未配對 ${Math.abs(sum.unhedgedShares)} 股` : ''}`,
        });
    }
}

/**
 * 送出前以新鮮讀取確認伺服器沒換（呼叫端在這之後除了送出本身不再等待）：
 * - 串流身分可判定（含近期心跳）且與指令產生時相同；
 * - 重新讀 /api/v1/info（不看快取）：API base、模擬／正式相同；有 instance_id 時記下，
 *   送出後比對回應的 X-Shioaji-Instance 標頭。
 * sidecar 1.7.8 之前沒有程序身分，驗證與送出之間仍有極短的空窗；instance 標頭上線後
 * 由回應比對補上。
 */
async function verifyServer(rec: SpreadExecRecord, gen: string | null): Promise<{ problem: string | null; instance?: string }> {
    if (gen === null || currentGen() !== gen) return { problem: '伺服器連線不穩或已重啟（身分無法確認）' };
    if (!envMatches(rec.env)) return { problem: ENV_PAUSED_TEXT };
    let info;
    try {
        info = await fetchInfo();
    } catch (e) {
        return { problem: `無法確認伺服器（${e instanceof Error ? e.message : String(e)}）` };
    }
    if (getApiBase() !== rec.env.base || info.simulation !== rec.env.simulation) return { problem: ENV_PAUSED_TEXT };
    // fetchInfo 會更新 instance_id；程序換了身分也跟著換
    if (currentGen() !== gen) return { problem: '伺服器身分已變更' };
    return { problem: null, instance: info.instance_id };
}

/** 回應標頭的 instance 檢查（舊版 SDK 沒有標頭時不做任何事） */
function instanceWatcher(expected: string | undefined) {
    let result: InstanceCheck = 'absent';
    return {
        onResponse: (res: Response) => { result = checkInstance(expected, instanceFromResponse(res)); },
        mismatch: () => result === 'mismatch',
    };
}

function run(rec: SpreadExecRecord, c: ReturnType<typeof execReduce>['commands'][number]) {
    const gen = currentGen();
    if (c.kind === 'cancel') {
        const slot = rec.state.slots.find(s => s.key === c.key);
        const tag = slotTag(rec.tagBase, c.key);
        const refuse = (error: string) => update(rec.id, { type: 'cancelResult', key: c.key, ok: false, error });
        if (!envMatches(rec.env) || gen === null || slot?.orderId !== c.orderId || slot.idGen !== gen) {
            refuse(!envMatches(rec.env) ? ENV_PAUSED_TEXT : '委託編號待重新接回（伺服器已重啟或連線中斷）');
            return;
        }
        void (async () => {
            // 以伺服器目前的委託列確認這個編號就是我們這一筆（標記相符）；編號被別的委託
            // 重用就不刪。快取裡沒有（例如重啟後尚未載入）就讀一次權威委託列。
            let row: Trade | undefined;
            try {
                const find = (rows: Trade[]) => rows.find(t => t.order.id === c.orderId);
                row = find(await fetchTrades('S', rec.account, { refresh: false }))
                    ?? find(await fetchTrades('S', rec.account, { refresh: true }));
            } catch (e) {
                return refuse(`無法確認委託（${e instanceof Error ? e.message : String(e)}）`);
            }
            if (!row || row.order.custom_field !== tag || currentGen() !== gen) return refuse('委託編號與本單標記不符，未刪單（待重新接回）');
            // 伺服器驗證放在最後，之後只剩送出本身
            const { problem, instance } = await verifyServer(rec, gen);
            if (problem) return refuse(problem);
            const watch = instanceWatcher(instance);
            const beforeSend = () => {
                if (!envMatches(rec.env)) throw new Error(`${ENV_PAUSED_TEXT}，未刪單`);
                if (currentGen() !== gen) throw new Error('伺服器身分已變更，未刪單');
            };
            // 以剛驗證的伺服器列刪單：編號、序號與數量都來自這一列，不經 App 本地委託列解析
            const verified = row;
            const results: PromiseSettledResult<Trade>[] = await cancelVerifiedOrder(verified, rec.account, { beforeSend, onResponse: watch.onResponse })
                .then(t => [{ status: 'fulfilled' as const, value: t }], (e: unknown) => [{ status: 'rejected' as const, reason: e }]);
            if (watch.mismatch()) {
                suspectInstance();
                return refuse('刪單回應來自不同的伺服器程序，結果不明；請核對委託');
            }
            const r = results[0];
            const ok = r?.status === 'fulfilled';
            const error = !r ? '沒有回應' : r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : undefined;
            if (!ok) notify({ kind: 'err', title: '整零價差：刪單失敗', body: `${rec.contract.code}：${error}；原單可能仍會成交，請在面板再按「取消」重試` });
            update(rec.id, { type: 'cancelResult', key: c.key, ok, ...(error ? { error } : {}) });
        })();
        return;
    }
    const failPlace = (msg: string) => {
        notify({ kind: 'err', title: `整零價差：${c.leg === 'odd' ? '零股' : '整股'}委託未送出`, body: msg });
        update(rec.id, { type: 'placeFailed', key: c.key, error: msg });
    };
    void (async () => {
        const { problem, instance } = await verifyServer(rec, gen);
        if (problem) return failPlace(problem);
        const watch = instanceWatcher(instance);
        try {
            const trade = await placeQuickOrder(rec.contract, c.action, c.price, c.quantity, {
                account: rec.account,
                source: 'auto',
                customField: slotTag(rec.tagBase, c.key),
                ...(c.leg === 'odd' ? { orderLot: 'IntradayOdd' as const } : {}),
                // 送出前最後一刻再確認環境與伺服器身分：不同就不送（mutationNotStarted）
                beforeSend: () => {
                    if (!envMatches(rec.env)) throw new Error(`${ENV_PAUSED_TEXT}，未送出`);
                    if (currentGen() !== gen) throw new Error('伺服器身分已變更，未送出');
                },
                onResponse: watch.onResponse,
            });
            if (watch.mismatch()) {
                // 回應來自別的程序：結果視為不明，以標記重新接回
                update(rec.id, { type: 'placeUnknown', key: c.key, error: '回應來自不同的伺服器程序' });
                suspectInstance();
                return;
            }
            // 回應期間伺服器身分變了 → 這個 id 不可信（之後以標記接回）
            const g = currentGen();
            update(rec.id, { type: 'placed', key: c.key, orderId: trade.order.id, gen: g !== null && g === gen ? g : null });
            update(rec.id, { type: 'report', key: c.key, ...tradeReport(trade) });
            void reconcile();
        } catch (error) {
            const notStarted = !!(error && typeof error === 'object' && 'mutationNotStarted' in error);
            const msg = error instanceof Error ? error.message : String(error);
            if (notStarted) failPlace(msg);
            else {
                update(rec.id, { type: 'placeUnknown', key: c.key, error: watch.mismatch() ? '回應來自不同的伺服器程序' : msg });
                if (watch.mismatch()) suspectInstance();
                void reconcile();
            }
        }
    })();
}

// 本頁面的隨機身分：重新整理後舊頁面取得的委託編號一律不信任（以標記重新接回）
const PAGE_ID = Math.random().toString(36).slice(2, 10);

/**
 * 目前的伺服器身分：頁面＋API base＋串流連線世代。HTTP API 沒有提供 sidecar 程序
 * 身分；sidecar 重啟必然中斷串流，所以同一連線世代內程序不變。串流不是 live
 * （連線中斷、重連中）時回 null＝無法判定，所有委託編號都不信任。
 */
// 回應標頭顯示可能換了程序 → 身分暫時無法判定，直到重新驗證成功（並換一個身分世代）
let instanceSuspect = false;
let instanceEpoch = 0;

export function currentGen(): string | null {
    const epoch = streamConnectionEpoch();
    // 心跳超過兩個週期沒來 → 串流可能已斷而尚未察覺，身分視為無法判定
    if (instanceSuspect || epoch < 0 || Date.now() - getLastHeartbeat() > 2 * HEARTBEAT_PERIOD_MS) return null;
    // SDK 1.7.8+ 的 instance_id（有就一併納入：程序換了，身分就換）
    const instance = knownServerInfo()?.instance_id ?? '';
    return `${PAGE_ID}|${getApiBase()}|${epoch}|${instanceEpoch}|${instance}`;
}

/** 回應標頭與送出前驗證的 instance 不符：身分作廢，重新驗證伺服器後以標記重新接回 */
function suspectInstance() {
    if (instanceSuspect) return;
    instanceSuspect = true;
    notify({ kind: 'err', title: '整零價差：伺服器程序可能已更換', body: '回應來自不同的 sidecar 程序，已暫停並重新確認伺服器；結果不明的委託會以標記重新接回' });
    void (async () => {
        try {
            await fetchInfo();
        } catch {
            // 讀不到也照樣換身分世代：之後的送單仍各自做新鮮驗證
        }
        instanceEpoch += 1;
        instanceSuspect = false;
        void reconcile();
    })();
}

/** 目前身分下取得、可信的委託編號（標記對帳時不可被別的委託占用） */
function trustedIds(gen: string | null): Set<string> {
    const ids = new Set<string>();
    if (gen === null) return ids;
    for (const r of records) for (const s of r.state.slots) if (s.orderId && s.idGen === gen) ids.add(s.orderId);
    return ids;
}

const target = (rec: SpreadExecRecord) => ({ tagBase: rec.tagBase, code: rec.contract.code, account: rec.account, state: rec.state });

// 對帳一律用「在目前身分下、剛從伺服器讀到的委託列」（/order/trades，refresh:false，
// sidecar 程序內快取、不耗帳務額度）。App 端 trading-state 的列可能被本地投影／合併
// 帶著舊標記更新（例如被重用的編號），不拿來綁定或採用回報。
interface FreshRows {
    gen: string;
    rows: Trade[];
}
const freshByAccount = new Map<string, FreshRows>();

async function fetchFresh(account: Account, refresh = false): Promise<FreshRows | null> {
    const gen = currentGen();
    if (gen === null) return null;
    let rows: Trade[];
    try {
        rows = await fetchTrades('S', account, { refresh });
    } catch {
        return null;
    }
    if (currentGen() !== gen) return null; // 讀取期間身分變了：這批列不可信
    const snap = { gen, rows };
    freshByAccount.set(flashAccountKey(account), snap);
    return snap;
}

let reconciling = false;
let reconcileAgain = false;
// 每個帳戶在「目前身分」下是否已做過一次權威讀取（refresh:true）。sidecar 重啟／新登入
// 後，程序內快取可能是空的或缺了斷線期間的成交；身分一換（含重新連線、重新整理）就
// 先做一次權威讀取，失敗則退避重試。例行對帳仍用 refresh:false。
const authGen = new Map<string, string>();
const authRetry = new Map<string, { delay: number; timer: ReturnType<typeof setTimeout> | null }>();
export const AUTH_RETRY_BASE_MS = 1000;
const AUTH_RETRY_MAX_MS = 30_000;
let authRetryBase = AUTH_RETRY_BASE_MS;

function scheduleAuthRetry(key: string) {
    const st = authRetry.get(key) ?? { delay: authRetryBase, timer: null };
    if (st.timer) return;
    st.timer = setTimeout(() => {
        st.timer = null;
        void reconcile();
    }, st.delay);
    st.delay = Math.min(AUTH_RETRY_MAX_MS, st.delay * 2);
    authRetry.set(key, st);
}

/** 需要權威讀取：還有任何不是券商確認終態的委託（在途、結果不明、刪單量對不上…） */
function needsAuthoritative(r: SpreadExecRecord): boolean {
    return !allBrokerFinal(r.state) || r.state.slots.some(x => x.cancelState === 'unknown');
}

/** 以剛讀到的伺服器委託列對帳（唯一標記；sidecar 重啟換 id 時重新接回）。併發呼叫會合併。 */
export async function reconcile(): Promise<void> {
    if (reconciling) {
        reconcileAgain = true;
        return;
    }
    reconciling = true;
    try {
        do {
            reconcileAgain = false;
            const accounts = new Map<string, Account>();
            for (const r of records) if (r.state.started && !isSettled(r) && envMatches(r.env)) accounts.set(flashAccountKey(r.account), r.account);
            for (const [key, account] of accounts) {
                const gen = currentGen();
                const needAuth = gen !== null && authGen.get(key) !== gen
                    && records.some(r => accountMatches(r.account, account) && r.state.started && needsAuthoritative(r));
                const snap = await fetchFresh(account, needAuth);
                if (!snap) {
                    if (needAuth) scheduleAuthRetry(key);
                    continue;
                }
                if (needAuth) {
                    authGen.set(key, snap.gen);
                    const st = authRetry.get(key);
                    if (st?.timer) clearTimeout(st.timer);
                    authRetry.delete(key);
                }
                const claimed = trustedIds(snap.gen);
                for (const rec of records) {
                    if (!rec.state.started || !envMatches(rec.env) || !accountMatches(rec.account, account)) continue;
                    if (currentGen() !== snap.gen) break;
                    for (const e of reconcileEvents(target(rec), snap.rows, claimed, snap.gen)) update(rec.id, e);
                }
            }
        } while (reconcileAgain);
    } finally {
        reconciling = false;
    }
}

/** 結果不明、或 sidecar 重啟後 id 不可信的那筆的候選委託：只從目前身分下剛讀到的列提供 */
export function candidateOrders(id: string, key: string): Trade[] {
    const rec = records.find(r => r.id === id);
    const slot = rec?.state.slots.find(s => s.key === key);
    const gen = currentGen();
    const snap = rec ? freshByAccount.get(flashAccountKey(rec.account)) : undefined;
    if (!rec || !slot || gen === null || !snap || snap.gen !== gen) return [];
    return candidateTrades(target(rec), slot, snap.rows, trustedIds(gen), gen) as Trade[];
}

/** 使用者指定結果不明那筆就是某筆委託：指定當下重新讀一次伺服器委託列再確認 */
export async function claimOrder(id: string, key: string, orderId: string): Promise<boolean> {
    const rec = records.find(r => r.id === id);
    if (!rec) return false;
    if (!envMatches(rec.env)) {
        notify({ kind: 'err', title: '整零價差', body: ENV_PAUSED_TEXT });
        return false;
    }
    const snap = await fetchFresh(rec.account);
    const now = records.find(r => r.id === id);
    const slot = now?.state.slots.find(s => s.key === key);
    if (!snap || !now || !slot || currentGen() !== snap.gen
        || !candidateTrades(target(now), slot, snap.rows, trustedIds(snap.gen), snap.gen).some(t => t.order.id === orderId)) {
        notify({ kind: 'err', title: '整零價差', body: '候選委託已變動或伺服器身分已變更，請重新選擇' });
        return false;
    }
    update(id, { type: 'placed', key, orderId, gen: snap.gen, rebind: !!slot.orderId, userClaimed: true });
    void reconcile();
    return true;
}

function retainQuotes(rec: SpreadExecRecord) {
    if (releases.has(rec.id)) return;
    try {
        const a = retainContractQuotes(rec.contract);
        const b = retainContractQuotes(rec.contract, { oddLot: true });
        releases.set(rec.id, () => { a(); b(); });
    } catch {
        // 行情訂閱失敗：補單定價會回報沒有報價，交由使用者決定
    }
}

function releaseQuotes(id: string) {
    releases.get(id)?.();
    releases.delete(id);
}

/** 同一環境回來：依序處理保留的回報，再對帳 */
function resumeHeld() {
    for (const rec of records) {
        if (!rec.held?.length || !envMatches(rec.env)) continue;
        const events = rec.held;
        replace({ ...rec, held: [] });
        for (const e of events) update(rec.id, e);
    }
    void reconcile();
    emit();
}

// 與觸價單引擎同一把主視窗執行鎖（claimExecutor 在同一視窗只建立一次）
const EXECUTOR_LOCK = 'sj-protection-executor';

/** 主視窗啟動：取得執行權後接回本機保存的執行並開始對帳（只執行一次） */
export function startOddSpreadService() {
    if (started || !isMainWindow()) return;
    if (!isExecutor()) {
        void claimExecutor(EXECUTOR_LOCK).acquired.then(() => startOddSpreadService());
        return;
    }
    started = true;
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const parsed = raw ? (JSON.parse(raw) as SpreadExecRecord[]) : [];
        // 重新整理前還在送出中的委託：結果不明，等委託列對上或使用者核對
        records = Array.isArray(parsed)
            ? pruneRecords(parsed.filter(r => r && r.tagBase && r.env).map(r => ({
                ...r,
                // 送出中 → 結果不明；刪單等待中 → 刪單結果不明（仍在委託中可再取消）
                state: restoreAfterReload(r.state),
            })))
            : [];
    } catch {
        records = [];
    }
    persist();
    for (const r of records) if (!isTerminalPhase(r.state.phase)) retainQuotes(r);
    // 委託列有更新只當作「該去伺服器讀一次」的訊號
    subscribeTradingState(() => { void reconcile(); });
    subscribeServerInfo(() => resumeHeld());
    // 串流重新連線（身分改變）→ 對帳（會先做一次權威讀取）
    subscribeStatusStore(() => { void reconcile(); });
    resumeHeld();
    // 接回後以總量重算一次（例如重新發出因重新整理遺失回應的多餘補單刪單）
    for (const r of records) if (!isSettled(r)) update(r.id, { type: 'refresh' });
}

export interface StartSpreadRequest {
    contract: ContractInfo;
    account: Account;
    plan: ExecPlan;
    fees: FeeSettings;
    maxSlipTicks: number;
    /** 使用者按下時綁定的環境；開始當下不同就拒絕 */
    env: ExecEnv;
}

/** 需要先處理、會擋下同商品同帳戶新價差單的執行：未結束，或還有結果不明（含使用者
 * 標記「未送出」但券商未確認）的委託——那筆若其實有送出，事後接回會與新單同時補單 */
export function blockingExecutionFor(code: string, account: Account | undefined): SpreadExecRecord | undefined {
    return records.find(r => r.contract.code === code && accountMatches(r.account, account) && r.state.started
        && (!isTerminalPhase(r.state.phase) || r.state.slots.some(s => s.status === 'unknown')));
}

export const liveExecutionFor = blockingExecutionFor;

export function hasLiveSpreadExecution(): boolean {
    return records.some(r => r.state.started && !isTerminalPhase(r.state.phase));
}

/** 開始一筆兩腳價差單；同商品同帳戶已有執行中（含結果不明）時拒絕 */
export function startSpreadExecution(req: StartSpreadRequest): string {
    const unavailable = oddSpreadExecUnavailable();
    if (unavailable) throw new Error(unavailable);
    startOddSpreadService();
    const blocking = blockingExecutionFor(req.contract.code, req.account);
    if (blocking) {
        throw new Error(isTerminalPhase(blocking.state.phase)
            ? '較早的價差單還有標記「未送出」但券商未確認的委託；請先在該筆核對，確認沒有送出後按「確認沒有送出，結束追蹤」'
            : '此商品已有執行中的價差單（含結果未確認的委託），請先處理');
    }
    if (!envMatches(req.env)) throw new Error('確認期間伺服器或模擬／正式環境已切換，未送出，請重新確認');
    const env = req.env;
    const now = Date.now();
    const id = `os-${now.toString(36)}-${++seq}`;
    // 之前的執行（含已結束）保留追蹤晚到成交，不因新執行刪除
    records = pruneRecords([...records, {
        id,
        tagBase: newTagBase(now),
        env: { base: env.base, simulation: env.simulation },
        contract: req.contract,
        account: req.account,
        fees: req.fees,
        maxSlipTicks: req.maxSlipTicks,
        startedAt: now,
        state: initExec(req.plan),
    }], now);
    update(id, { type: 'start' });
    return id;
}

/** 使用者確認補單（數量與價格凍結在確認當下）；缺口已變、環境不符就不送，回 false */
export interface FrozenHedge {
    version: number;
    leg: LegKind;
    action: 'Buy' | 'Sell';
    quantity: number;
    orders: LegOrder[];
}

export function acceptHedge(id: string, frozen: FrozenHedge): boolean {
    const rec = records.find(r => r.id === id);
    if (!rec || !envMatches(rec.env)) return false;
    const before = rec.state;
    update(id, { type: 'hedgeAccept', ...frozen });
    const after = records.find(r => r.id === id)?.state;
    return !!after && after !== before && !after.pendingHedge;
}

export function spreadExecAction(id: string, event: Extract<ExecEvent, { type: 'cancel' | 'hedgeDecline' | 'resolveUnknown' | 'abandonUnknown' }>) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    if (!envMatches(rec.env)) {
        notify({ kind: 'err', title: '整零價差', body: `${ENV_PAUSED_TEXT}：請切回開始時的伺服器與${rec.env.simulation ? '模擬' : '正式'}環境再操作` });
        return;
    }
    update(id, event);
}

/** 以最新委託簿重算補單建議（面板「以最新價補單」前呼叫） */
export function refreshHedgeOrders(id: string): LegOrder[] | undefined {
    const rec = records.find(r => r.id === id);
    const p = rec?.state.pendingHedge;
    if (!rec || !p) return undefined;
    return contextFor(rec).quoteHedge(p.leg, p.action, p.quantity).orders;
}

/** 關閉顯示：已結束的執行仍保留到當日結束，晚到成交照樣對帳 */
export function dismissSpreadExecution(id: string) {
    const rec = records.find(r => r.id === id);
    if (!rec || (rec.state.started && !isTerminalPhase(rec.state.phase))) return;
    replace({ ...rec, dismissed: true });
    persist();
    emit();
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

const getRecords = () => records;

/** 此商品／帳戶所有未關閉（或重新需要處理）的執行，新的在前 */
export function executionsFor(all: SpreadExecRecord[], code: string, account: Account | undefined): SpreadExecRecord[] {
    // 已關閉的執行若仍會擋下新單（還有結果不明的委託），照樣列出讓使用者處理
    return all.filter(r => r.contract.code === code && accountMatches(r.account, account) && r.state.started
        && (!r.dismissed || r.state.slots.some(x => x.status === 'unknown'))).reverse();
}

/** 面板顯示：此商品／帳戶每一筆需要看／處理的執行（含較早的） */
export function useSpreadExecutions(code: string, account: Account | undefined): SpreadExecRecord[] {
    const all = useSyncExternalStore(subscribe, getRecords);
    return useMemo(() => executionsFor(all, code, account), [all, code, account]);
}

// ---- 點價鎖（持久化；彈出視窗與主視窗共用本機儲存） ----

export interface ClickLock {
    id: string;
    code: string;
    /** flashAccountKey */
    account: string;
    text: string;
    at: number;
}

const LOCK_KEY = 'sj-pro-odd-spread-click-locks-v1';
let locks: ClickLock[] | null = null;
const lockListeners = new Set<() => void>();

function readLocks(): ClickLock[] {
    try {
        const v = JSON.parse(localStorage.getItem(LOCK_KEY) ?? '[]') as ClickLock[];
        return Array.isArray(v) ? v.filter(l => l && typeof l.id === 'string') : [];
    } catch {
        return [];
    }
}

function getLocks(): ClickLock[] {
    if (locks === null) {
        locks = readLocks();
        // 其他視窗改了鎖 → 重新讀
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('storage', e => {
                if (e.key !== LOCK_KEY) return;
                locks = readLocks();
                for (const l of lockListeners) l();
            });
        }
    }
    return locks;
}

function setLocks(next: ClickLock[]) {
    locks = next;
    try {
        localStorage.setItem(LOCK_KEY, JSON.stringify(next));
    } catch {
        // 本機儲存不可用：只在本次有效
    }
    for (const l of lockListeners) l();
}

/** 加上點價鎖（送出前就加，送出途中重新整理也不會遺失） */
export function addClickLock(code: string, account: Account, text: string): string {
    const id = `lk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setLocks([...getLocks(), { id, code, account: flashAccountKey(account), text, at: Date.now() }]);
    return id;
}

export function updateClickLock(id: string, text: string) {
    setLocks(getLocks().map(l => (l.id === id ? { ...l, text } : l)));
}

export function clearClickLock(id: string) {
    setLocks(getLocks().filter(l => l.id !== id));
}

function subscribeLocks(l: () => void) {
    lockListeners.add(l);
    return () => { lockListeners.delete(l); };
}

export function clickLocksFor(code: string, account: Account | undefined): ClickLock[] {
    const key = account ? flashAccountKey(account) : '';
    return getLocks().filter(l => l.code === code && l.account === key);
}

export function useClickLocks(code: string, account: Account | undefined): ClickLock[] {
    const all = useSyncExternalStore(subscribeLocks, getLocks);
    const key = account ? flashAccountKey(account) : '';
    return useMemo(() => all.filter(l => l.code === code && l.account === key), [all, code, key]);
}

/** 已成交股數換算（面板顯示用） */
export function hedgeUnitLabel(leg: LegKind, quantity: number): string {
    return leg === 'odd' ? `零股 ${quantity.toLocaleString('en-US')} 股` : `整股 ${quantity} 張（${(quantity * SHARES_PER_LOT).toLocaleString('en-US')} 股）`;
}

// 測試用
export function setAuthRetryBaseForTest(ms: number) {
    authRetryBase = ms;
}

export function resetOddSpreadServiceForTest() {
    for (const id of [...releases.keys()]) releaseQuotes(id);
    records = [];
    started = false;
    listeners.clear();
    freshByAccount.clear();
    authGen.clear();
    for (const st of authRetry.values()) if (st.timer) clearTimeout(st.timer);
    authRetry.clear();
    reconciling = false;
    reconcileAgain = false;
    instanceSuspect = false;
    locks = null;
    lockListeners.clear();
}
