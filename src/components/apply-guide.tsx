// src/components/apply-guide.tsx — 首次設定的預設畫面：一步一步帶使用者在
// 永豐官網申請 API Key、下載 .env，由原生殼直接載入金鑰後啟動模擬環境。
// 同一套導覽也從 App 裡「申請／下載憑證導覽」叫出（apply-guide-panel.tsx）：
// 先選要做的事（申請正式 API Key／下載 CA 憑證／簽署約定書），再走同一個申請視窗。
// 官網開在原生申請視窗（見 apply-guide-native.ts）；文案與網頁標示目標
// 集中在 apply-guide-config.ts。

import {
    ALargeSmall, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheckBig, CircleHelp, Clock, Crosshair,
    ExternalLink, FileKey, FileSignature, Flag, FlaskConical, Hourglass, KeyRound, ListChecks, Loader2, LogOut, MessageSquareText, Moon, OctagonAlert, Play, RotateCw, ShieldCheck,
    SquarePen, Sun, ThumbsUp, TriangleAlert, UserRound, X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { SIGNING_URLS, type SigningMarket } from '../lib/account-signing';
import {
    IN_APP_TASKS, PRODUCTION_NEXT_STEPS, SIGN_MARKET_COPY, SIGN_STATE_LABEL, SIGNING_MARKETS, TASK_CHOICES, TASK_ORDER,
    guideCardOf, guideCopyOf, guideStepOf, nextGuideStep, previousGuideStep, progressStepsOf, signMarketOf, signTargetId, sitePageOf, targetPageOf,
    type ApplyGuideTask, type ApplyPageStep, type GuidePoint, type GuideStep, type InAppGuideTask, type SignState,
} from '../lib/apply-guide-config';
import {
    clearApplySiteData, focusApplyTarget, listenApplyGuide, setApplyCaTarget, setApplyGuideCard, setApplyImportEnvironment, setApplySaveCa, setApplySaveEnv,
    openApplyWindow, showApplyApiPage, showApplySignPage,
    type ApplyGuideEvent, type ApplyWindowOpenResult, type ApplyWindowPlacement, type DownloadStatus,
} from '../lib/apply-guide-native';
import type { CredentialEnvironment } from '../lib/desktop-credentials';
import { openExternalUrl, type DesktopSettings } from '../lib/tauri';
import { baseMode, setThemeSettings, useThemeSettings } from '../lib/theme-store';
import * as g from './apply-guide.css';

export type ApplyWindowState = 'idle' | 'open' | 'browser' | 'closed';
export interface ApplyImported { profileId: string; name: string; environment?: CredentialEnvironment }
/** 「下載憑證」收下並設定到帳號的結果（不含憑證內容）。 */
export interface ApplyCaAttached { profileId: string; name: string; fileName: string; hasCaPassword: boolean }

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
    /** 「上一步」「下一步」（App 與官網上的說明卡共用）。 */
    canPrevious: boolean;
    canNext: boolean;
    goPrevious: () => void;
    goNext: () => void;
    /** 在官網上、黃色框旁邊顯示這一步的說明卡（預設開，選擇會記住）。 */
    pageCard: boolean;
    setPageCard: (on: boolean) => void;
    /** 這次導覽要做的事（首次設定固定 apply）。 */
    task: ApplyGuideTask;
    /** App 裡選了要做的事：切到該任務、打開（或沿用）申請視窗。 */
    chooseTask: (task: InAppGuideTask) => Promise<void>;
    /** 回到「選擇要做的事」。 */
    backToTasks: () => void;
    /** CA 憑證要設定到的正式帳號（null＝還沒選）。 */
    caProfileId: string | null;
    setCaProfile: (profileId: string | null) => Promise<void>;
    caAttached: ApplyCaAttached | null;
    /** 憑證沒有收成（格式不符、帳號不能用、選帳號失敗）的原因。 */
    caError: string;
    /** 「下載憑證」時同時把 Sinopac.pfx 存到下載資料夾（預設關，選擇會記住）。 */
    saveCaFile: boolean;
    setSaveCaFile: (save: boolean) => void;
}

export interface ApplyGuideOptions {
    task?: ApplyGuideTask;
    /** 憑證已設定到帳號：帳號清單要重新讀取 */
    onChanged?: () => void;
}

const SAVE_CA_KEY = 'sjpro.applyGuide.saveCaFile';
function readSaveCaPref(): boolean {
    try { return localStorage.getItem(SAVE_CA_KEY) === '1'; } catch { return false; }
}
function writeSaveCaPref(save: boolean) {
    try { if (save) localStorage.setItem(SAVE_CA_KEY, '1'); else localStorage.removeItem(SAVE_CA_KEY); } catch { /* 只是介面偏好 */ }
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

const PAGE_CARD_KEY = 'sjpro.applyGuide.pageCard';
/** 預設開；關掉時記成 '0'。 */
function readPageCardPref(): boolean {
    try { return localStorage.getItem(PAGE_CARD_KEY) !== '0'; } catch { return true; }
}
function writePageCardPref(on: boolean) {
    try { if (on) localStorage.removeItem(PAGE_CARD_KEY); else localStorage.setItem(PAGE_CARD_KEY, '0'); } catch { /* 只是介面偏好 */ }
}

export type SiteClearState = { kind: 'idle' } | { kind: 'clearing' } | { kind: 'done' } | { kind: 'failed'; message: string };

/** 導覽狀態放在 OnboardingSetup：切到手動設定時事件仍會收到。 */
export function useApplyGuide(onImported?: (imported: ApplyImported) => void, options: ApplyGuideOptions = {}): ApplyGuideController {
    const [step, setStep] = useState<GuideStep>('start');
    const [task, setTaskState] = useState<ApplyGuideTask>(options.task ?? 'apply');
    const taskRef = useRef(task);
    taskRef.current = task;
    const inAppRef = useRef(options.task !== undefined);
    const [caProfileId, setCaProfileState] = useState<string | null>(null);
    const caProfileRef = useRef<string | null>(null);
    const caRequestRef = useRef(0);
    /** 交接任務時送出憑證帳號的那一次（之後使用者又改選，就不是同一次） */
    const syncCaRequestRef = useRef(0);
    /** 每次把任務交給原生端算一次：較新的一次開始後，舊的不再往下送（不會蓋掉新任務選好的憑證帳號） */
    const syncRef = useRef(0);
    /** 每選一件事或回到選擇畫面算一次：等待中的舊切換不再動畫面、不再打開視窗 */
    const turnRef = useRef(0);
    /** 申請視窗每關一次算一次：關掉以後原生端已重設，等待中的切換不能把視窗再打開 */
    const closedRef = useRef(0);
    const [caAttached, setCaAttached] = useState<ApplyCaAttached | null>(null);
    const [caError, setCaError] = useState('');
    const [saveCaFile, setSaveCaState] = useState(readSaveCaPref);
    const saveCaRef = useRef(saveCaFile);
    saveCaRef.current = saveCaFile;
    const changedRef = useRef(options.onChanged);
    changedRef.current = options.onChanged;
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
    const [pageCard, setPageCardState] = useState(readPageCardPref);
    // 給事件處理用的最新值（同一批事件內也正確）
    const pageCardRef = useRef(pageCard);
    pageCardRef.current = pageCard;
    const setPageCardRef = useRef<(on: boolean) => void>(() => undefined);
    const hasImportedRef = useRef(false);
    /** 畫面上這一步（給官網卡片的「下一步」決定要不要切回 API 管理頁） */
    const stepRef = useRef<GuideStep>('start');
    stepRef.current = step;
    const theme = useThemeSettings();
    const windowRef = useRef<ApplyWindowState>('idle');
    windowRef.current = windowState;
    // 面板關掉（卸載）以後，還在等的工作不再打開申請視窗
    const aliveRef = useRef(true);
    useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
    const saveEnvRef = useRef(saveEnvFile);
    saveEnvRef.current = saveEnvFile;
    hasImportedRef.current = !!imported;
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
                    // App 裡的導覽停在「選擇要做的事」時，官網換頁不帶走畫面（首次設定照舊）
                    setStep(current => current === 'start' && inAppRef.current ? current : followSiteStep(current, event.step, taskRef.current));
                    break;
                }
                case 'imported': {
                    const value: ApplyImported = { profileId: event.profileId, name: event.name, ...(event.environment ? { environment: event.environment } : {}) };
                    // 存檔較慢、使用者已經換成下載憑證或簽署：帳號照樣重新讀取，但不打斷現在這件事
                    if (taskRef.current !== 'apply' && taskRef.current !== 'production') {
                        importedRef.current?.(value);
                        break;
                    }
                    setImported(value); setFailure(null); setStep('imported');
                    hasImportedRef.current = true;
                    // 正式金鑰載入後，下一步的 CA 憑證預設設定到這個帳號
                    if (taskRef.current === 'production' && event.environment === 'production') void selectCa(event.profileId);
                    importedRef.current?.(value);
                    break;
                }
                case 'ca-attached':
                    setCaAttached({ profileId: event.profileId, name: event.name, fileName: event.fileName, hasCaPassword: event.hasCaPassword });
                    setCaError('');
                    changedRef.current?.();
                    break;
                case 'ca-failed':
                    setCaError(event.message);
                    break;
                case 'import-failed':
                    setFailure({ message: event.message });
                    break;
                case 'downloaded':
                    setDownloaded({ fileName: event.fileName, status: event.status });
                    break;
                case 'closed':
                    // 同步記下來：還在等原生端回應的切換（還沒重畫）也看得到視窗已經關掉
                    ++closedRef.current; windowRef.current = 'closed';
                    setWindowState('closed'); setSynced(null);
                    break;
                case 'nav': {
                    // 官網頁面送來的（官網自己的程式也能假造）：只移動導覽步驟或關掉說明卡，條件和 App 裡的按鈕相同。
                    // 從簽署頁按「下一步」和 App 的「下一步」一樣把官網切回 API 管理頁（固定網址；官網本來就能自己換頁，不多給權限）
                    // 同一批事件（React 還沒重畫）也要從最新的步驟算：用 functional update 與同步更新的 ref
                    if (!pageCardRef.current) break;
                    if (event.action === 'hide') setPageCardRef.current(false);
                    else {
                        const action = event.action;
                        if (action === 'next' && stepRef.current === 'sign' && windowRef.current === 'open' && signMarketOf(syncedRef.current)) void showApplyApiPage();
                        setStep(current => pageNavStep(current, action, hasImportedRef.current, taskRef.current));
                    }
                    break;
                }
            }
        };
        void listenApplyGuide(handle).then(unlisten => { if (active) off = unlisten; else unlisten(); });
        return () => { active = false; off?.(); };
    }, []);
    /** 把這次任務交給原生端：.env 存成哪個環境、憑證設定到哪個帳號（視窗關掉後原生端會重設）。 */
    const syncTask = async (current: ApplyGuideTask) => {
        const sync = ++syncRef.current;
        const closes = closedRef.current;
        try { await setApplyImportEnvironment(current === 'production' ? 'production' : 'simulation'); } catch (error) {
            // 存不成正式帳號，這件事做不下去：上一件事留下的憑證帳號也不再攔截
            if (sync === syncRef.current && aliveRef.current) { ++caRequestRef.current; void setApplyCaTarget(null).catch(() => undefined); }
            throw error;
        }
        // 等待中又開始了另一件事（或回到選擇畫面）：由較新的那一次決定憑證帳號
        if (sync !== syncRef.current) return;
        // 面板已經關掉：之後叫出來的導覽自己決定憑證帳號
        if (!aliveRef.current) return;
        // 等待中視窗被關掉：原生端已清掉憑證帳號，重新打開時再送
        if (closes !== closedRef.current) return;
        const target = current === 'production' || current === 'ca' ? caProfileRef.current : null;
        syncCaRequestRef.current = ++caRequestRef.current;
        await setApplyCaTarget(target);
    };
    const selectCa = async (profileId: string | null) => {
        caProfileRef.current = profileId; setCaProfileState(profileId); setCaError('');
        if (windowRef.current !== 'open') return;
        const request = ++caRequestRef.current;
        try { await setApplyCaTarget(profileId); } catch (error) {
            // 使用者已經改選別的帳號：舊的結果不算
            if (request !== caRequestRef.current) return;
            caProfileRef.current = null; setCaProfileState(null);
            setCaError(error instanceof Error ? error.message : String(error));
        }
    };
    const openWindow = async (): Promise<ApplyWindowOpenResult | null> => {
        setOpening(true); setOpenError(''); setSiteClear({ kind: 'idle' });
        const turn = turnRef.current;
        try {
            const result = await openApplyWindow();
            // 面板在開窗途中關掉了：不再把這件事交給原生端（之後叫出來的導覽自己同步）
            if (!aliveRef.current) return null;
            // 原生端每次啟動都預設不存檔：開窗後把使用者記住的選擇帶過去
            if (result !== 'browser') {
                void setApplySaveEnv(saveEnvRef.current);
                void setApplySaveCa(saveCaRef.current);
                windowRef.current = 'open';
                const closes = closedRef.current;
                const request = caRequestRef.current;
                const sent = caProfileRef.current;
                try { await syncTask(taskRef.current); } catch (error) {
                    // 同步途中視窗被關掉：原生端已重設，這次的失敗不算
                    if (closes !== closedRef.current) return null;
                    // 正式金鑰存不成正式帳號、或憑證帳號設定失敗：不能讓使用者照著做下去
                    if (taskRef.current === 'production') throw error;
                    // 等待中使用者已經改選帳號：這次的結果不算（syncTask 自己只算一次）
                    if (caRequestRef.current <= request + 1 && caProfileRef.current === sent) {
                        caProfileRef.current = null; setCaProfileState(null);
                        setCaError(error instanceof Error ? error.message : String(error));
                    }
                }
                // 同步途中視窗被關掉：不能當成開著（畫面留在「官網視窗已關閉」，重新打開會再同步一次）
                if (closes !== closedRef.current) return null;
                // 同步途中面板關掉了：不再替它送憑證帳號
                if (!aliveRef.current) return null;
                // 開窗途中改選了帳號（那時還送不出去）：把最新的選擇送過去
                if (caProfileRef.current !== sent && (taskRef.current === 'ca' || taskRef.current === 'production')) {
                    windowRef.current = 'open';
                    void selectCa(caProfileRef.current);
                }
            }
            if (result === 'browser') setWindowState('browser');
            else { setPlacement(result); setWindowState('open'); }
            // 開窗途中使用者回到「選擇要做的事」：留在選擇畫面，不自己進到某件事
            setStep(current => current === 'start' && turn === turnRef.current ? 'login' : current);
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
    const canPrevious = canGoPrevious(step, !!imported, task);
    const canNext = canGoNext(step, !!imported, task);
    // 從排隊中的最新步驟算：同一批裡網頁卡片的按鈕先到也不會被蓋掉（和 pageNavStep 同一套限制）
    const goPrevious = () => setStep(current => pageNavStep(current, 'prev', hasImportedRef.current, taskRef.current));
    // 從簽署到 API 管理：官網還停在簽署頁時一起切回 API 管理頁（固定網址），和「前往 API 管理頁申請金鑰」相同
    const goNext = () => {
        // 切頁是副作用，留在 updater 外面，照畫面上這一步決定
        if (step === 'sign' && windowRef.current === 'open' && signMarketOf(syncedRef.current)) void showApplyApiPage();
        setStep(current => pageNavStep(current, 'next', hasImportedRef.current, taskRef.current));
    };
    const chooseTask = async (next: InAppGuideTask) => {
        const turn = ++turnRef.current;
        taskRef.current = next; setTaskState(next);
        // 每件事都重新選憑證要給哪個帳號（上一次選的帳號可能已經刪掉或改成模擬）
        caProfileRef.current = null; setCaProfileState(null);
        setCaError(''); setCaAttached(null); setFailure(null); setDownloaded(null); setOpenError('');
        setImported(null); hasImportedRef.current = false;
        // 官網已經登入、停在某一頁：直接跳到這件事對應的步驟（不必重新登入）
        const site = syncedRef.current;
        setStep(site && windowRef.current === 'open' ? followSiteStep('login', site, next) : 'login');
        const closes = closedRef.current;
        // 等待中使用者換了另一件事、或關掉申請視窗：這一次的結果不算
        const stale = () => turn !== turnRef.current || closes !== closedRef.current;
        if (windowRef.current === 'open') {
            try { await syncTask(next); } catch (error) {
                if (stale()) return;
                const message = error instanceof Error ? error.message : String(error);
                if (next === 'production') { setOpenError(message); setStep('start'); }
                else {
                    // 交接途中選的帳號被原生端拒絕：取消選取（原生端沒有在攔截）；之後又改選的不動
                    if (caRequestRef.current === syncCaRequestRef.current) {
                        caProfileRef.current = null; setCaProfileState(null);
                        setCaError(message);
                    }
                }
            }
            // 視窗在等待中被關掉：不自己重開（原生端已回到模擬、不攔截憑證），
            // 由使用者按「重新打開官網」走完整的開窗同步
            if (!aliveRef.current || stale()) return;
            const result = await openApplyWindow().catch(() => null); // 帶到前面
            if ((result === 'beside' || result === 'overlay') && !stale()) setPlacement(result);
            return;
        }
        if (!aliveRef.current) return;
        const result = await openWindow();
        if (!result && next === 'production' && !stale()) setStep('start');
    };
    const backToTasks = () => {
        // 選擇畫面不屬於任何一件事：原生端照首次設定（模擬、一般下載），官網換頁也不離開選擇畫面
        ++turnRef.current;
        taskRef.current = 'sign'; setTaskState('sign');
        setStep('start');
        // 不再攔截下載：回到選擇時原生端照首次設定（模擬、一般下載）
        if (windowRef.current === 'open') void syncTask('sign').catch(() => undefined);
    };
    const setSaveCaFile = (save: boolean) => {
        setSaveCaState(save); writeSaveCaPref(save);
        void setApplySaveCa(save);
    };
    const setPageCard = (on: boolean) => { pageCardRef.current = on; setPageCardState(on); writePageCardPref(on); };
    setPageCardRef.current = setPageCard;
    // 官網上的說明卡跟著導覽這一步走；關掉時送 null 把卡片拿掉
    const cardTheme = baseMode(theme);
    const cardLarge = theme.fontScale === 1.3;
    useEffect(() => {
        if (windowState !== 'open') return;
        const show = pageCard && step !== 'start';
        void setApplyGuideCard(show ? guideCardOf(step, { canPrev: canPrevious, canNext, theme: cardTheme, large: cardLarge }, task) : null);
    }, [windowState, pageCard, step, canPrevious, canNext, cardTheme, cardLarge, task]);
    // CA 憑證這一步：在官網上標示「下載憑證」（官網不在 API 管理頁時先切過去；換頁後標示會不見，再標一次）
    useEffect(() => {
        if (step !== 'ca' || windowState !== 'open' || !synced || synced === 'login') return;
        if (synced !== 'list' && sitePageOf(synced) === 'list') return; // 官網開著對話框：等關掉
        void locate('download-ca');
    }, [step, windowState, synced]); // eslint-disable-line react-hooks/exhaustive-deps
    return {
        step, setStep, windowState, placement, synced, imported, failure, downloaded, opening, openError, open,
        siteClear, clearSiteData, saveEnvFile, setSaveEnvFile, markets, setMarket, signs, signError, openSignPage, locate,
        canPrevious, canNext, goPrevious, goNext, pageCard, setPageCard,
        task, chooseTask, backToTasks, caProfileId, setCaProfile: selectCa, caAttached, caError, saveCaFile, setSaveCaFile,
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
    const copy = guideCopyOf(guide.task, 'sign');
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
        {windowOpen && guide.task !== 'sign' && <div className={g.actions}>
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


/** 文案裡用「」包起來的介面名稱畫成框，讓使用者一眼看出要按哪個。 */
export function Rich({ text }: { text: string }) {
    const parts = text.split(/「([^」]+)」/);
    return <>{parts.map((part, i) => i % 2 === 1
        ? <span key={i} className={g.uiChip}><span className={g.srOnly}>「</span>{part}<span className={g.srOnly}>」</span></span>
        : part)}</>;
}

/** 顯示設定：大字、深淺色。寫進 App 的主題設定，之後進到 App 也一樣。 */
function DisplayControls({ guide }: { guide?: ApplyGuideController }) {
    const theme = useThemeSettings();
    const large = theme.fontScale === 1.3;
    const light = baseMode(theme) === 'light';
    return <div className={g.displayControls} role="group" aria-label="顯示設定">
        {guide && <button className={g.toggle} aria-pressed={guide.pageCard} onClick={() => guide.setPageCard(!guide.pageCard)}
            title={guide.pageCard ? '官網上黃色框旁邊會顯示這一步的說明，按一下關掉' : '在官網上黃色框旁邊顯示這一步的說明'}>
            <MessageSquareText size={18} aria-hidden />網頁說明
        </button>}
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

/**
 * 「上一步」「下一步」：開始頁與載入金鑰後的完成頁沒有；第一步沒有上一步，載入金鑰前「下載 .env」是最後一步。
 * App 裡的任務：正式金鑰載入後還有「CA 憑證」；只下載憑證、只簽署的最後一步沒有下一步。
 */
export function canGoPrevious(step: GuideStep, imported: boolean, task: ApplyGuideTask = 'apply') {
    if (task !== 'apply' && !TASK_ORDER_OF(task).includes(step)) return false;
    return step !== 'start' && !(step === 'imported' && imported) && step !== 'login';
}
export function canGoNext(step: GuideStep, imported: boolean, task: ApplyGuideTask = 'apply') {
    if (task === 'apply') return step !== 'start' && !(step === 'imported' && imported) && !(step === 'success' && !imported);
    const order = TASK_ORDER_OF(task);
    const at = order.indexOf(step);
    return at > 0 && at < order.length - 1 && !(step === 'success' && !imported) && !(step === 'imported' && !imported);
}
const TASK_ORDER_OF = (task: ApplyGuideTask) => TASK_ORDER[task];
/** 官網上說明卡的按鈕：只換導覽步驟（不切換官網頁面）；不能動就停在原地。 */
export function pageNavStep(step: GuideStep, action: 'next' | 'prev', imported: boolean, task: ApplyGuideTask = 'apply'): GuideStep {
    if (action === 'next') return canGoNext(step, imported, task) ? nextGuideStep(step, task) : step;
    return canGoPrevious(step, imported, task) ? previousGuideStep(step, task) : step;
}

/** 勾選的市場全部讀到「已簽署」（沒勾任何市場也算）：進度列的「簽署」才打勾。 */
/**
 * 官網換頁時導覽要停在哪一步。
 * - 完成頁：關掉「新增成功」回到列表、登出、打開簽署頁都留在完成頁；開始申請另一把（身份驗證以後）才跟著官網走。
 * - 登入後官網會直接進 API 管理列表：導覽先停在「簽署」，使用者按「前往 API 管理頁申請金鑰」或「下一步」才往下；
 *   已在簽署步驟時官網停在列表也不往前跳。
 */
export function followSiteStep(current: GuideStep, site: ApplyPageStep, task: ApplyGuideTask = 'apply'): GuideStep {
    // 只下載憑證、只簽署：登入後一律停在那一步；回到登入頁（登出、逾時）才回登入
    if (task === 'ca' || task === 'sign') return site === 'login' ? 'login' : task;
    // 正式金鑰在 CA 憑證這一步：除非開始申請另一把（身份驗證以後），都留在這一步
    if (task === 'production' && current === 'ca' && !(site === 'verify' || site === 'form' || site === 'success')) return current;
    const next = guideStepOf(site);
    if (current === 'imported' && (site === 'list' || site === 'login' || signMarketOf(site))) return current;
    if (next === 'list' && (current === 'start' || current === 'login' || current === 'sign')) return 'sign';
    return next;
}

export function allChosenSigned(guide: Pick<ApplyGuideController, 'markets' | 'signs'>) {
    return guide.markets.every(market => guide.signs[market] === 'signed');
}

function Progress({ step, imported, signDone, onSelect, task = 'apply' }: {
    step: GuideStep; imported: boolean;
    /** 「簽署」只在勾選的市場都已簽署時打勾；只是顯示，不擋任何步驟 */
    signDone: boolean;
    onSelect: (step: GuideStep) => void;
    task?: ApplyGuideTask;
}) {
    const { steps, total } = progressStepsOf(task);
    const index = steps.indexOf(step);
    // 首次設定的「完成」是終點；App 裡的任務每一步都算一步
    const isDone = task === 'apply' && step === 'imported';
    const label = (item: GuideStep) => guideCopyOf(task, item).label;
    return <nav className={g.progressWrap} aria-label={task === 'apply' ? '申請進度' : '導覽進度'}>
        <p className={g.progressCount} aria-live="polite">
            {isDone ? '全部完成' : `第 ${index + 1} 步，共 ${total} 步`}
            <span className={g.progressCountMuted}>{isDone ? '' : `：${label(step)}`}</span>
        </p>
        <ol className={g.progress}>
            {steps.map((item, i) => {
                const passed = i < index || (isDone && i === index);
                const state = i === index && !isDone ? 'current' : passed && (item !== 'sign' || signDone) ? 'done' : 'todo';
                const last = task === 'apply' ? item === 'imported' : i === steps.length - 1;
                // 「完成／存入 App」要等金鑰載入；首次設定的終點也是
                const locked = item === 'imported' && !imported;
                const stateText = state === 'done' ? '已完成' : state === 'current' ? '目前在這一步'
                    : passed ? '勾選的市場還沒全部確認已簽署' : '還沒開始';
                return <li key={item} className={g.progressItem}>
                    {i > 0 && <span className={g.stepLine[i <= index ? 'done' : 'todo']} aria-hidden />}
                    <button className={g.step[state]} aria-current={state === 'current' ? 'step' : undefined}
                        aria-label={`${label(item)}，${stateText}`}
                        disabled={locked} onClick={() => onSelect(item)}>
                        <span className={g.dot[state]} aria-hidden>
                            {state === 'done' ? <Check size={18} strokeWidth={3} /> : last ? <Flag size={16} /> : i + 1}
                        </span>
                        <span className={g.stepLabel}>{label(item)}</span>
                    </button>
                </li>;
            })}
        </ol>
    </nav>;
}

export function ApplyGuide({ guide, settings, busy, docked = false, fab = docked, contentRef, onManual, onStart, inApp = false, onClose, onOpenAccount }: {
    guide: ApplyGuideController;
    settings: DesktopSettings;
    busy: boolean;
    /** 申請視窗蓋住主視窗右側：卡片縮成 428px 貼左，AI 浮鈕停在卡片右下。 */
    docked?: boolean;
    /** 卡片右下要留 AI 浮鈕的位置（預設跟著 docked；App 裡的面板沒有浮鈕）。 */
    fab?: boolean;
    /** AI 浮鈕對齊用：卡片內容區。 */
    contentRef?: Ref<HTMLDivElement>;
    onManual: () => void;
    onStart: (profileId: string) => Promise<void>;
    /** 從 App 裡叫出（不是首次設定）：開始頁是「選擇要做的事」，沒有手動輸入的捷徑。 */
    inApp?: boolean;
    /** 頁首的關閉鈕（App 裡的導覽面板）。 */
    onClose?: () => void;
    /** 到帳號設定編輯這個帳號（輸入憑證密碼）。 */
    onOpenAccount?: (profileId: string) => void;
}) {
    const { step, windowState } = guide;
    const copy = guideCopyOf(guide.task, step);
    const windowOpen = windowState === 'open';
    const cardClass = docked ? g.cardDocked : g.card;
    const bodyClass = fab ? g.bodyWithFab : g.body;
    const manualLink = inApp
        ? <div className={g.quietLinks}>
            <button className={g.textButton} onClick={guide.backToTasks}><ListChecks size={18} aria-hidden />換一件要做的事</button>
        </div>
        : <div className={g.quietLinks}>
            <button className={g.textButton} onClick={onManual}><SquarePen size={18} aria-hidden />{step === 'start' ? '我已經有 API Key' : '改用手動輸入或匯入 .env 檔'}</button>
        </div>;
    const label = inApp ? '申請／下載憑證導覽' : '申請 API Key 導覽';

    const header = <div className={g.header}>
        <div className={g.headerTitle}>
            <span className={g.headerIcon}><KeyRound size={20} aria-hidden /></span>
            <p className={g.brand}>{inApp ? '申請／下載憑證' : '申請 API Key'}</p>
            {!docked && <span className={g.brandSub}>Shioaji Pro</span>}
        </div>
        {onClose
            // 顯示設定和關閉鈕一起換行：窄的面板裡關閉鈕不會單獨落到下一行
            ? <div className={g.headerEnd}>
                <DisplayControls guide={windowOpen && step !== 'start' ? guide : undefined} />
                <button className={g.closeButton} aria-label="關閉導覽" title="關閉導覽" onClick={onClose}><X size={20} aria-hidden /></button>
            </div>
            : <DisplayControls guide={windowOpen && step !== 'start' ? guide : undefined} />}
    </div>;
    if (inApp && step === 'start') {
        return <section className={cardClass} aria-label={label}>
            {header}
            <div className={bodyClass} ref={contentRef}>
                <TaskChooser guide={guide} settings={settings} />
                <SiteLogout guide={guide} />
            </div>
        </section>;
    }
    const syncBanner = windowOpen && guide.synced && step !== 'imported' && <div className={g.syncBanner} role="status">
        <span className={g.syncDot} aria-hidden />
        <span><strong>已連動官網</strong>：官網換頁時，這裡會自動跳到對應步驟。</span>
    </div>;

    if (step === 'start') {
        return <section className={cardClass} aria-label={label}>
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
    const failureCalloutNode = failureCallout(guide, onManual);

    if (step === 'imported' && guide.imported && guide.task === 'production') {
        const profile = settings.profiles.find(p => p.id === guide.imported!.profileId);
        // 舊版原生殼不帶環境；帶了而且是模擬（例如設定沒送到）就提醒
        const wrongEnvironment = (profile?.environment ?? guide.imported.environment) === 'simulation';
        const plaintext = (profile?.credentialBackend ?? settings.credentialBackend) === 'plaintext-fallback';
        return <section className={cardClass} aria-label={label}>
            {header}
            <Progress step={step} imported task={guide.task} signDone={allChosenSigned(guide)} onSelect={guide.setStep} />
            <div className={bodyClass} ref={contentRef}>
                <div className={g.doneHero}>
                    <span className={g.doneIcon}><Check size={34} strokeWidth={3} aria-hidden /></span>
                    <h2 className={g.title}>{copy.title}</h2>
                    <p className={g.lead}><Rich text={copy.lead} /></p>
                </div>
                {failureCallout(guide, onManual)}
                <dl className={g.doneBox}>
                    <dt className={g.doneTerm}>帳號名稱</dt>
                    <dd className={g.doneValue}>{profile?.name ?? guide.imported.name}{!wrongEnvironment && <span className={g.prodBadge}>正式環境</span>}</dd>
                    {profile?.apiKeyMasked && <><dt className={g.doneTerm}>API Key</dt><dd className={g.doneValue}><span className={g.mono}>{profile.apiKeyMasked}</span></dd></>}
                    {!plaintext && <><dt className={g.doneTerm}>保存位置</dt><dd className={g.doneValue}>這台電腦的系統憑證庫</dd></>}
                </dl>
                {plaintext && <Callout tone="warn" title="金鑰存成檔案">
                    這台電腦沒有可用的系統憑證庫，金鑰與憑證密碼存在 {settings.fallbackPath}（只有你的帳號能讀寫，0600）。同一使用者執行的程式（含 Agent）仍可能讀到這個檔案。
                </Callout>}
                {wrongEnvironment && <Callout tone="warn" title="這把金鑰存成了模擬帳號"
                    actions={onOpenAccount && <button className={g.secondaryButton} onClick={() => onOpenAccount(guide.imported!.profileId)}><SquarePen size={18} aria-hidden />到帳號設定改成正式環境</button>}>
                    請到帳號設定把環境改成正式環境，再下載 CA 憑證。
                </Callout>}
                <p className={g.secondary}>這個帳號還不是使用中的帳號。要用它交易時，到「伺服器設定 › 帳號」按「切換使用」；正式環境的委託會動用真實資金。</p>
                <div className={g.actions}>
                    <button className={g.primary} onClick={() => guide.setStep('ca')}><FileKey size={20} aria-hidden />下一步：下載 CA 憑證</button>
                </div>
                <SiteLogout guide={guide} />
            </div>
        </section>;
    }

    if (step === 'ca') {
        return <section className={cardClass} aria-label={label}>
            {header}
            {syncBanner}
            <Progress step={step} imported={!!guide.imported} task={guide.task} signDone={allChosenSigned(guide)} onSelect={guide.setStep} />
            <div className={bodyClass} ref={contentRef}>
                <h2 className={g.title}>{copy.title}</h2>
                <p className={g.lead}><Rich text={copy.lead} /></p>
                {windowState === 'closed' && <Callout tone="warn" title="官網視窗已關閉"
                    actions={<button className={g.secondaryButton} onClick={() => void guide.open()}><RotateCw size={18} aria-hidden />重新打開官網</button>}>
                    按「重新打開官網」繼續。
                </Callout>}
                {guide.openError && <Callout tone="danger" title="打不開申請視窗">{guide.openError}</Callout>}
                <CaStep guide={guide} settings={settings} windowOpen={windowOpen} onOpenAccount={onOpenAccount} />
                {manualLink}
                <SiteLogout guide={guide} />
            </div>
            <div className={g.footer}>
                <button className={g.secondaryButton} disabled={!guide.canPrevious} onClick={() => guide.goPrevious()}><ChevronLeft size={20} aria-hidden />上一步</button>
                {onClose
                    ? <button className={g.secondaryButton} onClick={onClose}><Check size={20} aria-hidden />完成</button>
                    : <button className={g.secondaryButton} disabled={!guide.canNext} onClick={() => guide.goNext()}>下一步<ChevronRight size={20} aria-hidden /></button>}
            </div>
        </section>;
    }

    if (step === 'imported' && guide.imported) {
        const profile = settings.profiles.find(p => p.id === guide.imported!.profileId);
        // 匯入後使用者可能在帳號設定改成正式環境：導覽只啟動模擬環境
        const production = profile?.environment === 'production';
        const plaintext = (profile?.credentialBackend ?? settings.credentialBackend) === 'plaintext-fallback';
        return <section className={cardClass} aria-label={label}>
            {header}
            <Progress step={step} imported={!!guide.imported} task={guide.task} signDone={allChosenSigned(guide)} onSelect={guide.setStep} />
            <div className={bodyClass} ref={contentRef}>
                <div className={g.doneHero}>
                    <span className={g.doneIcon}><Check size={34} strokeWidth={3} aria-hidden /></span>
                    <h2 className={g.title}>完成！{copy.title}</h2>
                    {!production && <p className={g.lead}><Rich text={copy.lead} /></p>}
                </div>
                {failure && <p className={g.secondary}>之後下載的 .env 沒有載入成功，目前使用的仍是下面這把金鑰。</p>}
                {guide.downloaded && <p className={g.secondary}>{downloadedText(guide.downloaded)}</p>}
                {failureCalloutNode}
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
                                    {item.target && guide.windowState === 'open' && <button className={g.locate}
                                        title="在申請視窗中把這個位置框起來" aria-label={`在網頁上標示：${item.title}`}
                                        onClick={() => void guide.locate(item.target!)}
                                    ><Crosshair size={17} aria-hidden />在網頁上標示</button>}
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

    return <section className={cardClass} aria-label={label}>
        {header}
        {syncBanner}
        <Progress step={step} imported={!!guide.imported} task={guide.task} signDone={allChosenSigned(guide)} onSelect={guide.setStep} />
        <div className={bodyClass} ref={contentRef}>
            <h2 className={g.title}>{copy.title}</h2>
            <p className={g.lead}><Rich text={copy.lead} /></p>
            {/* 放在最上面：按「下載 .env」之前就要看到 */}
            {step === 'success' && windowState !== 'browser' && <SaveEnvOption guide={guide} />}
            {windowState === 'closed' && <Callout tone="warn" title="官網視窗已關閉"
                actions={<button className={g.secondaryButton} onClick={() => void guide.open()}><RotateCw size={18} aria-hidden />重新打開官網</button>}>
                按「重新打開官網」繼續。{step === 'success' ? '如果已經看到「新增成功」但還沒下載 .env，Secret Key 已經看不到了，請再新增一把金鑰。' : ''}
            </Callout>}
            {guide.openError && <Callout tone="danger" title="打不開申請視窗">{guide.openError}</Callout>}
            {windowState === 'browser' && <Callout tone="warn" title="已改用瀏覽器打開官網"
                actions={<button className={g.secondaryButton} onClick={onManual}><SquarePen size={18} aria-hidden />從 .env 檔匯入</button>}>
                這個版本無法在 App 裡打開申請視窗。請照下面的步驟在瀏覽器申請，下載 .env 檔後回到這裡匯入。
            </Callout>}
            {failureCalloutNode}
            {step === 'sign'
                ? <SignStep guide={guide} windowOpen={windowOpen} />
                : <PointList points={copy.points} canLocate={windowOpen} onLocate={guide.locate} />}
            {step === 'login' && windowOpen && <div className={g.actions}>
                <button className={g.secondaryButton} onClick={() => void showApplyApiPage()}><ArrowRight size={18} aria-hidden />回到 API 管理頁</button>
            </div>}
            {guide.downloaded && step === 'success' && <p className={g.secondary}>{downloadedText(guide.downloaded)}</p>}
            {copy.note && <p className={g.secondary}>{copy.note}</p>}
            {manualLink}
            <SiteLogout guide={guide} />
        </div>
        <div className={g.footer}>
            <button className={g.secondaryButton} disabled={!guide.canPrevious} onClick={() => guide.goPrevious()}><ChevronLeft size={20} aria-hidden />上一步</button>
            {onClose && guide.task === 'sign' && step === 'sign'
                ? <button className={g.secondaryButton} onClick={onClose}><Check size={20} aria-hidden />完成</button>
                : <button className={g.secondaryButton} disabled={!guide.canNext} onClick={() => guide.goNext()}>下一步<ChevronRight size={20} aria-hidden /></button>}
        </div>
    </section>;
}

function failureCallout(guide: ApplyGuideController, onManual: () => void) {
    const failure = guide.failure;
    return failure && <Callout tone="danger" title="App 沒有收到 .env 檔"
        actions={<button className={g.secondaryButton} onClick={onManual}><SquarePen size={18} aria-hidden />改用手動輸入</button>}>
        {failure.message}。先不要關掉官網的「新增成功」視窗，再按一次「下載 .env」。還是不行的話，按「複製」把 API Key 和 Secret Key 貼到手動輸入。
    </Callout>;
}

const TASK_ICON = { production: KeyRound, ca: FileKey, sign: FileSignature } as const;

/** App 裡叫出導覽時的開始頁：選擇要做的事。官網登入沿用申請視窗保存的資料。 */
function TaskChooser({ guide, settings }: { guide: ApplyGuideController; settings: DesktopSettings }) {
    const hasProduction = settings.profiles.some(profile => profile.environment === 'production');
    return <>
        <div className={g.hero}>
            <h2 className={g.title}>要在官網上做什麼？</h2>
            <p className={g.lead}>App 會在旁邊打開永豐金證券官網，一步一步告訴你要按哪裡。官網之前登入過的話，通常不用重新登入。</p>
        </div>
        {guide.openError && <Callout tone="danger" title="打不開申請視窗"
            actions={<button className={g.secondaryButton} onClick={() => void guide.open()}><RotateCw size={18} aria-hidden />再試一次</button>}>
            {guide.openError}
        </Callout>}
        <ul className={g.taskList} aria-label="選擇要做的事">
            {IN_APP_TASKS.map(task => {
                const Icon = TASK_ICON[task];
                const choice = TASK_CHOICES[task];
                const hint = task === 'ca' && !hasProduction ? '還沒有正式帳號：先申請正式 API Key，或到帳號設定新增。' : null;
                return <li key={task}>
                    <button className={g.taskButton} disabled={guide.opening} onClick={() => void guide.chooseTask(task)}>
                        <span className={g.itemIcon} aria-hidden><Icon size={20} /></span>
                        <span className={g.itemText}>
                            <span className={g.itemTitle}>{choice.title}</span>
                            <span className={g.itemBody}><Rich text={choice.body} /></span>
                            {hint && <span className={g.taskHint}>{hint}</span>}
                        </span>
                        {guide.opening ? <Loader2 size={20} className={g.spinner} aria-hidden /> : <ChevronRight size={20} aria-hidden />}
                    </button>
                </li>;
            })}
        </ul>
        <p className={g.secondary}>帳號密碼、驗證碼與憑證密碼都不經過導覽：登入在官網上完成，憑證密碼在「伺服器設定 › 帳號」輸入。</p>
    </>;
}

/** 「同時把憑證檔存到『下載』資料夾」：預設關，只設定到帳號。 */
function SaveCaOption({ guide }: { guide: ApplyGuideController }) {
    const on = guide.saveCaFile;
    return <label className={g.option}>
        <input type="checkbox" className={g.optionBox} checked={on} aria-describedby="apply-save-ca-hint"
            onChange={event => guide.setSaveCaFile(event.currentTarget.checked)} />
        <span className={g.optionText}>
            <span className={g.optionTitle}>同時存一份到「下載」資料夾</span>
            <span id="apply-save-ca-hint" className={on ? g.optionHintWarn : g.optionHint}>
                {on ? '憑證檔可以用來下正式委託，請妥善保管。' : '按「下載憑證」只會設定到選的帳號，不會另存檔案。'}
            </span>
        </span>
    </label>;
}

/** CA 憑證這一步：選正式帳號、存檔選項、收到憑證後的結果與下一步（輸入憑證密碼）。 */
function CaStep({ guide, settings, windowOpen, onOpenAccount }: {
    guide: ApplyGuideController; settings: DesktopSettings; windowOpen: boolean;
    onOpenAccount?: (profileId: string) => void;
}) {
    const copy = guideCopyOf(guide.task, 'ca');
    const candidates = settings.profiles.filter(profile => profile.environment === 'production' && profile.secretState === 'stored');
    const only = candidates.length === 1 ? candidates[0]!.id : null;
    // 只有一個正式帳號時直接選它；選的帳號被刪掉或改成模擬就取消。
    // 自動選只做一次：原生端拒絕或選過帳號以後，等使用者自己選，不會一直重試
    const autoTried = useRef<string | null>(null);
    const listed = useRef(new Set<string>());
    useEffect(() => {
        const current = guide.caProfileId;
        for (const profile of candidates) listed.current.add(profile.id);
        if (current) {
            // 選過帳號以後不再自動選（被取消時不會偷偷換成另一個帳號）
            autoTried.current ??= current;
            // 帳號清單還沒重新讀進剛存的正式帳號：保留這個選擇，不改選別的帳號；
            // 列過的帳號被刪掉或改成模擬才取消
            if (listed.current.has(current) && !candidates.some(profile => profile.id === current)) void guide.setCaProfile(null);
            return;
        }
        if (only && autoTried.current === null) { autoTried.current = only; void guide.setCaProfile(only); }
    }, [only, guide.caProfileId, candidates.map(profile => profile.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
    const attached = guide.caAttached;
    const attachedProfile = attached && settings.profiles.find(profile => profile.id === attached.profileId);
    return <>
        {candidates.length === 0
            ? <Callout tone="warn" title="還沒有正式帳號"
                actions={<button className={g.secondaryButton} onClick={() => void guide.chooseTask('production')}><KeyRound size={18} aria-hidden />申請正式 API Key</button>}>
                憑證要設定到正式環境的帳號。先申請一把勾選「正式環境」的金鑰，或到帳號設定新增正式帳號。
            </Callout>
            : <fieldset className={g.marketSet}>
                <legend className={g.marketLegend}>憑證要設定到哪個正式帳號？</legend>
                <div className={g.profileOptions}>
                    {candidates.map(profile => {
                        const on = guide.caProfileId === profile.id;
                        return <label key={profile.id} className={on ? g.profileOptionOn : g.profileOption}>
                            <input type="radio" name="apply-ca-profile" className={g.optionBox} checked={on}
                                onChange={() => void guide.setCaProfile(profile.id)} />
                            <span className={g.optionText}>
                                <span className={g.optionTitle}>{profile.name}</span>
                                <span className={g.optionHint}>{profile.hasCA ? '已設定憑證，會換成新下載的' : '還沒有憑證'}</span>
                            </span>
                        </label>;
                    })}
                </div>
            </fieldset>}
        {guide.caError && <Callout tone="danger" title="憑證沒有存成">{guide.caError}。請確認選的帳號後，在官網再按一次「下載憑證」。</Callout>}
        {attached && <Callout tone="success" title="憑證已設定到帳號"
            actions={onOpenAccount && <button className={g.secondaryButton} onClick={() => onOpenAccount(attached.profileId)}><SquarePen size={18} aria-hidden />{attached.hasCaPassword ? '到帳號設定確認' : '到帳號設定輸入憑證密碼'}</button>}>
            「{attached.fileName}」已存到這台電腦，設定給「{attachedProfile?.name ?? attached.name}」。{attached.hasCaPassword
                ? '沿用之前輸入的憑證密碼；憑證換新後密碼若不同，請到帳號設定更新。'
                : '還要輸入憑證密碼才能正式下單：到帳號設定編輯這個帳號，輸入憑證密碼後儲存。'}下次啟動或重啟伺服器時套用。
        </Callout>}
        {windowOpen && guide.caProfileId && <SaveCaOption guide={guide} />}
        <PointList points={copy.points} canLocate={windowOpen && !!guide.caProfileId} onLocate={guide.locate} />
        {guide.downloaded && <p className={g.secondary}>{downloadedText(guide.downloaded)}</p>}
    </>;
}
