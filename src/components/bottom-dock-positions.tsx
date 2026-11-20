import { canTrade } from '../lib/account-tradable';
// src/components/bottom-dock-positions.tsx — 持倉 tab：響應式欄位、
// 分帳戶區段、批次市價平倉（arm-lock 防誤觸）

import { reconcileAfterUnknownOutcome } from '../lib/order-outcome';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTradingLive } from '../hooks/use-stream';
import { contractMarket } from '../lib/contract-market';
import { ensureContract } from '../lib/contracts-cache';
import { maskAccountId, maskMoney, secretMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
import { useServerInfo, yesterdayQuantityNotice } from '../lib/server-info-store';
import {
    notify,
    placeQuickOrder,
    placeStockExitByShares,
} from '../lib/trade';
import type { AccountedPosition } from '../lib/types/portfolio';
import {
    fmtInt,
    fmtPrice,
    fmtSigned,
    fmtStockLots,
} from '../lib/utils/format';
import { vars } from '../theme.css';
import { Orb } from './orb';
import { AsyncStatus } from './async-status';
import { AccountQueryFailure } from './account-query-failure';
import type { QueryFailure } from '../lib/trading-state';
import { UsPositionDetail } from './us-account-panels';
import * as panel from './panel.css';
import * as styles from './bottom-dock.css';
import {
    accountRefLabel,
    ArmLockButton,
    ConfirmButton,
    isStockPosition,
    positionAccountRef,
    positionMarket,
    refKey,
    useMeasuredWidth,
    sizeClassOf,
    type AccountFallback,
    type MarketFilter,
    type SizeClass,
    type ViewMode,
} from './bottom-dock-shared';
import { usLinkKey } from '../lib/contract-key';
import { decAdd, fmtDec, fmtUsPrice } from '../lib/us/decimal';
import { US_POSITIONS_UNAVAILABLE, type UsPositionsStatus } from '../lib/us/us-trading-state';
import {
    fmtUsPnl,
    usAccountGroupKey,
    usAmountDir,
    usPositionRowKey,
    UsTag,
    type UsPositionRow,
} from './bottom-dock-shared';

/** 美股（H 帳戶）庫存資料；dock 決定要不要給（null = 沒有 H 帳戶） */
export interface UsPositionsInput {
    positions: UsPositionRow[];
    status: UsPositionsStatus;
    error?: string | null;
    /** 庫存查詢版本（id 每次重新編號） */
    version?: number;
}

type SortMode = 'default' | 'value' | 'pnl' | 'code';

function posKey(p: AccountedPosition): string {
    const acc = p.account ? `${p.account.broker_id}-${p.account.account_id}` : '';
    return `${acc}:${p.code}:${p.direction}:${p.id}`;
}

// 排序用市值：last_price × quantity（期貨無乘數資訊，僅供同類相對排序）
function sortValue(p: AccountedPosition): number {
    return Math.abs(p.last_price * p.quantity);
}

function retPctOf(p: AccountedPosition): number {
    const sign = p.direction === 'Buy' ? 1 : -1;
    return p.price > 0
        ? ((p.last_price - p.price) / p.price) * 100 * sign
        : 0;
}

/** 美股群組損益小計（USD decimal 字串）；沒有可加總的值回 null */
function usGroupPnl(rows: UsPositionRow[]): string | null {
    let sum: string | null = null;
    for (const p of rows) {
        if (p.pnl === null || p.pnl === undefined) continue;
        sum = decAdd(sum ?? '0', p.pnl) ?? sum;
    }
    return sum;
}

interface PosGroup {
    key: string;
    label: string;
    rows: AccountedPosition[];
    /** 美股群組（每個 H 帳戶一組）；不和台股列混算小計 */
    usRows?: UsPositionRow[];
}

export function PositionsPane({
    positions,
    initialStatus,
    mode,
    market,
    scopeKey,
    fallback,
    onChanged,
    onSelectCode,
    us = null,
    failure = null,
    onRetry,
}: {
    positions: AccountedPosition[];
    /** 台股持倉查詢只因券商暫時性／未開放失敗（TKAP01 6044、503、AS400）：灰字＋重試 */
    failure?: QueryFailure | null;
    onRetry?: () => void;
    /** 美股庫存；併入同一張表，金額 USD、不和台幣相加。null = 不顯示 */
    us?: UsPositionsInput | null;
    initialStatus: 'loading' | 'failed' | 'ready';
    mode: ViewMode;
    market: MarketFilter;
    scopeKey: string; // '' = 全部帳戶
    fallback: AccountFallback;
    onChanged: () => void;
    onSelectCode: (code: string) => void;
}) {
    const { ref: measureRef, width } = useMeasuredWidth();
    const size = sizeClassOf(width);
    const live = useTradingLive();
    const yesterdayNotice = yesterdayQuantityNotice(useServerInfo());
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const [armed, setArmed] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    // 美股庫存列展開的取得批次明細（list_position_detail）
    const [usOpen, setUsOpen] = useState<ReadonlySet<string>>(new Set());
    const toggleUsOpen = (key: string) => setUsOpen(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const [busy, setBusy] = useState<{ done: number; total: number } | null>(
        null,
    );
    const [busyCode, setBusyCode] = useState<string | null>(null);
    const [sort, setSort] = useState<SortMode>('default');
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

    // scope（帳戶範圍）＋市場篩選
    const rows = useMemo(() => {
        return positions.filter((p) => {
            if (market !== 'all' && positionMarket(p) !== market) return false;
            if (scopeKey) {
                return refKey(positionAccountRef(p, fallback)) === scopeKey;
            }
            return true;
        });
    }, [positions, market, scopeKey, fallback]);

    const sortedRows = useMemo(() => {
        if (sort === 'default') return rows;
        const s = [...rows];
        if (sort === 'value') s.sort((a, b) => sortValue(b) - sortValue(a));
        else if (sort === 'pnl') s.sort((a, b) => b.pnl - a.pnl);
        else s.sort((a, b) => a.code.localeCompare(b.code));
        return s;
    }, [rows, sort]);

    // 美股列：只篩期貨或選了單一台股帳戶時不顯示
    const usVisible = !!us && market !== 'F' && !scopeKey;
    const usRows = useMemo<UsPositionRow[]>(() => {
        if (!us || !usVisible || us.status !== 'ready') return [];
        if (sort === 'code') return [...us.positions].sort((a, b) => a.code.localeCompare(b.code));
        return us.positions;
    }, [us, usVisible, sort]);
    const usNotice = !usVisible || !us ? null
        : us.status === 'unsupported' ? { err: false, text: US_POSITIONS_UNAVAILABLE }
        : us.status === 'error' ? { err: true, text: us.error ?? '美股庫存查詢失敗，請按更新重試' }
        : us.status !== 'ready' ? { err: false, text: '美股庫存查詢中…' }
        : null;

    const groups = useMemo<PosGroup[]>(() => {
        if (mode !== 'grouped') {
            return [{ key: '', label: '', rows: sortedRows, usRows }];
        }
        const map = new Map<string, PosGroup>();
        for (const p of sortedRows) {
            const ref = positionAccountRef(p, fallback);
            const key = refKey(ref) || `type-${positionMarket(p)}`;
            let g = map.get(key);
            if (!g) {
                g = { key, label: accountRefLabel(ref, priv), rows: [] };
                map.set(key, g);
            }
            g.rows.push(p);
        }
        for (const p of usRows) {
            const key = usAccountGroupKey(p.account);
            let g = map.get(key);
            if (!g) {
                g = { key, label: `[美] ${p.account.broker_id}-${maskAccountId(p.account.account_id, priv)}`, rows: [], usRows: [] };
                map.set(key, g);
            }
            g.usRows!.push(p);
        }
        return [...map.values()];
    }, [sortedRows, usRows, mode, fallback, priv]);

    // 股名 joined from the contract cache
    const [names, setNames] = useState<Record<string, string>>({});
    const codesKey = rows.map((p) => p.code).join(',');
    useEffect(() => {
        let alive = true;
        void Promise.allSettled(rows.map((p) => ensureContract(p.code))).then(
            (rs) => {
                if (!alive) return;
                const next: Record<string, string> = {};
                for (const r of rs) {
                    if (r.status === 'fulfilled' && r.value.name) {
                        next[r.value.code] = r.value.name;
                    }
                }
                setNames(next);
            },
        );
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);

    // 帳戶範圍/市場篩選切換時清空選取 — 被篩掉的列不能以隱形選取殘留，
    // 切回原篩選時也不該突然「還原」一批已勾選的倉位
    useEffect(() => {
        setSelected(new Set());
    }, [scopeKey, market]);

    // poll 更新後選取集合只保留仍存在的列
    const visibleKeys = useMemo(() => new Set(rows.map(posKey)), [rows]);
    const selCount = [...selected].filter((k) => visibleKeys.has(k)).length;

    const toggleSelect = (p: AccountedPosition) => {
        const key = posKey(p);
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };
    const allSelected = rows.length > 0 && selCount === rows.length;
    const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(rows.map(posKey)));
    };

    // 捕捉列本身的帳戶；不得以目前選取帳戶補猜持倉歸屬。
    const closeOne = async (p: AccountedPosition, mode2: 'close' | 'reverse') => {
        const account = p.account;
        if (!account || !canTrade(account) || !account.broker_id || !account.account_id || !['S', 'F'].includes(account.account_type)) {
            throw new Error('持倉帳戶歸屬不明，未送出委託');
        }
        if ((isStockPosition(p) ? 'S' : 'F') !== account.account_type) throw new Error('持倉單位與帳戶市場不符，未送出委託');
        if (!Number.isInteger(p.quantity) || p.quantity <= 0 || !['Buy', 'Sell'].includes(p.direction)) {
            throw new Error('持倉數量或方向不明，未送出委託');
        }
        if (isStockPosition(p) && (mode2 === 'reverse' || !('cond' in p) || p.cond !== 'Cash')) {
            throw new Error('股票反手或信用持倉請分開確認交易條件，未送出委託');
        }
        const contract = await ensureContract(p.code);
        if (contractMarket(contract.security_type) !== account.account_type) throw new Error('商品與持倉帳戶市場不符，未送出委託');
        const exit = p.direction === 'Buy' ? 'Sell' : 'Buy';
        if (isStockPosition(p)) {
            await placeStockExitByShares(contract, exit, p.quantity, account);
        } else {
            await placeQuickOrder(contract, exit, null, mode2 === 'reverse' ? p.quantity * 2 : p.quantity,
                { account, ocType: mode2 === 'reverse' ? 'Auto' : 'Cover' });
        }
        return { exit, qty: mode2 === 'reverse' ? p.quantity * 2 : p.quantity };
    };

    // 平/反 are one-click market orders on the whole position — locked by
    // default like 閃電下單 (issue #1: 存股族一秒反向很可怕)
    const act = async (p: AccountedPosition, mode2: 'close' | 'reverse') => {
        if (busyCode || busy) return;
        setBusyCode(p.code);
        try {
            const { exit, qty } = await closeOne(p, mode2);
            notify({
                kind: 'ok',
                title: mode2 === 'close' ? '⏹ 平倉單已送出' : '🔄 反手單已送出',
                // 平倉／反手量＝持倉數量：遮金額時不露，之後才開也會重遮（#268）
                body: `${p.code} 市價${exit === 'Buy' ? '買' : '賣'} ${secretMoney(
                    isStockPosition(p) ? fmtStockLots(qty) : `${qty} 口`,
                )}`,
            });
            onChanged();
        } catch (e) {
            // 確定一筆都沒送出（mutationNotStarted）就照實說未送出
            const notSent = (e as { mutationNotStarted?: boolean } | null)?.mutationNotStarted === true;
            notify({
                kind: 'err',
                title: mode2 === 'close' ? (notSent ? '平倉未成立（未送出或被券商拒絕）' : '平倉未完整確認') : (notSent ? '反手未成立（未送出或被券商拒絕）' : '反手未完整確認'),
                body: notSent ? (e instanceof Error ? e.message : String(e)) : `可能已有部分委託送出或結果未知，請手動核對，勿直接重送。${e instanceof Error ? e.message : String(e)}`,
            });
            if (!notSent) reconcileAfterUnknownOutcome();
        } finally {
            setBusyCode(null);
        }
    };

    // 批次市價平倉：逐筆送出（避免撞上游帳務 rate limit），完成回報筆數
    const runBatchClose = async () => {
        const targets = rows.filter((p) => selected.has(posKey(p)));
        if (targets.length === 0 || busy || busyCode) return;
        setBusy({ done: 0, total: targets.length });
        let ok = 0;
        let firstErr = '';
        for (const p of targets) {
            try {
                await closeOne(p, 'close');
                ok++;
            } catch (e) {
                if (!firstErr) {
                    firstErr = `${p.code}: ${e instanceof Error ? e.message : String(e)}`;
                }
            }
            setBusy((b) => (b ? { done: b.done + 1, total: b.total } : b));
        }
        setBusy(null);
        setSelected(new Set());
        const fail = targets.length - ok;
        notify({
            kind: fail > 0 ? 'err' : 'ok',
            title: '批次平倉請核對委託',
            body: `已送出 ${ok} 筆 / 未完整確認 ${fail} 筆；可能部分送出，勿直接重送${firstErr ? `｜${firstErr}` : ''}`,
        });
        if (fail > 0) reconcileAfterUnknownOutcome();
        onChanged();
    };

    const maxAbsPnl = Math.max(1, ...rows.map((p) => Math.abs(p.pnl)));

    const selectionCell = (p: AccountedPosition) => (
        <input
            type='checkbox'
            className={styles.chk}
            disabled={!armed || busy !== null}
            checked={selected.has(posKey(p))}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelect(p)}
            title={armed ? '選取加入批次平倉' : '批次平倉已鎖定 — 先解鎖'}
        />
    );

    // 美股列：股數、成本／市價／損益皆 USD decimal 字串；不參加平／反與批次平倉
    const usTableRow = (p: UsPositionRow, sz: SizeClass) => {
        const dir = usAmountDir(p.pnl);
        const rowKey = usPositionRowKey(p);
        const open = usOpen.has(rowKey);
        const detailId = Number(p.id);
        return (
            <Fragment key={rowKey}>
            <tr
                className={styles.clickableRow}
                onClick={() => onSelectCode(usLinkKey(p.code))}
                title='點擊連動圖表與下單面板（美股請由下單面板賣出）'
            >
                <td className={styles.td}>
                    {Number.isInteger(detailId) && (
                        <button
                            type='button'
                            className={styles.cancelBtn}
                            aria-expanded={open}
                            aria-label={open ? '收合庫存明細' : '展開庫存明細'}
                            title={open ? '收合庫存明細' : '展開庫存明細'}
                            onClick={e => { e.stopPropagation(); toggleUsOpen(rowKey); }}
                        >
                            {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                        </button>
                    )}
                </td>
                <td className={styles.td}>
                    {p.code}
                    <UsTag />
                </td>
                {sz === 'wide' && <td className={styles.td} />}
                <td className={`${styles.td} ${panel.dirText[p.direction === 'Buy' ? 'up' : 'down']}`}>
                    {sz === 'wide'
                        ? p.direction === 'Buy' ? '多 LONG' : '空 SHORT'
                        : p.direction === 'Buy' ? '多' : '空'}
                </td>
                <td className={`${styles.td} ${styles.qtyCell}`}>
                    {maskMoney(`${fmtDec(p.quantity)} 股`, privMoney)}
                </td>
                {sz === 'wide' && <td className={`${styles.td} ${styles.qtyCell}`}>—</td>}
                {sz === 'wide' && (
                    <td className={styles.td}>
                        {maskMoney(fmtUsPrice(p.price), privMoney)}
                    </td>
                )}
                <td className={styles.td}>
                    {fmtUsPrice(p.market_price)}
                </td>
                <td className={`${styles.td} ${panel.dirText[dir]}`}>
                    {maskMoney(fmtUsPnl(p.pnl), privMoney)}
                    {p.pnl !== null && p.pnl !== undefined && <span className={styles.usUnit}>USD</span>}
                </td>
                <td className={`${styles.td} ${panel.dirText[dir]}`}>
                    {p.pnl_pct === null || p.pnl_pct === undefined ? '—' : `${fmtUsPnl(p.pnl_pct)}%`}
                </td>
                {sz === 'wide' && <td className={styles.td} />}
                {sz === 'wide' && <td className={styles.td} />}
            </tr>
            {open && (
                <tr>
                    <td className={styles.td} />
                    <td className={styles.td} colSpan={sz === 'wide' ? 11 : 6}>
                        <UsPositionDetail account={p.account} detailId={detailId} code={p.code} version={us?.version ?? 0} />
                    </td>
                </tr>
            )}
            </Fragment>
        );
    };

    const usCard = (p: UsPositionRow) => {
        const dir = usAmountDir(p.pnl);
        return (
            <div
                key={usPositionRowKey(p)}
                className={styles.cardRow}
                onClick={() => onSelectCode(usLinkKey(p.code))}
                title='點擊連動圖表與下單面板'
            >
                <div className={styles.cardLine}>
                    <span className={styles.cardCode}>
                        {p.code}
                        <UsTag />
                    </span>
                    <span className={styles.dirBadge[p.direction === 'Buy' ? 'up' : 'down']}>
                        {p.direction === 'Buy' ? '多' : '空'}
                    </span>
                    <span className={styles.cardSpacer} />
                    <span className={styles.qtyCell}>
                        {maskMoney(`${fmtDec(p.quantity)} 股`, privMoney)}
                    </span>
                </div>
                <div className={styles.cardLine}>
                    <span className={styles.priceStack}>
                        <span>
                            <span className={styles.priceStackLabel}>現</span>
                            {fmtUsPrice(p.market_price)}
                        </span>
                        <span>
                            <span className={styles.priceStackLabel}>均</span>
                            {maskMoney(fmtUsPrice(p.price), privMoney)}
                        </span>
                    </span>
                    <span className={styles.cardSpacer} />
                    <span className={panel.dirText[dir]}>
                        {maskMoney(fmtUsPnl(p.pnl), privMoney)}
                        <span className={styles.usUnit}>USD</span>{' '}
                        {p.pnl_pct !== null && p.pnl_pct !== undefined && (
                            <span className={styles.sumSub}>({fmtUsPnl(p.pnl_pct)}%)</span>
                        )}
                    </span>
                </div>
            </div>
        );
    };

    const renderTable = (list: AccountedPosition[], sz: SizeClass, usList: UsPositionRow[] = []) => (
        <table className={styles.table}>
            <thead>
                <tr>
                    <th className={styles.th} style={{ width: '1.4rem' }}>
                        <input
                            type='checkbox'
                            className={styles.chk}
                            disabled={!armed || busy !== null}
                            checked={allSelected}
                            onChange={toggleAll}
                            title='全選（批次平倉）'
                        />
                    </th>
                    <th className={styles.th}>代碼</th>
                    {sz === 'wide' && <th className={styles.th}>名稱</th>}
                    <th className={styles.th}>方向</th>
                    <th className={styles.th}>數量</th>
                    {sz === 'wide' && <th className={styles.th}>昨餘</th>}
                    <th className={styles.th}>{sz === 'wide' ? '成本' : '現價'}</th>
                    {sz === 'wide' && <th className={styles.th}>現價</th>}
                    <th className={styles.th}>損益</th>
                    <th className={styles.th}>報酬率</th>
                    {sz === 'wide' && (
                        <th className={styles.th} style={{ width: '16%' }}>
                            損益分布
                        </th>
                    )}
                    {sz === 'wide' && (
                        <th className={styles.th}>
                            <ArmLockButton
                                armed={armed}
                                onToggle={() => setArmed((v) => !v)}
                                hint='平/反與批次平倉'
                            />
                        </th>
                    )}
                </tr>
            </thead>
            <tbody>
                {list.map((p) => {
                    const dir = p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : 'flat';
                    const retPct = retPctOf(p);
                    return (
                        <tr
                            key={posKey(p)}
                            className={styles.clickableRow}
                            onClick={() => onSelectCode(p.code)}
                            title='點擊連動圖表與下單面板'
                        >
                            <td
                                className={styles.td}
                                onClick={(e) => e.stopPropagation()}
                            >
                                {selectionCell(p)}
                            </td>
                            <td className={styles.td}>{p.code}</td>
                            {sz === 'wide' && (
                                <td className={styles.td}>
                                    {names[p.code] ?? ''}
                                </td>
                            )}
                            <td
                                className={`${styles.td} ${panel.dirText[p.direction === 'Buy' ? 'up' : 'down']}`}
                            >
                                {sz === 'wide'
                                    ? p.direction === 'Buy'
                                        ? '多 LONG'
                                        : '空 SHORT'
                                    : p.direction === 'Buy'
                                      ? '多'
                                      : '空'}
                            </td>
                            <td className={`${styles.td} ${styles.qtyCell}`}>
                                {maskMoney(
                                    isStockPosition(p)
                                        ? fmtStockLots(p.quantity)
                                        : fmtInt(p.quantity),
                                    privMoney,
                                )}
                            </td>
                            {sz === 'wide' && (
                                <td className={`${styles.td} ${styles.qtyCell}`} title={isStockPosition(p) ? yesterdayNotice : undefined}>
                                    {isStockPosition(p)
                                        ? yesterdayNotice ? '待確認' : maskMoney(
                                              fmtStockLots(p.yd_quantity),
                                              privMoney,
                                          )
                                        : '—'}
                                </td>
                            )}
                            {sz === 'wide' && (
                                <td className={styles.td}>
                                    {maskMoney(fmtPrice(p.price), privMoney)}
                                </td>
                            )}
                            <td className={styles.td}>
                                {fmtPrice(p.last_price)}
                            </td>
                            <td className={`${styles.td} ${panel.dirText[dir]}`}>
                                {maskMoney(fmtSigned(p.pnl, 0), privMoney)}
                            </td>
                            <td className={`${styles.td} ${panel.dirText[dir]}`}>
                                {retPct > 0 ? '+' : ''}
                                {retPct.toFixed(2)}%
                            </td>
                            {sz === 'wide' && (
                                <td className={styles.td}>
                                    <div className={styles.pnlBar}>
                                        <div
                                            className={styles.pnlFill}
                                            style={{
                                                left:
                                                    p.pnl >= 0
                                                        ? '50%'
                                                        : undefined,
                                                right:
                                                    p.pnl < 0
                                                        ? '50%'
                                                        : undefined,
                                                width: `${(Math.abs(p.pnl) / maxAbsPnl) * 50}%`,
                                                background:
                                                    p.pnl >= 0
                                                        ? vars.color.up
                                                        : vars.color.down,
                                            }}
                                        />
                                    </div>
                                </td>
                            )}
                            {sz === 'wide' && (
                                <td className={styles.td}>
                                    <button
                                        className={styles.cancelBtn}
                                        disabled={
                                            busyCode === p.code ||
                                            busy !== null ||
                                            !live ||
                                            !armed
                                        }
                                        title={
                                            !live
                                                ? '行情或交易狀態未連線，暫停下單'
                                                : !armed
                                                  ? '已鎖定 — 點表頭鎖頭解鎖平/反'
                                                  : '市價沖銷此倉位'
                                        }
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void act(p, 'close');
                                        }}
                                    >
                                        平
                                    </button>{' '}
                                    <button
                                        className={styles.cancelBtn}
                                        disabled={
                                            busyCode === p.code ||
                                            busy !== null ||
                                            !live ||
                                            !armed
                                        }
                                        title={
                                            !live
                                                ? '行情或交易狀態未連線，暫停下單'
                                                : !armed
                                                  ? '已鎖定 — 點表頭鎖頭解鎖平/反'
                                                  : '同帳戶市價反向兩倍（翻倉）'
                                        }
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void act(p, 'reverse');
                                        }}
                                    >
                                        反
                                    </button>
                                </td>
                            )}
                        </tr>
                    );
                })}
                {usList.map((p) => usTableRow(p, sz))}
            </tbody>
        </table>
    );

    // 窄版：兩行卡片式 row（代碼＋方向＋量 / 現價均價疊排＋損益率）
    const renderCards = (list: AccountedPosition[], usList: UsPositionRow[] = []) => (
        <div>
            {list.map((p) => {
                const dir = p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : 'flat';
                const retPct = retPctOf(p);
                return (
                    <div
                        key={posKey(p)}
                        className={styles.cardRow}
                        onClick={() => onSelectCode(p.code)}
                        title='點擊連動圖表與下單面板'
                    >
                        <div className={styles.cardLine}>
                            <span onClick={(e) => e.stopPropagation()}>
                                {selectionCell(p)}
                            </span>
                            <span className={styles.cardCode}>{p.code}</span>
                            <span className={styles.cardName}>
                                {names[p.code] ?? ''}
                            </span>
                            <span
                                className={
                                    styles.dirBadge[
                                        p.direction === 'Buy' ? 'up' : 'down'
                                    ]
                                }
                            >
                                {p.direction === 'Buy' ? '多' : '空'}
                            </span>
                            <span className={styles.cardSpacer} />
                            <span className={styles.qtyCell}>
                                {maskMoney(
                                    isStockPosition(p)
                                        ? fmtStockLots(p.quantity)
                                        : fmtInt(p.quantity),
                                    privMoney,
                                )}
                            </span>
                        </div>
                        <div className={styles.cardLine}>
                            <span className={styles.priceStack}>
                                <span>
                                    <span className={styles.priceStackLabel}>
                                        現
                                    </span>
                                    {fmtPrice(p.last_price)}
                                </span>
                                <span>
                                    <span className={styles.priceStackLabel}>
                                        均
                                    </span>
                                    {maskMoney(fmtPrice(p.price), privMoney)}
                                </span>
                            </span>
                            <span className={styles.cardSpacer} />
                            <span className={panel.dirText[dir]}>
                                {maskMoney(fmtSigned(p.pnl, 0), privMoney)}{' '}
                                <span className={styles.sumSub}>
                                    ({retPct > 0 ? '+' : ''}
                                    {retPct.toFixed(2)}%)
                                </span>
                            </span>
                        </div>
                    </div>
                );
            })}
            {usList.map(usCard)}
        </div>
    );

    const renderRows = (list: AccountedPosition[], usList: UsPositionRow[] = []) =>
        size === 'narrow' ? renderCards(list, usList) : renderTable(list, size, usList);

    const groupSubtotal = (g: PosGroup) => {
        const pnl = g.rows.reduce((s, p) => s + p.pnl, 0);
        const stockValue = g.rows
            .filter(isStockPosition)
            .reduce(
                (s, p) =>
                    s +
                    (p.direction === 'Sell' ? -1 : 1) *
                        p.last_price *
                        p.quantity,
                0,
            );
        const hasStock = g.rows.some(isStockPosition);
        return { pnl, stockValue, hasStock };
    };

    return (
        <div className={styles.dockBody} ref={measureRef}>
            <div className={styles.paneScroll}>
                {usNotice && (
                    <div className={`${styles.usNote} ${usNotice.err ? panel.statusText.err : ''}`} role='status'>
                        <UsTag />
                        {usNotice.text}
                    </div>
                )}
                {rows.length === 0 && usRows.length === 0 && initialStatus === 'loading' ? (
                    <div className={styles.emptyState}>
                        <AsyncStatus phase='loading' text='載入持倉…' />
                    </div>
                ) : rows.length === 0 && usRows.length === 0 && initialStatus === 'failed' ? (
                    <div className={styles.emptyState}>
                        {failure
                            ? <AccountQueryFailure what='持倉' error={failure.raw} kind={failure.kind} onRetry={() => onRetry?.()} />
                            : <AsyncStatus phase='error' text='持倉尚未確認，請更新' />}
                    </div>
                ) : rows.length === 0 && usRows.length === 0 ? (
                    <div className={styles.emptyState}>
                        <AsyncStatus phase='empty' text='NO OPEN POSITIONS · 無持倉' />
                    </div>
                ) : mode === 'grouped' ? (
                    groups.map((g) => {
                        const sub = groupSubtotal(g);
                        const dir =
                            sub.pnl > 0 ? 'up' : sub.pnl < 0 ? 'down' : 'flat';
                        const isCollapsed = collapsed.has(g.key);
                        return (
                            <div key={g.key}>
                                <button
                                    className={styles.groupHeader}
                                    onClick={() =>
                                        setCollapsed((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(g.key)) {
                                                next.delete(g.key);
                                            } else next.add(g.key);
                                            return next;
                                        })
                                    }
                                >
                                    {isCollapsed ? (
                                        <ChevronRight size={11} />
                                    ) : (
                                        <ChevronDown size={11} />
                                    )}
                                    <span className={styles.groupTitle}>
                                        {g.label}
                                    </span>
                                    {g.usRows ? (
                                        // 美股群組：損益以 USD 小計，不和台幣相加
                                        <>
                                            <span className={styles.groupStat}>
                                                {g.usRows.length} 筆
                                            </span>
                                            <span className={panel.dirText[usAmountDir(usGroupPnl(g.usRows))]}>
                                                {maskMoney(fmtUsPnl(usGroupPnl(g.usRows)), privMoney)}
                                                <span className={styles.usUnit}>USD</span>
                                            </span>
                                        </>
                                    ) : (<>
                                    <span className={styles.groupStat}>
                                        {g.rows.length} 筆
                                    </span>
                                    <span className={styles.groupStat}>
                                        市值{' '}
                                        {sub.hasStock
                                            ? maskMoney(
                                                  fmtInt(
                                                      Math.round(
                                                          sub.stockValue,
                                                      ),
                                                  ),
                                                  privMoney,
                                              )
                                            : '—'}
                                    </span>
                                    <span className={panel.dirText[dir]}>
                                        {maskMoney(
                                            fmtSigned(sub.pnl, 0),
                                            privMoney,
                                        )}
                                    </span>
                                    </>)}
                                    <span className={styles.groupSpacer} />
                                </button>
                                {!isCollapsed && renderRows(g.rows, g.usRows)}
                            </div>
                        );
                    })
                ) : (
                    renderRows(sortedRows, usRows)
                )}
            </div>
            <div className={styles.batchBar}>
                <ArmLockButton
                    armed={armed}
                    onToggle={() => setArmed((v) => !v)}
                    hint='批次平倉'
                />
                {size === 'narrow' && (
                    <input
                        type='checkbox'
                        className={styles.chk}
                        disabled={!armed || busy !== null}
                        checked={allSelected}
                        onChange={toggleAll}
                        title='全選（批次平倉）'
                    />
                )}
                <span>
                    已選{' '}
                    <span className={styles.batchCount}>{selCount}</span> 筆
                </span>
                <span>價格模式 市價</span>
                {busy ? (
                    <span className={styles.busyRow}>
                        <Orb size={12} variant='ring' />
                        平倉中 {busy.done}/{busy.total}
                    </span>
                ) : (
                    <ConfirmButton
                        label='平倉'
                        confirmLabel={`確認市價平倉 ${selCount} 筆？`}
                        disabled={
                            !armed ||
                            selCount === 0 ||
                            !live ||
                            busyCode !== null
                        }
                        title={
                            !live
                                ? '行情或交易狀態未連線，暫停下單'
                                : !armed
                                  ? '已鎖定 — 點鎖頭解鎖批次平倉'
                                  : `以市價沖銷已選 ${selCount} 筆持倉`
                        }
                        onConfirm={() => void runBatchClose()}
                    />
                )}
                <span className={styles.batchSpacer} />
                <select
                    className={styles.accountSelect}
                    title='排序'
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortMode)}
                >
                    <option value='default'>預設排序</option>
                    <option value='value'>市值</option>
                    <option value='pnl'>損益</option>
                    <option value='code'>代碼</option>
                </select>
            </div>
        </div>
    );
}
