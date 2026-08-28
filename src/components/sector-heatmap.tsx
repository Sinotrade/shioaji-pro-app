// src/components/sector-heatmap.tsx — 產業全景（原類股熱力圖，issue #2 原地
// 升級）。資料源：shioaji 1.7.4 index_components 群組串流（1 秒），查詢僅
// 建底（docs/adr/0001）。兩層：
// - 全景層：產業 treemap — 面積可切換（成交值/|貢獻|/權重）、顏色＝加權
//   漲跌幅、tile 標貢獻點；加權/櫃買切換。
// - 下鑽層：點產業進入，左＝主力貢獻排行（該群 AbsDesc10 串流＋「其他成
//   員」餘量＋產業合計自洽列）、右＝同 10 檔＋餘量磚的磁磚牆（面積＝
//   |貢獻|）；窄面板退化為上下堆疊。header 掛官方類股指數為權威錨點。
//   純串流 — 不掛成員報價、不輪詢 snapshot。

import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { AlertTriangle, ChevronLeft } from 'lucide-react';
import {
    type CSSProperties,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { useIndexComponents } from '../hooks/use-index-components';
import { getIcBootstrapGroupWeights } from '../lib/index-components';
import { useQuote } from '../hooks/use-stream';
import { ensureContract } from '../lib/contracts-cache';
import { useFocusedSector } from '../lib/sector-sync';
import { subscribeQuote } from '../lib/shioaji';
import { loadStockDetails, SECTOR_INDICES } from '../lib/stock-index';
import type { ContractBase } from '../lib/types/contract';
import type { IcProjection } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import { vars } from '../theme.css';
import { Orb } from './orb';
import * as panel from './panel.css';
import * as styles from './sector-heatmap.css';

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
type PanoramaIndexCode = keyof typeof INDICES;
const INDEX_LABELS: Record<PanoramaIndexCode, string> = {
    IX0001: '加權',
    IX0043: '櫃買',
};

// 權重不設面積選項 — 它只是計算貢獻的係數（參考市值權重、盤中恆定），
// 觀察「權值版圖」看貢獻/成交值即可
type SizeMetric = 'amount' | 'contribution';
const SIZE_METRICS: { value: SizeMetric; label: string }[] = [
    { value: 'amount', label: '成交值' },
    { value: 'contribution', label: '貢獻' },
];

const CAT_KEY = 'sj-pro-heatmap-cat'; // 舊鍵沿用：最近下鑽的產業
const SIZE_KEY = 'sj-pro-panorama-size';
const INDEX_KEY = 'sj-pro-panorama-index';
// 左右並排的最小面板寬 — 更窄就退化為上下堆疊
const NARROW_PX = 520;

const GM_CONTRIBUTION: IcProjection = {
    kind: 'group_metric',
    metric: 'contribution',
};
const GM_WPERF: IcProjection = {
    kind: 'group_metric',
    metric: 'weighted_performance',
};
const GM_AMOUNT: IcProjection = { kind: 'group_metric', metric: 'amount' };

interface GroupRow {
    category: string;
    name: string;
    itemCount: number;
    points: number;
    pct: number;
    size: number;
}

function heatStyle(pct: number, extra?: CSSProperties): CSSProperties {
    const color =
        pct > 0 ? vars.color.up : pct < 0 ? vars.color.down : vars.color.flat;
    const alpha = 10 + Math.min(1, Math.abs(pct) / 4) * 46;
    return {
        '--heat-color': color,
        '--heat-alpha': `${alpha.toFixed(0)}%`,
        ...extra,
    } as CSSProperties;
}

function fmtAmount(value: number) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e10 ? 0 : 1)} 億`;
    if (value > 0) return `${Math.round(value / 1e4).toLocaleString('en-US')} 萬`;
    return '--';
}

function fmtPoints(value: number) {
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function fmtPct(value: number) {
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

// callback ref：條件渲染的量測目標（下鑽磚牆）晚於元件 mount 才出現，
// useRef+空依賴 effect 會掛不到 observer — 以元素 state 驅動重掛
function useBoxSize<T extends HTMLElement>() {
    const [element, setElement] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        if (!element || typeof ResizeObserver === 'undefined') return;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            setSize({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);
    return { ref: setElement, size };
}

interface HeatLeaf {
    key: string;
    label: string;
    sub?: string;
    pct: number | null;
    approx?: boolean; // 反推估算值 — 顯示 ≈ 前綴
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    onClick?: () => void;
    title: string;
}

// 共用 squarified treemap 渲染 — 全景層（產業）與下鑽磚牆（個股）皆用
function HeatTreemap({ leaves }: { leaves: HeatLeaf[] }) {
    return (
        <>
            {leaves.map((leaf) => {
                const width = leaf.x1 - leaf.x0;
                const height = leaf.y1 - leaf.y0;
                return (
                    <button
                        key={leaf.key}
                        className={styles.heatTile}
                        style={heatStyle(leaf.pct ?? 0, {
                            left: leaf.x0,
                            top: leaf.y0,
                            width,
                            height,
                        })}
                        title={leaf.title}
                        onClick={leaf.onClick}
                    >
                        {width >= 46 && height >= 24 && (
                            <span className={styles.tileName}>{leaf.label}</span>
                        )}
                        {leaf.pct !== null && width >= 52 && height >= 38 && (
                            <span
                                className={`${styles.tilePct} ${
                                    panel.dirText[
                                        leaf.pct > 0
                                            ? 'up'
                                            : leaf.pct < 0
                                              ? 'down'
                                              : 'flat'
                                    ]
                                }`}
                            >
                                {leaf.approx ? '≈' : ''}
                                {fmtPct(leaf.pct)}
                            </span>
                        )}
                        {leaf.sub !== undefined &&
                            width >= 82 &&
                            height >= 54 && (
                                <span className={styles.tileSub}>
                                    {leaf.sub}
                                </span>
                            )}
                    </button>
                );
            })}
        </>
    );
}

function layoutTreemap<T>(
    items: T[],
    value: (item: T) => number,
    width: number,
    height: number,
): { item: T; x0: number; y0: number; x1: number; y1: number }[] {
    if (width <= 0 || height <= 0) return [];
    type Datum = { item?: T; children?: Datum[] };
    const root = hierarchy<Datum>({
        children: items.map((item) => ({ item })),
    })
        .sum((datum) => (datum.item ? Math.max(0, value(datum.item)) : 0))
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laidOut = treemap<Datum>()
        .tile(treemapSquarify.ratio(1.35))
        .size([width, height])
        .paddingInner(2)
        .round(true)(root);
    return laidOut
        .leaves()
        .filter((leaf) => (leaf.value ?? 0) > 0 && leaf.data.item !== undefined)
        .map((leaf) => ({
            item: leaf.data.item as T,
            x0: leaf.x0,
            y0: leaf.y0,
            x1: leaf.x1,
            y1: leaf.y1,
        }));
}

export function SectorHeatmap({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const [indexCode, setIndexCode] = useState<PanoramaIndexCode>(() =>
        localStorage.getItem(INDEX_KEY) === 'IX0043' ? 'IX0043' : 'IX0001',
    );
    const [sizeMetric, setSizeMetric] = useState<SizeMetric>(() =>
        localStorage.getItem(SIZE_KEY) === 'contribution'
            ? 'contribution'
            : 'amount',
    );
    const [drillCat, setDrillCat] = useState<string | null>(null);
    const [nameByCode, setNameByCode] = useState<ReadonlyMap<string, string>>(
        () => new Map(),
    );
    const { ref: rootRef, size: rootSize } = useBoxSize<HTMLDivElement>();
    const narrow = rootSize.width > 0 && rootSize.width < NARROW_PX;

    // 下鑽排行指標跟隨面積選擇（群組內排行 published matrix 恰好就是
    // 貢獻 AbsDesc10 與成交值 Desc10 兩種）
    const drillMetric: 'contribution' | 'amount' = sizeMetric;
    const projections = useMemo<IcProjection[]>(() => {
        const list: IcProjection[] = [GM_CONTRIBUTION, GM_WPERF];
        if (sizeMetric === 'amount') list.push(GM_AMOUNT);
        if (drillCat) {
            list.push(
                sizeMetric === 'amount'
                    ? {
                          kind: 'ranking',
                          target: 'component',
                          metric: 'amount',
                          order: 'desc',
                          limit: 10,
                          group: drillCat,
                      }
                    : {
                          kind: 'ranking',
                          target: 'component',
                          metric: 'contribution',
                          order: 'abs_desc',
                          limit: 10,
                          group: drillCat,
                      },
            );
        }
        return list;
    }, [drillCat, sizeMetric]);
    const ic = useIndexComponents(INDICES[indexCode], projections);
    const contributionState = ic.states[0];
    const wperfState = ic.states[1];
    const sizeState =
        sizeMetric === 'amount' ? ic.states[2] : contributionState;
    const drillState = drillCat
        ? ic.states[projections.length - 1]
        : undefined;
    const icError =
        ic.subErrors.find(Boolean) ??
        (ic.bootstrap.status === 'error' || ic.bootstrap.status === 'quota'
            ? ic.bootstrap.error
            : undefined);

    const groupRows = useMemo<GroupRow[]>(() => {
        const base = contributionState?.groups ?? [];
        const pctByCat = new Map(
            (wperfState?.groups ?? []).map((group) => [
                group.category,
                group.value,
            ]),
        );
        const sizeByCat = new Map(
            (sizeState?.groups ?? []).map((group) => [
                group.category,
                group.value,
            ]),
        );
        return base.map((group) => ({
            category: group.category,
            name: group.name,
            itemCount: group.item_count,
            points: group.value,
            pct: pctByCat.get(group.category) ?? 0,
            size: Math.abs(sizeByCat.get(group.category) ?? 0),
        }));
    }, [contributionState, sizeState, wperfState]);
    const groupByCat = useMemo(
        () => new Map(groupRows.map((group) => [group.category, group])),
        [groupRows],
    );
    const isSimtrade =
        contributionState?.simtrade ||
        wperfState?.simtrade ||
        drillState?.simtrade;

    // 版面連動（跳同類）→ 直接下鑽該產業；類別碼可能帶前導零，數值化比對
    const focused = useFocusedSector();
    useEffect(() => {
        if (!focused?.category) return;
        const wanted = Number(focused.category);
        if (!Number.isFinite(wanted)) return;
        const match = groupRows.find(
            (group) => Number(group.category) === wanted,
        );
        if (match) {
            setDrillCat(match.category);
            localStorage.setItem(CAT_KEY, match.category);
        }
        // groupRows 故意不進依賴 — 只在連動事件觸發時反應一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focused?.seq]);

    // 下鑽排行的個股名稱（僅 10 檔，經 contracts 快取懶載）
    const drillCodes = (drillState?.entries ?? [])
        .map((entry) => entry.code)
        .join(',');
    useEffect(() => {
        if (!drillCodes) return;
        let active = true;
        void loadStockDetails(drillCodes.split(','))
            .then((details) => {
                if (!active) return;
                setNameByCode((current) => {
                    const next = new Map(current);
                    details.forEach((detail) =>
                        next.set(detail.code, detail.name),
                    );
                    return next;
                });
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [drillCodes]);

    // 下鑽 header 的官方類股指數（僅上市有對應官方指數）
    const officialSector =
        drillCat && indexCode === 'IX0001'
            ? SECTOR_INDICES.find(
                  (sector) => Number(sector.category) === Number(drillCat),
              )
            : undefined;
    useEffect(() => {
        if (!officialSector) return;
        void ensureContract(officialSector.index, 'IND')
            .then((contract) => subscribeQuote(contract, 'Quote'))
            .catch(() => undefined);
    }, [officialSector?.index]);
    const officialQuote = useQuote(officialSector?.index ?? null)?.index;
    const officialClose = Number(officialQuote?.close);
    const officialReference = Number(officialQuote?.reference);
    const officialPct =
        Number.isFinite(officialClose) &&
        Number.isFinite(officialReference) &&
        officialReference > 0
            ? ((officialClose - officialReference) / officialReference) * 100
            : null;

    const { ref: panoramaRef, size: panoramaSize } =
        useBoxSize<HTMLDivElement>();
    const panoramaLeaves = useMemo<HeatLeaf[]>(
        () =>
            layoutTreemap(
                groupRows.filter((group) => group.size > 0),
                (group) => group.size,
                panoramaSize.width,
                panoramaSize.height,
            ).map(({ item: group, ...rect }) => ({
                ...rect,
                key: group.category,
                label: group.name,
                pct: group.pct,
                // 角落數字跟著面積指標走：成交值模式顯示成交值、貢獻模式顯示貢獻點
                sub:
                    sizeMetric === 'amount'
                        ? fmtAmount(group.size)
                        : `${fmtPoints(group.points)} 點`,
                title: `${group.name}（${group.itemCount} 檔）｜加權漲跌 ${fmtPct(group.pct)}｜貢獻 ${fmtPoints(group.points)} 點${sizeMetric === 'amount' ? `｜成交 ${fmtAmount(group.size)}` : ''}`,
                onClick: () => {
                    setDrillCat(group.category);
                    localStorage.setItem(CAT_KEY, group.category);
                },
            })),
        [groupRows, panoramaSize, sizeMetric],
    );

    // ---- 下鑽層資料：10 檔主力＋餘量＋合計（與群組串流自洽） ----
    const drillGroup = drillCat ? groupByCat.get(drillCat) : undefined;
    const drillEntries = drillState?.entries ?? [];
    const isAmountDrill = drillMetric === 'amount';
    const top10Sum = drillEntries.reduce((sum, entry) => sum + entry.value, 0);
    // 餘量與合計跟著下鑽指標走：貢獻＝群組貢獻點、成交值＝群組總成交值
    const drillTotal = drillGroup
        ? isAmountDrill
            ? drillGroup.size
            : drillGroup.points
        : 0;
    // 成交值餘量 clamp ≥0 — 群組整包與排行整包非同刻，節奏差可瞬現微負
    // （貢獻模式不 clamp：負餘量是合法語意）
    const otherValue = drillGroup
        ? isAmountDrill
            ? Math.max(0, drillTotal - top10Sum)
            : drillTotal - top10Sum
        : 0;
    const otherCount = drillGroup
        ? Math.max(0, drillGroup.itemCount - drillEntries.length)
        : 0;
    const fmtDrillValue = (value: number) =>
        isAmountDrill ? fmtAmount(value) : fmtPoints(value);
    // 其他成員的加權漲跌幅反推：群組加權漲跌（wperf 串流）＝全員權重加權
    // 平均，扣掉排行前 10 的權重×漲跌即得餘量。權重取建底參考權重（盤中
    // 恆定）；兩串流節奏差（1s vs 5s）帶來的微小誤差以 ≈ 標示，並夾在
    // 台股漲跌停幅度內防瞬間偏斜。
    const drillGroupWeight = useMemo(
        () =>
            drillCat
                ? getIcBootstrapGroupWeights(indexCode)?.get(drillCat)
                : undefined,
        // ic 每個 store 版本換新物件 — 建底抵達/日切後自動更新
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [drillCat, ic, indexCode],
    );
    const otherPct = useMemo(() => {
        if (
            drillGroupWeight === undefined ||
            !drillGroup ||
            drillEntries.length === 0
        ) {
            return null;
        }
        const topWeight = drillEntries.reduce(
            (sum, entry) => sum + entry.weight_pct,
            0,
        );
        const restWeight = drillGroupWeight - topWeight;
        if (restWeight <= 1e-6) return null;
        const topWeighted = drillEntries.reduce(
            (sum, entry) => sum + entry.weight_pct * entry.pct_chg,
            0,
        );
        const estimate =
            (drillGroupWeight * drillGroup.pct - topWeighted) / restWeight;
        if (!Number.isFinite(estimate)) return null;
        return Math.max(-10, Math.min(10, estimate));
    }, [drillEntries, drillGroup, drillGroupWeight]);
    const barScale = drillEntries.reduce(
        (max, entry) => Math.max(max, Math.abs(entry.value)),
        0,
    );

    const { ref: wallRef, size: wallSize } = useBoxSize<HTMLDivElement>();
    const wallLeaves = useMemo<HeatLeaf[]>(() => {
        type WallItem = {
            key: string;
            label: string;
            pct: number | null;
            points: number;
            code?: string;
            count?: number;
        };
        const items: WallItem[] = drillEntries.map((entry) => ({
            key: entry.code,
            label: `${entry.code} ${nameByCode.get(entry.code) ?? ''}`.trim(),
            pct: entry.pct_chg,
            points: entry.value,
            code: entry.code,
        }));
        if (otherCount > 0 && Math.abs(otherValue) > 1e-9) {
            items.push({
                key: 'other',
                label: `其他成員（${otherCount} 檔）`,
                pct: otherPct,
                points: otherValue,
                count: otherCount,
            });
        }
        return layoutTreemap(
            items,
            (item) => Math.abs(item.points),
            wallSize.width,
            wallSize.height,
        ).map(({ item, ...rect }) => ({
            ...rect,
            key: item.key,
            label: item.label,
            pct: item.pct,
            approx: item.code === undefined && item.pct !== null,
            sub: isAmountDrill
                ? fmtAmount(item.points)
                : `${fmtPoints(item.points)} 點`,
            title:
                item.code === undefined
                    ? `${item.label}｜合計${isAmountDrill ? `成交 ${fmtAmount(item.points)}` : `貢獻 ${fmtPoints(item.points)} 點`}${item.pct !== null ? `｜加權漲跌 ≈${fmtPct(item.pct)}（依群組加權與前10反推）` : ''}`
                    : `${item.label}｜${isAmountDrill ? `成交 ${fmtAmount(item.points)}` : `貢獻 ${fmtPoints(item.points)} 點`}｜漲跌 ${fmtPct(item.pct ?? 0)}`,
            onClick: item.code ? () => onPick?.(item.code!) : undefined,
        }));
    }, [
        drillEntries,
        isAmountDrill,
        nameByCode,
        onPick,
        otherCount,
        otherPct,
        otherValue,
        wallSize,
    ]);

    const bootstrapPending =
        ic.bootstrap.status === 'pending' || ic.bootstrap.status === 'idle';

    // ---- render ----

    const drillView = drillCat !== null;

    return (
        <div ref={rootRef} className={styles.wrap}>
            {icError && (
                <div className={styles.error}>
                    <AlertTriangle size={12} />
                    {icError}
                </div>
            )}
            {!drillView ? (
                <>
                    <div className={styles.toolbar}>
                        <span className={styles.segmentGroup}>
                            {(
                                Object.keys(INDICES) as PanoramaIndexCode[]
                            ).map((code) => (
                                <button
                                    key={code}
                                    className={
                                        styles.segment[
                                            code === indexCode ? 'on' : 'off'
                                        ]
                                    }
                                    aria-pressed={code === indexCode}
                                    onClick={() => {
                                        setIndexCode(code);
                                        setDrillCat(null);
                                        localStorage.setItem(INDEX_KEY, code);
                                    }}
                                >
                                    {INDEX_LABELS[code]}
                                </button>
                            ))}
                        </span>
                        <span className={styles.segmentGroup}>
                            {SIZE_METRICS.map((metric) => (
                                <button
                                    key={metric.value}
                                    className={
                                        styles.segment[
                                            metric.value === sizeMetric
                                                ? 'on'
                                                : 'off'
                                        ]
                                    }
                                    aria-pressed={metric.value === sizeMetric}
                                    title={`面積＝${metric.label}`}
                                    onClick={() => {
                                        setSizeMetric(metric.value);
                                        localStorage.setItem(
                                            SIZE_KEY,
                                            metric.value,
                                        );
                                    }}
                                >
                                    {metric.label}
                                </button>
                            ))}
                        </span>
                        <span className={styles.hint}>
                            面積＝
                            {
                                SIZE_METRICS.find(
                                    (metric) => metric.value === sizeMetric,
                                )!.label
                            }
                            ・色＝加權漲跌幅・點產業下鑽
                        </span>
                        <span className={styles.spacer} />
                        {isSimtrade && (
                            <span className={styles.simtrade}>試撮</span>
                        )}
                    </div>
                    <div ref={panoramaRef} className={styles.treemapBox}>
                        <HeatTreemap leaves={panoramaLeaves} />
                        {panoramaLeaves.length === 0 && (
                            <div className={styles.empty}>
                                {bootstrapPending && !icError ? (
                                    <>
                                        <Orb size={12} />
                                        產業資料載入中…
                                    </>
                                ) : (
                                    '等待產業資料'
                                )}
                            </div>
                        )}
                    </div>
                </>
            ) : (
                <>
                    <div className={styles.toolbar}>
                        <button
                            className={styles.backBtn}
                            onClick={() => setDrillCat(null)}
                            title="回產業全景"
                        >
                            <ChevronLeft size={13} />
                            全景
                        </button>
                        <span className={styles.crumbName}>
                            {drillGroup?.name ?? ''}
                            {drillGroup && (
                                <span className={styles.hint}>
                                    {' '}
                                    {drillGroup.itemCount} 檔
                                </span>
                            )}
                        </span>
                        {drillGroup && (
                            <span
                                className={`${styles.officialQuote} ${
                                    panel.dirText[
                                        drillGroup.pct > 0
                                            ? 'up'
                                            : drillGroup.pct < 0
                                              ? 'down'
                                              : 'flat'
                                    ]
                                }`}
                                title="成分加權漲跌幅（自算）"
                            >
                                {fmtPct(drillGroup.pct)}
                            </span>
                        )}
                        {officialSector && officialPct !== null && (
                            <span
                                className={styles.officialQuote}
                                title={`官方${officialSector.label}類指數（${officialSector.index}）`}
                            >
                                <span className={styles.officialLabel}>
                                    官方
                                </span>
                                <span
                                    className={
                                        panel.dirText[
                                            officialPct > 0
                                                ? 'up'
                                                : officialPct < 0
                                                  ? 'down'
                                                  : 'flat'
                                        ]
                                    }
                                >
                                    {fmtPrice(officialClose)}（
                                    {fmtPct(officialPct)}）
                                </span>
                            </span>
                        )}
                        <span className={styles.spacer} />
                        <span className={styles.segmentGroup}>
                            {SIZE_METRICS.map((metric) => (
                                <button
                                    key={metric.value}
                                    className={
                                        styles.segment[
                                            metric.value === sizeMetric
                                                ? 'on'
                                                : 'off'
                                        ]
                                    }
                                    aria-pressed={metric.value === sizeMetric}
                                    title={`排行＝${metric.label}`}
                                    onClick={() => {
                                        setSizeMetric(metric.value);
                                        localStorage.setItem(
                                            SIZE_KEY,
                                            metric.value,
                                        );
                                    }}
                                >
                                    {metric.label}
                                </button>
                            ))}
                        </span>
                        {isSimtrade && (
                            <span className={styles.simtrade}>試撮</span>
                        )}
                    </div>
                    <div className={styles.drillBody[narrow ? 'column' : 'row']}>
                        <div className={styles.rankPane[narrow ? 'column' : 'row']}>
                            <div className={styles.rankHeader}>
                                <span />
                                <span>
                                    {isAmountDrill ? '成交值排行' : '主力貢獻'}
                                </span>
                                <span className={styles.rankHeaderCell}>
                                    漲跌幅
                                </span>
                                <span />
                                <span className={styles.rankHeaderCell}>
                                    {isAmountDrill ? '成交值' : '貢獻（點）'}
                                </span>
                            </div>
                            {drillEntries.map((entry, idx) => {
                                const ratio =
                                    barScale > 0
                                        ? Math.min(
                                              1,
                                              Math.abs(entry.value) / barScale,
                                          )
                                        : 0;
                                const dir =
                                    entry.value > 0
                                        ? 'up'
                                        : entry.value < 0
                                          ? 'down'
                                          : 'flat';
                                return (
                                    <button
                                        key={entry.code}
                                        className={styles.rankRow}
                                        title={`權重 ${entry.weight_pct.toFixed(2)}%`}
                                        onClick={() => onPick?.(entry.code)}
                                    >
                                        <span className={styles.rankIndex}>
                                            {idx + 1}
                                        </span>
                                        <span className={styles.rankCode}>
                                            {entry.code}
                                            <small
                                                className={styles.rankName}
                                            >
                                                {nameByCode.get(entry.code) ??
                                                    ''}
                                            </small>
                                        </span>
                                        <span
                                            className={`${styles.rankPct} ${
                                                panel.dirText[
                                                    entry.pct_chg > 0
                                                        ? 'up'
                                                        : entry.pct_chg < 0
                                                          ? 'down'
                                                          : 'flat'
                                                ]
                                            }`}
                                        >
                                            {fmtPct(entry.pct_chg)}
                                        </span>
                                        {isAmountDrill ? (
                                            <span className={styles.barCell}>
                                                <span
                                                    className={
                                                        styles.barFillAmount
                                                    }
                                                    style={{
                                                        width: `${(ratio * 100).toFixed(1)}%`,
                                                    }}
                                                />
                                            </span>
                                        ) : (
                                            <span className={styles.barCell}>
                                                <span
                                                    className={
                                                        styles.barHalfNeg
                                                    }
                                                >
                                                    {entry.value < 0 && (
                                                        <span
                                                            className={
                                                                styles.barFillNeg
                                                            }
                                                            style={{
                                                                width: `${(ratio * 100).toFixed(1)}%`,
                                                            }}
                                                        />
                                                    )}
                                                </span>
                                                <span
                                                    className={styles.barAxis}
                                                />
                                                <span
                                                    className={
                                                        styles.barHalfPos
                                                    }
                                                >
                                                    {entry.value > 0 && (
                                                        <span
                                                            className={
                                                                styles.barFillPos
                                                            }
                                                            style={{
                                                                width: `${(ratio * 100).toFixed(1)}%`,
                                                            }}
                                                        />
                                                    )}
                                                </span>
                                            </span>
                                        )}
                                        <span
                                            className={`${styles.rankPoints} ${isAmountDrill ? '' : panel.dirText[dir]}`}
                                        >
                                            {fmtDrillValue(entry.value)}
                                        </span>
                                    </button>
                                );
                            })}
                            {drillEntries.length === 0 && (
                                <div className={styles.empty}>
                                    {icError ? (
                                        '排行資料無法取得'
                                    ) : (
                                        <>
                                            <Orb size={12} />
                                            排行載入中…
                                        </>
                                    )}
                                </div>
                            )}
                            {drillEntries.length > 0 && drillGroup && (
                                <>
                                    {otherCount > 0 && (
                                        <div className={styles.summaryRow}>
                                            <span />
                                            <span
                                                className={styles.totalLabel}
                                            >
                                                其他成員（{otherCount} 檔）
                                            </span>
                                            <span
                                                className={`${styles.rankPct} ${
                                                    otherPct === null
                                                        ? ''
                                                        : panel.dirText[
                                                              otherPct > 0
                                                                  ? 'up'
                                                                  : otherPct <
                                                                      0
                                                                    ? 'down'
                                                                    : 'flat'
                                                          ]
                                                }`}
                                                title="依群組加權漲跌與前10檔反推的估算值"
                                            >
                                                {otherPct === null
                                                    ? ''
                                                    : `≈${fmtPct(otherPct)}`}
                                            </span>
                                            <span
                                                className={`${styles.rankPoints} ${styles.summaryValue} ${
                                                    isAmountDrill
                                                        ? ''
                                                        : panel.dirText[
                                                              otherValue > 0
                                                                  ? 'up'
                                                                  : otherValue <
                                                                      0
                                                                    ? 'down'
                                                                    : 'flat'
                                                          ]
                                                }`}
                                            >
                                                {fmtDrillValue(otherValue)}
                                            </span>
                                        </div>
                                    )}
                                    <div className={styles.totalRow}>
                                        <span />
                                        <span className={styles.totalLabel}>
                                            產業合計
                                        </span>
                                        <span
                                            className={`${styles.rankPct} ${
                                                panel.dirText[
                                                    drillGroup.pct > 0
                                                        ? 'up'
                                                        : drillGroup.pct < 0
                                                          ? 'down'
                                                          : 'flat'
                                                ]
                                            }`}
                                        >
                                            {fmtPct(drillGroup.pct)}
                                        </span>
                                        <span
                                            className={`${styles.rankPoints} ${styles.summaryValue} ${
                                                isAmountDrill
                                                    ? ''
                                                    : panel.dirText[
                                                          drillGroup.points > 0
                                                              ? 'up'
                                                              : drillGroup.points <
                                                                  0
                                                                ? 'down'
                                                                : 'flat'
                                                      ]
                                            }`}
                                        >
                                            {fmtDrillValue(drillTotal)}
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>
                        <div ref={wallRef} className={styles.wallPane}>
                            <HeatTreemap leaves={wallLeaves} />
                            {wallLeaves.length === 0 &&
                                drillEntries.length > 0 && (
                                    <div className={styles.empty}>
                                        等待分布資料
                                    </div>
                                )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
