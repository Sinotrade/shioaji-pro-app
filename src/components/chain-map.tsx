// src/components/chain-map.tsx：產業鏈資金流向：shioaji-data 產業鏈／題材／細產業 ×
// 即時 1 分 K 資金流，三種即時視圖：
// - 輪動（預設）：每個族群一顆泡泡，x＝開啟以來淨流入、y＝加速（近 10 分鐘
//   流入比重 − 近 30 分鐘），大小＝近 10 分成交值、顏色＝領先／轉弱／
//   改善／落後（RRG 四象限）。每分鐘滑動到新位置並留下 8 分鐘軌跡。
// - 金流（rank）：族群依淨流入上下分流排行，每分鐘換位、資金粒子沿條流動；
//   明細卡列出所選族群全部成分股。
// - 漲跌（heat）：族群與所選族群成分股依今日漲跌幅著色，方塊下緣細條為近 5／10
//   分鐘逐分資金方向。可切成清單：左族群、右所選族群成分股，欄位標題可排序。
// 下方是所選族群的上中下游流向與聚焦個股。
// 行情：即時 1 分 K 訂閱（約 800 檔、3 個 POST、每分鐘 0 request）＋其他面板
// 既有 tick；選「細產業」時另以 drill 批次補訂不在產業鏈／題材內的成分股；snapshots 只在當日第一次開啟時補開盤至今的彙總，不下載歷史 K
// 線。見 lib/chain-flow-feed.ts。面板隱藏或捲出畫面時暫停重繪；
// prefers-reduced-motion 時不做動畫。

import { LayoutGrid, List } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { groupFlow, shareShift, slotLabel } from '../lib/chain-flow';
import { connectChainFlow, type FeedMember } from '../lib/chain-flow-feed';
import { INDUSTRY_MIN, industryThemes, memberCodes, stageMembers, themeCodes, tierRank } from '../lib/chain-map';
import { RANK_METRICS, type RankMetric } from '../lib/chain-motion';
import { entityName, twCodeOf } from '../lib/company-data';
import type { ChainTier, Theme } from '../lib/company-data/types';
import { useCards } from '../lib/company-cards';
import { themeKey as themeKeyOf, useThemeSettings } from '../lib/theme-store';
import type { ContractBase } from '../lib/types/contract';
import { CHAIN_KINDS, panelPref, type ChainKind, type ChainView } from '../lib/workspace';
import { AsyncStatus } from './async-status';
import { FocusCard, TierCard, type TierView } from './chain-detail';
import { FlowHeat, type HeatForm } from './chain-heat';
import { FlowRank } from './chain-rank';
import { FlowRotation } from './chain-rotation';
import { FeedStatus, feedMembers, useChainFeed } from './chain-feed';
import { markKind, readPref, Segment, Select, useSharedPref, writePref, type FlowRow } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const THEME_KEY = 'sj-pro-chainmap-theme';
const KIND_KEY = 'sj-pro-chainmap-kind';
const HEAT_WINDOW_KEY = 'sj-pro-chainmap-heat-window';
const HEAT_FORM_KEY = 'sj-pro-chainmap-heat-form';
const VIEW_KEY = 'sj-pro-chainmap-view';
const METRIC_KEY = 'sj-pro-chainmap-rank-metric';
const DEFAULT_THEME = 'theme.ai_server';
/** Below this panel height the chain detail is hidden. */
const DETAIL_MIN_PX = 520;
const TIERS: ChainTier[] = ['upstream', 'midstream', 'downstream'];

// 持股 moved to its own panel (持股族群): a saved 'holdings' view is no longer
// allowed by readPref and falls back to 金流 (rank)
type ViewMode = ChainView;
const VIEW_MODES = ['rotation', 'rank', 'heat'] as const satisfies readonly ViewMode[];

/** Saved view of the panel; the retired 持股 tab (or anything unknown) becomes 金流 (rank) and is saved back. */
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

/** Group to select when `rows` lack the selection: the followed stock's, else the largest by today's turnover; null when it is listed. */
export function fallbackGroup(rows: readonly FlowRow[], selectedId: string, follow: string | null): string | null {
    if (rows.length === 0 || rows.some((r) => r.theme.id === selectedId)) return null;
    const owner = follow ? rows.find((r) => r.codes.includes(follow)) : undefined;
    return (owner ?? rows.reduce((a, b) => (b.flow.total > a.flow.total ? b : a))).theme.id;
}

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
    const [heatForm, setHeatFormState] = useState<HeatForm>(() => readPref(HEAT_FORM_KEY, ['map', 'list'] as const, 'map'));

    const setThemeId = useCallback((id: string) => {
        setThemeIdState(id);
        writePref(THEME_KEY, id);
    }, []);

    // ── 細產業: built from the company cards on first use; their members outside
    // the chain/theme universe get their own K-bar batch only while this kind is shown ──
    const { cards, error: cardsError, retry: retryCards } = useCards(kind === 'industry');
    const industries = useMemo(() => (cards ? industryThemes(cards.values()) : null), [cards]);
    const industryLoading = kind === 'industry' && !industries;
    const industryExtra = useMemo<FeedMember[]>(() => {
        if (kind !== 'industry' || !industries || !cards || !themes) return [];
        const universe = new Set(memberCodes(themes));
        const quotes = ready?.market?.quotes;
        return feedMembers(
            industries,
            (code) => cards.get(code)?.market,
            (code) => quotes?.[code]?.shares ?? null,
        ).filter((m) => !universe.has(m.code));
    }, [kind, industries, cards, themes, ready?.market]);
    const extraKey = industryExtra.map((m) => m.code).join(',');
    useEffect(
        () => (industryExtra.length > 0 ? connectChainFlow(industryExtra, 'drill') : undefined),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [extraKey],
    );

    // ── group rows (each view orders them itself); 全部 is chains and themes ──
    const pool = useMemo(
        () => (kind === 'industry' ? (industries ?? []) : (themes ?? []).filter((t) => kind === 'all' || t.kind === kind)),
        [themes, industries, kind],
    );
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
        return (
            themes.find((t) => t.id === themeId) ??
            // a 細產業 stays selected only while 細產業 is shown (its extra K-bars stop otherwise)
            (kind === 'industry' ? industries?.find((t) => t.id === themeId) : undefined) ??
            themes.find((t) => t.id === DEFAULT_THEME) ??
            themes[0] ??
            null
        );
    }, [themes, industries, themeId, kind]);
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
        // 細產業 still loading: wait, or the saved selection gives way to a chain
        if (kind === 'industry' && !industries) return;
        const id = `tw.${linkedCode}`;
        if (theme.members.some((m) => m.id === id)) {
            setFocus(linkedCode);
            return;
        }
        // only groups of the current 類型, or the lists would show no selection
        const owners = pool.filter((t) => t.members.some((m) => m.id === id));
        const next = owners.find((t) => t.kind === 'chain' && t.id !== 'chain.finance') ?? owners[0];
        if (next) {
            setThemeId(next.id);
            setFocus(linkedCode);
        }
        // only react to the linked code, not to theme switches made here
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedCode, themes, pool]);

    // when the list (on open, or after a 類型 switch) lacks the selection, select the group of the
    // linked / followed stock, else the list's largest group (today's turnover); waits for the list
    // (細產業 loads its cards first)
    const checkedKind = useRef<KindFilter | null>(null);
    useEffect(() => {
        // also waits for the snapshots: before them every turnover is 0
        if (checkedKind.current === kind || !theme || !rows.some((r) => r.flow.total > 0)) return;
        checkedKind.current = kind;
        const next = fallbackGroup(rows, theme.id, linkedCode ?? focus);
        if (next) setThemeId(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, rows, theme, setThemeId]);

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
            {/* three levels: the view (tabs), what to include (segments), then quiet display settings beside the feed status */}
            <div className={s.toolbar}>
                <Segment
                    variant='tabs'
                    label='視圖'
                    value={view}
                    onChange={(v) => {
                        setViewState(v);
                        writePref(VIEW_KEY, v);
                        onViewChange?.(v);
                    }}
                    options={[
                        { value: 'rank', label: '金流', title: '族群淨流入排行，長度為淨流入、粗細為成交值，每分鐘更新名次' },
                        { value: 'rotation', label: '輪動', title: '族群輪動象限：橫軸淨流入、縱軸資金動能，每分鐘更新位置與軌跡' },
                        { value: 'heat', label: '漲跌', title: '族群與成分股的熱力圖或清單，點族群看成分股' },
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
                        { value: 'all', label: '全部', title: '產業鏈與題材' },
                        { value: 'chain', label: '產業鏈' },
                        { value: 'theme', label: '題材' },
                        {
                            value: 'industry',
                            label: '細產業',
                            title: `細產業（第三方 AI 研究分類，${INDUSTRY_MIN} 檔以上）；選取時才另外訂閱不在產業鏈與題材內的成分股 1 分 K`,
                        },
                    ]}
                />
                <span className={s.toolSide}>
                {view === 'heat' && (
                    <Segment
                        label='呈現'
                        value={heatForm}
                        onChange={(v) => {
                            setHeatFormState(v);
                            writePref(HEAT_FORM_KEY, v);
                        }}
                        options={[
                            {
                                value: 'map',
                                label: '熱力圖',
                                title: '熱力圖：族群與成分股方塊，面積為成交值、顏色為今日漲跌幅',
                                icon: <LayoutGrid size={12} aria-hidden='true' />,
                            },
                            {
                                value: 'list',
                                label: '清單',
                                title: '清單：左邊族群、右邊所選族群成分股，點欄位標題排序',
                                icon: <List size={12} aria-hidden='true' />,
                            },
                        ]}
                    />
                )}
                {view === 'rank' && (
                    <Select
                        label='排行區間'
                        title={`排行區間：最近幾根 1 分 K 的淨流入（估算），或開啟面板後的累計${from !== null ? `（${slotLabel(from)} 起）` : ''}`}
                        value={metric}
                        onChange={(v) => {
                            setMetricState(v);
                            writePref(METRIC_KEY, v);
                        }}
                        options={[
                            { value: '5', label: '近 5 分' },
                            { value: '15', label: '近 15 分' },
                            { value: '30', label: '近 30 分' },
                            { value: 'cum', label: '累計' },
                        ]}
                    />
                )}
                {view === 'heat' && (
                    <Select
                        label='淨流入區間'
                        title='淨流入區間：方塊數字、細條與清單淨流入欄用最近幾根 1 分 K（顏色是今日漲跌，不受影響）'
                        value={heatWindow}
                        onChange={(v) => {
                            setHeatWindowState(v);
                            writePref(HEAT_WINDOW_KEY, v);
                        }}
                        options={[
                            { value: '5', label: '近 5 分' },
                            { value: '10', label: '近 10 分' },
                        ]}
                    />
                )}
                <FeedStatus feed={chainFeed} />
                </span>
            </div>

            <div className={s.views}>
                {industryLoading && (
                    <div className={s.center}>
                        <AsyncStatus
                            phase={cardsError ? 'error' : 'loading'}
                            text={cardsError ?? '讀取細產業…'}
                            action={
                                cardsError ? (
                                    <button type='button' className={panel.btn} onClick={retryCards}>
                                        重試
                                    </button>
                                ) : undefined
                            }
                        />
                    </div>
                )}
                {!industryLoading && view === 'rotation' && (
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
                {!industryLoading && view === 'rank' && (
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
                        focus={focus}
                        onPick={pick}
                    />
                )}
                {!industryLoading && view === 'heat' && (
                    <FlowHeat
                        rows={rows}
                        now={now}
                        window={Number(heatWindow)}
                        form={heatForm}
                        selectedId={theme.id}
                        focusCode={focus}
                        selectedName={theme.name}
                        selectedCodes={selectedCodes}
                        nameOf={nameOf}
                        reducedMotion={reducedMotion}
                        onSelect={setThemeId}
                        onPick={pick}
                    />
                )}
            </div>

            {/* 細產業 have no upstream / downstream stages: only the followed stock's card */}
            {showDetail && view !== 'heat' && (tiers.length > 0 || focus !== null) && !industryLoading && (
                <div className={s.detail}>
                    <div className={s.detailHead}>
                        <span className={s.kindMark[markKind(theme.kind)]} aria-hidden='true' />
                        <span className={s.detailTitle}>{theme.name}</span>
                        <span className={s.detailMeta}>
                            {themeCodes(theme).length} 檔・
                            {now !== null ? '累計淨流入走勢・近 15 分鐘資金占比變化' : closed ? '今日收盤彙總；盤中依 1 分 K 顯示資金流向' : '開盤至今彙總，下一根 1 分 K 起顯示走勢'}
                        </span>
                    </div>
                    <div className={`${s.detailBody} ${focus ? s.detailBodyFocus : ''}`}>
                        {tiers.length > 0 && (
                            <div className={s.tiers} style={{ gridTemplateColumns: `repeat(${tiers.length}, minmax(0, 1fr))` }}>
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
                        )}
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
                    淨流入為估算值：每分鐘成交值依收盤價相對前一分鐘漲跌給予正負號。{kind === 'industry' ? '細產業為第三方 AI 研究分類' : `產業鏈與題材為第三方 AI 整理資料（${ready?.themesMeta.asOf ?? '--'}）`}，可能過時或有誤
                </span>
            </div>
        </div>
    );
}
