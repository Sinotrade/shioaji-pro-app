import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
// src/components/flash-order.tsx — 閃電下單 price ladder (DOM trader).
// Fixed-window ladder anchored in tick space: the viewport always renders
// exactly the rows that fit, the wheel shifts the anchor by ticks, and
// auto-follow re-centers whenever the last price nears the window edge
// (paused while the pointer is inside, so clicks never land on a moving
// price). Click bid/ask columns to fire LMT orders, click your own order
// chips to cancel, market buy/sell + flatten + cancel-all in the action bar.

import { ensureAccounts, useAccounts } from '../lib/account-store';
import { usePrivacyMode } from '../lib/privacy';
import { accountMatches, flashAccountKey, resolveFlashAccount, scopedFlashRows, type FlashAccountKeys, type FlashMarket } from '../lib/flash-account';
import { collectFills, fifoPosition, hasTwoWayFills, tradingDayStart } from '../lib/futures-fifo';
import { ChevronDown, Zap } from 'lucide-react';
import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from 'react';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import { displayBook } from '../lib/display-book';
import { flashOrderSummary, loadFlashOrderDefault, normalizeChartOrder, saveFlashOrderDefault } from '../lib/chart-order-settings';
import { OrderSettingsButton } from './chart-order-popover';
import { useDisplayBook } from '../hooks/use-display-book';
import type { Snapshot } from '../lib/types/market';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import { cancellationSummary } from '../lib/trade-mutations';
import { cancelOrders } from '../lib/shioaji';
import { getAliasFor } from '../lib/stream';
import { useTickBandsVersion } from '../lib/tick-bands';
import { notify, placeQuickOrder, placeStockExitByShares } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import { ACTIVE_ORDER_STATUSES, type Action, type Trade } from '../lib/types/order';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import { fmtClock, fmtCompactInt, fmtInt, fmtPrice, fmtSigned, fmtStockLots } from '../lib/utils/format';
import { clampLotQuantity, isOddLot, ODD_LOT_MAX_SHARES, ODD_LOT_TEXT } from '../lib/odd-lot';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import { flashAccountLabels, flashSymbolLabel } from '../lib/flash-display';
import * as styles from './flash-order.css';

const ROW_H = 22; // must match row height in flash-order.css.ts
const EDGE = 2; // auto-recenter when last price gets this close to the edge

const keyOf = (p: number) => p.toFixed(2);
const FOLLOW_GLOBAL = '__follow__';
const ACCOUNT_CHANGED_DURING_CONFIRMATION = '確認期間帳戶已變更，請重新確認';

function accountChangedBeforeSend(error: unknown): boolean {
    return error instanceof Error && error.message === ACCOUNT_CHANGED_DURING_CONFIRMATION;
}

function notifyAccountChangedBeforeSend(): void {
    notify({
        kind: 'err',
        title: '閃電下單未送出',
        body: '確認期間帳戶已變更，這筆沒有送出，請重新確認',
    });
}

type PosMarks = { mixed: boolean; twoWay: boolean; stale: boolean; fifo: boolean };

// 閃電持倉列的成本來源標記（僅期貨）
function posLabel(p: PosMarks): string {
    const state = p.stale ? '待更新' : p.fifo ? '' : '估算';
    if (p.mixed) return state ? `多空並存 ${state}` : '多空並存';
    return state || 'FIFO';
}

function posNote(p: PosMarks): string {
    const rows = p.mixed ? '持倉同時有買、賣兩列（券商或即時估算尚未沖銷）；' : '今日有買賣沖銷；';
    if (p.stale) return `${rows}有成交回報尚未套用或委託／持倉待對帳，數字可能過時，請更新持倉確認`;
    if (p.fifo) return `${rows}成本與損益依本交易日成交逐筆先進先出（FIFO）沖銷計算`;
    return `${rows}本交易日成交無法完整對上持倉（可能含前期留倉或成交未載入），顯示持倉列加權平均，可能與先進先出（FIFO）結果不同，請以持倉面板確認`;
}

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
    /** odd-lot book: volumes in shares, shown compactly (exact in tooltip) */
    compact: boolean;
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
    compact,
    onCell,
    onCancelAt,
}: RowProps) {
    const vol = compact ? fmtCompactInt : fmtInt;
    const exact = (v: number | undefined) => (compact && v !== undefined && v >= 10_000 ? `${fmtInt(v)} 股` : undefined);
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
                <span className={styles.cellText} title={exact(bid)}>
                    {bid !== undefined ? vol(bid) : ''}
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
                    <span className={styles.lastVol} title={exact(lastVol)}>×{vol(lastVol)}</span>
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
                <span className={styles.cellText} title={exact(ask)}>
                    {ask !== undefined ? vol(ask) : ''}
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
    snapshot,
    trades: allTrades = [],
    positions: allPositions = [],
    onOrdersChanged,
    accountKeys,
    onAccountKeysChange,
    followMain = true,
    reconcilePending = false,
}: {
    contract: ContractInfo;
    snapshot?: Snapshot;
    trades?: Trade[];
    positions?: AccountedPosition[];
    onOrdersChanged?: () => void;
    // this panel's own account per market (issue #139); a market without a
    // key follows the app-wide selection. With onAccountKeysChange the
    // owner (workspace block / popout window) persists it; otherwise the
    // choice lives only in this component.
    accountKeys?: FlashAccountKeys;
    onAccountKeysChange?: (keys: FlashAccountKeys) => void;
    // false in popout windows: they cannot see the main window's live
    // selection, so they only ever use their pinned/chosen account
    followMain?: boolean;
    /** Orders or positions await reconciliation (missed or unapplied
     * reports): today's fills may be incomplete, so no FIFO cost. */
    reconcilePending?: boolean;
}) {
    const { quote, snapshot: initialSnapshot, book: lotDisplay } = useDisplayBook(contract.code, snapshot, contract);
    const live = useTradingLive();
    const accountState = useAccounts();
    const privacy = usePrivacyMode();
    const market: FlashMarket = contract.security_type === 'STK' ? 'S' : 'F';
    const [localKeys, setLocalKeys] = useState<FlashAccountKeys>(accountKeys ?? {});
    const panelKeys = onAccountKeysChange ? (accountKeys ?? {}) : localKeys;
    const globalAccount = market === 'S' ? accountState.selectedStock : accountState.selectedFutures;
    const eligible = accountState.accounts.filter(a => a.signed && a.account_type === market);
    const resolved = resolveFlashAccount(accountState.accounts, market, panelKeys[market], globalAccount, followMain);
    const activeAccount = resolved.account;
    // account list not fetched yet (startup / a fresh popout): a saved key
    // is not "unavailable" yet — say so, ordering stays disabled meanwhile
    const accountsLoading = !accountState.loaded;
    // idempotent — a popout / 閃電全開 tile has no dock or settings dialog
    // that would otherwise fetch the account list (#139)
    useEffect(ensureAccounts, []);
    const accountKey = activeAccount ? flashAccountKey(activeAccount) : '';
    const trades = scopedFlashRows(allTrades, activeAccount);
    const positions = scopedFlashRows(allPositions, activeAccount);
    const accountRef = useRef(activeAccount);
    accountRef.current = activeAccount;
    const privMoney = usePrivacyMoney();
    // 單位與數量的起始值來自「設為預設」（依股票／期貨）
    const [qty, setQty] = useState(() => loadFlashOrderDefault(market).qty);
    // 股票：整股（張）或盤中零股（股）（#204）— 每個面板自己的 state
    const [lot, setLot] = useState<'Common' | 'IntradayOdd'>(() => loadFlashOrderDefault(market).lot);
    const odd = market === 'S' && lot === 'IntradayOdd';
    // 盤中零股是另一個撮合市場：零股模式的五檔、成交價與單量一律取零股
    // 行情（intraday_odd，量以股計），只在這個面板處於零股時才訂閱；
    // 單位是面板自己的 state，同一檔的整股面板不受影響（#204）
    const oddQuote = useQuote(odd ? contract.code : null, { oddLot: true });
    const oddDisplay = useMemo(
        () => (odd ? displayBook(contract.code, undefined, oddQuote?.bidask, contract.target_code) : undefined),
        [odd, contract.code, contract.target_code, oddQuote?.bidask],
    );
    const display = odd ? oddDisplay : lotDisplay;
    // 零股約每 5 秒撮合一次 — 顯示最近一次撮合（零股成交）時間
    const oddMatchTime = odd ? fmtClock(oddQuote?.tick?.time) : '';
    const [armed, setArmed] = useState(false);
    const [anchor, setAnchor] = useState<number | null>(null);
    const [follow, setFollow] = useState(true);
    const [rowCount, setRowCount] = useState(21);
    const [, force] = useReducer((c: number) => c + 1, 0);

    // 整股成交價：持倉損益估值與零股尚無成交前的梯形置中都用它
    const lotLast = quote?.tick
        ? Number(quote.tick.close)
        : initialSnapshot?.close || contract.reference || null;
    const last = odd
        ? (oddQuote?.tick ? Number(oddQuote.tick.close) : null)
        : lotLast;
    const lastVol = odd
        ? (oddQuote?.tick?.volume ?? 0)
        : quote?.tick ? quote.tick.volume : 0;
    // ladder centre: the shown unit's last trade, else the regular-lot price
    const centerPrice = last ?? lotLast;
    const limitUp = contract.limit_up || 0;
    const limitDown = contract.limit_down || 0;

    // refs so hot-path callbacks stay referentially stable (rows are memo'd)
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const armedRef = useRef(armed);
    const armedAccountKey = useRef(accountKey);
    armedRef.current = armed && armedAccountKey.current === accountKey;
    const qtyRef = useRef(qty);
    qtyRef.current = qty;
    const oddRef = useRef(odd);
    oddRef.current = odd;
    const lastRef = useRef(centerPrice);
    lastRef.current = centerPrice;
    const tradesRef = useRef(trades);
    tradesRef.current = trades;
    const followRef = useRef(follow);
    followRef.current = follow;
    const hoverRef = useRef(false);
    const inflightRef = useRef(new Set<string>());
    const onOrdersChangedRef = useRef(onOrdersChanged);
    onOrdersChangedRef.current = onOrdersChanged;

    // Price navigation belongs to the symbol, not the trading account.
    useEffect(() => {
        setAnchor(null);
        setFollow(true);
    }, [contract.code]);

    // Account changes still disarm an active ladder.
    useEffect(() => {
        setArmed(false);
    }, [contract.code, accountKey]);

    // 換商品回預設單位；單位變了（或原本是零股）數量也回預設 —
    // 零股的股數不能沿用成張數
    const lotRef = useRef(lot);
    lotRef.current = lot;
    const firstCode = useRef(true);
    useEffect(() => {
        if (firstCode.current) { firstCode.current = false; return; }
        const d = loadFlashOrderDefault(contract.security_type === 'STK' ? 'S' : 'F');
        if (oddRef.current || d.lot !== lotRef.current) setQty(d.qty);
        setLot(d.lot);
    }, [contract.code]);

    // safety: drop out of armed mode the moment the feed isn't LIVE so a
    // click can't fire into a dead connection (issue #2)
    useEffect(() => {
        if (!live) setArmed(false);
    }, [live]);

    // Esc disarms anywhere — except while the settings popover is open:
    // there Esc only closes the popover
    const settingsOpenRef = useRef(false);
    useEffect(() => {
        if (!armed) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !settingsOpenRef.current && !e.defaultPrevented) setArmed(false);
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
    // bandsVer：tick-bands 到貨時重算 — 盤後沒有行情跳動觸發時，
    // 載入前用 fallback 格算出的 rows 才會被換成正確級距
    const bandsVer = useTickBandsVersion();
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
    }, [anchor, rowCount, contract, limitUp, limitDown, bandsVer]);

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
    }, [centerPrice, rows, maybeRecenter]);

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
        for (const { price, vol } of display?.bids ?? []) {
            const key = keyOf(price);
            map.set(key, { ...map.get(key), bid: vol });
        }
        for (const { price, vol } of display?.asks ?? []) {
            const key = keyOf(price);
            map.set(key, { ...map.get(key), ask: vol });
        }
        return map;
    }, [display]);

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

    // Stock chips / fills show only the current unit's orders (整股 in 張,
    // 零股 in 股) so a price level never adds lots and shares together.
    const lotShown = useCallback((t: Trade) => market !== 'S' || isOddLot(t.order.order_lot) === odd, [market, odd]);

    // my working orders at each price level
    const myOrders = useMemo(() => {
        const m = new Map<string, { buy: number; sell: number }>();
        for (const t of trades) {
            if (remainingWorkingOrderQuantity(t) <= 0) continue;
            const tc = t.contract.code;
            if (tc !== contract.code && getAliasFor(tc) !== contract.code) {
                continue;
            }
            if (!lotShown(t)) continue;
            // HTTP status.order_quantity can be 0 (1.7.6) — use the shared
            // original-quantity rule.
            const remaining = remainingWorkingOrderQuantity(t);
            if (remaining <= 0) continue;
            const price = t.status.modified_price || t.order.price;
            const key = keyOf(price);
            const cur = m.get(key) ?? { buy: 0, sell: 0 };
            if (t.order.action === 'Buy') cur.buy += remaining;
            else cur.sell += remaining;
            m.set(key, cur);
        }
        return m;
    }, [trades, contract.code, lotShown]);

    // today's fills aggregated per price level (from each trade's deals)
    const myFills = useMemo(() => {
        const m = new Map<string, { buy: number; sell: number }>();
        for (const t of trades) {
            const tc = t.contract.code;
            if (tc !== contract.code && getAliasFor(tc) !== contract.code) {
                continue;
            }
            if (!lotShown(t)) continue;
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
    }, [trades, contract.code, lotShown]);

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
        let rowPnl = 0;
        const sideQty = { Buy: 0, Sell: 0 };
        for (const p of matches) {
            net += p.direction === 'Sell' ? -p.quantity : p.quantity;
            cost += p.price * p.quantity;
            qtySum += p.quantity;
            rowPnl += p.pnl || 0;
            sideQty[p.direction === 'Sell' ? 'Sell' : 'Buy'] += p.quantity;
        }
        if (net === 0) return null;
        // Futures only (stock margin longs and short sales are real separate
        // positions). Intra-session the broker — and the live projection of
        // New fills — keeps separate Buy and Sell rows for one contract, and
        // blending them (#116) is not the cost the broker's FIFO netting will
        // give. With offsetting activity, replay this trading day's fills
        // FIFO; show it only when today's fills fully explain the rows.
        // Otherwise keep exactly the rows' figures and mark them 估算, or
        // 待更新 while reports await reconciliation.
        const futures = market === 'F';
        const mixed = futures && sideQty.Buy > 0 && sideQty.Sell > 0;
        const codes = new Set(matches.map(p => p.code));
        const code = codes.size === 1 ? matches[0]!.code : null;
        const since = tradingDayStart(Date.now() / 1000);
        const twoWay = futures && code !== null && hasTwoWayFills(trades, code, since);
        const fills = (mixed || twoWay) && code !== null && !reconcilePending ? collectFills(trades, code, since) : null;
        const mark = lotLast !== null && lotLast > 0 ? lotLast : matches.find(p => p.last_price > 0)?.last_price ?? 0;
        const fifo = fills ? fifoPosition(matches, fills, contract.multiplier ?? 0, mark) : null;
        const fifoOk = fifo !== null && !fifo.seeded;
        const rowAvg = qtySum > 0 ? cost / qtySum : 0;
        const avg = fifoOk ? fifo.avg : rowAvg;
        const pnl = fifoOk ? fifo.pnl : rowPnl;
        const stale = futures && reconcilePending;
        const safeExit = matches.every(p => Number.isInteger(p.quantity) && p.quantity > 0)
            && new Set(matches.map(p => p.direction)).size === 1
            && (market !== 'S' || matches.every(p => 'cond' in p && p.cond === 'Cash'));
        return { net, avg, avgKey: keyOf(roundToTick(contract, avg)), pnl, safeExit, mixed, twoWay, stale, fifo: fifoOk };
    }, [positions, trades, contract, reconcilePending, lotLast]);


    // ---- order actions (all gated by the arm toggle) ----

    // the panel must still trade with the account captured at click time —
    // re-checked after the (optional) confirmation dialog
    const stillPanelAccount = useCallback((captured: Account) => () => accountMatches(accountRef.current, captured), []);

    const send = useCallback(async (action: Action, price: number | null) => {
        const capturedAccount = accountRef.current;
        if (!armedRef.current || !capturedAccount) return;
        const oddLot = oddRef.current;
        const q = Math.max(1, qtyRef.current);
        if (oddLot && price === null) {
            notify({ kind: 'err', title: '⚡ 閃電下單未送出', body: ODD_LOT_TEXT.priceType });
            return;
        }
        const key = `${oddLot ? 'odd:' : ''}${action}:${price === null ? 'MKT' : keyOf(price)}`;
        if (inflightRef.current.has(key)) return; // double-click guard
        inflightRef.current.add(key);
        force();
        try {
            const trade = await placeQuickOrder(
                contractRef.current,
                action,
                price,
                q,
                {
                    account: capturedAccount,
                    isAccountCurrent: stillPanelAccount(capturedAccount),
                    ...(oddLot ? { orderLot: 'IntradayOdd' as const } : {}),
                },
            );
            notify({
                kind: 'ok',
                title: `⚡ ${oddLot ? '零股' : ''}${action === 'Buy' ? '買進' : '賣出'}已送出`,
                body: `${contractRef.current.code} ${q}${oddLot ? ' 股' : ''} @ ${
                    price === null ? '市價' : fmtPrice(price)
                } (${trade.status.status})`,
            });
            onOrdersChangedRef.current?.();
        } catch (e) {
            if (accountChangedBeforeSend(e)) notifyAccountChangedBeforeSend();
            else notify({ kind: 'err', title: '⚡ 閃電下單失敗', body: e instanceof Error ? e.message : String(e) });
        } finally {
            inflightRef.current.delete(key);
            force();
        }
    }, [stillPanelAccount]);

    const onCell = useCallback(
        (action: Action, price: number) => void send(action, price),
        [send],
    );

    const cancelAt = useCallback(async (action: Action, price: number) => {
        const capturedAccount = accountRef.current;
        if (!capturedAccount) return;
        const code = contractRef.current.code;
        const targets = tradesRef.current.filter(
            (t) =>
                accountMatches((t as Trade & { account?: Account }).account ?? t.order.account, capturedAccount) &&
                remainingWorkingOrderQuantity(t) > 0 &&
                (t.contract.code === code ||
                    getAliasFor(t.contract.code) === code) &&
                t.order.action === action &&
                // 只刪目前單位的委託：點 300 股的格子不可連帶刪掉同價的整股單（#204）
                (contractRef.current.security_type !== 'STK' ||
                    isOddLot(t.order.order_lot) === oddRef.current) &&
                keyOf(t.status.modified_price || t.order.price) ===
                    keyOf(price),
        );
        if (targets.length === 0) return;
        const results = await cancelOrders(targets.map((t) => t.order.id));
        const summary = cancellationSummary(results);
        notify({
            kind: summary.kind,
            title: '⚡ 刪單',
            body: `${code} @ ${fmtPrice(price)}：${summary.body}`,
        });
        onOrdersChangedRef.current?.();
    }, []);

    const onCancelAt = useCallback(
        (action: Action, price: number) => void cancelAt(action, price),
        [cancelAt],
    );

    const cancelSymbol = useCallback(async () => {
        const capturedAccount = accountRef.current;
        if (!capturedAccount) return;
        const code = contractRef.current.code;
        const targets = tradesRef.current.filter(
            (t) =>
                accountMatches((t as Trade & { account?: Account }).account ?? t.order.account, capturedAccount) &&
                remainingWorkingOrderQuantity(t) > 0 &&
                (t.contract.code === code ||
                    getAliasFor(t.contract.code) === code),
        );
        if (targets.length === 0) {
            notify({ kind: 'info', title: '⚡ 全刪', body: '沒有可刪的委託' });
            return;
        }
        const results = await cancelOrders(targets.map((t) => t.order.id));
        const summary = cancellationSummary(results);
        notify({
            kind: summary.kind,
            title: '⚡ 全刪',
            body: `${code}：${summary.body}`,
        });
        onOrdersChangedRef.current?.();
    }, []);

    const flatten = useCallback(async () => {
        const account = accountRef.current;
        if (!pos?.safeExit || !armedRef.current || !account) return;
        const key = `flatten:${account.account_type}:${account.broker_id}:${account.account_id}`;
        if (inflightRef.current.has(key)) return;
        inflightRef.current.add(key);
        const contract = contractRef.current;
        const action = pos.net > 0 ? 'Sell' : 'Buy';
        try {
            if (account.account_type === 'S') {
                await placeStockExitByShares(contract, action, Math.abs(pos.net), account, { isAccountCurrent: stillPanelAccount(account) });
            } else {
                await placeQuickOrder(contract, action, null, Math.abs(pos.net), { account, ocType: 'Cover', isAccountCurrent: stillPanelAccount(account) });
            }
            notify({ kind: 'info', title: '⚡ 平倉已送出', body: '請以委託與成交回報確認結果' });
            onOrdersChangedRef.current?.();
        } catch (error) {
            if (accountChangedBeforeSend(error)) notifyAccountChangedBeforeSend();
            else notify({ kind: 'err', title: '⚡ 平倉未完整確認', body: `可能已有部分委託送出或結果未知，請手動核對委託，勿直接重送。${error instanceof Error ? error.message : String(error)}` });
        } finally { inflightRef.current.delete(key); }
    }, [pos, stillPanelAccount]);

    // ---- render ----

    const lastKey = last !== null ? keyOf(roundToTick(contract, last)) : '';
    const lastIdx =
        lastKey === '' ? -1 : rows.findIndex((r) => keyOf(r) === lastKey);
    const topRow = rows[0];
    const lastAbove =
        lastIdx === -1 && last !== null && topRow !== undefined
            ? last > topRow
            : false;

    // 全刪 cancels every working order of the symbol (both units); the other
    // unit's orders are not on the ladder, so say how many there are
    const { workingCount, otherLotOrders } = useMemo(() => {
        let n = 0;
        let other = 0;
        for (const v of myOrders.values()) n += v.buy + v.sell;
        for (const t of trades) {
            if (remainingWorkingOrderQuantity(t) <= 0) continue;
            if (t.contract.code !== contract.code && getAliasFor(t.contract.code) !== contract.code) continue;
            if (!lotShown(t)) other += 1;
        }
        return { workingCount: n, otherLotOrders: other };
    }, [myOrders, trades, contract.code, lotShown]);

    const symbolLabel = flashSymbolLabel(contract);
    const flashSettings = normalizeChartOrder({ qty, lot }, market);
    const accountLabels = flashAccountLabels(eligible, privacy);
    const accountShort = resolved.following
        ? activeAccount ? `跟隨 ${accountLabels.short(activeAccount)}` : accountsLoading ? '帳戶載入中' : '無可用帳戶'
        : resolved.missing ? (accountsLoading ? '帳戶載入中' : '帳戶不可用')
        : activeAccount ? accountLabels.short(activeAccount) : '選擇帳戶';
    const accountTitle = activeAccount
        ? `${resolved.following ? '跟隨主畫面：' : ''}${accountLabels.long(activeAccount)}`
        : '選擇閃電下單帳戶';

    return (
        <div className={styles.wrap}>
            <div className={styles.symbolRow} title={symbolLabel.title}>
                <span className={styles.symbolName}>{symbolLabel.name}</span>
                <span className={styles.symbolMeta}>{symbolLabel.meta}</span>
            </div>
            <div className={styles.controls}>
                {/* 收合時只顯示精簡帳號（#176）；透明的原生 select 疊在上面，
                    展開的選單才列出帳號＋戶名 */}
                <label className={styles.accountPick}>
                    <span className={styles.accountText}>{accountShort}</span>
                    <ChevronDown size={10} aria-hidden />
                    <select
                        className={styles.accountSelect}
                        aria-label="閃電下單帳戶"
                        // 透明 select 蓋住標籤，完整帳號＋戶名的 tooltip 要放在 select 上
                        title={`${accountTitle}\n${resolved.following ? '跟隨主畫面帳戶 — 選擇帳戶後此視窗固定使用該帳戶' : '此視窗固定帳戶，不影響其他視窗與主畫面'}`}
                        value={resolved.following ? FOLLOW_GLOBAL : resolved.unset ? '' : panelKeys[market]}
                        onChange={e => {
                            armedRef.current = false;
                            setArmed(false);
                            const value = e.target.value;
                            if (value === FOLLOW_GLOBAL ? !followMain : !eligible.some(a => flashAccountKey(a) === value)) return;
                            const next = { ...panelKeys };
                            if (value === FOLLOW_GLOBAL) delete next[market];
                            else next[market] = value;
                            // drop the old account right away so nothing queued before
                            // the re-render can still fire with it
                            accountRef.current = undefined;
                            if (onAccountKeysChange) onAccountKeysChange(next);
                            else setLocalKeys(next);
                        }}
                    >
                        {followMain ? (
                            <option value={FOLLOW_GLOBAL}>
                                {!resolved.following
                                    ? '跟隨主畫面'
                                    : activeAccount
                                      ? `跟隨主畫面 ${accountLabels.long(activeAccount)}`
                                      : accountsLoading
                                        ? '跟隨主畫面（帳戶載入中）'
                                        : '跟隨主畫面（無可用帳戶）'}
                            </option>
                        ) : resolved.unset && <option value=''>請選擇帳戶</option>}
                        {resolved.missing && <option value={panelKeys[market]}>{accountsLoading ? '帳戶載入中' : '帳戶不可用'}</option>}
                        {eligible.map(a => <option key={flashAccountKey(a)} value={flashAccountKey(a)}>
                            {accountLabels.long(a)}
                        </option>)}
                    </select>
                </label>
                <button
                    className={styles.stepBtn}
                    onClick={() => setQty((v) => Math.max(1, v - 1))}
                >
                    −
                </button>
                <input
                    className={styles.qtyInput}
                    aria-label={odd ? '數量（股）' : '數量'}
                    title={odd ? `零股數量 1～${ODD_LOT_MAX_SHARES} 股` : '數量'}
                    value={qty}
                    inputMode='numeric'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0 && (!odd || v <= ODD_LOT_MAX_SHARES)) setQty(v);
                    }}
                />
                <button
                    className={styles.stepBtn}
                    onClick={() => setQty((v) => (odd ? clampLotQuantity(v + 1, 'IntradayOdd') : v + 1))}
                >
                    ＋
                </button>
                <span className={styles.qtyUnit}>{market === 'F' ? '口' : odd ? '股' : '張'}</span>
                <OrderSettingsButton
                    market={market}
                    settings={flashSettings}
                    onChange={next => {
                        if (next.lot !== lot) {
                            // 換單位一律先上鎖，股數與張數不能互換
                            armedRef.current = false;
                            setArmed(false);
                            setLot(next.lot);
                        }
                        setQty(next.qty);
                    }}
                    onSaveDefault={() => {
                        saveFlashOrderDefault(market, flashSettings);
                        notify({ kind: 'info', title: '已設為閃電下單預設', body: `新開的${market === 'F' ? '期貨' : '股票'}閃電下單面板與換商品時使用這組單位與數量；帳號不變。` });
                    }}
                    layout={{
                        title: '閃電下單設定',
                        scope: '只影響這個面板',
                        unit: market === 'S',
                        orderType: false,
                        octype: false,
                        defaultNote: `新開的${market === 'F' ? '期貨' : '股票'}閃電下單面板使用這組單位與數量（不含帳號）`,
                        qtyLabel: '閃電下單數量',
                    }}
                    contractLabel={symbolLabel.name === contract.code ? contract.code : `${contract.code} ${symbolLabel.name}`}
                    summary={flashOrderSummary(flashSettings, market, accountShort)}
                    ariaLabel='閃電下單設定'
                    onOpenChange={open => { settingsOpenRef.current = open; }}
                    align='panel'
                />
                <span className={styles.rowBreak} aria-hidden />
                <button
                    className={styles.armBtn[armed ? 'on' : 'off']}
                    disabled={!live || !activeAccount}
                    onClick={() => { armedAccountKey.current = accountKey; setArmed((a) => !a); }}
                >
                    {!live ? (
                        '⚠ 行情或交易狀態未連線'
                    ) : armed ? (
                        <>
                            <Zap size={10} style={{ verticalAlign: '-1px' }} />{' '}
                            點價即下單
                        </>
                    ) : (
                        '啟用閃電下單'
                    )}
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
                    className={`${styles.mktBtn.buy} ${armed && !odd ? '' : styles.disabledCell}`}
                    disabled={odd}
                    title={odd ? ODD_LOT_TEXT.priceType : undefined}
                    onClick={() => void send('Buy', null)}
                >
                    市價買
                </button>
                <button
                    className={`${styles.mktBtn.sell} ${armed && !odd ? '' : styles.disabledCell}`}
                    disabled={odd}
                    title={odd ? ODD_LOT_TEXT.priceType : undefined}
                    onClick={() => void send('Sell', null)}
                >
                    市價賣
                </button>
                {pos && (
                    <button
                        className={`${styles.flatBtn} ${armed ? '' : styles.disabledCell}`}
                        title={pos.safeExit
                            ? market === 'S'
                                ? `平倉 ${maskMoney(fmtStockLots(Math.abs(pos.net)), privMoney)}（整張市價、零股以漲跌停價限價）`
                                : `市價平倉 ${maskMoney(String(Math.abs(pos.net)), privMoney)}`
                            : '持倉方向或交易條件不明，請使用持倉面板確認'}
                        disabled={!pos.safeExit || !armed || !activeAccount}
                        onClick={() => void flatten()}
                    >
                        平倉
                    </button>
                )}
                <button
                    className={styles.cancelAllBtn}
                    disabled={workingCount === 0 && otherLotOrders === 0}
                    onClick={() => void cancelSymbol()}
                >
                    全刪{workingCount > 0 ? ` ${workingCount}` : ''}
                </button>
            </div>
            {pos && (
                <div className={styles.posBar}>
                    <span className={pos.net > 0 ? styles.posLong : styles.posShort}
                        title={market === 'S' && !privMoney ? `${Math.abs(pos.net).toLocaleString()} 股（含零股）` : undefined}>
                        {pos.net > 0 ? '多' : '空'} {maskMoney(market === 'S' ? fmtStockLots(Math.abs(pos.net)) : String(Math.abs(pos.net)), privMoney)}
                    </span>
                    <span>@ {fmtPrice(pos.avg)}</span>
                    {(pos.mixed || pos.twoWay || pos.stale) && (
                        <span className={styles.posMixed} title={posNote(pos)}>
                            {posLabel(pos)}
                        </span>
                    )}
                    <span
                        className={
                            pos.pnl >= 0 ? styles.posLong : styles.posShort
                        }
                    >
                        {maskMoney(fmtSigned(pos.pnl), privMoney)}
                    </span>
                </div>
            )}
            {odd && (
                <div className={styles.oddBanner} title='盤中零股與整股分開撮合，成交價可能與整股五檔不同'>
                    盤中零股 · 以股計 · 只限價 ROD · 僅現股；五檔與成交為零股行情（股）
                    {oddMatchTime && <span className={styles.oddMatchTime} title='盤中零股約每 5 秒撮合一次；五檔與成交價在撮合時更新'> · 最近撮合 {oddMatchTime}</span>}
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
                            compact={odd}
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
                {display?.source === 'snapshot' && <span title={display.time}>快照一檔</span>}
                {odd && !oddQuote && <span title='尚未收到盤中零股行情；梯形暫以整股成交價置中'>等待零股行情</span>}
                {otherLotOrders > 0 && (
                    <span title={`梯形只顯示${odd ? '零股' : '整股'}委託；全刪會一併刪除`}>
                        另有{odd ? '整股' : '零股'}委託 {otherLotOrders} 筆
                    </span>
                )}
                <span className={styles.totalBid} title={odd ? `${fmtInt(sumBid)} 股` : undefined}>Σ買 {odd ? fmtCompactInt(sumBid) : fmtInt(sumBid)}</span>
                <span className={styles.totalAsk} title={odd ? `${fmtInt(sumAsk)} 股` : undefined}>Σ賣 {odd ? fmtCompactInt(sumAsk) : fmtInt(sumAsk)}</span>
            </div>
            <div className={styles.hint}>
                {armed
                    ? odd
                        ? `點買量=零股限價買 ${qty} 股 · 點賣量=零股限價賣 · 點單量=刪單 · Esc 鎖定`
                        : '點買量=限價買 · 點賣量=限價賣 · 點單量=刪單 · Esc 鎖定'
                    : '安全鎖定中 — 點「啟用閃電下單」解鎖 · 滾輪捲動 · 雙擊置中'}
            </div>
        </div>
    );
}
