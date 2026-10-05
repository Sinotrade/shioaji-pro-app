import { LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OnboardingStep } from '../../../lib/sinopac-onboarding/types';
import { flowStage } from './FlowStepper';
import * as styles from './steps-a.css';

interface StepHeaderProps {
    step: OnboardingStep;
    Icon: LucideIcon;
    title: string;
    lead?: string;
}

/** 圖示 + 「步驟 N：標題」+ 選用的一行說明；N 取自進度列的階段編號。 */
export function StepHeader({ step, Icon, title, lead }: StepHeaderProps) {
    return (
        <div className={styles.header}>
            <h3 className={styles.title}>
                <Icon size={18} className={styles.titleIcon} aria-hidden='true' />
                {`步驟 ${flowStage(step)}：${title}`}
            </h3>
            {lead && <p className={styles.lead}>{lead}</p>}
        </div>
    );
}

/** 主按鈕內容：處理中顯示行內 spinner 與「處理中…」，字數不同但按鈕寬度固定所以不位移。 */
export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
    return busy ? (
        <>
            <LoaderCircle size={16} className={styles.spinner} aria-hidden='true' />
            處理中…
        </>
    ) : (
        children
    );
}
