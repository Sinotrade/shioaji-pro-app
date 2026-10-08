import { canTrade } from '../lib/account-tradable';
import { ORDER_CONTEXT_CHANGED_MESSAGE, useOrderContext } from '../hooks/use-order-context';
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
import { FlashQuickMenu } from './flash-quick-menu';
import { octypeLabel, quickOrderNote } from '../lib/order-conditions';
import { accountMatches, CASH_CREDIT, DEFAULT_ORDER_OPTS, normalizeFlashOrderOpts, type FlashOrderOpts, flashAccountKey, isFlashLot, normalizeFlashCredit, resolveFlashAccount, scopedFlashRows, type FlashAccountKeys, type FlashCredit, type FlashLot, type FlashMarket } from '../lib/flash-account';
import { creditEnquireCond, creditSideBlocks, creditStatus, prepareCreditOrder, useCreditEnquire, type CreditCond } from '../lib/credit-eligibility';
import { getApiBase } from '../lib/runtime';
import { captureServerMode } from '../lib/server-info-store';
import { collectFills, fifoPosition, hasTwoWayFills, tradingDayStart } from '../lib/futures-fifo';
import { Ban, ChevronDown, Zap } from 'lucide-react';
import {
    type ReactNode,
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
import { ACTIVE_ORDER_STATUSES, type Action, type FuturesOCType, type OrderType, type Trade } from '../lib/types/order';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import { fmtClock, fmtCompactInt, fmtInt, fmtPrice, fmtSigned, fmtStockLots } from '../lib/utils/format';
import { clampLotQuantity, CREDIT_TEXT, creditLabel, isOddLot, ODD_LOT_MAX_SHARES, ODD_LOT_TEXT } from '../lib/odd-lot';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import { flashAccountLabels, flashSymbolLabel } from '../lib/flash-display';
import { flashQtyMemoryText, flashQtySlot, rememberedFlashQty, sanitizeFlashQtySetting, validFlashQty, withRememberedFlashQty, type FlashQtySetting } from '../lib/flash-qty-memory';
import { expiryTime, isStockFuture, lotsPerContract, spreadOf } from '../lib/flash-link';
import * as styles from './flash-order.css';

const ROW_H = 22; // must match row height in flash-order.css.ts
const EDGE = 2; // auto-recenter when last price gets this close to the edge

const keyOf = (p: number) => p.toFixed(2);
const FOLLOW_GLOBAL = '__follow__';
const ACCOUNT_CHANGED_DURING_CONFIRMATION = '確認期間帳戶已變更，請重新確認';
const CONTRACT_EXPIRED = '合約已到期，這筆沒有送出';

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
    /** a side this panel's credit condition cannot send (reason), else null */
    buyBlock: string | null;
    sellBlock: string | null;
    /** 信用條件寫進格子提示（融資限價買 …） */
    credit: { buy: string; sell: string };
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
    buyBlock,
    sellBlock,
    credit,
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
                className={`${styles.buyCell} ${armed && !buyBlock ? '' : styles.disabledCell} ${buyBlock ? styles.blockedSide : ''}`}
                title={buyBlock ?? (armed ? `${credit.buy}限價買 ${text}` : '先啟用閃電下單')}
                data-side='buy'
                data-blocked={buyBlock ? true : undefined}
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
                className={`${styles.sellCell} ${armed && !sellBlock ? '' : styles.disabledCell} ${sellBlock ? styles.blockedSide : ''}`}
                title={sellBlock ?? (armed ? `${credit.sell}限價賣 ${text}` : '先啟用閃電下單')}
                data-side='sell'
                data-blocked={sellBlock ? true : undefined}
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
    lot: savedLot,
    onLotChange,
    qtyMemory: savedQtyMemory,
    onQtyMemoryChange,
    credit: savedCredit,
    onCreditChange,
    orderOpts: savedOrder,
    onOrderOptsChange,
    linkKey = '',
    symbolExtra,
    settingsRows,
    showRef = true,
    expiresAt = null,
    paused: pausedProp,
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
    // this panel's own unit (整股／盤中零股): kept across symbol changes and
    // persisted by the owner (workspace block / popout window) through
    // onLotChange. Undefined = never chosen → the 設為預設 unit.
    lot?: FlashLot;
    onLotChange?: (lot: FlashLot) => void;
    // 記住數量（預設開）：張／股／口各一個數量，由擁有者保存；false = 關閉。
    // 沒有 onQtyMemoryChange 時只在元件內
    qtyMemory?: FlashQtySetting;
    onQtyMemoryChange?: (setting: FlashQtySetting) => void;
    // this panel's own credit condition (整股：同下單面板的信用條件＋現股當沖先賣):
    // kept across symbol changes, persisted by the owner like the unit.
    // Undefined = never chosen → 現股.
    credit?: FlashCredit;
    onCreditChange?: (credit: FlashCredit) => void;
    // this panel's own order conditions (效期／期貨倉別／範圍市價), kept across
    // symbol changes and persisted by the owner. Undefined = defaults.
    orderOpts?: FlashOrderOpts;
    onOrderOptsChange?: (order: FlashOrderOpts) => void;
    /** 連動狀態（群組、對應商品、來源代碼）：一變就同一次 render 解除點價下單，
     * 確認中的那筆也不送 — 即使換完的合約跟原本相同 */
    linkKey?: string;
    /** 商品列右側（個股期月份） */
    symbolExtra?: ReactNode;
    /** 設定面板最上面的列（對應商品／規格／月份／價差對照） */
    settingsRows?: ReactNode;
    /** 價差對照列（零股：整零差；個股期：期現差） */
    showRef?: boolean;
    /** 對應的個股期到期時刻（最後交易日收盤）；之後點下去或確認中的都不送 */
    expiresAt?: number | null;
    /** 對應商品查詢中：面板保留（數量等狀態不重設），但不顯示舊合約、不能啟用或送出 */
    paused?: string;
}) {
    const { quote, snapshot: initialSnapshot, book: lotDisplay } = useDisplayBook(contract.code, snapshot, contract);
    // 真實月份個股期沒有最後交易日：無法判斷到期，跟查詢中一樣暫停（照選取、彈出視窗也一樣）
    const paused = pausedProp ?? (isStockFuture(contract) && !contract.target_code && expiryTime(contract) === null ? '個股期到期日無法確認，暫停送單' : undefined);
    const live = useTradingLive();
    const accountState = useAccounts();
    const privacy = usePrivacyMode();
    const market: FlashMarket = contract.security_type === 'STK' ? 'S' : 'F';
    const [localKeys, setLocalKeys] = useState<FlashAccountKeys>(accountKeys ?? {});
    const panelKeys = onAccountKeysChange ? (accountKeys ?? {}) : localKeys;
    const globalAccount = market === 'S' ? accountState.selectedStock : accountState.selectedFutures;
    const eligible = accountState.accounts.filter(a => canTrade(a) && a.account_type === market);
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
    // 預設在面板建立時就對股票與期貨「兩種」類別各取一份快照（#204）：之後
    // 別的面板按「設為預設」不會改到這個面板（包括它之後才切到的類別），
    // 只有這個面板自己的「設為預設」會更新它的快照
    const defaultSnapshot = useRef<Record<FlashMarket, ReturnType<typeof loadFlashOrderDefault>> | null>(null);
    defaultSnapshot.current ??= { S: loadFlashOrderDefault('S'), F: loadFlashOrderDefault('F') };
    const defaultFor = (m: FlashMarket) => defaultSnapshot.current![m];
    // 股票：整股（張）或盤中零股（股）（#204）是「這個面板」的設定，換股票不變；
    // 有 onLotChange 時由擁有者（版面 block／彈出視窗）保存，否則只在元件內。
    // 從沒選過（含升級前的面板）＝建立時的「設為預設」單位，不讀舊的依股票紀錄
    const [localLot, setLocalLot] = useState<FlashLot | undefined>(isFlashLot(savedLot) ? savedLot : undefined);
    const ownLot = onLotChange ? (isFlashLot(savedLot) ? savedLot : undefined) : localLot;
    const panelLot: FlashLot = ownLot ?? defaultFor('S').lot;
    // 期貨沒有零股：照常以「口」下單，面板單位不變，回到股票時恢復
    const lot: FlashLot = market === 'F' ? 'Common' : panelLot;
    // 數量只屬於輸入時的商品類別與單位：單位或類別一變（包含切換版面等外部
    // 改變），同一次 render 就視為 1、點價下單也用 1，不等 effect（#204）
    const unitKey = `${market}:${lot}`;
    const unitKeyRef = useRef(unitKey);
    unitKeyRef.current = unitKey;
    // 記住數量：依單位（張／股／口）各記一個；還原前一律重新檢查單位上限
    const [localQtyMemory, setLocalQtyMemory] = useState<FlashQtySetting>(() => sanitizeFlashQtySetting(savedQtyMemory));
    const qtyMemory: FlashQtySetting = onQtyMemoryChange ? sanitizeFlashQtySetting(savedQtyMemory) : localQtyMemory;
    const qtyMemoryRef = useRef(qtyMemory);
    qtyMemoryRef.current = qtyMemory;
    const onQtyMemoryChangeRef = useRef(onQtyMemoryChange);
    onQtyMemoryChangeRef.current = onQtyMemoryChange;
    const setQtyMemory = useCallback((next: FlashQtySetting) => {
        qtyMemoryRef.current = next;
        setLocalQtyMemory(next);
        onQtyMemoryChangeRef.current?.(next);
    }, []);
    const qtySlot = flashQtySlot(market, lot);
    const qtySlotRef = useRef(qtySlot);
    qtySlotRef.current = qtySlot;
    const remembered = qtyMemory === false ? { qty: undefined, invalid: false } : rememberedFlashQty(qtyMemory, qtySlot);
    const rememberedQty = remembered.qty;
    // 記住數量關閉或記住的數量不合法 → 1；開啟但這個單位還沒記住 → 設為預設
    const [qtyEntry, setQtyEntry] = useState<{ unit: string; qty: number }>(() => {
        if (qtyMemory === false || remembered.invalid) return { unit: unitKey, qty: 1 };
        if (rememberedQty !== undefined) return { unit: unitKey, qty: rememberedQty };
        return { unit: unitKey, qty: lot === defaultFor(market).lot ? defaultFor(market).qty : 1 };
    });
    // 記住數量開啟且這個單位有合法紀錄時，紀錄就是數量：切換版面等外部還原、
    // 換單位，都在同一次 render 生效；其他情況用輸入值（單位不同視為 1）
    const qty = remembered.invalid ? 1 : rememberedQty ?? (qtyEntry.unit === unitKey ? qtyEntry.qty : 1);
    const qtyNowRef = useRef(qty);
    qtyNowRef.current = qty;
    // 點價下單啟用時這個單位記住的數量；之後由外部（切換版面）改掉就失效
    const armedMemQty = useRef<number | undefined>(rememberedQty);
    // 使用者改數量（輸入、±、設定）：同一個事件裡一起更新這個單位的記憶 —
    // 合法就記下，不合法（例如清空、超過上限）就移除這個單位的紀錄
    const setQty = useCallback((v: number | ((prev: number) => number)) => {
        const next = typeof v === 'function' ? v(qtyNowRef.current) : v;
        const unit = unitKeyRef.current;
        const slot = qtySlotRef.current;
        setQtyEntry({ unit, qty: next });
        const mem = qtyMemoryRef.current;
        if (mem === false) return;
        if (validFlashQty(slot, next)) {
            armedMemQty.current = next;
            if (mem[slot] !== next) setQtyMemory(withRememberedFlashQty(mem, slot, next));
        } else {
            armedMemQty.current = undefined;
            if (Object.prototype.hasOwnProperty.call(mem, slot)) {
                const { [slot]: _dropped, ...rest } = mem;
                setQtyMemory(rest);
            }
        }
    }, [setQtyMemory]);
    // 輸入值跟著記住的數量，關閉記住數量時數量不會跳回舊值
    useEffect(() => {
        if (rememberedQty !== undefined) setQtyEntry(prev => (prev.unit === unitKey && prev.qty === rememberedQty ? prev : { unit: unitKey, qty: rememberedQty }));
    }, [rememberedQty, unitKey]);
    // 記住的數量不合法（超過單位上限、非整數等）：不帶出來，回到 1、提示並移除
    const invalidRemembered = remembered.invalid;
    useEffect(() => {
        if (!invalidRemembered) return;
        // 以最新的記憶再確認一次：已處理過（例如 StrictMode 重跑 effect）就不重複提示
        const mem = qtyMemoryRef.current;
        if (mem === false || !rememberedFlashQty(mem, qtySlot).invalid) return;
        const { [qtySlot]: bad, ...rest } = mem;
        const unitName = qtySlot === 'F' ? '口' : qtySlot === 'IntradayOdd' ? '股' : '張';
        notify({
            kind: 'err',
            title: '記住的數量已改為 1',
            body: `這個閃電面板記住的數量（${String(bad)} ${unitName}）不符合單位限制${qtySlot === 'IntradayOdd' ? `（零股每筆 1～${ODD_LOT_MAX_SHARES} 股）` : ''}，已改為 1 ${unitName}，請確認數量後再下單。`,
        });
        // 先把數量定在 1，移除紀錄後也不會回到舊的輸入值
        setQtyEntry({ unit: unitKeyRef.current, qty: 1 });
        setQtyMemory(rest);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [invalidRemembered, qtySlot]);
    const setPanelLot = (next: FlashLot) => {
        setLocalLot(next);
        onLotChange?.(next);
    };
    // 沒存過單位的面板（新開或升級前）把建立時的預設單位存一次，之後別的
    // 面板改「設為預設」不會在重新整理、切換版面或彈出時改到這個面板
    const onLotChangeRef = useRef(onLotChange);
    onLotChangeRef.current = onLotChange;
    const savedLotValid = isFlashLot(savedLot);
    useEffect(() => {
        if (!savedLotValid) onLotChangeRef.current?.(panelLot);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [savedLotValid]);
    const odd = market === 'S' && lot === 'IntradayOdd';
    // 信用條件是面板的設定（跟單位一樣），換股票保留。只在整股股票適用：
    // 零股時暫時當作現股（選項停用、設定不覆寫，切回整股恢復），期貨不顯示
    const [localCredit, setLocalCredit] = useState<FlashCredit | undefined>(() => normalizeFlashCredit(savedCredit));
    const ownCredit = onCreditChange ? normalizeFlashCredit(savedCredit) : localCredit;
    const panelCredit: FlashCredit = ownCredit ?? CASH_CREDIT;
    const creditApplies = market === 'S' && lot === 'Common';
    const credit: FlashCredit = creditApplies ? panelCredit : CASH_CREDIT;
    const creditKey = `${credit.cond}:${credit.daytradeShort ? 'dt' : ''}`;
    const setPanelCredit = (next: FlashCredit) => {
        setLocalCredit(next);
        onCreditChange?.(next);
    };
    // 可否融資／融券：只在面板是融資或融券時查（當日快取）；成數或單位確定
    // 是 0 才擋，查詢失敗只提示（由券商端決定）。絕不自動改成現股送出
    // 只有融資／融券要查 credit_enquire；借券類由券源決定，不查
    const creditCond: CreditCond | null = creditEnquireCond(credit);
    const enquiry = useCreditEnquire(contract, creditCond !== null);
    const creditCheck: 'ok' | 'blocked' | 'unknown' | 'loading' = creditCond === null
        ? 'ok'
        : enquiry.loading ? 'loading' : enquiry.failed ? 'unknown' : creditStatus(enquiry.row, creditCond);
    const creditName = creditLabel('Sell', credit.cond) ?? '';
    // 每一邊的停用原因與送單時的固定規則：與 K 線圖下單共用（credit-eligibility）
    const sides = creditSideBlocks(contract, credit, creditCheck);
    const { sellOnly, creditBlocked, dayTradeBlocked } = sides;
    const buyBlock = sides.buy;
    const sellBlock = sides.sell;
    // 融券面板的買邊停用，市價鈕仍寫「市價買」（不會出現「融券買」）
    const buyCredit = sellOnly ? '' : creditLabel('Buy', credit.cond, credit.daytradeShort) ?? '';
    const sellCredit = creditLabel('Sell', credit.cond, credit.daytradeShort) ?? '';
    const creditTag = creditApplies ? (credit.cond !== 'Cash' ? creditName : credit.daytradeShort ? '現沖' : '') : '';
    const creditBad = !!creditBlocked || !!dayTradeBlocked;
    // 送單時的固定規則（融券不能買、不可當沖）；可否融資券在送出前重新查詢，
    // 不沿用畫面上可能過時的結果
    const ruleBlockRef = useRef<Record<Action, string | null>>({ Buy: null, Sell: null });
    ruleBlockRef.current = sides.rule;
    const creditRef = useRef({ applies: creditApplies, credit });
    creditRef.current = { applies: creditApplies, credit };
    // 委託條件（同下單面板）：點價限價單的效期、期貨倉別、期貨市價鈕的價別。
    // 面板的設定；不適用的商品類別暫不套用（零股只能 ROD、股票沒有倉別與
    // 範圍市價），設定不覆寫，回來恢復
    const [localOrder, setLocalOrder] = useState<FlashOrderOpts | undefined>(() => normalizeFlashOrderOpts(savedOrder));
    const panelOrder: FlashOrderOpts = (onOrderOptsChange ? normalizeFlashOrderOpts(savedOrder) : localOrder) ?? DEFAULT_ORDER_OPTS;
    const setPanelOrder = (next: FlashOrderOpts) => {
        setLocalOrder(next);
        onOrderOptsChange?.(next);
    };
    const clickOrderType: OrderType = odd ? 'ROD' : panelOrder.orderType;
    const clickOctype: FuturesOCType | undefined = market === 'F' ? panelOrder.octype : undefined;
    const mktPriceType: 'MKT' | 'MKP' = market === 'F' ? panelOrder.futuresPriceType : 'MKT';
    const orderKey = `${clickOrderType}:${clickOctype ?? ''}:${mktPriceType}`;
    // 非預設才顯示標籤
    const orderTags = [
        ...(clickOrderType !== 'ROD' ? [clickOrderType] : []),
        ...(clickOctype && clickOctype !== 'Auto' ? [octypeLabel(clickOctype)] : []),
        ...(mktPriceType === 'MKP' ? ['範圍市價'] : []),
    ];
    const unitTag = market === 'F'
        ? (clickOctype && clickOctype !== 'Auto' ? octypeLabel(clickOctype) : '')
        : (creditTag === '借券豁免' ? '借豁' : creditTag);
    const orderSuffix = clickOrderType !== 'ROD' ? ` ${clickOrderType}` : '';
    const mktLabel = mktPriceType === 'MKP' ? '範圍市價' : '市價';
    const orderRef = useRef({ orderType: clickOrderType, octype: clickOctype, priceType: mktPriceType });
    orderRef.current = { orderType: clickOrderType, octype: clickOctype, priceType: mktPriceType };
    // which market the quick menu was opened for (its contents differ)
    const [menuOpen, setMenuOpenState] = useState<FlashMarket | null>(null);
    // the quick menu spans the controls row (narrow panels clip anything hanging off the button)
    const [menuTop, setMenuTop] = useState<number | undefined>(undefined);
    const unitBtnRef = useRef<HTMLButtonElement>(null);
    const openSettingsRef = useRef<((top?: number) => void) | null>(null);
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
    // 價差對照只用成交價（即時或快照），不拿參考價充數
    const tradedLast = quote?.tick ? Number(quote.tick.close) : initialSnapshot?.close || null;
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
    // 確認期間換信用條件也一樣中止（不會用舊條件送出）
    // 暫停（對應商品查詢中）也算換了狀態：確認中的單作廢，之後恢復也不會復活
    const captureContext = useOrderContext(contract, `${lot}:${creditKey}:${orderKey}:${linkKey}:${paused ? 'paused' : ''}`);
    const armedRef = useRef(armed);
    // 真實月份個股期（不是近月別名）在最後交易日收盤後一律不送 — 彈出視窗、照選取也一樣；其他期貨不由這裡判斷
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const expiresRef = useRef(expiresAt);
    expiresRef.current = expiresAt ?? (isStockFuture(contract) && !contract.target_code ? expiryTime(contract) : null);
    const expiredNow = () => expiresRef.current !== null && expiresRef.current !== undefined && Date.now() >= expiresRef.current;
    const armedAccountKey = useRef(accountKey);
    // 啟用時的商品與單位：換商品或單位一變（含外部改變）立即失效，不等
    // effect 解除 — 數量保留時也不會把上一檔的啟用帶到新商品
    const armKey = `${contract.code}:${unitKey}:${creditKey}:${orderKey}:${linkKey}:${paused ? 'paused' : ''}`;
    const armedKey = useRef(armKey);
    const armedQtyCurrent = armedMemQty.current === rememberedQty;
    armedRef.current = armed && armedAccountKey.current === accountKey && armedKey.current === armKey && armedQtyCurrent && !paused;
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

    // Account and unit changes still disarm an active ladder.
    useEffect(() => {
        setArmed(false);
    }, [contract.code, accountKey, lot, creditKey, orderKey, linkKey, paused]);
    // 記住的數量被外部改掉（例如切換版面）：點價下單解除
    useEffect(() => {
        if (armed && !armedQtyCurrent) setArmed(false);
    }, [armed, armedQtyCurrent]);

    // 換商品時單位跟著面板走、不變；數量只在輸入時的單位有效：商品類別
    // （股票／期貨）或單位一變就歸 1，單位沒變就保留（零股 500 股換股票仍是
    // 500 股）。500 股絕不會變成 500 口或 500 張（#204）。單位由外部改變
    // （例如切換版面）也一樣歸 1
    const unitRef = useRef({ market, lot });
    useEffect(() => {
        const prev = unitRef.current;
        unitRef.current = { market, lot };
        // 換到新單位：帶出該單位記住的數量（已檢查上限），否則 1；
        // 記住數量關閉時回到原單位也不讓舊數量復活
        if (prev.market !== market || prev.lot !== lot) {
            const mem = qtyMemoryRef.current;
            const restored = mem === false ? undefined : rememberedFlashQty(mem, flashQtySlot(market, lot)).qty;
            setQtyEntry({ unit: `${market}:${lot}`, qty: restored ?? 1 });
        }
    }, [market, lot]);

    // safety: drop out of armed mode the moment the feed isn't LIVE so a
    // click can't fire into a dead connection (issue #2)
    useEffect(() => {
        if (!live) setArmed(false);
    }, [live]);

    // Esc disarms anywhere — except while the settings popover is open:
    // there Esc only closes the popover
    const settingsOpenRef = useRef(false);
    // the quick menu belongs to the market it was opened for: switching between
    // stock and futures closes it (and its Esc listener) in the same render
    const menuShown = menuOpen === market;
    const menuOpenRef = useRef(false);
    menuOpenRef.current = menuShown;
    const setMenuOpen = (open: boolean) => { menuOpenRef.current = open; setMenuOpenState(open ? market : null); };
    useEffect(() => {
        if (menuOpen !== null && menuOpen !== market) setMenuOpenState(null);
    }, [market, menuOpen]);
    // Esc closes the quick menu and nothing else (no disarm)
    useEffect(() => {
        if (!menuShown) return;
        const onKey = (e: KeyboardEvent) => {
            // the menu may already be gone (e.g. switched to futures) before this listener is removed
            if (e.key === 'Escape' && menuOpenRef.current) { e.stopImmediatePropagation(); e.preventDefault(); menuOpenRef.current = false; setMenuOpenState(null); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [menuShown]);
    useEffect(() => {
        if (!armed) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !settingsOpenRef.current && !menuOpenRef.current && !e.defaultPrevented) setArmed(false);
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
        const capturedContract = contractRef.current;
        const isContextCurrent = captureContext();
        const q = Math.max(1, qtyRef.current);
        if (expiredNow()) {
            notify({ kind: 'err', title: '⚡ 閃電下單未送出', body: CONTRACT_EXPIRED });
            return;
        }
        if (pausedRef.current) return;
        if (oddLot && price === null) {
            notify({ kind: 'err', title: '⚡ 閃電下單未送出', body: ODD_LOT_TEXT.priceType });
            return;
        }
        // 信用條件：點下去當下的面板條件；不能用的一邊不送（不會改成現股）
        const { applies: creditOn, credit: clickCredit } = creditRef.current;
        const blocked = ruleBlockRef.current[action];
        if (blocked) {
            notify({ kind: 'err', title: '⚡ 閃電下單未送出', body: blocked });
            return;
        }
        const label = creditOn ? creditLabel(action, clickCredit.cond, clickCredit.daytradeShort) : undefined;
        const clickOrder = orderRef.current;
        const futures = capturedContract.security_type !== 'STK';
        const key = `${oddLot ? 'odd:' : ''}${action}:${price === null ? 'MKT' : keyOf(price)}`;
        if (inflightRef.current.has(key)) return; // double-click guard
        inflightRef.current.add(key);
        force();
        try {
            // 伺服器模式在點下去的當下（任何等待之前）就固定，送出前比對
            const serverMode = captureServerMode();
            // 信用檢查（與 K 線圖共用）：融資買進／融券賣出先看可否融資券（查詢失敗不擋，
            // 由券商端決定）；確認之後再重查；確認視窗跨日或換伺服器、現沖跨日都不送
            const gate = creditOn ? await prepareCreditOrder(capturedContract, action, clickCredit) : null;
            if (gate?.afterConfirm) {
                if (!isContextCurrent()) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
                if (!armedRef.current) throw new Error('閃電下單已鎖定，這筆沒有送出');
            }
            const trade = await placeQuickOrder(
                capturedContract,
                action,
                price,
                q,
                {
                    account: capturedAccount,
                    isAccountCurrent: stillPanelAccount(capturedAccount),
                    serverMode,
                    // 確認之後重新查可否融資券（不用快取）：確認期間變成 0 就不送；
                    // 查詢失敗照樣不擋（由券商端決定）
                    ...(gate?.afterConfirm ? { afterConfirm: gate.afterConfirm } : {}),
                    beforeSend: () => {
                        if (!isContextCurrent()) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
                        if (expiredNow()) throw new Error(CONTRACT_EXPIRED);
                        if (pausedRef.current) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
                        gate?.check();
                        // 確認期間合約更新（例如變成不可當沖）：照目前的規則再看一次
                        const nowBlocked = creditOn ? ruleBlockRef.current[action] : null;
                        if (nowBlocked) throw new Error(nowBlocked);
                        if (!accountMatches(accountRef.current, capturedAccount)) throw new Error('帳戶已變更，已停止後續下單');
                    },
                    ...(oddLot ? { orderLot: 'IntradayOdd' as const } : {}),
                    ...(creditOn ? { orderCond: clickCredit.cond, daytradeShort: clickCredit.daytradeShort } : {}),
                    // 委託條件：效期用於限價；期貨另帶倉別與市價鈕的價別
                    orderType: clickOrder.orderType,
                    ...(futures ? { ocType: clickOrder.octype ?? 'Auto', futuresPriceType: clickOrder.priceType } : {}),
                },
            );
            const conditions = quickOrderNote({
                market: price === null,
                futures,
                priceType: clickOrder.priceType,
                orderType: clickOrder.orderType,
                octype: clickOrder.octype,
            });
            notify({
                kind: 'ok',
                title: `⚡ ${oddLot ? '零股' : ''}${label ?? ''}${action === 'Buy' ? '買進' : '賣出'}已送出`,
                body: `${capturedContract.code} ${q}${oddLot ? ' 股' : ''} @ ${
                    price === null ? '市價' : fmtPrice(price)
                }${conditions ? ` · ${conditions}` : ''} (${trade.status.status})`,
            });
            onOrdersChangedRef.current?.();
        } catch (e) {
            if (accountChangedBeforeSend(e)) notifyAccountChangedBeforeSend();
            else notify({ kind: 'err', title: '⚡ 閃電下單失敗', body: e instanceof Error ? e.message : String(e) });
        } finally {
            inflightRef.current.delete(key);
            force();
        }
    }, [stillPanelAccount, captureContext]);

    const onCell = useCallback(
        (action: Action, price: number) => void send(action, price),
        [send],
    );

    // 刪單送出前再確認：期間面板暫停或連動、商品變了就不送（不撤到上一檔的委託）
    const cancelGuard = useCallback(() => {
        const isContextCurrent = captureContext();
        return () => { if (!isContextCurrent() || pausedRef.current) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE); };
    }, [captureContext]);

    const cancelAt = useCallback(async (action: Action, price: number) => {
        const capturedAccount = accountRef.current;
        if (!capturedAccount || pausedRef.current) return;
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
        const results = await cancelOrders(targets.map((t) => t.order.id), undefined, cancelGuard());
        const summary = cancellationSummary(results);
        notify({
            kind: summary.kind,
            title: '⚡ 刪單',
            body: `${code} @ ${fmtPrice(price)}：${summary.body}`,
        });
        onOrdersChangedRef.current?.();
    }, [cancelGuard]);

    const onCancelAt = useCallback(
        (action: Action, price: number) => void cancelAt(action, price),
        [cancelAt],
    );

    const cancelSymbol = useCallback(async () => {
        const capturedAccount = accountRef.current;
        if (!capturedAccount || pausedRef.current) return;
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
        const results = await cancelOrders(targets.map((t) => t.order.id), undefined, cancelGuard());
        const summary = cancellationSummary(results);
        notify({
            kind: summary.kind,
            title: '⚡ 全刪',
            body: `${code}：${summary.body}`,
        });
        onOrdersChangedRef.current?.();
    }, [cancelGuard]);

    const flatten = useCallback(async () => {
        const account = accountRef.current;
        if (!pos?.safeExit || !armedRef.current || !account) return;
        const key = `flatten:${account.account_type}:${account.broker_id}:${account.account_id}`;
        if (inflightRef.current.has(key)) return;
        inflightRef.current.add(key);
        const contract = contractRef.current;
        const isContextCurrent = captureContext();
        if (expiredNow() || pausedRef.current) {
            inflightRef.current.delete(key);
            notify({ kind: 'err', title: '⚡ 平倉未送出', body: CONTRACT_EXPIRED });
            return;
        }
        const beforeSend = () => {
            if (!isContextCurrent()) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
            if (expiredNow()) throw new Error(CONTRACT_EXPIRED);
            if (pausedRef.current) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
            if (!accountMatches(accountRef.current, account)) throw new Error('帳戶已變更，已停止後續下單');
        };
        const action = pos.net > 0 ? 'Sell' : 'Buy';
        try {
            if (account.account_type === 'S') {
                await placeStockExitByShares(contract, action, Math.abs(pos.net), account, { isAccountCurrent: stillPanelAccount(account), beforeSend });
            } else {
                await placeQuickOrder(contract, action, null, Math.abs(pos.net), { account, ocType: 'Cover', isAccountCurrent: stillPanelAccount(account), beforeSend });
            }
            notify({ kind: 'info', title: '⚡ 平倉已送出', body: '請以委託與成交回報確認結果' });
            onOrdersChangedRef.current?.();
        } catch (error) {
            if (accountChangedBeforeSend(error)) notifyAccountChangedBeforeSend();
            // 確定一筆都沒送出（例如確認期間伺服器模式變更）：照實說未送出
            else if ((error as { mutationNotStarted?: boolean } | null)?.mutationNotStarted) notify({ kind: 'err', title: '⚡ 平倉未成立（未送出或被券商拒絕）', body: error instanceof Error ? error.message : String(error) });
            else notify({ kind: 'err', title: '⚡ 平倉未完整確認', body: `可能已有部分委託送出或結果未知，請手動核對委託，勿直接重送。${error instanceof Error ? error.message : String(error)}` });
        } finally { inflightRef.current.delete(key); }
    }, [pos, stillPanelAccount, captureContext]);

    // ---- render ----

    // 畫面也用同一次 render 算出的啟用狀態：換商品／單位／連動的那一刻就顯示鎖定
    const armedView = armedRef.current;

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
    // rows are memo'd: keep the credit labels referentially stable
    const rowCredit = useMemo(() => ({ buy: buyCredit, sell: sellCredit }), [buyCredit, sellCredit]);
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
            {paused ? (
                <div className={styles.symbolRow}><span className={styles.symbolName}>{paused}</span></div>
            ) : (
            <div className={styles.symbolRow} title={symbolLabel.title}>
                <span className={styles.kindTag} data-testid='flash-kind'>
                    <b>{market === 'S' ? (odd ? '零股' : '整股') : isStockFuture(contract) ? '股期' : contract.security_type === 'OPT' ? '選擇權' : '期貨'}</b>
                    <i>{market === 'F' ? '口' : odd ? '股' : '張'}</i>
                </span>
                <span className={styles.symbolName}>{symbolLabel.name}</span>
                {creditTag && (
                    <span
                        className={styles.creditTag[creditBad ? 'bad' : 'ok']}
                        data-testid='flash-credit-tag'
                        data-bad={creditBad ? true : undefined}
                        title={creditBlocked ?? dayTradeBlocked ?? `這個面板的信用條件：${creditTag}`}
                    >
                        {creditTag}
                    </span>
                )}
                {orderTags.map(t => (
                    <span key={t} className={styles.creditTag.ok} data-testid='flash-order-tag' title={`這個面板的委託條件：${t}`}>{t}</span>
                ))}
                {symbolExtra}
                <span className={styles.symbolMeta}>{symbolLabel.meta}</span>
            </div>
            )}
            {!paused && showRef && (odd || isStockFuture(contract)) && (
                <FlashRefRow contract={contract} odd={odd} own={odd ? last : tradedLast} roundLot={tradedLast} />
            )}
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
                <span className={styles.unitAnchor}>
                    <button
                        type='button'
                        className={styles.unitBtn[menuShown ? 'open' : 'closed']}
                        aria-label='單位與委託條件'
                        aria-haspopup='menu'
                        aria-expanded={menuShown}
                        title={market === 'F'
                            ? `單位：口${orderTags.length ? `\n委託條件：${orderTags.join('・')}` : ''}`
                            : `單位：${odd ? '盤中零股（股）' : '整股（張）'}${creditApplies ? `\n信用：${creditTag || '現股'}` : '\n零股只能現股'}`}
                        ref={unitBtnRef}
                        onClick={() => {
                            const b = unitBtnRef.current;
                            if (b && Number.isFinite(b.offsetTop)) setMenuTop(b.offsetTop + b.offsetHeight + 4);
                            setMenuOpen(!menuOpen);
                        }}
                    >
                        {market === 'F' ? '口' : odd ? '股' : '張'}
                        {unitTag && <>·<b className={styles.unitCredit}>{unitTag}</b></>}
                        <ChevronDown size={9} aria-hidden />
                    </button>
                    {menuShown && (
                        <FlashQuickMenu
                            market={market}
                            odd={odd}
                            lot={lot}
                            credit={panelCredit}
                            order={panelOrder}
                            dayTradeOk={contract.day_trade === 'Yes'}
                            top={menuTop}
                            onCredit={next => { armedRef.current = false; setArmed(false); setPanelCredit(next); }}
                            onLot={next => { armedRef.current = false; setArmed(false); setPanelLot(next); }}
                            onOrder={next => { armedRef.current = false; setArmed(false); setPanelOrder(next); }}
                            onMore={() => openSettingsRef.current?.(menuTop)}
                            onClose={() => setMenuOpen(false)}
                        />
                    )}
                </span>
                <OrderSettingsButton
                    market={market}
                    settings={flashSettings}
                    onChange={next => {
                        if (next.lot !== lot) {
                            // 換單位一律先上鎖，股數與張數不能互換
                            armedRef.current = false;
                            setArmed(false);
                            setPanelLot(next.lot);
                            // 數量由新單位決定（記住的數量或 1），不把舊單位的數量寫進去
                            return;
                        }
                        setQty(next.qty);
                    }}
                    onSaveDefault={() => {
                        saveFlashOrderDefault(market, flashSettings);
                        defaultSnapshot.current![market] = flashSettings;
                        notify({ kind: 'info', title: '已設為閃電下單預設', body: `新開的${market === 'F' ? '期貨' : '股票'}閃電下單面板使用這組單位與數量；其他現有面板維持原設定，帳號不變。` });
                    }}
                    layout={{
                        title: '閃電下單設定',
                        scope: '只影響這個面板',
                        extraRows: settingsRows,
                        unit: market === 'S',
                        orderType: false,
                        octype: false,
                        defaultNote: `新開的${market === 'F' ? '期貨' : '股票'}閃電下單面板使用這組單位與數量（不含帳號）`,
                        qtyLabel: '閃電下單數量',
                        rememberQty: {
                            on: qtyMemory !== false,
                            text: qtyMemory === false ? '關閉：重新整理或換單位後數量回到 1' : `已記住：${flashQtyMemoryText(qtyMemory)}`,
                            note: '張、股、口各記一個數量，重新整理或重開後還原；關閉時清除',
                            onToggle: on => {
                                // 關閉時數量停在目前顯示的值；開啟時從目前數量開始記
                                setQtyEntry({ unit: unitKey, qty });
                                armedMemQty.current = undefined;
                                setQtyMemory(on ? withRememberedFlashQty({}, qtySlot, qty) : false);
                            },
                        },
                    }}
                    contractLabel={paused ?? (symbolLabel.name === contract.code ? contract.code : `${contract.code} ${symbolLabel.name}`)}
                    summary={flashOrderSummary(flashSettings, market, accountShort, { orderType: clickOrderType, octype: clickOctype, futuresPriceType: mktPriceType })}
                    ariaLabel='閃電下單設定'
                    onOpenChange={open => { settingsOpenRef.current = open; }}
                    align='panel'
                    // 股票面板的齒輪併進「張·融資」按鈕（更多設定…），窄面板不多佔一顆按鈕
                    hideTrigger
                    openRef={openSettingsRef}
                />
                <span className={styles.rowBreak} aria-hidden />
                <button
                    className={styles.armBtn[armedView ? 'on' : 'off']}
                    disabled={!live || !activeAccount || !!paused}
                    onClick={() => { armedAccountKey.current = accountKey; armedKey.current = armKey; armedMemQty.current = rememberedQty; setArmed(!armedView); }}
                >
                    {!live ? (
                        '⚠ 行情或交易狀態未連線'
                    ) : armedView ? (
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
                    className={`${styles.mktBtn.buy} ${armedView && !odd && !buyBlock ? '' : styles.disabledCell}`}
                    // 可否融資券的 0 只讓按鈕變淡、仍可點（點下去會重新查）；固定規則才停用
                    disabled={odd || !!ruleBlockRef.current.Buy}
                    data-blocked={buyBlock ? true : undefined}
                    title={odd ? ODD_LOT_TEXT.priceType : buyBlock ?? undefined}
                    onClick={() => void send('Buy', null)}
                >
                    {mktLabel}{buyCredit}買
                </button>
                <button
                    className={`${styles.mktBtn.sell} ${armedView && !odd && !sellBlock ? '' : styles.disabledCell}`}
                    disabled={odd || !!ruleBlockRef.current.Sell}
                    data-blocked={sellBlock ? true : undefined}
                    title={odd ? ODD_LOT_TEXT.priceType : sellBlock ?? undefined}
                    onClick={() => void send('Sell', null)}
                >
                    {mktLabel}{sellCredit}賣
                </button>
                {pos && !paused && (
                    <button
                        className={`${styles.flatBtn} ${armedView ? '' : styles.disabledCell}`}
                        title={pos.safeExit
                            ? market === 'S'
                                ? `平倉 ${maskMoney(fmtStockLots(Math.abs(pos.net)), privMoney)}（整張市價、零股以漲跌停價限價）`
                                : `市價平倉 ${maskMoney(String(Math.abs(pos.net)), privMoney)}`
                            : '持倉方向或交易條件不明，請使用持倉面板確認'}
                        disabled={!pos.safeExit || !armedView || !activeAccount}
                        onClick={() => void flatten()}
                    >
                        平倉
                    </button>
                )}
                <button
                    className={styles.cancelAllBtn}
                    disabled={!!paused || (workingCount === 0 && otherLotOrders === 0)}
                    onClick={() => void cancelSymbol()}
                >
                    全刪{workingCount > 0 && !paused ? ` ${workingCount}` : ''}
                </button>
            </div>
            {pos && !paused && (
                <div className={styles.posBar}>
                    <span className={pos.net > 0 ? styles.posLong : styles.posShort}
                        title={market === 'S' && !privMoney ? `${Math.abs(pos.net).toLocaleString()} 股（含零股）` : undefined}>
                        {pos.net > 0 ? '多' : '空'} {maskMoney(market === 'S' ? fmtStockLots(Math.abs(pos.net)) : String(Math.abs(pos.net)), privMoney)}
                    </span>
                    <span>@ {maskMoney(fmtPrice(pos.avg), privMoney)}</span>
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
            {odd && !paused && (
                <div className={styles.oddBanner} title='盤中零股與整股分開撮合，成交價可能與整股五檔不同'>
                    盤中零股 · 以股計 · 只限價 ROD · 僅現股；五檔與成交為零股行情（股）
                    {(panelCredit.cond !== 'Cash' || panelCredit.daytradeShort) && ' · 面板的信用條件在切回整股時恢復'}
                    {oddMatchTime && <span className={styles.oddMatchTime} title='盤中零股約每 5 秒撮合一次；五檔與成交價在撮合時更新'> · 最近撮合 {oddMatchTime}</span>}
                </div>
            )}
            {creditTag && !paused && (
                <div className={styles.creditBanner[creditBad ? 'bad' : 'ok']} data-testid='flash-credit-banner'>
                    {creditBad ? <Ban size={10} aria-hidden /> : credit.daytradeShort ? <Zap size={10} aria-hidden /> : null}
                    <span>
                        {creditBlocked ?? dayTradeBlocked ?? (credit.cond === 'MarginTrading'
                            ? '融資：點買＝融資買進，點賣＝融資賣出'
                            : sellOnly
                              ? `${creditName}：只能點賣（${creditName}賣出）；買進請改現股或融資`
                              : '現股當沖先賣：點賣為現沖賣出，當日需回補')}
                        {creditCheck === 'unknown' && ' · 無法確認可否融資券（不擋單，由券商端決定）'}
                        {creditCheck === 'loading' && ' · 確認可否融資券中…'}
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
                {(rows.length === 0 || paused) && (
                    <div className={styles.waiting}>{paused ?? '等待報價…'}</div>
                )}
                {!paused && rows.map((price) => {
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
                            armed={armedView}
                            buyBlock={buyBlock}
                            sellBlock={sellBlock}
                            credit={rowCredit}
                            compact={odd}
                            onCell={onCell}
                            onCancelAt={onCancelAt}
                        />
                    );
                })}
                {!paused && lastIdx === -1 && last !== null && rows.length > 0 && (
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
            {!paused && (
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
            )}
            <div className={styles.hint}>
                {armedView
                    ? odd
                        ? `點買量=零股限價買 ${qty} 股 · 點賣量=零股限價賣 · 點單量=刪單 · Esc 鎖定`
                        : `點買量=${buyBlock ? '停用' : `${buyCredit}限價買${orderSuffix}`} · 點賣量=${sellBlock ? '停用' : `${sellCredit}限價賣${orderSuffix}`} · 點單量=刪單 · Esc 鎖定`
                    : '安全鎖定中 — 點「啟用閃電下單」解鎖 · 滾輪捲動 · 雙擊置中'}
            </div>
        </div>
    );
}

// 價差對照列：零股面板＝零股成交價 − 整股成交價；個股期面板＝期貨 − 現股，
// 並提示 1 口對應幾張。用最近成交價，任一方沒有成交就顯示 —
function FlashRefRow({ contract, odd, own, roundLot }: { contract: ContractInfo; odd: boolean; own: number | null; roundLot: number | null }) {
    return odd
        ? <FlashRefLine contract={contract} odd own={own} base={roundLot} />
        : <FlashBasisRow contract={contract} own={own} />;
}

// 個股期：現股的最近成交價（即時成交，沒有就用快照）
function FlashBasisRow({ contract, own }: { contract: ContractInfo; own: number | null }) {
    const { quote, snapshot } = useDisplayBook(contract.underlying_code ?? '');
    const base = quote?.tick ? Number(quote.tick.close) : snapshot?.close || null;
    return <FlashRefLine contract={contract} odd={false} own={own} base={base} />;
}

function FlashRefLine({ contract, odd, own, base }: { contract: ContractInfo; odd: boolean; own: number | null; base: number | null }) {
    const s = spreadOf(own, base);
    const digits = base !== null && Math.abs(base) >= 500 ? 0 : undefined;
    const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
    return (
        <div className={styles.refRow} data-testid='flash-ref'>
            <span className={styles.refKey}>{odd ? '整股' : '現股'} <b>{base ? fmtPrice(base) : '—'}</b></span>
            <span className={styles.refKey}>
                {odd ? '整零差' : '期現差'}{' '}
                {s ? <b className={s.diff > 0 ? styles.refUp : s.diff < 0 ? styles.refDown : undefined}>{sign(s.diff)}{fmtPrice(Math.abs(s.diff), digits)} ({sign(s.pct)}{Math.abs(s.pct).toFixed(2)}%)</b> : <b>—</b>}
            </span>
            {!odd && <span className={styles.refKey}>{lotsPerContract(contract.multiplier)}</span>}
        </div>
    );
}
