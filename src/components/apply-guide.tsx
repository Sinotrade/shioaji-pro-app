// src/components/apply-guide.tsx — 首次設定的預設畫面：一步一步帶使用者在
// 永豐官網申請 API Key、下載 .env，由原生殼直接載入金鑰後啟動模擬環境。
// 官網開在原生申請視窗（見 apply-guide-native.ts）；文案與網頁標示目標
// 集中在 apply-guide-config.ts。

import {
    ALargeSmall, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheckBig, Clock, Crosshair,
    ExternalLink, Flag, FlaskConical, KeyRound, Loader2, LogOut, Moon, OctagonAlert, Play, RotateCw, ShieldCheck,
    SquarePen, Sun, ThumbsUp, TriangleAlert, UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
    GUIDE_COPY, GUIDE_ORDER, PRODUCTION_NEXT_STEPS, nextGuideStep, previousGuideStep,
    type ApplyPageStep, type GuidePoint, type GuideStep,
} from '../lib/apply-guide-config';
import {
    clearApplySiteData, focusApplyTarget, listenApplyGuide, openApplyWindow, showApplyApiPage, type ApplyGuideEvent, type ApplyWindowPlacement, type DownloadStatus,
} from '../lib/apply-guide-native';
import { openExternalUrl, type DesktopSettings } from '../lib/tauri';
import { baseMode, setThemeSettings, useThemeSettings } from '../lib/theme-store';
import * as g from './apply-guide.css';

export type ApplyWindowState = 'idle' | 'open' | 'browser' | 'closed';
export interface ApplyImported { profileId: string; name: string }

export interface ApplyGuideController {
    step: GuideStep;
    setStep: (step: GuideStep) => void;
    windowState: ApplyWindowState;
    /** 申請視窗的位置；只有 overlay（蓋住主視窗）時導覽才靠左。 */
    placement: ApplyWindowPlacement;
    synced: ApplyPageStep | null;
    imported: ApplyImported | null;
    failure: { message: string } | null;
    downloaded: { fileName: string; status: DownloadStatus } | null;
    opening: boolean;
    openError: string;
    open: () => Promise<void>;
    /** 登出並清除官網資料：idle／進行中／完成／失敗訊息。 */
    siteClear: SiteClearState;
    clearSiteData: () => Promise<void>;
}

export type SiteClearState = { kind: 'idle' } | { kind: 'clearing' } | { kind: 'done' } | { kind: 'failed'; message: string };

/** 導覽狀態放在 OnboardingSetup：切到手動設定時事件仍會收到。 */
export function useApplyGuide(onImported?: (imported: ApplyImported) => void): ApplyGuideController {
    const [step, setStep] = useState<GuideStep>('start');
    const [windowState, setWindowState] = useState<ApplyWindowState>('idle');
    const [placement, setPlacement] = useState<ApplyWindowPlacement>('overlay');
    const [synced, setSynced] = useState<ApplyPageStep | null>(null);
    const [imported, setImported] = useState<ApplyImported | null>(null);
    const [failure, setFailure] = useState<ApplyGuideController['failure']>(null);
    const [downloaded, setDownloaded] = useState<ApplyGuideController['downloaded']>(null);
    const [opening, setOpening] = useState(false);
    const [openError, setOpenError] = useState('');
    const [siteClear, setSiteClear] = useState<SiteClearState>({ kind: 'idle' });
    const importedRef = useRef(onImported);
    importedRef.current = onImported;
    useEffect(() => {
        let active = true;
        let off: (() => void) | undefined;
        const handle = (event: ApplyGuideEvent) => {
            switch (event.kind) {
                case 'step':
                    setSynced(event.step);
                    setWindowState('open');
                    // 載入後關掉「新增成功」會回到列表：留在完成頁；
                    // 開始申請另一把（身份驗證以後）才跟著官網走，完成頁仍可從進度列回去
                    setStep(current => current === 'imported' && (event.step === 'list' || event.step === 'login') ? current : event.step);
                    break;
                case 'imported': {
                    const value = { profileId: event.profileId, name: event.name };
                    setImported(value); setFailure(null); setStep('imported');
                    importedRef.current?.(value);
                    break;
                }
                case 'import-failed':
                    setFailure({ message: event.message });
                    break;
                case 'downloaded':
                    setDownloaded({ fileName: event.fileName, status: event.status });
                    break;
                case 'closed':
                    setWindowState('closed'); setSynced(null);
                    break;
            }
        };
        void listenApplyGuide(handle).then(unlisten => { if (active) off = unlisten; else unlisten(); });
        return () => { active = false; off?.(); };
    }, []);
    const open = async () => {
        setOpening(true); setOpenError(''); setSiteClear({ kind: 'idle' });
        try {
            const result = await openApplyWindow();
            if (result === 'browser') setWindowState('browser');
            else { setPlacement(result); setWindowState('open'); }
            setStep(current => current === 'start' ? 'login' : current);
        } catch (error) {
            setOpenError(error instanceof Error ? error.message : String(error));
        } finally { setOpening(false); }
    };
    const clearSiteData = async () => {
        setSiteClear({ kind: 'clearing' });
        try {
            await clearApplySiteData();
            // 原生端已關掉申請視窗；closed 事件也會到，這裡先把狀態對齊
            setWindowState(current => current === 'open' ? 'closed' : current);
            setSynced(null);
            setSiteClear({ kind: 'done' });
        } catch (error) {
            setSiteClear({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
    };
    return { step, setStep, windowState, placement, synced, imported, failure, downloaded, opening, openError, open, siteClear, clearSiteData };
}

/** 「登出並清除官網資料」：先確認再清；用瀏覽器開官網時不顯示（那邊的登入由瀏覽器管）。 */
function SiteLogout({ guide }: { guide: ApplyGuideController }) {
    const [confirming, setConfirming] = useState(false);
    const state = guide.siteClear;
    if (guide.windowState === 'browser') return null;
    if (state.kind === 'done') {
        return <Callout tone="success" title="已登出官網">申請視窗保存的永豐登入與憑證資料已清除。下次打開官網要重新登入。</Callout>;
    }
    if (confirming || state.kind === 'clearing') {
        const clearing = state.kind === 'clearing';
        return <Callout tone="warn" title="要登出並清除官網資料嗎？"
            actions={<>
                <button className={g.secondaryButton} disabled={clearing} onClick={() => void guide.clearSiteData().then(() => setConfirming(false))}>
                    {clearing ? <Loader2 size={18} className={g.spinner} aria-hidden /> : <LogOut size={18} aria-hidden />}
                    {clearing ? '正在清除…' : '確認登出並清除'}
                </button>
                <button className={g.textButton} disabled={clearing} onClick={() => setConfirming(false)}>取消</button>
            </>}>
            會關掉官網視窗，並清除這台電腦上申請視窗保存的永豐登入、憑證與暫存資料。App 裡已載入的 API Key 不受影響。
        </Callout>;
    }
    return <>
        {state.kind === 'failed' && <Callout tone="danger" title="沒有清除完成">{state.message}</Callout>}
        <div className={g.quietLinks}>
            <button className={g.textButton} onClick={() => setConfirming(true)}><LogOut size={18} aria-hidden />登出並清除官網資料</button>
        </div>
    </>;
}

const SITE_STEPS: GuideStep[] = GUIDE_ORDER.filter(step => step !== 'start');
const TOTAL_SITE_STEPS = SITE_STEPS.length - 1; // 「完成」不算一步

/** 文案裡用「」包起來的介面名稱畫成框，讓使用者一眼看出要按哪個。 */
export function Rich({ text }: { text: string }) {
    const parts = text.split(/「([^」]+)」/);
    return <>{parts.map((part, i) => i % 2 === 1
        ? <span key={i} className={g.uiChip}><span className={g.srOnly}>「</span>{part}<span className={g.srOnly}>」</span></span>
        : part)}</>;
}

/** 顯示設定：大字、深淺色。寫進 App 的主題設定，之後進到 App 也一樣。 */
function DisplayControls() {
    const theme = useThemeSettings();
    const large = theme.fontScale === 1.3;
    const light = baseMode(theme) === 'light';
    return <div className={g.displayControls} role="group" aria-label="顯示設定">
        <button className={g.toggle} aria-pressed={large} onClick={() => setThemeSettings({ fontScale: large ? 1.15 : 1.3 })}>
            <ALargeSmall size={18} aria-hidden />大字
        </button>
        <button className={g.toggle} onClick={() => setThemeSettings({ mode: light ? 'dark' : 'light' })}
            aria-label={light ? '改用深色畫面' : '改用淺色畫面'}>
            {light ? <Moon size={17} aria-hidden /> : <Sun size={17} aria-hidden />}{light ? '深色' : '淺色'}
        </button>
    </div>;
}

function PointList({ points, canLocate, numbered = true }: { points: GuidePoint[]; canLocate: boolean; numbered?: boolean }) {
    const rows: ReactNode[] = [];
    points.forEach((point, i) => {
        if (point.group) rows.push(<li key={`g-${point.group}`} className={g.groupTitle} aria-hidden>{point.group}</li>);
        rows.push(<li key={point.title} className={point.tone === 'caution' ? g.itemCaution : g.item}>
            <span className={g.itemNumber} aria-hidden>{numbered ? i + 1 : <Check size={16} />}</span>
            <div className={g.itemText}>
                <p className={g.itemTitle}>
                    <span><Rich text={point.title} /></span>
                    {point.tone === 'recommend' && <span className={g.tag.recommend}><ThumbsUp size={13} aria-hidden />建議</span>}
                    {point.tone === 'caution' && <span className={g.tag.caution}><TriangleAlert size={13} aria-hidden />注意</span>}
                </p>
                <p className={g.itemBody}><Rich text={point.body} /></p>
                {point.target && <button
                    className={g.locate} disabled={!canLocate}
                    title={canLocate ? '在申請視窗中把這個位置框起來' : '開啟申請視窗後可以標示'}
                    aria-label={`在網頁上標示：${point.title}`}
                    onClick={() => void focusApplyTarget(point.target!)}
                ><Crosshair size={17} aria-hidden />{canLocate ? '在網頁上標示' : '開啟官網後可標示'}</button>}
            </div>
        </li>);
    });
    return <ol className={g.list}>{rows}</ol>;
}

const CALLOUT_PREFIX = { danger: '錯誤', warn: '注意', success: '完成' } as const;
const CALLOUT_ICON = { danger: OctagonAlert, warn: TriangleAlert, success: CircleCheckBig } as const;
function Callout({ tone, title, children, actions }: { tone: 'danger' | 'warn' | 'success'; title: string; children: ReactNode; actions?: ReactNode }) {
    const Icon = CALLOUT_ICON[tone];
    return <div className={g.callout[tone]} role={tone === 'danger' ? 'alert' : 'status'}>
        <span className={g.calloutIcon[tone]}><Icon size={22} aria-hidden /></span>
        <div className={g.calloutBody}>
            <p className={g.calloutTitle}>{CALLOUT_PREFIX[tone]}：{title}</p>
            <p className={g.calloutText}>{children}</p>
            {actions && <div className={g.calloutActions}>{actions}</div>}
        </div>
    </div>;
}

function Progress({ step, imported, onSelect }: { step: GuideStep; imported: boolean; onSelect: (step: GuideStep) => void }) {
    const index = SITE_STEPS.indexOf(step);
    const isDone = step === 'imported';
    return <nav className={g.progressWrap} aria-label="申請進度">
        <p className={g.progressCount} aria-live="polite">
            {isDone ? '全部完成' : `第 ${index + 1} 步，共 ${TOTAL_SITE_STEPS} 步`}
            <span className={g.progressCountMuted}>{isDone ? '' : `：${GUIDE_COPY[step].label}`}</span>
        </p>
        <ol className={g.progress}>
            {SITE_STEPS.map((item, i) => {
                const state = i < index || (isDone && i === index) ? 'done' : i === index ? 'current' : 'todo';
                const last = item === 'imported';
                const stateText = state === 'done' ? '已完成' : state === 'current' ? '目前在這一步' : '還沒開始';
                return <li key={item} className={g.progressItem}>
                    {i > 0 && <span className={g.stepLine[i <= index ? 'done' : 'todo']} aria-hidden />}
                    <button className={g.step[state]} aria-current={state === 'current' ? 'step' : undefined}
                        aria-label={`${GUIDE_COPY[item].label}，${stateText}`}
                        disabled={last && !imported} onClick={() => onSelect(item)}>
                        <span className={g.dot[state]} aria-hidden>
                            {state === 'done' ? <Check size={18} strokeWidth={3} /> : last ? <Flag size={16} /> : i + 1}
                        </span>
                        <span className={g.stepLabel}>{GUIDE_COPY[item].label}</span>
                    </button>
                </li>;
            })}
        </ol>
    </nav>;
}

export function ApplyGuide({ guide, settings, busy, docked = false, contentRef, onManual, onStart }: {
    guide: ApplyGuideController;
    settings: DesktopSettings;
    busy: boolean;
    /** 申請視窗蓋住主視窗右側：卡片縮成 428px 貼左，AI 浮鈕停在卡片右下。 */
    docked?: boolean;
    /** AI 浮鈕對齊用：卡片內容區。 */
    contentRef?: Ref<HTMLDivElement>;
    onManual: () => void;
    onStart: (profileId: string) => Promise<void>;
}) {
    const { step, windowState } = guide;
    const copy = GUIDE_COPY[step];
    const windowOpen = windowState === 'open';
    const cardClass = docked ? g.cardDocked : g.card;
    const bodyClass = docked ? g.bodyWithFab : g.body;
    const manualLink = <div className={g.quietLinks}>
        <button className={g.textButton} onClick={onManual}><SquarePen size={18} aria-hidden />{step === 'start' ? '我已經有 API Key' : '改用手動輸入或匯入 .env 檔'}</button>
    </div>;

    const header = <div className={g.header}>
        <div className={g.headerTitle}>
            <span className={g.headerIcon}><KeyRound size={20} aria-hidden /></span>
            <p className={g.brand}>申請 API Key</p>
            {!docked && <span className={g.brandSub}>Shioaji Pro</span>}
        </div>
        <DisplayControls />
    </div>;
    const syncBanner = windowOpen && guide.synced && step !== 'imported' && <div className={g.syncBanner} role="status">
        <span className={g.syncDot} aria-hidden />
        <span><strong>已連動官網</strong>：官網換頁時，這裡會自動跳到對應步驟。</span>
    </div>;

    if (step === 'start') {
        return <section className={cardClass} aria-label="申請 API Key 導覽">
            {header}
            <div className={bodyClass} ref={contentRef}>
                <div className={g.hero}>
                    <h2 className={g.title}>{copy.title}</h2>
                    <div className={g.heroMeta}>
                        <span className={g.metaPill}><Clock size={15} aria-hidden />約 5 分鐘</span>
                        <span className={g.metaPill}><FlaskConical size={15} aria-hidden />先用模擬環境</span>
                    </div>
                    <p className={g.lead}><Rich text={copy.lead} /></p>
                </div>
                <ul className={g.list}>
                    {copy.points.map((point, i) => <li key={point.title} className={g.item}>
                        <span className={g.itemIcon} aria-hidden>{[<UserRound size={18} />, <FlaskConical size={18} />, <ShieldCheck size={18} />][i]}</span>
                        <div className={g.itemText}><p className={g.itemTitle}>{point.title}</p><p className={g.itemBody}>{point.body}</p></div>
                    </li>)}
                </ul>
                {guide.openError && <Callout tone="danger" title="打不開申請視窗"
                    actions={<button className={g.secondaryButton} onClick={() => void guide.open()}><RotateCw size={18} aria-hidden />再試一次</button>}>
                    {guide.openError}
                </Callout>}
                <div className={g.actions}>
                    <button className={g.primary} disabled={guide.opening} onClick={() => void guide.open()}>
                        {guide.opening ? <Loader2 size={20} className={g.spinner} aria-hidden /> : <ArrowRight size={20} aria-hidden />}
                        {guide.opening ? '正在打開官網…' : '開始申請'}
                    </button>
                </div>
                {manualLink}
                <SiteLogout guide={guide} />
            </div>
        </section>;
    }

    const failure = guide.failure;
    const failureCallout = failure && <Callout tone="danger" title="App 沒有收到 .env 檔"
        actions={<button className={g.secondaryButton} onClick={onManual}><SquarePen size={18} aria-hidden />改用手動輸入</button>}>
        {failure.message}。先不要關掉官網的「新增成功」視窗，再按一次「下載 .env」。還是不行的話，按「複製」把 API Key 和 Secret Key 貼到手動輸入。
    </Callout>;

    if (step === 'imported' && guide.imported) {
        const profile = settings.profiles.find(p => p.id === guide.imported!.profileId);
        // 匯入後使用者可能在帳號設定改成正式環境：導覽只啟動模擬環境
        const production = profile?.environment === 'production';
        const plaintext = (profile?.credentialBackend ?? settings.credentialBackend) === 'plaintext-fallback';
        return <section className={cardClass} aria-label="申請 API Key 導覽">
            {header}
            <Progress step={step} imported={!!guide.imported} onSelect={guide.setStep} />
            <div className={bodyClass} ref={contentRef}>
                <div className={g.doneHero}>
                    <span className={g.doneIcon}><Check size={34} strokeWidth={3} aria-hidden /></span>
                    <h2 className={g.title}>完成！{copy.title}</h2>
                    {!production && <p className={g.lead}><Rich text={copy.lead} /></p>}
                </div>
                {failure && <p className={g.secondary}>之後下載的 .env 沒有載入成功，目前使用的仍是下面這把金鑰。</p>}
                {failureCallout}
                <dl className={g.doneBox}>
                    <dt className={g.doneTerm}>帳號名稱</dt>
                    <dd className={g.doneValue}>{profile?.name ?? guide.imported.name}{!production && <span className={g.simBadge}>模擬環境</span>}</dd>
                    {profile?.apiKeyMasked && <><dt className={g.doneTerm}>API Key</dt><dd className={g.doneValue}><span className={g.mono}>{profile.apiKeyMasked}</span></dd></>}
                    {!plaintext && <><dt className={g.doneTerm}>保存位置</dt><dd className={g.doneValue}>這台電腦的系統憑證庫</dd></>}
                </dl>
                {plaintext && <Callout tone="warn" title="金鑰存成檔案">
                    這台電腦沒有可用的系統憑證庫，金鑰與憑證密碼存在 {settings.fallbackPath}（只有你的帳號能讀寫，0600）。同一使用者執行的程式（含 Agent）仍可能讀到這個檔案。
                </Callout>}
                {production && <Callout tone="warn" title="這個帳號已改成正式環境"
                    actions={<button className={g.secondaryButton} onClick={onManual}><SquarePen size={18} aria-hidden />到帳號設定</button>}>
                    導覽只會啟動模擬環境。請到帳號設定確認環境與 CA 憑證後再啟動。
                </Callout>}
                <div className={g.actions}>
                    <button className={g.primary} disabled={busy || production} onClick={() => void onStart(guide.imported!.profileId)}>
                        {busy ? <Loader2 size={20} className={g.spinner} aria-hidden /> : <Play size={20} aria-hidden />}
                        {busy ? '啟動中，約 10–30 秒…' : '啟動模擬環境'}
                    </button>
                </div>
                <details className={g.details}>
                    <summary className={g.summary}><ShieldCheck size={19} aria-hidden />之後要正式交易，還需要 {PRODUCTION_NEXT_STEPS.length} 件事<span className={g.summaryChevron}><ChevronDown size={20} aria-hidden /></span></summary>
                    <div className={g.detailsBody}>
                        <ol className={g.list}>
                            {PRODUCTION_NEXT_STEPS.map((item, i) => <li key={item.title} className={g.item}>
                                <span className={g.itemNumber} aria-hidden>{i + 1}</span>
                                <div className={g.itemText}>
                                    <p className={g.itemTitle}><Rich text={item.title} /></p>
                                    <p className={g.itemBody}><Rich text={item.body} /></p>
                                    {item.links.length > 0 && <div className={g.linkRow}>
                                        {item.links.map(link => <button key={link.label} className={g.textButton} onClick={() => void openExternalUrl(link.url)}>
                                            {link.label}<ExternalLink size={16} aria-label="（在瀏覽器開啟）" />
                                        </button>)}
                                    </div>}
                                </div>
                            </li>)}
                        </ol>
                        <p className={g.secondary}>帳號名稱、環境與 CA 憑證之後都可以在「伺服器設定 › 帳號」修改。</p>
                    </div>
                </details>
                <SiteLogout guide={guide} />
            </div>
        </section>;
    }

    return <section className={cardClass} aria-label="申請 API Key 導覽">
        {header}
        {syncBanner}
        <Progress step={step} imported={!!guide.imported} onSelect={guide.setStep} />
        <div className={bodyClass} ref={contentRef}>
            <h2 className={g.title}>{copy.title}</h2>
            <p className={g.lead}><Rich text={copy.lead} /></p>
            {windowState === 'closed' && <Callout tone="warn" title="官網視窗已關閉"
                actions={<button className={g.secondaryButton} onClick={() => void guide.open()}><RotateCw size={18} aria-hidden />重新打開官網</button>}>
                按「重新打開官網」繼續。{step === 'success' ? '如果已經看到「新增成功」但還沒下載 .env，Secret Key 已經看不到了，請再新增一把金鑰。' : ''}
            </Callout>}
            {guide.openError && <Callout tone="danger" title="打不開申請視窗">{guide.openError}</Callout>}
            {windowState === 'browser' && <Callout tone="warn" title="已改用瀏覽器打開官網"
                actions={<button className={g.secondaryButton} onClick={onManual}><SquarePen size={18} aria-hidden />從 .env 檔匯入</button>}>
                這個版本無法在 App 裡打開申請視窗。請照下面的步驟在瀏覽器申請，下載 .env 檔後回到這裡匯入。
            </Callout>}
            {failureCallout}
            <PointList points={copy.points} canLocate={windowOpen} />
            {step === 'login' && windowOpen && <div className={g.actions}>
                <button className={g.secondaryButton} onClick={() => void showApplyApiPage()}><ArrowRight size={18} aria-hidden />回到 API 管理頁</button>
            </div>}
            {guide.downloaded && step === 'success' && <p className={g.secondary}>{{
                saved: `另外下載的「${guide.downloaded.fileName}」已存到下載資料夾。`,
                unknown: `「${guide.downloaded.fileName}」已交給系統下載，請到下載資料夾確認。`,
                failed: `「${guide.downloaded.fileName}」下載失敗，請在官網再下載一次。`,
            }[guide.downloaded.status]}</p>}
            {copy.note && <p className={g.secondary}>{copy.note}</p>}
            {manualLink}
            <SiteLogout guide={guide} />
        </div>
        <div className={g.footer}>
            <button className={g.secondaryButton} disabled={step === 'login'} onClick={() => guide.setStep(previousGuideStep(step))}><ChevronLeft size={20} aria-hidden />上一步</button>
            <button className={g.secondaryButton} disabled={step === 'success' && !guide.imported} onClick={() => guide.setStep(nextGuideStep(step))}>下一步<ChevronRight size={20} aria-hidden /></button>
        </div>
    </section>;
}
