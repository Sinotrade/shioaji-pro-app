// src/components/us-session-icon.tsx — 美股延長時段圖示（自選副行、報價板、下單面板共用）
//
// 照 TradingView：盤前＝日出、盤後＝日落、夜盤＝月亮（lucide）。畫面只有圖示，
// 讀屏名稱與提示是中文時段（盤前／盤後／夜盤），提示可以再帶高低、時間。
// 一般盤、未知時段不畫；需要保留位置時用 placeholder（同大小、不顯示）。

import { Moon, Sunrise, Sunset, type LucideIcon } from 'lucide-react';
import { US_SESSION_LABEL, type UsTradingSession } from '../lib/us/us-quotes';
import * as styles from './us-session-icon.css';

const ICONS: Partial<Record<UsTradingSession, LucideIcon>> = {
    PreMarket: Sunrise,
    AfterHours: Sunset,
    Overnight: Moon,
};

/** 這個時段有沒有圖示（只有盤前、盤後、夜盤） */
export const hasUsSessionIcon = (session: UsTradingSession | null | undefined) => !!session && !!ICONS[session];

export function UsSessionIcon({
    session,
    size = 12,
    title,
    className,
    placeholder = false,
}: {
    session: UsTradingSession | null | undefined;
    size?: number;
    /** 提示；預設是時段名稱 */
    title?: string;
    className?: string;
    /** 只佔位不顯示（沒有延長時段價時保留寬度） */
    placeholder?: boolean;
}) {
    const Icon = (session && ICONS[session]) || (placeholder ? Sunset : undefined);
    if (!Icon) return null;
    const label = session ? US_SESSION_LABEL[session] : '';
    const box = { width: size, height: size };
    if (placeholder) {
        return (
            <span className={`${styles.icon} ${styles.placeholder}${className ? ` ${className}` : ''}`} style={box} aria-hidden='true'>
                <Icon size={size} strokeWidth={2} />
            </span>
        );
    }
    return (
        <span
            className={`${styles.icon}${className ? ` ${className}` : ''}`}
            style={box}
            role='img'
            aria-label={label}
            title={title ?? label}
            data-us-session={session}
        >
            <Icon size={size} strokeWidth={2} aria-hidden='true' />
        </span>
    );
}
