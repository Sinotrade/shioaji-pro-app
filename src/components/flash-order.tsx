// src/components/flash-order.tsx — 閃電下單 price ladder (DOM trader).
// Fixed-window ladder anchored in tick space: the viewport always renders
// exactly the rows that fit, the wheel shifts the anchor by ticks, and
// auto-follow re-centers whenever the last price nears the window edge
// (paused while the pointer is inside, so clicks never land on a moving
// price). Click bid/ask columns to fire LMT orders, click your own order
// chips to cancel, market buy/sell + flatten + cancel-all in the action bar.

import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from 'react';
import { useQuote } from '../hooks/use-stream';
import { cancelOrder } from '../lib/shioaji';
import { getAliasFor, onOrderEvent } from '../lib/stream';
import { notify, placeQuickOrder } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import { ACTIVE_ORDER_STATUSES, type Action, type Trade } from '../lib/types/order';
import type { Position } from '../lib/types/portfolio';
import { fmtInt, fmtPrice, fmtSigned } from '../lib/utils/format';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import * as styles from './flash-order.css';

const ROW_H = 22; // must match row height in flash-order.css.ts
const EDGE = 2; // auto-recenter when last price gets this close to the edge

const keyOf = (p: number) => p.toFixed(2);

interface RowProps {
    price: number;
    text: string;
    isLast: boolean;
    lastVol: number;
    bid?: number;
    ask?: number;
    bidPct: number;
    askPct: number;
    myBuy: number;
    mySell: number;
    buyFill: number;
    sellFill: number;
    avgMark: boolean;
    band: 'up' | 'down' | null;
    armed: boolean;
    onCell: (action: Action, price: number) => void;
    onCancelAt: (action: Action, price: number) => void;
}

const FlashRow = memo(function FlashRow({
    price,
    text,
    isLast,
    lastVol,
    bid,
    ask,
    bidPct,
    askPct,
    myBuy,
    mySell,
    buyFill,
    sellFill,
    avgMark,
    band,
    armed,
    onCell,
    onCancelAt,
}: RowProps) {
    return (
        <div className={styles.row[isLast ? 'last' : 'normal']}>
            <div className={styles.chipCell}>
                {buyFill > 0 && (
                    <span
                        className={styles.fillBadge.buy}
                        title={`今日買進成交 ${buyFill} @ ${text}`}
                    >
                        {buyFill}
                    </span>
                )}
                {myBuy > 0 && (
                    <button
                        className={styles.orderChip.buy}
                        title={`刪除 ${text} 買單 ${myBuy}`}
                        onClick={() => onCancelAt('Buy', price)}
                    >
                        {myBuy}
                    </button>
                )}
            </div>
            <div
                className={`${styles.buyCell} ${armed ? '' : styles.disabledCell}`}
                title={armed ? `限價買 ${text}` : '先啟用閃電下單'}
                onClick={() => onCell('Buy', price)}
            >
                {bid !== undefined && (
                    <div
                        className={styles.volBarBid}
                        style={{ width: `${bidPct}%` }}
                    />
                )}
                <span className={styles.cellText}>
                    {bid !== undefined ? fmtInt(bid) : ''}
                </span>
            </div>
            <div
                className={`${styles.priceCell} ${
                    band === 'up'
                        ? styles.bandUp
                        : band === 'down'
                          ? styles.bandDown
                          : ''
                } ${avgMark ? styles.avgMark : ''}`}
                title={
                    band === 'up'
                        ? '漲停'
                        : band === 'down'
                          ? '跌停'
                          : undefined
                }
            >
                {text}
                {isLast && lastVol > 0 && (
                    <span className={styles.lastVol}>×{fmtInt(lastVol)}</span>
                )}
            </div>
            <div
                className={`${styles.sellCell} ${armed ? '' : styles.disabledCell}`}
                title={armed ? `限價賣 ${text}` : '先啟用閃電下單'}
                onClick={() => onCell('Sell', price)}
            >
                {ask !== undefined && (
                    <div
                        className={styles.volBarAsk}
                        style={{ width: `${askPct}%` }}
                    />
                )}
                <span className={styles.cellText}>
                    {ask !== undefined ? fmtInt(ask) : ''}
                </span>
            </div>
            <div className={styles.chipCell}>
                {mySell > 0 && (
                    <button
                        className={styles.orderChip.sell}
                        title={`刪除 ${text} 賣單 ${mySell}`}
                        onClick={() => onCancelAt('Sell', price)}
                    >
                        {mySell}
                    </button>
                )}
                {sellFill > 0 && (
                    <span
                        className={styles.fillBadge.sell}
                        title={`今日賣出成交 ${sellFill} @ ${text}`}
                    >
                        {sellFill}
                    </span>
                )}
            </div>
        </div>
    );
});

export function FlashOrder({
    contract,
    trades = [],
    positions = [],
    onOrdersChanged,
}: {
    contract: ContractInfo;
    trades?: Trade[];
    positions?: Position[];
    onOrdersChanged?: () => void;
}) {
    const quote = useQuote(contract.code);
    const [qty, setQty] = useState(1);
    const [armed, setArmed] = useState(false);
    const [anchor, setAnchor] = useState<number | null>(null);
    const [follow, setFollow] = useState(true);
    const [rowCount, setRowCount] = useState(21);
    const [, force] = useReducer((c: number) => c + 1, 0);

    const last = quote?.tick
        ? Number(quote.tick.close)
        : contract.reference || null;
    const lastVol = quote?.tick ? quote.tick.volume : 0;
    const limitUp = contract.limit_up || 0;
    const limitDown = contract.limit_down || 0;

    // refs so hot-path callbacks stay referentially stable (rows are memo'd)
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const armedRef = useRef(armed);
    armedRef.current = armed;
    const qtyRef = useRef(qty);
    qtyRef.current = qty;
    const lastRef = useRef(last);
    lastRef.current = last;
    const tradesRef = useRef(trades);
    tradesRef.current = trades;
    const followRef = useRef(follow);
    followRef.current = follow;
    const hoverRef = useRef(false);
    const inflightRef = useRef(new Set<string>());
    const onOrdersChangedRef = useRef(onOrdersChanged);
    onOrdersChangedRef.current = onOrdersChanged;

    // reset on symbol change
    useEffect(() => {
        setAnchor(null);
        setFollow(true);
        setArmed(false);
    }, [contract.code]);

    // Esc disarms anywhere
    useEffect(() => {
        if (!armed) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setArmed(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [armed]);

    // viewport rows = whatever fits the panel height
    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            setRowCount(Math.max(7, Math.floor(el.clientHeight / ROW_H)));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // ladder window generated in tick space around the anchor, clamped to
    // limit-up/down. When one side is cut short by a limit, the other side
    // borrows the leftover rows so the window always stays full — the limit
    // price sticks to the top/bottom edge instead of leaving blank space.
    const rows = useMemo(() => {
        if (anchor === null) return [] as number[];
        // the anchor itself must stay inside the price limits
        let center = anchor;
        if (limitUp > 0 && center > limitUp) center = limitUp;
        if (limitDown > 0 && center < limitDown) center = limitDown;
        const half = Math.floor(rowCount / 2);
        const ups: number[] = [];
        let p = center;
        for (let i = 0; i < rowCount - 1; i++) {
            const n = stepPrice(contract, p, 1);
            if (limitUp > 0 && n > limitUp + 1e-9) break;
            ups.push(n);
            p = n;
        }
        const downs: number[] = [];
        p = center;
        for (let i = 0; i < rowCount - 1; i++) {
            const n = stepPrice(contract, p, -1);
            if (n <= 0) break;
            if (limitDown > 0 && n < limitDown - 1e-9) break;
            downs.push(n);
            p = n;
        }
        let nUp = Math.min(half, ups.length);
        const nDown = Math.min(rowCount - 1 - nUp, downs.length);
        nUp = Math.min(rowCount - 1 - nDown, ups.length);
        return [
            ...ups.slice(0, nUp).reverse(),
            center,
            ...downs.slice(0, nDown),
        ];
    }, [anchor, rowCount, contract, limitUp, limitDown]);

    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    // auto-follow: recenter when last price nears/leaves the window —
    // but never while the pointer is inside (prices must not move under
    // a click)
    const maybeRecenter = useCallback(() => {
        const lp = lastRef.current;
        if (!followRef.current || lp === null || hoverRef.current) return;
        setAnchor((prev) => {
            const centered = roundToTick(contractRef.current, lp);
            if (prev === null) return centered;
            const rws = rowsRef.current;
            const idx = rws.findIndex((r) => keyOf(r) === keyOf(lp));
            if (idx === -1 || idx < EDGE || idx > rws.length - 1 - EDGE) {
                return centered;
            }
            return prev;
        });
    }, []);
    // initial anchor + per-tick edge check
    useEffect(() => {
        maybeRecenter();
    }, [last, rows, maybeRecenter]);

    const recenter = useCallback(() => {
        const lp = lastRef.current;
        if (lp === null) return;
        setFollow(true);
        setAnchor(roundToTick(contractRef.current, lp));
    }, []);

    // wheel scrolls the ladder in tick space (needs non-passive listener).
    // Trackpads fire dozens of small-delta events per swipe, so accumulate
    // pixels and move one tick per row height — the ladder tracks the
    // gesture 1:1 instead of jumping a fixed amount per event.
    const wheelAccum = useRef(0);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const px = e.deltaMode === 1 ? e.deltaY * ROW_H : e.deltaY;
            wheelAccum.current += px;
            const ticks = Math.trunc(wheelAccum.current / ROW_H);
            if (ticks === 0) return;
            wheelAccum.current -= ticks * ROW_H;
            setFollow(false);
            setAnchor((a) => {
                if (a === null) return a;
                const c = contractRef.current;
                let n = stepPrice(c, a, -ticks);
                // scrolling stops at the price limits
                if (c.limit_up > 0 && n > c.limit_up) n = c.limit_up;
                if (c.limit_down > 0 && n < c.limit_down) n = c.limit_down;
                return n;
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // 5-level book lookup + totals
    const book = useMemo(() => {
        const map = new Map<string, { bid?: number; ask?: number }>();
        const ba = quote?.bidask;
        if (ba) {
            ba.bid_price.forEach((p, i) => {
                const key = keyOf(Number(p));
                map.set(key, { ...map.get(key), bid: ba.bid_volume[i] });
            });
            ba.ask_price.forEach((p, i) => {
                const key = keyOf(Number(p));
                map.set(key, { ...map.get(key), ask: ba.ask_volume[i] });
            });
        }
        return map;
    }, [quote?.bidask]);

    const { maxVol, sumBid, sumAsk } = useMemo(() => {
        let m = 1;
        let sb = 0;
        let sa = 0;
        for (const v of book.values()) {
            m = Math.max(m, v.bid ?? 0, v.ask ?? 0);
            sb += v.bid ?? 0;
            sa += v.ask ?? 0;
        }
        return { maxVol: m, sumBid: sb, sumAsk: sa };
    }, [book]);

    // my working orders at each price level
    const myOrders = useMemo(() => {
        const m = new Map<string, { buy: number; sell: number }>();
        for (const t of trades) {
            if (!ACTIVE_ORDER_STATUSES.has(t.status.status)) continue;
            const tc = t.contract.code;
            if (tc !== contract.code && getAliasFor(tc) !== contract.code) {
                continue;
            }
            const remaining =
                (t.status.order_quantity || t.order.quantity) -
                t.status.deal_quantity -
                t.status.cancel_quantity;
            if (remaining <= 0) continue;
            const price = t.status.modified_price || t.order.price;
            const key = keyOf(price);
            const cur = m.get(key) ?? { buy: 0, sell: 0 };
            if (t.order.action === 'Buy') cur.buy += remaining;
            else cur.sell += remaining;
            m.set(key, cur);
        }
        return m;
    }, [trades, contract.code]);

    // today's fills aggregated per price level (from each trade's deals)
    const myFills = useMemo(() => {
        const m = new Map<string, { buy: number; sell: number }>();
        for (const t of trades) {
            const tc = t.contract.code;
            if (tc !== contract.code && getAliasFor(tc) !== contract.code) {
                continue;
            }
            for (const d of t.status.deals ?? []) {
                if (!d.quantity) continue;
                const key = keyOf(Number(d.price));
                const cur = m.get(key) ?? { buy: 0, sell: 0 };
                if (t.order.action === 'Buy') cur.buy += d.quantity;
                else cur.sell += d.quantity;
                m.set(key, cur);
            }
        }
        return m;
    }, [trades, contract.code]);

    // net position for this symbol (alias-aware for continuous contracts)
    const pos = useMemo(() => {
        const matches = positions.filter(
            (p) =>
                p.code === contract.code ||
                getAliasFor(p.code) === contract.code,
        );
        if (matches.length === 0) return null;
        let net = 0;
        let cost = 0;
        let qtySum = 0;
        let pnl = 0;
        for (const p of matches) {
            net += p.direction === 'Sell' ? -p.quantity : p.quantity;
            cost += p.price * p.quantity;
            qtySum += p.quantity;
            pnl += p.pnl || 0;
        }
        if (net === 0) return null;
        const avg = qtySum > 0 ? cost / qtySum : 0;
        return { net, avg, avgKey: keyOf(roundToTick(contract, avg)), pnl };
    }, [positions, contract]);

    // refresh working orders promptly after any order event (debounced —
    // a burst of events triggers one refresh). The delay is jittered per
    // instance so eight 閃電全開 windows don't all refetch in the same
    // instant when a fill lands.
    useEffect(() => {
        const delay = 400 + Math.floor(Math.random() * 900);
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = onOrderEvent(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => onOrdersChangedRef.current?.(), delay);
        });
        return () => {
            off();
            if (timer) clearTimeout(timer);
        };
    }, []);

    // ---- order actions (all gated by the arm toggle) ----

    const send = useCallback(async (action: Action, price: number | null) => {
        if (!armedRef.current) return;
        const q = Math.max(1, qtyRef.current);
        const key = `${action}:${price === null ? 'MKT' : keyOf(price)}`;
        if (inflightRef.current.has(key)) return; // double-click guard
        inflightRef.current.add(key);
        force();
        try {
            const trade = await placeQuickOrder(
                contractRef.current,
                action,
                price,
                q,
            );
            notify({
                kind: 'ok',
                title: `⚡ ${action === 'Buy' ? '買進' : '賣出'}已送出`,
                body: `${contractRef.current.code} ${q} @ ${
                    price === null ? '市價' : fmtPrice(price)
                } (${trade.status.status})`,
            });
            onOrdersChangedRef.current?.();
        } catch (e) {
            notify({
                kind: 'err',
                title: '⚡ 閃電下單失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        } finally {
            inflightRef.current.delete(key);
            force();
        }
    }, []);

    const onCell = useCallback(
        (action: Action, price: number) => void send(action, price),
        [send],
    );

    const cancelAt = useCallback(async (action: Action, price: number) => {
        const code = contractRef.current.code;
        const targets = tradesRef.current.filter(
            (t) =>
                ACTIVE_ORDER_STATUSES.has(t.status.status) &&
                (t.contract.code === code ||
                    getAliasFor(t.contract.code) === code) &&
                t.order.action === action &&
                keyOf(t.status.modified_price || t.order.price) ===
                    keyOf(price),
        );
        if (targets.length === 0) return;
        const results = await Promise.allSettled(
            targets.map((t) => cancelOrder(t.order.id)),
        );
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        notify({
            kind: ok === targets.length ? 'ok' : 'err',
            title: '⚡ 刪單',
            body: `${code} @ ${fmtPrice(price)} 已送出 ${ok}/${targets.length} 筆刪單`,
        });
        onOrdersChangedRef.current?.();
    }, []);

    const onCancelAt = useCallback(
        (action: Action, price: number) => void cancelAt(action, price),
        [cancelAt],
    );

    const cancelSymbol = useCallback(async () => {
        const code = contractRef.current.code;
        const targets = tradesRef.current.filter(
            (t) =>
                ACTIVE_ORDER_STATUSES.has(t.status.status) &&
                (t.contract.code === code ||
                    getAliasFor(t.contract.code) === code),
        );
        if (targets.length === 0) {
            notify({ kind: 'info', title: '⚡ 全刪', body: '沒有可刪的委託' });
            return;
        }
        const results = await Promise.allSettled(
            targets.map((t) => cancelOrder(t.order.id)),
        );
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        notify({
            kind: ok === targets.length ? 'ok' : 'err',
            title: '⚡ 全刪',
            body: `${code} 已送出 ${ok}/${targets.length} 筆刪單`,
        });
        onOrdersChangedRef.current?.();
    }, []);

    const flatten = useCallback(() => {
        if (!pos || !armedRef.current) return;
        void send(pos.net > 0 ? 'Sell' : 'Buy', null);
    }, [pos, send]);

    // ---- render ----

    const lastKey = last !== null ? keyOf(roundToTick(contract, last)) : '';
    const lastIdx =
        lastKey === '' ? -1 : rows.findIndex((r) => keyOf(r) === lastKey);
    const topRow = rows[0];
    const lastAbove =
        lastIdx === -1 && last !== null && topRow !== undefined
            ? last > topRow
            : false;

    const workingCount = useMemo(() => {
        let n = 0;
        for (const v of myOrders.values()) n += v.buy + v.sell;
        return n;
    }, [myOrders]);

    return (
        <div className={styles.wrap}>
            <div className={styles.controls}>
                <span className={styles.qtyLabel}>量</span>
                <button
                    className={styles.stepBtn}
                    onClick={() => setQty((v) => Math.max(1, v - 1))}
                >
                    −
                </button>
                <input
                    className={styles.qtyInput}
                    value={qty}
                    inputMode='numeric'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0) setQty(v);
                    }}
                />
                <button
                    className={styles.stepBtn}
                    onClick={() => setQty((v) => v + 1)}
                >
                    ＋
                </button>
                <button
                    className={styles.armBtn[armed ? 'on' : 'off']}
                    onClick={() => setArmed((a) => !a)}
                >
                    {armed ? '⚡ 點價即下單' : '啟用閃電下單'}
                </button>
                <button
                    className={styles.followBtn[follow ? 'on' : 'off']}
                    title={follow ? '自動跟隨現價中 — 點擊固定' : '已固定 — 點擊恢復跟隨'}
                    onClick={() => {
                        if (follow) setFollow(false);
                        else recenter();
                    }}
                >
                    {follow ? '跟隨' : '固定'}
                </button>
                <button
                    className={styles.recenterBtn}
                    title='現價置中並恢復跟隨'
                    onClick={recenter}
                >
                    置中
                </button>
            </div>
            <div className={styles.actionBar}>
                <button
                    className={`${styles.mktBtn.buy} ${armed ? '' : styles.disabledCell}`}
                    onClick={() => void send('Buy', null)}
                >
                    市價買
                </button>
                <button
                    className={`${styles.mktBtn.sell} ${armed ? '' : styles.disabledCell}`}
                    onClick={() => void send('Sell', null)}
                >
                    市價賣
                </button>
                {pos && (
                    <button
                        className={`${styles.flatBtn} ${armed ? '' : styles.disabledCell}`}
                        title={`市價平倉 ${Math.abs(pos.net)}`}
                        onClick={flatten}
                    >
                        平倉
                    </button>
                )}
                <button
                    className={styles.cancelAllBtn}
                    disabled={workingCount === 0}
                    onClick={() => void cancelSymbol()}
                >
                    全刪{workingCount > 0 ? ` ${workingCount}` : ''}
                </button>
            </div>
            {pos && (
                <div className={styles.posBar}>
                    <span className={pos.net > 0 ? styles.posLong : styles.posShort}>
                        {pos.net > 0 ? '多' : '空'} {Math.abs(pos.net)}
                    </span>
                    <span>@ {fmtPrice(pos.avg)}</span>
                    <span
                        className={
                            pos.pnl >= 0 ? styles.posLong : styles.posShort
                        }
                    >
                        {fmtSigned(pos.pnl)}
                    </span>
                </div>
            )}
            <div className={styles.headRow}>
                <span>買單</span>
                <span>買量</span>
                <span>價格</span>
                <span>賣量</span>
                <span>賣單</span>
            </div>
            <div
                ref={bodyRef}
                className={styles.ladderBody}
                onMouseEnter={() => {
                    hoverRef.current = true;
                }}
                onMouseLeave={() => {
                    hoverRef.current = false;
                    maybeRecenter();
                }}
                onDoubleClick={recenter}
            >
                {rows.length === 0 && (
                    <div className={styles.waiting}>等待報價…</div>
                )}
                {rows.map((price) => {
                    const key = keyOf(price);
                    const lv = book.get(key);
                    const mine = myOrders.get(key);
                    const fills = myFills.get(key);
                    return (
                        <FlashRow
                            key={key}
                            price={price}
                            text={fmtPrice(price)}
                            isLast={key === lastKey}
                            lastVol={key === lastKey ? lastVol : 0}
                            bid={lv?.bid}
                            ask={lv?.ask}
                            bidPct={lv?.bid ? (lv.bid / maxVol) * 90 : 0}
                            askPct={lv?.ask ? (lv.ask / maxVol) * 90 : 0}
                            myBuy={mine?.buy ?? 0}
                            mySell={mine?.sell ?? 0}
                            buyFill={fills?.buy ?? 0}
                            sellFill={fills?.sell ?? 0}
                            avgMark={pos !== null && key === pos.avgKey}
                            band={
                                limitUp > 0 && key === keyOf(limitUp)
                                    ? 'up'
                                    : limitDown > 0 && key === keyOf(limitDown)
                                      ? 'down'
                                      : null
                            }
                            armed={armed}
                            onCell={onCell}
                            onCancelAt={onCancelAt}
                        />
                    );
                })}
                {lastIdx === -1 && last !== null && rows.length > 0 && (
                    <button
                        className={
                            styles.jumpBtn[lastAbove ? 'top' : 'bottom']
                        }
                        onClick={recenter}
                    >
                        {lastAbove ? '▲' : '▼'} 現價 {fmtPrice(last)}
                    </button>
                )}
            </div>
            <div className={styles.totalsRow}>
                <span className={styles.totalBid}>Σ買 {fmtInt(sumBid)}</span>
                <span className={styles.totalAsk}>Σ賣 {fmtInt(sumAsk)}</span>
            </div>
            <div className={styles.hint}>
                {armed
                    ? '點買量=限價買 · 點賣量=限價賣 · 點單量=刪單 · Esc 鎖定'
                    : '安全鎖定中 — 點「啟用閃電下單」解鎖 · 滾輪捲動 · 雙擊置中'}
            </div>
        </div>
    );
}
