// src/components/chain-map.tsx — 產業鏈資金流向：shioaji-data 產業鏈／題材 ×
// 即時 1 分 K 資金流，三種即時視圖：
// - 輪動（預設）：每個族群一顆泡泡，x＝開啟以來淨流入、y＝加速（近 10 分鐘
//   流入比重 − 近 30 分鐘），大小＝近 10 分成交值、顏色＝領先／轉弱／
//   改善／落後（RRG 四象限）。每分鐘滑動到新位置並留下 8 分鐘軌跡。
// - 排行：族群依淨流入上下分流排行，每分鐘換位、資金粒子沿條流動。
// - 熱力：族群與所選族群成分股依近 5／10 分鐘淨流入占成交值著色，不需歷史資料。
// 下方是所選族群的上中下游流向與聚焦個股。
// 行情：即時 1 分 K 訂閱（約 800 檔、3 個 POST、每分鐘 0 request）＋其他面板
// 既有 tick；snapshots 只在當日第一次開啟時補開盤至今的彙總，不下載歷史 K
// 線。見 lib/chain-flow-feed.ts。面板隱藏或捲出畫面時暫停重繪；
// prefers-reduced-motion 時不做動畫。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { groupFlow, shareShift } from '../lib/chain-flow';
import { stageMembers, themeCodes, tierRank } from '../lib/chain-map';
import { RANK_METRICS, type RankMetric } from '../lib/chain-motion';
import { entityName, twCodeOf } from '../lib/company-data';
import type { ChainTier, Theme } from '../lib/company-data/types';
import { themeKey as themeKeyOf, useThemeSettings } from '../lib/theme-store';
import type { ContractBase } from '../lib/types/contract';
import { CHAIN_KINDS, panelPref, type ChainKind, type ChainView } from '../lib/workspace';
import { AsyncStatus } from './async-status';
import { FocusCard, TierCard, type TierView } from './chain-detail';
import { FlowHeat } from './chain-heat';
import { FlowRank } from './chain-rank';
import { FlowRotation } from './chain-rotation';
import { FeedStatus, useChainFeed } from './chain-feed';
import { readPref, Segment, useSharedPref, writePref, type FlowRow } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const THEME_KEY = 'sj-pro-chainmap-theme';
const KIND_KEY = 'sj-pro-chainmap-kind';
const HEAT_WINDOW_KEY = 'sj-pro-chainmap-heat-window';
const VIEW_KEY = 'sj-pro-chainmap-view';
const METRIC_KEY = 'sj-pro-chainmap-rank-metric';
const DEFAULT_THEME = 'theme.ai_server';
/** Below this panel height the chain detail is hidden. */
const DETAIL_MIN_PX = 520;
const TIERS: ChainTier[] = ['upstream', 'midstream', 'downstream'];

// 持股 moved to its own panel (持股族群): a saved 'holdings' view is no longer
// allowed by readPref and falls back to 排行
type ViewMode = ChainView;
const VIEW_MODES = ['rotation', 'rank', 'heat'] as const satisfies readonly ViewMode[];

/** Saved view of the panel; the retired 持股 tab (or anything unknown) becomes 排行 and is saved back. */
export function readChainView(): ViewMode {
    const view = readPref(VIEW_KEY, VIEW_MODES, 'rank');
    try {
        if (localStorage.getItem(VIEW_KEY) !== view) localStorage.removeItem(VIEW_KEY);
    } catch {
        // storage unavailable: nothing saved to migrate
    }
    return view;
}
type KindFilter = ChainKind;

export function ChainMap({
    contract,
    onPick,
    view: panelView,
    kind: panelKind,
    onViewChange,
    onKindChange,
}: {
    contract?: ContractBase | null;
    onPick?: (code: string) => void;
    /** The panel's own 視圖 / 類型 (saved with the layout); absent = last choice in any 產業鏈資金流向 panel. */
    view?: ViewMode;
    kind?: KindFilter;
    onViewChange?: (view: ViewMode) => void;
    onKindChange?: (kind: KindFilter) => void;
}) {
    const chainFeed = useChainFeed();
    const { data, ready, themes, index, nameOf, rootRef, rootSize, paused, reducedMotion, revision, book, now, from, closed } = chainFeed;
    const themeKey = themeKeyOf(useThemeSettings());

    const [themeId, setThemeIdState] = useState(() => {
        try {
            return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
        } catch {
            return DEFAULT_THEME;
        }
    });
    const [savedKind, setKindState] = useSharedPref<KindFilter>(panelKind, () => readPref(KIND_KEY, CHAIN_KINDS, 'all'));
    const [savedView, setViewState] = useSharedPref<ViewMode>(panelView, readChainView);
    const kind = panelPref(panelKind, CHAIN_KINDS, savedKind);
    const view = panelPref(panelView, VIEW_MODES, savedView);
    const [metric, setMetricState] = useState<RankMetric>(() => readPref(METRIC_KEY, RANK_METRICS, 'cum'));
    const [focus, setFocus] = useState<string | null>(null);
    const [heatWindow, setHeatWindowState] = useState<'5' | '10'>(() => readPref(HEAT_WINDOW_KEY, ['5', '10'] as const, '10'));

    const setThemeId = useCallback((id: string) => {
        setThemeIdState(id);
        writePref(THEME_KEY, id);
    }, []);

    // ── group rows (each view orders them itself) ──
    const pool = useMemo(() => (themes ?? []).filter((t) => kind === 'all' || t.kind === kind), [themes, kind]);
    const rows = useMemo<FlowRow[]>(() => {
        return pool.flatMap((theme) => {
            const codes = themeCodes(theme);
            return codes.length > 0 ? [{ theme, codes, flow: groupFlow(book, codes, now) }] : [];
        });
        // the book mutates in place: `revision` is the change signal
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pool, revision, now]);

    const theme: Theme | null = useMemo(() => {
        if (!themes) return null;
        return themes.find((t) => t.id === themeId) ?? themes.find((t) => t.id === DEFAULT_THEME) ?? themes[0] ?? null;
    }, [themes, themeId]);
    const selectedCodes = useMemo(() => (theme ? themeCodes(theme) : []), [theme]);

    // ── chain detail: upstream → midstream → downstream ──
    const stageOf = useMemo(() => {
        const map = new Map<string, string>();
        if (!theme) return map;
        const names = new Map(theme.stages.map((st) => [st.id, st.name]));
        for (const m of theme.members) {
            const code = twCodeOf(m.id);
            if (code && !map.has(code)) map.set(code, names.get(m.stage) ?? '');
        }
        return map;
    }, [theme]);
    const tiers = useMemo<TierView[]>(() => {
        if (!theme) return [];
        const byStage = stageMembers(theme);
        const tierOf = new Map(theme.stages.map((st) => [st.id, st.tier]));
        const buckets = new Map<ChainTier, Set<string>>();
        for (const [stageId, codes] of byStage) {
            const raw = tierOf.get(stageId);
            const tier = raw && TIERS.includes(raw) ? raw : 'midstream';
            const set = buckets.get(tier) ?? new Set<string>();
            codes.forEach((c) => set.add(c));
            buckets.set(tier, set);
        }
        return [...buckets.entries()]
            .filter(([, set]) => set.size > 0)
            .sort((a, b) => tierRank(a[0]) - tierRank(b[0]))
            .map(([tier, set]) => {
                const codes = [...set];
                return { tier, codes, flow: groupFlow(book, codes, now) };
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [theme, revision, now]);
    const shifts = useMemo(() => shareShift(tiers.map((t) => t.flow), now), [tiers, now]);

    // ── follow the linked contract ──
    const linkedCode = contract && contract.security_type === 'STK' ? contract.code : null;
    useEffect(() => {
        if (!linkedCode || !themes || !theme) return;
        const id = `tw.${linkedCode}`;
        if (theme.members.some((m) => m.id === id)) {
            setFocus(linkedCode);
            return;
        }
        const owners = themes.filter((t) => t.members.some((m) => m.id === id));
        const next = owners.find((t) => t.kind === 'chain' && t.id !== 'chain.finance') ?? owners[0];
        if (next) {
            setThemeId(next.id);
            setFocus(linkedCode);
        }
        // only react to the linked code, not to theme switches made here
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedCode, themes]);

    const pick = useCallback(
        (code: string) => {
            setFocus(code);
            onPick?.(code);
        },
        [onPick],
    );

    // ── render ──
    if (data.phase === 'loading') {
        return (
            <div className={s.center}>
                <AsyncStatus phase='loading' text='讀取產業鏈資料…' />
            </div>
        );
    }
    if (data.phase === 'error' || !theme) {
        return (
            <div className={s.center}>
                <AsyncStatus
                    phase='error'
                    text={data.phase === 'error' ? data.error : '沒有產業鏈資料'}
                    action={
                        <button type='button' className={panel.btn} onClick={data.retry}>
                            重試
                        </button>
                    }
                />
            </div>
        );
    }

    const showDetail = rootSize.height === 0 || rootSize.height >= DETAIL_MIN_PX;

    return (
        <div ref={rootRef} className={s.wrap}>
            <div className={s.toolbar}>
                <Segment
                    label='視圖'
                    value={view}
                    onChange={(v) => {
                        setViewState(v);
                        writePref(VIEW_KEY, v);
                        onViewChange?.(v);
                    }}
                    options={[
                        { value: 'rank', label: '排行', title: '族群淨流入排行，長度為淨流入、粗細為成交值，每分鐘更新名次' },
                        { value: 'rotation', label: '輪動', title: '族群輪動象限：橫軸淨流入、縱軸資金動能，每分鐘更新位置與軌跡' },
                        { value: 'heat', label: '熱力', title: '族群與成分股近期淨流入占成交值，點族群看成分股' },
                    ]}
                />
                <Segment
                    label='類型'
                    value={kind}
                    onChange={(v) => {
                        setKindState(v);
                        writePref(KIND_KEY, v);
                        onKindChange?.(v);
                    }}
                    options={[
                        { value: 'all', label: '全部' },
                        { value: 'chain', label: '產業鏈' },
                        { value: 'theme', label: '題材' },
                    ]}
                />
                {view === 'rank' && (
                    <Segment
                        label='排行區間'
                        value={metric}
                        onChange={(v) => {
                            setMetricState(v);
                            writePref(METRIC_KEY, v);
                        }}
                        options={[
                            { value: '5', label: '近 5 分', title: '最近 5 根 1 分 K 的淨流入（估算）' },
                            { value: '15', label: '近 15 分', title: '最近 15 根 1 分 K 的淨流入（估算）' },
                            { value: '30', label: '近 30 分', title: '最近 30 根 1 分 K 的淨流入（估算）' },
                            { value: 'cum', label: '累計', title: '開啟面板後收到的 1 分 K 累計淨流入（估算）' },
                        ]}
                    />
                )}
                {view === 'heat' && (
                    <Segment
                        label='統計區間'
                        value={heatWindow}
                        onChange={(v) => {
                            setHeatWindowState(v);
                            writePref(HEAT_WINDOW_KEY, v);
                        }}
                        options={[
                            { value: '5', label: '近 5 分', title: '最近 5 根 1 分 K' },
                            { value: '10', label: '近 10 分', title: '最近 10 根 1 分 K' },
                        ]}
                    />
                )}
                <span className={s.spacer} />
                <FeedStatus feed={chainFeed} />
            </div>

            <div className={s.views}>
                {view === 'rotation' && (
                    <FlowRotation
                        rows={rows}
                        now={now}
                        from={from}
                        session={book.date}
                        selectedId={theme.id}
                        reducedMotion={reducedMotion}
                        paused={paused}
                        onSelect={setThemeId}
                    />
                )}
                {view === 'rank' && (
                    <FlowRank
                        rows={rows}
                        metric={metric}
                        now={now}
                        from={from}
                        selectedId={theme.id}
                        reducedMotion={reducedMotion}
                        paused={paused}
                        onSelect={setThemeId}
                        nameOf={nameOf}
                        onPick={pick}
                    />
                )}
                {view === 'heat' && (
                    <FlowHeat
                        rows={rows}
                        now={now}
                        window={Number(heatWindow)}
                        selectedId={theme.id}
                        selectedName={theme.name}
                        selectedCodes={selectedCodes}
                        nameOf={nameOf}
                        reducedMotion={reducedMotion}
                        onSelect={setThemeId}
                        onPick={pick}
                    />
                )}
            </div>

            {showDetail && view !== 'heat' && (
                <div className={s.detail}>
                    <div className={s.detailHead}>
                        <span className={s.kindMark[theme.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                        <span className={s.detailTitle}>{theme.name}</span>
                        <span className={s.detailMeta}>
                            {themeCodes(theme).length} 檔・
                            {now !== null ? '累計淨流入走勢・近 15 分鐘資金占比變化' : closed ? '今日收盤彙總；盤中依 1 分 K 顯示資金流向' : '開盤至今彙總，下一根 1 分 K 起顯示走勢'}
                        </span>
                    </div>
                    <div className={`${s.detailBody} ${focus ? s.detailBodyFocus : ''}`}>
                        <div className={s.tiers} style={{ gridTemplateColumns: `repeat(${Math.max(1, tiers.length)}, minmax(0, 1fr))` }}>
                            {tiers.map((tier, i) => (
                                <TierCard
                                    key={tier.tier}
                                    view={tier}
                                    shift={shifts[i] ?? 0}
                                    last={i === tiers.length - 1}
                                    from={from}
                                    now={now}
                                    hover={null}
                                    themeKey={themeKey}
                                    revision={revision}
                                    nameOf={nameOf}
                                    stageOf={stageOf}
                                    focus={focus}
                                    onPick={pick}
                                />
                            ))}
                        </div>
                        {focus && (
                            <FocusCard
                                code={focus}
                                theme={theme}
                                edges={ready?.edges ?? null}
                                nameOf={(id) => entityName(index, id)}
                                inChain={(code) => stageOf.has(code)}
                                onPick={pick}
                                onClose={() => setFocus(null)}
                                revision={revision}
                            />
                        )}
                    </div>
                </div>
            )}

            <div className={s.footer}>
                <span>
                    淨流入為估算值：每分鐘成交值依收盤價相對前一分鐘漲跌給予正負號。產業鏈與題材為第三方 AI 整理資料（
                    {ready?.themesMeta.asOf ?? '--'}），可能過時或有誤
                </span>
            </div>
        </div>
    );
}
