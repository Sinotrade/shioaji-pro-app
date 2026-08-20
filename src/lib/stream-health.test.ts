// src/lib/stream-health.test.ts — 假 LIVE 偵測的判定表（issue #28）。
// 背離＝快照前進而 SSE 靜止；seq 有動一律 ok；兩者皆靜止（夜盤冷清、
// 休市、颱風假）一律 hold，永遠不能把安靜的市場判成失聯。

import { describe, expect, it } from 'vitest';
import {
    advanceEvidence,
    compareBaselines,
    type CanaryBaseline,
    type EvidenceState,
} from './stream-health';

function baselines(
    entries: Record<string, [snapshotDt: string, seq: number]>,
): Map<string, CanaryBaseline> {
    return new Map(
        Object.entries(entries).map(([code, [snapshotDt, seq]]) => [
            code,
            { snapshotDt, seq },
        ]),
    );
}

describe('compareBaselines', () => {
    it('快照前進而 SSE 全靜止 → stale（本案主症狀）', () => {
        const prev = baselines({
            IX0001: ['2026-08-20T10:00:00', 5],
            TXFR1: ['2026-08-20T10:00:01', 9],
        });
        const next = baselines({
            IX0001: ['2026-08-20T10:00:10', 5],
            TXFR1: ['2026-08-20T10:00:11', 9],
        });
        expect(compareBaselines(prev, next)).toBe('stale');
    });

    it('任一商品 seq 有動 → ok（串流活著，即使另一商品快照前進）', () => {
        const prev = baselines({
            IX0001: ['2026-08-20T10:00:00', 5],
            TXFR1: ['2026-08-20T10:00:01', 9],
        });
        const next = baselines({
            IX0001: ['2026-08-20T10:00:10', 5],
            TXFR1: ['2026-08-20T10:00:11', 10],
        });
        expect(compareBaselines(prev, next)).toBe('ok');
    });

    it('快照與 seq 都沒動 → hold（夜盤冷清、休市、颱風假）', () => {
        const prev = baselines({
            IX0001: ['2026-08-20T13:33:00', 5],
            TXFR1: ['2026-08-20T13:44:59', 9],
        });
        const next = baselines({
            IX0001: ['2026-08-20T13:33:00', 5],
            TXFR1: ['2026-08-20T13:44:59', 9],
        });
        expect(compareBaselines(prev, next)).toBe('hold');
    });

    it('只有單一商品的快照前進、SSE 靜止 → 仍是 stale', () => {
        // 夜盤只有台指期在動（指數收盤停更）也要能偵測
        const prev = baselines({
            IX0001: ['2026-08-20T13:33:00', 5],
            TXFR1: ['2026-08-20T22:15:00', 9],
        });
        const next = baselines({
            IX0001: ['2026-08-20T13:33:00', 5],
            TXFR1: ['2026-08-20T22:16:30', 9],
        });
        expect(compareBaselines(prev, next)).toBe('stale');
    });

    it('新出現的商品（上一輪沒有基準）不參與判定', () => {
        const prev = baselines({ IX0001: ['2026-08-20T10:00:00', 5] });
        const next = baselines({
            IX0001: ['2026-08-20T10:00:00', 5],
            TXFR1: ['2026-08-20T10:00:11', 9],
        });
        expect(compareBaselines(prev, next)).toBe('hold');
    });

    it('空基準（快照整批失敗過）→ hold，不會誤判', () => {
        expect(compareBaselines(new Map(), new Map())).toBe('hold');
    });
});

describe('advanceEvidence', () => {
    const run = (start: EvidenceState, verdicts: string[]) =>
        verdicts.reduce(
            (s, v) => advanceEvidence(s, v as 'stale' | 'ok' | 'hold'),
            start,
        );

    it('連續背離累積、ok 全歸零', () => {
        expect(run({ streak: 0, holdRun: 0 }, ['stale', 'stale'])).toEqual({
            streak: 2,
            holdRun: 0,
        });
        expect(run({ streak: 2, holdRun: 0 }, ['ok'])).toEqual({
            streak: 0,
            holdRun: 0,
        });
    });

    it('hold 連續三輪把累積歸零：相隔數小時的兩次單輪背離不能湊成連續', () => {
        // 收盤瞬間一輪背離 → 整個休市 hold → 開盤重放空窗再一輪背離，
        // 不可以觸發（歸零後 streak 只有 1）
        const closed = run({ streak: 1, holdRun: 0 }, ['hold', 'hold', 'hold']);
        expect(closed.streak).toBe(0);
        expect(run(closed, ['stale']).streak).toBe(1);
    });

    it('短暫 hold（一兩輪）不影響背離累積', () => {
        expect(run({ streak: 1, holdRun: 0 }, ['hold', 'stale']).streak).toBe(2);
    });
});
