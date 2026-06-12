// src/components/grid-ticket.tsx — 鋪單 (order grid): lay N limit orders
// at stepped price levels in one click, cancel them in one click, and an
// optional 動態跟隨 mode that cancel/replaces the grid as the last price
// moves so the ladder keeps its distance. Grid orders are tagged with
// custom_field so only our own orders are touched.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { checkOrderAllowed } from '../lib/risk';
import {
    cancelOrder,
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
import { stepPrice } from '../lib/utils/ticksize';
import * as styles from './order-ticket.css';
import * as flash from './flash-order.css';
import * as panel from './panel.css';

const GRID_TAG = 'sjgrid';
const MAX_LEVELS = 15;
const FOLLOW_INTERVAL_MS = 2500;
const MAX_OPS_PER_CYCLE = 4;

const keyOf = (p: number) => p.toFixed(2);

export function GridTicket({
    contract,
    trades = [],
    onOrdersChanged,
}: {
    contract: ContractInfo;
    trades?: Trade[];
    onOrdersChanged?: () => void;
}) {
    const quote = useQuote(contract.code);
    const [side, setSide] = useState<Action>('Buy');
    const [startOff, setStartOff] = useState(1); // ticks from last
    const [levels, setLevels] = useState(5);
    const [step, setStep] = useState(1); // ticks between levels
    const [qtyPer, setQtyPer] = useState(1);
    const [armed, setArmed] = useState(false);
    const [follow, setFollow] = useState(false);
    const [busy, setBusy] = useState(false);

    const last = quote?.tick
        ? Number(quote.tick.close)
        : contract.reference || null;

    // refs for the follow loop
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const tradesRef = useRef(trades);
    tradesRef.current = trades;
    const lastRef = useRef(last);
    lastRef.current = last;
    const sideRef = useRef(side);
    sideRef.current = side;
    const paramsRef = useRef({ startOff, levels, step, qtyPer });
    paramsRef.current = { startOff, levels, step, qtyPer };
    const onChangedRef = useRef(onOrdersChanged);
    onChangedRef.current = onOrdersChanged;
    const cycleBusy = useRef(false);
    // prices we placed recently — the trades poll may not reflect them yet,
    // and re-placing a level that's merely in flight would double the order
    const recentPlace = useRef(new Map<string, number>());
    const RECENT_MS = 15000;

    // reset on symbol change
    useEffect(() => {
        setArmed(false);
        setFollow(false);
    }, [contract.code]);

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

    const placeAt = async (price: number) => {
        recentPlace.current.set(keyOf(price), Date.now());
        const c = contractRef.current;
        const p = paramsRef.current;
        const s = sideRef.current;
        const req = {
            action: s,
            price,
            quantity: p.qtyPer,
            order_type: 'ROD' as const,
            custom_field: GRID_TAG,
        };
        if (isFuturesContract(c)) {
            return placeFuturesOrder(c, {
                ...req,
                price_type: 'LMT',
                octype: 'Auto',
            });
        }
        return placeStockOrder(c, {
            ...req,
            price_type: 'LMT',
            order_lot: 'Common',
        });
    };

    const layGrid = async () => {
        if (!armed || busy || last === null) return;
        const blocked = checkOrderAllowed(qtyPer * levels);
        if (blocked) {
            notify({ kind: 'err', title: '風控阻擋', body: blocked });
            return;
        }
        setBusy(true);
        const prices = desiredPrices(last);
        let ok = 0;
        for (const price of prices) {
            try {
                await placeAt(price);
                ok += 1;
            } catch (e) {
                notify({
                    kind: 'err',
                    title: `鋪單失敗 @${fmtPrice(price)}`,
                    body: e instanceof Error ? e.message : String(e),
                });
            }
        }
        notify({
            kind: ok === prices.length ? 'ok' : 'info',
            title: '🧱 鋪單完成',
            body: `${contract.code} ${side === 'Buy' ? '買' : '賣'}邊 ${ok}/${prices.length} 筆`,
        });
        setBusy(false);
        onChangedRef.current?.();
    };

    const cancelGrid = async () => {
        if (gridOrders.length === 0) return;
        setBusy(true);
        const results = await Promise.allSettled(
            gridOrders.map((t) => cancelOrder(t.order.id)),
        );
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        notify({
            kind: 'ok',
            title: '🧹 鋪單全撤',
            body: `已送出 ${ok}/${gridOrders.length} 筆刪單`,
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
        const timer = setInterval(async () => {
            if (cycleBusy.current) return;
            const base = lastRef.current;
            if (base === null) return;
            cycleBusy.current = true;
            try {
                const desired = new Set(desiredPrices(base).map(keyOf));
                const c = contractRef.current;
                const mine = tradesRef.current.filter(
                    (t) =>
                        ACTIVE_ORDER_STATUSES.has(t.status.status) &&
                        t.order.custom_field === GRID_TAG &&
                        t.order.action === sideRef.current &&
                        (t.contract.code === c.code ||
                            getAliasFor(t.contract.code) === c.code),
                );
                const have = new Set(
                    mine.map((t) =>
                        keyOf(t.status.modified_price || t.order.price),
                    ),
                );
                let ops = 0;
                for (const t of mine) {
                    if (ops >= MAX_OPS_PER_CYCLE) break;
                    const k = keyOf(t.status.modified_price || t.order.price);
                    if (!desired.has(k)) {
                        ops += 1;
                        await cancelOrder(t.order.id).catch(() => undefined);
                    }
                }
                const now = Date.now();
                for (const [k, ts] of recentPlace.current) {
                    if (now - ts > RECENT_MS) recentPlace.current.delete(k);
                }
                for (const k of desired) {
                    if (ops >= MAX_OPS_PER_CYCLE) break;
                    // skip levels visible in trades OR placed moments ago
                    // (the poll hasn't caught up — re-placing would double)
                    if (!have.has(k) && !recentPlace.current.has(k)) {
                        ops += 1;
                        await placeAt(Number(k)).catch(() => undefined);
                    }
                }
                if (ops > 0) onChangedRef.current?.();
            } finally {
                cycleBusy.current = false;
            }
        }, FOLLOW_INTERVAL_MS);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [follow, armed]);

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
            {numField('每檔量', qtyPer, setQtyPer, 1, 99)}

            {preview.length > 0 && (
                <span className={styles.costRow}>
                    預覽：{fmtPrice(preview[0])} ~{' '}
                    {fmtPrice(preview[preview.length - 1])}（{preview.length}{' '}
                    檔 × {qtyPer}）
                </span>
            )}

            <button
                className={flash.armBtn[armed ? 'on' : 'off']}
                onClick={() => {
                    setArmed((a) => !a);
                    if (armed) setFollow(false);
                }}
            >
                {armed ? '⚡ 已解鎖' : '解鎖鋪單'}
            </button>

            <div className={styles.fieldRow}>
                <button
                    className={
                        styles.execBtn[side === 'Buy' ? 'buy' : 'sell']
                    }
                    style={{ flex: 1 }}
                    disabled={!armed || busy || last === null}
                    onClick={() => void layGrid()}
                >
                    {busy ? '處理中…' : `鋪 ${preview.length} 檔`}
                </button>
                <button
                    className={flash.cancelAllBtn}
                    disabled={busy || gridOrders.length === 0}
                    onClick={() => void cancelGrid()}
                >
                    全撤 {gridOrders.length > 0 ? gridOrders.length : ''}
                </button>
            </div>

            <button
                className={flash.followBtn[follow ? 'on' : 'off']}
                disabled={!armed}
                title='價格移動時自動撤舊補新，維持與現價的相對距離'
                onClick={() => setFollow((f) => !f)}
            >
                {follow ? '🔄 動態跟隨中（每 2.5s 校正）' : '動態跟隨現價'}
            </button>

            {gridOrders.length > 0 && (
                <span className={styles.costRow}>
                    在途鋪單：
                    {gridOrders
                        .map(
                            (t) =>
                                `${t.order.action === 'Buy' ? '買' : '賣'}${fmtPrice(
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
