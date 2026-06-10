// src/lib/utils/transformers/tick.ts

import type { HistoryTicks, Tick } from '../../types/tick';

export function unPackHistoryTicks(raw: HistoryTicks, code: string): Tick[] {
    const total = raw.datetime.length;
    const ticks: Tick[] = [];
    for (let i = 0; i < total; i++) {
        ticks.push({
            code,
            time: raw.datetime[i]?.slice(11) ?? '',
            close: raw.close[i] ?? 0,
            volume: raw.volume[i] ?? 0,
            tick_type: raw.tick_type[i] ?? 0,
        });
    }
    return ticks;
}
