// 進度列：把伺服器的 10 個步驟對應到使用者看得到的 6 個階段。
import { Check, Minus } from 'lucide-react';
import type { OnboardingStep } from '../../../lib/sinopac-onboarding/types';
import * as s from './flow-stepper.css';

export const FLOW_STAGES = ['帳密', '生日', '憑證', '權限', '金鑰', '完成'] as const;

export type FlowStage = 1 | 2 | 3 | 4 | 5 | 6;

const STAGE_OF: Record<OnboardingStep, FlowStage> = {
    login: 1,
    birthday: 2,
    cert_otp: 3,
    terms: 3,
    relogin: 3,
    plan: 4,
    key_otp: 5,
    creating: 5,
    done: 6,
    stopped: 1,
};

/** 伺服器步驟對應的階段（1 到 6）。 */
export const flowStage = (step: OnboardingStep): FlowStage => STAGE_OF[step];

interface FlowStepperProps {
    step: OnboardingStep;
    /** 這次流程是否跳出過 WebCA 憑證流程；沒有的話，走到第 4 階段後第 2、3 階段標為略過。 */
    sawCert: boolean;
}

export function FlowStepper({ step, sawCert }: FlowStepperProps) {
    if (step === 'stopped') return null;
    const current = flowStage(step);
    return (
        <ol className={s.stepper} aria-label='進度'>
            {FLOW_STAGES.map((label, index) => {
                const number = index + 1;
                const skipped = (number === 2 || number === 3) && !sawCert && current >= 4;
                const state = skipped
                    ? 'skipped'
                    : number === current
                      ? 'current'
                      : number < current
                        ? 'done'
                        : 'upcoming';
                return (
                    <li
                        key={label}
                        className={s.item[state]}
                        aria-current={state === 'current' ? 'step' : undefined}
                    >
                        <span className={s.dot[state]}>
                            {state === 'done' ? (
                                <Check size={12} strokeWidth={3} aria-hidden='true' />
                            ) : state === 'skipped' ? (
                                <Minus size={12} strokeWidth={3} aria-hidden='true' />
                            ) : (
                                number
                            )}
                        </span>
                        <span>
                            {label}
                            {(state === 'skipped' || state === 'done') && (
                                <span className={s.srOnly}>{state === 'skipped' ? '（略過）' : '（已完成）'}</span>
                            )}
                        </span>
                        {number < FLOW_STAGES.length && (
                            <span className={s.separator} aria-hidden='true'>
                                ›
                            </span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}
