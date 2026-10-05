// 方案步驟：選權限、帳戶、IP、名稱與到期日（移植自 PlanStep.svelte）。
// IP 模式由使用者選（預設無限制 IP，動態 IP 只能這樣設定）；開放交易時，送出前一定要勾選風險確認。
import { KeyRound } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import {
    ACCOUNT_TYPE_LABELS,
    ACCOUNT_TYPE_ORDER,
    PERMISSION_LABELS,
    PERMISSION_ORDER,
    addDays,
    addOneYear,
    createPlanForm,
    planFromForm,
    toDateKey,
    type PlanForm,
} from '../../../lib/sinopac-onboarding/plan';
import {
    ONBOARDING_MAX_IPS,
    ONBOARDING_NAME_MAX,
    validateOnboardingPlan,
    type OnboardingPlan,
} from '../../../lib/sinopac-onboarding/types';
import { autofocus } from './focus';
import { StepHeader } from './step-header';
import * as s from './steps-b.css';

export interface PlanStepProps {
    busy: boolean;
    onSubmit: (plan: OnboardingPlan) => void;
}

const IP_MODES: [PlanForm['ipMode'], string][] = [
    ['unlimited', '無限制 IP'],
    ['restricted', '限制 IP'],
];

const EXPIRY_PRESETS: [string, number | 'year'][] = [
    ['90 天', 90],
    ['180 天', 180],
    ['1 年', 'year'],
];

export function PlanStep({ busy, onSubmit }: PlanStepProps) {
    const uid = useId();
    const [form, setForm] = useState<PlanForm>(() => createPlanForm());
    const [attempted, setAttempted] = useState(false);

    const patch = (next: Partial<PlanForm>) => setForm((current) => ({ ...current, ...next }));

    const plan = planFromForm(form);
    const errors = validateOnboardingPlan(plan);
    const trade = plan.permissions.trade;
    const tradeAckError = trade && !form.tradeAck ? '開放交易前，請先勾選確認。' : '';
    const now = new Date();
    const tomorrow = toDateKey(addDays(now, 1));
    const presetDate = (span: number | 'year') => toDateKey(span === 'year' ? addOneYear(now) : addDays(now, span));
    const showError = (key: keyof typeof errors) => (attempted ? errors[key] : undefined);

    function submit(event: FormEvent) {
        event.preventDefault();
        if (busy) return;
        setAttempted(true);
        if (Object.keys(errors).length > 0 || tradeAckError) return;
        onSubmit(plan);
    }

    return (
        <form className={s.root} autoComplete='off' noValidate onSubmit={submit}>
            <StepHeader
                step='plan'
                Icon={KeyRound}
                title='設定 API Key 權限與帳戶'
                lead='名稱、權限、綁定帳戶與到期日；選好後才會寄出驗證碼。'
            />

            <div className={s.section}>
                <div className={s.labelRow}>
                    <label className={s.label} htmlFor={`${uid}-name`}>
                        API Key 名稱
                    </label>
                    <span className={s.hint}>
                        {form.name.length}／{ONBOARDING_NAME_MAX} 個字元
                    </span>
                </div>
                <div className={s.group.field}>
                    <input
                        id={`${uid}-name`}
                        ref={autofocus}
                        className={s.input}
                        autoComplete='off'
                        aria-invalid={Boolean(showError('name'))}
                        value={form.name}
                        onChange={(event) => patch({ name: event.target.value })}
                    />
                </div>
                {showError('name') && (
                    <p className={s.footerError} role='alert'>
                        {errors.name}
                    </p>
                )}
            </div>

            <fieldset className={s.section}>
                <legend className={s.sectionLabel}>權限勾選</legend>
                <div className={s.group.rows}>
                    <div className={s.checkGrid}>
                        {PERMISSION_ORDER.map((key) => (
                            <label key={key} className={s.checkRow}>
                                <input
                                    type='checkbox'
                                    className={s.control}
                                    checked={form.permissions[key]}
                                    onChange={(event) =>
                                        patch({
                                            permissions: { ...form.permissions, [key]: event.target.checked },
                                            tradeAck: key === 'trade' && !event.target.checked ? false : form.tradeAck,
                                        })
                                    }
                                />
                                {PERMISSION_LABELS[key]}
                            </label>
                        ))}
                    </div>
                    {/* 依附在「交易」之下：縮排對齊「交易」的文字，取消交易時一起消失。 */}
                    {trade && (
                        <div className={s.subRow}>
                            <label className={s.checkRowTop}>
                                <input
                                    type='checkbox'
                                    className={s.control}
                                    checked={form.tradeAck}
                                    onChange={(event) => patch({ tradeAck: event.target.checked })}
                                />
                                <span>我了解：開放交易後，持有這組金鑰的人都可以下單。</span>
                            </label>
                            {attempted && tradeAckError && (
                                <p className={s.subError} role='alert'>
                                    {tradeAckError}
                                </p>
                            )}
                        </div>
                    )}
                </div>
                {!form.permissions.prod && (
                    <p className={s.footer}>沒勾「正式環境」只能用模擬環境，讀不到真實庫存。</p>
                )}
                {showError('permissions') && (
                    <p className={s.footerError} role='alert'>
                        {errors.permissions}
                    </p>
                )}
            </fieldset>

            <fieldset className={s.section}>
                <legend className={s.sectionLabel}>綁定帳戶</legend>
                <div className={s.group.rows}>
                    <div className={s.checkFlow}>
                        {ACCOUNT_TYPE_ORDER.map((type) => (
                            <label key={type} className={s.checkRow}>
                                <input
                                    type='checkbox'
                                    className={s.control}
                                    checked={form.accountTypes[type]}
                                    onChange={(event) =>
                                        patch({ accountTypes: { ...form.accountTypes, [type]: event.target.checked } })
                                    }
                                />
                                {ACCOUNT_TYPE_LABELS[type]}
                            </label>
                        ))}
                    </div>
                </div>
                {showError('accountTypes') && (
                    <p className={s.footerError} role='alert'>
                        {errors.accountTypes}
                    </p>
                )}
            </fieldset>

            <fieldset className={s.section}>
                <legend className={s.sectionLabel}>允許的 IP</legend>
                <div className={s.group.rows}>
                    {IP_MODES.map(([mode, label], index) => (
                        <label key={mode} className={index > 0 ? `${s.checkRow} ${s.divided}` : s.checkRow}>
                            <input
                                type='radio'
                                name={`${uid}-ip-mode`}
                                className={s.control}
                                checked={form.ipMode === mode}
                                onChange={() => patch({ ipMode: mode })}
                            />
                            {label}
                        </label>
                    ))}
                    {/* 限制 IP 的欄位依附在「限制 IP」之下，縮排對齊它的文字。 */}
                    {form.ipMode === 'restricted' && (
                        <div className={s.sub}>
                            <p className={s.hint}>請填入會使用這組金鑰的固定 IPv4，最多 {ONBOARDING_MAX_IPS} 組。</p>
                            {form.ips.map((ip, index) => (
                                <div key={index} className={s.ipRow}>
                                    <input
                                        className={s.input}
                                        inputMode='decimal'
                                        autoComplete='off'
                                        aria-label={`允許的 IP ${index + 1}`}
                                        aria-invalid={Boolean(showError('ip'))}
                                        placeholder='例如 203.0.113.42'
                                        value={ip}
                                        onChange={(event) =>
                                            patch({
                                                ips: form.ips.map((current, other) =>
                                                    other === index ? event.target.value : current,
                                                ),
                                            })
                                        }
                                    />
                                    {form.ips.length > 1 && (
                                        <button
                                            type='button'
                                            className={s.btn.compact}
                                            onClick={() => patch({ ips: form.ips.filter((_, other) => other !== index) })}
                                        >
                                            移除
                                        </button>
                                    )}
                                </div>
                            ))}
                            {showError('ip') && (
                                <p className={s.fieldError} role='alert'>
                                    {errors.ip}
                                </p>
                            )}
                            {form.ips.length < ONBOARDING_MAX_IPS && (
                                <button
                                    type='button'
                                    className={s.textBtn}
                                    onClick={() => patch({ ips: [...form.ips, ''] })}
                                >
                                    新增另一組 IP
                                </button>
                            )}
                        </div>
                    )}
                </div>
                {form.ipMode === 'unlimited' && (
                    <p className={s.footer}>一般家用或行動網路的 IP 會變動，請選無限制 IP；有固定 IP 再改選限制 IP。</p>
                )}
            </fieldset>

            <div className={s.section}>
                <label id={`${uid}-expiry-label`} className={s.sectionLabel} htmlFor={`${uid}-expiry`}>
                    到期日
                </label>
                <div className={s.group.inline}>
                    <input
                        id={`${uid}-expiry`}
                        type='date'
                        className={`${s.input} ${s.grow}`}
                        min={tomorrow}
                        aria-invalid={Boolean(showError('expiresOn'))}
                        value={form.expiresOn}
                        onChange={(event) => patch({ expiresOn: event.target.value })}
                    />
                    {/* 快速選項：與目前日期相符的那段呈選取狀態，自訂日期時都不選。 */}
                    <div className={s.segmented} role='group' aria-labelledby={`${uid}-expiry-label`}>
                        {EXPIRY_PRESETS.map(([label, span]) => {
                            const date = presetDate(span);
                            return (
                                <button
                                    key={label}
                                    type='button'
                                    className={s.segment}
                                    aria-pressed={form.expiresOn === date}
                                    onClick={() => patch({ expiresOn: date })}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                </div>
                {showError('expiresOn') ? (
                    <p className={s.footerError} role='alert'>
                        {errors.expiresOn}
                    </p>
                ) : (
                    <p className={s.footer}>預設一年，到期前記得續期。</p>
                )}
            </div>

            <button type='submit' className={s.btn.primary} disabled={busy}>
                下一步：API 金鑰申請驗證
            </button>
        </form>
    );
}
