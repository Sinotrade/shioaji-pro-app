// src/components/company-panel.tsx — 公司資料面板（#337）
//
// Follows the panel's contract (selection / link group / pin). Shows who the
// company is, where it sits in its value chain, its themes, suppliers and
// customers (with live quotes for Taiwan counterparties), official revenue
// and quarterly statements, and every source. Research text is framed as
// third-party data with its as_of date; unresearched companies say they only
// have official data. Reads go through the shared shioaji-data reader, the
// same one the Agent tools use.

import { useMemo, useState } from 'react';
import {
    Building2,
    ChevronRight,
    CircleAlert,
    Database,
    ExternalLink as ExternalLinkIcon,
    FileText,
    Globe,
    Info,
    Layers,
    Network,
    Star,
    WifiOff,
    X,
} from 'lucide-react';
import { staleParts, useCompanyData, useCompanyEntities, type CompanyDataView } from '../hooks/use-company-data';
import { useLiveSnapshots } from '../hooks/use-live-snapshots';
import { useQuote } from '../hooks/use-stream';
import {
    MARKET_LABEL,
    STALE_TEXT,
    entityIndex,
    entityName,
    normalizeCompanyCode,
    quarterMetrics,
    recentRevenue,
    stageName,
    tierLabel,
    trailingEps,
    twCodeOf,
    type DataMeta,
} from '../lib/company-data';
import type {
    ChainTier,
    Company,
    Entity,
    Financials,
    RelationRow,
    Theme,
} from '../lib/company-data/types';
import type { ContractBase, ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import { AsyncStatus } from './async-status';
import { ExternalLink } from './external-link';
import { RefreshButton } from './refresh-button';
import * as panel from './panel.css';
import * as s from './company-panel.css';

type Tab = 'overview' | 'financials' | 'relations' | 'sources';
const TIERS: ChainTier[] = ['upstream', 'midstream', 'downstream'];
const MIX_OPACITY = [1, 0.7, 0.5, 0.36, 0.25, 0.17, 0.12];

// ── formatting ────────────────────────────────────────────────────────────

/** TWD amount → 兆／億 with sensible precision. */
export function fmtTwd(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e12) return `${(v / 1e12).toFixed(2)} 兆`;
    if (a >= 1e8) return `${(v / 1e8).toLocaleString('en-US', { maximumFractionDigits: a >= 1e10 ? 0 : 1 })} 億`;
    if (a >= 1e4) return `${(v / 1e4).toLocaleString('en-US', { maximumFractionDigits: 0 })} 萬`;
    return v.toLocaleString('en-US');
}

/** Thousand-TWD statement amount → 億. */
const fmtK = (v: number | null | undefined) => (v === null || v === undefined ? '—' : fmtTwd(v * 1000));
const fmtRatio = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
const fmtGrowth = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

// ── target & live price ───────────────────────────────────────────────────

/** Company code for a contract: the stock itself, or a stock derivative's underlying. */
export function companyTarget(contract: ContractInfo): { code: string; viaUnderlying: boolean } | null {
    if (contract.security_type === 'STK') {
        const code = normalizeCompanyCode(contract.code);
        return code ? { code, viaUnderlying: false } : null;
    }
    if (contract.security_type === 'IND' || contract.underlying_kind === 'I') return null;
    const underlying = normalizeCompanyCode(contract.underlying_code ?? '');
    return underlying ? { code: underlying, viaUnderlying: true } : null;
}

interface LivePrice {
    price: number | null;
    change: number | null;
    pct: number | null;
    /** null = live quote; otherwise the daily-close date it came from */
    closeDate: string | null;
}

function useLivePrice(code: string, snapshot: Snapshot | undefined, daily: CompanyDataView['market']): LivePrice {
    const quote = useQuote(code);
    const tick = quote?.tick;
    if (tick && !tick.simtrade && Number(tick.close) > 0) {
        const price = Number(tick.close);
        const change = tick.price_chg !== undefined ? Number(tick.price_chg) : null;
        const pct = tick.pct_chg !== undefined ? Number(tick.pct_chg) : null;
        return { price, change, pct, closeDate: null };
    }
    if (snapshot && snapshot.code === code && snapshot.close > 0) {
        return { price: snapshot.close, change: snapshot.change_price, pct: snapshot.change_rate, closeDate: null };
    }
    const q = daily?.quotes[code];
    return { price: q?.close ?? null, change: null, pct: null, closeDate: q?.date ?? null };
}

const dirClass = (v: number | null | undefined) =>
    v === null || v === undefined || v === 0 ? panel.dirText.flat : v > 0 ? panel.dirText.up : panel.dirText.down;

// ── panel ─────────────────────────────────────────────────────────────────

export function CompanyPanel({
    contract,
    snapshot,
    onPick,
}: {
    contract: ContractInfo;
    snapshot?: Snapshot;
    onPick?: (code: string) => void;
}) {
    const target = companyTarget(contract);
    const { state, status, refresh } = useCompanyData(target?.code ?? null);

    if (!target) {
        return (
            <div className={s.center}>
                <Building2 size={22} className={s.centerIcon} aria-hidden='true' />
                <span>公司資料僅支援上市櫃股票，以及個股期貨、個股選擇權的標的公司</span>
            </div>
        );
    }
    if (!state || state.phase === 'loading') {
        return (
            <div className={s.center}>
                <AsyncStatus phase='loading' text='載入公司資料…' />
            </div>
        );
    }
    if (state.phase === 'error') {
        const missing = state.errorCode === 'not_found';
        return (
            <div className={s.center}>
                {missing ? (
                    <Building2 size={22} className={s.centerIcon} aria-hidden='true' />
                ) : state.errorCode === 'offline' ? (
                    <WifiOff size={22} className={s.centerIcon} aria-hidden='true' />
                ) : (
                    <CircleAlert size={22} className={panel.statusText.err} aria-hidden='true' />
                )}
                <span role={missing ? undefined : 'alert'}>
                    {missing
                        ? `${target.code} 不在公司資料收錄範圍（收錄上市櫃公司；ETF、權證與興櫃不在內）`
                        : state.error}
                </span>
                {!missing && state.errorCode !== 'unsupported_schema' && (
                    <RefreshButton label='重新讀取公司資料' onClick={refresh} />
                )}
            </div>
        );
    }
    return (
        <CompanyView
            view={state}
            refreshing={state.refreshing}
            stale={staleParts(state).length > 0 || status.phase === 'stale'}
            viaUnderlying={target.viaUnderlying ? contract : null}
            snapshot={snapshot}
            onPick={onPick}
            onRefresh={refresh}
        />
    );
}

function CompanyView({
    view,
    refreshing,
    stale,
    viaUnderlying,
    snapshot,
    onPick,
    onRefresh,
}: {
    view: CompanyDataView;
    refreshing: boolean;
    stale: boolean;
    viaUnderlying: ContractInfo | null;
    snapshot?: Snapshot;
    onPick?: (code: string) => void;
    onRefresh: () => void;
}) {
    const { company: c } = view;
    const researched = c.has_research && c.as_of !== null;
    const [tab, setTab] = useState<Tab>('overview');
    const [focus, setFocus] = useState<Focus | null>(null);
    const live = useLivePrice(c.code, snapshot, view.market);
    const entities = useCompanyEntities(tab === 'relations' || focus !== null);
    const relationCount = useMemo(
        () => Object.values(c.relations ?? {}).reduce((n, rows) => n + (rows?.length ?? 0), 0),
        [c],
    );
    const evidenceCount = Object.keys(c.evidence ?? {}).length;

    const tabs: { id: Tab; label: string; count?: number }[] = [
        { id: 'overview', label: '概覽' },
        { id: 'financials', label: '財務' },
        { id: 'relations', label: '上下游', count: researched ? relationCount : undefined },
        { id: 'sources', label: '來源', count: evidenceCount || undefined },
    ];

    return (
        <div className={s.root}>
            <div className={s.scroll}>
                <Header company={c} live={live} viaUnderlying={viaUnderlying} />
                <Kpis view={view} live={live} />
                <div className={s.tabs} role='tablist' aria-label='公司資料分頁'>
                    {tabs.map((t) => (
                        <button
                            key={t.id}
                            type='button'
                            role='tab'
                            aria-selected={tab === t.id}
                            className={s.tab}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                            {t.count !== undefined && <span className={s.tabCount}>{t.count}</span>}
                        </button>
                    ))}
                </div>
                <div role='tabpanel'>
                    {tab === 'overview' && (
                        <Overview
                            view={view}
                            researched={researched}
                            focus={focus}
                            onFocus={setFocus}
                            entities={entities}
                            onPick={onPick}
                        />
                    )}
                    {tab === 'financials' && <FinancialsTab view={view} />}
                    {tab === 'relations' && (
                        <RelationsTab company={c} researched={researched} entities={entities} onPick={onPick} />
                    )}
                    {tab === 'sources' && <SourcesTab view={view} researched={researched} />}
                </div>
            </div>
            <Footer view={view} researched={researched} stale={stale} refreshing={refreshing} onRefresh={onRefresh} />
        </div>
    );
}

// ── header & KPIs ─────────────────────────────────────────────────────────

function Header({
    company: c,
    live,
    viaUnderlying,
}: {
    company: Company;
    live: LivePrice;
    viaUnderlying: ContractInfo | null;
}) {
    const ind = c.industry ?? {};
    const research = [ind.l1_name, ind.l2_name, ind.l3_name].filter(Boolean) as string[];
    return (
        <div className={s.head}>
            <div className={s.headRow}>
                <span className={s.code}>{c.code}</span>
                <span className={s.name}>{c.name}</span>
                <span className={`${s.chip} ${s.chipTone.neutral}`}>{MARKET_LABEL[c.market] ?? c.market}</span>
                {c.english_short && <span className={s.english}>{c.english_short}</span>}
                <span className={s.price}>
                    <span className={`${s.priceValue} ${dirClass(live.change)}`}>{fmtPrice(live.price ?? undefined)}</span>
                    {live.closeDate === null ? (
                        <span className={`${s.priceChange} ${dirClass(live.change)}`}>
                            {fmtSigned(live.change ?? undefined)} {fmtPct(live.pct ?? undefined)}
                        </span>
                    ) : (
                        live.price !== null && <span className={s.priceNote}>收盤 {live.closeDate}</span>
                    )}
                </span>
            </div>
            <div className={s.crumbs}>
                {ind.l0_name && (
                    <span className={`${s.chip} ${s.chipTone.official}`} title='交易所產業別'>
                        {ind.l0_name}
                    </span>
                )}
                {research.map((label, i) => (
                    <span key={label} className={s.crumbs}>
                        {i > 0 && (
                            <span className={s.crumbSep} aria-hidden='true'>
                                <ChevronRight size={11} />
                            </span>
                        )}
                        <span className={i === research.length - 1 ? s.crumbStrong : undefined}>{label}</span>
                    </span>
                ))}
                {viaUnderlying && (
                    <span className={`${s.chip} ${s.chipTone.accent}`} title={`${viaUnderlying.code} 的標的公司`}>
                        {viaUnderlying.code} 標的
                    </span>
                )}
            </div>
        </div>
    );
}

function Kpis({ view, live }: { view: CompanyDataView; live: LivePrice }) {
    const fin = view.financials;
    const shares = view.market?.quotes[view.code]?.shares ?? null;
    const cap = live.price !== null && shares ? live.price * shares : view.market?.quotes[view.code]?.market_cap_twd ?? null;
    const eps = fin ? trailingEps(fin) : null;
    const pe = live.price !== null && eps !== null && eps > 0 ? live.price / eps : null;
    const latestQ = fin ? quarterMetrics(fin, 1)[0] : undefined;
    const months = fin ? recentRevenue(fin, 1) : [];
    const lastMonth = months[months.length - 1];
    const items = [
        {
            label: '市值',
            value: fmtTwd(cap),
            sub: `${live.closeDate === null ? '即時價 × 股數' : `收盤 ${live.closeDate ?? '—'}`}${view.marketMeta?.stale ? ' · 快取' : ''}`,
        },
        { label: '本益比', value: pe !== null ? pe.toFixed(1) : '—', sub: eps !== null ? `近四季 EPS ${eps.toFixed(2)}` : '近四季 EPS —' },
        {
            label: '月營收',
            value: lastMonth ? fmtK(lastMonth.revenue_thousand_twd) : '—',
            sub: lastMonth ? `${lastMonth.period} 年增 ${fmtGrowth(lastMonth.yoy_pct)}` : '—',
        },
        {
            label: latestQ?.grossMarginPct !== null && latestQ?.grossMarginPct !== undefined ? '毛利率' : '淨利率',
            value: fmtRatio(latestQ?.grossMarginPct ?? latestQ?.netMarginPct),
            sub: latestQ ? latestQ.period : '—',
        },
    ];
    return (
        <div className={s.kpis}>
            {items.map((it) => (
                <div key={it.label} className={s.kpi}>
                    <span className={s.kpiLabel}>{it.label}</span>
                    <span className={s.kpiValue}>{it.value}</span>
                    <span className={s.kpiSub}>{it.sub}</span>
                </div>
            ))}
        </div>
    );
}

// ── overview ──────────────────────────────────────────────────────────────

interface Focus {
    themeId: string;
    stageIds: string[] | null;
    title: string;
}

function ThirdPartyChip({ asOf }: { asOf: string | null }) {
    return (
        <span
            className={`${s.chip} ${s.chipTone.thirdParty}`}
            title='AI 依公開文件整理並經多個模型交叉核對，可能過時或有誤'
        >
            第三方資料{asOf ? ` · ${asOf}` : ''}
        </span>
    );
}

function OfficialChip({ date }: { date?: string | null }) {
    return <span className={`${s.chip} ${s.chipTone.official}`}>官方資料{date ? ` · ${date}` : ''}</span>;
}

/** Marks one section as served from offline cache (verified, but maybe not the latest). */
function StaleTag({ meta }: { meta: DataMeta | null | undefined }) {
    if (!meta?.stale) return null;
    return (
        <span
            className={s.stale}
            title={`無法連線資料來源，顯示先前下載並驗證過的快取（版本 ${meta.releaseId}），未確認為最新`}
        >
            <WifiOff size={11} aria-hidden='true' />
            快取
        </span>
    );
}

function Overview({
    view,
    researched,
    focus,
    onFocus,
    entities,
    onPick,
}: {
    view: CompanyDataView;
    researched: boolean;
    focus: Focus | null;
    onFocus: (focus: Focus | null) => void;
    entities: Entity[] | null;
    onPick?: (code: string) => void;
}) {
    const c = view.company;
    const themes = view.themes;
    const chainTheme = c.chain ? themes?.find((t) => t.id === c.chain) : undefined;
    const ownStages = new Set([c.chain_stage?.stage, ...(c.chain_stage?.also ?? []).map((a) => a.stage)].filter(Boolean));

    return (
        <>
            {!researched && (
                <div className={s.section}>
                    <div className={s.notice} role='note'>
                        <Info size={14} aria-hidden='true' style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>
                            <span className={s.noticeTitle}>只有官方資料</span>
                            這家公司尚未納入研究，沒有業務摘要、產業鏈、題材與上下游資料。基本資料、收盤市值、月營收與季報為交易所與公開資訊觀測站的官方資料。
                        </span>
                    </div>
                </div>
            )}
            {researched && (c.summary_long || c.summary_short) && (
                <div className={s.section}>
                    <div className={s.sectionHead}>
                        <FileText size={12} aria-hidden='true' />
                        業務
                        <span className={s.sectionMeta}>
                            <StaleTag meta={view.meta} />
                            <ThirdPartyChip asOf={c.as_of} />
                        </span>
                    </div>
                    <p className={s.prose}>{c.summary_long ?? c.summary_short}</p>
                </div>
            )}
            {researched && c.chain_stage && (
                <div className={s.section}>
                    <div className={s.sectionHead}>
                        <Network size={12} aria-hidden='true' />
                        產業鏈位置
                        <span className={s.sectionMeta}>
                            <StaleTag meta={view.themesMeta} />
                            <span className={s.muted}>{chainTheme?.name ?? c.chain}</span>
                        </span>
                    </div>
                    <div className={s.chain}>
                        {TIERS.map((tier) => {
                            const stages = chainTheme
                                ? chainTheme.stages.filter((st) => st.tier === tier)
                                : c.chain_stage && c.chain_stage.tier === tier
                                  ? [{ id: c.chain_stage.stage, name: c.chain_stage.stage_name, tier }]
                                  : [];
                            return (
                                <div key={tier} className={s.tierCol}>
                                    <span className={s.tierHead}>{tierLabel(tier)}</span>
                                    {stages.map((st) => {
                                        const tone =
                                            st.id === c.chain_stage?.stage ? 'own' : ownStages.has(st.id) ? 'also' : 'other';
                                        const pressed =
                                            focus?.themeId === chainTheme?.id && focus?.stageIds?.[0] === st.id;
                                        return (
                                            <button
                                                key={st.id}
                                                type='button'
                                                className={`${s.stage} ${s.stageTone[tone]}`}
                                                aria-pressed={pressed}
                                                disabled={!chainTheme}
                                                title={tone === 'own' ? '主要階段' : tone === 'also' ? '兼營階段' : '看這一段的公司'}
                                                onClick={() =>
                                                    chainTheme &&
                                                    onFocus(
                                                        pressed
                                                            ? null
                                                            : { themeId: chainTheme.id, stageIds: [st.id], title: `${chainTheme.name} · ${st.name}` },
                                                    )
                                                }
                                            >
                                                <span className={s.stageLabel}>{st.name}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                    {c.chain_stage.reason && <p className={s.reason}>{c.chain_stage.reason}</p>}
                    {focus && focus.themeId === chainTheme?.id && chainTheme && (
                        <MemberList theme={chainTheme} focus={focus} view={view} entities={entities} onPick={onPick} onClose={() => onFocus(null)} />
                    )}
                </div>
            )}
            {researched && c.segments?.length > 0 && <RevenueMix company={c} />}
            {researched && c.themes?.length > 0 && (
                <div className={s.section}>
                    <div className={s.sectionHead}>
                        <Layers size={12} aria-hidden='true' />
                        題材
                        <span className={s.sectionMeta}>
                            <StaleTag meta={view.themesMeta} />
                        </span>
                    </div>
                    <div className={s.themeChips}>
                        {c.themes.map((ref) => {
                            const theme = themes?.find((t) => t.id === ref.theme);
                            const pressed = focus?.themeId === ref.theme;
                            return (
                                <button
                                    key={`${ref.theme}:${ref.stage}`}
                                    type='button'
                                    className={s.themeChip}
                                    aria-pressed={pressed}
                                    disabled={!theme}
                                    onClick={() =>
                                        theme &&
                                        onFocus(pressed ? null : { themeId: theme.id, stageIds: null, title: theme.name })
                                    }
                                >
                                    {ref.theme === c.main_theme && <Star size={11} aria-label='主題材' />}
                                    {theme?.name ?? ref.theme}
                                    <span className={s.themeStage}>
                                        {theme ? stageName(theme, ref.stage) : ref.stage} · {tierLabel(ref.tier)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    {focus && focus.themeId !== chainTheme?.id && (() => {
                        const theme = themes?.find((t) => t.id === focus.themeId);
                        return theme ? (
                            <MemberList theme={theme} focus={focus} view={view} entities={entities} onPick={onPick} onClose={() => onFocus(null)} />
                        ) : null;
                    })()}
                </div>
            )}
            <CompanyFacts company={c} officialDate={view.meta.officialFetchedAt} />
        </>
    );
}

function RevenueMix({ company: c }: { company: Company }) {
    const segments = c.segments.filter((seg) => seg.revenue_share_pct !== null);
    const period = segments[0]?.period;
    return (
        <div className={s.section}>
            <div className={s.sectionHead}>
                <Database size={12} aria-hidden='true' />
                營收組成
                {period && <span className={s.sectionMeta}><span className={s.muted}>{period}</span></span>}
            </div>
            {segments.length > 0 && (
                <div className={s.mixBar} role='img' aria-label='營收組成比例'>
                    {segments.map((seg, i) => (
                        <span
                            key={seg.id}
                            style={{
                                width: `${seg.revenue_share_pct}%`,
                                background: 'currentColor',
                                opacity: MIX_OPACITY[i] ?? 0.1,
                            }}
                            className={panel.dirText.flat}
                        />
                    ))}
                </div>
            )}
            <div className={s.mixList}>
                {c.segments.map((seg, i) => (
                    <span key={seg.id} className={s.mixItem}>
                        <span
                            className={s.swatch}
                            style={{ background: 'currentColor', opacity: MIX_OPACITY[i] ?? 0.1 }}
                            aria-hidden='true'
                        />
                        <span className={s.mixName}>{seg.name}</span>
                        <span className={panel.mono}>
                            {seg.revenue_share_pct !== null ? `${seg.revenue_share_pct}%` : '—'}
                        </span>
                    </span>
                ))}
            </div>
        </div>
    );
}

function MemberList({
    theme,
    focus,
    view,
    entities,
    onPick,
    onClose,
}: {
    theme: Theme;
    focus: Focus;
    view: CompanyDataView;
    entities: Entity[] | null;
    onPick?: (code: string) => void;
    onClose: () => void;
}) {
    const [all, setAll] = useState(false);
    const index = entities ? entityIndex(entities) : null;
    const cap = (id: string) => {
        const code = twCodeOf(id);
        return (code && view.market?.quotes[code]?.market_cap_twd) || 0;
    };
    const stageIds = focus.stageIds ? new Set(focus.stageIds) : null;
    const members = theme.members
        .filter((m) => !stageIds || stageIds.has(m.stage))
        .slice()
        .sort((a, b) => cap(b.id) - cap(a.id));
    const shown = all ? members : members.slice(0, 8);
    return (
        <div className={s.members}>
            <div className={s.membersHead}>
                {focus.title}
                <span className={s.groupCount}>{members.length}</span>
                <button type='button' className={s.close} onClick={onClose} aria-label='收合'>
                    <X size={12} />
                </button>
            </div>
            {shown.map((m) => {
                const code = twCodeOf(m.id);
                const self = code === view.code;
                return (
                    <button
                        key={`${m.id}:${m.stage}`}
                        type='button'
                        className={`${s.row} ${code && !self && onPick ? s.rowLink : ''}`}
                        disabled={!code || self || !onPick}
                        onClick={() => code && onPick?.(code)}
                    >
                        <span className={s.rowName}>
                            <span className={s.rowNameText}>{entityName(index, m.id)}</span>
                            {code && <span className={s.rowCode}>{code}</span>}
                        </span>
                        <span className={s.rowDetail} title={m.detail ?? undefined}>
                            {focus.stageIds ? m.detail : `${stageName(theme, m.stage)} · ${m.detail ?? ''}`}
                        </span>
                        <span className={s.rowEnd}>{fmtTwd(cap(m.id) || null)}</span>
                    </button>
                );
            })}
            {members.length > 8 && (
                <button type='button' className={s.more} onClick={() => setAll((v) => !v)}>
                    {all ? '收合' : `顯示全部 ${members.length} 家`}
                </button>
            )}
        </div>
    );
}

function CompanyFacts({ company: c, officialDate }: { company: Company; officialDate: string | null }) {
    const site = c.website ? (/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`) : null;
    return (
        <div className={s.section}>
            <div className={s.sectionHead}>
                <Building2 size={12} aria-hidden='true' />
                基本資料
                <span className={s.sectionMeta}>
                    <OfficialChip date={officialDate} />
                </span>
            </div>
            <dl className={s.facts}>
                {c.full_name && (
                    <>
                        <dt>公司名稱</dt>
                        <dd>{c.full_name}</dd>
                    </>
                )}
                {c.industry?.l0_name && (
                    <>
                        <dt>產業別</dt>
                        <dd>{c.industry.l0_name}</dd>
                    </>
                )}
                {c.listed && (
                    <>
                        <dt>{c.market === 'tpex' ? '上櫃日期' : '上市日期'}</dt>
                        <dd className={panel.mono}>{c.listed}</dd>
                    </>
                )}
                {c.incorporated && (
                    <>
                        <dt>成立日期</dt>
                        <dd className={panel.mono}>{c.incorporated}</dd>
                    </>
                )}
                {site && (
                    <>
                        <dt>網站</dt>
                        <dd>
                            <ExternalLink href={site} className={s.sourceLink}>
                                {c.website!.replace(/^https?:\/\//, '')}
                            </ExternalLink>
                        </dd>
                    </>
                )}
            </dl>
        </div>
    );
}

// ── financials ────────────────────────────────────────────────────────────

function RevenueChart({ fin }: { fin: Financials }) {
    const months = recentRevenue(fin, 36);
    const W = 360;
    const H = 116;
    const top = 12;
    const bottom = 16;
    const plotH = H - top - bottom;
    const values = months.map((m) => m.revenue_thousand_twd ?? 0);
    const max = Math.max(1, ...values);
    const yoy = months.map((m) => m.yoy_pct);
    const finiteYoy = yoy.filter((v): v is number => v !== null && Number.isFinite(v));
    const yMin = Math.min(0, ...finiteYoy);
    const yMax = Math.max(0, ...finiteYoy, 1);
    const slot = W / Math.max(1, months.length);
    const barW = Math.max(2, slot * 0.66);
    const yOf = (v: number) => top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
    const points = months
        .map((m, i) => (m.yoy_pct === null ? null : `${(i * slot + slot / 2).toFixed(1)},${yOf(m.yoy_pct).toFixed(1)}`))
        .filter(Boolean)
        .join(' ');
    const labelIdx = new Set([0, Math.floor((months.length - 1) / 2), months.length - 1]);
    return (
        <svg className={s.chart} viewBox={`0 0 ${W} ${H}`} role='img' aria-label='月營收與年增率'>
            <text x='0' y='9'>{fmtK(max)}</text>
            {months.map((m, i) => {
                const v = m.revenue_thousand_twd ?? 0;
                const h = (v / max) * plotH;
                return (
                    <rect
                        key={m.period}
                        x={i * slot + (slot - barW) / 2}
                        y={top + plotH - h}
                        width={barW}
                        height={h}
                        rx='1'
                        className={panel.dirText.flat}
                        style={{ fill: 'currentColor', opacity: i === months.length - 1 ? 0.9 : 0.42 }}
                    >
                        <title>{`${m.period} 營收 ${fmtK(m.revenue_thousand_twd)}，年增 ${fmtGrowth(m.yoy_pct)}，月增 ${fmtGrowth(m.mom_pct)}`}</title>
                    </rect>
                );
            })}
            {yMin < 0 && (
                <line x1='0' x2={W} y1={yOf(0)} y2={yOf(0)} strokeDasharray='2 3' strokeWidth='1' className={panel.dirText.flat} style={{ stroke: 'currentColor', opacity: 0.6 }} />
            )}
            <polyline points={points} fill='none' strokeWidth='1.5' className={s.yoyLine} />
            {months.map((m, i) =>
                labelIdx.has(i) ? (
                    <text key={`l-${m.period}`} x={i * slot + slot / 2} y={H - 3} textAnchor={i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle'}>
                        {m.period}
                    </text>
                ) : null,
            )}
        </svg>
    );
}

function FinancialsTab({ view }: { view: CompanyDataView }) {
    const fin = view.financials;
    if (!fin) {
        return (
            <div className={s.center}>
                <span>{view.financialsError ?? '這家公司沒有財報資料'}</span>
            </div>
        );
    }
    const months = recentRevenue(fin, 6).slice().reverse();
    const quarters = quarterMetrics(fin, 8);
    const general = quarters.some((q) => q.grossMarginPct !== null);
    return (
        <>
            <div className={s.section}>
                <div className={s.sectionHead}>
                    月營收
                    <span className={s.sectionMeta}>
                        <StaleTag meta={view.financialsMeta} />
                        <OfficialChip date={view.financialsMeta?.asOf} />
                    </span>
                </div>
                {fin.monthly_revenue.length > 0 ? (
                    <>
                        <RevenueChart fin={fin} />
                        <div className={s.legend}>
                            <span className={s.legendKey}>
                                <span className={`${s.swatch} ${panel.dirText.flat}`} style={{ background: 'currentColor', opacity: 0.5 }} />
                                營收（近 {Math.min(36, fin.monthly_revenue.length)} 個月）
                            </span>
                            <span className={s.legendKey}>
                                <span className={`${s.swatch} ${s.yoySwatch}`} />
                                年增率
                            </span>
                        </div>
                        <div className={s.tableWrap}>
                            <table className={s.table}>
                                <thead>
                                    <tr>
                                        <th>月份</th>
                                        <th>營收</th>
                                        <th>月增</th>
                                        <th>年增</th>
                                        <th>累計年增</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {months.map((m) => (
                                        <tr key={m.period}>
                                            <td>{m.period}</td>
                                            <td>{fmtK(m.revenue_thousand_twd)}</td>
                                            <td>{fmtGrowth(m.mom_pct)}</td>
                                            <td>{fmtGrowth(m.yoy_pct)}</td>
                                            <td>{fmtGrowth(m.ytd_yoy_pct)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                ) : (
                    <span className={s.muted}>沒有月營收資料</span>
                )}
            </div>
            <div className={s.section}>
                <div className={s.sectionHead}>
                    季度財報
                    <span className={s.sectionMeta}>
                        <span className={s.muted}>單季，合併報表</span>
                    </span>
                </div>
                {quarters.length > 0 ? (
                    <div className={s.tableWrap}>
                        <table className={s.table}>
                            <thead>
                                <tr>
                                    <th>季別</th>
                                    <th>營收</th>
                                    {general && <th>毛利率</th>}
                                    {general && <th>營益率</th>}
                                    <th>淨利率</th>
                                    <th>EPS</th>
                                </tr>
                            </thead>
                            <tbody>
                                {quarters.map((q) => (
                                    <tr key={q.period}>
                                        <td>{q.period}</td>
                                        <td>{fmtK(q.revenue)}</td>
                                        {general && <td>{fmtRatio(q.grossMarginPct)}</td>}
                                        {general && <td>{fmtRatio(q.operatingMarginPct)}</td>}
                                        <td>{fmtRatio(q.netMarginPct)}</td>
                                        <td>{q.eps !== null ? q.eps.toFixed(2) : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <span className={s.muted}>沒有季報資料</span>
                )}
                <span className={s.sourceMeta}>
                    金額為新台幣；淨利為歸屬母公司業主；來源：公開資訊觀測站彙總報表、證交所與櫃買中心開放資料
                </span>
            </div>
        </>
    );
}

// ── relations ─────────────────────────────────────────────────────────────

const GROUPS: { key: keyof Company['relations']; label: string }[] = [
    { key: 'suppliers', label: '供應商' },
    { key: 'customers', label: '客戶' },
    { key: 'partners', label: '合作夥伴' },
    { key: 'competitors', label: '競爭對手' },
    { key: 'subsidiaries', label: '子公司' },
    { key: 'parents', label: '母公司' },
    { key: 'transactions', label: '重大交易' },
];
const GROUP_PREVIEW = 6;
const LIVE_LIMIT = 40;

function RelationsTab({
    company: c,
    researched,
    entities,
    onPick,
}: {
    company: Company;
    researched: boolean;
    entities: Entity[] | null;
    onPick?: (code: string) => void;
}) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const groups = GROUPS.map((g) => ({ ...g, rows: c.relations?.[g.key] ?? [] })).filter((g) => g.rows.length > 0);
    const visible = groups.flatMap((g) => (expanded[g.key] ? g.rows : g.rows.slice(0, GROUP_PREVIEW)));
    const index = entities ? entityIndex(entities) : null;
    const contracts = useMemo(() => {
        if (!index) return [] as ContractBase[];
        const seen = new Set<string>();
        const out: ContractBase[] = [];
        for (const row of visible) {
            const code = twCodeOf(row.id);
            const market = index.get(row.id)?.market;
            const exchange = market === 'twse' ? 'TSE' : market === 'tpex' ? 'OTC' : null;
            if (!code || !exchange || seen.has(code) || out.length >= LIVE_LIMIT) continue;
            seen.add(code);
            out.push({ code, exchange, security_type: 'STK', target_code: null });
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index, visible.map((r) => r.id).join(',')]);
    const { snapshots } = useLiveSnapshots(contracts);

    if (!researched) {
        return (
            <div className={s.section}>
                <div className={s.notice} role='note'>
                    <Info size={14} aria-hidden='true' style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                        <span className={s.noticeTitle}>只有官方資料</span>
                        這家公司尚未納入研究，沒有客戶、供應商與合作關係資料。
                    </span>
                </div>
            </div>
        );
    }
    if (groups.length === 0) {
        return <div className={s.center}>研究資料沒有列出具名的上下游或關係企業</div>;
    }
    return (
        <>
            <div className={s.section} style={{ paddingBottom: 0, borderBottom: 'none' }}>
                <div className={s.sectionHead}>
                    <Network size={12} aria-hidden='true' />
                    上下游與關係
                    <span className={s.sectionMeta}>
                        <ThirdPartyChip asOf={c.as_of} />
                    </span>
                </div>
            </div>
            {groups.map((g) => {
                const open = expanded[g.key] ?? false;
                const rows = open ? g.rows : g.rows.slice(0, GROUP_PREVIEW);
                return (
                    <div key={g.key} className={s.section} style={{ padding: `4px ${'1rem'} 8px` }}>
                        <div className={s.members}>
                            <div className={s.membersHead}>
                                {g.label}
                                <span className={s.groupCount}>{g.rows.length}</span>
                            </div>
                            {rows.map((row) => (
                                <RelationLine
                                    key={`${g.key}:${row.edge}:${row.id}`}
                                    row={row}
                                    snapshot={snapshots.get(twCodeOf(row.id) ?? '')}
                                    onPick={onPick}
                                />
                            ))}
                            {g.rows.length > GROUP_PREVIEW && (
                                <button
                                    type='button'
                                    className={s.more}
                                    onClick={() => setExpanded((e) => ({ ...e, [g.key]: !open }))}
                                >
                                    {open ? '收合' : `顯示全部 ${g.rows.length} 筆`}
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
        </>
    );
}

function RelationLine({
    row,
    snapshot,
    onPick,
}: {
    row: RelationRow;
    snapshot?: Snapshot;
    onPick?: (code: string) => void;
}) {
    const code = twCodeOf(row.id);
    const clickable = Boolean(code && onPick);
    const detail = [row.amount, row.detail].filter(Boolean).join(' · ');
    return (
        <button
            type='button'
            className={`${s.row} ${clickable ? s.rowLink : ''}`}
            disabled={!clickable}
            onClick={() => code && onPick?.(code)}
            title={clickable ? `切換到 ${code} ${row.name}` : undefined}
        >
            <span className={s.rowName}>
                {!code && <Globe size={11} className={s.foreignIcon} aria-label='非台股' />}
                <span className={s.rowNameText}>{row.name}</span>
                {code && <span className={s.rowCode}>{code}</span>}
            </span>
            <span className={s.rowDetail} title={detail || undefined}>
                {detail || '—'}
            </span>
            <span className={s.rowEnd}>
                {row.evidence_level === 'media' && (
                    <span className={`${s.chip} ${s.chipTone.neutral}`} title='來源為具名媒體報導'>
                        媒體
                    </span>
                )}
                {snapshot ? (
                    <span className={dirClass(snapshot.change_rate)}>{fmtPct(snapshot.change_rate)}</span>
                ) : (
                    <span className={s.muted}>{row.as_of ?? ''}</span>
                )}
            </span>
        </button>
    );
}

// ── sources ───────────────────────────────────────────────────────────────

function SourcesTab({ view, researched }: { view: CompanyDataView; researched: boolean }) {
    const [all, setAll] = useState(false);
    const c = view.company;
    const evidence = Object.entries(c.evidence ?? {}).sort(([, a], [, b]) =>
        String(b.published_date ?? '').localeCompare(String(a.published_date ?? '')),
    );
    const shown = all ? evidence : evidence.slice(0, 12);
    return (
        <>
            <div className={s.section}>
                <div className={s.sectionHead}>
                    <Database size={12} aria-hidden='true' />
                    資料時點
                </div>
                <dl className={s.facts}>
                    <dt>研究資料</dt>
                    <dd>{researched ? `${c.as_of}（第三方，AI 整理並交叉核對）` : '尚未研究，只有官方資料'}</dd>
                    <dt>官方資料</dt>
                    <dd>{view.meta.officialFetchedAt ?? '—'}</dd>
                    {view.financialsMeta?.asOf && (
                        <>
                            <dt>月營收至</dt>
                            <dd>{view.financialsMeta.asOf}</dd>
                        </>
                    )}
                    <dt>資料版本</dt>
                    <dd className={panel.mono}>{view.meta.releaseId}</dd>
                    {staleParts(view).length > 0 && (
                        <>
                            <dt>離線快取</dt>
                            <dd>{staleParts(view).join('、')}（{STALE_TEXT.split('・')[1]}）</dd>
                        </>
                    )}
                </dl>
            </div>
            {evidence.length > 0 && (
                <div className={s.section}>
                    <div className={s.sectionHead}>
                        <FileText size={12} aria-hidden='true' />
                        研究出處
                        <span className={s.sectionMeta}>
                            <span className={s.muted}>{evidence.length} 筆</span>
                        </span>
                    </div>
                    <ul className={s.sourceList}>
                        {shown.map(([id, e]) => (
                            <li key={id} className={s.sourceItem}>
                                {e.url ? (
                                    <ExternalLink href={e.url} className={s.sourceLink}>
                                        {e.title ?? e.url}
                                    </ExternalLink>
                                ) : (
                                    <span>{e.title ?? id}</span>
                                )}
                                <span className={s.sourceMeta}>
                                    {[e.publisher, e.published_date, e.locator].filter(Boolean).join(' · ')}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {evidence.length > 12 && (
                        <button type='button' className={s.more} style={{ borderTop: 'none', padding: 0 }} onClick={() => setAll((v) => !v)}>
                            {all ? '收合' : `顯示全部 ${evidence.length} 筆`}
                        </button>
                    )}
                </div>
            )}
            {view.sources && view.sources.sources.length > 0 && (
                <div className={s.section}>
                    <div className={s.sectionHead}>
                        <ExternalLinkIcon size={12} aria-hidden='true' />
                        官方資料來源
                        <span className={s.sectionMeta}>
                            <StaleTag meta={view.sourcesMeta} />
                        </span>
                    </div>
                    <ul className={s.sourceList}>
                        {view.sources.sources.map((src) => (
                            <li key={src.id} className={s.sourceItem}>
                                {src.url ? (
                                    <ExternalLink href={src.url} className={s.sourceLink}>
                                        {src.attribution}
                                    </ExternalLink>
                                ) : (
                                    <span>{src.attribution}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {view.meta.disclaimer && (
                <div className={s.section}>
                    <p className={s.reason}>{view.meta.disclaimer}</p>
                </div>
            )}
        </>
    );
}

// ── footer ────────────────────────────────────────────────────────────────

function Footer({
    view,
    researched,
    stale,
    refreshing,
    onRefresh,
}: {
    view: CompanyDataView;
    researched: boolean;
    stale: boolean;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className={s.foot}>
            <span className={s.footText}>
                {researched ? <ThirdPartyChip asOf={view.company.as_of} /> : <OfficialChip />}
                <span>官方 {view.meta.officialFetchedAt ?? '—'}</span>
                <span className={panel.mono}>shioaji-data {view.meta.releaseId}</span>
            </span>
            {stale && (
                <span
                    className={s.stale}
                    title={`無法連線資料來源，顯示先前下載並驗證過的本機快取，未確認為最新版本${
                        staleParts(view).length ? `：${staleParts(view).join('、')}` : ''
                    }`}
                >
                    <WifiOff size={11} aria-hidden='true' />
                    {STALE_TEXT}
                </span>
            )}
            <RefreshButton label='重新檢查公司資料' loading={refreshing} onClick={onRefresh} />
        </div>
    );
}
