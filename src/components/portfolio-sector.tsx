// src/components/portfolio-sector.tsx — body of the 持股族群 panel: the user's
// stock holdings grouped by 族群（官方產業別）／產業鏈／題材, read against the
// same live 1-minute K-bar flow as 產業鏈資金流向 (shared feed, chain-feed.tsx).
//
// Two forms share one data model (lib/portfolio-sector.ts) and one chrome
// (KPI strip, in-panel flip alerts, empty states):
// - bubble: 持股泡泡 — each held group is a large circle placed by its recent
//   flow share (x) and change today (y); my holdings are packed inside it,
//   size = market value, colour = change today.
// - lanes:  資金通道 — one lane per held group, thickness = my weight,
//   length = the group's net flow, reorders each minute.
// 族群 flow comes from the index_components group metrics (shared with
// 產業全景); 產業鏈／題材 flow from the shared 1-minute K-bar book.
// Requests: the group-metric subscriptions are ref-counted with 產業全景 (no
// extra request while it is open); one drill K-bar batch for held codes outside
// the chain/theme universe; cards come from the shared shioaji-data reader.

import { AlertTriangle, BellRing, Briefcase, LogIn, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { slotLabel, type FlowBook } from '../lib/chain-flow';
import { connectChainFlow, type FeedMember } from '../lib/chain-flow-feed';
import { fmtSignedPct, fmtTwd, memberCodes, stockContract } from '../lib/chain-map';
import { useAccounts } from '../lib/account-store';
import type { Theme } from '../lib/company-data/types';
import {
    buildAssigner,
    detectFlips,
    GROUPING_LABEL,
    GROUPINGS,
    portfolioView,
    useCards,
    useHoldings,
    type FlipAlert,
    type Grouping,
} from '../lib/portfolio-sector';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import { icFlowRecorder, useIcSectorFlow } from '../lib/sector-flow-ic';
import { refreshTradingState } from '../lib/trading-state';
import { HOLDING_FORMS, panelPref, type HoldingForm } from '../lib/workspace';
import { AsyncStatus } from './async-status';
import { dir, readPref, Segment, useSharedPref, writePref } from './chain-ui';
import { Odometer } from './odometer';
import { HoldingBubbles } from './portfolio-bubbles';
import { HoldingLanes } from './portfolio-lanes';
import type { VariantProps } from './portfolio-types';
import * as s from './portfolio-sector.css';

const FORM_KEY = 'sj-pro-chainmap-holding-form';
const GROUPING_KEY = 'sj-pro-chainmap-holding-grouping';

const FORMS = HOLDING_FORMS;

export function PortfolioSector({
    themes,
    book,
    revision,
    now,
    from,
    nameOf,
    reducedMotion,
    paused,
    onPick,
    status,
    form: panelForm,
    grouping: panelGrouping,
    onFormChange,
    onGroupingChange,
}: {
    themes: readonly Theme[];
    book: FlowBook;
    revision: number;
    now: number | null;
    from: number | null;
    nameOf: (code: string) => string;
    reducedMotion: boolean;
    paused: boolean;
    onPick: (code: string) => void;
    /** Feed status shown at the end of the alert line. */
    status?: ReactNode;
    /** The panel's own 呈現 / 分組 (saved with the layout); absent = last choice. */
    form?: HoldingForm;
    grouping?: Grouping;
    onFormChange?: (form: HoldingForm) => void;
    onGroupingChange?: (grouping: Grouping) => void;
}) {
    const { accounts } = useAccounts();
    const holdings = useHoldings();
    const { cards, error: cardsError } = useCards(true);
    const privacyMoney = usePrivacyMoney();
    const [savedForm, setFormState] = useSharedPref<HoldingForm>(panelForm, () => readPref(FORM_KEY, FORMS, 'bubble'));
    const [savedGrouping, setGroupingState] = useSharedPref<Grouping>(panelGrouping, () => readPref(GROUPING_KEY, GROUPINGS, 'sector'));
    const form = panelPref(panelForm, FORMS, savedForm);
    const grouping = panelPref(panelGrouping, GROUPINGS, savedGrouping);
    // the selected group id belongs to one grouping: drop it whenever the grouping changes (switch, preset or Agent spec)
    const [selection, setSelection] = useState<{ grouping: Grouping; id: string } | null>(null);
    const selectedGroup = selection?.grouping === grouping ? selection.id : null;
    const setSelectedGroup = (id: string | null) => setSelection(id === null ? null : { grouping, id });
    const effective = grouping;
    const icRevision = useIcSectorFlow(true);

    // held codes outside the chain/theme universe get their own K-bar batch
    const universe = useMemo(() => new Set(memberCodes(themes)), [themes]);
    // wait for the cards: the market decides the contract's exchange (TSE / OTC)
    const extra = useMemo<FeedMember[]>(
        () =>
            !cards
                ? []
                : holdings.holdings
                      .filter((h) => !universe.has(h.code))
                      .map((h) => ({ code: h.code, contract: stockContract(h.code, cards.get(h.code)?.market), shares: null })),
        [holdings.holdings, universe, cards],
    );
    const extraKey = extra.map((m) => `${m.code}@${m.contract.exchange}`).sort().join(',');
    useEffect(() => (extra.length > 0 ? connectChainFlow(extra, 'drill') : undefined),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [extraKey]);

    const assign = useMemo(() => (cards ? buildAssigner(effective, themes, cards) : null), [effective, themes, cards]);
    const view = useMemo(
        () =>
            assign
                ? portfolioView(holdings.holdings, assign, book, now, nameOf, (def) =>
                      effective === 'sector' && def.icKeys?.length ? icFlowRecorder.groupFlow(def.icKeys, now) : null,
                  )
                : null,
        // the book and the recorder mutate in place: the revisions are the change signals
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [assign, holdings.holdings, revision, icRevision, now, nameOf, effective],
    );

    // flip alerts: a held group turns from net inflow to net outflow (or back)
    const flipState = useRef<{ grouping: Grouping; slot: number | null; signs: Map<string, 1 | -1> }>({
        grouping: effective,
        slot: null,
        signs: new Map(),
    });
    const [alerts, setAlerts] = useState<FlipAlert[]>([]);
    const [flips, setFlips] = useState<Map<string, FlipAlert>>(new Map());
    useEffect(() => {
        if (!view || now === null) return;
        const st = flipState.current;
        if (st.grouping !== effective) {
            flipState.current = { grouping: effective, slot: now, signs: detectFlips(new Map(), view.groups, now).next };
            setAlerts([]);
            setFlips(new Map());
            return;
        }
        if (st.slot === now) return;
        const { next, alerts: fresh } = detectFlips(st.signs, view.groups, now);
        flipState.current = { grouping: effective, slot: now, signs: next };
        setFlips(new Map(fresh.map((a) => [a.groupId, a])));
        if (fresh.length > 0) setAlerts((list) => [...fresh.reverse(), ...list].slice(0, 4));
    }, [view, now, effective]);

    const setForm = (v: HoldingForm) => {
        setFormState(v);
        writePref(FORM_KEY, v);
        onFormChange?.(v);
    };
    const setGrouping = (v: Grouping) => {
        setGroupingState(v);
        writePref(GROUPING_KEY, v);
        onGroupingChange?.(v);
        setSelectedGroup(null);
    };

    const controls = (
        <div className={s.controls}>
            <Segment
                label='呈現'
                value={form}
                onChange={setForm}
                options={[
                    { value: 'bubble', label: '泡泡', title: '每個持有分組一個外圓，依資金與漲跌放置；持股排在圓內，大小為市值' },
                    { value: 'lanes', label: '通道', title: '每個持有分組一條通道，粗細為持股權重，長度為該分組淨流入' },
                ]}
            />
            <Segment
                label='分組'
                value={grouping}
                onChange={setGrouping}
                options={GROUPINGS.map((g) => ({
                    value: g,
                    label: GROUPING_LABEL[g],
                    title: {
                        sector: '依官方產業別分組，資金取自產業全景同一份產業指標',
                        chain: '依主要產業鏈分組（shioaji-data）',
                        theme: '依主要題材分組，每檔只算一個題材，其他題材列在提示中',
                    }[g],
                }))}
            />
        </div>
    );

    // ── empty states ──
    if (accounts.length === 0 && !holdings.holdings.length) {
        return (
            <div className={s.root}>
                <div className={s.empty}>
                    <LogIn size={22} className={s.emptyIcon} aria-hidden='true' />
                    <span className={s.emptyTitle}>登入後顯示持股的族群資金</span>
                    <span>持股依族群、產業鏈或題材分組，對照各分組的即時資金流向。族群與題材的資金流不需登入，可在「產業鏈資金流向」面板查看。</span>
                </div>
            </div>
        );
    }
    if (holdings.phase === 'loading' || (!cards && !cardsError)) {
        return (
            <div className={s.root}>
                <div className={s.empty}>
                    <AsyncStatus phase='loading' text={holdings.phase === 'loading' ? '讀取持股…' : '讀取公司分類資料…'} />
                </div>
            </div>
        );
    }
    if (holdings.phase === 'failed') {
        return (
            <div className={s.root}>
                <div className={s.empty}>
                    <AsyncStatus phase='error' text={`持股查詢失敗：${holdings.error ?? '未知錯誤'}`} />
                    <button type='button' className={s.retry} onClick={() => void refreshTradingState('positions')}>
                        <RotateCw size={12} aria-hidden='true' />
                        重新查詢
                    </button>
                </div>
            </div>
        );
    }
    if (cardsError && !cards) {
        return (
            <div className={s.root}>
                <div className={s.empty}>
                    <AsyncStatus phase='error' text={`公司分類資料無法取得：${cardsError}`} />
                </div>
            </div>
        );
    }
    if (holdings.holdings.length === 0 || !view) {
        return (
            <div className={s.root}>
                <div className={s.empty}>
                    <Briefcase size={22} className={s.emptyIcon} aria-hidden='true' />
                    <span className={s.emptyTitle}>目前沒有現股庫存</span>
                    <span>買進股票後，這裡會依族群、產業鏈或題材顯示持股與各分組的即時資金流向。</span>
                </div>
            </div>
        );
    }

    const dayDir = dir(view.dayPnl);
    const dayPct = view.total - view.dayPnl > 0 ? (view.dayPnl / (view.total - view.dayPnl)) * 100 : null;
    const props: VariantProps = {
        view,
        grouping: effective,
        now,
        from,
        session: book.date,
        flips,
        privacyMoney,
        reducedMotion,
        paused,
        selectedGroup,
        onSelectGroup: setSelectedGroup,
        onPick,
    };

    return (
        <div className={s.root}>
            <div className={s.head}>
                <div className={s.kpi}>
                    <span className={s.kpiLabel}>今日持股損益</span>
                    <span className={`${s.kpiBig} ${s.tone[dayDir]}`}>
                        {privacyMoney ? maskMoney('', true) : <Odometer text={fmtTwd(view.dayPnl, true).replace(' ', '')} reducedMotion={reducedMotion} />}
                        <span className={`${s.kpiSub} ${s.tone[dayDir]}`}>{fmtSignedPct(dayPct)}</span>
                    </span>
                </div>
                <div className={s.kpi}>
                    <span className={s.kpiLabel}>持股市值</span>
                    <span className={s.kpiValue}>
                        {maskMoney(fmtTwd(view.total), privacyMoney)}
                        <span className={s.kpiSub}>{view.stocks.length} 檔・{view.groups.length} 個{GROUPING_LABEL[effective]}</span>
                    </span>
                </div>
                <div className={s.kpi} title={`持股市值中，所屬${GROUPING_LABEL[effective]}近 10 分鐘為淨流入的比重`}>
                    <span className={s.kpiLabel}>順資金比重（近 10 分）</span>
                    <span className={s.kpiValue}>{now !== null ? `${Math.round(view.alignedShare * 100)}%` : '--'}</span>
                    <span className={s.alignBar} aria-hidden='true'>
                        <span className={s.alignFill} style={{ width: `${now !== null ? view.alignedShare * 100 : 0}%` }} />
                    </span>
                </div>
                {controls}
            </div>
            <div className={s.alerts} aria-live='polite'>
                {holdings.error && (
                    <span className={s.alert} title={holdings.error}>
                        <AlertTriangle size={11} className={s.alertIcon} aria-hidden='true' />
                        持股查詢失敗，顯示上次結果
                        <button type='button' className={s.retry} onClick={() => void refreshTradingState('positions')}>
                            <RotateCw size={11} aria-hidden='true' />
                            重新查詢
                        </button>
                    </span>
                )}
                {alerts.length > 0 ? (
                    alerts.map((a) => (
                        <span key={`${a.groupId}-${a.slot}`} className={s.alert}>
                            <BellRing size={11} className={s.alertIcon} aria-hidden='true' />
                            <span className={s.alertTime}>{slotLabel(a.slot)}</span>
                            <span className={s.alertName}>{a.name}</span>
                            {a.to === 'out' ? '轉為淨流出' : '轉為淨流入'}・持有 {a.held} 檔
                        </span>
                    ))
                ) : (
                    !holdings.error && <span>持有分組由淨流入轉為淨流出時會在此提示</span>
                )}
                {status && <span className={s.status}>{status}</span>}
            </div>
            <div className={s.body}>
                {form === 'bubble' && <HoldingBubbles {...props} />}
                {form === 'lanes' && <HoldingLanes {...props} />}
            </div>
        </div>
    );
}
