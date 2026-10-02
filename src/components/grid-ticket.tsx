// src/components/grid-ticket.tsx — 鋪單 (order grid): lay N limit orders
// at stepped price levels in one click, cancel them in one click, and an
// optional 動態跟隨 mode that cancel/replaces the grid as the last price
// moves so the ladder keeps its distance. Grid orders are tagged with
// custom_field so only our own orders are touched.

import { canTrade } from '../lib/account-tradable';

import { RefreshCw, Zap } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import { ORDER_CONTEXT_CHANGED_MESSAGE, useOrderContext } from '../hooks/use-order-context';
import { accountConfirmLabel, requestOrderConfirm } from '../lib/order-confirm';
import {
    ACCOUNT_CHANGED_MESSAGE,
    captureSelectedAccount,
    isSelectedAccountUnchanged,
    usableCapturedAccount,
} from '../lib/order-account';
import { accountMatches } from '../lib/flash-account';
import { useAccounts } from '../lib/account-store';
import { maskAccountId, usePrivacyMode } from '../lib/privacy';
import type { Account } from '../lib/types/portfolio';
import { cancellationSummary } from '../lib/trade-mutations';
import { checkOrderAllowed, getRiskSettings } from '../lib/risk';
import {
    cancelOrder,
    cancelOrders,
    placeFuturesOrder,
    placeStockOrder,
} from '../lib/shioaji';
import { getAliasFor } from '../lib/stream';
import { isFuturesContract, notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import {
    ACTIVE_ORDER_STATUSES,
    type Action,
    type Trade,
} from '../lib/types/order';
import { fmtPrice } from '../lib/utils/format';
import { isOddLot, ODD_LOT_MAX_SHARES, oddLotReferencePrice, orderQtyUnit, type OddBaseQuote } from '../lib/odd-lot';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import { loadOrderLotPreference, saveOrderLotPreference, QUICK_ORDER_LOTS } from '../lib/order-lot-preference';
import * as styles from './order-ticket.css';
import * as flash from './flash-order.css';
import * as panel from './panel.css';

const GRID_TAG = 'sjgrid';
const MAX_LEVELS = 15;
const FOLLOW_INTERVAL_MS = 2500;
const MAX_OPS_PER_CYCLE = 4;

const keyOf = (p: number) => p.toFixed(2);

// 網格單的擁有者（#204）：custom_field 只能帶固定標記，同一檔可能有多個
// 鋪單面板（不同單位／帳戶／同單位不同面板）。每個面板（workspace block id）
// 記下自己送出的委託 id，存在 localStorage（依帳戶分組），重新整理與其他
// 視窗都看得到。全撤與動態跟隨的撤單只動本面板擁有的單；沒有擁有者的
// 網格單只用來避免重複補單，永遠不會被跟隨撤掉或取代。
const OWNERS_KEY = 'sj-pro-grid-owners';
const OWNERS_TTL_MS = 3 * 24 * 3600 * 1000;
const OWNERS_MAX = 2000;
type OwnerEntry = { owner: string; at: number };
type OwnerStore = Record<string, Record<string, OwnerEntry>>; // account key → order id → owner

const accountKeyOf = (a: Pick<Account, 'account_type' | 'broker_id' | 'account_id'> | undefined | null) =>
    a ? `${a.account_type}:${a.broker_id}:${a.account_id}` : '';

function readOwners(): OwnerStore {
    try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(OWNERS_KEY) ?? '{}') as unknown;
        return raw && typeof raw === 'object' ? raw as OwnerStore : {};
    } catch {
        return {};
    }
}

/** Owner (panel id) of a grid order, or undefined when no panel claims it. */
export function gridOwnerOf(account: Pick<Account, 'account_type' | 'broker_id' | 'account_id'> | undefined | null, orderId: string, store = readOwners()): string | undefined {
    const e = store[accountKeyOf(account)]?.[orderId];
    return e && typeof e.owner === 'string' ? e.owner : undefined;
}

export function recordGridOwner(account: Pick<Account, 'account_type' | 'broker_id' | 'account_id'>, orderId: string, owner: string): void {
    try {
        const store = readOwners();
        const key = accountKeyOf(account);
        const now = Date.now();
        const entries = { ...(store[key] ?? {}), [orderId]: { owner, at: now } };
        const kept = Object.entries(entries)
            .filter(([, e]) => e && now - Number(e.at) < OWNERS_TTL_MS)
            .sort((a, b) => Number(b[1].at) - Number(a[1].at))
            .slice(0, OWNERS_MAX);
        globalThis.localStorage?.setItem(OWNERS_KEY, JSON.stringify({ ...store, [key]: Object.fromEntries(kept) }));
    } catch { /* quota / private mode */ }
}

let gridInstanceSeq = 0;

export type GridBaseQuote = OddBaseQuote;

/** 鋪單基準價：整股取整股成交價（沒有則參考價）；盤中零股只看零股行情
 * （oddLotReferencePrice），沒有零股行情回 null（等待零股行情）。 */
export function gridBasePrice(
    odd: boolean,
    quote: GridBaseQuote | undefined,
    oddQuote: GridBaseQuote | undefined,
    reference: number | null | undefined,
    round: (p: number) => number,
): number | null {
    if (!odd) return quote?.tick ? Number(quote.tick.close) : reference || null;
    return oddLotReferencePrice(oddQuote, round);
}

export function GridTicket({
    panelId,
    contract,
    trades = [],
    onOrdersChanged,
}: {
    /** workspace block id — the persisted owner of this panel's grid orders */
    panelId?: string;
    contract: ContractInfo;
    trades?: Trade[];
    onOrdersChanged?: () => void;
}) {
    const quote = useQuote(contract.code);
    const live = useTradingLive();
    const [side, setSide] = useState<Action>('Buy');
    const [startOff, setStartOff] = useState(1); // ticks from last
    const [levels, setLevels] = useState(5);
    const [step, setStep] = useState(1); // ticks between levels
    const [qtyPer, setQtyPer] = useState(1);
    // 股票：整股（張）或盤中零股（股）（#204）
    const [lot, setLot] = useState<'Common' | 'IntradayOdd'>(() => loadOrderLotPreference('grid', contract, QUICK_ORDER_LOTS, 'Common'));
    const lotPreferences = useRef(new Map<string, 'Common' | 'IntradayOdd'>());
    const futures = isFuturesContract(contract);
    const odd = !futures && lot === 'IntradayOdd';
    const unit = orderQtyUnit(futures, lot);
    const captureContext = useOrderContext(contract, lot);
    const [armed, setArmed] = useState(false);
    const [follow, setFollow] = useState(false);
    const [busy, setBusy] = useState(false);
    const unitLabelId = useId();
    // account pinned by the running 動態跟隨 loop (display only)
    const [followAccountShown, setFollowAccountShown] = useState<Account | null>(null);
    const priv = usePrivacyMode();

    // 盤中零股網格以零股行情為基準（另一個撮合市場，#204）；沒有零股
    // 成交也沒有零股五檔時等待，不用整股價格
    const oddQuote = useQuote(odd ? contract.code : null, { oddLot: true });
    const last = gridBasePrice(odd, quote, oddQuote, contract.reference, p => roundToTick(contract, p));
    const waitingOdd = odd && last === null;
    const localId = useMemo(() => `grid-local-${Date.now().toString(36)}-${++gridInstanceSeq}`, []);
    const instanceId = panelId ? `grid:${panelId}` : localId;
    const instanceRef = useRef(instanceId);
    instanceRef.current = instanceId;
    const accountOf = (t: Trade) => (t as Trade & { account?: Account }).account ?? t.order.account;
    const ownerOf = (t: Trade, store?: OwnerStore) => gridOwnerOf(accountOf(t), t.order.id, store);

    // refs for the follow loop
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const tradesRef = useRef(trades);
    tradesRef.current = trades;
    const lastRef = useRef(last);
    lastRef.current = last;
    const sideRef = useRef(side);
    sideRef.current = side;
    const paramsRef = useRef({ startOff, levels, step, qtyPer, odd });
    paramsRef.current = { startOff, levels, step, qtyPer, odd };
    const onChangedRef = useRef(onOrdersChanged);
    onChangedRef.current = onOrdersChanged;
    const cycleBusy = useRef(false);
    // prices we placed recently — the trades poll may not reflect them yet,
    // and re-placing a level that's merely in flight would double the order
    const recentPlace = useRef(new Map<string, number>());
    const RECENT_MS = 15000;
    // Follow-mode cancels whose outcome is unknown (CANCEL_UNCONFIRMED or an
    // ambiguous failure). Never cancelled again automatically — that would be
    // a resend (ADR 0004); they stay until the user reconciles manually.
    const unresolvedCancels = useRef(new Set<string>());

    // reset on symbol change：每檔量只在輸入時的單位有效 — 之前是零股，或
    // 商品類別（股票／期貨）變了，都回 1（比對切換「之前」的單位；render 後
    // 的 odd 已經是新商品的值），500 股不會變成 500 口或 500 張（#204）
    const lotStateRef = useRef(lot);
    lotStateRef.current = lot;
    const unitClassRef = useRef(futures);
    useEffect(() => {
        setArmed(false);
        setFollow(false);
        recentPlace.current.clear();
        const classChanged = unitClassRef.current !== futures;
        unitClassRef.current = futures;
        const nextLot = futures ? 'Common' : lotPreferences.current.get(contract.code) ?? loadOrderLotPreference('grid', contract, QUICK_ORDER_LOTS, 'Common');
        if (lotStateRef.current !== 'Common' || lotStateRef.current !== nextLot || classChanged) setQtyPer(1);
        setLot(nextLot);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract.code, futures]);

    // our working grid orders for this symbol
    const gridOrders = useMemo(
        () =>
            trades.filter(
                (t) =>
                    ACTIVE_ORDER_STATUSES.has(t.status.status) &&
                    t.order.custom_field === GRID_TAG &&
                    (t.contract.code === contract.code ||
                        getAliasFor(t.contract.code) === contract.code),
            ),
        [trades, contract.code],
    );

    const desiredPrices = (base: number): number[] => {
        const c = contractRef.current;
        const p = paramsRef.current;
        const s = sideRef.current;
        const out: number[] = [];
        for (let i = 0; i < p.levels; i++) {
            const offset = p.startOff + i * p.step;
            const price = stepPrice(c, base, s === 'Buy' ? -offset : offset);
            if (price <= 0) break;
            if (c.limit_down > 0 && price < c.limit_down) break;
            if (c.limit_up > 0 && price > c.limit_up) break;
            out.push(price);
        }
        return out;
    };

    // batch: unit/quantity/side fixed at the start of a manual 鋪單 so a
    // mid-batch toggle can't change later orders after the risk check (#204)
    const placeAt = async (
        price: number,
        account: Account,
        batch: { qtyPer: number; odd: boolean; side: Action; contract: ContractInfo; beforeDispatch: () => void },
    ) => {
        batch.beforeDispatch();
        recentPlace.current.set(keyOf(price), Date.now());
        const c = batch.contract;
        const p = batch;
        const s = batch.side;
        const req = {
            action: s,
            price,
            quantity: p.qtyPer,
            order_type: 'ROD' as const,
            custom_field: GRID_TAG,
        };
        const trade = isFuturesContract(c)
            ? await placeFuturesOrder(c, {
                ...req,
                price_type: 'LMT',
                octype: 'Auto',
            }, account, { beforeDispatch: batch.beforeDispatch })
            : await placeStockOrder(c, {
                ...req,
                price_type: 'LMT',
                order_lot: p.odd ? 'IntradayOdd' : 'Common',
            }, account, { beforeDispatch: batch.beforeDispatch });
        const id = (trade as Trade | undefined)?.order?.id;
        if (id) recordGridOwner(account, id, instanceRef.current);
        return trade;
    };

    const layGrid = async () => {
        if (!armed || busy || last === null) return;
        const isContextCurrent = captureContext();
        const batch = { qtyPer, odd, side, contract, beforeDispatch: () => {
            if (!isContextCurrent()) throw Object.assign(new Error(ORDER_CONTEXT_CHANGED_MESSAGE), { tradingGateRejected: true });
        } };
        const blocked = checkOrderAllowed(batch.qtyPer * levels, batch.odd ? 'IntradayOdd' : undefined);
        if (blocked) {
            notify({ kind: 'err', title: '風控阻擋', body: blocked });
            return;
        }
        const prices = desiredPrices(last);
        // 鋪單帳戶在確認前固定（#139），確認後比對，變了就整批不送
        const gridAccount = captureSelectedAccount(
            isFuturesContract(contract) ? 'F' : 'S',
        );
        if (!gridAccount) {
            notify({ kind: 'err', title: '鋪單未送出', body: '缺少有效的下單帳戶' });
            return;
        }
        // 從確認到送完都鎖住單位切換
        setBusy(true);
        try {
            await sendBatch(prices, gridAccount, batch);
        } finally {
            setBusy(false);
        }
    };

    const sendBatch = async (
        prices: number[],
        gridAccount: Account,
        batch: { qtyPer: number; odd: boolean; side: Action; contract: ContractInfo; beforeDispatch: () => void },
    ) => {
        const { qtyPer, odd, side } = batch;
        // 手動鋪單整批確認一次（動態跟隨的補單不屬手動，不再問）
        if (getRiskSettings().confirmManualOrders && prices.length > 0) {
            const priceRange = `${fmtPrice(Math.min(...prices))} ～ ${fmtPrice(
                Math.max(...prices),
            )} 限價`;
            const approved = await requestOrderConfirm({
                code: contract.code,
                name: contract.name,
                action: side,
                price: null,
                priceLabel: priceRange,
                quantity: qtyPer * prices.length,
                unit,
                note: `網格鋪單 ${prices.length} 檔 × ${qtyPer}${odd ? ' 股・盤中零股限價 ROD' : ''}`,
                accountLabel: accountConfirmLabel(gridAccount),
            }).catch(() => false);
            if (!approved) return;
        }
        if (!isSelectedAccountUnchanged(gridAccount)) {
            notify({ kind: 'err', title: '鋪單未送出', body: ACCOUNT_CHANGED_MESSAGE });
            return;
        }
        let ok = 0;
        for (const price of prices) {
            try {
                if (!canTrade(gridAccount) || !usableCapturedAccount(gridAccount)) {
                    throw Object.assign(new Error(`${ACCOUNT_CHANGED_MESSAGE}；已停止後續鋪單`), { tradingGateRejected: true });
                }
                await placeAt(price, gridAccount, { ...batch, beforeDispatch: () => {
                    batch.beforeDispatch();
                    if (!canTrade(gridAccount) || !usableCapturedAccount(gridAccount) || !isSelectedAccountUnchanged(gridAccount)) {
                        throw Object.assign(new Error(ACCOUNT_CHANGED_MESSAGE), { tradingGateRejected: true });
                    }
                } });
                ok += 1;
            } catch (e) {
                notify({
                    kind: 'err',
                    title: `鋪單失敗 @${fmtPrice(price)}`,
                    body: e instanceof Error ? e.message : String(e),
                });
                if ((e as { tradingGateRejected?: boolean })?.tradingGateRejected) break;
            }
        }
        notify({
            kind: ok === prices.length ? 'ok' : 'info',
            title: '🧱 鋪單完成',
            body: `${contract.code} ${odd ? '零股' : ''}${side === 'Buy' ? '買' : '賣'}邊 ${ok}/${prices.length} 筆`,
        });
        onChangedRef.current?.();
    };

    // 全撤只撤「本面板擁有、目前單位、目前帳戶」的網格單（#204）。按鈕上的
    // 筆數只是提示；實際要撤的清單在按下時依當下帳戶重新計算
    const ownOrders = (account: Account | null | undefined) => {
        if (!account) return [];
        const store = readOwners();
        return gridOrders.filter(
            (t) =>
                ownerOf(t, store) === instanceId &&
                isOddLot(t.order.order_lot) === odd &&
                accountMatches(accountOf(t), account),
        );
    };
    // re-render on account changes so the count follows the current account
    useAccounts();
    const ownGrid = ownOrders(captureSelectedAccount(futures ? 'F' : 'S'));
    const otherGrid = gridOrders.length - ownGrid.length;
    const cancelGrid = async () => {
        const account = captureSelectedAccount(futures ? 'F' : 'S');
        if (!account) {
            notify({ kind: 'err', title: '鋪單全撤未執行', body: '沒有可用的下單帳戶，無法確認要撤哪個帳戶的鋪單' });
            return;
        }
        const targets = ownOrders(account);
        if (targets.length === 0) {
            notify({ kind: 'info', title: '鋪單全撤', body: '目前帳戶與單位沒有本面板送出的在途鋪單' });
            return;
        }
        setBusy(true);
        const results = await cancelOrders(targets.map((t) => t.order.id));
        const summary = cancellationSummary(results);
        notify({
            kind: summary.kind,
            title: '🧹 鋪單全撤',
            body: summary.body,
        });
        setBusy(false);
        setFollow(false);
        onChangedRef.current?.();
    };

    // 動態跟隨: periodically diff the working grid against the desired
    // ladder around the CURRENT price; cancel strays, place missing —
    // capped per cycle so a fast market can't burst orders
    useEffect(() => {
        if (!follow || !armed) return;
        // 跟隨啟動時固定商品、帳戶與交易單位；等待回應期間切換或清理
        // 會讓整個週期失效，每次 dispatch 也必須重新核對。
        let active = true;
        const isContextCurrent = captureContext();
        const followContract = contractRef.current;
        const followOdd = paramsRef.current.odd;
        const followAccount = captureSelectedAccount(
            isFuturesContract(contractRef.current) ? 'F' : 'S',
        );
        const stop = (body: string) => {
            if (!active) return;
            active = false;
            setFollow(false);
            notify({ kind: 'err', title: '鋪單跟隨已停止', body });
        };
        if (!followAccount) {
            stop('缺少有效的下單帳戶');
            return;
        }
        setFollowAccountShown(followAccount);
        const timer = setInterval(async () => {
            if (!active) return;
            if (cycleBusy.current) return;
            const base = lastRef.current;
            if (base === null) return;
            // 每個週期固定單位／數量／方向（#204）；進行中若使用者改了單位或
            // 方向，這個週期立刻停止，不以新單位送出任何一筆
            const cycle = { qtyPer: paramsRef.current.qtyPer, odd: paramsRef.current.odd, side: sideRef.current };
            if (cycle.odd !== followOdd) return;
            const changed = () => {
                if (!active) return true;
                if (!isContextCurrent() || paramsRef.current.odd !== cycle.odd || sideRef.current !== cycle.side) {
                    stop(ORDER_CONTEXT_CHANGED_MESSAGE);
                    return true;
                }
                if (!isSelectedAccountUnchanged(followAccount)) {
                    stop(ACCOUNT_CHANGED_MESSAGE);
                    return true;
                }
                return false;
            };
            const beforeDispatch = () => {
                if (changed()) throw Object.assign(new Error(ORDER_CONTEXT_CHANGED_MESSAGE), { tradingGateRejected: true, mutationNotStarted: true });
                if (!canTrade(followAccount) || !usableCapturedAccount(followAccount)) {
                    stop('跟隨啟動時的帳戶已不可用');
                    throw Object.assign(new Error(ACCOUNT_CHANGED_MESSAGE), { tradingGateRejected: true, mutationNotStarted: true });
                }
            };
            if (changed()) return;
            if (!usableCapturedAccount(followAccount)) {
                stop('跟隨啟動時的帳戶已不可用');
                return;
            }
            cycleBusy.current = true;
            try {
                const desired = new Set(desiredPrices(base).map(keyOf));
                const c = followContract;
                const owners = readOwners();
                const same = tradesRef.current.filter(
                    (t) =>
                        ACTIVE_ORDER_STATUSES.has(t.status.status) &&
                        t.order.custom_field === GRID_TAG &&
                        t.order.action === cycle.side &&
                        isOddLot(t.order.order_lot) === followOdd &&
                        accountMatches(accountOf(t), followAccount) &&
                        (t.contract.code === c.code ||
                            getAliasFor(t.contract.code) === c.code),
                );
                // 撤單／取代只動本面板擁有的單；沒有擁有者的網格單只用來避免
                // 重複補單，其他面板的單完全不看
                const mine = same.filter(t => ownerOf(t, owners) === instanceRef.current);
                const counted = same.filter(t => {
                    const owner = ownerOf(t, owners);
                    return owner === undefined || owner === instanceRef.current;
                });
                const have = new Set(
                    counted.map((t) =>
                        keyOf(t.status.modified_price || t.order.price),
                    ),
                );
                let ops = 0;
                for (const t of mine) {
                    if (ops >= MAX_OPS_PER_CYCLE || changed()) break;
                    if (!canTrade(followAccount) || !usableCapturedAccount(followAccount)) { stop('跟隨啟動時的帳戶已不可用'); return; }
                    const k = keyOf(t.status.modified_price || t.order.price);
                    if (!desired.has(k) && !unresolvedCancels.current.has(t.order.id)) {
                        ops += 1;
                        await cancelOrder(t.order.id, { beforeSend: beforeDispatch }).catch((error: unknown) => {
                            // A refusal before sending may be retried next
                            // cycle; anything else may have reached the broker.
                            if ((error as { mutationNotStarted?: unknown } | null)?.mutationNotStarted === true) return;
                            unresolvedCancels.current.add(t.order.id);
                            notify({
                                kind: 'err',
                                title: '鋪單跟隨：刪單未確認',
                                body: `${t.contract.code} @${fmtPrice(t.status.modified_price || t.order.price)}：${error instanceof Error ? error.message : String(error)}。此筆不再自動處理，請手動更新委託核對`,
                            });
                        });
                    }
                }
                const now = Date.now();
                for (const [k, ts] of recentPlace.current) {
                    if (now - ts > RECENT_MS) recentPlace.current.delete(k);
                }
                for (const k of desired) {
                    if (ops >= MAX_OPS_PER_CYCLE || changed()) break;
                    if (!canTrade(followAccount) || !usableCapturedAccount(followAccount)) { stop('跟隨啟動時的帳戶已不可用'); return; }
                    // skip levels visible in trades OR placed moments ago
                    // (the poll hasn't caught up — re-placing would double)
                    if (!have.has(k) && !recentPlace.current.has(k)) {
                        // 風控鎖／單筆上限／當日虧損上限同樣擋自動補單
                        const blocked = checkOrderAllowed(cycle.qtyPer, cycle.odd ? 'IntradayOdd' : undefined);
                        if (blocked) {
                            stop(blocked);
                            break;
                        }
                        ops += 1;
                        await placeAt(Number(k), followAccount, { ...cycle, contract: c, beforeDispatch }).catch(() => undefined);
                    }
                }
                if (ops > 0) onChangedRef.current?.();
            } finally {
                cycleBusy.current = false;
            }
        }, FOLLOW_INTERVAL_MS);
        return () => {
            active = false;
            clearInterval(timer);
            setFollowAccountShown(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [follow, armed, contract.code, futures, lot]);

    const preview = last !== null ? desiredPrices(last) : [];
    const numField = (
        label: string,
        value: number,
        set: (v: number) => void,
        min: number,
        max: number,
    ) => (
        <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>{label}</span>
            <button
                className={styles.stepBtn}
                onClick={() => set(Math.max(min, value - 1))}
            >
                −
            </button>
            <input
                className={styles.numInput}
                value={value}
                inputMode='numeric'
                onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isInteger(v) && v >= min && v <= max) set(v);
                }}
            />
            <button
                className={styles.stepBtn}
                onClick={() => set(Math.min(max, value + 1))}
            >
                ＋
            </button>
        </div>
    );

    return (
        <div className={styles.body}>
            <div className={styles.sideTabs}>
                <button
                    className={styles.buyTab[side === 'Buy' ? 'on' : 'off']}
                    onClick={() => {
                        setSide('Buy');
                        setFollow(false);
                    }}
                >
                    買進鋪單
                </button>
                <button
                    className={styles.sellTab[side === 'Sell' ? 'on' : 'off']}
                    onClick={() => {
                        setSide('Sell');
                        setFollow(false);
                    }}
                >
                    賣出鋪單
                </button>
            </div>

            {numField('起始檔距', startOff, setStartOff, 1, 50)}
            {numField('檔數', levels, setLevels, 1, MAX_LEVELS)}
            {numField('間隔(檔)', step, setStep, 1, 10)}
            {!futures && (
                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel} id={unitLabelId}>單位</span>
                    <div className={styles.segGroup} role="radiogroup" aria-labelledby={unitLabelId}>
                        {([
                            ['Common', '整股'],
                            ['IntradayOdd', '盤中零股'],
                        ] as const).map(([value, label]) => (
                            <button
                                key={value}
                                className={styles.seg[lot === value ? 'on' : 'off']}
                                role="radio"
                                aria-checked={lot === value}
                                disabled={busy}
                                title={value === 'IntradayOdd' ? '盤中零股：每檔以股計（1～999 股），限價 ROD、僅現股' : '整股以張計'}
                                onClick={() => {
                                    if (lot === value) return;
                                    lotPreferences.current.set(contract.code, value);
                                    saveOrderLotPreference('grid', contract, value);
                                    setLot(value);
                                    setQtyPer(1);
                                    setFollow(false);
                                }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {numField(`每檔量(${unit})`, qtyPer, setQtyPer, 1, odd ? ODD_LOT_MAX_SHARES : 99)}

            {preview.length > 0 && (
                <span className={styles.costRow}>
                    預覽：{fmtPrice(preview[0])} ~{' '}
                    {fmtPrice(preview[preview.length - 1])}（{preview.length}{' '}
                    檔 × {qtyPer} {unit}{odd ? '・盤中零股限價' : ''}）
                </span>
            )}

            <button
                className={flash.armBtn[armed ? 'on' : 'off']}
                onClick={() => {
                    setArmed((a) => !a);
                    if (armed) setFollow(false);
                }}
            >
                {armed ? (
                    <>
                        <Zap size={10} style={{ verticalAlign: '-1px' }} /> 已解鎖
                    </>
                ) : (
                    '解鎖鋪單'
                )}
            </button>

            <div className={styles.fieldRow}>
                <button
                    className={
                        styles.execBtn[side === 'Buy' ? 'buy' : 'sell']
                    }
                    style={{ flex: 1 }}
                    disabled={!armed || busy || last === null || !live}
                    onClick={() => void layGrid()}
                >
                    {!live
                        ? '⚠ 未連線'
                        : waitingOdd
                          ? '等待零股行情'
                          : busy
                          ? '處理中…'
                          : `鋪 ${preview.length} 檔`}
                </button>
                <button
                    className={flash.cancelAllBtn}
                    disabled={busy || ownGrid.length === 0}
                    title={otherGrid > 0 ? `只撤本面板目前單位與帳戶的鋪單；另有 ${otherGrid} 筆其他鋪單請在委託面板處理` : '撤掉本面板送出的鋪單'}
                    onClick={() => void cancelGrid()}
                >
                    全撤 {ownGrid.length > 0 ? ownGrid.length : ''}
                </button>
            </div>

            <button
                className={flash.followBtn[follow ? 'on' : 'off']}
                disabled={!armed}
                title='價格移動時自動撤舊補新，維持與現價的相對距離'
                onClick={() => setFollow((f) => !f)}
            >
                {follow ? (
                    <>
                        <RefreshCw size={10} style={{ verticalAlign: '-1px' }} />{' '}
                        動態跟隨中（每 2.5s 校正）
                    </>
                ) : (
                    '動態跟隨現價'
                )}
            </button>
            {follow && followAccountShown && (
                <span className={styles.costRow} title='動態跟隨啟動時固定的下單帳戶'>
                    跟隨帳戶 {followAccountShown.broker_id}-{maskAccountId(followAccountShown.account_id, priv)}
                </span>
            )}

            {gridOrders.length > 0 && (
                <span className={styles.costRow}>
                    在途鋪單：
                    {gridOrders
                        .map(
                            (t) =>
                                `${isOddLot(t.order.order_lot) ? '零' : ''}${t.order.action === 'Buy' ? '買' : '賣'}${fmtPrice(
                                    t.status.modified_price || t.order.price,
                                )}`,
                        )
                        .join(' · ')}
                </span>
            )}

            <span className={styles.costRow}>
                <span className={panel.dirText.up}>
                    ⚠ 鋪單會一次送出多筆委託；動態跟隨會自動撤補，請確認風控上限並自行承擔風險
                </span>
            </span>
        </div>
    );
}
