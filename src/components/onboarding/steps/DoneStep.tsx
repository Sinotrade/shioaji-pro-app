// 完成步驟：寫入成功只顯示路徑；存檔失敗才一次性顯示 Secret Key，確認已保存之前不能離開。
// 帳戶是否已開通 API 下單由 checkReadiness 確認，確定還沒開通才列出簽署與模擬測試。
import { CircleCheckBig, Copy, Download, Eye, EyeOff, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SIGNING_URLS } from '../../../lib/account-signing';
import { permissionLabels } from '../../../lib/sinopac-onboarding/plan';
import type { Readiness } from '../../../lib/sinopac-onboarding/readiness';
import type { OnboardingResult } from '../../../lib/sinopac-onboarding/types';
import { ExternalLink } from '../../external-link';
import { StepHeading } from './step-heading';
import * as s from './steps-b.css';

const SECRET_UNSAVED_NOTICE =
    'Secret Key 只會顯示這一次，請先勾選「我已經複製並安全保存」再繼續。';
const FINISH_FAILED_NOTICE =
    '沒有完成。金鑰仍保留在這個畫面，請確認已保存後再試一次。';
const COPY_FAILED_NOTICE = '瀏覽器不允許自動複製，請按眼睛顯示金鑰後，手動選取並複製。';
const MASK = '•'.repeat(44);
const REVOKE_DELAY_MS = 1000;

const ROWS = [
    { field: 'apiKey', label: 'API Key', variable: 'SJ_API_KEY' },
    { field: 'secretKey', label: 'Secret Key', variable: 'SJ_SEC_KEY' },
] as const;
type Field = (typeof ROWS)[number]['field'];

/**
 * 鎖定期間攔下重新整理（beforeunload）；full 時另外攔 Esc 與瀏覽器上一頁，並呼叫 onBlocked 讓畫面顯示原因。
 * 原生 <dialog> 的 Esc 是 keydown 的預設動作，所以在 capture 階段就取消它。
 */
export function useLeaveGuard(locked: boolean, onBlocked: () => void, full = true) {
    const notify = useRef(onBlocked);
    useEffect(() => {
        notify.current = onBlocked;
    });
    useEffect(() => {
        if (!locked || typeof window === 'undefined') return;
        const onUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', onUnload);
        if (!full) return () => window.removeEventListener('beforeunload', onUnload);

        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            // 只 preventDefault：App 的 Esc-Esc 全刪單快捷鍵靠 defaultPrevented 判斷這下 Esc 已被用掉，不能整個吞掉事件。
            event.preventDefault();
            notify.current();
        };
        // 上一頁會卸載整個畫面：先墊一筆歷史紀錄，讓上一頁只吃掉它。
        const pushGuardEntry = () => window.history.pushState({ sinopacSecret: true }, '');
        const onPop = () => {
            pushGuardEntry();
            notify.current();
        };
        const state = window.history.state as { sinopacSecret?: boolean } | null;
        if (!state?.sinopacSecret) pushGuardEntry();
        window.addEventListener('keydown', onKey, { capture: true });
        window.addEventListener('popstate', onPop);
        return () => {
            window.removeEventListener('beforeunload', onUnload);
            window.removeEventListener('keydown', onKey, { capture: true });
            window.removeEventListener('popstate', onPop);
        };
    }, [locked, full]);
}

export interface DoneStepProps {
    result: OnboardingResult;
    /** 只在使用者選擇顯示時才有；只存在這個元件與父層的記憶體，不寫入任何儲存空間。 */
    revealed: { apiKey: string; secretKey: string } | null;
    /** 金鑰已在永豐金證券建立，但父層沒能儲存：使用者必須自己複製。 */
    saveFailed?: boolean;
    /** 金鑰已寫入的 .env 絕對路徑（後端回報）；saveFailed 時不會顯示。 */
    savedPath?: string;
    /** 使用者確認已保存並按下進入。回傳 Promise 時會等它；reject 則金鑰與防護都留在畫面上。 */
    onFinish: () => void | Promise<void>;
    /** 鎖定中（有金鑰且尚未確認已保存）為 true，父層用它擋自己的關閉鈕與對話框。 */
    onLockedChange?: (locked: boolean) => void;
    /** 確認帳戶是否已開通 API 下單；掛載時只跑一次。沒有提供時直接顯示「無法確認」。 */
    checkReadiness?: () => Promise<Readiness>;
}

export function DoneStep({ result, revealed, saveFailed = false, savedPath, onFinish, onLockedChange, checkReadiness }: DoneStepProps) {
    const [shown, setShown] = useState<Record<Field, boolean>>({ apiKey: false, secretKey: false });
    const [copied, setCopied] = useState<Field | 'env' | null>(null);
    const [copyFailed, setCopyFailed] = useState(false);
    const [saved, setSaved] = useState(false);
    const [blocked, setBlocked] = useState(false);
    const [pending, setPending] = useState(false);
    const [finished, setFinished] = useState(false);
    const [finishFailed, setFinishFailed] = useState(false);
    const [readiness, setReadiness] = useState<Readiness | { kind: 'checking' }>(
        checkReadiness ? { kind: 'checking' } : { kind: 'unknown' },
    );
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const locked = Boolean(revealed) && !saved;
    useLeaveGuard(locked, () => setBlocked(true));

    const report = useRef(onLockedChange);
    useEffect(() => {
        report.current = onLockedChange;
    });
    useEffect(() => {
        report.current?.(locked);
    }, [locked]);
    useEffect(
        () => () => {
            clearTimeout(timer.current);
            report.current?.(false);
        },
        [],
    );

    // 只在掛載時確認一次；卸載後才回來的結果直接丟掉，失敗一律當作無法確認。
    useEffect(() => {
        if (!checkReadiness) return;
        let alive = true;
        void checkReadiness().then(
            (next) => {
                if (alive) setReadiness(next);
            },
            () => {
                if (alive) setReadiness({ kind: 'unknown' });
            },
        );
        return () => {
            alive = false;
        };
    }, []);

    // 只在使用者按下按鈕時才組出 .env 的兩行。
    const envText = () => (revealed ? ROWS.map((row) => `${row.variable}=${revealed[row.field]}\n`).join('') : '');

    async function copy(field: Field | 'env') {
        if (!revealed) return;
        try {
            await navigator.clipboard.writeText(field === 'env' ? envText() : revealed[field]);
            setCopyFailed(false);
            setCopied(field);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(null), 2000);
        } catch {
            setCopyFailed(true);
        }
    }

    function downloadEnv() {
        if (!revealed) return;
        const url = URL.createObjectURL(new Blob([envText()], { type: 'text/plain' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = '.env';
        link.click();
        // 稍後再 revoke：立刻 revoke 在部分 WebKit 會讓下載失敗。
        setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    }

    async function finish() {
        if (locked || pending || finished) return;
        setPending(true);
        setFinishFailed(false);
        try {
            await onFinish();
            setFinished(true);
        } catch {
            // 不顯示例外原文；重新上鎖，確保金鑰在使用者再次確認前不會被關掉。
            setFinishFailed(true);
            setSaved(false);
        } finally {
            setPending(false);
        }
    }

    const notice = finishFailed
        ? FINISH_FAILED_NOTICE
        : locked && blocked
            ? SECRET_UNSAVED_NOTICE
            : locked
                ? '勾選上面的確認後才能進入。'
                : '';
    const noticeIsAlert = finishFailed || (locked && blocked);

    return (
        <div className={s.root}>
            <StepHeading
                icon={saveFailed ? TriangleAlert : CircleCheckBig}
                tone={saveFailed ? 'warn' : 'ok'}
                title={saveFailed ? '金鑰已建立，但沒有儲存' : 'API Key 申請成功'}
            >
                <p className={s.lead}>
                    {saveFailed
                        ? 'API Key 已在永豐金證券建立，但無法寫入本機設定。下面是唯一一次顯示 Secret Key 的機會，請立即複製。'
                        : revealed
                            ? 'API Key 已建立並寫入本機設定。下面是唯一一次顯示 Secret Key 的機會。'
                            : 'API Key 已建立。Secret Key 不會顯示在畫面上，也不需要你複製。'}
                </p>
            </StepHeading>

            {!saveFailed && savedPath && (
                <p className={s.banner.ok}>
                    <CircleCheckBig size={16} aria-hidden='true' />
                    <span>
                        已寫入 <code className={s.mono}>{savedPath}</code>
                    </span>
                </p>
            )}

            {revealed && (
                <section className={s.secretPanel} aria-label='金鑰（只顯示一次）'>
                    <p className={s.panelWarning} role='alert'>
                        這是唯一一次看到 Secret Key。關閉或重新整理後就無法再取得；沒保存的話，只能到永豐金證券刪除這組金鑰再重新建立。
                    </p>
                    {ROWS.map((row) => {
                        const visible = shown[row.field];
                        return (
                            <div key={row.field} className={s.keyRow}>
                                <div className={s.keyHead}>
                                    <span className={s.label}>{row.label}</span>
                                    <code className={s.varName}>{row.variable}</code>
                                </div>
                                <code
                                    className={s.keyValue[visible ? 'shown' : 'masked']}
                                    aria-label={visible ? undefined : `${row.label}（已隱藏）`}
                                >
                                    {visible ? revealed[row.field] : MASK}
                                </code>
                                <div className={s.keyActions}>
                                    <button
                                        type='button'
                                        className={s.btn.compact}
                                        aria-label={`${visible ? '隱藏' : '顯示'} ${row.label}`}
                                        aria-pressed={visible}
                                        onClick={() => setShown((current) => ({ ...current, [row.field]: !current[row.field] }))}
                                    >
                                        {visible ? <EyeOff size={16} aria-hidden='true' /> : <Eye size={16} aria-hidden='true' />}
                                    </button>
                                    <button
                                        type='button'
                                        className={`${s.btn.compact} ${s.copyBtn}`}
                                        aria-label={`複製 ${row.label}`}
                                        onClick={() => void copy(row.field)}
                                    >
                                        <Copy size={15} aria-hidden='true' />
                                        {copied === row.field ? '已複製' : '複製'}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    {saveFailed && (
                        <>
                            <div className={s.chipRow}>
                                <button type='button' className={s.btn.compact} onClick={() => void copy('env')}>
                                    <Copy size={15} aria-hidden='true' />
                                    {copied === 'env' ? '已複製 .env 兩行' : '複製成 .env 兩行'}
                                </button>
                                <button type='button' className={s.btn.compact} onClick={downloadEnv}>
                                    <Download size={15} aria-hidden='true' />
                                    下載 .env 檔
                                </button>
                            </div>
                            <p className={s.hint}>.env 內含 Secret Key。放進專案資料夾後，請刪除下載的檔案，並清空剪貼簿。</p>
                        </>
                    )}
                    <span className={s.srOnly} role='status'>
                        {copied ? `已複製 ${ROWS.find((row) => row.field === copied)?.label ?? '.env 兩行'}` : ''}
                    </span>
                    {copyFailed && (
                        <p className={s.fieldError} role='alert'>
                            {COPY_FAILED_NOTICE}
                        </p>
                    )}
                    <label className={s.checkRow}>
                        <input
                            type='checkbox'
                            className={s.control}
                            checked={saved}
                            disabled={pending}
                            onChange={(event) => {
                                setSaved(event.target.checked);
                                setBlocked(false);
                                setFinishFailed(false);
                            }}
                        />
                        我已經複製並安全保存這兩個值
                    </label>
                </section>
            )}

            <dl className={s.summary}>
                <dt>API Key</dt>
                <dd className={s.mono}>••••••••{result.apiKeyLast4}</dd>
                <dt>到期日</dt>
                <dd>{result.expiresOn}</dd>
                <dt>權限</dt>
                <dd>{permissionLabels(result.permissions).join('、')}</dd>
                <dt>帳戶</dt>
                <dd>
                    {result.accountLabels.length > 0 ? (
                        <ul className={s.plainList}>
                            {result.accountLabels.map((label) => (
                                <li key={label}>{label}</li>
                            ))}
                        </ul>
                    ) : (
                        '永豐金證券表單沒有回報已勾選的帳戶'
                    )}
                </dd>
            </dl>

            {saveFailed && (
                <>
                    <h4 className={s.sectionTitle}>接下來要做的事</h4>
                    <ul className={s.list}>
                        <li>
                            用「複製成 .env 兩行」或「下載 .env 檔」把兩個值放進專案資料夾的 .env，或之後填進「API Key 登入」分頁。
                        </li>
                    </ul>
                </>
            )}

            {readiness.kind === 'checking' && (
                <p className={s.hint} role='status'>
                    正在確認帳戶是否已開通 API 下單…
                </p>
            )}
            {readiness.kind === 'ready' && (
                <p className={s.banner.ok}>
                    <CircleCheckBig size={16} aria-hidden='true' />
                    <span>帳戶已開通 API 下單，正式環境可以使用。</span>
                </p>
            )}
            {readiness.kind === 'pending' && (
                <>
                    <h4 className={s.sectionTitle}>還有帳戶尚未開通</h4>
                    <ul className={s.list}>
                        {readiness.items.map(({ product, label }) => {
                            const signing = SIGNING_URLS[product === 'stock' ? 'S' : 'F'];
                            return (
                                <li key={label}>
                                    {label}：請先簽署
                                    <ExternalLink className={s.link} href={signing.url}>
                                        {signing.label}
                                    </ExternalLink>
                                    ，再完成模擬登入與下單測試（週一至週五 08:00 到 20:00）。完成後正式環境才能使用。
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
            {readiness.kind === 'unknown' && (
                <p className={s.hint}>
                    目前無法確認帳戶是否已開通。進入 Shioaji Pro 後，可在右上角「伺服器」面板按「檢查目前帳戶／CA」確認；顯示未簽署時，再簽署 API 約定書並完成模擬下單測試。
                </p>
            )}

            <div className={s.actions}>
                <button
                    type='button'
                    className={s.btn.primary}
                    disabled={locked || pending || finished}
                    aria-busy={pending}
                    onClick={() => void finish()}
                >
                    進入 Shioaji Pro
                </button>
                {(revealed || notice) && (
                    <p className={`${s.notice} ${noticeIsAlert ? s.noticeAlert : ''}`} role='status'>
                        {notice}
                    </p>
                )}
            </div>
        </div>
    );
}
