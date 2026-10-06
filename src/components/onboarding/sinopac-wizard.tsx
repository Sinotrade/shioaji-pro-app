// src/components/onboarding/sinopac-wizard.tsx — 帳號密碼申請 API Key：畫面由伺服器回報的 step 驅動，帳密只放在記憶體。

import { LoaderCircle, LogIn, ScrollText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchAccounts } from '../../lib/shioaji';
import {
    OnboardingApiError,
    onboardingApi,
    type OnboardingStepAction,
} from '../../lib/sinopac-onboarding/api';
import {
    ERROR_COPY,
    NOTICE_CREATE_ENDED,
    NOTICE_ENDED,
    NOTICE_LOGIN_UNSURE,
    NOTICE_OFFLINE,
    NOTICE_OTP_INVALID_ENDED,
    NOTICE_RESYNCED,
    isOnboardingErrorCode,
    onboardingErrorCode,
    type OnboardingStopCode,
} from '../../lib/sinopac-onboarding/errors';
import { createPlanForm, planFromForm } from '../../lib/sinopac-onboarding/plan';
import { checkReadiness } from '../../lib/sinopac-onboarding/readiness';
import { matchesTwcaTerms } from '../../lib/sinopac-onboarding/twca-terms';
import { isTauri } from '../../lib/tauri';
import type {
    OnboardingErrorCode,
    OnboardingOtpChannel,
    OnboardingOtpPurpose,
    OnboardingPlan,
    OnboardingResult,
    OnboardingStartRequest,
    OnboardingStatus,
    OnboardingStep,
} from '../../lib/sinopac-onboarding/types';
import * as styles from './sinopac-wizard.css';
import { BirthdayStep } from './steps/BirthdayStep';
import { CreatingStep } from './steps/CreatingStep';
import { DoneStep } from './steps/DoneStep';
import { FlowStepper } from './steps/FlowStepper';
import { LoginStep } from './steps/LoginStep';
import { OtpStep } from './steps/OtpStep';
import { PlanStep } from './steps/PlanStep';
import { StoppedStep } from './steps/StoppedStep';
import { StepHeader } from './steps/step-header';
import * as stepStyles from './steps/steps-a.css';
import { TermsStep } from './steps/TermsStep';

type Keys = { apiKey: string; secretKey: string };

export interface SinopacWizardProps {
    /**
     * 金鑰已建立後，使用者按下完成時呼叫一次；回傳後金鑰立刻從記憶體丟掉，reject 則留著讓使用者再試。
     * keys 只有桌面版（要用它啟動伺服器）或存檔失敗時才有；saveFailed 表示伺服器沒寫入 .env。
     */
    onKeysReady: (keys: Keys | null, info: { saveFailed: boolean }) => void | Promise<void>;
    /** 停止畫面的「改用 API Key 登入」：交給上層切換分頁。 */
    onUseApiKey: () => void;
    /** 完成畫面顯示著只出現一次的 Secret、使用者還沒確認已保存時為 true。 */
    onLockedChange?: (locked: boolean) => void;
    /** 本機瀏覽器的狀態，給播放窗用：working 正在操作官網、waiting 停在官網等使用者輸入、off 沒有可看的畫面。 */
    onBrowserChange?: (browser: BrowserActivity) => void;
}

export type BrowserActivity = 'off' | 'waiting' | 'working';

// Vite 熱更新替換這個模組時，舊元件的卸載不是使用者離開：不取消流程、不丟金鑰。
let hotDisposed = false;
if (import.meta.hot) import.meta.hot.dispose(() => { hotDisposed = true; });

interface Finished {
    result: OnboardingResult;
    /** 只有存檔失敗時才顯示給使用者；平常金鑰只留在 keysRef 交給上層。 */
    revealed: Keys | null;
    saveFailed: boolean;
    savedPath?: string;
}

const ACTIVE_STEPS: OnboardingStep[] = [
    'birthday',
    'cert_otp',
    'terms',
    'relogin',
    'plan',
    'key_otp',
    'creating',
];
const CERT_STEPS: OnboardingStep[] = ['birthday', 'cert_otp', 'terms', 'relogin'];
// 還原到 creating 時最多每 3 秒讀一次、共 40 次，不無限輪詢。
const CREATING_POLL_MS = 3000;
const CREATING_POLL_MAX = 40;
const UNAVAILABLE_NOTICE =
    '此環境沒有帳號密碼申請功能（僅限開發模式的網頁版）。請改用「API Key 登入」。';

// 讀取進度時先佔好第 1 步的形狀，進度出來後內容直接換上去。
function Skeleton() {
    return (
        <div className={styles.skeleton} aria-hidden='true'>
            <div className={styles.boneBar} />
            <div className={styles.boneTitle} />
            <div className={styles.boneLine} />
            <div className={styles.boneLabel} />
            <div className={styles.boneField} />
            <div className={styles.boneLabel} />
            <div className={styles.boneField} />
            <div className={styles.boneButton} />
        </div>
    );
}

export function SinopacWizard({ onKeysReady, onUseApiKey, onLockedChange, onBrowserChange }: SinopacWizardProps) {
    const [probe, setProbe] = useState<'checking' | 'ready' | 'unavailable'>('checking');
    const [status, setStatus] = useState<OnboardingStatus | null>(null);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [stopped, setStopped] = useState<OnboardingStopCode | null>(null);
    const [finished, setFinished] = useState<Finished | null>(null);
    const [lastPlan, setLastPlan] = useState<OnboardingPlan | null>(null);
    const [sawCert, setSawCert] = useState(false);
    const [cancelAsk, setCancelAsk] = useState(false);
    const [creatingGaveUp, setCreatingGaveUp] = useState(false);
    const [creatingResumed, setCreatingResumed] = useState(false);
    const [termsFailed, setTermsFailed] = useState(false);
    // 憑證建好後的再登入要用剛才的帳密：只放記憶體，用完或離開憑證流程就清掉。
    const [credentials, setCredentials] = useState<OnboardingStartRequest | null>(null);
    const [now, setNow] = useState(() => Date.now());

    // 這些值在 await 之後還要讀到最新的，不能依賴 render 當下的 state。
    const flag = useRef({
        busy: false,
        keyRequested: false,
        autoRelogin: false,
        autoTerms: false,
        // 使用者在這次掛載的登入畫面勾選了條款同意（重新整理後就沒有，條款要手動同意）。
        consented: false,
        destroyed: false,
    }).current;
    const statusRef = useRef<OnboardingStatus | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const noticeRef = useRef<HTMLParagraphElement>(null);
    const busyStep = useRef<OnboardingStep | null>(null);
    // 金鑰建立後、交給上層之前的內容；交出去或離開就清掉。
    const keysRef = useRef<{ keys: Keys | null; saveFailed: boolean } | null>(null);

    const step: OnboardingStep = finished ? 'done' : stopped ? 'stopped' : (status?.step ?? 'login');
    const purpose: OnboardingOtpPurpose = step === 'key_otp' ? 'key' : 'cert';
    const isBusy = busy !== '';
    const expiresAt = status && ACTIVE_STEPS.includes(status.step) ? status.expiresAt : null;
    const sessionExpired = expiresAt !== null && Date.parse(expiresAt) <= now;
    // 處理中不能取消：伺服器可能正在建立金鑰，Secret 只在那次回應裡。
    const canCancel = !isBusy && status !== null && ACTIVE_STEPS.includes(status.step);
    // 完成畫面確認剛綁定的帳戶是否已開通：每組結果只建一次，finish() 換掉 finished 時也不重查。
    const doneResult = finished?.result;
    const checkDoneReadiness = useMemo(
        () => (doneResult ? () => checkReadiness(doneResult.accountLabels, fetchAccounts) : undefined),
        [doneResult],
    );

    function commitStatus(next: OnboardingStatus | null) {
        statusRef.current = next;
        setStatus(next);
        setNow(Date.now());
    }

    function stopWith(code: OnboardingStopCode) {
        setStopped(code);
        commitStatus(null);
        setNotice('');
        setCancelAsk(false);
    }

    function applyStatus(next: OnboardingStatus, fromAction: boolean) {
        setNotice('');
        if (next.step === 'stopped') {
            stopWith(next.error && isOnboardingErrorCode(next.error.code) ? next.error.code : 'GENERIC');
            return;
        }
        // 後端不會回 done；真的收到就當作沒有進行中的流程。
        if (next.step === 'done') {
            commitStatus(null);
            return;
        }
        if (CERT_STEPS.includes(next.step)) setSawCert(true);
        commitStatus(next);
        // 200 回應也可能帶 error：同樣只顯示固定文字。
        if (fromAction && next.error && isOnboardingErrorCode(next.error.code)) handleCode(next.error.code);
    }

    function handleCode(code: OnboardingErrorCode) {
        const copy = ERROR_COPY[code];
        if (copy.kind === 'stop') {
            stopWith(code);
            return;
        }
        // 密碼錯誤時伺服器已結束連線，回到登入畫面。
        if (code === 'ONBOARDING_BAD_CREDENTIALS') commitStatus(null);
        if (code === 'ONBOARDING_OTP_EXPIRED' && statusRef.current)
            commitStatus({ ...statusRef.current, otp: null });
        setNotice(copy.message);
    }

    // 只讀進度、不重送任何動作；讀取失敗回 null。
    async function resync(): Promise<OnboardingStatus | null> {
        try {
            const next = await onboardingApi.status();
            applyStatus(next, false);
            return next;
        } catch {
            return null;
        }
    }

    async function handleError(error: unknown, kind: OnboardingStepAction['kind']) {
        const code = onboardingErrorCode(error);
        if (code === 'ONBOARDING_INVALID_STATE') {
            setNotice((await resync()) ? ERROR_COPY.ONBOARDING_INVALID_STATE.message : NOTICE_OFFLINE);
            return;
        }
        if (
            code === 'ONBOARDING_OTP_INVALID' ||
            code === 'ONBOARDING_OTP_EXPIRED' ||
            code === 'ONBOARDING_INVALID_REQUEST'
        ) {
            // session 可能還在（可更正再試），也可能已為了安全結束：先讀進度再提示。
            const next = await resync();
            if (!next) {
                setNotice(NOTICE_OFFLINE);
                return;
            }
            if (next.step === 'stopped') return;
            if (!ACTIVE_STEPS.includes(next.step)) {
                setNotice(code === 'ONBOARDING_OTP_INVALID' ? NOTICE_OTP_INVALID_ENDED : NOTICE_ENDED);
                return;
            }
            if (code === 'ONBOARDING_OTP_EXPIRED') commitStatus({ ...next, otp: null });
            setNotice(ERROR_COPY[code].message);
            return;
        }
        if (code) {
            handleCode(code);
            return;
        }
        // 沒有錯誤碼：不知道伺服器有沒有收到，只讀進度確認，絕不自動重送。
        const next = await resync();
        const loginKind = kind === 'start' || kind === 'relogin';
        const stillLogin = next !== null && (next.step === 'login' || next.step === 'relogin');
        setNotice(
            !next
                ? loginKind
                    ? NOTICE_LOGIN_UNSURE
                    : NOTICE_OFFLINE
                : loginKind && stillLogin
                  ? NOTICE_LOGIN_UNSURE
                  : NOTICE_RESYNCED,
        );
    }

    async function run(action: OnboardingStepAction, text: string): Promise<OnboardingStatus | null> {
        if (flag.busy) return null;
        flag.busy = true;
        setBusy(text);
        setNotice('');
        setCancelAsk(false);
        try {
            const next = await onboardingApi.step(action);
            applyStatus(next, true);
            return next;
        } catch (error) {
            await handleError(error, action.kind);
            return null;
        } finally {
            flag.busy = false;
            setBusy('');
        }
    }

    function resetFlow() {
        flag.keyRequested = false;
        flag.autoRelogin = false;
        flag.autoTerms = false;
        flag.consented = false;
        keysRef.current = null;
        setLastPlan(null);
        setSawCert(false);
        setCreatingGaveUp(false);
        setCreatingResumed(false);
        setTermsFailed(false);
        setCredentials(null);
    }

    function restart() {
        resetFlow();
        setStopped(null);
        setFinished(null);
        commitStatus(null);
        setNotice('');
        setCancelAsk(false);
    }

    function leave() {
        if (flag.busy) return;
        if (statusRef.current && ACTIVE_STEPS.includes(statusRef.current.step)) onboardingApi.cancelQuietly();
        restart();
    }

    async function submitLogin(body: OnboardingStartRequest) {
        resetFlow();
        flag.consented = true; // LoginStep 只在勾選同意後才送出
        const next = await run({ kind: 'start', body }, '正在連線到永豐金證券…');
        if (next && CERT_STEPS.includes(next.step)) setCredentials(body);
    }
    const submitRelogin = (body: OnboardingStartRequest) =>
        run({ kind: 'relogin', body }, '正在重新登入…');
    const submitBirthday = (birthday: string) => void run({ kind: 'birthday', body: { birthday } }, '正在送出生日…');
    const sendOtp = (p: OnboardingOtpPurpose, channel: OnboardingOtpChannel, targetIndex: number) =>
        void run({ kind: 'otpSend', body: { purpose: p, channel, targetIndex } }, '正在請永豐金證券寄出驗證碼…');
    const acceptTerms = () =>
        run({ kind: 'terms', body: { accepted: true } }, '正在同意憑證作業條款並建立憑證…');
    function submitPlan(plan: OnboardingPlan) {
        setLastPlan(plan);
        void run({ kind: 'plan', body: plan }, '正在前往身分驗證…');
    }

    async function verifyOtp(p: OnboardingOtpPurpose, code: string) {
        const next = await run({ kind: 'otpVerify', body: { purpose: p, code } }, '正在驗證…');
        // 回應遺失但重新讀取後已在 creating 時也要補送；keyRequested 擋重複建立。
        const reachedCreating =
            next?.step === 'creating' || (next === null && statusRef.current?.step === 'creating');
        if (p === 'key' && reachedCreating) await createKey();
    }

    // 建立金鑰的請求只送一次，失敗也不自動重送。
    async function createKey() {
        if (flag.busy || flag.keyRequested || flag.destroyed) return;
        flag.keyRequested = true;
        flag.busy = true;
        setBusy('正在建立 API Key…');
        setNotice('');
        try {
            // 只有桌面版要用金鑰啟動伺服器；網頁版由開發伺服器寫進 .env，Secret 不必經過瀏覽器。
            const { result, revealed, envPath } = await onboardingApi.createKey({ revealSecret: isTauri });
            if (flag.destroyed) return;
            if (isTauri && !revealed) {
                stopWith('ONBOARDING_KEY_CAPTURE_FAILED');
                return;
            }
            // 伺服器已存進 .env：畫面不顯示 Secret，只留給上層。
            keysRef.current = { keys: revealed, saveFailed: false };
            setFinished({ result, revealed: null, saveFailed: false, savedPath: envPath });
            commitStatus(null);
        } catch (error) {
            if (flag.destroyed) return;
            const code = onboardingErrorCode(error);
            const salvage = error instanceof OnboardingApiError ? error.salvage : null;
            if (salvage?.revealed) {
                // 已建立但存檔失敗：Secret 只剩這一次機會，顯示讓使用者複製。
                keysRef.current = { keys: salvage.revealed, saveFailed: true };
                setFinished({ result: salvage.result, revealed: salvage.revealed, saveFailed: true });
                commitStatus(null);
            } else if (code === 'ONBOARDING_INVALID_STATE') {
                await handleError(error, 'plan');
            } else if (code) {
                stopWith(code);
            } else {
                // 沒有錯誤碼：斷線不會中止伺服器上的建立，先等它離開 creating 再下結論（不重送）。
                const ended = await waitOutCreating();
                if (flag.destroyed) return;
                stopWith('KEY_UNSURE');
                // 等不到結果時伺服器 session 可能還在：盡力取消，免得重新開始被擋。
                if (!ended) onboardingApi.cancelQuietly();
            }
        } finally {
            flag.busy = false;
            setBusy('');
        }
    }

    // 只讀進度：伺服器離開 creating 回 true；建立請求根本沒送達或等到上限回 false。
    async function waitOutCreating(): Promise<boolean> {
        for (let i = 0; i < CREATING_POLL_MAX; i++) {
            await new Promise((resolve) => setTimeout(resolve, CREATING_POLL_MS));
            if (flag.destroyed) return false;
            try {
                const next = await onboardingApi.status();
                if (next.step !== 'creating') return true;
                if (next.keyRequested === false) return false;
            } catch {
                // 單次失敗不中止，受次數上限限制。
            }
        }
        return false;
    }

    async function pollCreating() {
        for (let i = 0; i < CREATING_POLL_MAX; i++) {
            await new Promise((resolve) => setTimeout(resolve, CREATING_POLL_MS));
            if (flag.destroyed || statusRef.current?.step !== 'creating' || flag.busy) return;
            try {
                const next = await onboardingApi.status();
                // 等回應期間使用者可能已取消或開始別的動作：晚到的進度不採用。
                if (flag.destroyed || flag.busy || statusRef.current?.step !== 'creating') return;
                applyStatus(next, false);
                if (next.step === 'login') {
                    setNotice(NOTICE_CREATE_ENDED);
                    return;
                }
            } catch {
                // 單次失敗不中止，受次數上限限制。
            }
        }
        if (!flag.destroyed && statusRef.current?.step === 'creating') setCreatingGaveUp(true);
    }

    async function finish() {
        const handoff = keysRef.current;
        if (!handoff) throw new Error('KEYS_UNAVAILABLE');
        await onKeysReady(handoff.keys, { saveFailed: handoff.saveFailed });
        keysRef.current = null;
        // 只收起 Secret；saveFailed 保留，完成畫面才不會改口說「不需要你複製」。
        setFinished((current) => current && { ...current, revealed: null });
    }

    // 讀不到進度就是沒有後端（打包版或沒有外掛的伺服器），改顯示說明。
    useEffect(() => {
        flag.destroyed = false;
        let mounted = true; // StrictMode 會先卸載再掛載，只採用最後一次的結果
        onboardingApi.status().then(
            (next) => {
                if (!mounted) return;
                applyStatus(next, false);
                setProbe('ready');
                // 還原到 creating：建立請求可能已送出，不重送、只等候結果；伺服器明確說還沒送出（驗證碼的回應在送出前遺失）才送第一次。
                if (next.step === 'creating') {
                    if (next.keyRequested === false) {
                        void createKey();
                        return;
                    }
                    setCreatingResumed(true);
                    void pollCreating();
                }
            },
            () => {
                if (mounted) setProbe('unavailable');
            },
        );
        return () => {
            mounted = false;
            flag.destroyed = true;
            if (hotDisposed) return; // 熱更新會馬上重新掛載同一個畫面
            keysRef.current = null;
            const live = statusRef.current;
            if (flag.busy || (live && ACTIVE_STEPS.includes(live.step))) onboardingApi.cancelQuietly();
        };
    }, []);

    const active = status !== null;
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);

    // 連線只保留 10 分鐘：到期就在畫面上收掉。
    useEffect(() => {
        if (sessionExpired && !isBusy) stopWith('ONBOARDING_SESSION_EXPIRED');
    }, [sessionExpired, isBusy]);

    useEffect(() => {
        if (credentials && !CERT_STEPS.includes(step)) setCredentials(null);
    }, [credentials, step]);

    useEffect(() => {
        if (step !== 'relogin' || !credentials || isBusy || cancelAsk || flag.autoRelogin) return;
        flag.autoRelogin = true;
        void submitRelogin(credentials).finally(() => setCredentials(null));
    }, [step, credentials, isBusy, cancelAsk]);

    // 登入畫面已告知並取得授權：這次掛載勾過同意、且頁面條款和登入畫面顯示的一致時才自動同意一次，否則或失敗就手動。
    const manualTerms = termsFailed || !flag.consented || !matchesTwcaTerms(status?.termsText ?? null);
    useEffect(() => {
        if (step !== 'terms' || manualTerms || isBusy || cancelAsk || flag.autoTerms) return;
        flag.autoTerms = true;
        void acceptTerms().then((next) => {
            if (!next || next.step === 'terms') setTermsFailed(true);
        });
    }, [step, manualTerms, isBusy, cancelAsk]);

    // 錯誤出現時捲進可視範圍；處理結束後，同一步驟內把焦點放回錯誤訊息或主要控制項（換步驟時由新步驟自己取得焦點）。
    useEffect(() => {
        if (notice) noticeRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, [notice]);
    useEffect(() => {
        if (isBusy) {
            busyStep.current = step;
            return;
        }
        const from = busyStep.current;
        busyStep.current = null;
        const root = rootRef.current;
        if (from !== step || !root || root.closest('[hidden]')) return;
        if (noticeRef.current) return noticeRef.current.focus({ preventScroll: true });
        const held = document.activeElement;
        if (held && held !== document.body && (!root.contains(held) || !(held as HTMLInputElement).disabled)) return;
        root.querySelector<HTMLElement>('[data-primary], button[type="submit"]')?.focus({ preventScroll: true });
    }, [isBusy]);

    // creating 起不播：永豐金證券的成功視窗會顯示 Secret Key（伺服器端也同樣不給畫面）。
    const onSite = ACTIVE_STEPS.includes(step) && step !== 'creating';
    const browser: BrowserActivity = isBusy && (onSite || step === 'login') ? 'working' : onSite ? 'waiting' : 'off';
    useEffect(() => onBrowserChange?.(browser), [browser]);

    if (probe === 'unavailable')
        return (
            <p className={styles.unavailable} role="status">
                {UNAVAILABLE_NOTICE}
            </p>
        );

    function renderStep(): ReactNode {
        if (probe === 'checking') return <Skeleton />;
        switch (step) {
            case 'login':
                return <LoginStep busy={isBusy} onSubmit={submitLogin} onManual={() => stopWith('MANUAL')} />;
            case 'birthday':
                return <BirthdayStep busy={isBusy} onSubmit={submitBirthday} />;
            case 'cert_otp':
            case 'key_otp':
                return (
                    <OtpStep
                        key={step}
                        purpose={purpose}
                        targets={status?.otpTargets ?? []}
                        otp={status?.otp ?? null}
                        now={now}
                        busy={isBusy}
                        onSend={(channel, targetIndex) => sendOtp(purpose, channel, targetIndex)}
                        onVerify={(code) => void verifyOtp(purpose, code)}
                    />
                );
            case 'terms':
                return manualTerms ? (
                    <TermsStep
                        termsText={status?.termsText ?? null}
                        busy={isBusy}
                        onSubmit={() => void acceptTerms()}
                    />
                ) : (
                    <StepHeader
                        step='terms'
                        Icon={ScrollText}
                        title='憑證作業條款'
                        lead='依你的授權，系統正在代你同意條款並建立憑證，不需要操作。'
                    />
                );
            case 'relogin':
                return credentials ? (
                    <StepHeader
                        step='relogin'
                        Icon={LogIn}
                        title='憑證建好了，自動重新登入'
                        lead='系統正在用剛才輸入的帳號密碼重新登入，不需要再輸入。'
                    />
                ) : (
                    <LoginStep relogin busy={isBusy} onSubmit={submitRelogin} />
                );
            case 'plan':
                return <PlanStep busy={isBusy} onSubmit={submitPlan} />;
            case 'creating':
                return (
                    <CreatingStep
                        resumed={creatingResumed}
                        gaveUp={creatingGaveUp}
                        onCancel={() => setCancelAsk(true)}
                    />
                );
            case 'done':
                return (
                    finished && (
                        <DoneStep
                            result={finished.result}
                            revealed={finished.revealed}
                            saveFailed={finished.saveFailed}
                            savedPath={finished.savedPath}
                            onFinish={finish}
                            onLockedChange={onLockedChange}
                            checkReadiness={checkDoneReadiness}
                        />
                    )
                );
            case 'stopped':
                return (
                    stopped && (
                        <StoppedStep
                            code={stopped}
                            plan={lastPlan ?? planFromForm(createPlanForm())}
                            keyName={lastPlan?.name ?? null}
                            onRestart={restart}
                            onClose={onUseApiKey}
                        />
                    )
                );
        }
    }

    const inFlow = status !== null && ACTIVE_STEPS.includes(status.step);
    const statusText = probe === 'checking' ? '正在讀取目前的進度…' : busy;

    return (
        <div className={styles.root} ref={rootRef} aria-busy={statusText !== ''}>
            <div className={styles.content}>
                {probe === 'ready' && <FlowStepper step={step} sawCert={sawCert} />}
                {renderStep()}
            </div>
            {notice && (
                <p ref={noticeRef} className={styles.notice} role='alert' tabIndex={-1}>
                    {notice}
                </p>
            )}
            {statusText && (
                <p className={styles.status} role='status'>
                    <LoaderCircle className={stepStyles.spinner} size={16} aria-hidden='true' />
                    {statusText}
                </p>
            )}
            {probe === 'ready' && inFlow && (
                <div className={styles.footer}>
                    {cancelAsk && canCancel ? (
                        <div className={styles.confirm}>
                            <span>
                                要取消申請嗎？進行中的連線會關閉，已輸入的資料會清除。
                                {step === 'creating' && '金鑰可能已經建立，取消後 Secret Key 無法取回。'}
                            </span>
                            <button type='button' className={styles.secondaryBtn} onClick={leave}>
                                取消申請
                            </button>
                            <button type='button' className={styles.secondaryBtn} onClick={() => setCancelAsk(false)}>
                                繼續
                            </button>
                        </div>
                    ) : (
                        canCancel && (
                            <button type='button' className={styles.secondaryBtn} onClick={() => setCancelAsk(true)}>
                                取消申請
                            </button>
                        )
                    )}
                </div>
            )}
        </div>
    );
}
