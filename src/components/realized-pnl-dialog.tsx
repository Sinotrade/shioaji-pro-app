// src/components/realized-pnl-dialog.tsx — 歷史已實現損益：可選日期區間查詢，
// 摘要總額＋明細（股名、方向、數量（股）、價格、成本/手續費/交易稅、損益率、
// 已實現損益）。今日已實現損益卡片（bottom-dock-account.tsx）永遠鎖定當日，
// 這個 dialog 才是可選任意區間的歷史查詢（issue: historical realized P&L）。

import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ensureContract } from '../lib/contracts-cache';
import {
    fetchProfitLoss,
    fetchProfitLossSummary,
    type AccountSelector,
    type ProfitLoss,
} from '../lib/kgi';
import type { Account } from '../lib/types/portfolio';
import {
    fmtMoney,
    fmtPrice,
    fmtSigned,
    fmtStockLots,
} from '../lib/utils/format';
import { dateStrOffset } from '../lib/utils/kbars';
import * as panel from './panel.css';
import * as styles from './realized-pnl-dialog.css';

type AccountedPnl = ProfitLoss & { market: 'S' | 'F' };

function dirOfAmount(n: number): 'up' | 'down' | 'flat' {
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

const PRESETS: { label: string; days: number }[] = [
    { label: '今日', days: 0 },
    { label: '近7日', days: 6 },
    { label: '近30日', days: 29 },
    { label: '近90日', days: 89 },
];

export function RealizedPnlDialog({
    onClose,
    scopeAccount,
    hasFuturesAccount,
}: {
    onClose: () => void;
    scopeAccount: Account | null;
    hasFuturesAccount: boolean;
}) {
    const [start, setStart] = useState(() => dateStrOffset(6));
    const [end, setEnd] = useState(() => dateStrOffset(0));
    const [activePreset, setActivePreset] = useState<number | null>(6);
    const [rows, setRows] = useState<AccountedPnl[] | null>(null);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [names, setNames] = useState<Record<string, string>>({});

    const showStock = !scopeAccount || scopeAccount.account_type === 'S';
    const showFut =
        hasFuturesAccount &&
        (!scopeAccount || scopeAccount.account_type === 'F');

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const run = useCallback(async () => {
        if (start > end) {
            setError('起始日不可晚於結束日');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const markets: ('S' | 'F')[] = [];
            if (showStock) markets.push('S');
            if (showFut) markets.push('F');
            const nextRows: AccountedPnl[] = [];
            let nextTotal = 0;
            await Promise.all(
                markets.map(async (m) => {
                    const sel: AccountSelector | undefined =
                        scopeAccount && scopeAccount.account_type === m
                            ? {
                                  broker_id: scopeAccount.broker_id,
                                  account_id: scopeAccount.account_id,
                              }
                            : undefined;
                    const [list, sum] = await Promise.all([
                        fetchProfitLoss(m, sel, start, end).catch(
                            () => [] as ProfitLoss[],
                        ),
                        fetchProfitLossSummary(m, sel, start, end).catch(
                            () => null,
                        ),
                    ]);
                    for (const r of list) nextRows.push({ ...r, market: m });
                    const haveSum =
                        sum &&
                        (sum.total.pnl !== 0 || sum.profitloss_sum.length > 0);
                    nextTotal += haveSum
                        ? sum.total.pnl
                        : list.reduce((s, r) => s + r.pnl, 0);
                }),
            );
            nextRows.sort((a, b) =>
                a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
            );
            setRows(nextRows);
            setTotal(nextTotal);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setRows(null);
        } finally {
            setLoading(false);
        }
    }, [start, end, showStock, showFut, scopeAccount]);

    useEffect(() => {
        void run();
        // 只在開啟時自動查一次（預設近 7 日）；之後改區間要按「查詢」，
        // 避免每次調整日期輸入框都觸發一次請求
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 股名 lazy 解析：用共用 contracts-cache，不在這裡自建第二套查詢
    const codesKey = useMemo(
        () => [...new Set((rows ?? []).map((r) => r.code))].join(','),
        [rows],
    );
    useEffect(() => {
        const codes = codesKey ? codesKey.split(',') : [];
        if (codes.length === 0) return;
        let alive = true;
        void Promise.allSettled(
            codes.map((code) => ensureContract(code)),
        ).then((rs) => {
            if (!alive) return;
            setNames((prev) => {
                const next = { ...prev };
                for (const r of rs) {
                    if (r.status === 'fulfilled' && r.value.name) {
                        next[r.value.code] = r.value.name;
                    }
                }
                return next;
            });
        });
        return () => {
            alive = false;
        };
    }, [codesKey]);

    const applyPreset = (days: number) => {
        setActivePreset(days);
        setStart(dateStrOffset(days));
        setEnd(dateStrOffset(0));
    };

    return (
        <div
            className={styles.overlay}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className={styles.dialog}>
                <div className={styles.header}>
                    歷史已實現損益 Realized P&amp;L History
                    <button className={styles.closeBtn} onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>
                <div className={styles.toolbar}>
                    {PRESETS.map((p) => (
                        <button
                            key={p.days}
                            className={
                                styles.presetBtn[
                                    activePreset === p.days
                                        ? 'active'
                                        : 'normal'
                                ]
                            }
                            onClick={() => applyPreset(p.days)}
                        >
                            {p.label}
                        </button>
                    ))}
                    <span className={styles.dateLabel}>起</span>
                    <input
                        type='date'
                        className={styles.dateInput}
                        value={start}
                        max={end}
                        onChange={(e) => {
                            setActivePreset(null);
                            setStart(e.target.value);
                        }}
                    />
                    <span className={styles.dateLabel}>迄</span>
                    <input
                        type='date'
                        className={styles.dateInput}
                        value={end}
                        min={start}
                        max={dateStrOffset(0)}
                        onChange={(e) => {
                            setActivePreset(null);
                            setEnd(e.target.value);
                        }}
                    />
                    <span className={styles.spacer} />
                    <button
                        className={styles.queryBtn}
                        disabled={loading}
                        onClick={() => void run()}
                    >
                        {loading ? '查詢中…' : '查詢'}
                    </button>
                </div>
                <div className={styles.summaryBar}>
                    <span>
                        {start} ~ {end}
                    </span>
                    <span
                        className={`${styles.summaryTotal} ${panel.dirText[dirOfAmount(total)]}`}
                    >
                        {fmtSigned(total, 0)}
                    </span>
                    <span>{rows?.length ?? 0} 筆</span>
                </div>
                <div className={styles.body}>
                    {error ? (
                        <div className={styles.errorMsg}>{error}</div>
                    ) : rows === null ? (
                        <div className={styles.empty}>載入中…</div>
                    ) : rows.length === 0 ? (
                        <div className={styles.empty}>
                            此區間無已實現損益紀錄
                        </div>
                    ) : (
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th className={styles.th}>股票</th>
                                    <th className={styles.th}>日期</th>
                                    <th className={styles.th}>方向</th>
                                    <th className={styles.th}>數量</th>
                                    <th className={styles.th}>價格</th>
                                    <th className={styles.th}>成本</th>
                                    <th className={styles.th}>手續費</th>
                                    <th className={styles.th}>交易稅</th>
                                    <th className={styles.th}>損益率</th>
                                    <th className={styles.th}>已實現損益</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr
                                        key={`${r.market}-${r.id}-${'dseq' in r ? r.dseq : r.date}`}
                                    >
                                        <td className={styles.td}>
                                            <span
                                                className={styles.nameCell}
                                            >
                                                <span
                                                    className={
                                                        styles.nameCode
                                                    }
                                                >
                                                    {r.code}
                                                </span>
                                                <span
                                                    className={
                                                        styles.nameLabel
                                                    }
                                                >
                                                    {names[r.code] ?? ''}
                                                </span>
                                            </span>
                                        </td>
                                        <td className={styles.td}>
                                            {r.date}
                                        </td>
                                        <td
                                            className={`${styles.td} ${
                                                'direction' in r &&
                                                r.direction
                                                    ? panel.dirText[
                                                          r.direction ===
                                                          'Sell'
                                                              ? 'down'
                                                              : 'up'
                                                      ]
                                                    : ''
                                            }`}
                                        >
                                            {'direction' in r && r.direction
                                                ? r.direction === 'Sell'
                                                    ? '賣'
                                                    : '買'
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {r.market === 'S'
                                                ? fmtStockLots(
                                                      Math.abs(r.quantity),
                                                  )
                                                : `${Math.abs(r.quantity).toLocaleString()}口`}
                                        </td>
                                        <td className={styles.td}>
                                            {fmtPrice(
                                                'price' in r
                                                    ? r.price
                                                    : 'entry_price' in r
                                                      ? r.entry_price
                                                      : 0,
                                            )}
                                        </td>
                                        <td className={styles.td}>
                                            {'cost' in r && r.cost
                                                ? fmtMoney(r.cost)
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {'fee' in r && r.fee
                                                ? fmtMoney(r.fee)
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {'tax' in r && r.tax
                                                ? fmtMoney(r.tax)
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {'pr_ratio' in r
                                                ? `${r.pr_ratio.toFixed(2)}%`
                                                : '—'}
                                        </td>
                                        <td
                                            className={`${styles.td} ${panel.dirText[dirOfAmount(r.pnl)]}`}
                                        >
                                            {fmtSigned(r.pnl, 0)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
                <div className={styles.footer}>
                    <span>資料來源：KGI Account.RealizePL（明細）</span>
                    <span>
                        {showStock && showFut
                            ? '證券＋期貨'
                            : showStock
                              ? '證券'
                              : '期貨'}
                    </span>
                </div>
            </div>
        </div>
    );
}
