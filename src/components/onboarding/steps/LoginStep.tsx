import { Eye, EyeOff, Lock, LogIn, UserCheck } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import {
    isTaiwanIdFormat,
    type OnboardingStartRequest,
} from '../../../lib/sinopac-onboarding/types';
import { TWCA_TERMS } from '../../../lib/sinopac-onboarding/twca-terms';
import { ExternalLink } from '../../external-link';
import { useAutofocusRef } from './focus';
import * as styles from './steps-a.css';
import { BusyLabel, StepHeader } from './step-header';

const TWCA_CPS_URL = 'https://www.twca.com.tw/repository';

export interface LoginStepProps {
    /** 憑證建立後永豐金證券的登入框是空的：精靈會自動帶入剛才的帳密；只有帳密已不在記憶體時才顯示這個表單。 */
    relogin?: boolean;
    busy: boolean;
    onSubmit: (body: OnboardingStartRequest) => void;
    onManual?: () => void;
}

interface FieldErrors {
    idNumber?: string;
    password?: string;
    consent?: string;
}

const CONSENT_REQUIRED = '請先勾選「我已閱讀並同意憑證作業條款」。';

export function LoginStep({ relogin = false, busy, onSubmit, onManual }: LoginStepProps) {
    const uid = useId();
    const idFieldId = `${uid}-id`;
    const passwordFieldId = `${uid}-password`;
    const consentId = `${uid}-consent`;
    const termsId = `${uid}-terms`;
    const consentFieldId = `${uid}-agree`;
    const [termsOpen, setTermsOpen] = useState(false);
    // 這個勾選就是使用者的同意；精靈到憑證步驟時才依此在永豐金證券的視窗代為勾選同一個選項。
    const [agreed, setAgreed] = useState(false);
    const consentInput = useRef<HTMLInputElement>(null);
    const [idNumber, setIdNumber] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [errors, setErrors] = useState<FieldErrors>({});
    const idInput = useAutofocusRef<HTMLInputElement>();
    const passwordInput = useRef<HTMLInputElement>(null);

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const next: FieldErrors = {};
        if (!isTaiwanIdFormat(idNumber))
            next.idNumber = '身分證字號格式不正確，應為 1 個英文字母加 9 位數字。';
        if (!password) next.password = '請輸入密碼。';
        if (!relogin && !agreed) next.consent = CONSENT_REQUIRED;
        setErrors(next);
        if (next.idNumber || next.password || next.consent) {
            (next.idNumber ? idInput.node : next.password ? passwordInput : consentInput).current?.focus();
            return;
        }
        const body = { idNumber: idNumber.trim().toUpperCase(), password };
        // 帳號與密碼只活在這一次請求：送出前就先從元件狀態清掉。
        setIdNumber('');
        setPassword('');
        setShowPassword(false);
        onSubmit(body);
    }

    return (
        <form
            className={styles.form}
            autoComplete='off'
            noValidate
            aria-busy={busy}
            onSubmit={submit}
        >
            <StepHeader
                step={relogin ? 'relogin' : 'login'}
                Icon={relogin ? LogIn : UserCheck}
                title={relogin ? '憑證建好了，再登入一次' : '輸入帳號密碼'}
                lead={relogin ? '永豐金證券要求憑證建立後重新登入，請再輸入一次帳號密碼。' : undefined}
            />

            <div className={styles.field}>
                <label className={styles.label} htmlFor={idFieldId}>
                    身分證字號
                </label>
                <input
                    id={idFieldId}
                    ref={idInput.attach}
                    className={styles.input}
                    name='sinopac-onboarding-id'
                    type='text'
                    maxLength={10}
                    autoComplete='off'
                    autoCapitalize='characters'
                    spellCheck={false}
                    placeholder='A123456789'
                    data-1p-ignore
                    data-lpignore='true'
                    data-form-type='other'
                    aria-required='true'
                    aria-invalid={errors.idNumber ? true : undefined}
                    aria-describedby={errors.idNumber ? `${idFieldId}-error` : undefined}
                    readOnly={busy}
                    value={idNumber}
                    onChange={(event) => setIdNumber(event.target.value)}
                />
                {errors.idNumber && (
                    <p id={`${idFieldId}-error`} className={styles.fieldError} role='alert'>
                        {errors.idNumber}
                    </p>
                )}
            </div>

            <div className={styles.field}>
                <label className={styles.label} htmlFor={passwordFieldId}>
                    密碼
                </label>
                <div className={styles.inputRow}>
                <input
                    id={passwordFieldId}
                    ref={passwordInput}
                    className={styles.passwordInput}
                    name='sinopac-onboarding-password'
                    type={showPassword ? 'text' : 'password'}
                    autoComplete='off'
                    spellCheck={false}
                    placeholder='請輸入密碼'
                    data-1p-ignore
                    data-lpignore='true'
                    data-form-type='other'
                    aria-required='true'
                    aria-invalid={errors.password ? true : undefined}
                    aria-describedby={errors.password ? `${passwordFieldId}-error` : undefined}
                    readOnly={busy}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                />
                <button
                    type='button'
                    className={styles.eyeBtn}
                    aria-label={showPassword ? '隱藏密碼' : '顯示密碼'}
                    aria-pressed={showPassword}
                    aria-controls={passwordFieldId}
                    onClick={() => setShowPassword((v) => !v)}
                >
                    {showPassword ? <EyeOff size={16} aria-hidden='true' /> : <Eye size={16} aria-hidden='true' />}
                </button>
                </div>
                {errors.password && (
                    <p id={`${passwordFieldId}-error`} className={styles.fieldError} role='alert'>
                        {errors.password}
                    </p>
                )}
            </div>

            {relogin ? (
                <div className={styles.infoBox}>
                    <Lock size={16} className={styles.infoIcon} aria-hidden='true' />
                    <div className={styles.infoBody}>
                        <p id={consentId} className={styles.infoText}>
                            密碼不會長期保存，所以需要再輸入一次。這是整個流程的第 2 次（也是最後一次）登入送出。
                        </p>
                    </div>
                </div>
            ) : (
                <div className={styles.consent}>
                    <div className={styles.consentRow}>
                        <input
                            id={consentFieldId}
                            ref={consentInput}
                            type='checkbox'
                            className={styles.choiceInput}
                            checked={agreed}
                            disabled={busy}
                            aria-labelledby={`${consentFieldId}-label ${termsId}-toggle`}
                            aria-invalid={errors.consent ? true : undefined}
                            aria-describedby={errors.consent ? `${consentFieldId}-error` : undefined}
                            onChange={(event) => {
                                setAgreed(event.target.checked);
                                if (event.target.checked) setErrors(({ consent: _, ...rest }) => rest);
                            }}
                        />
                        <span>
                            <label id={`${consentFieldId}-label`} htmlFor={consentFieldId} className={styles.consentLabel}>
                                我已閱讀並同意
                            </label>
                            <button
                                id={`${termsId}-toggle`}
                                type='button'
                                className={styles.inlineLink}
                                aria-expanded={termsOpen}
                                aria-controls={termsId}
                                onClick={() => setTermsOpen((open) => !open)}
                            >
                                憑證作業條款
                            </button>
                        </span>
                    </div>
                    <div
                        id={termsId}
                        className={styles.termsPanel}
                        role='region'
                        aria-label='憑證作業條款全文'
                        tabIndex={0}
                        hidden={!termsOpen}
                    >
                        {TWCA_TERMS.map((clause, index) => (
                            <p key={clause} className={styles.termsClause}>
                                {clause}
                                {index === 1 && (
                                    <>
                                        <ExternalLink className={styles.inlineLink} href={TWCA_CPS_URL}>
                                            {TWCA_CPS_URL}
                                        </ExternalLink>
                                        。
                                    </>
                                )}
                            </p>
                        ))}
                    </div>
                    {errors.consent && (
                        <p id={`${consentFieldId}-error`} className={styles.fieldError} role='alert'>
                            {errors.consent}
                        </p>
                    )}
                </div>
            )}

            <div className={styles.actions}>
                <button
                    type='submit'
                    className={styles.primaryBtn}
                    data-primary
                    aria-disabled={busy}
                    aria-describedby={relogin ? consentId : undefined}
                >
                    <BusyLabel busy={busy}>{relogin ? '重新登入' : '登入並繼續'}</BusyLabel>
                </button>
                {!relogin && onManual && (
                    <button
                        type='button'
                        className={styles.linkBtn}
                        disabled={busy}
                        onClick={onManual}
                    >
                        不想輸入密碼？改用引導方式
                    </button>
                )}
            </div>
        </form>
    );
}
