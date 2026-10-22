import { RefreshButton } from './refresh-button';
import { Star } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveSnapshots } from '../hooks/use-live-snapshots';
import { useProductNamesVersion } from '../hooks/use-product-names-version';
import { primeContract } from '../lib/contracts-cache';
import {
    fetchFutures
} from '../lib/shioaji';
import { loadStockCatalog, type StockMeta } from '../lib/stock-index';
import { getProductCatalogVersion, useProductCatalogVersion } from '../lib/product-catalog-version';
import { notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import { fmtPrice, fmtSigned } from '../lib/utils/format';
import * as styles from './derivative-explorer.css';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import { UnderlyingPicker } from './underlying-picker';

const STOCK_FUTURE_UNDERLYING = 'sj-pro-stock-future-underlying';

function aliasRank(contract: ContractInfo) {
    if (contract.code.endsWith('R1')) return 0;
    if (contract.code.endsWith('R2')) return 1;
    return 2;
}

export function StockFuturesPanel({
    onPick,
    onAdd,
    contract,
}: {
    onPick: (code: string) => void;
    onAdd: (contract: ContractInfo) => Promise<unknown>;
    contract?: ContractInfo | null;
}) {
    const [underlying, setUnderlying] = useState<StockMeta | null>(null);
    const [catalog, setCatalog] = useState<StockMeta[]>([]);
    const [contracts, setContracts] = useState<ContractInfo[]>([]);
    const [mode, setMode] = useState<'continuous' | 'all'>('continuous');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [catalogError, setCatalogError] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const version = useProductCatalogVersion();
    const namesVersion = useProductNamesVersion();
    const [catalogVersion, setCatalogVersion] = useState(-1);
    const catalogReady = catalogVersion === version && !catalogError;
    // 同標的、同目錄版本重抓（重試、視窗取得焦點）時舊列身分仍有效，不鎖表格
    const requestContext = JSON.stringify([version, underlying?.code]);
    const [loadedContext, setLoadedContext] = useState<string | null>(null);
    const contractsReady = catalogReady && loadedContext === requestContext && !error;
    const linkedCode = useRef<string | null>(null);
    // 換標的時在同一次 render 清掉上一檔的合約，摘要與表格才不會分屬兩檔
    const [shownCode, setShownCode] = useState(underlying?.code);
    if (shownCode !== underlying?.code) {
        setShownCode(underlying?.code);
        setContracts([]);
        if (underlying && !catalogError) setLoading(true);
    }

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        const isCurrent = () => active && getProductCatalogVersion() === version;
        setCatalogError(false);
        loadStockCatalog({ signal: controller.signal })
            .then((rows) => {
                if (!isCurrent()) return;
                setCatalog(rows);
                setCatalogVersion(version);
                if (rows.length === 0) setLoading(false);
                const saved = localStorage.getItem(STOCK_FUTURE_UNDERLYING);
                setUnderlying(previous =>
                    rows.find((stock) => stock.code === previous?.code) ??
                        rows.find((stock) => stock.code === saved) ??
                        rows.find((stock) => stock.code === '2330') ??
                        rows[0] ??
                        null,
                );
            })
            .catch(() => { if (isCurrent()) { setCatalogError(true); setLoading(false); } });
        return () => { active = false; controller.abort(); };
    }, [version, namesVersion, refresh]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onFocus = () => setRefresh(value => value + 1);
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, []);

    // 標準 chrome 連動/釘選：不釘時 contract 跟隨自選選擇 — 點到股票
    // 直接跟；點到個股期跟它的標的。目錄查不到（無個股期）就不動。
    useEffect(() => {
        if (!contract || catalog.length === 0 || linkedCode.current === contract.code) return;
        const code =
            contract.security_type === 'STK'
                ? contract.code
                : contract.security_type === 'FUT'
                  ? contract.underlying_code
                  : null;
        if (!code) return;
        const stock = catalog.find((s) => s.code === code);
        if (!stock) return;
        linkedCode.current = contract.code;
        setUnderlying((prev) => (prev?.code === stock.code ? prev : stock));
        localStorage.setItem(STOCK_FUTURE_UNDERLYING, stock.code);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract?.code, catalog]);

    useEffect(() => {
        if (!underlying || catalogVersion !== version || catalogError) return;
        const controller = new AbortController();
        let active = true;
        const isCurrent = () => active && getProductCatalogVersion() === version;
        setLoading(true);
        setError(false);
        fetchFutures({ underlyingCode: underlying.code }, { signal: controller.signal })
            .then((rows) => {
                if (!isCurrent()) return;
                setContracts(rows);
                setLoadedContext(requestContext);
            })
            .catch(() => {
                if (!isCurrent()) return;
                setError(true);
            })
            .finally(() => { if (isCurrent()) setLoading(false); });
        return () => { active = false; controller.abort(); };
    }, [underlying?.code, version, refresh, catalogVersion, catalogError]);

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

    const { snapshots: snapshots, refresh: refreshQuotes, loading: quotesLoading, error: quotesError } = useLiveSnapshots(visible.slice(0, 40));

    const roots = new Set(contracts.map((contract) => contract.root).filter(Boolean));

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {quotesError && <span role="status">{quotesError}；保留上次報價</span>}
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
                <RefreshButton label="更新報價" loading={quotesLoading} onClick={() => void refreshQuotes()} />
            </div>
            {(error || catalogError) && (
                <div role='alert' className={styles.error}>
                    {catalogError ? '標的目錄載入失敗' : '個股期合約載入失敗'}；保留上次資料
                    <button type='button' onClick={() => setRefresh(value => value + 1)}>重試商品資料</button>
                </div>
            )}
            <div className={styles.summary}>
                <span className={styles.summaryStrong}>
                    {underlying ? `${underlying.code} ${underlying.name}` : '—'}
                </span>
                <span>{roots.size} 種規格</span>
                <span>{contractsReady || visible.length === 0 ? `${visible.length} 口合約可選` : '更新完成後可選取'}</span>
            </div>
            {loading && contracts.length === 0 ? (
                <div className={styles.empty}>
                    <AsyncStatus phase='loading' text='載入個股期合約…' />
                </div>
            ) : (error || catalogError) && contracts.length === 0 ? (
                <div className={styles.error}><AsyncStatus phase='error' text='個股期合約載入失敗' /></div>
            ) : visible.length === 0 ? (
                <div className={styles.empty}><AsyncStatus phase='empty' text='此標的目前沒有個股期' /></div>
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
                                            if (!contractsReady || getProductCatalogVersion() !== version) return;
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
