import { Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ensureContract, primeContract } from '../lib/contracts-cache';
import { fetchSnapshots, fetchWarrants } from '../lib/kgi';
import { loadStockCatalog, type StockMeta } from '../lib/stock-index';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { todayStr } from '../lib/utils/date';
import { fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './derivative-explorer.css';
import { UnderlyingPicker } from './underlying-picker';
import { Orb } from './orb';

const WARRANT_UNDERLYING = 'sj-pro-warrant-underlying';

function daysUntil(date: string | undefined) {
    if (!date) return Infinity;
    const target = new Date(`${date}T00:00:00+08:00`).getTime();
    return Math.ceil((target - Date.now()) / 86400000);
}

function moneyness(contract: ContractInfo, spot: number | null) {
    if (!spot || !contract.strike_price) return Infinity;
    const distance =
        contract.call_put === 'P'
            ? spot - contract.strike_price
            : contract.strike_price - spot;
    return (distance / spot) * 100;
}

export function WarrantPanel({
    onPick,
    onAdd,
}: {
    onPick: (code: string) => void;
    onAdd: (contract: ContractInfo) => Promise<unknown>;
}) {
    const [underlying, setUnderlying] = useState<StockMeta | null>(null);
    const [contracts, setContracts] = useState<ContractInfo[]>([]);
    const [underlyingQuote, setUnderlyingQuote] = useState<Snapshot | null>(null);
    const [snapshots, setSnapshots] = useState<Map<string, Snapshot>>(new Map());
    const [right, setRight] = useState<'all' | 'C' | 'P'>('all');
    const [expiryDays, setExpiryDays] = useState(180);
    const [sort, setSort] = useState<'moneyness' | 'expiry'>('moneyness');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        loadStockCatalog()
            .then((catalog) => {
                const saved = localStorage.getItem(WARRANT_UNDERLYING);
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
        Promise.all([
            fetchWarrants(underlying.code, { expiryFrom: todayStr() }),
            ensureContract(underlying.code, 'STK')
                .then((contract) => fetchSnapshots([contract]))
                .then((rows) => rows[0] ?? null),
        ])
            .then(([rows, quote]) => {
                setContracts(rows);
                setUnderlyingQuote(quote);
            })
            .catch(() => {
                setContracts([]);
                setUnderlyingQuote(null);
                setError(true);
            })
            .finally(() => setLoading(false));
    }, [underlying]);

    const filtered = useMemo(() => {
        const spot = underlyingQuote?.close ?? null;
        return contracts
            .filter((contract) => right === 'all' || contract.call_put === right)
            .filter(
                (contract) =>
                    expiryDays === 0 || daysUntil(contract.expiry_date) <= expiryDays,
            )
            .sort((a, b) => {
                if (sort === 'expiry') {
                    return (
                        daysUntil(a.expiry_date) - daysUntil(b.expiry_date) ||
                        Math.abs(moneyness(a, spot)) - Math.abs(moneyness(b, spot))
                    );
                }
                return (
                    Math.abs(moneyness(a, spot)) - Math.abs(moneyness(b, spot)) ||
                    daysUntil(a.expiry_date) - daysUntil(b.expiry_date)
                );
            })
            .slice(0, 60);
    }, [contracts, expiryDays, right, sort, underlyingQuote]);

    const visibleKey = filtered.map((contract) => contract.code).join(',');
    const refresh = useCallback(async () => {
        if (!visibleKey) {
            setSnapshots(new Map());
            return;
        }
        try {
            const rows = await fetchSnapshots(filtered.slice(0, 60));
            setSnapshots(new Map(rows.map((row) => [row.code, row])));
        } catch {
            // Keep the latest successful quote set.
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleKey]);

    useEffect(() => {
        void refresh();
        const timer = setInterval(refresh, 8000);
        return () => clearInterval(timer);
    }, [refresh]);

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                <UnderlyingPicker
                    value={underlying}
                    onChange={(stock) => {
                        setUnderlying(stock);
                        localStorage.setItem(WARRANT_UNDERLYING, stock.code);
                    }}
                />
                {(['all', 'C', 'P'] as const).map((value) => (
                    <button
                        key={value}
                        className={styles.segment[right === value ? 'on' : 'off']}
                        onClick={() => setRight(value)}
                    >
                        {value === 'all' ? '全部' : value === 'C' ? '認購' : '認售'}
                    </button>
                ))}
                <select
                    className={styles.select}
                    value={expiryDays}
                    aria-label='到期區間'
                    onChange={(event) => setExpiryDays(Number(event.target.value))}
                >
                    <option value={90}>90 天內</option>
                    <option value={180}>180 天內</option>
                    <option value={365}>一年內</option>
                    <option value={0}>全部到期日</option>
                </select>
                <select
                    className={styles.select}
                    value={sort}
                    aria-label='權證排序'
                    onChange={(event) =>
                        setSort(event.target.value as 'moneyness' | 'expiry')
                    }
                >
                    <option value='moneyness'>價內外排序</option>
                    <option value='expiry'>到期日排序</option>
                </select>
            </div>
            <div className={styles.summary}>
                <span className={styles.summaryStrong}>
                    {underlying ? `${underlying.code} ${underlying.name}` : '—'}
                </span>
                <span>
                    現貨 {underlyingQuote ? fmtPrice(underlyingQuote.close) : '—'}
                </span>
                <span>{contracts.length.toLocaleString()} 檔發行中</span>
                <span>顯示最接近條件的 {filtered.length} 檔</span>
            </div>
            {loading ? (
                <div className={styles.empty}>
                    <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    載入權證市場…
                </div>
            ) : error ? (
                <div className={styles.error}>權證資料載入失敗</div>
            ) : filtered.length === 0 ? (
                <div className={styles.empty}>目前篩選條件沒有權證</div>
            ) : (
                <div className={styles.scroll}>
                    <table className={styles.table}>
                        <colgroup>
                            <col style={{ width: '32%' }} />
                            <col style={{ width: '9%' }} />
                            <col style={{ width: '13%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '12%' }} />
                            <col style={{ width: '14%' }} />
                            <col style={{ width: '34px' }} />
                        </colgroup>
                        <thead>
                            <tr>
                                <th className={styles.thLeft}>權證</th>
                                <th className={styles.th}>類型</th>
                                <th className={styles.th}>成交</th>
                                <th className={styles.th}>履約價</th>
                                <th className={styles.th}>價內外</th>
                                <th className={styles.th}>到期</th>
                                <th className={styles.th} aria-label='加入自選' />
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((contract) => {
                                const quote = snapshots.get(contract.code);
                                const distance = moneyness(
                                    contract,
                                    underlyingQuote?.close ?? null,
                                );
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
                                        title='連動此權證'
                                        onClick={() => {
                                            primeContract(contract);
                                            onPick(contract.code);
                                        }}
                                    >
                                        <td className={styles.tdLeft}>
                                            <strong>{contract.code}</strong>
                                            <span className={styles.contractName}>
                                                {contract.name}
                                            </span>
                                        </td>
                                        <td className={styles.td}>
                                            <span className={styles.badge}>
                                                {contract.call_put === 'P' ? '認售' : '認購'}
                                            </span>
                                        </td>
                                        <td className={`${styles.td} ${panel.dirText[direction]}`}>
                                            {quote ? fmtPrice(quote.close) : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {contract.strike_price
                                                ? fmtPrice(contract.strike_price)
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {Number.isFinite(distance)
                                                ? `${distance >= 0 ? '價外 ' : '價內 '}${Math.abs(distance).toFixed(1)}%`
                                                : '—'}
                                        </td>
                                        <td className={styles.td}>
                                            {contract.expiry_date ?? '—'}
                                            <span className={styles.contractName}>
                                                {Number.isFinite(daysUntil(contract.expiry_date))
                                                    ? `${daysUntil(contract.expiry_date)} 天`
                                                    : ''}
                                            </span>
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

