import { CalendarDays } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { isBirthday8 } from '../../../lib/sinopac-onboarding/types';
import { useAutofocusRef } from './focus';
import * as styles from './steps-a.css';
import { BusyLabel, StepHeader } from './step-header';

export interface BirthdayStepProps {
    busy: boolean;
    /** 8 碼 YYYYMMDD；父層再包成 { birthday } 送出。 */
    onSubmit: (birthday: string) => void;
}

export function BirthdayStep({ busy, onSubmit }: BirthdayStepProps) {
    const uid = useId();
    const fieldId = `${uid}-birthday`;
    const [birthday, setBirthday] = useState('');
    const [error, setError] = useState('');
    const input = useAutofocusRef<HTMLInputElement>();

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const value = birthday.replace(/\D/g, '');
        if (!isBirthday8(value)) {
            setError('請輸入 8 碼西元年月日，例如 19900101。');
            input.node.current?.focus();
            return;
        }
        setError('');
        setBirthday('');
        onSubmit(value);
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
                step='birthday'
                Icon={CalendarDays}
                title='輸入生日驗證'
                lead='請輸入 8 碼西元生日。'
            />

            <div className={styles.field}>
                <label className={styles.label} htmlFor={fieldId}>
                    生日（西元年月日）
                </label>
                <input
                    id={fieldId}
                    ref={input.attach}
                    className={styles.input}
                    name='sinopac-onboarding-birthday'
                    inputMode='numeric'
                    maxLength={8}
                    autoComplete='off'
                    placeholder='例如 19900101'
                    data-1p-ignore
                    aria-required='true'
                    aria-invalid={error ? true : undefined}
                    aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ''}`}
                    readOnly={busy}
                    value={birthday}
                    onChange={(event) => setBirthday(event.target.value)}
                />
                {error && (
                    <p id={`${fieldId}-error`} className={styles.fieldError} role='alert'>
                        {error}
                    </p>
                )}
                <p id={`${fieldId}-hint`} className={styles.hint}>
                    配合主管機關落實資訊安全防護機制，憑證申請將採行「OTP」認證機制，以維護投資人權益。
                </p>
            </div>

            <button type='submit' className={styles.primaryBtn} data-primary aria-disabled={busy}>
                <BusyLabel busy={busy}>下一步</BusyLabel>
            </button>
        </form>
    );
}
