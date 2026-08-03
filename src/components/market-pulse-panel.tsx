import {
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    GitBranch,
    LayoutGrid,
    Link2,
    ListOrdered,
    SlidersHorizontal,
} from 'lucide-react';
import {
    type CSSProperties,
    Fragment,
    type KeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import {
    sankey,
    sankeyLinkHorizontal,
    type SankeyGraph,
} from 'd3-sankey';
import { useMarketPulseSnapshot } from '../hooks/use-market-pulse';
import { useQuote } from '../hooks/use-stream';
import { ensureContract } from '../lib/contracts-cache';
import {
    buildContributionFlow,
    type ContributionFlowLink,
    type ContributionFlowNode,
} from '../lib/contribution-flow';
import {
    exchangeTimeDifferenceSeconds,
    futuresIndexBasis,
} from '../lib/market-pulse';
import {
    subscribeEnrichedIndex,
    subscribeMarketSignal,
    subscribeQuote,
    unsubscribeEnrichedIndex,
    unsubscribeMarketSignal,
} from '../lib/shioaji';
import {
    loadStockDetails,
    sectorLabel,
    type StockMeta,
} from '../lib/stock-index';
import type { ContractBase } from '../lib/types/contract';
import type {
    PulseIndexCode,
    PulseSection,
    PulseSectionWeights,
} from '../lib/workspace';
import type {
    ContributionRanking,
    IndexContributionEntry,
    ScannerExchange,
    ScannerRule,
} from '../lib/types/market';
import type { IndustryContributionEntry } from '../lib/types/market';
import { vars } from '../theme.css';
import * as panel from './panel.css';
import * as styles from './market-pulse-panel.css';

type PulseView = 'index' | 'signals';
type IndexVisualization = 'distribution' | 'flow';
type SignalFamily = 'limit' | 'move' | 'volume' | 'state';
type SignalFilterGroup = 'market' | SignalFamily;

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
    { value: 'positive25', label: '上漲貢獻' },
    { value: 'negative25', label: '下跌貢獻' },
];
const FLOW_RANKINGS: ContributionRanking[] = ['positive25', 'negative25'];
const STOCK_DETAIL_BATCH_SIZE = 8;
const PULSE_SECTIONS: PulseSection[] = ['stocks', 'industries', 'flow'];
const DEFAULT_SECTION_WEIGHTS: PulseSectionWeights = {
    stocks: 28,
    industries: 32,
    flow: 40,
};
const MIN_SECTION_WEIGHT = 12;
const SECTION_LABELS: Record<PulseSection, string> = {
    stocks: '成分股貢獻',
    industries: '產業貢獻分布',
    flow: '貢獻傳導',
};

function initialPulseSections(
    sections: PulseSection[] | undefined,
    legacyVisualization: IndexVisualization,
): PulseSection[] {
    const valid = PULSE_SECTIONS.filter((section) => sections?.includes(section));
    if (valid.length > 0) return valid;
    return legacyVisualization === 'flow'
        ? ['flow']
        : ['stocks', 'industries'];
}

function initialPulseWeights(
    weights: Partial<PulseSectionWeights> | undefined,
): PulseSectionWeights {
    return {
        stocks: weights?.stocks ?? DEFAULT_SECTION_WEIGHTS.stocks,
        industries: weights?.industries ?? DEFAULT_SECTION_WEIGHTS.industries,
        flow: weights?.flow ?? DEFAULT_SECTION_WEIGHTS.flow,
    };
}
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
const SIGNAL_FAMILIES: SignalFamily[] = ['limit', 'move', 'volume', 'state'];
const FAMILY_LABELS: Record<SignalFamily, string> = {
    limit: '漲跌停',
    move: '急漲跌',
    volume: '爆量',
    state: '狀態',
};
const ALL_SIGNAL_RULES = SIGNAL_FAMILIES.flatMap(
    (family) => FAMILY_RULES[family],
);
const SIGNAL_EXCHANGES: ScannerExchange[] = ['TSE', 'OTC'];
const EXCHANGE_LABELS: Record<ScannerExchange, string> = {
    TSE: '上市',
    OTC: '上櫃',
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

interface TreemapDatum {
    name: string;
    entry?: IndustryContributionEntry;
    children?: TreemapDatum[];
}

function IndustryTreemap({ entries }: { entries: IndustryContributionEntry[] }) {
    const ref = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === 'undefined') return;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            setSize({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const layout = useMemo(() => {
        if (size.width <= 0 || size.height <= 0) return [];
        const visible = entries.filter((entry) => entry.points !== 0);
        const root = hierarchy<TreemapDatum>({
            name: 'industries',
            children: visible.map((entry) => ({
                name: sectorLabel(entry.category),
                entry,
            })),
        })
            .sum((datum) => Math.abs(datum.entry?.points ?? 0))
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
        const laidOut = treemap<TreemapDatum>()
            .tile(treemapSquarify.ratio(1.35))
            .size([size.width, size.height])
            .paddingInner(2)
            .round(true)(root);
        const total = laidOut.value ?? 0;
        const max = laidOut.leaves()[0]?.value ?? 0;
        return laidOut.leaves().map((leaf) => ({
            ...leaf,
            entry: leaf.data.entry as IndustryContributionEntry,
            share: total > 0 ? ((leaf.value ?? 0) / total) * 100 : 0,
            intensity:
                max > 0
                    ? 18 + Math.sqrt((leaf.value ?? 0) / max) * 34
                    : 18,
        }));
    }, [entries, size]);

    return (
        <div ref={ref} className={styles.treemap}>
            {layout.map((leaf) => {
                const width = leaf.x1 - leaf.x0;
                const height = leaf.y1 - leaf.y0;
                const entry = leaf.entry;
                const style = {
                    left: leaf.x0,
                    top: leaf.y0,
                    width,
                    height,
                    '--heat-color':
                        entry.points > 0
                            ? vars.color.up
                            : entry.points < 0
                              ? vars.color.down
                              : vars.color.flat,
                    '--heat-alpha': `${leaf.intensity.toFixed(0)}%`,
                } as CSSProperties;
                return (
                    <div
                        key={entry.category}
                        className={styles.treemapTile}
                        style={style}
                        title={`${sectorLabel(entry.category)} ${entry.points > 0 ? '+' : ''}${entry.points.toFixed(2)} 點 · ${leaf.share.toFixed(2)}%`}
                    >
                        {width >= 48 && height >= 26 && (
                            <span className={styles.treemapName}>
                                {sectorLabel(entry.category)}
                            </span>
                        )}
                        {width >= 58 && height >= 38 && (
                            <strong className={styles.treemapPoints}>
                                {entry.points > 0 ? '+' : ''}
                                {entry.points.toFixed(2)}
                            </strong>
                        )}
                        {width >= 92 && height >= 58 && (
                            <span className={styles.treemapShare}>
                                {leaf.share.toFixed(1)}%
                            </span>
                        )}
                    </div>
                );
            })}
            {layout.length === 0 && (
                <div className={styles.empty}>等待產業貢獻資料</div>
            )}
        </div>
    );
}

function ContributionSankey({
    entries,
    details,
    industries,
    onPick,
}: {
    entries: IndexContributionEntry[];
    details: StockMeta[];
    industries: IndustryContributionEntry[];
    onPick?: (code: string) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === 'undefined') return;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            setSize({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const layout = useMemo(() => {
        const flow = buildContributionFlow(entries, details, industries);
        if (!flow.links.length || size.height <= 0) return null;
        const width = Math.max(560, size.width);
        const height = Math.max(220, size.height);
        const generator = sankey<
            SankeyGraph<ContributionFlowNode, ContributionFlowLink>,
            ContributionFlowNode,
            ContributionFlowLink
        >()
            .nodeId((node) => node.id)
            .nodeWidth(8)
            .nodePadding(9)
            .extent([
                [12, 12],
                [width - 118, height - 14],
            ]);
        return {
            width,
            height,
            graph: generator({
                nodes: flow.nodes.map((node) => ({ ...node })),
                links: flow.links.map((link) => ({ ...link })),
            }),
        };
    }, [details, entries, industries, size]);

    const linkPath = useMemo(
        () => sankeyLinkHorizontal<ContributionFlowNode, ContributionFlowLink>(),
        [],
    );

    return (
        <div ref={ref} className={styles.sankeyViewport}>
            {layout ? (
                <svg
                    className={styles.sankey}
                    width={layout.width}
                    height={layout.height}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    role="img"
                    aria-label="拉抬與壓抑經由產業到主要個股的指數貢獻傳導圖"
                >
                    <g className={styles.sankeyLinks}>
                        {layout.graph.links.map((link, index) => (
                            <path
                                key={`${String(link.source)}-${String(link.target)}-${index}`}
                                className={styles.sankeyLink}
                                d={linkPath(link) ?? undefined}
                                stroke={
                                    link.direction === 'up'
                                        ? vars.color.up
                                        : vars.color.down
                                }
                                strokeWidth={Math.max(1, link.width ?? 1)}
                            >
                                <title>{`${link.value.toFixed(2)} 點`}</title>
                            </path>
                        ))}
                    </g>
                    <g>
                        {layout.graph.nodes.map((node) => {
                            const x0 = node.x0 ?? 0;
                            const x1 = node.x1 ?? 0;
                            const y0 = node.y0 ?? 0;
                            const y1 = node.y1 ?? 0;
                            const color =
                                node.direction === 'up'
                                    ? vars.color.up
                                    : vars.color.down;
                            return (
                                <g
                                    key={node.id}
                                    className={
                                        node.code && onPick
                                            ? styles.sankeyInteractiveNode
                                            : undefined
                                    }
                                    onClick={() =>
                                        node.code && onPick?.(node.code)
                                    }
                                >
                                    <rect
                                        x={x0}
                                        y={y0}
                                        width={Math.max(1, x1 - x0)}
                                        height={Math.max(1, y1 - y0)}
                                        rx={2}
                                        fill={color}
                                    />
                                    <text
                                        className={styles.sankeyLabel}
                                        x={x1 + 6}
                                        y={(y0 + y1) / 2}
                                        dominantBaseline="middle"
                                        fill={color}
                                    >
                                        {node.label}
                                        <tspan className={styles.sankeyValue}>
                                            {' '}
                                            {node.direction === 'up' ? '+' : '-'}
                                            {node.points.toFixed(2)}
                                        </tspan>
                                    </text>
                                </g>
                            );
                        })}
                    </g>
                </svg>
            ) : (
                <div className={styles.empty}>等待成分股貢獻資料</div>
            )}
        </div>
    );
}

export function MarketPulsePanel({
    onPick,
    initialVisualization = 'distribution',
    initialSections,
    initialWeights,
    initialIndexCode = 'IX0001',
    fixedIndex = false,
    fixedView,
    onConfigChange,
}: {
    onPick?: (code: string) => void;
    initialVisualization?: IndexVisualization;
    initialSections?: PulseSection[];
    initialWeights?: Partial<PulseSectionWeights>;
    initialIndexCode?: PulseIndexCode;
    fixedIndex?: boolean;
    fixedView?: PulseView;
    onConfigChange?: (
        sections: PulseSection[],
        weights: PulseSectionWeights,
    ) => void;
}) {
    const pulse = useMarketPulseSnapshot();
    const view = fixedView ?? 'index';
    const [sections, setSections] = useState<PulseSection[]>(() =>
        initialPulseSections(initialSections, initialVisualization),
    );
    const [sectionWeights, setSectionWeights] = useState<PulseSectionWeights>(
        () => initialPulseWeights(initialWeights),
    );
    const sectionWorkspaceRef = useRef<HTMLDivElement>(null);
    const sectionWeightsRef = useRef(sectionWeights);
    sectionWeightsRef.current = sectionWeights;
    const [indexCode, setIndexCode] =
        useState<PulseIndexCode>(initialIndexCode);
    const [ranking, setRanking] = useState<ContributionRanking>('top10');
    const [enabledSignalRules, setEnabledSignalRules] = useState<ScannerRule[]>(
        () => [...FAMILY_RULES.move],
    );
    const [enabledSignalExchanges, setEnabledSignalExchanges] = useState<
        ScannerExchange[]
    >(() => [...SIGNAL_EXCHANGES]);
    const [showSignalRules, setShowSignalRules] = useState(false);
    const [expandedSignalGroups, setExpandedSignalGroups] = useState<
        SignalFilterGroup[]
    >(['market', 'move']);
    const [autoFollowSignals, setAutoFollowSignals] = useState(true);
    const latestSignalRef = useRef<string | null | undefined>(undefined);
    const [error, setError] = useState('');
    const [indexPending, setIndexPending] = useState(false);
    const [contributionPending, setContributionPending] = useState(false);
    const [stockDetails, setStockDetails] = useState<StockMeta[]>([]);
    const [stockDetailsPending, setStockDetailsPending] = useState(false);
    const [nearMonthCode, setNearMonthCode] = useState('');
    const [nearMonthPending, setNearMonthPending] = useState(false);
    const [signalCoverage, setSignalCoverage] = useState({
        ok: 0,
        total: 0,
        pending: false,
    });
    const index = INDICES[indexCode];
    const officialIndex = useQuote(indexCode)?.index;
    const nearMonthQuote = useQuote(
        indexCode === 'IX0001' ? 'TXFR1' : null,
    )?.tick;

    useEffect(() => {
        setSections(
            initialPulseSections(initialSections, initialVisualization),
        );
    }, [initialSections, initialVisualization]);

    useEffect(() => {
        const next = initialPulseWeights(initialWeights);
        sectionWeightsRef.current = next;
        setSectionWeights(next);
    }, [initialWeights]);

    useEffect(() => {
        setIndexCode(initialIndexCode);
    }, [initialIndexCode]);

    useEffect(() => {
        if (view !== 'index') return;
        let active = true;
        setError('');
        setIndexPending(true);
        void Promise.all([
            subscribeEnrichedIndex('calculated_index', index),
            subscribeEnrichedIndex('industry_contribution', index),
            subscribeQuote(index, 'Quote'),
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
        if (view !== 'index' || indexCode !== 'IX0001') {
            setNearMonthPending(false);
            return;
        }
        let active = true;
        setNearMonthPending(true);
        void ensureContract('TXFR1', 'FUT')
            .then((contract) => {
                if (active) {
                    setNearMonthCode(contract.target_code || contract.code);
                }
            })
            .catch(() => {
                if (active) setNearMonthCode('');
            })
            .finally(() => {
                if (active) setNearMonthPending(false);
            });
        return () => {
            active = false;
        };
    }, [indexCode, view]);

    useEffect(() => {
        if (view !== 'index') return;
        let active = true;
        setContributionPending(true);
        const rankings = [...new Set([ranking, ...FLOW_RANKINGS])];
        void Promise.all(
            rankings.map((value) =>
                subscribeEnrichedIndex('index_contribution', index, value),
            ),
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
            void Promise.allSettled(
                rankings.map((value) =>
                    unsubscribeEnrichedIndex(
                        'index_contribution',
                        index,
                        value,
                    ),
                ),
            );
        };
    }, [index, ranking, view]);

    useEffect(() => {
        if (view !== 'signals') return;
        let active = true;
        const rules = enabledSignalRules;
        const subscriptions = rules.flatMap((rule) =>
            enabledSignalExchanges.map((exchange) => ({ rule, exchange })),
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
    }, [enabledSignalExchanges, enabledSignalRules, view]);

    const calculated = pulse.calculated.get(indexCode);
    const officialCloseValue = Number(officialIndex?.close);
    const officialClose = Number.isFinite(officialCloseValue)
        ? officialCloseValue
        : null;
    const indexGap =
        calculated && officialClose !== null
            ? calculated.close - officialClose
            : null;
    const timeGap =
        calculated && officialIndex?.time
            ? exchangeTimeDifferenceSeconds(
                  calculated.time,
                  officialIndex.time,
              )
            : null;
    const nearMonthPriceValue = Number(nearMonthQuote?.close);
    const nearMonthPrice = Number.isFinite(nearMonthPriceValue)
        ? nearMonthPriceValue
        : null;
    const futuresBasis = futuresIndexBasis(
        nearMonthPrice,
        calculated?.close,
    );
    const contribution = pulse.indexContribution.get(
        `${indexCode}:${ranking}`,
    );
    const industryContribution = pulse.industryContribution.get(indexCode);
    const drivers = contribution?.entries ?? [];
    const flowDrivers = useMemo(() => {
        const byCode = new Map<string, IndexContributionEntry>();
        for (const flowRanking of FLOW_RANKINGS) {
            const event = pulse.indexContribution.get(
                `${indexCode}:${flowRanking}`,
            );
            for (const entry of event?.entries ?? []) {
                const current = byCode.get(entry.code);
                if (!current || Math.abs(entry.points) > Math.abs(current.points)) {
                    byCode.set(entry.code, entry);
                }
            }
        }
        for (const entry of drivers) {
            if (!byCode.has(entry.code)) byCode.set(entry.code, entry);
        }
        return [...byCode.values()];
    }, [drivers, indexCode, pulse.indexContribution, pulse.version]);
    const driverCodes = [...new Set(flowDrivers.map((entry) => entry.code))]
        .sort()
        .join(',');

    useEffect(() => {
        if (!driverCodes) {
            setStockDetails([]);
            setStockDetailsPending(false);
            return;
        }
        let active = true;
        const codes = driverCodes.split(',');
        setStockDetailsPending(true);
        setStockDetails((current) =>
            current.filter((stock) => codes.includes(stock.code)),
        );
        const loadDetails = async () => {
            const details: StockMeta[] = [];
            for (let start = 0; start < codes.length; start += STOCK_DETAIL_BATCH_SIZE) {
                const batch = await loadStockDetails(
                    codes.slice(start, start + STOCK_DETAIL_BATCH_SIZE),
                );
                details.push(...batch);
                if (active) setStockDetails([...details]);
            }
            return details;
        };
        void loadDetails()
            .catch(() => undefined)
            .finally(() => {
                if (active) setStockDetailsPending(false);
            });
        return () => {
            active = false;
        };
    }, [driverCodes]);

    const stockByCode = useMemo(
        () => new Map(stockDetails.map((stock) => [stock.code, stock])),
        [stockDetails],
    );
    const industries = useMemo(
        () => [...(industryContribution?.entries ?? [])],
        [industryContribution, pulse.version],
    );
    const flowIndustries = useMemo(() => {
        const sorted = [...industries].sort(
            (a, b) => Math.abs(b.points) - Math.abs(a.points),
        );
        const visible = sorted.slice(0, 12);
        const rest = sorted.slice(12);
        const otherUp = rest.reduce(
            (sum, entry) => sum + Math.max(0, entry.points),
            0,
        );
        const otherDown = rest.reduce(
            (sum, entry) => sum + Math.min(0, entry.points),
            0,
        );
        if (otherUp > 0) {
            visible.push({ category: 'other-up', points: otherUp });
        }
        if (otherDown < 0) {
            visible.push({ category: 'other-down', points: otherDown });
        }
        return visible;
    }, [industries]);
    const industryTotal = industries.reduce(
        (total, entry) => total + Math.abs(entry.points),
        0,
    );
    const contributionIsSimtrade =
        contribution?.simtrade || industryContribution?.simtrade;
    const enabledSignalRuleSet = new Set(enabledSignalRules);
    const enabledSignalExchangeSet = new Set(enabledSignalExchanges);
    const enabledSignalRulesKey = enabledSignalRules.join('|');
    const enabledSignalExchangesKey = enabledSignalExchanges.join('|');
    const visibleSignals = pulse.signals
        .filter(
            (signal) =>
                enabledSignalRuleSet.has(signal.scanner) &&
                enabledSignalExchangeSet.has(signal.exchange),
        )
        .slice(0, 100);
    const latestSignal = visibleSignals[0];
    const latestSignalKey = latestSignal
        ? `${latestSignal.exchange}-${latestSignal.scanner}-${latestSignal.quote.code}-${latestSignal.quote.time}`
        : null;

    useEffect(() => {
        latestSignalRef.current = latestSignalKey;
    }, [enabledSignalExchangesKey, enabledSignalRulesKey]);

    useEffect(() => {
        if (!showSignalRules) return;
        const closeOnEscape = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setShowSignalRules(false);
        };
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, [showSignalRules]);

    useEffect(() => {
        if (view !== 'signals') return;
        if (latestSignalRef.current === undefined) {
            latestSignalRef.current = latestSignalKey;
            return;
        }
        if (!latestSignalKey || !latestSignal) return;
        if (latestSignalRef.current === latestSignalKey) return;
        latestSignalRef.current = latestSignalKey;
        if (autoFollowSignals) onPick?.(latestSignal.quote.code);
    }, [autoFollowSignals, latestSignal, latestSignalKey, onPick, view]);

    const toggleSignalFamily = useCallback((family: SignalFamily) => {
        const familyRules = FAMILY_RULES[family];
        setEnabledSignalRules((current) => {
            const currentSet = new Set(current);
            const allEnabled = familyRules.every((rule) =>
                currentSet.has(rule),
            );
            familyRules.forEach((rule) =>
                allEnabled ? currentSet.delete(rule) : currentSet.add(rule),
            );
            return ALL_SIGNAL_RULES.filter((rule) => currentSet.has(rule));
        });
    }, []);

    const toggleSignalRule = useCallback((rule: ScannerRule) => {
        setEnabledSignalRules((current) => {
            const currentSet = new Set(current);
            currentSet.has(rule)
                ? currentSet.delete(rule)
                : currentSet.add(rule);
            return ALL_SIGNAL_RULES.filter((value) => currentSet.has(value));
        });
    }, []);

    const toggleSignalExchange = useCallback((exchange: ScannerExchange) => {
        setEnabledSignalExchanges((current) =>
            current.includes(exchange)
                ? current.filter((value) => value !== exchange)
                : SIGNAL_EXCHANGES.filter(
                      (value) => current.includes(value) || value === exchange,
                  ),
        );
    }, []);

    const clearSignalFilters = useCallback(() => {
        setEnabledSignalRules([]);
        setEnabledSignalExchanges([]);
    }, []);

    const toggleSignalGroup = useCallback((group: SignalFilterGroup) => {
        setExpandedSignalGroups((current) =>
            current.includes(group)
                ? current.filter((value) => value !== group)
                : [...current, group],
        );
    }, []);

    const toggleSection = useCallback(
        (section: PulseSection) => {
            const next = sections.includes(section)
                ? sections.length === 1
                    ? sections
                    : sections.filter((value) => value !== section)
                : PULSE_SECTIONS.filter(
                      (value) => sections.includes(value) || value === section,
                  );
            if (next === sections) return;
            setSections(next);
            onConfigChange?.(next, sectionWeightsRef.current);
        },
        [onConfigChange, sections],
    );

    const resizeSections = useCallback(
        (
            left: PulseSection,
            right: PulseSection,
            delta: number,
            persist: boolean,
        ) => {
            const current = sectionWeightsRef.current;
            const pairTotal = current[left] + current[right];
            const leftWeight = Math.max(
                MIN_SECTION_WEIGHT,
                Math.min(pairTotal - MIN_SECTION_WEIGHT, current[left] + delta),
            );
            const next = {
                ...current,
                [left]: leftWeight,
                [right]: pairTotal - leftWeight,
            };
            sectionWeightsRef.current = next;
            setSectionWeights(next);
            if (persist) onConfigChange?.(sections, next);
        },
        [onConfigChange, sections],
    );

    const beginResize = useCallback(
        (
            event: ReactPointerEvent<HTMLDivElement>,
            left: PulseSection,
            right: PulseSection,
        ) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWeights = sectionWeightsRef.current;
            const width = sectionWorkspaceRef.current?.clientWidth ?? 1;
            const totalWeight = sections.reduce(
                (sum, section) => sum + startWeights[section],
                0,
            );
            const move = (moveEvent: PointerEvent) => {
                const delta = ((moveEvent.clientX - startX) / width) * totalWeight;
                setSectionWeights((current) => {
                    const pairTotal = startWeights[left] + startWeights[right];
                    const leftWeight = Math.max(
                        MIN_SECTION_WEIGHT,
                        Math.min(
                            pairTotal - MIN_SECTION_WEIGHT,
                            startWeights[left] + delta,
                        ),
                    );
                    const next = {
                        ...current,
                        [left]: leftWeight,
                        [right]: pairTotal - leftWeight,
                    };
                    sectionWeightsRef.current = next;
                    return next;
                });
            };
            const end = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', end);
                onConfigChange?.(sections, sectionWeightsRef.current);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end, { once: true });
        },
        [onConfigChange, sections],
    );

    const resizeWithKeyboard = useCallback(
        (
            event: KeyboardEvent<HTMLDivElement>,
            left: PulseSection,
            right: PulseSection,
        ) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            resizeSections(left, right, event.key === 'ArrowLeft' ? -3 : 3, true);
        },
        [resizeSections],
    );

    return (
        <div className={styles.root}>
            {error && (
                <div className={styles.error}>
                    <AlertTriangle size={13} />
                    {error}
                </div>
            )}
            {view === 'index' ? (
                <>
                    <div className={styles.controls}>
                        {fixedIndex ? (
                            <span className={styles.marketBadge}>
                                {INDEX_LABELS[indexCode]}
                            </span>
                        ) : (
                            (Object.keys(INDICES) as PulseIndexCode[]).map(
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
                            )
                        )}
                        <span className={styles.controlDivider} />
                        <button
                            className={styles.control[
                                sections.includes('stocks') ? 'on' : 'off'
                            ]}
                            onClick={() => toggleSection('stocks')}
                            aria-pressed={sections.includes('stocks')}
                            title="顯示或隱藏成分股貢獻"
                        >
                            <ListOrdered size={12} /> 成分股貢獻
                        </button>
                        <button
                            className={styles.control[
                                sections.includes('industries') ? 'on' : 'off'
                            ]}
                            onClick={() => toggleSection('industries')}
                            aria-pressed={sections.includes('industries')}
                            title="顯示或隱藏產業貢獻分布"
                        >
                            <LayoutGrid size={12} /> 產業分布
                        </button>
                        <button
                            className={styles.control[
                                sections.includes('flow') ? 'on' : 'off'
                            ]}
                            onClick={() => toggleSection('flow')}
                            aria-pressed={sections.includes('flow')}
                            title="顯示或隱藏貢獻傳導"
                        >
                            <GitBranch size={12} /> 貢獻傳導
                        </button>
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
                        <span className={styles.summaryMetric}>
                            <span className={styles.summaryLabel}>自算</span>
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
                        </span>
                        <span className={styles.metricDivider} />
                        <span className={styles.summaryMetric}>
                            <span className={styles.summaryLabel}>官方</span>
                            <strong className={styles.metricValue}>
                                {officialClose?.toLocaleString('en-US', {
                                    maximumFractionDigits: 2,
                                }) ?? '--'}
                            </strong>
                        </span>
                        <span className={styles.summaryMetric}>
                            <span className={styles.summaryLabel}>價差</span>
                            <strong
                                className={`${styles.metricValue} ${panel.dirText[direction(indexGap ?? 0)]}`}
                                title="自算指數 − 官方指數"
                            >
                                {indexGap === null
                                    ? '--'
                                    : `${indexGap > 0 ? '+' : ''}${indexGap.toFixed(2)} 點`}
                            </strong>
                        </span>
                        <span className={styles.summaryMetric}>
                            <span className={styles.summaryLabel}>時間差</span>
                            <strong
                                className={`${styles.metricValue} ${panel.dirText[direction(timeGap ?? 0)]}`}
                                title="自算指數時間 − 官方指數時間"
                            >
                                {timeGap === null
                                    ? '--'
                                    : `${timeGap > 0 ? '+' : ''}${timeGap.toFixed(3)} 秒`}
                            </strong>
                        </span>
                        {indexCode === 'IX0001' && (
                            <>
                                <span className={styles.metricDivider} />
                                <span className={styles.summaryMetric}>
                                    <span
                                        className={styles.summaryLabel}
                                        title={`連續近月 TXFR1${nearMonthCode ? `，目前映射 ${nearMonthCode}` : ''}`}
                                    >
                                        台指近月
                                    </span>
                                    <strong className={styles.metricValue}>
                                        {nearMonthPrice?.toLocaleString(
                                            'en-US',
                                            {
                                                maximumFractionDigits: 2,
                                            },
                                        ) ??
                                            (nearMonthPending
                                                ? '訂閱中...'
                                                : '--')}
                                    </strong>
                                    {nearMonthCode && (
                                        <span className={styles.contractCode}>
                                            {nearMonthCode}
                                        </span>
                                    )}
                                </span>
                                <span className={styles.summaryMetric}>
                                    <span className={styles.summaryLabel}>
                                        期現差
                                    </span>
                                    <strong
                                        className={`${styles.metricValue} ${panel.dirText[direction(futuresBasis ?? 0)]}`}
                                        title="台指期近月 − 自算加權指數；正值為升水，負值為逆價差"
                                    >
                                        {futuresBasis === null
                                            ? '--'
                                            : `${futuresBasis > 0 ? '+' : ''}${futuresBasis.toFixed(2)} 點`}
                                    </strong>
                                </span>
                            </>
                        )}
                        <span className={styles.spacer} />
                        {(calculated?.simtrade || contributionIsSimtrade) && (
                            <span className={styles.simtrade}>試撮</span>
                        )}
                        <span className={styles.time}>
                            {calculated?.time.slice(0, 8) ?? ''}
                        </span>
                    </div>
                    <div
                        ref={sectionWorkspaceRef}
                        className={styles.sectionWorkspace}
                    >
                        {sections.map((section, index) => (
                            <Fragment key={section}>
                                {index > 0 && (
                                    <div
                                        className={styles.sectionDivider}
                                        role="separator"
                                        aria-label={`調整${SECTION_LABELS[sections[index - 1]!]}與${SECTION_LABELS[section]}寬度`}
                                        aria-orientation="vertical"
                                        tabIndex={0}
                                        onPointerDown={(event) =>
                                            beginResize(
                                                event,
                                                sections[index - 1]!,
                                                section,
                                            )
                                        }
                                        onKeyDown={(event) =>
                                            resizeWithKeyboard(
                                                event,
                                                sections[index - 1]!,
                                                section,
                                            )
                                        }
                                    />
                                )}
                                <section
                                    className={styles.section}
                                    style={{
                                        flexBasis: 0,
                                        flexGrow: sectionWeights[section],
                                    }}
                                >
                                    {section === 'stocks' ? (
                                        <>
                                            <div
                                                className={styles.sectionHeading}
                                            >
                                                <span>成分股貢獻</span>
                                                <span
                                                    className={styles.areaLegend}
                                                >
                                                    目前排行
                                                </span>
                                            </div>
                                            <div className={styles.list}>
                                                {drivers.map((entry, idx) => (
                                                    <button
                                                        key={`${entry.code}-${idx}`}
                                                        className={
                                                            styles.rowButton
                                                        }
                                                        onClick={() =>
                                                            onPick?.(entry.code)
                                                        }
                                                    >
                                                        <span
                                                            className={styles.rank}
                                                        >
                                                            {idx + 1}
                                                        </span>
                                                        <span
                                                            className={styles.code}
                                                        >
                                                            {entry.code}
                                                            <small
                                                                className={
                                                                    styles.stockName
                                                                }
                                                            >
                                                                {stockByCode.get(
                                                                    entry.code,
                                                                )?.name ??
                                                                    (stockDetailsPending
                                                                        ? '名稱載入中'
                                                                        : '名稱未取得')}
                                                            </small>
                                                        </span>
                                                        <span
                                                            className={`${styles.points} ${panel.dirText[direction(entry.points)]}`}
                                                        >
                                                            {entry.points > 0
                                                                ? '+'
                                                                : ''}
                                                            {entry.points.toFixed(
                                                                2,
                                                            )}{' '}
                                                            點
                                                        </span>
                                                        <span
                                                            className={`${styles.pct} ${panel.dirText[direction(entry.pct_chg)]}`}
                                                        >
                                                            {entry.pct_chg > 0
                                                                ? '+'
                                                                : ''}
                                                            {entry.pct_chg.toFixed(
                                                                2,
                                                            )}
                                                            %
                                                        </span>
                                                    </button>
                                                ))}
                                                {drivers.length === 0 && (
                                                    <div
                                                        className={styles.empty}
                                                    >
                                                        {contributionPending
                                                            ? '訂閱中...'
                                                            : '等待成分股貢獻資料'}
                                                    </div>
                                                )}
                                            </div>
                                        </>
                                    ) : section === 'industries' ? (
                                        <>
                                            <div
                                                className={styles.sectionHeading}
                                            >
                                                <span>產業貢獻分布</span>
                                                <span
                                                    className={styles.areaLegend}
                                                >
                                                    面積＝絕對貢獻
                                                    {industryTotal > 0 &&
                                                        ` · ${industryTotal.toFixed(1)} 點`}
                                                </span>
                                            </div>
                                            {industries.length > 0 ? (
                                                <IndustryTreemap
                                                    entries={industries}
                                                />
                                            ) : (
                                                <div className={styles.empty}>
                                                    {indexPending
                                                        ? '訂閱中...'
                                                        : '等待產業貢獻資料'}
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div
                                                className={styles.sectionHeading}
                                            >
                                                <span>貢獻傳導</span>
                                                <span
                                                    className={styles.areaLegend}
                                                >
                                                    產業流寬＝貢獻點數 ·
                                                    各產業展開前 5 大個股 ·
                                                    非成交資金轉移
                                                </span>
                                            </div>
                                            {stockDetailsPending &&
                                            stockDetails.length === 0 ? (
                                                <div className={styles.empty}>
                                                    正在解析主要個股產業…
                                                </div>
                                            ) : (
                                                <ContributionSankey
                                                    entries={flowDrivers}
                                                    details={stockDetails}
                                                    industries={flowIndustries}
                                                    onPick={onPick}
                                                />
                                            )}
                                        </>
                                    )}
                                </section>
                            </Fragment>
                        ))}
                    </div>
                </>
            ) : (
                <>
                    <div className={styles.controls}>
                        <button
                            className={
                                styles.control[showSignalRules ? 'on' : 'off']
                            }
                            aria-expanded={showSignalRules}
                            aria-haspopup='dialog'
                            onClick={() => setShowSignalRules((open) => !open)}
                        >
                            <SlidersHorizontal size={11} /> 訊號{' '}
                            {enabledSignalRules.length}/{ALL_SIGNAL_RULES.length}
                            {' · '}市場 {enabledSignalExchanges.length}/
                            {SIGNAL_EXCHANGES.length}
                            <ChevronDown size={11} />
                        </button>
                        <button
                            className={
                                styles.control[autoFollowSignals ? 'on' : 'off']
                            }
                            title='新訊號抵達時連動未鎖定的行情面板'
                            aria-pressed={autoFollowSignals}
                            onClick={() =>
                                setAutoFollowSignals((enabled) => !enabled)
                            }
                        >
                            <Link2 size={11} /> 自動跟隨
                        </button>
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
                                : signalCoverage.total === 0
                                  ? '未選擇訂閱'
                                  : signalCoverage.ok === signalCoverage.total
                                    ? `${signalCoverage.ok}/${signalCoverage.total} 訂閱正常`
                                    : `${signalCoverage.ok}/${signalCoverage.total} 訂閱成功`}
                        </span>
                    </div>
                    {showSignalRules && (
                        <>
                            <button
                                className={styles.signalRuleBackdrop}
                                aria-label='關閉訊號多選選單'
                                onClick={() => setShowSignalRules(false)}
                            />
                            <div
                                className={styles.signalRuleFilters}
                                role='dialog'
                                aria-label='訊號與市場篩選'
                            >
                                <div className={styles.signalRuleMenuHeader}>
                                    <strong
                                        className={styles.signalRuleMenuTitle}
                                    >
                                        訊號篩選
                                    </strong>
                                    <span
                                        className={
                                            styles.signalRuleMenuSummary
                                        }
                                    >
                                        已選 {enabledSignalRules.length} 項
                                    </span>
                                    <button
                                        type='button'
                                        className={styles.signalRuleClear}
                                        disabled={
                                            enabledSignalRules.length === 0 &&
                                            enabledSignalExchanges.length === 0
                                        }
                                        onClick={clearSignalFilters}
                                    >
                                        全部清除
                                    </button>
                                </div>
                                <section className={styles.signalMarketSection}>
                                    <button
                                        type='button'
                                        className={styles.signalSectionToggle}
                                        aria-expanded={expandedSignalGroups.includes(
                                            'market',
                                        )}
                                        onClick={() =>
                                            toggleSignalGroup('market')
                                        }
                                    >
                                        {expandedSignalGroups.includes(
                                            'market',
                                        ) ? (
                                            <ChevronDown size={12} />
                                        ) : (
                                            <ChevronRight size={12} />
                                        )}
                                        <span>市場</span>
                                        <small
                                            className={styles.signalGroupCount}
                                        >
                                            {enabledSignalExchanges.length}/
                                            {SIGNAL_EXCHANGES.length}
                                        </small>
                                    </button>
                                    {expandedSignalGroups.includes(
                                        'market',
                                    ) && (
                                        <div
                                            className={
                                                styles.signalMarketOptions
                                            }
                                        >
                                            {SIGNAL_EXCHANGES.map((exchange) => (
                                                <label
                                                    key={exchange}
                                                    className={
                                                        styles.signalRuleOption
                                                    }
                                                >
                                                    <input
                                                        type='checkbox'
                                                        className={
                                                            styles.signalRuleCheckbox
                                                        }
                                                        checked={enabledSignalExchangeSet.has(
                                                            exchange,
                                                        )}
                                                        onChange={() =>
                                                            toggleSignalExchange(
                                                                exchange,
                                                            )
                                                        }
                                                    />
                                                    <span>
                                                        {
                                                            EXCHANGE_LABELS[
                                                                exchange
                                                            ]
                                                        }{' '}
                                                        {exchange}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </section>
                                <div className={styles.signalRuleDivider} />
                                <h4 className={styles.signalRulesHeading}>
                                    訊號規則
                                </h4>
                                <div className={styles.signalRuleGrid}>
                                    {SIGNAL_FAMILIES.map((family) => {
                                        const familyRules =
                                            FAMILY_RULES[family];
                                        const enabledCount = familyRules.filter(
                                            (rule) =>
                                                enabledSignalRuleSet.has(rule),
                                        ).length;
                                        return (
                                            <fieldset
                                                key={family}
                                                className={
                                                    styles.signalRuleGroup
                                                }
                                            >
                                                <legend
                                                    className={
                                                        styles.signalRuleLegend
                                                    }
                                                >
                                                    <button
                                                        type='button'
                                                        className={
                                                            styles.signalRuleCollapseToggle
                                                        }
                                                        aria-expanded={expandedSignalGroups.includes(
                                                            family,
                                                        )}
                                                        onClick={() =>
                                                            toggleSignalGroup(
                                                                family,
                                                            )
                                                        }
                                                    >
                                                        {expandedSignalGroups.includes(
                                                            family,
                                                        ) ? (
                                                            <ChevronDown
                                                                size={12}
                                                            />
                                                        ) : (
                                                            <ChevronRight
                                                                size={12}
                                                            />
                                                        )}
                                                        <span>
                                                            {
                                                                FAMILY_LABELS[
                                                                    family
                                                                ]
                                                            }
                                                        </span>
                                                        <small
                                                            className={
                                                                styles.signalGroupCount
                                                            }
                                                        >
                                                            {enabledCount}/
                                                            {familyRules.length}
                                                        </small>
                                                    </button>
                                                    <button
                                                        type='button'
                                                        className={
                                                            styles.signalRuleGroupToggle
                                                        }
                                                        onClick={() =>
                                                            toggleSignalFamily(
                                                                family,
                                                            )
                                                        }
                                                    >
                                                        {enabledCount ===
                                                        familyRules.length
                                                            ? '清除'
                                                            : '全選'}
                                                    </button>
                                                </legend>
                                                {expandedSignalGroups.includes(
                                                    family,
                                                ) && (
                                                    <div
                                                        className={
                                                            styles.signalRuleOptions
                                                        }
                                                    >
                                                        {familyRules.map(
                                                            (rule) => (
                                                                <label
                                                                    key={rule}
                                                                    className={
                                                                        styles.signalRuleOption
                                                                    }
                                                                >
                                                                    <input
                                                                        type='checkbox'
                                                                        className={
                                                                            styles.signalRuleCheckbox
                                                                        }
                                                                        checked={enabledSignalRuleSet.has(
                                                                            rule,
                                                                        )}
                                                                        onChange={() =>
                                                                            toggleSignalRule(
                                                                                rule,
                                                                            )
                                                                        }
                                                                    />
                                                                    <span>
                                                                        {
                                                                            RULE_LABELS[
                                                                                rule
                                                                            ]
                                                                        }
                                                                    </span>
                                                                </label>
                                                            ),
                                                        )}
                                                    </div>
                                                )}
                                            </fieldset>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}
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

export function MarketSignalPanel({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    return <MarketPulsePanel onPick={onPick} fixedView="signals" />;
}
