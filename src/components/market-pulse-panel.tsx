import { Activity, AlertTriangle, Radio } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useMarketPulseSnapshot } from '../hooks/use-market-pulse';
import {
    subscribeEnrichedIndex,
    subscribeMarketSignal,
    unsubscribeEnrichedIndex,
    unsubscribeMarketSignal,
} from '../lib/shioaji';
import { sectorLabel } from '../lib/stock-index';
import type { ContractBase } from '../lib/types/contract';
import type { ContributionRanking, ScannerRule } from '../lib/types/market';
import * as panel from './panel.css';
import * as styles from './market-pulse-panel.css';

type PulseView = 'index' | 'signals';
type SignalFamily = 'limit' | 'move' | 'volume' | 'state';

const INDICES: Record<'IX0001' | 'IX0043', ContractBase> = {
    IX0001: {
        security_type: 'IND',
        region: 'TW',
        exchange: 'TSE',
        code: 'IX0001',
        target_code: null,
    },
    IX0043: {
        security_type: 'IND',
        region: 'TW',
        exchange: 'OTC',
        code: 'IX0043',
        target_code: null,
    },
};

const INDEX_LABELS = { IX0001: '加權', IX0043: '櫃買' } as const;
const RANKINGS: { value: ContributionRanking; label: string }[] = [
    { value: 'top10', label: '前十' },
    { value: 'abs10', label: '影響最大' },
    { value: 'positive25', label: '拉抬' },
    { value: 'negative25', label: '壓抑' },
];
const FAMILY_RULES: Record<SignalFamily, ScannerRule[]> = {
    limit: [
        'bid_near_limit_up',
        'bid_touch_limit_up',
        'limit_up_unlocked',
        'ask_near_limit_down',
        'ask_touch_limit_down',
        'limit_down_unlocked',
    ],
    move: [
        'trade_price_surge',
        'trade_price_drop',
        'bid_price_surge',
        'ask_price_drop',
    ],
    volume: ['volume_burst'],
    state: ['simtrade', 'suspend'],
};
const RULE_LABELS: Record<ScannerRule, string> = {
    bid_near_limit_up: '接近漲停',
    bid_touch_limit_up: '觸及漲停',
    limit_up_unlocked: '漲停打開',
    ask_near_limit_down: '接近跌停',
    ask_touch_limit_down: '觸及跌停',
    limit_down_unlocked: '跌停打開',
    trade_price_surge: '成交急漲',
    trade_price_drop: '成交急跌',
    bid_price_surge: '買價急漲',
    ask_price_drop: '賣價急跌',
    volume_burst: '單筆爆量',
    simtrade: '試撮',
    suspend: '暫停交易',
};

function direction(value: number) {
    return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

function signalDirection(rule: ScannerRule) {
    return rule.includes('down') || rule.includes('drop')
        ? 'down'
        : rule.includes('up') || rule.includes('surge')
          ? 'up'
          : 'flat';
}

function signalDetail(rule: ScannerRule, extra: Record<string, unknown>) {
    if (rule === 'volume_burst') {
        const amount = Number(extra.amount ?? 0);
        return amount > 0 ? `${(amount / 1_000_000).toFixed(1)} 百萬` : '爆量';
    }
    if (rule.includes('surge') || rule.includes('drop')) {
        const pct = Number(extra.change_percent ?? 0);
        return Number.isFinite(pct)
            ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`
            : '';
    }
    const price = Number(extra.trigger_price ?? extra.limit_price ?? 0);
    return price > 0 ? price.toLocaleString('en-US') : '';
}

export function MarketPulsePanel({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const pulse = useMarketPulseSnapshot();
    const [view, setView] = useState<PulseView>('index');
    const [indexCode, setIndexCode] = useState<'IX0001' | 'IX0043'>('IX0001');
    const [ranking, setRanking] = useState<ContributionRanking>('top10');
    const [family, setFamily] = useState<SignalFamily>('move');
    const [error, setError] = useState('');
    const [indexPending, setIndexPending] = useState(false);
    const [contributionPending, setContributionPending] = useState(false);
    const [signalCoverage, setSignalCoverage] = useState({
        ok: 0,
        total: 0,
        pending: false,
    });
    const index = INDICES[indexCode];

    useEffect(() => {
        if (view !== 'index') return;
        let active = true;
        setError('');
        setIndexPending(true);
        void Promise.all([
            subscribeEnrichedIndex('calculated_index', index),
            subscribeEnrichedIndex('industry_contribution', index),
        ])
            .then(() => {
                if (active) setIndexPending(false);
            })
            .catch((reason: unknown) => {
                if (!active) return;
                setIndexPending(false);
                setError(
                    reason instanceof Error
                        ? reason.message
                        : '指數動能訂閱失敗',
                );
            });
        return () => {
            active = false;
            void Promise.allSettled([
                unsubscribeEnrichedIndex('calculated_index', index),
                unsubscribeEnrichedIndex('industry_contribution', index),
            ]);
        };
    }, [index, view]);

    useEffect(() => {
        if (view !== 'index') return;
        let active = true;
        setContributionPending(true);
        void subscribeEnrichedIndex(
            'index_contribution',
            index,
            ranking,
        )
            .then(() => {
                if (active) setContributionPending(false);
            })
            .catch((reason: unknown) => {
                if (!active) return;
                setContributionPending(false);
                setError(
                    reason instanceof Error
                        ? reason.message
                        : '成分股貢獻訂閱失敗',
                );
            });
        return () => {
            active = false;
            void unsubscribeEnrichedIndex(
                'index_contribution',
                index,
                ranking,
            ).catch(() => undefined);
        };
    }, [index, ranking, view]);

    useEffect(() => {
        if (view !== 'signals') return;
        let active = true;
        const rules = FAMILY_RULES[family];
        const subscriptions = rules.flatMap((rule) =>
            (['TSE', 'OTC'] as const).map((exchange) => ({ rule, exchange })),
        );
        setError('');
        setSignalCoverage({ ok: 0, total: subscriptions.length, pending: true });
        void Promise.allSettled(
            subscriptions.map(({ rule, exchange }) =>
                subscribeMarketSignal(rule, exchange),
            ),
        ).then((results) => {
            if (!active) return;
            const ok = results.filter(
                (result) => result.status === 'fulfilled',
            ).length;
            setSignalCoverage({ ok, total: results.length, pending: false });
            if (ok < results.length) {
                setError(
                    `市場訊號僅完成 ${ok}/${results.length} 個訂閱，資料可能不完整`,
                );
            }
        });
        return () => {
            active = false;
            void Promise.allSettled(
                subscriptions.map(({ rule, exchange }) =>
                    unsubscribeMarketSignal(rule, exchange),
                ),
            );
        };
    }, [family, view]);

    const calculated = pulse.calculated.get(indexCode);
    const contribution = pulse.indexContribution.get(
        `${indexCode}:${ranking}`,
    );
    const industryContribution = pulse.industryContribution.get(indexCode);
    const drivers = contribution?.entries ?? [];
    const industries = useMemo(
        () =>
            [...(industryContribution?.entries ?? [])]
                .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
                .slice(0, 18),
        [industryContribution, pulse.version],
    );
    const maxIndustryPoints = Math.max(
        0,
        ...industries.map((entry) => Math.abs(entry.points)),
    );
    const contributionIsSimtrade =
        contribution?.simtrade || industryContribution?.simtrade;
    const familyRules = FAMILY_RULES[family];
    const visibleSignals = pulse.signals
        .filter((signal) => familyRules.includes(signal.scanner))
        .slice(0, 100);

    return (
        <div className={styles.root}>
            <div className={styles.tabs}>
                <button
                    className={styles.tab[view === 'index' ? 'on' : 'off']}
                    onClick={() => setView('index')}
                >
                    <Activity size={13} /> 指數動能
                </button>
                <button
                    className={styles.tab[view === 'signals' ? 'on' : 'off']}
                    onClick={() => setView('signals')}
                >
                    <Radio size={13} /> 即時訊號
                </button>
            </div>
            {error && (
                <div className={styles.error}>
                    <AlertTriangle size={13} />
                    {error}
                </div>
            )}
            {view === 'index' ? (
                <>
                    <div className={styles.controls}>
                        {(Object.keys(INDICES) as (keyof typeof INDICES)[]).map(
                            (code) => (
                                <button
                                    key={code}
                                    className={
                                        styles.control[
                                            code === indexCode ? 'on' : 'off'
                                        ]
                                    }
                                    onClick={() => setIndexCode(code)}
                                >
                                    {INDEX_LABELS[code]}
                                </button>
                            ),
                        )}
                        <span className={styles.spacer} />
                        {RANKINGS.map((item) => (
                            <button
                                key={item.value}
                                className={
                                    styles.control[
                                        item.value === ranking ? 'on' : 'off'
                                    ]
                                }
                                onClick={() => setRanking(item.value)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.summary}>
                        <span className={styles.summaryLabel}>自算指數</span>
                        <strong
                            className={`${styles.summaryValue} ${panel.dirText[direction(calculated?.price_chg ?? 0)]}`}
                        >
                            {calculated
                                ? calculated.close.toLocaleString('en-US', {
                                      maximumFractionDigits: 2,
                                  })
                                : '--'}
                        </strong>
                        <span
                            className={`${styles.change} ${panel.dirText[direction(calculated?.price_chg ?? 0)]}`}
                        >
                            {calculated
                                ? `${calculated.price_chg > 0 ? '+' : ''}${calculated.price_chg.toFixed(2)} · ${calculated.pct_chg.toFixed(2)}%`
                                : indexPending
                                  ? '訂閱中...'
                                  : '等待盤中資料'}
                        </span>
                        {(calculated?.simtrade || contributionIsSimtrade) && (
                            <span className={styles.simtrade}>試撮</span>
                        )}
                        <span className={styles.time}>
                            {calculated?.time.slice(0, 8) ?? ''}
                        </span>
                    </div>
                    <div className={styles.columns}>
                        <section className={styles.section}>
                            <div className={styles.sectionTitle}>
                                成分股貢獻
                            </div>
                            <div className={styles.list}>
                                {drivers.map((entry, idx) => (
                                    <button
                                        key={`${entry.code}-${idx}`}
                                        className={styles.rowButton}
                                        onClick={() => onPick?.(entry.code)}
                                    >
                                        <span className={styles.rank}>
                                            {idx + 1}
                                        </span>
                                        <span className={styles.code}>
                                            {entry.code}
                                        </span>
                                        <span
                                            className={`${styles.points} ${panel.dirText[direction(entry.points)]}`}
                                        >
                                            {entry.points > 0 ? '+' : ''}
                                            {entry.points.toFixed(2)} 點
                                        </span>
                                        <span
                                            className={`${styles.pct} ${panel.dirText[direction(entry.pct_chg)]}`}
                                        >
                                            {entry.pct_chg > 0 ? '+' : ''}
                                            {entry.pct_chg.toFixed(2)}%
                                        </span>
                                    </button>
                                ))}
                                {drivers.length === 0 && (
                                    <div className={styles.empty}>
                                        {contributionPending
                                            ? '訂閱中...'
                                            : '等待成分股貢獻資料'}
                                    </div>
                                )}
                            </div>
                        </section>
                        <section className={styles.section}>
                            <div className={styles.sectionTitle}>產業貢獻熱力圖</div>
                            <div className={styles.heatmap}>
                                {industries.map((entry) => (
                                    <div
                                        key={entry.category}
                                        className={
                                            styles.heatTile[
                                                direction(entry.points)
                                            ]
                                        }
                                        style={{
                                            flexGrow:
                                                maxIndustryPoints > 0
                                                    ? Math.max(
                                                          0.35,
                                                          Math.sqrt(
                                                              Math.abs(
                                                                  entry.points,
                                                              ) /
                                                                  maxIndustryPoints,
                                                          ),
                                                      )
                                                    : 1,
                                        }}
                                        title={`${sectorLabel(entry.category)} ${entry.points > 0 ? '+' : ''}${entry.points.toFixed(2)} 點`}
                                    >
                                        <span className={styles.heatName}>
                                            {sectorLabel(entry.category)}
                                        </span>
                                        <strong className={styles.heatPoints}>
                                            {entry.points > 0 ? '+' : ''}
                                            {entry.points.toFixed(2)}
                                        </strong>
                                    </div>
                                ))}
                                {industries.length === 0 && (
                                    <div className={styles.empty}>
                                        {indexPending
                                            ? '訂閱中...'
                                            : '等待產業貢獻資料'}
                                    </div>
                                )}
                            </div>
                        </section>
                    </div>
                </>
            ) : (
                <>
                    <div className={styles.controls}>
                        {(['limit', 'move', 'volume', 'state'] as const).map(
                            (value) => (
                            <button
                                key={value}
                                className={
                                    styles.control[
                                        value === family ? 'on' : 'off'
                                    ]
                                }
                                onClick={() => setFamily(value)}
                            >
                                {value === 'limit'
                                    ? '漲跌停'
                                    : value === 'move'
                                      ? '急漲跌'
                                      : value === 'volume'
                                        ? '爆量'
                                        : '狀態'}
                            </button>
                            ),
                        )}
                        <span className={styles.spacer} />
                        <span className={styles.live}>
                            <span
                                className={
                                    signalCoverage.ok === signalCoverage.total &&
                                    signalCoverage.total > 0
                                        ? styles.liveDot
                                        : styles.liveDotPartial
                                }
                            />{' '}
                            {signalCoverage.pending
                                ? '訂閱中'
                                : `${signalCoverage.ok}/${signalCoverage.total} subscriptions`}
                        </span>
                    </div>
                    {pulse.gap && (
                        <div className={styles.gap}>
                            <AlertTriangle size={13} />
                            串流重連期間遺漏 {pulse.gap.dropped_count} 筆訊號
                        </div>
                    )}
                    <div className={styles.signalHeader}>
                        <span>時間</span>
                        <span>市場</span>
                        <span>代碼</span>
                        <span>訊號</span>
                        <span>變化</span>
                        <span>成交價</span>
                    </div>
                    <div className={styles.signalList}>
                        {visibleSignals.map((signal) => {
                            const close = Number(signal.quote.close ?? 0);
                            return (
                                <button
                                    key={`${signal.exchange}-${signal.scanner}-${signal.quote.code}-${signal.quote.time}`}
                                    className={styles.signalRow}
                                    onClick={() => onPick?.(signal.quote.code)}
                                >
                                    <span className={styles.time}>
                                        {signal.quote.time.slice(0, 8)}
                                    </span>
                                    <span className={styles.exchange}>
                                        {signal.exchange}
                                    </span>
                                    <span className={styles.code}>
                                        {signal.quote.code}
                                    </span>
                                    <span
                                        className={
                                            panel.dirText[
                                                signalDirection(signal.scanner)
                                            ]
                                        }
                                    >
                                        {RULE_LABELS[signal.scanner]}
                                    </span>
                                    <span
                                        className={`${styles.detail} ${panel.dirText[signalDirection(signal.scanner)]}`}
                                    >
                                        {signalDetail(
                                            signal.scanner,
                                            signal.extra,
                                        )}
                                    </span>
                                    <span className={styles.price}>
                                        {close > 0
                                            ? close.toLocaleString('en-US')
                                            : '--'}
                                    </span>
                                </button>
                            );
                        })}
                        {visibleSignals.length === 0 && (
                            <div className={styles.empty}>等待盤中訊號</div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
