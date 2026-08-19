import { Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { primeContract } from '../lib/contracts-cache';
import {
    fetchFutures,
    fetchSnapshots,
} from '../lib/kgi';
import { loadStockCatalog, type StockMeta } from '../lib/stock-index';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice, fmtSigned } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './derivative-explorer.css';
import { UnderlyingPicker } from './underlying-picker';
import { Orb } from './orb';

const STOCK_FUTURE_UNDERLYING = 'sj-pro-stock-future-underlying';

function aliasRank(contract: ContractInfo) {
    if (contract.code.endsWith('R1')) return 0;
    if (contract.code.endsWith('R2')) return 1;
    return 2;
}

export function StockFuturesPanel({
    onPick,
    onAdd,
}: {
    onPick: (code: string) => void;
    onAdd: (contract: ContractInfo) => Promise<unknown>;
}) {
    const [underlying, setUnderlying] = useState<StockMeta | null>(null);
    const [contracts, setContracts] = useState<ContractInfo[]>([]);
    const [snapshots, setSnapshots] = useState<Map<string, Snapshot>>(new Map());
    const [mode, setMode] = useState<'continuous' | 'all'>('continuous');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        loadStockCatalog()
            .then((catalog) => {
                const saved = localStorage.getItem(STOCK_FUTURE_UNDERLYING);
                setUnderlying(
                    catalog.find((stock) => stock.code === saved) ??
                        catalog.find((stock) => stock.code === '2330') ??
                        catalog[0] ??
                        null,
                );
            })
            .catch(() => setError(true));
    }, []);

    useEffect(() => {
        if (!underlying) return;
        setLoading(true);
        setError(false);
        fetchFutures({ underlyingCode: underlying.code })
            .then((rows) => setContracts(rows))
            .catch(() => {
                setContracts([]);
                setError(true);
            })
            .finally(() => setLoading(false));
    }, [underlying]);

    const visible = useMemo(() => {
        const rows =
            mode === 'continuous'
                ? contracts.filter((contract) => /R[12]$/.test(contract.code))
                : contracts.filter((contract) => !/R[12]$/.test(contract.code));
        return [...rows].sort(
            (a, b) =>
                (a.root ?? '').localeCompare(b.root ?? '') ||
                aliasRank(a) - aliasRank(b) ||
                (a.delivery_month ?? '').localeCompare(b.delivery_month ?? ''),
        );
    }, [contracts, mode]);

    const visibleKey = visible.map((contract) => contract.code).join(',');
    const refresh = useCallback(async () => {
        if (!visibleKey) {
            setSnapshots(new Map());
            return;
        }
        try {
            const rows = await fetchSnapshots(visible.slice(0, 40));
            setSnapshots(new Map(rows.map((row) => [row.code, row])));
        } catch {
            // Keep the latest successful quote set.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleKey]);

    useEffect(() => {
        void refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
    }, [refresh]);

    const roots = new Set(contracts.map((contract) => contract.root).filter(Boolean));

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                <UnderlyingPicker
                    value={underlying}
                    onChange={(stock) => {
                        setUnderlying(stock);
                        localStorage.setItem(STOCK_FUTURE_UNDERLYING, stock.code);
                    }}
                />
                <button
                    className={styles.segment[mode === 'continuous' ? 'on' : 'off']}
                    onClick={() => setMode('continuous')}
                >
                    近月／次月
                </button>
                <button
                    className={styles.segment[mode === 'all' ? 'on' : 'off']}
                    onClick={() => setMode('all')}
                >
                    全月份
                </button>
            </div>
            <div className={styles.summary}>
                <span className={styles.summaryStrong}>
                    {underlying ? `${underlying.code} ${underlying.name}` : '—'}
                </span>
                <span>{roots.size} 種規格</span>
                <span>{visible.length} 口合約可選</span>
            </div>
            {loading ? (
                <div className={styles.empty}>
                    <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    載入個股期合約…
                </div>
            ) : error ? (
                <div className={styles.error}>個股期合約載入失敗</div>
            ) : visible.length === 0 ? (
                <div className={styles.empty}>此標的目前沒有個股期</div>
            ) : (
                <div className={styles.scroll}>
                    <table className={styles.table}>
                        <colgroup>
                            <col style={{ width: '31%' }} />
                            <col style={{ width: '13%' }} />
                            <col style={{ width: '16%' }} />
                            <col style={{ width: '16%' }} />
                            <col style={{ width: '14%' }} />
                            <col style={{ width: '34px' }} />
                        </colgroup>
                        <thead>
                            <tr>
                                <th className={styles.thLeft}>合約</th>
                                <th className={styles.th}>月份</th>
                                <th className={styles.th}>成交</th>
                                <th className={styles.th}>漲跌</th>
                                <th className={styles.th}>乘數</th>
                                <th className={styles.th} aria-label='加入自選' />
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((contract) => {
                                const quote = snapshots.get(contract.code);
                                const direction = quote
                                    ? quote.change_price > 0
                                        ? 'up'
                                        : quote.change_price < 0
                                          ? 'down'
                                          : 'flat'
                                    : 'flat';
                                return (
                                    <tr
                                        key={contract.code}
                                        className={styles.row}
                                        title='連動此合約'
                                        onClick={() => {
                                            primeContract(contract);
                                            onPick(contract.code);
                                        }}
                                    >
                                        <td className={styles.tdLeft}>
                                            <strong>{contract.code}</strong>{' '}
                                            {/R1$/.test(contract.code) && (
                                                <span className={styles.badge}>近月</span>
                                            )}
                                            {/R2$/.test(contract.code) && (
                                                <span className={styles.badge}>次月</span>
                                            )}
                                            <span className={styles.contractName}>
                                                {contract.name}
                                            </span>
                                        </td>
                                        <td className={styles.td}>
                                            {contract.delivery_month ?? '—'}
                                        </td>
                                        <td className={`${styles.td} ${panel.dirText[direction]}`}>
                                            {quote ? fmtPrice(quote.close) : '—'}
                                        </td>
                                        <td className={`${styles.td} ${panel.dirText[direction]}`}>
                                            {quote ? fmtSigned(quote.change_price) : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {contract.multiplier?.toLocaleString() ?? '—'}
                                        </td>
                                        <td className={styles.td}>
                                            <button
                                                className={styles.iconButton}
                                                title='加入目前自選清單'
                                                aria-label={`將 ${contract.code} 加入自選`}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    void onAdd(contract)
                                                        .then(() =>
                                                            notify({
                                                                kind: 'ok',
                                                                title: '已加入自選',
                                                                body: `${contract.code} ${contract.name}`,
                                                            }),
                                                        )
                                                        .catch((error) =>
                                                            notify({
                                                                kind: 'err',
                                                                title: '加入自選失敗',
                                                                body:
                                                                    error instanceof Error
                                                                        ? error.message
                                                                        : String(error),
                                                            }),
                                                        );
                                                }}
                                            >
                                                <Star size={13} />
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

