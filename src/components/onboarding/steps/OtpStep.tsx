import { ShieldCheck } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type {
    OnboardingOtpChannel,
    OnboardingOtpPurpose,
    OnboardingOtpTarget,
    OnboardingStatus,
} from '../../../lib/sinopac-onboarding/types';
import { autofocus } from './focus';
import { BusyLabel, StepHeader } from './step-header';
import * as styles from './steps-a.css';

export interface OtpStepProps {
    purpose: OnboardingOtpPurpose;
    /** 從永豐金證券頁面即時讀到的收碼選項（已遮罩），不寫死。 */
    targets: OnboardingOtpTarget[];
    otp: OnboardingStatus['otp'];
    /** 父層每秒更新的時間（毫秒），倒數由伺服器給的 expiresAt 推算。 */
    now: number;
    busy: boolean;
    onSend: (channel: OnboardingOtpChannel, targetIndex: number) => void;
    onVerify: (code: string) => void;
}

const CHANNEL_NAMES: Record<OnboardingOtpChannel, string> = {
    sms: '手機簡訊',
    email: 'Email',
};
const CHANNEL_ORDER: readonly OnboardingOtpChannel[] = ['sms', 'email'];

function clock(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

// 父層切換 cert_otp / key_otp 時要用 key={purpose} 重新掛載，避免上一階段選的管道與輸入殘留。
export function OtpStep({ purpose, targets, otp, now, busy, onSend, onVerify }: OtpStepProps) {
    const uid = useId();
    const [pickedChannel, setPickedChannel] = useState<OnboardingOtpChannel | null>(null);
    const [pickedIndex, setPickedIndex] = useState<number | null>(null);
    const [code, setCode] = useState('');
    const [codeError, setCodeError] = useState('');

    const active = otp && otp.purpose === purpose ? otp : null;
    const leftSeconds = active
        ? Math.max(0, Math.ceil((Date.parse(active.expiresAt) - now) / 1000)) || 0
        : 0;
    const counting = active !== null && leftSeconds > 0;
    const expired = active !== null && leftSeconds === 0;
    const channels = CHANNEL_ORDER.filter((option) =>
        targets.some((target) => target.channel === option),
    );
    // 倒數期間永豐金證券不允許重寄或改管道，所以鎖定在已寄出的那一組。
    const channel =
        active && counting
            ? active.channel
            : pickedChannel && channels.includes(pickedChannel)
                ? pickedChannel
                : (channels[0] ?? null);
    const channelTargets = targets.filter((target) => target.channel === channel);
    const targetIndex =
        active && counting
            ? active.targetIndex
            : channelTargets.some((target) => target.index === pickedIndex)
                ? pickedIndex
                : (channelTargets[0]?.index ?? null);

    function send() {
        if (busy || channel === null || targetIndex === null) return;
        setCode('');
        setCodeError('');
        onSend(channel, targetIndex);
    }

    function verify(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || !counting) return;
        // UNVERIFIED: 永豐金證券驗證碼的位數與字元集未實際觀察過（原型假設 6 位數字）。
        // 驗證規則與後端一致（4 到 12 個英數字），避免前端比後端更嚴格而擋住第一次真實執行。
        const value = code.trim();
        if (!/^[0-9A-Za-z]{4,12}$/.test(value)) {
            setCodeError('請輸入簡訊或 Email 收到的驗證碼。');
            return;
        }
        setCodeError('');
        setCode('');
        onVerify(value);
    }

    const codeFieldId = `${uid}-otp`;
    const targetFieldId = `${uid}-target`;

    return (
        <div className={styles.form}>
            <StepHeader
                step={purpose === 'key' ? 'key_otp' : 'cert_otp'}
                Icon={ShieldCheck}
                title={purpose === 'key' ? 'API 金鑰申請驗證' : '輸入驗證碼'}
                lead={
                    purpose === 'key'
                        ? '為了安全，建立 API Key 前永豐金證券會要求再驗證一次。驗證碼一律由你本人輸入。'
                        : '永豐金證券會寄一組驗證碼，用來建立網頁憑證。驗證碼一律由你本人輸入。'
                }
            />

            {channels.length === 0 ? (
                <p className={styles.alertBox} role='alert'>
                    沒有讀到可用的收碼方式。請取消後重新開始，或改在永豐金證券官網自己完成。
                </p>
            ) : (
                <>
                    <fieldset className={styles.channelList} disabled={counting || busy}>
                        <legend className={styles.legend}>驗證碼收取方式</legend>
                        {channels.map((option) => (
                            <label
                                key={option}
                                className={`${channel === option ? styles.channelOptionActive : styles.channelOption}${counting ? ` ${styles.channelLocked}` : ''}`}
                            >
                                <input
                                    type='radio'
                                    name={`${uid}-channel`}
                                    className={styles.choiceInput}
                                    value={option}
                                    checked={channel === option}
                                    onChange={() => {
                                        setPickedChannel(option);
                                        setPickedIndex(null);
                                    }}
                                />
                                <span className={styles.channelName}>{CHANNEL_NAMES[option]}</span>
                            </label>
                        ))}
                    </fieldset>

                    <div className={styles.field}>
                        <label className={styles.label} htmlFor={targetFieldId}>
                            收碼的{channel === 'email' ? '信箱' : '手機號碼'}
                        </label>
                        <select
                            id={targetFieldId}
                            className={styles.select}
                            disabled={counting || busy}
                            value={targetIndex ?? ''}
                            onChange={(event) => setPickedIndex(Number(event.target.value))}
                        >
                            {channelTargets.map((target) => (
                                <option key={target.index} value={target.index}>
                                    {target.masked}
                                </option>
                            ))}
                        </select>
                    </div>

                    {counting ? (
                        <>
                            <div className={styles.countdown}>
                                <span id={`${codeFieldId}-sent`}>驗證碼已寄出，請在時間內輸入。</span>
                                <span>
                                    剩餘{' '}
                                    <b className={styles.countdownTime} role='timer' aria-live='off'>
                                        {clock(leftSeconds)}
                                    </b>
                                </span>
                            </div>
                            <form
                                className={styles.form}
                                autoComplete='off'
                                noValidate
                                aria-busy={busy}
                                onSubmit={verify}
                            >
                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor={codeFieldId}>
                                        驗證碼
                                    </label>
                                    <input
                                        id={codeFieldId}
                                        ref={autofocus}
                                        className={styles.otpInput}
                                        name='sinopac-onboarding-otp'
                                        inputMode='numeric'
                                        maxLength={12}
                                        autoComplete='one-time-code'
                                        placeholder='••••••'
                                        data-1p-ignore
                                        aria-required='true'
                                        aria-invalid={codeError ? true : undefined}
                                        aria-describedby={`${codeFieldId}-sent${codeError ? ` ${codeFieldId}-error` : ''}`}
                                        readOnly={busy}
                                        value={code}
                                        onChange={(event) => setCode(event.target.value)}
                                    />
                                    {codeError && (
                                        <p id={`${codeFieldId}-error`} className={styles.fieldError} role='alert'>
                                            {codeError}
                                        </p>
                                    )}
                                </div>
                                <button type='submit' className={styles.primaryBtn} data-primary aria-disabled={busy}>
                                    <BusyLabel busy={busy}>確認驗證碼</BusyLabel>
                                </button>
                                <p className={styles.hint}>
                                    永豐金證券在倒數期間不允許重寄或改用其他管道，過期後才能重新寄送。
                                </p>
                            </form>
                        </>
                    ) : (
                        <>
                            {expired && (
                                <p className={styles.warnBox} role='alert'>
                                    <b>驗證碼已過期。</b>請重新寄送一組。
                                </p>
                            )}
                            <button
                                type='button'
                                ref={autofocus}
                                className={styles.primaryBtn}
                                data-primary
                                disabled={targetIndex === null}
                                aria-disabled={busy || targetIndex === null}
                                onClick={send}
                            >
                                <BusyLabel busy={busy}>{expired ? '重新寄送驗證碼' : '寄送驗證碼'}</BusyLabel>
                            </button>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
