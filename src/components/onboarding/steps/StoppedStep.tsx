// 停止步驟：依錯誤碼引導復原；金鑰可能已建立時，先檢查並刪除孤兒金鑰再重來（移植自 StoppedStep.svelte）。
import { OctagonAlert } from 'lucide-react';
import {
    ACCOUNT_TYPE_LABELS,
    enabledPermissions,
    permissionLabels,
} from '../../../lib/sinopac-onboarding/plan';
import { ERROR_COPY, type OnboardingStopCode } from '../../../lib/sinopac-onboarding/errors';
import type { OnboardingPlan } from '../../../lib/sinopac-onboarding/types';
import { ExternalLink } from '../../external-link';
import { StepHeading } from './step-heading';
import * as s from './steps-b.css';

const SINOPAC_API_PAGE = 'https://www.sinotrade.com.tw/newweb/PythonAPIKey/';
const API_KEY_TAB = 'API Key 登入';

export interface StoppedStepProps {
    code: OnboardingStopCode;
    /** 引導清單要勾哪些項目：沿用使用者填過的方案，沒有就用建議的預設。 */
    plan: OnboardingPlan;
    /** 已送出的金鑰名稱，用來提示去永豐金證券刪除同名金鑰。 */
    keyName: string | null;
    onRestart: () => void;
    /** 「改用 API Key 登入」的出口：父層應切到 API Key 登入分頁。 */
    onClose: () => void;
}

export function StoppedStep({ code, plan, keyName, onRestart, onClose }: StoppedStepProps) {
    // 執行期收到不認得的碼時退回通用文案，不顯示任何伺服器文字。
    const copy = ERROR_COPY[code] ?? ERROR_COPY.GENERIC;
    const name = keyName?.trim();
    const restartLabel =
        code === 'MANUAL' ? '回到第一步' : copy.deleteKeyHint ? '已確認並刪除，重新開始' : '重新開始';
    const useApiKey = (
        <button type='button' className={copy.fallback ? s.btn.primary : s.btn.outline} onClick={onClose}>
            改用 {API_KEY_TAB}
        </button>
    );
    const restart = (
        <button type='button' className={copy.fallback ? s.btn.outline : s.btn.primary} onClick={onRestart}>
            {restartLabel}
        </button>
    );

    return (
        <div className={s.root}>
            <StepHeading icon={OctagonAlert} tone='warn' title={copy.title}>
                <p className={s.lead} role={code === 'MANUAL' ? undefined : 'alert'}>
                    {copy.message}
                </p>
            </StepHeading>

            {copy.deleteKeyHint && (
                <div className={s.banner.warn} role='note'>
                    <span>
                        <b className={s.bannerTitle}>重新申請之前，請先檢查永豐金證券的 API Key 清單</b>
                        {name ? (
                            <>
                                在 API 管理頁的清單找名稱為「<b>{name}</b>」的金鑰並刪除。
                            </>
                        ) : (
                            '在 API 管理頁的清單找剛才這次申請建立的金鑰（看名稱與建立時間）並刪除。'
                        )}
                        沒刪除就重新申請，會多出一組用不到的金鑰，並占用 30 組的上限。
                    </span>
                </div>
            )}

            {copy.fallback && (
                <section aria-label='在永豐金證券官網自己完成' className={s.root}>
                    <h4 className={s.sectionTitle}>1. 前往永豐金證券 API 管理頁</h4>
                    <ExternalLink className={`${s.btn.outline} ${s.fitContent}`} href={SINOPAC_API_PAGE}>
                        開啟永豐金證券 API 管理頁
                    </ExternalLink>
                    <h4 className={s.sectionTitle}>2. 新增 API Key 時，請這樣勾選</h4>
                    <dl className={s.summary}>
                        <dt>名稱</dt>
                        <dd>{plan.name}</dd>
                        <dt>權限</dt>
                        <dd>{permissionLabels(enabledPermissions(plan)).join('、')}</dd>
                        <dt>帳戶</dt>
                        <dd>{plan.accountTypes.map((type) => ACCOUNT_TYPE_LABELS[type]).join('、')}</dd>
                        <dt>IP</dt>
                        <dd>
                            {plan.ip.mode === 'unlimited' ? '無限制 IP' : `限制 IP：${plan.ip.addresses.join('、')}`}
                        </dd>
                        <dt>到期日</dt>
                        <dd>{plan.expiresOn}</dd>
                    </dl>
                    <h4 className={s.sectionTitle}>3. 到「{API_KEY_TAB}」分頁填入金鑰</h4>
                    <p className={s.hint}>
                        在永豐金證券官網按「確定」後，會出現一次性的 API Key 與 Secret Key。把兩個值填進「{API_KEY_TAB}」分頁的 API
                        Key 與 Secret Key 欄位即可。
                    </p>
                </section>
            )}

            <div className={s.actions}>
                {copy.fallback ? (
                    <>
                        {useApiKey}
                        {restart}
                    </>
                ) : (
                    <>
                        {restart}
                        {useApiKey}
                    </>
                )}
            </div>
        </div>
    );
}
