import type { V9Resonance, V9ResonanceFrame, V9ResonanceSide } from './utils/research-chart';
import { researchEntry, type ResearchEntryCheck, type ResearchEntryContext, type ResearchEntryEvaluation } from './research-entry';

/** Per-symbol data quality. Global SSE LIVE is not evidence that this symbol's
 * last closed bar is current. This is supplied by the chart. */
export interface ResearchDataStatus {
    state: 'loading' | 'fresh' | 'stale' | 'closed' | 'unknown';
    reason?: string;
}

export interface ResearchDirection {
    tone: V9ResonanceSide;
    label: string;
    arrow: string;
}

export interface ResearchDecision {
    background: ResearchDirection;
    shortTerm: ResearchDirection;
    entryLabel: ResearchEntryEvaluation['label'] | '不可確認' | '休市回顧' | '方向分歧' | '方向未同向';
    entrySide?: 'long' | 'short';
    entryChecks: Array<ResearchEntryCheck | { id: 'direction'; label: string; state: 'pass' | 'wait' | 'missing'; detail: string }>;
    reasons: string[];
    dataStatus: ResearchDataStatus;
}

function directionPair(frames: V9ResonanceFrame[], minutes: number[], role: string): ResearchDirection {
    const pair = minutes.map(value => frames.find(frame => frame.minutes === value));
    const missing = pair.filter(frame => !frame || frame.side === 'insufficient').length;
    if (missing === pair.length)
        return { tone: 'insufficient', label: `${role}待資料`, arrow: '…' };
    if (missing) {
        const parts = pair.map((frame, index) => {
            const label = frame?.label ?? (minutes[index] === 1440 ? '日K' : `${minutes[index]}分`);
            const side = !frame || frame.side === 'insufficient' ? '不足'
                : frame.side === 'long' ? '多' : frame.side === 'short' ? '空' : '中性';
            return `${label}${side}`;
        });
        return { tone: 'insufficient', label: `${role}：${parts.join('／')}`, arrow: '…' };
    }
    if (pair.every(frame => frame!.side === 'long'))
        return { tone: 'long', label: `${role}偏多`, arrow: '↑' };
    if (pair.every(frame => frame!.side === 'short'))
        return { tone: 'short', label: `${role}偏空`, arrow: '↓' };
    const sides = pair.map(frame => frame!.side);
    if (sides.includes('long') && sides.includes('short'))
        return { tone: 'neutral', label: `${role}分歧`, arrow: '↔' };
    return { tone: 'neutral', label: `${role}未同向`, arrow: '↔' };
}

/** Display-only: direction votes and historical markers cannot promote a
 * research chart into a verified executable entry signal. */
export function researchDecision(
    resonance: V9Resonance | null,
    status: ResearchDataStatus = { state: 'unknown' },
    loading = false,
    entryContext?: ResearchEntryContext,
): ResearchDecision {
    const dataStatus = loading ? { state: 'loading' as const } : status;
    const reasons: string[] = [];
    const entryChecks: ResearchDecision['entryChecks'] = [];
    let entrySide: ResearchDecision['entrySide'];
    const gated = dataStatus.state !== 'fresh' && dataStatus.state !== 'closed';
    const waiting = (role: string): ResearchDirection => ({ tone: 'insufficient', label: `${role}待確認`, arrow: '…' });
    const background = gated ? waiting('背景') : directionPair(resonance?.frames ?? [], [60, 1440], '背景');
    const shortTerm = gated ? waiting('短線') : directionPair(resonance?.frames ?? [], [1, 5], '短線');
    let entryLabel: ResearchDecision['entryLabel'] = '等待確認';
    switch (dataStatus.state) {
        case 'loading': entryLabel = '等待資料'; reasons.push('商品 K 棒載入中，暫停盤勢判讀'); break;
        case 'stale': entryLabel = '不可確認'; reasons.push('盤中 K 棒過期，等待新資料'); break;
        case 'unknown': entryLabel = '不可確認'; reasons.push('尚未確認此商品資料新鮮度'); break;
        case 'closed': entryLabel = '休市回顧'; reasons.push('目前休市，只回顧已收棒，不是行情斷線'); break;
        case 'fresh': break;
    }
    if (dataStatus.reason) reasons.push(dataStatus.reason);
    if (!resonance) {
        if (dataStatus.state === 'fresh') entryLabel = '等待資料';
        reasons.push('尚無可判讀的已收棒');
    } else if (!gated && dataStatus.state === 'fresh') {
        const frames = [1, 5, 60, 1440].map(minutes => resonance.frames.find(frame => frame.minutes === minutes));
        const missing = frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => !frame || frame.side === 'insufficient');
        const sides = frames.map(frame => frame?.side);
        if (missing.length) {
            entryLabel = '等待資料';
            const detail = `資料不足：${missing.map(({ frame, index }) => `${frame?.label ?? ['1分', '5分', '60分', '日K'][index]} ${frame?.bars ?? 0}/${frame?.requiredBars ?? 117} 根`).join('、')}`;
            reasons.push(detail);
            entryChecks.push({ id: 'direction', label: '四週期方向', state: 'missing', detail });
        } else if (sides.includes('long') && sides.includes('short')) {
            entryLabel = '方向分歧';
            const detail = (background.tone === 'long' && shortTerm.tone === 'short') ||
                (background.tone === 'short' && shortTerm.tone === 'long')
                ? '高週期背景與短線方向分歧' : '1分／5分／60分／日K出現互斥多空方向';
            reasons.push(detail);
            entryChecks.push({ id: 'direction', label: '四週期方向', state: 'wait', detail });
        } else if (sides.includes('neutral')) {
            entryLabel = '方向未同向';
            const detail = '週期方向尚未同向：仍有中性週期，不把多數票當進場';
            reasons.push(detail);
            entryChecks.push({ id: 'direction', label: '四週期方向', state: 'wait', detail });
        } else {
            const side = sides[0] as 'long' | 'short';
            entryChecks.push({ id: 'direction', label: '四週期方向', state: 'pass', detail: `四週期同${side === 'long' ? '多' : '空'}；仍須檢核固定5分K，不代表可進場` });
            if (!entryContext) {
                entryLabel = '等待資料';
                const detail = '尚無固定已收5分K研究檢核資料';
                entryChecks.push({ id: 'data', label: '固定已收5分K', state: 'missing', detail });
                reasons.push(detail);
            } else {
                const entry = researchEntry(entryContext, side);
                entryLabel = entry.label;
                if (entry.label === '研究觸發多' || entry.label === '研究觸發空') entrySide = side;
                entryChecks.push(...entry.checks);
                reasons.push(...entry.checks.filter(check => check.state !== 'pass').map(check => check.detail));
            }
        }
    }
    reasons.push('既有指標的研究檢核，非正式進場策略；研究方向與歷史標記不是已驗證進場條件，不提供可直接下單訊號');
    return { background, shortTerm, entryLabel, entrySide, entryChecks, reasons, dataStatus };
}
