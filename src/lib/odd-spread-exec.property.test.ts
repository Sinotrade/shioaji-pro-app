// 整零價差：狀態機＋委託列對帳的固定種子隨機序列測試（repo 沒有 fast-check）。
//
// 模擬券商（委託以券商 id 回報、帶我們的唯一標記）：
// - 下單：送出前最後一刻檢查環境；成功／結果不明（一半其實送到）／確定未送出；
//   HTTP 回應延遲、亂序。
// - 成交：部分、全部；刪單請求送達後、生效前仍可能成交；刪單生效另一步。
// - 刪單依指令帶的「券商 id」找單（不是內部 key）：舊 id 若被別的委託重用就會刪錯。
// - 券商晚到的拒單；正常改價；委託列暫時漏列某筆；回讀落後（含刪單後仍 Submitted、
//   刪單量涵蓋全部，ADR 0004）。
// - App 重新整理：在途 HTTP 遺失、狀態機接回、頁面身分改變。
// - sidecar 重啟：新程序、所有委託換新 id、舊 id 可能被無關（可能仍在委託中的）委託
//   重用；在途請求以錯誤結束。
// - 伺服器身分＝串流連線世代：sidecar 重啟必然中斷串流，身分先變成「無法判定」
//   （新程序的資料在串流恢復前就已看不到舊程序），恢復後換新世代。另有不重啟的
//   串流中斷（身分改變但 id 其實仍有效）。重啟不一定馬上換世代：無法判定的期間
//   可能很長，也可能在世代恢復前就讀到新程序的委託列。
// - 環境切換：API base 或模擬／正式改變一段時間。
// - 使用者：取消、標記未送出（1/4 的序列會誤標已送出的委託）、補單接受／拒絕。
//
// 判定（oracle）獨立於執行器，只用券商端真實狀態、送出的指令與模擬使用者的明確
// 操作（拒絕補單的數量）：
//   (a) sequential 零股送出總量 ≤ 計畫（誤標序列也檢查）。
//   (x) 從不刪到別人的委託（誤標序列也檢查）。
//   (b) 靜止後，補單造成的成交不得超過需要量（誤標序列除外）。
//   (s) 靜止後，若某腳最多可能成交超過需要量，該腳每一筆仍在委託中的補單都必須已被刪
//       （或刪單失敗、已通知）——只看這一筆本身（誤標序列也檢查）。
//   (l) 靜止後，另一腳已確定、缺口未被使用者明確放棄 → 已補單，或停在「未配對待處理」，
//       或有一筆真的沒送到券商、等使用者核對的「結果不明」（誤標序列除外）。
//   (c) 靜止後，券商端每一筆我們的委託都以目前 id 追蹤、成交量一致；在委託中的必為在途
//       （誤標序列也檢查）。
//   (d) 同一意圖不會送兩次；券商端不會出現兩筆同標記的委託（誤標序列也檢查）。

import { describe, expect, it } from 'vitest';
import {
    execReduce,
    initExec,
    isBrokerFinal,
    isLive,
    restoreAfterReload,
    type ExecCommand,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type LegKind,
} from './odd-spread-exec';
import { reconcileEvents, slotTag, type TradeLike } from './odd-spread-reconcile';

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ACC = { account_type: 'S', broker_id: 'BR', account_id: 'A' };
const TAG_BASE = 'abc';

interface BrokerOrder {
    key: string | null; // null＝不是我們的委託
    id: string;
    tag?: string;
    leg: LegKind;
    action: 'Buy' | 'Sell';
    price: number;
    qty: number;
    filled: number;
    cancelled: number;
    status: 'live' | 'filled' | 'cancelled' | 'failed';
    cancelReq: boolean;
    topUp: boolean;
    hidden: boolean;
    /** 新程序的快取裡有沒有這筆（重啟後要權威讀取才載入） */
    inCache: boolean;
    /** 委託列目前看到的快照 */
    seen: { status: string; filled: number; cancelled: number; price: number };
}

interface Env { base: string; simulation: boolean }

function simulate(seed: number) {
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const chance = (p: number) => r() < p;

    const mode = chance(0.5) ? 'sequential' : 'simultaneous';
    const sloppy = seed % 4 === 0;
    const lots = 1 + Math.floor(r() * 2);
    const oddCap = lots * 1000;
    const oddOrders: { price: number; quantity: number }[] = [];
    for (let left = oddCap; left > 0;) {
        const q = Math.min(left, 999, 100 + Math.floor(r() * 900));
        oddOrders.push({ price: 100, quantity: q });
        left -= q;
    }
    const plan: ExecPlan = { direction: chance(0.5) ? 'buyRoundSellOdd' : 'buyOddSellRound', mode, lots, roundPrice: 100, oddOrders, netPerShare: 1 };

    const bound: Env = { base: 'b1', simulation: true };
    let env: Env = { ...bound };
    let envSteps = 0;
    const envOk = () => env.base === bound.base && env.simulation === bound.simulation;

    // 伺服器身分（串流連線世代）。sidecar 重啟後有一段「前端還沒察覺」的時間：身分仍是
    // 舊的，但 HTTP 已打到新程序（可能已是另一個模式）
    let page = 0;
    let epoch = 1;
    let streamDownSteps = 0;
    let detectSteps = 0;
    let trueSim = bound.simulation; // 伺服器實際的模式
    const identity = (): string | null => (streamDownSteps > 0 ? null : `p${page}e${epoch}`);
    // App 端的委託列快照：每一列帶讀取時的身分；重啟後舊快照仍可能留著
    let snapshot: TradeLike[] = [];
    const stamps = new Map<TradeLike, string | null>();
    let wrongMarked = false;
    let staleConfirms = 0;
    let serverRefusals = 0;
    let openConfirm: { version: number; leg: LegKind; action: 'Buy' | 'Sell'; quantity: number; orders: { price: number; quantity: number }[] } | null = null;

    let s: ExecState = initExec(plan);
    let idSeq = 0;
    const book: BrokerOrder[] = []; // 我們的與別人的委託（同一個 id 空間）
    const ours = () => book.filter(o => o.key !== null);
    let http: ExecEvent[] = [];
    let outbox: { c: ExecCommand; gen: string | null }[] = [];
    let held: ExecEvent[] = [];
    const sentKeys: string[] = [];
    const startKeys = new Set<string>();
    let oddPlaced = 0;
    let started = false;
    let foreignCancelled = 0;
    const waivedT: Record<LegKind, number> = { odd: 0, round: 0 };
    const log: string[] = [];

    const ctx: ExecContext = {
        currentGen: identity,
        quoteHedge: (_leg, _action, quantity) => (chance(0.7)
            ? { ok: true, orders: [{ price: 100, quantity }] }
            : { ok: false, reason: '超過滑價上限', orders: [{ price: 101, quantity }] }),
    };

    const newId = () => `id${++idSeq}`;
    const lotOf = (leg: LegKind) => (leg === 'odd' ? 'IntradayOdd' : 'Common');
    const tradeOf = (o: BrokerOrder): TradeLike => ({
        account: ACC,
        contract: { code: '2330' },
        order: { id: o.id, action: o.action, price: o.seen.price, quantity: o.qty, order_lot: lotOf(o.leg), ...(o.tag ? { custom_field: o.tag } : {}) },
        status: { status: o.seen.status, deal_quantity: o.seen.filled, cancel_quantity: o.seen.cancelled },
    });
    const truthStatus = (o: BrokerOrder) => (o.status === 'live' ? (o.filled > 0 ? 'PartFilled' : 'Submitted') : o.status === 'filled' ? 'Filled' : o.status === 'cancelled' ? 'Cancelled' : 'Failed');
    const see = (o: BrokerOrder, readBackQuirk = false) => {
        o.seen = { status: readBackQuirk && o.status === 'cancelled' ? 'Submitted' : truthStatus(o), filled: o.filled, cancelled: o.cancelled, price: o.price };
    };
    const reportOf = (o: BrokerOrder): ExecEvent => {
        const st = o.seen.status;
        return { type: 'report', key: o.key!, filled: o.seen.filled, cancelled: o.seen.cancelled,
            status: st === 'Filled' ? 'filled' : st === 'Cancelled' ? 'cancelled' : st === 'Failed' ? 'failed' : 'working' };
    };
    const fail = (msg: string) => expect.fail(`${msg}\n${log.join('\n')}`);

    const createAtBroker = (c: Extract<ExecCommand, { kind: 'place' }>): BrokerOrder => {
        if (trueSim !== bound.simulation) fail(`(m) order ${c.key} created in the other mode`);
        const o: BrokerOrder = {
            key: c.key, id: newId(), tag: slotTag(TAG_BASE, c.key), leg: c.leg, action: c.action, price: c.price, qty: c.quantity,
            filled: 0, cancelled: 0, status: 'live', cancelReq: false, topUp: !startKeys.has(c.key), hidden: false, inCache: true,
            seen: { status: 'PendingSubmit', filled: 0, cancelled: 0, price: c.price },
        };
        see(o);
        book.push(o);
        return o;
    };

    const check = () => {
        if (new Set(sentKeys).size !== sentKeys.length) fail('(d) duplicate place');
        const tags = ours().map(o => o.tag);
        if (new Set(tags).size !== tags.length) fail('(d) duplicate tag at broker');
        if (mode === 'sequential' && oddPlaced > oddCap) fail(`(a) odd sent ${oddPlaced}`);
        if (foreignCancelled > 0) fail('(x) cancelled a foreign order');
    };

    const reduce = (e: ExecEvent): ExecCommand[] => {
        const res = execReduce(s, e, ctx);
        s = res.state;
        log.push(`${e.type}${'key' in e ? ` ${e.key}` : ''}${e.type === 'placed' ? ` ${e.orderId} gen=${e.gen}` : ''} → ${s.phase} ${res.commands.map(c => `${c.kind}:${c.key}${c.kind === 'cancel' ? `@${c.orderId}` : ''}`).join(',')}`);
        for (const c of res.commands) {
            if (c.kind === 'place') {
                sentKeys.push(c.key);
                if (!started) startKeys.add(c.key);
                if (c.leg === 'odd') oddPlaced += c.quantity;
            }
            if (c.kind === 'place' && c.leg === 'odd' && c.quantity > 999) fail(`odd order over 999 shares: ${c.quantity}`);
            outbox.push({ c, gen: identity() });
        }
        check();
        return res.commands;
    };
    // 服務層：環境不符時回報保留
    const feed = (e: ExecEvent) => {
        if (envOk()) reduce(e);
        else held.push(e);
    };
    // 讀委託列（新程序的列、帶讀取當下的身分）
    let authGenH: string | null = null;
    let authFailures = 0;
    let authPending = false;
    const fetchListing = (refresh = false) => {
        if (refresh) for (const o of book) o.inCache = true;
        snapshot = book.filter(o => !o.hidden && o.inCache).map(tradeOf);
        const g = identity();
        for (const t of snapshot) stamps.set(t, g);
    };
    // 服務每次對帳都先向伺服器（目前的程序）讀一次委託列，帶讀取當下的身分
    const reconcile = () => {
        if (!envOk()) return;
        const gen = identity();
        // 身分一換、且有在途或結果不明的委託 → 先做權威讀取（可能失敗，下次再試）
        const needAuth = gen !== null && authGenH !== gen && s.slots.some(x => !isBrokerFinal(x) || x.cancelState === 'unknown');
        if (needAuth) {
            if (chance(0.2)) { authFailures++; authPending = true; return; } // 服務會退避重試
            authPending = false;
            fetchListing(true);
            authGenH = gen;
        } else fetchListing(false);
        const trusted = new Set(gen === null ? [] : s.slots.filter(x => x.orderId && x.idGen === gen).map(x => x.orderId!));
        for (const e of reconcileEvents({ tagBase: TAG_BASE, code: '2330', account: ACC, state: s }, snapshot, trusted, gen, t => stamps.get(t) ?? null)) reduce(e);
    };
    // 服務層送出前的新鮮檢查：身分與指令產生時相同、重新讀 /info 的模式相同
    const serverOk = (gen: string | null) => envOk() && gen !== null && identity() === gen && trueSim === bound.simulation;
    const execOne = ({ c, gen: genAtCmd }: { c: ExecCommand; gen: string | null }) => {
        if (c.kind === 'place') {
            if (!serverOk(genAtCmd)) { serverRefusals++; http.push({ type: 'placeFailed', key: c.key, error: 'server check' }); return; }
            // 券商：零股每筆上限 999 股
            if (c.leg === 'odd' && c.quantity > 999) { http.push({ type: 'placeFailed', key: c.key, error: '>999' }); return; }
            const genAtSend = identity();
            const roll = r();
            if (roll < 0.6) {
                const o = createAtBroker(c);
                const g = identity();
                http.push({ type: 'placed', key: c.key, orderId: o.id, gen: g !== null && g === genAtSend ? g : null }, reportOf(o));
            } else if (roll < 0.85) {
                if (chance(0.5)) createAtBroker(c);
                http.push({ type: 'placeUnknown', key: c.key, error: 'timeout' });
            } else {
                http.push({ type: 'placeFailed', key: c.key, error: 'refused' });
            }
        } else {
            // 服務層防線：身分無法判定或與取得 id 時不同 → 不送刪單
            const slot = s.slots.find(x => x.key === c.key);
            if (!serverOk(genAtCmd) || slot?.idGen !== identity()) {
                http.push({ type: 'cancelResult', key: c.key, ok: false, error: 'untrusted id' });
                return;
            }
            // 刪單前讀伺服器（新程序）委託快取：這個編號的列必須帶本單標記
            const row = book.find(x => x.id === c.orderId);
            if (!row || row.tag !== slotTag(TAG_BASE, c.key)) {
                http.push({ type: 'cancelResult', key: c.key, ok: false, error: 'tag mismatch' });
                return;
            }
            // 券商依指令帶的 id 找單
            const o = book.find(x => x.id === c.orderId);
            if (!o || chance(0.2)) { http.push({ type: 'cancelResult', key: c.key, ok: false, error: 'busy' }); return; }
            if (o.key !== c.key) {
                if (o.status === 'live') foreignCancelled++;
                o.cancelReq = true;
            } else if (o.status === 'live') o.cancelReq = true;
            http.push({ type: 'cancelResult', key: c.key, ok: true });
        }
    };
    const loseInFlight = () => {
        for (const { c, gen } of outbox) if (c.kind === 'place' && serverOk(gen) && chance(0.5)) createAtBroker(c);
        outbox = [];
        http = [];
    };
    const failInFlight = () => {
        const next: ExecEvent[] = [];
        for (const { c, gen } of outbox) {
            if (c.kind === 'place') {
                if (serverOk(gen) && chance(0.5)) createAtBroker(c);
                next.push({ type: 'placeUnknown', key: c.key, error: 'sidecar restart' });
            } else next.push({ type: 'cancelResult', key: c.key, ok: false, error: 'sidecar restart' });
        }
        for (const e of http) {
            if (e.type === 'placed') next.push({ type: 'placeUnknown', key: e.key, error: 'sidecar restart' });
            else if (e.type === 'cancelResult') next.push({ ...e, ok: false, error: 'sidecar restart' });
            else if (e.type !== 'report') next.push(e);
        }
        outbox = [];
        http = next;
    };
    const replayHeld = () => {
        const evs = held;
        held = [];
        for (const e of evs) reduce(e);
        reconcile();
    };
    const streamBack = () => {
        epoch++;
        log.push(`stream live e${epoch}`);
        fetchListing();
        if (envOk()) {
            reduce({ type: 'refresh' });
            reconcile();
        }
    };

    reduce({ type: 'start' });
    started = true;
    for (let step = 0; step < 160; step++) {
        if (envSteps > 0 && --envSteps === 0) {
            env = { ...bound, simulation: trueSim };
            log.push('env back');
            replayHeld();
        }
        if (detectSteps > 0 && --detectSteps === 0) {
            // 前端察覺串流中斷；/info 也更新快取的模式
            streamDownSteps = 1 + Math.floor(r() * 8);
            env = { ...env, simulation: trueSim };
            log.push(`restart detected (stream down ${streamDownSteps})`);
            if (envOk() && held.length) replayHeld(); // 服務在伺服器資訊更新時處理保留的回報
        } else if (streamDownSteps > 0 && --streamDownSteps === 0) streamBack();
        const roll = r();
        const live = ours().filter(o => o.status === 'live');
        if (roll < 0.13 && outbox.length) {
            execOne(outbox.splice(Math.floor(r() * outbox.length), 1)[0]!);
        } else if (roll < 0.27 && http.length) {
            feed(http.splice(Math.floor(r() * http.length), 1)[0]!);
        } else if (roll < 0.4 && live.length) {
            const o = pick(live);
            o.filled += 1 + Math.floor(r() * (o.qty - o.filled));
            if (o.filled >= o.qty) o.status = 'filled';
        } else if (roll < 0.45) {
            const o = book.find(x => x.cancelReq && x.status === 'live');
            if (o) { o.status = 'cancelled'; o.cancelled = o.qty - o.filled; }
        } else if (roll < 0.47 && live.length) {
            pick(live).status = 'failed'; // 晚到拒單
        } else if (roll < 0.5 && live.length) {
            const o = pick(live);
            o.price += chance(0.5) ? 1 : -1; // 正常改價
        } else if (roll < 0.53 && book.length) {
            const o = pick(book);
            o.hidden = !o.hidden; // 委託列暫時漏列
        } else if (roll < 0.64 && book.length) {
            see(pick(book), chance(0.3));
            reconcile();
        } else if (roll < 0.68 && envOk()) {
            feed({ type: 'cancel' });
        } else if (roll < 0.72 && envOk()) {
            const cand = s.slots.filter(x => x.status === 'unknown' && !x.markedUnsent && (sloppy || !ours().some(o => o.key === x.key)));
            if (cand.length) {
                const k = pick(cand).key;
                if (ours().some(o => o.key === k)) wrongMarked = true;
                feed({ type: 'resolveUnknown', key: k });
            }
            // 核對後確認真的沒送出 → 結束追蹤（只對券商端確實沒有的）
            const marked = s.slots.filter(x => x.status === 'unknown' && x.markedUnsent && !ours().some(o => o.key === x.key));
            if (marked.length && chance(0.3)) feed({ type: 'abandonUnknown', key: pick(marked).key });
        } else if (roll < 0.74 && s.pendingHedge && !openConfirm) {
            // 打開補單確認視窗：凍結當下看到的內容（之後才按確認，期間待補內容可能改變）
            const p = s.pendingHedge;
            if (p.orders.reduce((a, o) => a + o.quantity, 0) === p.quantity) openConfirm = { version: p.version, leg: p.leg, action: p.action, quantity: p.quantity, orders: p.orders.map(o => ({ ...o })) };
        } else if (roll < 0.78 && envOk() && (openConfirm || s.pendingHedge)) {
            if (openConfirm && chance(0.65)) {
                const f = openConfirm;
                openConfirm = null;
                const stale = !s.pendingHedge || s.pendingHedge.version !== f.version;
                const cmds = reduce({ type: 'hedgeAccept', ...f });
                const places = cmds.filter(c => c.kind === 'place');
                if (stale) {
                    staleConfirms++;
                    if (places.length) fail('stale confirmation was accepted');
                }
                if (places.some(c => c.kind === 'place' && (c.leg !== f.leg || c.action !== f.action))) fail('hedge sent a different leg than confirmed');
                if (places.reduce((a, c) => a + (c.kind === 'place' ? c.quantity : 0), 0) > f.quantity) fail('hedge sent more than confirmed');
            } else if (s.pendingHedge) {
                const p = s.pendingHedge;
                openConfirm = null;
                waivedT[p.leg] += p.quantity; // 使用者明確放棄的量
                reduce({ type: 'hedgeDecline', version: p.version });
            }
        } else if (roll < 0.82) {
            // App 重新整理：新頁面身分
            loseInFlight();
            page++;
            s = restoreAfterReload(JSON.parse(JSON.stringify(s)) as ExecState);
            log.push(`reload p${page}`);
            if (envOk() && identity() !== null) {
                reduce({ type: 'refresh' });
                reconcile();
            }
        } else if (roll < 0.86) {
            // sidecar 重啟：委託換 id、舊 id 可能被別人的（仍在委託中的）委託重用；新程序可能
            // 是另一個模式；前端要過一段時間才察覺（期間身分不變、HTTP 已打到新程序）
            failInFlight();
            // 新程序：快取裡沒有斷線前的委託，要權威讀取才載入
            for (const o of book) o.inCache = false;
            if (chance(0.25)) trueSim = !trueSim;
            else trueSim = bound.simulation;
            for (const o of ours()) {
                const old = o.id;
                o.id = newId();
                if (chance(0.4)) {
                    const foreign: BrokerOrder = {
                        key: null, id: old, leg: o.leg, action: o.action, price: o.price, qty: o.qty, filled: chance(0.5) ? o.qty : 0,
                        cancelled: 0, status: 'live', cancelReq: false, topUp: false, hidden: false, inCache: true,
                        seen: { status: 'Submitted', filled: 0, cancelled: 0, price: o.price },
                    };
                    if (foreign.filled >= foreign.qty) foreign.status = 'filled';
                    see(foreign);
                    book.push(foreign);
                }
            }
            detectSteps = Math.floor(r() * 4);
            if (detectSteps === 0) {
                streamDownSteps = 1 + Math.floor(r() * 10);
                env = { ...env, simulation: trueSim };
                if (envOk() && held.length) replayHeld();
            }
            log.push(`sidecar restart sim=${trueSim} (detect after ${detectSteps})`);
            // 察覺前後都可能讀到新程序的委託列
            if (chance(0.5)) { fetchListing(); reconcile(); }
        } else if (roll < 0.88 && streamDownSteps === 0 && detectSteps === 0) {
            // 不重啟的串流中斷：id 仍有效，但身分會換
            streamDownSteps = 1 + Math.floor(r() * 5);
            log.push(`stream blip (${streamDownSteps})`);
        } else if (roll < 0.91 && envOk() && detectSteps === 0) {
            env = chance(0.5) ? { base: 'b2', simulation: true } : { base: 'b1', simulation: false };
            envSteps = 3 + Math.floor(r() * 6);
            log.push(`env switch ${env.base}/${env.simulation}`);
        }
    }

    // ---- 靜止：環境與串流回來、不再成交；指令、回應、刪單生效、委託列全部跑完 ----
    // 伺服器回到原模式（若重啟成另一模式，再重啟一次回來）、前端都已察覺
    if (trueSim !== bound.simulation || detectSteps > 0) {
        trueSim = bound.simulation;
        detectSteps = 0;
        streamDownSteps = 1;
        log.push('restart back to bound mode');
    }
    if (!envOk() || held.length) { env = { ...bound }; log.push('env back'); replayHeld(); }
    if (streamDownSteps > 0) { streamDownSteps = 0; streamBack(); }
    for (const o of book) o.hidden = false;
    fetchListing();
    for (let guard = 0; guard < 300; guard++) {
        let did = false;
        while (outbox.length) { execOne(outbox.shift()!); did = true; }
        while (http.length) { feed(http.shift()!); did = true; }
        for (const o of book) {
            if (o.cancelReq && o.status === 'live') { o.status = 'cancelled'; o.cancelled = o.qty - o.filled; did = true; }
        }
        for (const o of book) see(o);
        fetchListing();
        const before = JSON.stringify(s);
        reconcile();
        reduce({ type: 'refresh' });
        if (JSON.stringify(s) !== before) did = true;
        if (!did && !outbox.length && !http.length && !authPending) break;
    }
    const L = () => log.join('\n');

    // ---- oracle：只用券商真實狀態、送出的指令與使用者明確的放棄 ----
    const filledT = (leg: LegKind) => ours().filter(o => o.leg === leg).reduce((a, o) => a + o.filled, 0);
    const liveRemT = (leg: LegKind) => ours().filter(o => o.leg === leg && o.status === 'live').reduce((a, o) => a + o.qty - o.filled, 0);
    const roundNeed = (sh: number) => (sh >= oddCap ? lots : Math.min(lots, Math.floor(sh / 1000)));
    const oddNeed = (lt: number) => (lt >= lots ? oddCap : Math.min(oddCap, lt * 1000));
    const other = (leg: LegKind): LegKind => (leg === 'odd' ? 'round' : 'odd');
    const need = (leg: LegKind, x: number) => (leg === 'round' ? roundNeed(x) : oddNeed(x));
    const hedgeLegs: LegKind[] = mode === 'sequential' ? ['round'] : ['round', 'odd'];

    for (const leg of hedgeLegs) {
        const o = other(leg);
        const needMax = need(leg, filledT(o) + liveRemT(o));
        const needMin = need(leg, filledT(o));
        const pot = filledT(leg) + liveRemT(leg);
        const topUpFilled = ours().filter(x => x.leg === leg && x.topUp).reduce((a, x) => a + x.filled, 0);
        // (b) 補單造成的超額成交：不允許
        if (!wrongMarked && Math.min(filledT(leg) - needMax, topUpFilled) > 0) fail(`(b) ${leg} over-hedged: filled ${filledT(leg)} need ${needMax}`);
        // (s) 仍在委託中的多餘補單，每一筆本身都必須已刪（或刪單失敗、已通知）
        if (pot > needMax) {
            for (const x of ours().filter(y => y.leg === leg && y.topUp && y.status === 'live')) {
                const slot = s.slots.find(y => y.key === x.key);
                if (slot?.cancelState !== 'failed') fail(`(s) live surplus top-up ${x.key} not cancelled`);
            }
        }
        // (l) 另一腳確定、缺口未被明確放棄 → 已補、或等使用者決定
        const determined = liveRemT(o) === 0;
        const gap = needMin - pot - waivedT[leg];
        if (!wrongMarked && determined && gap > 0) {
            // 只有「真的沒送到券商」的結果不明委託才算在等使用者，而且要能解釋這個缺口：
            // 在這一腳、剩餘量涵蓋缺口，或在另一腳（讓另一腳在執行器看來尚未確定）
            const trulyUnknown = s.slots.filter(x => x.status === 'unknown' && !x.markedUnsent && !ours().some(b => b.key === x.key));
            const unknownOnLeg = trulyUnknown.filter(x => x.leg === leg).reduce((acc, x) => acc + x.quantity - x.filled, 0);
            const explains = unknownOnLeg >= gap || trulyUnknown.some(x => x.leg === o);
            if (!(s.pendingHedge?.leg === leg || explains)) fail(`(l) ${leg} gap ${gap} neither hedged nor awaiting user\n${JSON.stringify(s.slots)}`);
        }
    }
    // (c) 追蹤
    for (const o of ours()) {
        const slot = s.slots.find(x => x.key === o.key);
        if (!slot) fail(`(c) untracked ${o.key}`);
        // 券商確認終態的委託不再變動，不必換成新程序的 id；其他的必須以目前 id 追蹤
        if (!isBrokerFinal(slot!) && slot!.orderId !== o.id) fail(`(c) ${o.key} bound to ${slot!.orderId}, broker id ${o.id}\n${L()}`);
        if (slot!.filled !== o.filled) fail(`(c) ${o.key} filled ${slot!.filled} vs ${o.filled}`);
        if (o.status === 'live' && !isLive(slot!)) fail(`(c) live ${o.key} not tracked as live`);
    }
    return {
        mode,
        phase: s.phase,
        topUps: ours().filter(o => o.topUp).length,
        restarts: log.some(l => l.startsWith('sidecar restart')),
        blips: log.some(l => l.startsWith('stream blip')),
        envSwitch: log.some(l => l.startsWith('env switch')),
        lateFail: ours().some(o => o.status === 'failed'),
        foreignLive: book.some(o => o.key === null && o.status === 'live'),
        waived: waivedT.odd + waivedT.round > 0,
        staleConfirms,
        serverRefusals,
    };
}

describe('整零價差：隨機事件序列的不變式（獨立 oracle）', () => {
    it('6,000 組固定種子', { timeout: 120_000 }, () => {
        const seen = { topUps: 0, restarts: 0, blips: 0, env: 0, lateFail: 0, foreignLive: 0, waived: 0, staleConfirms: 0, serverRefusals: 0, modes: new Set<string>(), phases: new Set<string>() };
        for (let seed = 1; seed <= 6000; seed++) {
            const res = simulate(seed);
            seen.modes.add(res.mode);
            seen.phases.add(res.phase);
            if (res.topUps) seen.topUps++;
            if (res.restarts) seen.restarts++;
            if (res.blips) seen.blips++;
            if (res.envSwitch) seen.env++;
            if (res.lateFail) seen.lateFail++;
            if (res.foreignLive) seen.foreignLive++;
            if (res.waived) seen.waived++;
            seen.staleConfirms += res.staleConfirms;
            seen.serverRefusals += res.serverRefusals;
        }
        // 確實涵蓋到各種情況
        expect(seen.modes.size).toBe(2);
        expect(seen.phases.size).toBeGreaterThan(4);
        expect(seen.topUps).toBeGreaterThan(300);
        expect(seen.restarts).toBeGreaterThan(500);
        expect(seen.blips).toBeGreaterThan(300);
        expect(seen.env).toBeGreaterThan(500);
        expect(seen.lateFail).toBeGreaterThan(500);
        expect(seen.foreignLive).toBeGreaterThan(300);
        expect(seen.waived).toBeGreaterThan(100);
        expect(seen.staleConfirms).toBeGreaterThan(10); // 確認視窗開著時待補內容改變
        expect(seen.serverRefusals).toBeGreaterThan(100); // 重啟察覺前被新鮮檢查擋下的送單
    });
});

describe('對帳：唯一標記與伺服器身分', () => {
    const slot = { key: 'odd:0', leg: 'odd' as const, action: 'Sell' as const, price: 100, quantity: 300, status: 'working' as const, filled: 0, orderId: 'OLD', idGen: 'g0' };
    const state = { ...initExec({ direction: 'buyRoundSellOdd', mode: 'sequential', lots: 1, roundPrice: 100, oddOrders: [{ price: 100, quantity: 300 }] }), started: true, slots: [slot] };
    const rec = { tagBase: TAG_BASE, code: '2330', account: ACC, state };
    const tr = (id: string, tag: string | undefined, filled = 0, price = 100): TradeLike => ({
        account: ACC, contract: { code: '2330' },
        order: { id, action: 'Sell', price, quantity: 300, order_lot: 'IntradayOdd', ...(tag ? { custom_field: tag } : {}) },
        status: { status: 'Submitted', deal_quantity: filled, cancel_quantity: 0 },
    });
    const tag = slotTag(TAG_BASE, 'odd:0');
    it('同標記換了 id → rebind（改過價也認得）', () => {
        expect(reconcileEvents(rec, [tr('NEW', tag, 5, 101)], new Set(), 'g1')).toEqual([
            { type: 'placed', key: 'odd:0', orderId: 'NEW', gen: 'g1', rebind: true },
            { type: 'report', key: 'odd:0', filled: 5, status: 'working', cancelled: 0 },
        ]);
    });
    it('身分變了或無法判定：舊 id 被別的委託重用 → 不採用', () => {
        expect(reconcileEvents(rec, [tr('OLD', undefined, 300)], new Set(), 'g1')).toEqual([]);
        expect(reconcileEvents(rec, [tr('OLD', undefined, 300)], new Set(), null)).toEqual([]);
        expect(reconcileEvents(rec, [tr('OLD', 'oxyz00', 300)], new Set(), 'g1')).toEqual([]);
    });
    it('沒有標記的列一律不自動採用（即使 id 相同、同一身分）；使用者指定過的才以 id 對帳', () => {
        expect(reconcileEvents(rec, [tr('OLD', undefined, 7, 102)], new Set(), 'g0')).toEqual([]);
        const claimedRec = { ...rec, state: { ...state, slots: [{ ...slot, userClaimed: true }] } };
        expect(reconcileEvents(claimedRec, [tr('OLD', undefined, 7, 102)], new Set(), 'g0')).toEqual([{ type: 'report', key: 'odd:0', filled: 7, status: 'working', cancelled: 0 }]);
        expect(reconcileEvents(claimedRec, [tr('OLD', undefined, 7)], new Set(), 'g1')).toEqual([]);
        expect(reconcileEvents(claimedRec, [tr('OLD', 'oxyz00', 7)], new Set(), 'g0')).toEqual([]);
    });
    it('舊身分時讀到的列（舊快照）不能把 id 授予目前身分', () => {
        const staleRow = tr('NEW', tag, 5);
        expect(reconcileEvents(rec, [staleRow], new Set(), 'g1', () => 'g0')).toEqual([]);
        expect(reconcileEvents(rec, [staleRow], new Set(), 'g1', () => 'g1')[0]).toMatchObject({ type: 'placed', orderId: 'NEW', gen: 'g1' });
    });
    it('同一標記對到多列 → 不接回', () => {
        expect(reconcileEvents(rec, [tr('A', tag), tr('B', tag)], new Set(), 'g1')).toEqual([]);
    });
});
