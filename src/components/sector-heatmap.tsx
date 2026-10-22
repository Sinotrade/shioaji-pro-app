// src/components/sector-heatmap.tsx — 產業全景（原類股熱力圖，issue #2 原地
// 升級）。資料源：shioaji index_components 群組／群組內排行串流（1 秒），
// 查詢僅建底（docs/adr/0001）。兩層：
// - 全景層：產業 → 個股兩層 treemap。每個產業訂閱群組內排行（成交值
//   desc/10 或貢獻 abs_desc/10），產業頂端標題列＝名稱＋加權漲跌，個股
//   tile 面積＝市值（參考權重）／成交值／|貢獻|、顏色＝漲跌幅（連續色階）。
//   面板夠寬時右側加產業漲跌排行與貢獻前後。可匯出 PNG。
// - 下鑽層：點產業標題進入，左＝主力貢獻排行（該群 AbsDesc10 串流＋「其他
//   成員」餘量＋產業合計自洽列）、右＝同 10 檔＋餘量磚的磁磚牆；窄面板
//   退化為上下堆疊。header 掛官方類股指數為權威錨點。
//   純串流 — 不掛成員報價、不輪詢 snapshot。

import { AlertTriangle, ChevronLeft, ImageDown } from 'lucide-react';
import { LayoutGroup, motion, MotionConfig } from 'motion/react';
import {
    type CSSProperties,
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useCoalescedStates } from '../hooks/use-coalesced-states';
import { useIndexComponents } from '../hooks/use-index-components';
import { useBoxSize } from '../hooks/use-box-size';
import { useQuote } from '../hooks/use-stream';
import { fitHeatLabel, type HeatLabelFit } from '../lib/heat-label';
import {
    heatBudget,
    layoutFlat,
    layoutNested,
    type Rect,
    selectHeatItems,
    type SplitMemo,
    weightWithFallback,
    stableOrder,
} from '../lib/heat-layout';
import {
    heatColor,
    heatInk,
    heatPalette,
    heatRgb,
    legendColors,
    rgbCss,
    SECTOR_HEAT_DOMAIN,
    STOCK_HEAT_DOMAIN,
    type HeatPalette,
} from '../lib/heat-scale';
import {
    exportFileName,
    renderHeatmapPng,
    saveHeatmapPng,
} from '../lib/heatmap-export';
import {
    getIcBootstrapGroupWeights,
    getIcGroupWperfAt,
} from '../lib/index-components';
import { estimateOtherPct } from '../lib/sector-other-pct';
import { useFocusedSector } from '../lib/sector-sync';
import { loadStockDetails, SECTOR_INDICES } from '../lib/stock-index';
import { useThemeSettings } from '../lib/theme-store';
import { notify } from '../lib/trade';
import type { ContractBase } from '../lib/types/contract';
import type { IcProjection, IcRankingEntry } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import {
    PANORAMA_INDEX_CODES,
    PANORAMA_INDEX_LABELS,
    type PanoramaIndexCode,
} from '../lib/workspace';
import { vars } from '../theme.css';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import * as styles from './sector-heatmap.css';

const INDICES: Record<PanoramaIndexCode, ContractBase> = {
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
const INDEX_LABELS = PANORAMA_INDEX_LABELS;

// 面積：市值（建底參考市值權重，盤中恆定 → 版圖最穩定）／成交值／|貢獻|
type SizeMetric = 'weight' | 'amount' | 'contribution';
const SIZE_METRICS: { value: SizeMetric; label: string }[] = [
    { value: 'weight', label: '市值' },
    { value: 'amount', label: '成交值' },
    { value: 'contribution', label: '貢獻' },
];
// 預設面積＝貢獻（使用者 2026-10-21 決定）；已存的選擇照舊沿用
export function initialSizeMetric(stored: string | null): SizeMetric {
    return stored === 'weight' || stored === 'amount' || stored === 'contribution'
        ? stored
        : 'contribution';
}
// 下鑽排行只有成交值／貢獻兩種（群組內排行 published matrix）
type DrillMetric = 'amount' | 'contribution';
const DRILL_METRICS: { value: DrillMetric; label: string }[] = [
    { value: 'amount', label: '成交值' },
    { value: 'contribution', label: '貢獻' },
];

// 其他成員漲跌幅不顯示時的說明（資料不同刻／餘量權重過小／超出漲跌停）
const OTHER_PCT_UNAVAILABLE =
    '加權漲跌暫無法可靠估算（尚無與排行同時點的群組資料，或餘量權重過小）';

const CAT_KEY = 'sj-pro-heatmap-cat'; // 舊鍵沿用：最近下鑽的產業
const SIZE_KEY = 'sj-pro-panorama-size';
const INDEX_KEY = 'sj-pro-panorama-index';
// 左右並排的最小面板寬 — 更窄就退化為上下堆疊
const NARROW_PX = 520;
// 全景側欄（產業排行＋貢獻前後）出現的最小面板寬
const SIDE_PX = 760;
const HEADER_PX = 18;
// 群組內排行每組最多 10 檔（published matrix）
const GROUP_RANK_LIMIT = 10;

const GM_CONTRIBUTION: IcProjection = {
    kind: 'group_metric',
    metric: 'contribution',
};
const GM_WPERF: IcProjection = {
    kind: 'group_metric',
    metric: 'weighted_performance',
};
const GM_AMOUNT: IcProjection = { kind: 'group_metric', metric: 'amount' };
// 全市場貢獻前／後 25（與市場脈動共用同一條投影）
const RK_POS: IcProjection = {
    kind: 'ranking',
    target: 'component',
    metric: 'contribution',
    order: 'positive_desc',
    limit: 25,
};
const RK_NEG: IcProjection = {
    kind: 'ranking',
    target: 'component',
    metric: 'contribution',
    order: 'negative_asc',
    limit: 25,
};

function groupRanking(metric: DrillMetric, group: string): IcProjection {
    return metric === 'amount'
        ? {
              kind: 'ranking',
              target: 'component',
              metric: 'amount',
              order: 'desc',
              limit: GROUP_RANK_LIMIT,
              group,
          }
        : {
              kind: 'ranking',
              target: 'component',
              metric: 'contribution',
              order: 'abs_desc',
              limit: GROUP_RANK_LIMIT,
              group,
          };
}

interface GroupRow {
    category: string;
    name: string;
    itemCount: number;
    points: number;
    pct: number;
    size: number;
}

function fmtAmount(value: number) {
    if (value >= 1e12) return `${(value / 1e12).toFixed(2)} 兆`;
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

// 標題列／排行用的短名：去掉「工業」「業」字尾（半導體業→半導體、塑膠工業→塑膠）
function shortSectorName(name: string): string {
    const short = name.replace(/(工業|業)$/, '');
    return short.length > 0 ? short : name;
}

const dirOf = (value: number) => (value > 0 ? 'up' : value < 0 ? 'down' : 'flat');

interface TileView {
    key: string;
    code: string;
    name: string;
    rect: Rect;
    pct: number | null;
    pctText: string | null;
    sub?: string;
    fill: string;
    ink: string;
    fit: HeatLabelFit;
    title: string;
    onClick?: () => void;
}

function buildTile(
    palette: HeatPalette,
    domain: number,
    t: Omit<TileView, 'fill' | 'ink' | 'fit'>,
): TileView {
    const rgb = heatRgb(t.pct, domain, palette);
    return {
        ...t,
        fill: rgbCss(rgb),
        ink: heatInk(rgb, palette),
        fit: fitHeatLabel(t.rect.w, t.rect.h, t.name, t.pctText, t.code),
    };
}

// tile 依 key 排序後渲染：DOM 節點順序固定，位置／尺寸／顏色的 CSS
// transition 才不會因節點搬移而中斷
// memo：父層因串流版本重繪但 tiles 沒變時，不重新比對整片按鈕
const HeatTiles = memo(function HeatTiles({ tiles }: { tiles: TileView[] }) {
    const sorted = useMemo(
        () => [...tiles].sort((a, b) => (a.key < b.key ? -1 : 1)),
        [tiles],
    );
    return (
        <>
            {sorted.map((tile) => {
                const { fit } = tile;
                const showSub =
                    tile.sub !== undefined &&
                    fit.mode === 'both' &&
                    tile.rect.h >= fit.fontSize * 3.6 + 16;
                return (
                    <button
                        key={tile.key}
                        className={styles.heatTile}
                        style={{
                            left: tile.rect.x,
                            top: tile.rect.y,
                            width: tile.rect.w,
                            height: tile.rect.h,
                            background: tile.fill,
                            color: tile.ink,
                        }}
                        title={tile.title}
                        aria-label={tile.title}
                        onClick={tile.onClick}
                    >
                        {fit.mode !== 'none' && (
                            <span
                                className={styles.tileName}
                                style={{ fontSize: fit.fontSize }}
                            >
                                {fit.mode === 'code' ? tile.code : tile.name}
                            </span>
                        )}
                        {fit.mode === 'both' && tile.pctText && (
                            <span
                                className={styles.tilePct}
                                style={{
                                    fontSize: Math.round(fit.fontSize * 0.86),
                                }}
                            >
                                {tile.pctText}
                            </span>
                        )}
                        {showSub && (
                            <span className={styles.tileSub}>{tile.sub}</span>
                        )}
                    </button>
                );
            })}
        </>
    );
});

function Legend({ palette, domain }: { palette: HeatPalette; domain: number }) {
    const colors = legendColors(domain, palette);
    return (
        <span
            className={styles.legend}
            aria-label={`色階範圍 正負 ${domain}%`}
        >
            -{domain}%
            <span className={styles.legendBar}>
                {colors.map((color, i) => (
                    <span
                        key={i}
                        className={styles.legendCell}
                        style={{ background: color }}
                    />
                ))}
            </span>
            +{domain}%
        </span>
    );
}

const NO_PROJECTIONS: IcProjection[] = [];

interface PanoramaStock {
    key: string;
    weight: number;
    entry: IcRankingEntry;
}

export function SectorHeatmap({
    onPick,
    index,
    onIndexChange,
}: {
    onPick?: (code: string) => void;
    /**
     * 版面為這個面板指定的市場（跟版面一起持久化）；缺省 = 沿用上次選擇。
     * 同時開多個產業全景時，各面板各存各的（加權／櫃買並排免切換）。
     */
    index?: PanoramaIndexCode;
    onIndexChange?: (index: PanoramaIndexCode) => void;
}) {
    const theme = useThemeSettings();
    const palette = useMemo(
        () => heatPalette(theme),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [theme.mode, theme.convention, theme.custom],
    );
    const [indexCode, setIndexCode] = useState<PanoramaIndexCode>(
        () =>
            index ??
            (localStorage.getItem(INDEX_KEY) === 'IX0043' ? 'IX0043' : 'IX0001'),
    );
    const [sizeMetric, setSizeMetric] = useState<SizeMetric>(() =>
        initialSizeMetric(localStorage.getItem(SIZE_KEY)),
    );
    const [drillCat, setDrillCat] = useState<string | null>(null);
    // 版面指定的市場優先：換版面或外部改欄位時都要跟上
    useEffect(() => {
        if (index) setIndexCode(index);
    }, [index]);
    const selectIndex = useCallback(
        (code: PanoramaIndexCode) => {
            setIndexCode(code);
            setDrillCat(null);
            localStorage.setItem(INDEX_KEY, code);
            onIndexChange?.(code);
        },
        [onIndexChange],
    );
    const [nameByCode, setNameByCode] = useState<ReadonlyMap<string, string>>(
        () => new Map(),
    );
    const { ref: rootRef, size: rootSize } = useBoxSize<HTMLDivElement>();
    const narrow = rootSize.width > 0 && rootSize.width < NARROW_PX;
    const showSide = drillCat === null && rootSize.width >= SIDE_PX;

    // 群組內排行與下鑽排行的指標：市值面積沿用成交值排行（published
    // matrix 沒有群組內權重排行）
    const rankMetric: DrillMetric =
        sizeMetric === 'contribution' ? 'contribution' : 'amount';
    const drillMetric = rankMetric;

    // 各自獨立的 useIndexComponents：切換下鑽／側欄只動自己那幾條訂閱
    const baseIc = useIndexComponents(
        INDICES[indexCode],
        useMemo(() => [GM_CONTRIBUTION, GM_WPERF, GM_AMOUNT], []),
    );
    const contributionState = baseIc.states[0];
    const wperfState = baseIc.states[1];
    const amountState = baseIc.states[2];

    // 產業清單（建底／群組串流抵達後才知道）→ 每個產業一條群組內排行
    const categoriesKey = (contributionState?.groups ?? [])
        .map((group) => group.category)
        .sort()
        .join(',');
    // 下鑽時全景隱藏：全景的群組排行凍結在進入下鑽前的指標，下鑽內切換
    // 成交值／貢獻只換下鑽那一條訂閱，不讓 G 個產業整批退訂再重訂
    const [groupMetric, setGroupMetric] = useState<DrillMetric>(rankMetric);
    if (drillCat === null && groupMetric !== rankMetric) {
        setGroupMetric(rankMetric);
    }
    const groupProjections = useMemo(
        () =>
            categoriesKey
                ? categoriesKey
                      .split(',')
                      .map((category) => groupRanking(groupMetric, category))
                : NO_PROJECTIONS,
        [categoriesKey, groupMetric],
    );
    const groupIc = useIndexComponents(INDICES[indexCode], groupProjections);
    const sideIc = useIndexComponents(
        INDICES[indexCode],
        useMemo(() => (showSide ? [RK_POS, RK_NEG] : NO_PROJECTIONS), [showSide]),
    );
    const drillIc = useIndexComponents(
        INDICES[indexCode],
        useMemo(
            () =>
                drillCat ? [groupRanking(drillMetric, drillCat)] : NO_PROJECTIONS,
            [drillCat, drillMetric],
        ),
    );
    const drillState = drillCat ? drillIc.states[0] : undefined;
    const sizeState =
        sizeMetric === 'contribution' ? contributionState : amountState;
    const icError =
        [...baseIc.subErrors, ...groupIc.subErrors, ...drillIc.subErrors].find(
            Boolean,
        ) ??
        (baseIc.bootstrap.status === 'error' ||
        baseIc.bootstrap.status === 'quota'
            ? baseIc.bootstrap.error
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
    // 全景 header 加總：Σ群組成交值＝大盤總成交、Σ群組貢獻＝指數漲跌點
    const totalAmount = useMemo(
        () =>
            (amountState?.groups ?? []).reduce(
                (sum, group) => sum + group.value,
                0,
            ),
        [amountState],
    );
    const totalPoints = useMemo(
        () =>
            (contributionState?.groups ?? []).reduce(
                (sum, group) => sum + group.value,
                0,
            ),
        [contributionState],
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

    // ---- 全景層：產業 → 個股兩層 treemap ----
    const { ref: panoramaRef, size: panoramaSize, resizing } =
        useBoxSize<HTMLDivElement>();
    const groupStates = useCoalescedStates(
        groupIc.states,
        `${indexCode}|${groupMetric}|${categoriesKey}`,
        250,
        drillCat !== null,
    );
    const groupEntries = useMemo(() => {
        const map = new Map<string, IcRankingEntry[]>();
        groupProjections.forEach((projection, i) => {
            if (projection.kind !== 'ranking' || !projection.group) return;
            map.set(projection.group, groupStates[i]?.entries ?? []);
        });
        return map;
    }, [groupStates, groupProjections]);
    // 排序遲滯：以上一次的順序為底，同一個指數／面積指標內延續
    const orderRef = useRef<{
        scope: string;
        groups: string[];
        stocks: Map<string, string[]>;
        split: SplitMemo;
    }>({ scope: '', groups: [], stocks: new Map(), split: new Map() });
    const panorama = useMemo(() => {
        const scope = `${indexCode}|${sizeMetric}`;
        if (orderRef.current.scope !== scope) {
            orderRef.current = {
                scope,
                groups: [],
                stocks: new Map(),
                split: new Map(),
            };
        }
        const memo = orderRef.current;
        const metricWeight = (entry: IcRankingEntry) =>
            sizeMetric === 'weight'
                ? entry.weight_pct
                : Math.abs(entry.value);
        // 開盤前／全部平盤時貢獻皆為 0：面積改用市值權重，不讓已載入的資料
        // 整片消失、一直停在「等待產業資料」
        const { weight: weightOf, fallback: weightFallback } =
            weightWithFallback(
                groupRows.map((row) => groupEntries.get(row.category) ?? []),
                metricWeight,
                (entry) => entry.weight_pct,
            );
        const groupsIn = groupRows.map((row) => {
            const items: PanoramaStock[] = (
                groupEntries.get(row.category) ?? []
            ).map((entry) => ({
                key: entry.code,
                weight: weightOf(entry),
                entry,
            }));
            const order = stableOrder(memo.stocks.get(row.category), items);
            memo.stocks.set(row.category, order);
            const byKey = new Map(items.map((item) => [item.key, item]));
            const stocks = order.map((key) => byKey.get(key)!);
            return {
                key: row.category,
                row,
                stocks,
                weight: stocks.reduce((sum, stock) => sum + stock.weight, 0),
            };
        });
        const groupOrder = stableOrder(memo.groups, groupsIn);
        memo.groups = groupOrder;
        const groupIn = new Map(groupsIn.map((group) => [group.key, group]));
        const ordered = groupOrder.map((key) => groupIn.get(key)!);
        const budget = heatBudget(
            panoramaSize.width,
            panoramaSize.height,
            GROUP_RANK_LIMIT,
        );
        const selected = selectHeatItems(ordered, budget);
        const nextSplit: SplitMemo = new Map();
        const layout = layoutNested(
            selected.map(({ group, stocks }) => ({ key: group.key, stocks })),
            panoramaSize.width,
            panoramaSize.height,
            HEADER_PX,
            memo.split,
            nextSplit,
        );
        memo.split = nextSplit;
        return {
            selected,
            layout,
            groupCount: groupsIn.filter((g) => g.weight > 0).length,
            weightFallback,
        };
    }, [groupEntries, groupRows, indexCode, panoramaSize, sizeMetric]);

    // 個股名稱（入選者，經 contracts 快取懶載）
    const posEntries = sideIc.states[0]?.entries ?? [];
    const negEntries = sideIc.states[1]?.entries ?? [];
    const drillEntries = drillState?.entries ?? [];
    const wantedCodes = [
        ...panorama.layout.tiles.map((tile) => tile.key),
        ...posEntries.map((entry) => entry.code),
        ...negEntries.map((entry) => entry.code),
        ...drillEntries.map((entry) => entry.code),
    ]
        .filter((code) => !nameByCode.has(code))
        .sort()
        .join(',');
    useEffect(() => {
        if (!wantedCodes) return;
        let active = true;
        void loadStockDetails(wantedCodes.split(','))
            .then((details) => {
                if (!active || details.length === 0) return;
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
    }, [wantedCodes]);

    const openDrill = useCallback((category: string) => {
        setDrillCat(category);
        localStorage.setItem(CAT_KEY, category);
    }, []);

    const panoramaTiles = useMemo<TileView[]>(() => {
        const stockOf = new Map<string, { stock: PanoramaStock; row: GroupRow }>();
        for (const { group, stocks } of panorama.selected) {
            for (const stock of stocks) {
                stockOf.set(stock.key, { stock, row: group.row });
            }
        }
        // 太小放不下標題列的產業：整塊點擊改為進入產業明細（窄面板沒有
        // 側欄排行，否則就沒有入口）
        const headerless = new Set(
            panorama.layout.sectors
                .filter((sector) => !sector.header)
                .map((sector) => sector.key),
        );
        return panorama.layout.tiles.flatMap((tile) => {
            const hit = stockOf.get(tile.key);
            if (!hit) return [];
            const { entry } = hit.stock;
            const name = nameByCode.get(entry.code) ?? entry.code;
            const valueText =
                groupMetric === 'amount'
                    ? `成交 ${fmtAmount(entry.value)}`
                    : `貢獻 ${fmtPoints(entry.value)} 點`;
            return [
                buildTile(palette, STOCK_HEAT_DOMAIN, {
                    key: entry.code,
                    code: entry.code,
                    name,
                    rect: tile.rect,
                    pct: entry.pct_chg,
                    pctText: fmtPct(entry.pct_chg),
                    title: `${name}（${entry.code}）· ${hit.row.name}\n漲跌 ${fmtPct(entry.pct_chg)} · 權重 ${entry.weight_pct.toFixed(2)}% · ${valueText}${headerless.has(tile.groupKey) ? `\n點擊看${hit.row.name}明細` : ''}`,
                    onClick: headerless.has(tile.groupKey)
                        ? () => openDrill(tile.groupKey)
                        : () => onPick?.(entry.code),
                }),
            ];
        });
    }, [groupMetric, nameByCode, onPick, openDrill, palette, panorama]);

    const sectorHeaders = useMemo(
        () =>
            panorama.layout.sectors.flatMap((sector) => {
                const row = groupByCat.get(sector.key);
                if (!row || !sector.header) return [];
                return [{ key: sector.key, row, rect: sector.header }];
            }),
        [groupByCat, panorama],
    );

    // 涵蓋率：成交值＝Σ入選成交值／全市場成交值；市值＝Σ入選權重／Σ群組權重
    const shownCount = panorama.layout.tiles.length;
    const shownGroups = panorama.layout.sectors.length;
    const coverage = useMemo(() => {
        const entries = panorama.selected.flatMap(({ stocks }) =>
            stocks.map((stock) => stock.entry),
        );
        if (sizeMetric === 'amount') {
            if (totalAmount <= 0) return null;
            return (
                entries.reduce((sum, entry) => sum + entry.value, 0) /
                totalAmount
            );
        }
        if (sizeMetric === 'weight') {
            const weights = getIcBootstrapGroupWeights(indexCode);
            const total = weights
                ? [...weights.values()].reduce((sum, w) => sum + w, 0)
                : 100;
            if (total <= 0) return null;
            return (
                entries.reduce((sum, entry) => sum + entry.weight_pct, 0) /
                total
            );
        }
        return null;
        // ic 換新物件代表建底可能已更新（權重來源）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [baseIc, indexCode, panorama, sizeMetric, totalAmount]);
    // 備援時面積其實是市值權重：說明與匯出都照實際面積指標寫
    const effectiveMetric: SizeMetric = panorama.weightFallback
        ? 'weight'
        : sizeMetric;
    const metricLabel = SIZE_METRICS.find(
        (metric) => metric.value === effectiveMetric,
    )!.label;
    const colorHint =
        theme.convention === 'intl' ? '綠色上漲・紅色下跌' : '紅色上漲・綠色下跌';
    const coverageText =
        shownCount === 0
            ? ''
            : panorama.weightFallback
              ? `顯示 ${shownGroups} 個產業、${shownCount} 檔`
              : effectiveMetric === 'contribution'
              ? `顯示 ${shownGroups} 個產業中貢獻最大的 ${shownCount} 檔`
              : `顯示 ${shownGroups} 個產業中${effectiveMetric === 'amount' ? '成交值最大' : '成交最活躍'}的 ${shownCount} 檔${
                    coverage !== null
                        ? `（佔全體個股${metricLabel} ${Math.round(coverage * 100)}%）`
                        : ''
                }`;
    const areaLabel = panorama.weightFallback
        ? `市值（${sizeMetric === 'contribution' ? '貢獻' : '成交值'}尚未產生）`
        : sizeMetric === 'contribution'
          ? '貢獻（絕對值）'
          : metricLabel;
    const captionText = `${colorHint}・面積越大代表${areaLabel}越大${coverageText ? `・${coverageText}` : ''}`;

    // ---- 匯出 PNG ----
    const [exporting, setExporting] = useState(false);
    const exportPng = useCallback(async () => {
        if (exporting || panoramaTiles.length === 0) return;
        setExporting(true);
        try {
            const now = new Date();
            const p2 = (n: number) => String(n).padStart(2, '0');
            const stamp = `${now.getFullYear()}/${p2(now.getMonth() + 1)}/${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
            const blob = await renderHeatmapPng({
                width: panoramaSize.width,
                height: panoramaSize.height,
                title: `產業全景・${INDEX_LABELS[indexCode]}`,
                subtitle: `面積＝${metricLabel}・${stamp}${isSimtrade ? '・試撮' : ''}`,
                caption: captionText,
                legend: {
                    colors: legendColors(STOCK_HEAT_DOMAIN, palette),
                    low: `-${STOCK_HEAT_DOMAIN}%`,
                    high: `+${STOCK_HEAT_DOMAIN}%`,
                },
                background: rgbCss(palette.gap),
                headerFill: rgbCss(palette.header),
                foreground: rgbCss(palette.fg),
                muted: rgbCss(palette.muted),
                sectors: sectorHeaders.map(({ row, rect }) => ({
                    rect,
                    header: rect,
                    name: shortSectorName(row.name),
                    pctText: fmtPct(row.pct),
                    pctColor: rgbCss(
                        row.pct > 0
                            ? palette.upText
                            : row.pct < 0
                              ? palette.downText
                              : palette.muted,
                    ),
                })),
                tiles: panoramaTiles.map((tile) => ({
                    rect: tile.rect,
                    fill: tile.fill,
                    ink: tile.ink,
                    name: tile.name,
                    code: tile.code,
                    pctText: tile.pctText,
                    mode: tile.fit.mode,
                    fontSize: tile.fit.fontSize,
                })),
            });
            const saved = await saveHeatmapPng(
                blob,
                exportFileName(`${INDEX_LABELS[indexCode]}-${metricLabel}`, now),
            );
            if (saved) {
                notify({ kind: 'ok', title: '已匯出產業全景', body: saved });
            }
        } catch (reason) {
            notify({
                kind: 'err',
                title: '產業全景匯出失敗',
                body: reason instanceof Error ? reason.message : String(reason),
            });
        } finally {
            setExporting(false);
        }
    }, [
        captionText,
        exporting,
        indexCode,
        isSimtrade,
        metricLabel,
        palette,
        panoramaSize,
        panoramaTiles,
        sectorHeaders,
    ]);

    // ---- 側欄：產業漲跌排行＋貢獻前後 ----
    const sectorRank = useMemo(
        () =>
            [...groupRows].sort(
                (a, b) =>
                    b.pct - a.pct || (a.category < b.category ? -1 : 1),
            ),
        [groupRows],
    );
    const sectorRankMax = sectorRank.reduce(
        (max, row) => Math.max(max, Math.abs(row.pct)),
        0,
    );
    const { ref: moversRef, size: moversSize } = useBoxSize<HTMLDivElement>();
    // 每塊：標題約 20px、列高 18px；兩塊平分高度
    const moverRows = Math.max(
        3,
        Math.min(25, Math.floor((moversSize.height / 2 - 24) / 18)),
    );

    // 下鑽 header 的官方類股指數（僅上市有對應官方指數）
    const officialSector =
        drillCat && indexCode === 'IX0001'
            ? SECTOR_INDICES.find(
                  (sector) => Number(sector.category) === Number(drillCat),
              )
            : undefined;
    const officialQuote = useQuote(officialSector?.index ?? null)?.index;
    const officialClose = Number(officialQuote?.close);
    const officialReference = Number(officialQuote?.reference);
    const officialPct =
        Number.isFinite(officialClose) &&
        Number.isFinite(officialReference) &&
        officialReference > 0
            ? ((officialClose - officialReference) / officialReference) * 100
            : null;

    // ---- 下鑽層資料：10 檔主力＋餘量＋合計（與群組串流自洽） ----
    const drillGroup = drillCat ? groupByCat.get(drillCat) : undefined;
    const isAmountDrill = drillMetric === 'amount';
    const top10Sum = drillEntries.reduce((sum, entry) => sum + entry.value, 0);
    // 餘量與合計跟著下鑽指標走：貢獻＝群組貢獻點、成交值＝群組總成交值
    const drillGroupAmount = drillCat
        ? Math.abs(
              (amountState?.groups ?? []).find(
                  (group) => group.category === drillCat,
              )?.value ?? 0,
          )
        : 0;
    const drillTotal = drillGroup
        ? isAmountDrill
            ? drillGroupAmount
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
    // 其他成員的加權漲跌幅反推（群組加權漲跌扣排行前 10）— 群組漲跌只取
    // 排行 calculated_at 當下有效的值（建底同快照／盤中 AS-OF，見
    // getIcGroupWperfAt）；無法判定、餘量權重過小或結果超出漲跌停時顯示
    // 「—」（#330）。權重取建底參考權重（盤中恆定，
    // 與排行列的 weight_pct 同基準）。
    const drillCalculatedAt = drillState?.calculatedAt;
    const { drillGroupWeight, drillGroupPctAtRows } = useMemo(
        () => ({
            drillGroupWeight: drillCat
                ? getIcBootstrapGroupWeights(indexCode)?.get(drillCat)
                : undefined,
            drillGroupPctAtRows: drillCat
                ? getIcGroupWperfAt(indexCode, drillCat, drillCalculatedAt)
                : undefined,
        }),
        // ic 每個 store 版本換新物件 — 建底抵達、日切、群組新包後自動更新
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [drillCat, drillCalculatedAt, baseIc, drillIc, indexCode],
    );
    const otherPct = useMemo(
        () =>
            estimateOtherPct({
                groupWeight: drillGroupWeight,
                groupPct: drillGroupPctAtRows,
                entries: drillEntries,
            }),
        [drillEntries, drillGroupPctAtRows, drillGroupWeight],
    );
    const barScale = drillEntries.reduce(
        (max, entry) => Math.max(max, Math.abs(entry.value)),
        0,
    );

    const { ref: wallRef, size: wallSize, resizing: wallResizing } =
        useBoxSize<HTMLDivElement>();
    const wallOrderRef = useRef<{
        scope: string;
        order: string[];
        split: SplitMemo;
    }>({ scope: '', order: [], split: new Map() });
    const wallTiles = useMemo<TileView[]>(() => {
        type WallItem = {
            key: string;
            weight: number;
            name: string;
            pct: number | null;
            points: number;
            code?: string;
        };
        // 全部為 0（開盤前／全面平盤）時同全景，面積改用市值權重；「其他
        // 成員」餘量不為 0 時仍照原指標（單位一致，餘量照畫）
        const residual = otherCount > 0 && Math.abs(otherValue) > 1e-9;
        const picked = weightWithFallback(
            [drillEntries],
            (entry) => Math.abs(entry.value),
            (entry) => entry.weight_pct,
        );
        const wallFallback = picked.fallback && !residual;
        const wallWeight = wallFallback
            ? picked.weight
            : (entry: IcRankingEntry) => Math.abs(entry.value);
        const items: WallItem[] = drillEntries.map((entry) => ({
            key: entry.code,
            weight: wallWeight(entry),
            name: nameByCode.get(entry.code) ?? entry.code,
            pct: entry.pct_chg,
            points: entry.value,
            code: entry.code,
        }));
        if (residual) {
            items.push({
                key: 'other',
                weight: Math.abs(otherValue),
                name: `其他 ${otherCount} 檔`,
                pct: otherPct,
                points: otherValue,
            });
        }
        const scope = `${indexCode}|${drillCat}|${drillMetric}`;
        if (wallOrderRef.current.scope !== scope) {
            wallOrderRef.current = { scope, order: [], split: new Map() };
        }
        const order = stableOrder(wallOrderRef.current.order, items);
        wallOrderRef.current.order = order;
        const byKey = new Map(items.map((item) => [item.key, item]));
        const ordered = order.map((key) => byKey.get(key)!);
        const nextSplit: SplitMemo = new Map();
        const boxes = layoutFlat(
            ordered,
            wallSize.width,
            wallSize.height,
            wallOrderRef.current.split,
            nextSplit,
        );
        wallOrderRef.current.split = nextSplit;
        return boxes.map(
            (box) => {
                const item = byKey.get(box.key)!;
                const valueText = isAmountDrill
                    ? `成交 ${fmtAmount(item.points)}`
                    : `貢獻 ${fmtPoints(item.points)} 點`;
                const pctText =
                    item.pct === null
                        ? item.code === undefined
                            ? '—'
                            : null
                        : `${item.code === undefined ? '≈' : ''}${fmtPct(item.pct)}`;
                return buildTile(palette, STOCK_HEAT_DOMAIN, {
                    key: item.key,
                    code: item.code ?? item.name,
                    name: item.name,
                    rect: box.rect,
                    pct: item.pct,
                    pctText,
                    sub: isAmountDrill
                        ? fmtAmount(item.points)
                        : `${fmtPoints(item.points)} 點`,
                    title:
                        item.code === undefined
                            ? `其他成員（${otherCount} 檔）｜合計${valueText}${item.pct !== null ? `｜加權漲跌 ≈${fmtPct(item.pct)}（依群組加權與前10反推）` : `｜${OTHER_PCT_UNAVAILABLE}`}`
                            : `${item.name}（${item.code}）｜${valueText}｜漲跌 ${fmtPct(item.pct ?? 0)}`,
                    onClick: item.code
                        ? () => onPick?.(item.code!)
                        : undefined,
                });
            },
        );
    }, [
        drillCat,
        drillEntries,
        drillMetric,
        indexCode,
        isAmountDrill,
        nameByCode,
        onPick,
        otherCount,
        otherPct,
        otherValue,
        palette,
        wallSize,
    ]);

    const bootstrapPending =
        baseIc.bootstrap.status === 'pending' ||
        baseIc.bootstrap.status === 'idle';

    // ---- render ----

    const drillView = drillCat !== null;
    const setMetric = (metric: SizeMetric) => {
        setSizeMetric(metric);
        localStorage.setItem(SIZE_KEY, metric);
    };

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
                            {PANORAMA_INDEX_CODES.map((code) => (
                                <button
                                    key={code}
                                    className={
                                        styles.segment[
                                            code === indexCode ? 'on' : 'off'
                                        ]
                                    }
                                    aria-pressed={code === indexCode}
                                    onClick={() => selectIndex(code)}
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
                                    onClick={() => setMetric(metric.value)}
                                >
                                    {metric.label}
                                </button>
                            ))}
                        </span>
                        <span className={styles.spacer} />
                        {contributionState && (
                            <span
                                className={`${styles.totals} ${
                                    panel.dirText[dirOf(totalPoints)]
                                }`}
                                title="產業貢獻合計 ≈ 指數漲跌點數"
                            >
                                {fmtPoints(totalPoints)} 點
                            </span>
                        )}
                        {totalAmount > 0 && (
                            <span
                                className={styles.totals}
                                title="全市場成分合計（Σ產業群組）"
                            >
                                成交 {fmtAmount(totalAmount)}
                            </span>
                        )}
                        {isSimtrade && (
                            <span className={styles.simtrade}>試撮</span>
                        )}
                        <button
                            className={styles.iconBtn}
                            onClick={() => void exportPng()}
                            disabled={exporting || panoramaTiles.length === 0}
                            title="匯出 PNG 圖片"
                            aria-label="匯出 PNG 圖片"
                        >
                            <ImageDown size={13} />
                        </button>
                    </div>
                    <div className={styles.caption}>
                        <span className={styles.captionText} title={captionText}>
                            {captionText}
                        </span>
                        <Legend palette={palette} domain={STOCK_HEAT_DOMAIN} />
                    </div>
                    <div className={styles.panoramaBody}>
                        <div
                            ref={panoramaRef}
                            className={styles.treemapBox}
                            style={
                                {
                                    background: rgbCss(palette.gap),
                                    '--heat-move': resizing ? '0.18s' : '0.6s',
                                } as CSSProperties
                            }
                        >
                            {sectorHeaders.map(({ key, row, rect }) => (
                                <button
                                    key={`h${key}`}
                                    className={styles.sectorHeader}
                                    style={{
                                        left: rect.x,
                                        top: rect.y,
                                        width: rect.w,
                                        height: rect.h,
                                        background: rgbCss(palette.header),
                                    }}
                                    title={`${row.name}（${row.itemCount} 檔）｜加權漲跌 ${fmtPct(row.pct)}｜貢獻 ${fmtPoints(row.points)} 點・點擊看產業明細`}
                                    onClick={() => openDrill(key)}
                                >
                                    <span className={styles.sectorHeaderName}>
                                        {shortSectorName(row.name)}
                                    </span>
                                    {rect.w >= shortSectorName(row.name).length * 11 + 62 && (
                                        <span
                                            className={`${styles.sectorHeaderPct} ${panel.dirText[dirOf(row.pct)]}`}
                                        >
                                            {fmtPct(row.pct)}
                                        </span>
                                    )}
                                </button>
                            ))}
                            <HeatTiles tiles={panoramaTiles} />
                            {panoramaTiles.length === 0 && (
                                <div className={styles.empty}>
                                    <AsyncStatus
                                        phase={icError ? 'error' : bootstrapPending ? 'loading' : 'idle'}
                                        text={icError ? '產業資料無法取得' : bootstrapPending ? '載入產業資料…' : '等待產業資料'}
                                    />
                                </div>
                            )}
                        </div>
                        {showSide && (
                            <MotionConfig reducedMotion="user">
                                <div className={styles.sideCol}>
                                    <div
                                        className={styles.sideBlock}
                                        style={{ flex: '1 1 52%' }}
                                    >
                                        <div className={styles.sideTitle}>
                                            類股漲跌
                                            <span className={styles.sideNote}>
                                                加權漲跌幅
                                            </span>
                                        </div>
                                        <div className={styles.sideList}>
                                            <LayoutGroup>
                                                {sectorRank.map((row) => (
                                                    <motion.button
                                                        layout="position"
                                                        transition={{
                                                            duration: 0.45,
                                                            ease: [0.22, 1, 0.36, 1],
                                                        }}
                                                        key={row.category}
                                                        className={styles.sideRow}
                                                        title={`${row.name}・點擊看產業明細`}
                                                        onClick={() =>
                                                            openDrill(row.category)
                                                        }
                                                    >
                                                        <span className={styles.sideName}>
                                                            {shortSectorName(row.name)}
                                                        </span>
                                                        <span className={styles.sideBarTrack}>
                                                            <span
                                                                className={styles.sideBar}
                                                                style={{
                                                                    display: 'block',
                                                                    width: `${sectorRankMax > 0 ? Math.max(2, (Math.abs(row.pct) / sectorRankMax) * 100) : 0}%`,
                                                                    background: heatColor(
                                                                        row.pct === 0 ? 0 : Math.sign(row.pct) * SECTOR_HEAT_DOMAIN,
                                                                        SECTOR_HEAT_DOMAIN,
                                                                        palette,
                                                                    ),
                                                                }}
                                                            />
                                                        </span>
                                                        <span
                                                            className={`${styles.sideValue} ${panel.dirText[dirOf(row.pct)]}`}
                                                        >
                                                            {fmtPct(row.pct)}
                                                        </span>
                                                    </motion.button>
                                                ))}
                                            </LayoutGroup>
                                        </div>
                                    </div>
                                    <div
                                        ref={moversRef}
                                        style={{
                                            flex: '1 1 48%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: vars.space.xs,
                                            minHeight: 0,
                                        }}
                                    >
                                        {(
                                            [
                                                ['貢獻前', posEntries],
                                                ['貢獻後', negEntries],
                                            ] as const
                                        ).map(([label, list]) => (
                                            <div
                                                key={label}
                                                className={styles.sideBlock}
                                                style={{ flex: '1 1 0' }}
                                            >
                                                <div className={styles.sideTitle}>
                                                    {label} {Math.min(moverRows, list.length)} 檔
                                                    <span className={styles.sideNote}>
                                                        點
                                                    </span>
                                                </div>
                                                <div className={styles.sideList}>
                                                    {list.slice(0, moverRows).map((entry) => (
                                                        <motion.button
                                                            layout="position"
                                                            transition={{
                                                                duration: 0.45,
                                                                ease: [0.22, 1, 0.36, 1],
                                                            }}
                                                            key={entry.code}
                                                            className={styles.moverRow}
                                                            title={`${nameByCode.get(entry.code) ?? entry.code}（${entry.code}）｜漲跌 ${fmtPct(entry.pct_chg)}`}
                                                            onClick={() => onPick?.(entry.code)}
                                                        >
                                                            <span className={styles.moverCode}>
                                                                {entry.code}
                                                            </span>
                                                            <span className={styles.sideName}>
                                                                {nameByCode.get(entry.code) ?? ''}
                                                            </span>
                                                            <span
                                                                className={`${styles.sideValue} ${panel.dirText[dirOf(entry.value)]}`}
                                                            >
                                                                {fmtPoints(entry.value)}
                                                            </span>
                                                        </motion.button>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </MotionConfig>
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
                            {DRILL_METRICS.map((metric) => (
                                <button
                                    key={metric.value}
                                    className={
                                        styles.segment[
                                            metric.value === drillMetric
                                                ? 'on'
                                                : 'off'
                                        ]
                                    }
                                    aria-pressed={metric.value === drillMetric}
                                    title={`排行＝${metric.label}`}
                                    onClick={() => setMetric(metric.value)}
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
                                                    style={
                                                        {
                                                            width: `${(ratio * 100).toFixed(1)}%`,
                                                            '--bar-color':
                                                                entry.pct_chg >
                                                                0
                                                                    ? vars.color
                                                                          .up
                                                                    : entry.pct_chg <
                                                                        0
                                                                      ? vars
                                                                            .color
                                                                            .down
                                                                      : vars
                                                                            .color
                                                                            .flat,
                                                        } as CSSProperties
                                                    }
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
                                    <AsyncStatus
                                        phase={icError ? 'error' : drillState ? 'empty' : 'loading'}
                                        text={icError ? '排行資料無法取得' : drillState ? '目前沒有排行資料' : '載入排行…'}
                                    />
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
                                                        ? panel.dirText.flat
                                                        : panel.dirText[
                                                              otherPct > 0
                                                                  ? 'up'
                                                                  : otherPct <
                                                                      0
                                                                    ? 'down'
                                                                    : 'flat'
                                                          ]
                                                }`}
                                                title={
                                                    otherPct === null
                                                        ? OTHER_PCT_UNAVAILABLE
                                                        : '依群組加權漲跌與前10檔反推的估算值'
                                                }
                                            >
                                                {otherPct === null
                                                    ? '—'
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
                        <div
                            ref={wallRef}
                            className={styles.wallPane}
                            style={
                                {
                                    background: rgbCss(palette.gap),
                                    '--heat-move': wallResizing ? '0.18s' : '0.6s',
                                } as CSSProperties
                            }
                        >
                            <HeatTiles tiles={wallTiles} />
                            {wallTiles.length === 0 &&
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
