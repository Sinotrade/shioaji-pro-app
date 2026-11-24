// src/components/apply-guide.tsx — 首次設定的預設畫面：一步一步帶使用者在
// 永豐官網申請 API Key、下載 .env，由原生殼直接載入金鑰後啟動模擬環境。
// 官網開在原生申請視窗（見 apply-guide-native.ts）；文案與網頁標示目標
// 集中在 apply-guide-config.ts。

import {
    AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList, Crosshair,
    ExternalLink, FlaskConical, KeyRound, Loader2, Play, RotateCw, ShieldAlert, ShieldCheck, SquarePen,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    GUIDE_COPY, GUIDE_ORDER, PRODUCTION_NEXT_STEPS, nextGuideStep, previousGuideStep,
    type ApplyPageStep, type GuidePoint, type GuideStep,
} from '../lib/apply-guide-config';
import {
    focusApplyTarget, listenApplyGuide, openApplyWindow, showApplyApiPage, type ApplyGuideEvent, type DownloadStatus,
} from '../lib/apply-guide-native';
import { openExternalUrl, type DesktopSettings } from '../lib/tauri';
import * as g from './apply-guide.css';
import * as s from './server-settings-dialog.css';

export type ApplyWindowState = 'idle' | 'open' | 'browser' | 'closed';
export interface ApplyImported { profileId: string; name: string }

export interface ApplyGuideController {
    step: GuideStep;
    setStep: (step: GuideStep) => void;
    windowState: ApplyWindowState;
    synced: ApplyPageStep | null;
    imported: ApplyImported | null;
    failure: { message: string } | null;
    downloaded: { fileName: string; status: DownloadStatus } | null;
    opening: boolean;
    openError: string;
    open: () => Promise<void>;
}

/** 導覽狀態放在 OnboardingSetup：切到手動設定時事件仍會收到。 */
export function useApplyGuide(onImported?: (imported: ApplyImported) => void): ApplyGuideController {
    const [step, setStep] = useState<GuideStep>('start');
    const [windowState, setWindowState] = useState<ApplyWindowState>('idle');
    const [synced, setSynced] = useState<ApplyPageStep | null>(null);
    const [imported, setImported] = useState<ApplyImported | null>(null);
    const [failure, setFailure] = useState<ApplyGuideController['failure']>(null);
    const [downloaded, setDownloaded] = useState<ApplyGuideController['downloaded']>(null);
    const [opening, setOpening] = useState(false);
    const [openError, setOpenError] = useState('');
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
        setOpening(true); setOpenError('');
        try {
            const result = await openApplyWindow();
            setWindowState(result === 'window' ? 'open' : 'browser');
            setStep(current => current === 'start' ? 'login' : current);
        } catch (error) {
            setOpenError(error instanceof Error ? error.message : String(error));
        } finally { setOpening(false); }
    };
    return { step, setStep, windowState, synced, imported, failure, downloaded, opening, openError, open };
}

const SITE_STEPS: GuideStep[] = GUIDE_ORDER.filter(step => step !== 'start');
const TOTAL_SITE_STEPS = SITE_STEPS.length - 1; // 「完成」不算一步

function PointList({ points, canLocate }: { points: GuidePoint[]; canLocate: boolean }) {
    return <ul className={g.points}>
        {points.map(point => <li key={point.title} className={g.point}>
            <div className={g.pointText}>
                <p className={g.pointTitle}>
                    {point.title}
                    {point.tone === 'recommend' && <span className={g.tag.recommend}>建議</span>}
                    {point.tone === 'caution' && <span className={g.tag.caution}>注意</span>}
                </p>
                <p className={g.pointBody}>{point.body}</p>
            </div>
            {point.target && <button
                className={g.locate} disabled={!canLocate}
                title={canLocate ? '在申請視窗中標示這個位置' : '開啟申請視窗後可以標示'}
                aria-label={`在網頁上標示「${point.title}」`}
                onClick={() => void focusApplyTarget(point.target!)}
            ><Crosshair size={13} />標示</button>}
        </li>)}
    </ul>;
}

function Callout({ tone, icon, title, children, actions }: { tone: 'danger' | 'warn'; icon: ReactNode; title?: string; children: ReactNode; actions?: ReactNode }) {
    return <div className={tone === 'danger' ? s.calloutDanger : s.calloutWarn} role={tone === 'danger' ? 'alert' : 'status'}>
        <span className={s.calloutIcon}>{icon}</span>
        <div className={s.calloutBody}>
            {title && <p className={s.calloutTitle}>{title}</p>}
            <p className={s.calloutText}>{children}</p>
            {actions && <div className={s.calloutActions}>{actions}</div>}
        </div>
    </div>;
}

function Progress({ step, imported, onSelect }: { step: GuideStep; imported: boolean; onSelect: (step: GuideStep) => void }) {
    const index = SITE_STEPS.indexOf(step);
    return <ol className={g.progress} aria-label="申請進度">
        {SITE_STEPS.map((item, i) => {
            const state = i < index ? 'done' : i === index ? 'current' : 'todo';
            return <li key={item}>
                <button className={g.progressItem[state]} aria-current={state === 'current' ? 'step' : undefined}
                    disabled={item === 'imported' && !imported} onClick={() => onSelect(item)}>
                    <span className={g.progressBar[state]} />
                    <span className={g.progressLabel}>{GUIDE_COPY[item].label}</span>
                </button>
            </li>;
        })}
    </ol>;
}

export function ApplyGuide({ guide, settings, busy, agentAvailable, onToggleAgent, onManual, onStart }: {
    guide: ApplyGuideController;
    settings: DesktopSettings;
    busy: boolean;
    agentAvailable: boolean;
    onToggleAgent: () => void;
    onManual: () => void;
    onStart: (profileId: string) => Promise<void>;
}) {
    const { step, windowState } = guide;
    const copy = GUIDE_COPY[step];
    const windowOpen = windowState === 'open';
    const siteIndex = SITE_STEPS.indexOf(step);
    const altLinks = <div className={g.quietLinks}>
        <button className={s.linkButton} onClick={onManual}><SquarePen size={14} />{step === 'start' ? '我已經有 API Key' : '改用手動輸入或匯入 .env'}</button>
        {agentAvailable && <button className={s.linkButton} onClick={onToggleAgent}><Bot size={14} />問 AI 助理</button>}
    </div>;

    const header = <div className={g.header}>
        <KeyRound size={16} />
        <span className={g.brand}>Shioaji Pro</span>
        <span className={g.brandSub}>申請 API Key</span>
        <span className={g.headerSpacer} />
        {windowOpen && guide.synced && <span className={g.sync} title="官網畫面切換時會自動跳到對應步驟"><span className={g.syncDot} />已同步官網畫面</span>}
    </div>;

    if (step === 'start') {
        return <section className={g.card} aria-label="申請 API Key 導覽">
            {header}
            <div className={g.body}>
                <div className={g.hero}>
                    <span className={g.heroIcon}><KeyRound size={22} /></span>
                    <h2 className={g.title}>{copy.title}</h2>
                    <p className={g.lead}>{copy.lead}</p>
                </div>
                <ul className={g.points}>
                    {copy.points.map((point, i) => <li key={point.title} className={g.pointWithIcon}>
                        <span className={g.pointIcon}>{[<ClipboardList size={16} />, <FlaskConical size={16} />, <ShieldCheck size={16} />][i]}</span>
                        <div className={g.pointText}><p className={g.pointTitle}>{point.title}</p><p className={g.pointBody}>{point.body}</p></div>
                    </li>)}
                </ul>
                {guide.openError && <Callout tone="danger" icon={<AlertTriangle size={16} />} title="無法開啟申請視窗">{guide.openError}</Callout>}
                <div className={g.actions}>
                    <button className={g.primaryLarge} disabled={guide.opening} onClick={() => void guide.open()}>
                        {guide.opening ? <Loader2 size={16} className={s.spinner} /> : <ArrowRight size={16} />}開始申請
                    </button>
                </div>
                {altLinks}
            </div>
        </section>;
    }

    const failure = guide.failure;
    const failureCallout = failure && <Callout tone="danger" icon={<AlertTriangle size={16} />} title="無法載入下載的 .env"
                actions={<button className={s.smallButton} onClick={onManual}><SquarePen size={14} />改用手動設定</button>}>
                {failure.message}。請先不要關閉官網的「新增成功」視窗，可以再按一次「下載 .env」重試，或按「複製」把 API Key 與 Secret Key 貼到手動設定。
            </Callout>;

    if (step === 'imported' && guide.imported) {
        const profile = settings.profiles.find(p => p.id === guide.imported!.profileId);
        // 匯入後使用者可能在帳號設定改成正式環境：導覽只啟動模擬環境
        const production = profile?.environment === 'production';
        const plaintext = (profile?.credentialBackend ?? settings.credentialBackend) === 'plaintext-fallback';
        return <section className={g.card} aria-label="申請 API Key 導覽">
            {header}
            <Progress step={step} imported={!!guide.imported} onSelect={guide.setStep} />
            <div className={g.body}>
                <h2 className={g.title}>{copy.title}</h2>
                {failure && <p className={g.lead}>之後下載的 .env 沒有載入成功，目前載入的仍是下面這把金鑰。</p>}
                {failureCallout}
                <div className={g.doneBox}>
                    <span className={g.doneIcon}><CheckCircle2 size={26} /></span>
                    <div>
                        <p className={g.doneName}>{profile?.name ?? guide.imported.name}{!production && <span className={g.simBadge}>模擬</span>}</p>
                        {profile?.apiKeyMasked && <p className={g.doneMeta}>API Key {profile.apiKeyMasked}</p>}
                    </div>
                </div>
                <p className={g.lead}>{plaintext ? '' : '金鑰已存進這台電腦的系統憑證庫。'}{production ? '' : copy.lead}</p>
                {plaintext && <Callout tone="warn" icon={<ShieldAlert size={16} />} title="金鑰以檔案保存">
                    這台電腦沒有可用的系統憑證庫，金鑰與憑證密碼存在 {settings.fallbackPath}（只有你的帳號能讀寫，0600）。同一使用者執行的程式（含 Agent）仍可能讀到這個檔案。
                </Callout>}
                {production && <Callout tone="warn" icon={<AlertTriangle size={16} />} title="這個帳號已改成正式環境"
                    actions={<button className={s.smallButton} onClick={onManual}><SquarePen size={14} />到帳號設定</button>}>
                    導覽只會啟動模擬環境。請到帳號設定確認環境與 CA 憑證後再啟動。
                </Callout>}
                <div className={g.actions}>
                    <button className={g.primaryLarge} disabled={busy || production} onClick={() => void onStart(guide.imported!.profileId)}>
                        {busy ? <Loader2 size={16} className={s.spinner} /> : <Play size={16} />}啟動模擬環境
                    </button>
                </div>
                <p className={g.sectionTitle}><ShieldCheck size={15} />之後要正式交易，還需要</p>
                <ol className={g.points}>
                    {PRODUCTION_NEXT_STEPS.map((item, i) => <li key={item.title} className={g.pointNumbered}>
                        <span className={g.numbered}>{i + 1}</span>
                        <div className={g.pointText}>
                            <p className={g.pointTitle}>{item.title}</p>
                            <p className={g.pointBody}>{item.body}</p>
                            {item.links.length > 0 && <div className={g.linkRow}>
                                {item.links.map(link => <button key={link.label} className={s.linkButton} onClick={() => void openExternalUrl(link.url)}>
                                    {link.label}<ExternalLink size={12} />
                                </button>)}
                            </div>}
                        </div>
                    </li>)}
                </ol>
                <p className={s.hint}>帳號名稱、環境與 CA 憑證之後都可以在「伺服器設定 › 帳號」修改。</p>
            </div>
        </section>;
    }

    return <section className={g.card} aria-label="申請 API Key 導覽">
        {header}
        <Progress step={step} imported={!!guide.imported} onSelect={guide.setStep} />
        <div className={g.body}>
            <p className={g.stepEyebrow}>步驟 {siteIndex + 1}／{TOTAL_SITE_STEPS}</p>
            <h2 className={g.title}>{copy.title}</h2>
            <p className={g.lead}>{copy.lead}</p>
            {windowState === 'closed' && <Callout tone="warn" icon={<AlertTriangle size={16} />} title="申請視窗已關閉"
                actions={<button className={s.smallButton} onClick={() => void guide.open()}><RotateCw size={14} />重新開啟</button>}>
                重新開啟後需要再登入一次。{step === 'success' ? '如果已經看到「新增成功」但還沒下載 .env，Secret Key 無法再查看，請新增一把新的金鑰。' : ''}
            </Callout>}
            {guide.openError && <Callout tone="danger" icon={<AlertTriangle size={16} />} title="無法開啟申請視窗">{guide.openError}</Callout>}
            {windowState === 'browser' && <Callout tone="warn" icon={<ExternalLink size={16} />} title="已在瀏覽器開啟官網"
                actions={<button className={s.smallButton} onClick={onManual}><SquarePen size={14} />從 .env 匯入</button>}>
                這個版本無法在 App 內開啟申請視窗。照下面的步驟在瀏覽器申請，下載 .env 後回到這裡匯入。
            </Callout>}
            {failureCallout}
            <PointList points={copy.points} canLocate={windowOpen} />
            {step === 'login' && windowOpen && <div className={g.actions}>
                <button className={s.button} onClick={() => void showApplyApiPage()}><ArrowRight size={14} />回到 API 管理頁</button>
            </div>}
            {guide.downloaded && step === 'success' && <p className={s.hint}>{{
                saved: `另外下載的「${guide.downloaded.fileName}」已存到下載資料夾。`,
                unknown: `「${guide.downloaded.fileName}」已交給系統下載，請到下載資料夾確認。`,
                failed: `「${guide.downloaded.fileName}」下載失敗，請在官網再下載一次。`,
            }[guide.downloaded.status]}</p>}
            {copy.note && <p className={s.hint}>{copy.note}</p>}
            {altLinks}
        </div>
        <div className={g.footer}>
            <button className={s.smallButton} disabled={step === 'login'} onClick={() => guide.setStep(previousGuideStep(step))}><ChevronLeft size={14} />上一步</button>
            <span className={g.footerHint}>{windowOpen ? '官網畫面切換時，這裡會自動跳到對應步驟。' : ''}</span>
            <button className={s.smallButton} disabled={step === 'success' && !guide.imported} onClick={() => guide.setStep(nextGuideStep(step))}>下一步<ChevronRight size={14} /></button>
        </div>
    </section>;
}
