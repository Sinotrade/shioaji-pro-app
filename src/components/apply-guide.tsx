// src/components/apply-guide.tsx — 首次設定的預設畫面：一步一步帶使用者在
// 永豐官網申請 API Key、下載 .env，由原生殼直接載入金鑰後啟動模擬環境。
// 官網開在原生申請視窗（見 apply-guide-native.ts）；文案與網頁標示目標
// 集中在 apply-guide-config.ts。

import {
    ALargeSmall, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheckBig, CircleHelp, Clock, Crosshair,
    ExternalLink, FileSignature, Flag, FlaskConical, Hourglass, KeyRound, Loader2, LogOut, Moon, OctagonAlert, Play, RotateCw, ShieldCheck,
    SquarePen, Sun, ThumbsUp, TriangleAlert, UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { SIGNING_URLS, type SigningMarket } from '../lib/account-signing';
import {
    GUIDE_COPY, GUIDE_ORDER, PRODUCTION_NEXT_STEPS, SIGN_MARKET_COPY, SIGN_STATE_LABEL, SIGNING_MARKETS,
    guideStepOf, nextGuideStep, previousGuideStep, signMarketOf, signTargetId, sitePageOf, targetPageOf,
    type ApplyPageStep, type GuidePoint, type GuideStep, type SignState,
} from '../lib/apply-guide-config';
import {
    clearApplySiteData, focusApplyTarget, listenApplyGuide, setApplySaveEnv, openApplyWindow, showApplyApiPage, showApplySignPage,
    type ApplyGuideEvent, type ApplyWindowOpenResult, type ApplyWindowPlacement, type DownloadStatus,
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
    /** 「下載 .env」時同時把檔案存到下載資料夾（預設關，選擇會記住）。 */
    saveEnvFile: boolean;
    setSaveEnvFile: (save: boolean) => void;
    /** 使用者打算交易的市場（只有這些要簽約定書；選擇會記住）。 */
    markets: SigningMarket[];
    setMarket: (market: SigningMarket, on: boolean) => void;
    /** 各市場簽署頁讀到的狀態（這次開 App 期間；沒讀到是 unknown）。 */
    signs: Record<SigningMarket, SignState>;
    /** 打開簽署頁失敗的原因（空字串＝沒有錯誤） */
    signError: string;
    /** 在申請視窗打開該市場的簽署頁（視窗沒開就先打開）。 */
    openSignPage: (market: SigningMarket) => Promise<void>;
    /** 在官網上標示目標；官網不在目標所在的頁面時先切過去，載入後再標示。 */
    locate: (target: string) => Promise<void>;
}

const SAVE_ENV_KEY = 'sjpro.applyGuide.saveEnvFile';
function readSaveEnvPref(): boolean {
    try { return localStorage.getItem(SAVE_ENV_KEY) === '1'; } catch { return false; }
}
function writeSaveEnvPref(save: boolean) {
    try { if (save) localStorage.setItem(SAVE_ENV_KEY, '1'); else localStorage.removeItem(SAVE_ENV_KEY); } catch { /* 只是介面偏好 */ }
}

const MARKETS_KEY = 'sjpro.applyGuide.markets';
/** 第一次（沒有記住的選擇）預設三個市場都勾；之後可以改。 */
const DEFAULT_MARKETS: SigningMarket[] = ['S', 'F', 'H'];
function readMarketsPref(): SigningMarket[] {
    try {
        const raw = localStorage.getItem(MARKETS_KEY);
        if (raw === null) return DEFAULT_MARKETS;
        const list = JSON.parse(raw) as unknown;
        return Array.isArray(list) ? SIGNING_MARKETS.filter(m => list.includes(m)) : DEFAULT_MARKETS;
    } catch { return DEFAULT_MARKETS; }
}
function writeMarketsPref(markets: SigningMarket[]) {
    try { localStorage.setItem(MARKETS_KEY, JSON.stringify(markets)); } catch { /* 只是介面偏好 */ }
}
const UNKNOWN_SIGNS: Record<SigningMarket, SignState> = { S: 'unknown', F: 'unknown', H: 'unknown' };

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
    const [saveEnvFile, setSaveEnvState] = useState(readSaveEnvPref);
    const [markets, setMarkets] = useState(readMarketsPref);
    const [signs, setSigns] = useState(UNKNOWN_SIGNS);
    const [signError, setSignError] = useState('');
    const windowRef = useRef<ApplyWindowState>('idle');
    windowRef.current = windowState;
    const saveEnvRef = useRef(saveEnvFile);
    saveEnvRef.current = saveEnvFile;
    const importedRef = useRef(onImported);
    importedRef.current = onImported;
    const syncedRef = useRef<ApplyPageStep | null>(null);
    syncedRef.current = synced;
    /** 切頁後要標示的目標：官網換到它所在的頁面時標示 */
    const pendingFocusRef = useRef<string | null>(null);
    useEffect(() => {
        let active = true;
        let off: (() => void) | undefined;
        const handle = (event: ApplyGuideEvent) => {
            switch (event.kind) {
                case 'step': {
                    setSynced(event.step);
                    syncedRef.current = event.step;
                    const pending = pendingFocusRef.current;
                    if (pending) {
                        // 回到登入頁（沒登入或逾時）就放棄；到了目標所在的頁面才標示
                        if (event.step === 'login') pendingFocusRef.current = null;
                        else if (sitePageOf(event.step) === targetPageOf(pending)) {
                            pendingFocusRef.current = null;
                            void focusApplyTarget(pending);
                        }
                    }
                    setWindowState('open');
                    const market = signMarketOf(event.step);
                    // 官網回到登入頁＝登出或逾時，下一個登入的可能是別人：先前讀到的簽署狀態不能沿用
                    if (event.step === 'login') setSigns(current => current === UNKNOWN_SIGNS ? current : UNKNOWN_SIGNS);
                    // 讀不到（unknown）不蓋掉先前讀到的狀態：頁面載入中也會先回報 unknown
                    if (market && event.sign && event.sign !== 'unknown') {
                        const sign = event.sign;
                        setSigns(current => current[market] === sign ? current : { ...current, [market]: sign });
                    }
                    // 載入後關掉「新增成功」會回到列表、從完成頁打開簽署頁：都留在完成頁；
                    // 開始申請另一把（身份驗證以後）才跟著官網走，完成頁仍可從進度列回去
                    setStep(current => followSiteStep(current, event.step));
                    break;
                }
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
    const openWindow = async (): Promise<ApplyWindowOpenResult | null> => {
        setOpening(true); setOpenError(''); setSiteClear({ kind: 'idle' });
        try {
            const result = await openApplyWindow();
            // 原生端每次啟動都預設不存檔：開窗後把使用者記住的選擇帶過去
            if (result !== 'browser') void setApplySaveEnv(saveEnvRef.current);
            if (result === 'browser') setWindowState('browser');
            else { setPlacement(result); setWindowState('open'); }
            setStep(current => current === 'start' ? 'login' : current);
            return result;
        } catch (error) {
            setOpenError(error instanceof Error ? error.message : String(error));
            return null;
        } finally { setOpening(false); }
    };
    const open = async () => { await openWindow(); };
    const openSignPage = async (market: SigningMarket) => {
        setSignError('');
        let state: ApplyWindowState | ApplyWindowOpenResult | null = windowRef.current;
        if (state !== 'open' && state !== 'browser') state = await openWindow();
        if (!state) return;
        // 用瀏覽器開官網時（舊版原生殼）簽署頁也交給瀏覽器
        if (state === 'browser') void openExternalUrl(SIGNING_URLS[market].url);
        else {
            try { await showApplySignPage(market); } catch (error) {
                setSignError(error instanceof Error ? error.message : String(error));
            }
        }
    };
    const locate = async (target: string) => {
        const page = targetPageOf(target);
        const current = syncedRef.current ? sitePageOf(syncedRef.current) : null;
        if (!page || page === current) {
            pendingFocusRef.current = null;
            await focusApplyTarget(target);
            return;
        }
        pendingFocusRef.current = target;
        const market = signMarketOf(page);
        try {
            if (market) await showApplySignPage(market);
            else await showApplyApiPage();
        } catch {
            pendingFocusRef.current = null;
        }
    };
    const setMarket = (market: SigningMarket, on: boolean) => {
        setMarkets(current => {
            const next = SIGNING_MARKETS.filter(m => m === market ? on : current.includes(m));
            writeMarketsPref(next);
            return next;
        });
    };
    const clearSiteData = async () => {
        setSiteClear({ kind: 'clearing' });
        try {
            await clearApplySiteData();
            // 原生端已關掉申請視窗；closed 事件也會到，這裡先把狀態對齊
            setWindowState(current => current === 'open' ? 'closed' : current);
            setSynced(null);
            // 登出後可能換另一個身分登入：先前讀到的簽署狀態不能沿用
            setSigns(UNKNOWN_SIGNS);
            setSiteClear({ kind: 'done' });
        } catch (error) {
            setSiteClear({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
    };
    const setSaveEnvFile = (save: boolean) => {
        setSaveEnvState(save); writeSaveEnvPref(save);
        void setApplySaveEnv(save);
    };
    return {
        step, setStep, windowState, placement, synced, imported, failure, downloaded, opening, openError, open,
        siteClear, clearSiteData, saveEnvFile, setSaveEnvFile, markets, setMarket, signs, signError, openSignPage, locate,
    };
}

const SIGN_ICON = { unknown: CircleHelp, signed: CircleCheckBig, unsigned: CircleAlert, pending: Hourglass } as const;

/** 「你打算交易哪些市場？」：只有勾選的市場要簽約定書。 */
function MarketChoice({ guide }: { guide: ApplyGuideController }) {
    return <fieldset className={g.marketSet}>
        <legend className={g.marketLegend}>你打算用 API 交易哪些市場？</legend>
        <div className={g.marketOptions}>
            {SIGNING_MARKETS.map(market => {
                const on = guide.markets.includes(market);
                return <label key={market} className={on ? g.marketOptionOn : g.marketOption}>
                    <input type="checkbox" className={g.optionBox} checked={on}
                        onChange={event => guide.setMarket(market, event.currentTarget.checked)} />
                    <span className={g.optionTitle}>{SIGN_MARKET_COPY[market].title}</span>
                </label>;
            })}
        </div>
    </fieldset>;
}

/** 勾選市場的簽署列：狀態（圖示＋文字）與打開簽署頁的按鈕。 */
function SignRows({ guide, compact = false }: { guide: ApplyGuideController; compact?: boolean }) {
    const current = guide.windowState === 'open' ? signMarketOf(guide.synced) : null;
    if (guide.markets.length === 0) {
        return <p className={g.secondary}>還沒選市場。勾選要交易的市場後，這裡會列出要簽的約定書。</p>;
    }
    return <>{guide.signError && <Callout tone="danger" title="打不開簽署頁">{guide.signError}，請再按一次「打開簽署頁」。</Callout>}
    <ul className={g.signList} aria-label="API 約定書簽署狀態">
        {guide.markets.map(market => {
            const state = guide.signs[market];
            const Icon = SIGN_ICON[state];
            const here = current === market;
            return <li key={market} className={g.signRow} aria-current={here ? 'page' : undefined}>
                <div className={g.signHead}>
                    <div className={g.itemText}>
                        <p className={g.itemTitle}>{SIGN_MARKET_COPY[market].title}</p>
                        {!compact && <p className={g.itemBody}>{SIGN_MARKET_COPY[market].body}</p>}
                    </div>
                    <span className={g.signStatus[state]} aria-live="polite" aria-atomic="true">
                        <Icon size={16} aria-hidden /><span className={g.srOnly}>{SIGN_MARKET_COPY[market].title}：</span>{SIGN_STATE_LABEL[state]}
                    </span>
                </div>
                {here
                    ? <p className={g.signHere}>官網目前在這個簽署頁</p>
                    : <button className={g.secondaryButton} disabled={guide.opening}
                        aria-label={`打開${SIGN_MARKET_COPY[market].title}簽署頁`}
                        onClick={() => void guide.openSignPage(market)}>
                        <FileSignature size={18} aria-hidden />打開簽署頁
                    </button>}
            </li>;
        })}
    </ul></>;
}

/** 簽署步驟：選市場、各市場狀態、照順序做的說明。 */
function SignStep({ guide, windowOpen }: { guide: ApplyGuideController; windowOpen: boolean }) {
    const copy = GUIDE_COPY.sign;
    const market = signMarketOf(guide.synced);
    return <>
        <MarketChoice guide={guide} />
        <SignRows guide={guide} />
        <p className={g.secondary}>只要簽打算交易的市場。簽署會用到登入時設定好的電子憑證。約定書是法律文件，請自己閱讀後再簽，App 不會替你勾選或按「簽署」。狀態是從官網簽署頁讀到的，讀不到時顯示「未確認」，以官網為準。</p>
        {windowOpen && market && <>
            <h3 className={g.subTitle}>在簽署頁上照順序做</h3>
            <PointList points={copy.points} canLocate={windowOpen}
                resolveTarget={target => signTargetId(guide.synced, target)} />
        </>}
        {windowOpen && <div className={g.actions}>
            <button className={g.secondaryButton} onClick={() => { void showApplyApiPage(); guide.setStep('list'); }}>
                <ArrowRight size={18} aria-hidden />前往 API 管理頁申請金鑰
            </button>
        </div>}
    </>;
}

/** 「同時把 .env 檔存到『下載』資料夾」：預設關，只匯入 App。 */
function SaveEnvOption({ guide }: { guide: ApplyGuideController }) {
    const on = guide.saveEnvFile;
    return <label className={g.option}>
        <input type="checkbox" className={g.optionBox} checked={on} aria-describedby="apply-save-env-hint"
            onChange={event => guide.setSaveEnvFile(event.currentTarget.checked)} />
        <span className={g.optionText}>
            <span className={g.optionTitle}>同時把 .env 檔存到「下載」資料夾</span>
            <span id="apply-save-env-hint" className={on ? g.optionHintWarn : g.optionHint}>
                {on ? '檔案內含 Secret Key，請妥善保管。' : '按「下載 .env」會直接匯入 App，不會另存檔案。'}
            </span>
        </span>
    </label>;
}

const downloadedText = (d: { fileName: string; status: DownloadStatus }) => ({
    saved: `「${d.fileName}」已存到下載資料夾。`,
    unknown: `「${d.fileName}」已交給系統下載，請到下載資料夾確認。`,
    failed: `「${d.fileName}」下載失敗，請在官網再下載一次。`,
}[d.status]);

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

/** 完成頁的約定書說明：勾選的市場還有沒簽的（或還沒確認）就提醒。 */
function doneSignText(guide: ApplyGuideController) {
    const chosen = guide.markets;
    if (chosen.length === 0) return '要用 API 交易的市場都要簽署約定書。到「簽署」步驟選擇市場。';
    if (chosen.every(m => guide.signs[m] === 'signed')) return '你選的市場都已簽署。正式下單前還要完成模擬環境測試。';
    return '你選的市場還有約定書沒簽或還沒確認。模擬環境現在就能用；正式下單前要簽好並完成測試。';
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

function PointList({ points, canLocate, numbered = true, resolveTarget = target => target, onLocate = focusApplyTarget }: {
    points: GuidePoint[]; canLocate: boolean; numbered?: boolean;
    /** 按「在網頁上標示」：預設直接標示；導覽主畫面會先把官網切到目標所在的頁面 */
    onLocate?: (target: string) => Promise<unknown>;
    /** 設定檔裡的目標名稱 → 申請視窗的目標 id；null 表示目前頁面沒有 */
    resolveTarget?: (target: string) => string | null;
}) {
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
                {point.target && (() => {
                    const id = resolveTarget(point.target);
                    const can = canLocate && id !== null;
                    return <button
                        className={g.locate} disabled={!can}
                        title={can ? '在申請視窗中把這個位置框起來' : '開啟申請視窗後可以標示'}
                        aria-label={`在網頁上標示：${point.title}`}
                        onClick={() => { if (id) void onLocate(id); }}
                    ><Crosshair size={17} aria-hidden />{can ? '在網頁上標示' : '開啟官網後可標示'}</button>;
                })()}
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

/** 勾選的市場全部讀到「已簽署」（沒勾任何市場也算）：進度列的「簽署」才打勾。 */
/**
 * 官網換頁時導覽要停在哪一步。
 * - 完成頁：關掉「新增成功」回到列表、登出、打開簽署頁都留在完成頁；開始申請另一把（身份驗證以後）才跟著官網走。
 * - 登入後官網會直接進 API 管理列表：導覽先停在「簽署」，使用者按「前往 API 管理頁申請金鑰」或「下一步」才往下；
 *   已在簽署步驟時官網停在列表也不往前跳。
 */
export function followSiteStep(current: GuideStep, site: ApplyPageStep): GuideStep {
    const next = guideStepOf(site);
    if (current === 'imported' && (site === 'list' || site === 'login' || signMarketOf(site))) return current;
    if (next === 'list' && (current === 'start' || current === 'login' || current === 'sign')) return 'sign';
    return next;
}

export function allChosenSigned(guide: Pick<ApplyGuideController, 'markets' | 'signs'>) {
    return guide.markets.every(market => guide.signs[market] === 'signed');
}

function Progress({ step, imported, signDone, onSelect }: {
    step: GuideStep; imported: boolean;
    /** 「簽署」只在勾選的市場都已簽署時打勾；只是顯示，不擋任何步驟 */
    signDone: boolean;
    onSelect: (step: GuideStep) => void;
}) {
    const index = SITE_STEPS.indexOf(step);
    const isDone = step === 'imported';
    return <nav className={g.progressWrap} aria-label="申請進度">
        <p className={g.progressCount} aria-live="polite">
            {isDone ? '全部完成' : `第 ${index + 1} 步，共 ${TOTAL_SITE_STEPS} 步`}
            <span className={g.progressCountMuted}>{isDone ? '' : `：${GUIDE_COPY[step].label}`}</span>
        </p>
        <ol className={g.progress}>
            {SITE_STEPS.map((item, i) => {
                const passed = i < index || (isDone && i === index);
                const state = i === index && !isDone ? 'current' : passed && (item !== 'sign' || signDone) ? 'done' : 'todo';
                const last = item === 'imported';
                const stateText = state === 'done' ? '已完成' : state === 'current' ? '目前在這一步'
                    : passed ? '勾選的市場還沒全部確認已簽署' : '還沒開始';
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
            <Progress step={step} imported={!!guide.imported} signDone={allChosenSigned(guide)} onSelect={guide.setStep} />
            <div className={bodyClass} ref={contentRef}>
                <div className={g.doneHero}>
                    <span className={g.doneIcon}><Check size={34} strokeWidth={3} aria-hidden /></span>
                    <h2 className={g.title}>完成！{copy.title}</h2>
                    {!production && <p className={g.lead}><Rich text={copy.lead} /></p>}
                </div>
                {failure && <p className={g.secondary}>之後下載的 .env 沒有載入成功，目前使用的仍是下面這把金鑰。</p>}
                {guide.downloaded && <p className={g.secondary}>{downloadedText(guide.downloaded)}</p>}
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
                <section className={g.signSection} aria-labelledby="apply-done-sign">
                    <h3 id="apply-done-sign" className={g.subTitle}><FileSignature size={19} aria-hidden />API 約定書</h3>
                    <p className={g.secondary}>{doneSignText(guide)}</p>
                    {guide.openError && <Callout tone="danger" title="打不開申請視窗"
                        actions={<button className={g.secondaryButton} disabled={guide.opening} onClick={() => void guide.open()}><RotateCw size={18} aria-hidden />重新打開官網</button>}>
                        {guide.openError}
                    </Callout>}
                    <SignRows guide={guide} compact />
                </section>
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
        <Progress step={step} imported={!!guide.imported} signDone={allChosenSigned(guide)} onSelect={guide.setStep} />
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
            {step === 'sign'
                ? <SignStep guide={guide} windowOpen={windowOpen} />
                : <PointList points={copy.points} canLocate={windowOpen} onLocate={guide.locate} />}
            {step === 'login' && windowOpen && <div className={g.actions}>
                <button className={g.secondaryButton} onClick={() => void showApplyApiPage()}><ArrowRight size={18} aria-hidden />回到 API 管理頁</button>
            </div>}
            {step === 'success' && windowState !== 'browser' && <SaveEnvOption guide={guide} />}
            {guide.downloaded && step === 'success' && <p className={g.secondary}>{downloadedText(guide.downloaded)}</p>}
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
