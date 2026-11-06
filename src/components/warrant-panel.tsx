import { RefreshButton } from './refresh-button';
import { Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLiveSnapshots } from '../hooks/use-live-snapshots';
import { pickUnderlying, useStockCatalog } from '../hooks/use-stock-catalog';
import { primeContract } from '../lib/contracts-cache';
import {
    fetchSnapshots,
    fetchWarrants,
    resolveContract,
} from '../lib/shioaji';
import type { StockMeta } from '../lib/stock-index';
import { getProductCatalogVersion } from '../lib/product-catalog-version';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { todayStr } from '../lib/utils/date';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './derivative-explorer.css';
import { AsyncStatus } from './async-status';
import { CatalogRetryAlert } from './catalog-retry-alert';
import * as panel from './panel.css';
import { UnderlyingPicker } from './underlying-picker';

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
    const [right, setRight] = useState<'all' | 'C' | 'P'>('all');
    const [expiryDays, setExpiryDays] = useState(180);
    const [sort, setSort] = useState<'moneyness' | 'expiry'>('moneyness');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const { ready: catalogReady, error: catalogError, retry, reloads, version } = useStockCatalog({
        onLoad: (catalog) => {
            if (catalog.length === 0) setLoading(false);
            const saved = localStorage.getItem(WARRANT_UNDERLYING);
            setUnderlying(previous => pickUnderlying(catalog, previous, saved));
        },
        onError: () => setLoading(false),
    });
    // 同標的、同目錄版本重抓（重試、視窗取得焦點）時舊列身分仍有效，不鎖表格
    const requestContext = JSON.stringify([version, underlying?.code]);
    const [loadedContext, setLoadedContext] = useState<string | null>(null);
    const contractsReady = catalogReady && loadedContext === requestContext && !error;
    // 換標的時在同一次 render 清掉上一檔的權證與現貨價，摘要與表格才不會分屬兩檔
    const [shownCode, setShownCode] = useState(underlying?.code);
    if (shownCode !== underlying?.code) {
        setShownCode(underlying?.code);
        setContracts([]);
        setUnderlyingQuote(null);
        if (underlying && !catalogError) setLoading(true);
    }

    useEffect(() => {
        if (!underlying || !catalogReady) return;
        const controller = new AbortController();
        let active = true;
        const isCurrent = () => active && getProductCatalogVersion() === version;
        setLoading(true);
        setError(false);
        Promise.all([
            fetchWarrants(underlying.code, { expiryFrom: todayStr() }, { signal: controller.signal }),
            resolveContract(underlying.code, 'STK', { signal: controller.signal })
                .then((contract) => {
                    if (controller.signal.aborted) throw new DOMException('標的查詢已取消', 'AbortError');
                    return fetchSnapshots([contract]);
                })
                .then((rows) => rows[0] ?? null),
        ])
            .then(([rows, quote]) => {
                if (!isCurrent()) return;
                setContracts(rows);
                setLoadedContext(requestContext);
                setUnderlyingQuote(quote);
            })
            .catch(() => {
                if (!isCurrent()) return;
                setError(true);
            })
            .finally(() => { if (isCurrent()) setLoading(false); });
        return () => { active = false; controller.abort(); };
    }, [underlying?.code, version, reloads, catalogReady]);

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

    const { snapshots: snapshots, refresh: refreshQuotes, loading: quotesLoading, error: quotesError } = useLiveSnapshots(filtered.slice(0, 60));

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {quotesError && <span role="status">{quotesError}；保留上次報價</span>}
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
                <RefreshButton label="更新報價" loading={quotesLoading} onClick={() => void refreshQuotes()} />
            </div>
            <CatalogRetryAlert catalogError={catalogError} error={error} text='權證資料載入失敗' onRetry={retry} />
            <div className={styles.summary}>
                <span className={styles.summaryStrong}>
                    {underlying ? `${underlying.code} ${underlying.name}` : '—'}
                </span>
                <span>
                    現貨 {underlyingQuote ? fmtPrice(underlyingQuote.close) : '—'}
                </span>
                <span>{contracts.length.toLocaleString()} 檔發行中</span>
                <span>顯示最接近條件的 {filtered.length} 檔</span>
                {!contractsReady && filtered.length > 0 && <span>更新完成後可選取</span>}
            </div>
            {loading && contracts.length === 0 ? (
                <div className={styles.empty}>
                    <AsyncStatus phase='loading' text='載入權證市場…' />
                </div>
            ) : (error || catalogError) && contracts.length === 0 ? (
                <div className={styles.error}><AsyncStatus phase='error' text='權證資料載入失敗' /></div>
            ) : filtered.length === 0 ? (
                <div className={styles.empty}><AsyncStatus phase='empty' text='目前篩選條件沒有權證' /></div>
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
                                            if (!contractsReady || getProductCatalogVersion() !== version) return;
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
                                                disabled={!contractsReady}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    if (!contractsReady || getProductCatalogVersion() !== version) return;
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
