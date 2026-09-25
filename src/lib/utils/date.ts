// src/lib/utils/date.ts

import { dateStrOffset } from './kbars';

// 今天的台灣（交易所）日期 — 與本機時區無關，和 dateStrOffset 同一套
// UTC+8 換算；海外使用者查當日成交/損益/掃描才不會落到本地前一天
export function todayStr(): string {
    return dateStrOffset(0);
}
