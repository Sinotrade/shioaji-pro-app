import { Fragment, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useContract } from '../lib/contracts-cache';
import { getMarketSnapshot, subscribeMarketSnapshots } from '../lib/market-snapshot-store';
import { getQuote, subscribeQuoteStore } from '../lib/stream';
import { filterResearchIndustryGroups, RESEARCH_INDUSTRY_GROUPS, RESEARCH_INDUSTRY_STOCK_COUNT, researchObservedPrice, type ResearchIndustryStock, type ResearchObservedPrice } from '../lib/research-industry-watchlist';
import { fmtPct, fmtPrice } from '../lib/utils/format';
import * as styles from './research-industry-watchlist.css';

function ObservedRow({ stock, selected, onPick }: { stock: ResearchIndustryStock; selected: boolean; onPick: (code: string) => void }) {
    // useQuote owns broker subscriptions, so deliberately use only the store's
    // observer here. Mounting/filtering the 49-row table never calls an API.
    const contract = useContract(stock.code);
    const subscribe = useCallback((listener: () => void) => subscribeQuoteStore(stock.code, listener), [stock.code]);
    const readQuote = useCallback(() => getQuote(stock.code), [stock.code]);
    const quote = useSyncExternalStore(subscribe, readQuote);
    const readSnapshot = useCallback(() => contract ? getMarketSnapshot(contract) : undefined, [contract]);
    const snapshot = useSyncExternalStore(subscribeMarketSnapshots, readSnapshot);
    const value = researchObservedPrice(stock.code, contract, quote, snapshot);
    return <ObservationStockRow stock={stock} selected={selected} onPick={onPick} value={value} />;
}

function ObservationStockRow({ stock, selected, onPick, value }: { stock: ResearchIndustryStock; selected: boolean; onPick: (code: string) => void; value: ResearchObservedPrice }) {
    const direction = value.change === undefined || value.change === 0 ? 'flat' : value.change > 0 ? 'up' : 'down';
    return (
        <button className={styles.row[selected ? 'selected' : 'normal']} data-stock-code={stock.code} aria-label={`觀察 ${stock.code} ${stock.name}`} aria-pressed={selected}
            title={`${stock.code} ${stock.name} · ${value.source}${value.stamp ? ` · ${value.stamp}` : ''}\n點選只聯動此股票；不加入自選、不批次載入`} onClick={() => onPick(stock.code)}>
            <span className={styles.identity}><span className={styles.code}>{stock.code}</span><span className={styles.name}>{stock.name}</span></span>
            <span className={styles.numbers}><span className={styles.price[direction]}>{fmtPrice(value.price)}</span>
                <span className={styles.source}>{value.price === undefined ? value.source : `${fmtPct(value.pct)} · ${value.source}`}</span>
            </span>
        </button>
    );
}

/** Pure view for offline layout QA: no contract, stream or broker hooks. */
export function ResearchIndustryWatchlistView({ onPick, selectedCode, renderStock }: { onPick: (code: string) => void; selectedCode?: string | null; renderStock?: (stock: ResearchIndustryStock, selected: boolean) => ReactNode }) {
    const [industry, setIndustry] = useState('');
    const [query, setQuery] = useState('');
    const groups = useMemo(() => filterResearchIndustryGroups(industry, query), [industry, query]);
    const count = groups.reduce((sum, group) => sum + group.stocks.length, 0);
    return (
        <div className={styles.root}>
            <div className={styles.toolbar}>
                <select className={styles.control} aria-label='篩選觀察產業' value={industry} onChange={event => setIndustry(event.target.value)}>
                    <option value=''>全部 17 產業</option>
                    {RESEARCH_INDUSTRY_GROUPS.map(group => <option key={group.industry} value={group.industry}>{group.industry}</option>)}
                </select>
                <input className={styles.control} aria-label='搜尋觀察股票' placeholder='代碼／股名' value={query} onChange={event => setQuery(event.target.value)} />
            </div>
            <div className={styles.note}>{`截圖名單 · ${count}/${RESEARCH_INDUSTRY_STOCK_COUNT} 檔 · 非最新龍頭排行／買進推薦`}<br />只讀已載入行情（不保證即時）；點一檔聯動 K 線／五檔。</div>
            <div className={styles.body}>
                {groups.length === 0 && <div className={styles.empty}>沒有符合的觀察股票</div>}
                {groups.map(group => <section className={styles.group} key={group.industry} aria-label={group.industry}>
                    <h3 className={styles.heading}><span>{group.industry}</span><span>{group.stocks.length}</span></h3>
                    {group.stocks.map(stock => <Fragment key={stock.code}>{renderStock ? renderStock(stock, selectedCode === stock.code) : <ObservationStockRow stock={stock} selected={selectedCode === stock.code} onPick={onPick} value={{ source: '未載入' }} />}</Fragment>)}
                </section>)}
            </div>
        </div>
    );
}

export function ResearchIndustryWatchlist({ onPick, selectedCode }: { onPick: (code: string) => void; selectedCode?: string | null }) {
    return <ResearchIndustryWatchlistView onPick={onPick} selectedCode={selectedCode} renderStock={(stock, selected) => <ObservedRow stock={stock} selected={selected} onPick={onPick} />} />;
}
