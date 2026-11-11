import { canTrade } from '../lib/account-tradable';
import { reconcileAfterUnknownOutcome, reportOrderError } from '../lib/order-outcome';
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
import { Ban, ChevronDown, Crosshair, Locate, LocateFixed, Lock, Settings, ShieldCheck, Zap } from 'lucide-react';
import { useFlashLadder } from '../hooks/use-flash-ladder';
import { dayEnd, sessionEnd } from '../lib/conditional/session';
import { getConditionalSettings } from '../lib/conditional/settings';
import { clickCondition, DEFAULT_PROTECT, DEFAULT_TRIGGER_SEND, dragProblem, flashProtectPlan, flashProtectText, positionEffect,
    protectConditionProblem, protectEffect, triggerConditionProblem, triggerIntent, triggerKind, triggerSendOf, triggerSendText, type LadderMark } from '../lib/flash-trigger';
import type { TriggerValidity } from '../lib/trigger-engine';
import { flashAddTrigger, flashEnvIs, flashLastPrice, flashModifyTrigger, flashPlaceBracket, flashReadClose, flashReadHeld, flashRemoveTrigger, flashRestoreProtection, flashStopProtections } from '../lib/flash-conditional';
import { restoreAfterUnfilledClose, restoreTriggers, warnIfStillHeld, withFlattenLock } from '../lib/flash-flatten-restore';
import { FlashProtectStrip } from './flash-protect';
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
import { noteOrderTraceEntry } from '../lib/order-trace';
import { cancelOrders } from '../lib/shioaji';
import { getAliasFor } from '../lib/stream';
import { useTickBandsVersion } from '../lib/tick-bands';
import { notify, placeQuickOrder, placeStockExitByShares } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import { ACTIVE_ORDER_STATUSES, type Action, type FuturesOCType, type OrderType, type Trade } from '../lib/types/order';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import { fmtClock, fmtCompactInt, fmtInt, fmtPrice, fmtSigned, fmtStockLots } from '../lib/utils/format';
import { clampLotQuantity, CREDIT_TEXT, creditLabel, isOddLot, ODD_LOT_MAX_SHARES, ODD_LOT_TEXT } from '../lib/odd-lot';
import { triggerCreditFields, triggerCreditText } from '../lib/trigger-credit';
import { roundToTick, stepPrice } from '../lib/utils/ticksize';
import { contractMarket, isWarrantContract } from '../lib/contract-market';
import { WARRANT_FLASH_TEXT, warrantExitBySharesProblem, warrantMarketOrderBlock, warrantProtectProblem, warrantTriggerProblem } from '../lib/warrant-rules';
import { flashAccountLabels, flashSymbolLabel } from '../lib/flash-display';
import { flashQtyMemoryText, flashQtySlot, rememberedFlashQty, sanitizeFlashQtySetting, validFlashQty, withRememberedFlashQty, type FlashQtySetting } from '../lib/flash-qty-memory';
import { expiryTime, isStockFuture, lotsPerContract, spreadOf } from '../lib/flash-link';
import * as styles from './flash-order.css';
import { orderStatusWithNumber } from '../lib/order-status-label';
import { dayShortCoverRoom, flashOrderTotals, flashTotalsSince, flashWorkingOrders, sameContractMonth } from '../lib/flash-order-totals';
import { useStockOrderConditionsVersion } from '../lib/stock-order-conditions';
import { FlashTotalsRow } from './flash-totals-bar';

const ROW_H = 22; // must match row height in flash-order.css.ts
const EDGE = 2; // auto-recenter when last price gets this close to the edge

const keyOf = (p: number) => p.toFixed(2);
// #244 One rule for "this order is a chip on the ladder" — the chips and the
// cancel they trigger (cell click, 全刪 per side) must name the same orders,
// whoever placed them (this panel, the orders tab, iLeader).
const ladderSide = (t: Trade): 'buy' | 'sell' | null => t.order.action === 'Buy' ? 'buy' : t.order.action === 'Sell' ? 'sell' : null;
const ladderPrice = (t: Trade) => t.status.modified_price || t.order.price;
function onLadder(t: Trade, code: string, stockOddLot: boolean | null): boolean {
    return remainingWorkingOrderQuantity(t) > 0
        && (t.contract.code === code || getAliasFor(t.contract.code) === code)
        // stocks: only the shown unit (整股 or 零股, #204); null = not a stock
        && (stockOddLot === null || isOddLot(t.order.order_lot) === stockOddLot);
}
/** 委託合計與買全刪／賣全刪的範圍：同一實際月份（含連續月別名）、股票只算目前單位。
 * 合計的「未成交」與買／賣全刪的目標都從這裡加 flashWorkingOrders 產生 */
function totalsScope(c: ContractInfo, odd: boolean): (t: Trade) => boolean {
    const stock = contractMarket(c.security_type) === 'S';
    return t => sameContractMonth(t, c, getAliasFor) && (!stock || isOddLot(t.order.order_lot) === odd);
}
const FOLLOW_GLOBAL = '__follow__';
const ACCOUNT_CHANGED_DURING_CONFIRMATION = '確認期間帳戶已變更，請重新確認';
const CONTRACT_EXPIRED = '合約已到期，這筆沒有送出';
const REVERSE_TEXT = '自動停損停利開啟時不送反手單（數量大於持倉）；請先平倉，或關閉自動停損停利';
const NO_MARKS: LadderMark[] = [];

/** 觸價單的預設有效期：條件單設定的「本盤／今日」 */
function defaultValidity(futures: boolean, now = Date.now()): TriggerValidity {
    const market = futures ? 'futures' : 'stock';
    const type = getConditionalSettings().defaultValidity;
    return { type, until: type === 'session' ? sessionEnd(now, market) : dayEnd(now, market) };
}

/** Marks of one side and price, grouped as the ladder shows them. */
interface MarkGroup {
    side: 'buy' | 'sell';
    price: number;
    marks: LadderMark[];
}

const markQty = (ms: LadderMark[]) => ms.reduce((n, m) => n + m.quantity, 0);

function MarkChips({ side, price, marks, dragging, onMarkDown, onMarkClick, inline = false }: {
    /** a plain click (no drag): delete */
    onMarkClick: (g: MarkGroup) => void;
    /** in the 觸價 column (centred) instead of on the volume cell's edge */
    inline?: boolean;
    side: 'buy' | 'sell';
    price: number;
    marks: LadderMark[];
    dragging: boolean;
    onMarkDown: (g: MarkGroup, e: { button: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => void;
}) {
    const triggers = marks.filter(m => m.kind === 'trigger');
    const stops = marks.filter(m => m.kind === 'stop');
    const takes = marks.filter(m => m.kind === 'take');
    // the narrow 觸價 column with several kinds at one price: short labels
    // (quantities stay in the title), so every control stays reachable
    const crowded = inline && [triggers, stops, takes].filter(x => x.length > 0).length > 1;
    const trig = triggers.length > 0 && (
        <button
            type='button'
            key='t'
            data-testid='flash-trigger-mark'
            className={`${styles.mark[side === 'buy' ? 'triggerBuy' : 'triggerSell']} ${triggers.every(m => m.editable) ? '' : styles.markLocked} ${
                triggers.every(m => m.paused) ? styles.markPaused : ''} ${triggers.some(m => m.pending) ? styles.markPending : ''} ${dragging ? styles.markDragging : ''}`}
            title={triggers.map(m => m.title).join('\n')}
            onPointerDown={e => onMarkDown({ side, price, marks: triggers }, e)}
            // the click itself deletes (never the column's own place handler)
            onClick={e => { e.stopPropagation(); onMarkClick({ side, price, marks: triggers }); }}
        >
            {!crowded && (triggers.some(m => m.protects) ? <ShieldCheck size={8} aria-hidden /> : <Crosshair size={8} aria-hidden />)}
            {markQty(triggers)}
        </button>
    );
    const prot = (ms: LadderMark[], kind: 'stop' | 'take') => ms.length > 0 && (
        <span key={kind} data-testid={`flash-${kind}-mark`} className={`${styles.mark[kind]} ${ms.some(m => m.pending) ? styles.markPending : ''}`}
            title={ms.map(m => m.title).join('\n')} onClick={e => e.stopPropagation()}>
            {kind === 'stop' ? '損' : '利'}{crowded ? '' : markQty(ms)}
        </span>
    );
    // the trigger sits on the outer edge (buy: left, sell: right)
    const items = side === 'buy' ? [trig, prot(stops, 'stop'), prot(takes, 'take')] : [prot(stops, 'stop'), prot(takes, 'take'), trig];
    return <span className={inline ? `${styles.markSlotInline} ${crowded ? styles.markCrowded : ''}` : styles.markSlotSide[side]}>{items}</span>;
}

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
    /** trigger: place a 觸價單 at this price instead of a limit order */
    onCell: (action: Action, price: number, trigger: boolean) => void;
    onCancelAt: (action: Action, price: number) => void;
    /** #216 觸價單: outer 觸買／觸賣 columns (default) or Alt＋點 on the volume cells */
    layout: 'columns' | 'modifier';
    /** why triggers cannot be placed now (credit conditions), else null */
    trigBlock: string | null;
    /** which way a trigger at this price fires (from the traded price); null: unknown */
    trigDir: 'above' | 'below' | null;
    /** what a fired trigger sends, per side (same classification as placing it) */
    trigNote: { buy: string; sell: string };
    buyMarks: LadderMark[];
    sellMarks: LadderMark[];
    /** this row is where a dragged trigger would go */
    drop: 'ok' | 'bad' | null;
    dragSide: 'buy' | 'sell' | null;
    onMarkDown: (g: MarkGroup, e: { button: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => void;
    onMarkClick: (g: MarkGroup) => void;
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
    layout,
    trigBlock,
    trigDir,
    trigNote,
    buyMarks,
    sellMarks,
    drop,
    dragSide,
    onMarkDown,
    onMarkClick,
}: RowProps) {
    const vol = compact ? fmtCompactInt : fmtInt;
    const exact = (v: number | undefined) => (compact && v !== undefined && v >= 10_000 ? `${fmtInt(v)} 股` : undefined);
    const columns = layout === 'columns';
    const op = trigDir === 'above' ? '≥' : '≤';
    // a side the panel's credit condition cannot send is not a trigger side either
    const trigSideBlock = (side: 'buy' | 'sell') => trigBlock ?? (side === 'buy' ? buyBlock : sellBlock);
    const trigTitle = (side: 'buy' | 'sell') => !armed ? '先啟用閃電下單'
        : trigSideBlock(side) ?? (trigDir === null ? '尚未收到成交價，或此價等於成交價（會立刻觸發），不能掛觸價'
            : `觸價${side === 'buy' ? '買' : '賣'}：成交價 ${op} ${text} 時${trigNote[side]}（不是限價）`);
    const trigCell = (side: 'buy' | 'sell', marks: LadderMark[]) => (
        <div
            className={`${styles.trigCell} ${armed && !trigSideBlock(side) && trigDir !== null ? '' : styles.disabledCell}`}
            data-trigger={side}
            data-preview={armed && !trigSideBlock(side) && trigDir !== null ? `觸${op}` : ''}
            title={trigTitle(side)}
            onClick={() => onCell(side === 'buy' ? 'Buy' : 'Sell', price, true)}
        >
            {marks.length > 0 && <MarkChips inline side={side} price={price} marks={marks} dragging={dragSide === side} onMarkDown={onMarkDown} onMarkClick={onMarkClick} />}
        </div>
    );
    const altHint = (side: 'buy' | 'sell') => (!columns && armed && !trigBlock ? `\nAlt＋點＝觸價${side === 'buy' ? '買' : '賣'}（成交價 ${op} ${text}）` : '');
    return (
        <div className={`${styles.row[isLast ? 'last' : 'normal']} ${columns ? styles.cols7 : ''} ${drop ? styles.dropRow[drop] : ''}`}>
            {columns && trigCell('buy', buyMarks)}
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
                title={buyBlock ?? (!armed ? '先啟用閃電下單' : `${credit.buy}限價買 ${text}${altHint('buy')}`)}
                data-side='buy'
                data-blocked={buyBlock ? true : undefined}
                onClick={e => onCell('Buy', price, !columns && e.altKey)}
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
                {!columns && buyMarks.length > 0 && <MarkChips side='buy' price={price} marks={buyMarks} dragging={dragSide === 'buy'} onMarkDown={onMarkDown} onMarkClick={onMarkClick} />}
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
                title={sellBlock ?? (!armed ? '先啟用閃電下單' : `${credit.sell}限價賣 ${text}${altHint('sell')}`)}
                data-side='sell'
                data-blocked={sellBlock ? true : undefined}
                onClick={e => onCell('Sell', price, !columns && e.altKey)}
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
                {!columns && sellMarks.length > 0 && <MarkChips side='sell' price={price} marks={sellMarks} dragging={dragSide === 'sell'} onMarkDown={onMarkDown} onMarkClick={onMarkClick} />}
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
            {columns && trigCell('sell', sellMarks)}
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
    // 股票與權證走證券（S）；權證可能標成 WRT 或 STK（SDK 1.7 以前），以 contractMarket 判斷
    const market: FlashMarket = contractMarket(contract.security_type) === 'S' ? 'S' : 'F';
    // 權證：只有整張現股（不得零股、不適用信用），外國標的不收市價（docs/qa/warrant-rules.md）
    const warrant = isWarrantContract(contract);
    const warrantMarketBlock = warrantMarketOrderBlock(contract);
    // 外國標的權證不能自動停損停利（出場是市價單）；國內標的權證照現股整張附加
    const warrantProtectBlock = warrantProtectProblem(contract);
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
    // 權證同理：不得零股交易，固定整張；面板的單位設定不覆寫，換回股票時恢復
    const lot: FlashLot = market === 'F' || warrant ? 'Common' : panelLot;
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
    const creditApplies = market === 'S' && lot === 'Common' && !warrant;
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
    // 觸價單建立時看每一邊目前的停用原因（含已確定不可融資券）
    const sideBlockRef = useRef<Record<Action, string | null>>({ Buy: null, Sell: null });
    sideBlockRef.current = { Buy: sides.buy, Sell: sides.sell };
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
    // #216 自動停損停利與觸價後送出方式也是面板的條件：一變就解除點價
    const protect = panelOrder.protect ?? DEFAULT_PROTECT;
    const triggerSendSetting = panelOrder.triggerSend ?? DEFAULT_TRIGGER_SEND;
    const orderKey = `${clickOrderType}:${clickOctype ?? ''}:${mktPriceType}:${protect.on ? JSON.stringify(protect) : 'off'}:${JSON.stringify(triggerSendSetting)}:${panelOrder.triggerLayout ?? 'columns'}`;
    // 自動停損停利開啟但目前條件不能附加：點價不送（不會改成無保護送出）
    // 權證：只有整張現股（面板的信用設定不套用）；外國標的不能附加
    const protectBlock = protect.on
        ? warrant
            ? warrantProtectBlock
            : protectConditionProblem({ market, odd, creditCond: credit.cond, daytradeShort: credit.daytradeShort, octype: clickOctype })
        : null;
    // 觸價單帶建立當下的信用條件送出（#263：現股、融資、融券、現股當沖先賣；借券不支援）；
    // 每一邊另照面板規則（sides）；權證：整張現股，外國標的觸價後只能限價
    const triggerBlock = warrant
        ? warrantTriggerProblem(contract, { send: triggerSendSetting })
        : triggerConditionProblem({ market, creditCond: credit.cond, daytradeShort: credit.daytradeShort });
    const protectRef = useRef({ protect, block: protectBlock });
    protectRef.current = { protect, block: protectBlock };
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
    const triggerRef = useRef({ setting: triggerSendSetting, block: triggerBlock });
    triggerRef.current = { setting: triggerSendSetting, block: triggerBlock };

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
    // 連續月的實際月份（target_code）也算情境：換月（I6→J6）時等待中的送單／刪單中止
    const captureContext = useOrderContext(contract, `${contract.target_code ?? ''}:${lot}:${creditKey}:${orderKey}:${linkKey}:${paused ? 'paused' : ''}`);
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
            const side = ladderSide(t);
            if (!side || !onLadder(t, contract.code, market === 'S' ? odd : null)) continue;
            // HTTP status.order_quantity can be 0 (1.7.6) — use the shared
            // original-quantity rule.
            const key = keyOf(ladderPrice(t));
            const cur = m.get(key) ?? { buy: 0, sell: 0 };
            cur[side] += remainingWorkingOrderQuantity(t);
            m.set(key, cur);
        }
        return m;
    }, [trades, contract.code, market, odd]);

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

    // 委託合計（設定「顯示委託合計」，預設開）：只從委託與成交回報算，
    // 不經過持倉投影；範圍：面板帳戶、同一實際月份（含連續月別名）、目前單位、本交易日
    const showTotals = panelOrder.showTotals !== false;
    // 送單時記下的現沖先賣旗標（回報不帶）有新紀錄就重算
    const orderCondsVersion = useStockOrderConditionsVersion();
    const orderTotals = useMemo(() => showTotals
        ? flashOrderTotals(trades, totalsScope(contract, odd), market === 'S', flashTotalsSince(market === 'S'))
        : null, [showTotals, trades, contract, odd, market, orderCondsVersion]);
    // #403 今天還能用現股買進回補的當沖先賣（同一套回報算法）：觸買在這之內＝回補出場單
    const coverRoom = useMemo(() => market === 'S'
        ? dayShortCoverRoom(trades, totalsScope(contract, odd), flashTotalsSince(true))
        : 0, [trades, contract, odd, market, orderCondsVersion]);

    // 買全刪／賣全刪可刪的筆數＝合計裡「未成交」的那一組委託（cancelSide 用同一個函式選目標）
    const sideOrderCount = useMemo(() => {
        if (!showTotals) return { buy: 0, sell: 0 };
        const w = flashWorkingOrders(trades, totalsScope(contract, odd), flashTotalsSince(market === 'S'));
        return { buy: w.buy.length, sell: w.sell.length };
    }, [showTotals, trades, contract, odd, market]);

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

    // #216 持倉換成下單單位（整股：張；零股：股；期貨：口），判斷進場／減倉／反手
    const heldRef = useRef({ held: 0, exitSafe: false, coverRoom: 0 });
    heldRef.current = { held: pos ? (market === 'S' && !odd ? pos.net / 1000 : pos.net) : 0, exitSafe: !!pos?.safeExit, coverRoom };
    // 觸價方向只看真正的成交價（零股看零股成交），不拿參考價充數
    const triggerPriceRef = useRef<number | null>(null);
    triggerPriceRef.current = odd ? (oddQuote?.tick ? Number(oddQuote.tick.close) : null) : tradedLast;
    const lastTradeRef = useRef<number | null>(null);
    lastTradeRef.current = tradedLast;
    const ladder = useFlashLadder({ code: contract.code, odd, account: activeAccount }, market === 'F');
    // #216 觸價單與限價同時可點：外側觸買／觸賣欄（預設）或 Alt＋點買量／賣量
    const triggerLayout = panelOrder.triggerLayout ?? 'columns';
    const trigRef = triggerPriceRef.current;
    // the same entry / exit classification as placing it (QA 10/13: the
    // preview said 附停損停利 for what became a 停損 exit)
    const trigNoteFor = (action: Action): string => {
        const sendText = triggerSendText(triggerSendSetting, { market, odd, mktPriceType });
        // #263 the credit condition it will go out with (當沖先賣: sells only)
        const fields = creditApplies ? triggerCreditFields(credit, action) : {};
        const creditText = creditApplies ? triggerCreditText(fields) : '';
        const word = `${action === 'Buy' ? '買進' : '賣出'}${creditText ? `（${creditText}）` : ''}`;
        const held = heldRef.current;
        const q = Math.max(1, qty);
        const effect = positionEffect(held.held, action, q);
        const intent = triggerIntent({ market, octype: clickOctype, effect, exitSafe: held.exitSafe, action, qty: q, credit: fields, coverRoom: held.coverRoom });
        if (intent.role === 'exit') return `${sendText}${word}${market === 'S' && action === 'Buy' ? '回補' : '平倉'}（出場單，不附停損停利）`;
        const pEffect = protectEffect(effect, market, clickOctype);
        if (protect.on && !protectBlock && pEffect === 'reverse') return `${sendText}${word}（自動停損停利開啟時反手不送）`;
        return `${sendText}${word}${protect.on && !protectBlock && pEffect === 'open' ? '（附停損停利）' : ''}`;
    };
    const trigNoteBuy = trigNoteFor('Buy');
    const trigNoteSell = trigNoteFor('Sell');
    const trigNote = useMemo(() => ({ buy: trigNoteBuy, sell: trigNoteSell }), [trigNoteBuy, trigNoteSell]);
    const trigWord = triggerBlock ? (warrant ? '觸價停用（外國標的權證觸價後需限價）' : '觸價停用（借券）') : triggerLayout === 'columns' ? '點觸買／觸賣=觸價單' : 'Alt＋點=觸價單';
    const openProtectRef = useRef<(() => void) | null>(null);
    const ladderBackgroundRef = useRef(ladder.background);
    ladderBackgroundRef.current = ladder.background;


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
        const noMarket = price === null ? warrantMarketOrderBlock(capturedContract) : null;
        if (noMarket) {
            notify({ kind: 'err', title: '⚡ 閃電下單未送出', body: noMarket });
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
        const futures = contractMarket(capturedContract.security_type) !== 'S';
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
            const beforeSend = () => {
                if (!isContextCurrent()) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
                if (expiredNow()) throw new Error(CONTRACT_EXPIRED);
                if (pausedRef.current) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
                gate?.check();
                // 確認期間合約更新（例如變成不可當沖）：照目前的規則再看一次
                const nowBlocked = creditOn ? ruleBlockRef.current[action] : null;
                if (nowBlocked) throw new Error(nowBlocked);
                if (!accountMatches(accountRef.current, capturedAccount)) throw new Error('帳戶已變更，已停止後續下單');
            };
            // #216 自動停損停利：進場（開倉或加碼）附括號單；減倉照送不附；反手不送
            const prot = protectRef.current;
            // a 新倉 order always opens (a separate position): it gets protection
            const effectNow = () => protectEffect(positionEffect(heldRef.current.held, action, q), futures ? 'F' : 'S', clickOrder.octype);
            const effect = effectNow();
            // the position may change while the confirmation is open: with
            // protection on, a click is sent only as what it was judged to be
            const guarded = prot.protect.on ? () => {
                beforeSend();
                if (effectNow() !== effect) throw new Error('確認期間持倉已變動（進場／減倉判斷不同），這筆沒有送出，請重新確認');
            } : beforeSend;
            if (prot.protect.on && effect !== 'reduce') {
                if (prot.block) throw new Error(`${prot.block}（自動停損停利開啟中，這筆沒有送出）`);
                if (effect === 'reverse') throw new Error(REVERSE_TEXT);
                const refPrice = price ?? triggerPriceRef.current;
                if (!refPrice) throw new Error('尚未收到成交價，無法計算停損停利，這筆沒有送出');
                const background = ladderBackgroundRef.current;
                const result = await flashPlaceBracket({
                    contract: capturedContract,
                    account: capturedAccount,
                    action,
                    entry: price === null ? { type: 'MKT' } : { type: 'LMT', price },
                    plan: flashProtectPlan(prot.protect, q),
                    refPrice,
                    order: {
                        orderType: clickOrder.orderType,
                        ...(futures ? { octype: clickOrder.octype === 'New' ? 'New' as const : 'Auto' as const, futuresPriceType: clickOrder.priceType } : {}),
                        beforeSend: guarded,
                        isAccountCurrent: stillPanelAccount(capturedAccount),
                        serverMode,
                        confirmNote: `附自動停損停利（${flashProtectText(prot.protect)}${background ? '・背景執行' : ''}）`,
                    },
                });
                if (result === 'placed' || result === 'trigger') {
                    notify({
                        kind: 'ok',
                        title: `⚡ ${action === 'Buy' ? '買進' : '賣出'}已送出・附停損停利`,
                        body: `${capturedContract.code} ${q} @ ${price === null ? '市價' : fmtPrice(price)}・${flashProtectText(prot.protect)}（成交後依成交價計算）`,
                    });
                } else if (!result.error.startsWith('進場單已送出')) {
                    // nothing was sent (the entry-out case was already notified)
                    throw new Error(result.error);
                }
                onOrdersChangedRef.current?.();
                return;
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
                    beforeSend: guarded,
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
                }${conditions ? ` · ${conditions}` : ''}（${orderStatusWithNumber(trade)}）${
                    prot.protect.on ? ' · 減倉，未附加停損停利' : ''}`,
            });
            onOrdersChangedRef.current?.();
        } catch (e) {
            if (accountChangedBeforeSend(e)) notifyAccountChangedBeforeSend();
            else reportOrderError('⚡ 閃電下單', e, notify);
        } finally {
            inflightRef.current.delete(key);
            force();
        }
    }, [stillPanelAccount, captureContext]);

    // #216 觸價模式：在點的價位掛觸價單（不是限價）。方向由成交價決定；
    // 反向且數量在持倉內＝停損停利出場（不擋風控、期貨平倉；股票：現股賣出在
    // 現股持股內，或現股買進在今天待回補的當沖先賣內，#403），其他＝進場
    // 觸價單（觸發時套用風控）；自動停損停利開啟的進場附括號單
    const placeTriggerAt = useCallback(async (action: Action, price: number) => {
        const capturedAccount = accountRef.current;
        if (!armedRef.current || !capturedAccount) return;
        const capturedContract = contractRef.current;
        const fail = (body: string) => notify({ kind: 'err', title: '⚡ 觸價單未建立', body });
        if (pausedRef.current) return;
        if (expiredNow()) { fail(CONTRACT_EXPIRED); return; }
        const { setting, block } = triggerRef.current;
        if (block) { fail(block); return; }
        // #263 信用條件：點下去當下的面板條件寫進觸價單；不能用的一邊不掛（不改成現股）
        const { applies: creditOn, credit: clickCredit } = creditRef.current;
        const sideBlock = creditOn ? sideBlockRef.current[action] : null;
        if (sideBlock) { fail(sideBlock); return; }
        const creditFields = creditOn ? triggerCreditFields(clickCredit, action) : {};
        const condition = clickCondition(price, triggerPriceRef.current);
        if (condition !== 'above' && condition !== 'below') { fail(condition); return; }
        const oddLot = oddRef.current;
        const futures = contractMarket(capturedContract.security_type) !== 'S';
        const q = Math.max(1, qtyRef.current);
        const clickOrder = orderRef.current;
        const effect = positionEffect(heldRef.current.held, action, q);
        // #403 stocks: a cash buy within today's 當沖先賣 to cover, or a cash
        // sell within the shares held, is an exit (no opening-risk checks)
        const intent = triggerIntent({ market: futures ? 'F' : 'S', octype: clickOrder.octype, effect, exitSafe: heldRef.current.exitSafe,
            action, qty: q, credit: creditFields, coverRoom: heldRef.current.coverRoom });
        const send = triggerSendOf(setting, { market: futures ? 'F' : 'S', odd: oddLot, mktPriceType: clickOrder.priceType, action });
        const validity = defaultValidity(futures);
        const key = `trigger:${oddLot ? 'odd:' : ''}${action}:${keyOf(price)}`;
        if (inflightRef.current.has(key)) return;
        inflightRef.current.add(key);
        force();
        try {
            const prot = protectRef.current;
            const pEffect = protectEffect(effect, futures ? 'F' : 'S', clickOrder.octype);
            if (prot.protect.on && intent.role === 'entry' && pEffect !== 'reduce') {
                if (prot.block) { fail(`${prot.block}（自動停損停利開啟中）`); return; }
                if (pEffect === 'reverse') { fail(REVERSE_TEXT); return; }
                const result = await flashPlaceBracket({
                    contract: capturedContract,
                    account: capturedAccount,
                    action,
                    entry: { type: 'touch', price, condition, send: send ?? { type: 'MKT' }, validity },
                    plan: flashProtectPlan(prot.protect, q),
                    refPrice: price,
                    order: futures && clickOrder.octype === 'New' ? { octype: 'New' } : {},
                });
                if (typeof result === 'object') { fail(result.error); return; }
                // the window engine announces its own triggers; the background one does not
                if (ladderBackgroundRef.current) {
                    notify({ kind: 'info', title: '⚡ 觸價單已掛・附停損停利（背景執行）', body: `${capturedContract.code} 成交價 ${condition === 'above' ? '≥' : '≤'} ${fmtPrice(price)} → ${action === 'Buy' ? '買' : '賣'} ${q}・${flashProtectText(prot.protect)}` });
                }
                return;
            }
            await flashAddTrigger({
                code: capturedContract.code,
                condition,
                price,
                action,
                quantity: q,
                kind: triggerKind(condition, action),
                ...(intent.role === 'entry' ? { role: 'entry' as const } : {}),
                ...(intent.octype ? { octype: intent.octype } : {}),
                ...(oddLot ? { orderLot: 'IntradayOdd' as const } : {}),
                ...creditFields,
                ...(send ? { send } : {}),
                validity,
            }, capturedContract, capturedAccount);
        } finally {
            inflightRef.current.delete(key);
            force();
        }
    }, []);

    const onCell = useCallback(
        (action: Action, price: number, trigger: boolean) => void (trigger ? placeTriggerAt(action, price) : send(action, price)),
        [send, placeTriggerAt],
    );

    // #216 梯形上的觸價單：點一下刪除，拖曳到別的價位改觸發價
    const cancelMarks = useCallback(async (g: MarkGroup) => {
        const editable = g.marks.filter(m => m.editable);
        if (!editable.length) {
            notify({ kind: 'info', title: '⚡ 觸價單', body: g.marks[0]?.title.split('\n')[0] ?? '請到條件單面板處理' });
            return;
        }
        for (const m of editable) {
            try {
                await flashRemoveTrigger(m.id);
            } catch (e) {
                notify({ kind: 'err', title: '⚡ 觸價單刪除未確認', body: e instanceof Error ? e.message : String(e) });
                return;
            }
        }
        notify({ kind: 'info', title: '⚡ 已刪除觸價單', body: `${contractRef.current.code} @ ${fmtPrice(g.price)}・${markQty(editable)}` });
    }, []);

    const moveMarks = useCallback(async (g: MarkGroup, price: number) => {
        if (!armedRef.current) {
            notify({ kind: 'err', title: '⚡ 觸價單未改價', body: '先啟用閃電下單才能拖曳改價' });
            return;
        }
        for (const m of g.marks) {
            const problem = dragProblem(m, price, triggerPriceRef.current);
            if (problem) { notify({ kind: 'err', title: '⚡ 觸價單未改價', body: problem }); return; }
        }
        if (Math.abs(price - g.price) < 1e-9) return;
        for (const m of g.marks) {
            try {
                await flashModifyTrigger(m.id, { price });
            } catch (e) {
                notify({ kind: 'err', title: '⚡ 觸價單改價未完成', body: e instanceof Error ? e.message : String(e) });
                return;
            }
        }
        notify({ kind: 'ok', title: '⚡ 觸價單已改價', body: `${contractRef.current.code} ${fmtPrice(g.price)} → ${fmtPrice(price)}` });
    }, []);

    const [drag, setDrag] = useState<{ group: MarkGroup; over: number | null } | null>(null);
    // the click that ends a drag (or an Esc-cancelled drag) of THIS marker is not a delete
    const dragEnded = useRef<string | null>(null);
    const markKey = (g: MarkGroup) => `${g.side}:${keyOf(g.price)}`;
    const onMarkClick = useCallback((g: MarkGroup) => {
        if (dragEnded.current === markKey(g)) { dragEnded.current = null; return; }
        void cancelMarks(g);
    }, [cancelMarks]);
    const dragCleanupRef = useRef<(() => void) | null>(null);
    useEffect(() => () => dragCleanupRef.current?.(), []);
    const onMarkDown = useCallback((g: MarkGroup, e: { button: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragCleanupRef.current?.();
        dragEnded.current = null;
        const startY = e.clientY;
        let moved = false;
        const rowAt = (y: number): number | null => {
            const el = bodyRef.current;
            if (!el) return null;
            const idx = Math.floor((y - el.getBoundingClientRect().top) / ROW_H);
            return rowsRef.current[idx] ?? null;
        };
        const cleanup = () => {
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('keydown', esc, true);
            dragCleanupRef.current = null;
        };
        const move = (ev: { clientY: number }) => {
            if (!moved && Math.abs(ev.clientY - startY) < 4) return;
            moved = true;
            setDrag({ group: g, over: rowAt(ev.clientY) });
        };
        const up = (ev: { clientY: number }) => {
            cleanup();
            setDrag(null);
            // a plain click is the button's own click (deletes); only a drag moves
            if (!moved) return;
            dragEnded.current = markKey(g);
            const target = rowAt(ev.clientY);
            if (target !== null) void moveMarks(g, target);
        };
        // Esc ends the drag only (the ladder stays armed)
        const esc = (ev: KeyboardEvent) => {
            if (ev.key !== 'Escape') return;
            ev.preventDefault();
            cleanup();
            setDrag(null);
            if (moved) dragEnded.current = markKey(g);
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('keydown', esc, true);
        dragCleanupRef.current = cleanup;
    }, [cancelMarks, moveMarks]);

    // #216 平倉／全刪 的停損停利範圍：這個面板的帳戶＋商品＋單位
    // （股票平倉同時平整股與零股：兩種單位的保護都要取消，allUnits）
    const protectionScopeOf = (a: Account, allUnits = false) => {
        const c = contractRef.current;
        return { account: { account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id },
            codes: [c.code, c.target_code].filter((x): x is string => !!x), odd: allUnits && contractMarket(c.security_type) === 'S' ? null : oddRef.current };
    };

    // 刪單送出前再確認：期間面板暫停或連動、商品變了就不送（不撤到上一檔的委託）
    const cancelGuard = useCallback(() => {
        const isContextCurrent = captureContext();
        return () => { if (!isContextCurrent() || pausedRef.current) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE); };
    }, [captureContext]);

    const cancelAt = useCallback(async (action: Action, price: number) => {
        const capturedAccount = accountRef.current;
        if (!capturedAccount || pausedRef.current) return;
        const code = contractRef.current.code;
        // the chip's own orders (same rule as the chips): 只刪目前單位的委託，
        // 點 300 股的格子不可連帶刪掉同價的整股單（#204）
        const side = action === 'Buy' ? 'buy' : 'sell';
        const unit = contractMarket(contractRef.current.security_type) === 'S' ? oddRef.current : null;
        const targets = tradesRef.current.filter(
            (t) =>
                accountMatches((t as Trade & { account?: Account }).account ?? t.order.account, capturedAccount) &&
                ladderSide(t) === side && onLadder(t, code, unit) &&
                keyOf(ladderPrice(t)) === keyOf(price),
        );
        if (targets.length === 0) {
            // never a silent click: the chip was there, say why nothing was sent
            notify({ kind: 'err', title: '⚡ 刪單', body: `${code} @ ${fmtPrice(price)}：找不到這個價位可刪的委託（可能剛成交或已刪），沒有送出；請到委託分頁核對` });
            return;
        }
        noteOrderTraceEntry(targets.map((t) => t.order.id), 'flash cell');
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
        // the context is fixed at the click: a product switched meanwhile cancels nothing of it
        const guard = cancelGuard();
        // #216 全刪 also ends this product's 停損停利 (never while an exit is out)
        const stop = await flashStopProtections(protectionScopeOf(capturedAccount));
        const protectNote = stop.blocked.length
            ? `停損停利未取消：${stop.blocked.join('；')}，請到條件單面板處理`
            : stop.failed.length ? `停損停利取消未確認：${stop.failed.join('；')}` : stop.stopped ? `已取消停損停利 ${stop.stopped} 張` : '';
        if (protectNote) notify({ kind: stop.blocked.length || stop.failed.length ? 'err' : 'info', title: '⚡ 全刪・停損停利', body: `${code}：${protectNote}` });
        // both units of a stock (全刪), whoever placed the order
        const targets = tradesRef.current.filter(
            (t) =>
                accountMatches((t as Trade & { account?: Account }).account ?? t.order.account, capturedAccount) &&
                onLadder(t, code, null),
        );
        if (targets.length === 0) {
            if (!protectNote) notify({ kind: 'info', title: '⚡ 全刪', body: '沒有可刪的委託' });
            return;
        }
        noteOrderTraceEntry(targets.map((t) => t.order.id), 'flash 全刪');
        const results = await cancelOrders(targets.map((t) => t.order.id), undefined, guard);
        const summary = cancellationSummary(results);
        notify({
            kind: summary.kind,
            title: '⚡ 全刪',
            body: `${code}：${summary.body}`,
        });
        onOrdersChangedRef.current?.();
    }, [cancelGuard]);

    // 買全刪／賣全刪（點底部合計列的買單／賣單合計）：目標＝合計裡「未成交」的那組委託
    // （flashWorkingOrders：面板帳戶、同一實際月份、目前單位、本交易日，誰下的單都算 #244），只刪那一邊；
    // 不取消停損停利（那是「全刪」才做的）。閃電未啟用、暫停時不動作，同一邊送出中不重送
    const cancelSide = useCallback(async (side: 'buy' | 'sell') => {
        const capturedAccount = accountRef.current;
        if (!capturedAccount || pausedRef.current || !armedRef.current) return;
        const key = `cancel-side:${side}`;
        if (inflightRef.current.has(key)) return;
        inflightRef.current.add(key);
        try {
            const code = contractRef.current.code;
            // the context is fixed at the click: a product or account switched meanwhile cancels nothing
            const guard = cancelGuard();
            const c = contractRef.current;
            const title = side === 'buy' ? '⚡ 買全刪' : '⚡ 賣全刪';
            const targets = flashWorkingOrders(
                tradesRef.current.filter(t => accountMatches((t as Trade & { account?: Account }).account ?? t.order.account, capturedAccount)),
                totalsScope(c, oddRef.current), flashTotalsSince(contractMarket(c.security_type) === 'S'))[side];
            if (targets.length === 0) {
                notify({ kind: 'err', title, body: `${code}：找不到可刪的${side === 'buy' ? '買' : '賣'}單（可能剛成交或已刪），沒有送出；請到委託分頁核對` });
                return;
            }
            noteOrderTraceEntry(targets.map((t) => t.order.id), side === 'buy' ? 'flash 買全刪' : 'flash 賣全刪');
            const results = await cancelOrders(targets.map((t) => t.order.id), undefined, guard);
            const summary = cancellationSummary(results);
            notify({ kind: summary.kind, title, body: `${code}：${summary.body}` });
            onOrdersChangedRef.current?.();
        } finally { inflightRef.current.delete(key); }
    }, [cancelGuard]);
    const onCancelSide = useCallback((side: 'buy' | 'sell') => void cancelSide(side), [cancelSide]);

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
        const stock = account.account_type === 'S';
        // 權證（外國標的不收市價、沒有零股）：先確認能平倉，不能就不動停損停利
        const exitProblem = stock ? warrantExitBySharesProblem(contract, Math.abs(pos.net)) : null;
        if (exitProblem) {
            inflightRef.current.delete(key);
            notify({ kind: 'err', title: '⚡ 平倉未送出', body: `${exitProblem}；停損停利維持不變` });
            return;
        }
        const unit = stock ? '張' : '口';
        const codes = [contract.code, contract.target_code].filter((x): x is string => !!x);
        const net = pos.net;
        // one 平倉 of this account + product at a time (also across windows),
        // held until its unfilled-close check has finished
        // keyed by the tradable contract (TXFR1 → TXFJ6): an alias panel and a direct one share it
        const ran = await withFlattenLock(`${account.account_type}:${account.broker_id}:${account.account_id}:${contract.target_code || contract.code}`, async () => {
            let stop: Awaited<ReturnType<typeof flashStopProtections>> | null = null;
            // what an unfilled close puts back (futures only: a stock sell trigger without the shares could open a short)
            const restoreFor = () => (stop && !stock ? stop.restore : []);
            const watch = (readClose: () => Promise<{ final: boolean; filled: number } | null>) => {
                const group = `restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
                let n = 0;
                return restoreAfterUnfilledClose(net, restoreFor(), contract.code, unit, {
                    readClose,
                    readHeld: () => flashReadHeld(account, codes, false),
                    last: () => flashLastPrice(contract.code),
                    envOk: () => flashEnvIs(stop?.env),
                    // every restored protection its own OCO group (one firing never cancels another's legs)
                    restore: leg => flashRestoreProtection(restoreTriggers(leg, { code: contract.code, futures: true, odd: false,
                        group: `${group}-${++n}` }), contract, account),
                    notify,
                });
            };
            const stockWatch = () => (stop?.restore.length ? warnIfStillHeld(net, contract.code, { readHeld: () => flashReadHeld(account, codes, false), notify }) : Promise.resolve(false));
            try {
                // #216 停損停利 first: ended before the close goes out, so no exit can
                // fire on top of it; an exit that is out or unknown blocks the close
                stop = await flashStopProtections(protectionScopeOf(account, true));
                if (stop.blocked.length || stop.failed.length) {
                    notify({ kind: 'err', title: '⚡ 平倉未送出', body: stop.blocked.length
                        ? `${stop.blocked.join('；')}。為避免重複出場，這筆沒有送出；請到條件單面板處理後再平倉`
                        : `停損停利取消未確認（${stop.failed.join('；')}）。為避免重複出場，這筆沒有送出` });
                    // some were ended before another failed: those lots are unprotected now
                    if (stop.stopped > 0) {
                        notify({ kind: 'err', title: '⚡ 部分停損停利已取消（未受保護）', body: `${contract.code}：已取消 ${stop.stopped} 張停損停利、其他取消未確認，平倉沒有送出，已取消的保護沒有恢復。請到條件單面板確認，必要時重新設定停損停利` });
                    }
                    return;
                }
                let closeId: string | null = null;
                if (stock) {
                    await placeStockExitByShares(contract, action, Math.abs(net), account, { isAccountCurrent: stillPanelAccount(account), beforeSend });
                } else {
                    const trade = await placeQuickOrder(contract, action, null, Math.abs(net), { account, ocType: 'Cover', isAccountCurrent: stillPanelAccount(account), beforeSend });
                    closeId = trade?.order?.id ?? null;
                }
                // quantities in the product's unit (口／張／股), not a count of orders
                const lots = stop.restore.filter(r => !r.odd).reduce((n, r) => n + r.quantity, 0);
                const shares = stop.restore.filter(r => r.odd).reduce((n, r) => n + r.quantity, 0);
                const protectedText = stock && shares
                    ? `已先取消停損停利（${lots} 張、${shares} 股）；`
                    : lots > 0 ? `已先取消停損停利（${lots} ${unit}）；` : stop.stopped ? '已先取消停損停利；' : '';
                notify({ kind: 'info', title: '⚡ 平倉已送出', body: `${protectedText}請以委託與成交回報確認結果${
                    restoreFor().length ? '；若沒有成交，會對剩餘部位恢復停損停利' : stock && stop.restore.length ? '；股票的停損停利不會自動恢復' : ''}` });
                onOrdersChangedRef.current?.();
                if (stock) await stockWatch();
                else if (restoreFor().length) {
                    // the close may not fill (IOC): once it is final, put the protection back for what is still held
                    await watch(() => (closeId ? flashReadClose(account, closeId) : Promise.resolve(null)));
                }
            } catch (error) {
                const notStarted = !!(error as { mutationNotStarted?: boolean } | null)?.mutationNotStarted;
                if (accountChangedBeforeSend(error)) notifyAccountChangedBeforeSend();
                // 確定一筆都沒送出（例如確認期間伺服器模式變更）：照實說未送出
                else if (notStarted) notify({ kind: 'err', title: '⚡ 平倉未成立（未送出或被券商拒絕）', body: error instanceof Error ? error.message : String(error) });
                else {
                    notify({ kind: 'err', title: '⚡ 平倉未完整確認', body: `可能已有部分委託送出或結果未知，請手動核對委託，勿直接重送。${error instanceof Error ? error.message : String(error)}` });
                    reconcileAfterUnknownOutcome();
                }
                // protections were ended but the close did not go out (or was refused): put them back
                if (stop && (notStarted || accountChangedBeforeSend(error)) && stop.restore.length) {
                    if (stock) await stockWatch();
                    else await watch(() => Promise.resolve({ final: true, filled: 0 }));
                } else if (stop && stop.restore.length) {
                    notify({ kind: 'err', title: '⚡ 停損停利已取消（未受保護）', body: `${contract.code}：平倉結果不明，平倉前取消的停損停利沒有恢復。請到委託與持倉確認，必要時自行設定停損停利` });
                }
            }
        });
        try {
            if (!ran) notify({ kind: 'err', title: '⚡ 平倉未送出', body: '這個商品前一次平倉的結果還在確認中（可能在其他視窗），請稍候再試' });
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
                    <b>{market === 'S' ? (warrant ? '權證' : odd ? '零股' : '整股') : isStockFuture(contract) ? '股期' : contract.security_type === 'OPT' ? '選擇權' : '期貨'}</b>
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
                        className={styles.gearBtn[menuShown ? 'open' : 'closed']}
                        aria-label='單位與委託條件'
                        aria-haspopup='menu'
                        aria-expanded={menuShown}
                        data-testid='flash-settings'
                        data-unit={`${market === 'F' ? '口' : odd ? '股' : '張'}${unitTag ? `·${unitTag}` : ''}`}
                        title={`閃電下單設定：${warrant ? '委託條件、觸價、停損停利、記住數量、連動' : '單位、信用、委託條件、觸價、停損停利、記住數量、連動'}\n${market === 'F'
                            ? `單位：口${orderTags.length ? `・${orderTags.join('・')}` : ''}`
                            : `單位：${odd ? '盤中零股（股）' : '整股（張）'}${creditApplies ? `・信用：${creditTag || '現股'}` : warrant ? '・權證只能整張現股' : '・零股只能現股'}`}`}
                        ref={unitBtnRef}
                        onClick={() => {
                            const b = unitBtnRef.current;
                            if (b && Number.isFinite(b.offsetTop)) setMenuTop(b.offsetTop + b.offsetHeight + 4);
                            setMenuOpen(!menuOpen);
                        }}
                    >
                        <Settings size={12} aria-hidden />
                    </button>
                    {menuShown && (
                        <FlashQuickMenu
                            market={market}
                            odd={odd}
                            warrant={warrant}
                            lot={lot}
                            credit={panelCredit}
                            order={panelOrder}
                            dayTradeOk={contract.day_trade === 'Yes'}
                            top={menuTop}
                            onCredit={next => { armedRef.current = false; setArmed(false); setPanelCredit(next); }}
                            onLot={next => { armedRef.current = false; setArmed(false); setPanelLot(next); }}
                            onOrder={next => { armedRef.current = false; setArmed(false); setPanelOrder(next); }}
                            triggerSend={triggerSendSetting}
                            onTriggerSend={next => { armedRef.current = false; setArmed(false); setPanelOrder({ ...panelOrder, triggerSend: next }); }}
                            // 外國標的權證：觸價後市價停用（附原因），只能選限價
                            triggerMarketBlock={warrantMarketBlock ? WARRANT_FLASH_TEXT.foreignTriggerMenu : null}
                            showTotals={showTotals}
                            // 只是顯示：不改送出的委託，不解除點價下單
                            onShowTotals={next => { const { showTotals: _was, ...rest } = panelOrder; setPanelOrder(next ? rest : { ...rest, showTotals: false }); }}
                            triggerLayout={triggerLayout}
                            onTriggerLayout={next => { armedRef.current = false; setArmed(false); setPanelOrder({ ...panelOrder, triggerLayout: next }); }}
                            // 外國標的權證不能自動停損停利：收起入口並寫原因（已開著的面板仍可進去關掉）
                            onProtect={warrantProtectBlock && !protect.on ? undefined : () => openProtectRef.current?.()}
                            protectBlock={warrantProtectBlock}
                            onMore={() => openSettingsRef.current?.(menuTop)}
                            onClose={() => setMenuOpen(false)}
                        />
                    )}
                </span>
                <OrderSettingsButton
                    market={market}
                    settings={flashSettings}
                    onChange={next => {
                        if (next.lot !== lot && !warrant) {
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
                        unit: market === 'S' && !warrant,
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
            </div>
            <div className={styles.actionBar}>
                <button
                    className={`${styles.mktBtn.buy} ${armedView && !odd && !warrantMarketBlock && !buyBlock ? '' : styles.disabledCell} ${warrantMarketBlock ? styles.ruleLocked : ''}`}
                    // 可否融資券的 0 只讓按鈕變淡、仍可點（點下去會重新查）；固定規則才停用
                    disabled={odd || !!warrantMarketBlock || !!ruleBlockRef.current.Buy}
                    data-blocked={buyBlock ? true : undefined}
                    title={odd ? ODD_LOT_TEXT.priceType : warrantMarketBlock ?? buyBlock ?? `${mktLabel}${buyCredit}買`}
                    onClick={() => void send('Buy', null)}
                >
                    {warrantMarketBlock && <Lock size={10} aria-hidden className={styles.ruleLockIcon} />}
                    {mktLabel}{buyCredit}買
                </button>
                <button
                    className={`${styles.mktBtn.sell} ${armedView && !odd && !warrantMarketBlock && !sellBlock ? '' : styles.disabledCell} ${warrantMarketBlock ? styles.ruleLocked : ''}`}
                    disabled={odd || !!warrantMarketBlock || !!ruleBlockRef.current.Sell}
                    data-blocked={sellBlock ? true : undefined}
                    title={odd ? ODD_LOT_TEXT.priceType : warrantMarketBlock ?? sellBlock ?? `${mktLabel}${sellCredit}賣`}
                    onClick={() => void send('Sell', null)}
                >
                    {warrantMarketBlock && <Lock size={10} aria-hidden className={styles.ruleLockIcon} />}
                    {mktLabel}{sellCredit}賣
                </button>
                {/* #376 平倉／全刪／停損停利固定同一群：有沒有持倉、掛單數多長都不改變市價鈕的位置 */}
                <div className={styles.actionSecondary} data-testid='flash-action-secondary'>
                {/* #376 平倉一直占位：有沒有持倉，全刪都在同一個位置，不會按錯 */}
                <button
                    className={`${styles.flatBtn} ${pos && !paused && armedView ? '' : styles.disabledCell}`}
                    title={paused
                        ? paused
                        : !pos
                            ? '目前沒有持倉'
                            : pos.safeExit
                                ? market === 'S'
                                    ? `平倉 ${maskMoney(fmtStockLots(Math.abs(pos.net)), privMoney)}（整張市價、零股以漲跌停價限價）`
                                    : `市價平倉 ${maskMoney(String(Math.abs(pos.net)), privMoney)}`
                                : '持倉方向或交易條件不明，請使用持倉面板確認'}
                    disabled={!pos || !!paused || !pos.safeExit || !armedView || !activeAccount}
                    onClick={() => void flatten()}
                >
                    平倉
                </button>
                <button
                    className={styles.cancelAllBtn}
                    disabled={!!paused || (workingCount === 0 && otherLotOrders === 0 && ladder.protectedQty === 0)}
                    title={ladder.protectedQty > 0 ? '刪除這個商品的委託，並取消這個面板的停損停利' : undefined}
                    onClick={() => void cancelSymbol()}
                >
                    全刪{workingCount > 0 && !paused ? ` ${workingCount}` : ''}
                </button>
                {/* 外國標的權證不能停損停利：關著就不顯示；已開著的仍顯示（不符），讓使用者可以關掉 */}
                {!paused && (!warrantProtectBlock || protect.on) && (
                    <FlashProtectStrip
                        compact
                        openRef={openProtectRef}
                        protect={panelOrder.protect}
                        block={protectBlock}
                        protectedQty={ladder.protectedQty > 0 ? maskMoney(String(ladder.protectedQty), privMoney) : null}
                        background={ladder.background}
                        unit={market === 'F' ? '口' : odd ? '股' : '張'}
                        onChange={next => { armedRef.current = false; setArmed(false); setPanelOrder({ ...panelOrder, protect: next }); }}
                    />
                )}
                </div>
            </div>
            {warrantMarketBlock && !paused && (
                <div className={styles.creditBanner.ok} data-testid='flash-warrant-market' title={warrantMarketBlock}>
                    <Lock size={10} aria-hidden />
                    <span>{WARRANT_FLASH_TEXT.foreignMarket}</span>
                </div>
            )}
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
            <div className={`${styles.headRow} ${triggerLayout === 'columns' ? styles.cols7 : ''}`}>
                {triggerLayout === 'columns' && <span className={styles.headTrigger} title='點這一欄＝在該價掛觸價買單'>觸買</span>}
                <span>買單</span>
                <span>買量</span>
                <button
                    type='button'
                    className={styles.headPrice[follow ? 'on' : 'off']}
                    title={follow ? '自動跟隨現價中 — 點擊固定' : '已固定 — 點擊恢復跟隨'}
                    onClick={() => { if (follow) setFollow(false); else recenter(); }}
                >
                    {follow ? <LocateFixed size={10} aria-hidden /> : <Locate size={10} aria-hidden />}價格
                </button>
                <span>賣量</span>
                <span>賣單</span>
                {triggerLayout === 'columns' && <span className={styles.headTrigger} title='點這一欄＝在該價掛觸價賣單'>觸賣</span>}
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
                    const lm = ladder.marks.get(key);
                    const drop = drag && drag.over !== null && keyOf(drag.over) === key
                        ? (drag.group.marks.some(m => dragProblem(m, price, triggerPriceRef.current)) ? 'bad' as const : 'ok' as const) : null;
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
                            avgMark={pos !== null && !privMoney && key === pos.avgKey}
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
                            layout={triggerLayout}
                            trigBlock={triggerBlock}
                            trigDir={trigRef === null ? null : price > trigRef + 1e-9 ? 'above' : price < trigRef - 1e-9 ? 'below' : null}
                            trigNote={trigNote}
                            buyMarks={lm?.buy ?? NO_MARKS}
                            sellMarks={lm?.sell ?? NO_MARKS}
                            drop={drop}
                            dragSide={drag && keyOf(drag.group.price) === key ? drag.group.side : null}
                            onMarkDown={onMarkDown}
                            onMarkClick={onMarkClick}
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
            <>
            {/* 提示列一直佔固定一行高：提示出現／消失不改變梯子可用高度，否則 ResizeObserver
                重算列數、頂端價格位移一檔，游標下的價位會換掉（可能點錯價下單或刪單） */}
            <div className={styles.totalsRow} data-testid='flash-notices'>
                {display?.source === 'snapshot' && <span title={display.time}>快照一檔</span>}
                {odd && !oddQuote && <span title='尚未收到盤中零股行情；梯形暫以整股成交價置中'>等待零股行情</span>}
                {otherLotOrders > 0 && (
                    <span title={`梯形只顯示${odd ? '零股' : '整股'}委託；全刪會一併刪除`}>
                        另有{odd ? '整股' : '零股'}委託 {otherLotOrders} 筆
                    </span>
                )}
            </div>
            <FlashTotalsRow columns={triggerLayout === 'columns'} mine={orderTotals} sumBid={sumBid} sumAsk={sumAsk} odd={odd}
                unit={market === 'F' ? '口' : odd ? '股' : '張'} priv={privMoney}
                // 只有整股現股有當沖先賣；期貨、零股、權證的價格欄留空
                cover={market === 'S' && !odd && !warrant}
                cancel={{ armed: armedView, counts: sideOrderCount, onCancel: onCancelSide }} />
            </>
            )}
            <div className={styles.hint}>
                {armedView
                    ? odd
                        ? `點買量=零股限價買 ${qty} 股 · 點賣量=零股限價賣 · ${trigWord} · 點單量=刪單 · Esc 鎖定`
                        : `點買量=${buyBlock ? '停用' : `${buyCredit}限價買${orderSuffix}`} · 點賣量=${sellBlock ? '停用' : `${sellCredit}限價賣${orderSuffix}`}${
                            protect.on ? (protectBlock ? ' · 自動停損停利條件不符，進場不送' : ' · 進場附停損停利') : ''} · ${trigWord} · 點單量=刪單 · Esc 鎖定`
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
    const lots = odd ? '' : lotsPerContract(contract.multiplier);
    const baseText = base ? fmtPrice(base) : '—';
    const diffText = s ? `${sign(s.diff)}${fmtPrice(Math.abs(s.diff), digits)}` : '—';
    const pctText = s ? `(${sign(s.pct)}${Math.abs(s.pct).toFixed(2)}%)` : '';
    const kind = odd ? '整零差' : '期現差';
    return (
        <div className={styles.refRow} data-testid='flash-ref'
            title={`${odd ? '整股' : '現股'} ${baseText}　${kind} ${diffText}${pctText ? ` ${pctText}` : ''}${lots ? `　${lots}` : ''}`}>
            <span className={styles.refKey}>{odd ? '整股' : '現股'} <b>{baseText}</b></span>
            <span className={`${styles.refKey} ${styles.refDiff}`}>
                {kind}{' '}
                <b className={s ? s.diff > 0 ? styles.refUp : s.diff < 0 ? styles.refDown : undefined : undefined}>
                    {diffText}
                    {/* 個股期多一欄 1口=N張：窄面板先收百分比，全文在這一列的 tooltip */}
                    {pctText && <span className={odd ? undefined : styles.refPct}> {pctText}</span>}
                </b>
            </span>
            {lots && <span className={`${styles.refKey} ${styles.refLots}`} data-testid='flash-ref-lots'>{lots}</span>}
        </div>
    );
}
