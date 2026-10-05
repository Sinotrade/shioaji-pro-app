// 步驟標題：圖示加標題，後面接一行說明；沒有輸入欄位的畫面換頁時由標題接住焦點。
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { autofocus } from './focus';
import * as s from './steps-b.css';

interface StepHeadingProps {
    icon: LucideIcon;
    tone?: keyof typeof s.headIcon;
    title: string;
    children?: ReactNode;
}

export function StepHeading({ icon: Icon, tone = 'accent', title, children }: StepHeadingProps) {
    return (
        <div className={s.header}>
            <div className={s.heading}>
                <Icon className={s.headIcon[tone]} size={18} aria-hidden='true' />
                <h3 className={s.title} tabIndex={-1} ref={autofocus}>
                    {title}
                </h3>
            </div>
            {children}
        </div>
    );
}
