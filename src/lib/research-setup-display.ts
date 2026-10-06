import type { ResearchDataStatus } from './research-decision';
import type { researchSetups } from './research-setups';
import type { researchSessionVwap } from './research-vwap';

export type ResearchSetupEvaluation = ReturnType<typeof researchSetups>;
export type ResearchVwapEvaluation = ReturnType<typeof researchSessionVwap>;

/** Display-only gate. A stale/disconnected/closed chart must never keep a
 * cached pattern confirmation looking like a current actionable event. */
export function researchSetupDisplay(
    setup: ResearchSetupEvaluation,
    vwap: ResearchVwapEvaluation,
    dataStatus?: ResearchDataStatus,
    loading = false,
) {
    const tone = 'insufficient' as const;
    if (loading || dataStatus?.state === 'loading') {
        return { label: '型態資料載入中', detail: '等待同商品已收一分K；不沿用上一檔型態', tone };
    }
    if (dataStatus?.state === 'closed') {
        return { label: '已休市 · 型態暫停', detail: '休市不確認新型態；歷史研究請使用回放', tone };
    }
    if (dataStatus?.state !== 'fresh') {
        return { label: '型態資料未確認', detail: dataStatus?.reason ?? '等待本商品資料時效確認', tone };
    }
    if (vwap.status !== 'ready' || setup.state === 'waiting-data') {
        return { label: '等待型態資料', detail: vwap.status !== 'ready' ? vwap.reason : setup.detail, tone };
    }
    return { label: setup.label, detail: setup.detail,
        tone: setup.side ?? 'neutral' as 'long' | 'short' | 'neutral' };
}
