// src/components/bottom-dock-positions.tsx — 持倉 tab：響應式欄位、
// 分帳戶區段、批次市價平倉（arm-lock 防誤觸）

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTradingLive } from '../hooks/use-stream';
import { ensureContract } from '../lib/contracts-cache';
import { maskMoney, usePrivacyMode, usePrivacyMoney } from '../lib/privacy';
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
    if (isStockPosition(p) && typeof p.pnl_pct === 'number') return p.pnl_pct;
    const sign = p.direction === 'Buy' ? 1 : -1;
    return p.price > 0
        ? ((p.last_price - p.price) / p.price) * 100 * sign
        : 0;
}

interface PosGroup {
    key: string;
    label: string;
    rows: AccountedPosition[];
}

export function PositionsPane({
    positions,
    mode,
    market,
    scopeKey,
    fallback,
    onChanged,
    onSelectCode,
}: {
    positions: AccountedPosition[];
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
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const [armed, setArmed] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
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

    const groups = useMemo<PosGroup[]>(() => {
        if (mode !== 'grouped') {
            return [{ key: '', label: '', rows: sortedRows }];
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
        return [...map.values()];
    }, [sortedRows, mode, fallback, priv]);

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

    // NOTE（已知限制）：平倉單經 placeQuickOrder/placeStockExitByShares 走
    // accountFor()，也就是「目前選中的證/期帳戶」。同類型多帳戶時，非選中
    // 帳戶的倉位會被路由到選中帳戶下單。現況一證一期沒有實害；若未來支援
    // 同類型多帳戶，需把 p.account 傳進下單層。
    const closeOne = async (p: AccountedPosition, mode2: 'close' | 'reverse') => {
        const contract = await ensureContract(p.code);
        const exit = p.direction === 'Buy' ? 'Sell' : 'Buy';
        const qty = mode2 === 'close' ? p.quantity : p.quantity * 2;
        if (isStockPosition(p)) {
            // shares → Common lots + IntradayOdd remainder
            await placeStockExitByShares(contract, exit, qty);
        } else {
            await placeQuickOrder(contract, exit, null, qty);
        }
        return { exit, qty };
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
                body: `${p.code} 市價${exit === 'Buy' ? '買' : '賣'} ${
                    isStockPosition(p) ? fmtStockLots(qty) : `${qty} 口`
                }`,
            });
            onChanged();
        } catch (e) {
            notify({
                kind: 'err',
                title: mode2 === 'close' ? '平倉失敗' : '反手失敗',
                body: e instanceof Error ? e.message : String(e),
            });
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
            title: '批次平倉完成',
            body: `成功 ${ok} 筆 / 失敗 ${fail} 筆${firstErr ? `｜${firstErr}` : ''}`,
        });
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

    const renderTable = (list: AccountedPosition[], sz: SizeClass) => (
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
                                    {isStockPosition(p) && p.name
                                        ? p.name
                                        : names[p.code] ?? ''}
                                </td>
                            )}
                            <td
                                className={`${styles.td} ${panel.dirText[p.direction === 'Buy' ? 'up' : 'down']}`}
                            >
                                {sz === 'wide'
                                    ? `${p.direction === 'Buy' ? '多 LONG' : '空 SHORT'}${
                                          isStockPosition(p) && p.position_type_label
                                              ? ` / ${p.position_type_label}`
                                              : ''
                                      }`
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
                                <td className={`${styles.td} ${styles.qtyCell}`}>
                                    {isStockPosition(p)
                                        ? maskMoney(
                                              fmtStockLots(p.yd_quantity),
                                              privMoney,
                                          )
                                        : '—'}
                                </td>
                            )}
                            {sz === 'wide' && (
                                <td className={styles.td}>
                                    {fmtPrice(p.price)}
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
                                                ? '行情未連線，暫停下單'
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
                                                ? '行情未連線，暫停下單'
                                                : !armed
                                                  ? '已鎖定 — 點表頭鎖頭解鎖平/反'
                                                  : '市價反向兩倍（翻倉）'
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
            </tbody>
        </table>
    );

    // 窄版：兩行卡片式 row（代碼＋方向＋量 / 現價均價疊排＋損益率）
    const renderCards = (list: AccountedPosition[]) => (
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
                                {isStockPosition(p) && p.name
                                    ? p.name
                                    : names[p.code] ?? ''}
                            </span>
                            <span
                                className={
                                    styles.dirBadge[
                                        p.direction === 'Buy' ? 'up' : 'down'
                                    ]
                                }
                            >
                                {p.direction === 'Buy' ? '多' : '空'}
                                {isStockPosition(p) && p.position_type_label
                                    ? `/${p.position_type_label}`
                                    : ''}
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
                                    {fmtPrice(p.price)}
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
        </div>
    );

    const renderRows = (list: AccountedPosition[]) =>
        size === 'narrow' ? renderCards(list) : renderTable(list, size);

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
                {rows.length === 0 ? (
                    <div className={styles.emptyState}>
                        NO OPEN POSITIONS · 無持倉
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
                                    <span className={styles.groupSpacer} />
                                </button>
                                {!isCollapsed && renderRows(g.rows)}
                            </div>
                        );
                    })
                ) : (
                    renderRows(sortedRows)
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
                                ? '行情未連線，暫停下單'
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
