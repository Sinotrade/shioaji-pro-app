// 建立中步驟：金鑰只會建立一次，這個畫面沒有任何重試入口（移植自 CreatingStep.svelte）。
import { KeyRound, LoaderCircle } from 'lucide-react';
import { useLeaveGuard } from './DoneStep';
import { StepHeading } from './step-heading';
import * as s from './steps-b.css';

export interface CreatingStepProps {
    /** 重新整理後從伺服器進度還原：這個頁面沒有送出建立請求，只能等候。 */
    resumed: boolean;
    /** 等候次數達上限，伺服器仍沒有結果。 */
    gaveUp: boolean;
    onCancel: () => void;
}

export function CreatingStep({ resumed, gaveUp, onCancel }: CreatingStepProps) {
    // 這個頁面正在等建立回應（Secret Key 只在這次回應裡）：重新整理會讓它永遠消失。
    useLeaveGuard(!resumed && !gaveUp, () => undefined, false);

    return (
        <div className={s.root} role='status' aria-live='polite'>
            <StepHeading icon={KeyRound} title='正在建立 API Key'>
                <p className={s.lead}>請不要關閉或重新整理這個頁面，大約需要幾秒鐘。</p>
            </StepHeading>
            {gaveUp ? (
                <>
                    <p className={s.banner.danger} role='alert'>
                        等了一段時間仍沒有結果。為避免重複建立金鑰，我們不會自動再送一次。請取消後到永豐金證券 API
                        管理頁確認有沒有多出一組金鑰，再決定要不要重新申請。
                    </p>
                    <div className={s.actions}>
                        <button type='button' className={s.btn.outline} onClick={onCancel}>
                            取消並離開
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <p className={s.banner.warn}>
                        建立金鑰只會送出一次，不會自動重試。請不要重新送出或重新申請，否則永豐金證券會多出一組金鑰。
                    </p>
                    <ul className={s.progress}>
                        <li className={s.progressItem}>
                            <span className={s.progressMark}>
                                <LoaderCircle className={s.spinner} size={20} aria-hidden='true' />
                            </span>
                            <span>在永豐金證券 API 管理頁填入名稱、權限、帳戶與 IP</span>
                        </li>
                        <li className={`${s.progressItem} ${s.dim}`}>
                            <span className={s.progressMark} />
                            <span>按下確定並取得金鑰（只在本機處理）</span>
                        </li>
                        <li className={`${s.progressItem} ${s.dim}`}>
                            <span className={s.progressMark} />
                            <span>寫入本機設定，並關閉瀏覽器</span>
                        </li>
                    </ul>
                    {resumed && (
                        <p className={s.hint}>
                            頁面重新整理過，正在等伺服器完成上一次送出的建立。若這次有選擇顯示 Secret
                            Key，它已經無法再顯示。
                        </p>
                    )}
                </>
            )}
        </div>
    );
}
