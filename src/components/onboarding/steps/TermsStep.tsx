import { ScrollText } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import * as styles from './steps-a.css';
import { BusyLabel, StepHeader } from './step-header';

export interface TermsStepProps {
    /** 從永豐金證券頁面讀到的條款全文。第三方內容，只當純文字顯示。 */
    termsText: string | null;
    busy: boolean;
    onSubmit: () => void;
}

export function TermsStep({ termsText, busy, onSubmit }: TermsStepProps) {
    const box = useRef<HTMLDivElement>(null);
    const [reachedEnd, setReachedEnd] = useState(false);
    const [agreed, setAgreed] = useState(false);

    const paragraphs = (termsText ?? '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

    function checkEnd() {
        const el = box.current;
        if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) setReachedEnd(true);
    }

    // 條款短到不需要捲動時，視為已經讀到最底；依 termsText 而不是每次 render 都會變的 paragraphs。
    useEffect(checkEnd, [termsText]);

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || !reachedEnd || !agreed) return;
        onSubmit();
    }

    return (
        <form className={styles.form} noValidate aria-busy={busy} onSubmit={submit}>
            <StepHeader
                step='terms'
                Icon={ScrollText}
                title='憑證作業條款'
                lead='這是臺灣網路認證公司（TWCA）電子憑證的法律同意，必須由你本人閱讀並勾選。'
            />

            {paragraphs.length === 0 ? (
                <p className={styles.alertBox} role='alert'>
                    沒有讀到條款內容，無法繼續。請取消後重新開始，或改在永豐金證券官網自己完成。
                </p>
            ) : (
                <>
                    {/* 可捲動區域必須能用鍵盤聚焦並捲動，否則只用鍵盤的人讀不到條款最底部。 */}
                    <div
                        ref={box}
                        className={styles.termsBox}
                        tabIndex={0}
                        role='region'
                        aria-label='憑證作業條款全文'
                        onScroll={checkEnd}
                    >
                        {paragraphs.map((paragraph, index) => (
                            <p key={index} className={styles.termsParagraph}>
                                {paragraph}
                            </p>
                        ))}
                    </div>
                    <label
                        className={`${styles.checkRowTop}${reachedEnd ? '' : ` ${styles.checkRowLocked}`}`}
                    >
                        <input
                            type='checkbox'
                            className={styles.choiceInput}
                            disabled={!reachedEnd}
                            checked={agreed}
                            onChange={(event) => setAgreed(event.target.checked)}
                        />
                        <span>
                            我已閱讀並同意憑證作業條款
                            {!reachedEnd && (
                                <span className={styles.choiceHint}>請先把條款捲到最底部，才能勾選。</span>
                            )}
                        </span>
                    </label>
                    <button
                        type='submit'
                        className={styles.primaryBtn}
                        data-primary
                        disabled={!reachedEnd || !agreed}
                        aria-disabled={busy || !reachedEnd || !agreed}
                    >
                        <BusyLabel busy={busy}>同意並繼續</BusyLabel>
                    </button>
                </>
            )}
        </form>
    );
}
