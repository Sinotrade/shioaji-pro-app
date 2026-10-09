// src/lib/conditional/rows.test.ts — the 條件單管理面板 projection (#226).
import { describe, expect, it } from 'vitest';
import type { BracketPlan } from '../bracket-core';
import type { BackgroundTriggerOrder } from '../execution/background-view';
import type { BracketView } from '../execution/bracket-contract';
import { mockPendingConfirmItem } from '../execution/pending-confirm-mock';
import type { EndedTrigger, ExitRecord, TriggerOrder } from '../trigger-engine';
import { conditionText, projectRows, rowsForTab, type Sources } from './rows';

const ENV = 'http://sim.invalid|simulation';
const F = { account_type: 'F' as const, broker_id: 'b', account_id: 'a1' };
const NOW = Date.UTC(2026, 9, 9, 2, 0); // 10:00 Taipei

const trig = (over: Partial<TriggerOrder> = {}): TriggerOrder => ({
    id: 'tg-1', code: 'TXFR1', orderCode: 'TXFJ6', condition: 'below', price: 47900, action: 'Sell', quantity: 1, kind: 'stop',
    env: ENV, account: F, createdAt: NOW - 1000, ...over,
});

const plan = (over: Partial<BracketPlan> = {}): BracketPlan => ({
    id: 'bk-1', env: ENV, account: F, market: 'futures', orderId: 'o1', seqno: '1', quoteCode: 'TXFR1', orderCode: 'TXFJ6',
    securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 3, stopPrice: 48000, takePrice: 48600, group: 'bracket:o1',
    fills: { a: 3 }, filled: 3, entryClosed: true, exit: null, issues: [], createdAt: NOW - 5000, updatedAt: NOW - 4000, ...over,
});

const sources = (over: Partial<Sources> = {}): Sources => ({
    triggers: [], brackets: [], exits: [], ended: [], pendingConfirm: [], feedMissing: [], executing: true,
    envNow: ENV, streamLive: true, now: NOW, ...over,
});

describe('projectRows', () => {
    it('a plain trigger: condition words, status and actions', () => {
        const p = projectRows(sources({ triggers: [trig()] }));
        expect(p.rows).toHaveLength(1);
        const r = p.rows[0]!;
        expect(r.kind).toBe('trigger');
        expect(r.condition).toBe('≤ 47,900 停損');
        expect(r.side).toEqual({ text: '賣出 1 口', dir: 'Sell' });
        expect(r.status).toEqual({ text: '盯價中', tone: 'ok' });
        expect(r.actions).toMatchObject({ modify: true, pause: true, resume: false, cancel: true, send: false });
        expect(p.counts).toMatchObject({ active: 1, attention: 0 });
    });

    it('condition words follow direction and purpose', () => {
        expect(conditionText(trig({ condition: 'above', action: 'Buy', price: 1520 }))).toBe('≥ 1,520 突破');
        expect(conditionText(trig({ condition: 'above', action: 'Sell', kind: 'take', price: 48600 }))).toBe('≥ 48,600 停利');
        expect(conditionText(trig({ condition: 'below', action: 'Buy', kind: 'take', price: 47000 }))).toBe('≤ 47,000 停利');
        expect(conditionText(trig({ kind: 'alert', price: 47000 }))).toBe('≤ 47,000 跌破通知');
    });

    it('a paused trigger offers resume; env / stream / executor states are not shown as watching', () => {
        expect(projectRows(sources({ triggers: [trig({ paused: true })] })).rows[0]!.actions).toMatchObject({ pause: false, resume: true });
        expect(projectRows(sources({ triggers: [trig()], envNow: 'x|production' })).rows[0]!.status.tone).toBe('warn');
        expect(projectRows(sources({ triggers: [trig()], streamLive: false })).rows[0]!.status.text).toBe('連線中斷，暫停盯價');
        expect(projectRows(sources({ triggers: [trig()], executing: false })).rows[0]!.status.text).toBe('主視窗未執行，暫停盯價');
        // a background trigger keeps running without this window executing
        const bg = { ...trig({ id: 'bg:p:l' }), background: { programId: 'p', levelId: 'l' } } as BackgroundTriggerOrder;
        expect(projectRows(sources({ triggers: [bg], executing: false })).rows[0]!.status.text).toBe('盯價中');
    });

    it('a 待確認 trigger is pinned under 需要你處理 with send / keep / cancel', () => {
        const p = projectRows(sources({ triggers: [trig({ id: 'a' }), trig({ id: 'b', code: '2330', pending: { price: 1072, at: NOW, reason: 'restart' } })] }));
        expect(p.rows.map(r => r.id)).toEqual(['b', 'a']);
        expect(p.rows[0]).toMatchObject({ attention: true, status: { text: '恢復時已穿價，未自動送出', tone: 'err' } });
        expect(p.rows[0]!.actions).toMatchObject({ send: true, keep: true, cancel: true, modify: false, pause: false });
        expect(p.counts).toMatchObject({ active: 1, attention: 1 });
    });

    it('a manual OCO pair is one 二擇一 row; bracket legs belong to their bracket', () => {
        const legs = [trig({ id: 'u', group: 'g', condition: 'above', price: 48400, action: 'Buy' }), trig({ id: 'd', group: 'g' })];
        const bracketLegs = [trig({ id: 's', bracketId: 'bk-1', group: 'bracket:o1', price: 48000 }),
            trig({ id: 't', bracketId: 'bk-1', group: 'bracket:o1', condition: 'above', price: 48600, kind: 'take' })];
        const p = projectRows(sources({ triggers: [...legs, ...bracketLegs], brackets: [plan()] }));
        expect(p.rows.map(r => r.kind).sort()).toEqual(['bracket', 'oco']);
        const oco = p.rows.find(r => r.kind === 'oco')!;
        expect(oco.condition).toBe('≥ 48,400 突破 · ≤ 47,900 停損');
        expect(oco.side.text).toBe('雙向 1 口');
        const b = p.rows.find(r => r.kind === 'bracket')!;
        expect(b.condition).toBe('停損 48,000 · 停利 48,600');
        expect(b.status.text).toBe('保護中 · 成交 3/3');
        expect(b.actions).toMatchObject({ modify: true, cancel: true, reconcile: true });
        expect(p.counts.byTab).toMatchObject({ all: 2, oco: 1, bracket: 1, trigger: 0 });
        expect(rowsForTab(p, 'oco')).toHaveLength(1);
    });

    it('bracket attention: unknown exit, unprotected quantity; finished brackets go to 已結束', () => {
        const unknown = plan({ exit: { status: 'unknown', kind: 'stop', quantity: 3, filled: 0, fills: {}, at: NOW } });
        const p1 = projectRows(sources({ brackets: [unknown] }));
        expect(p1.rows[0]).toMatchObject({ attention: true, status: { tone: 'err' } });
        expect(p1.rows[0]!.actions.acknowledge).toBe(true);
        const short = plan({ exit: { status: 'incomplete', kind: 'stop', quantity: 3, filled: 1, fills: { x: 1 }, at: NOW } });
        expect(projectRows(sources({ brackets: [short] })).rows[0]!.status.text).toBe('未受保護 2 口，請對帳後處理');
        const done = plan({ exit: { status: 'filled', kind: 'take', quantity: 3, filled: 3, fills: { x: 3 }, at: NOW } });
        const p3 = projectRows(sources({ brackets: [done] }));
        expect(p3.rows).toHaveLength(0);
        expect(p3.ended[0]!.status.text).toBe('停利已出場');
        expect(p3.counts.firedToday).toBe(1);
    });

    it('委託待確認 items and unknown trigger exits are attention rows', () => {
        const item = mockPendingConfirmItem({ id: 'c1', env: ENV });
        const exit: ExitRecord = { id: 'ex-1', triggerId: 'gone', env: ENV, account: F, market: 'futures', orderCode: 'TXFJ6', action: 'Sell',
            reserveKey: 'k', requested: 1, kind: 'stop', quantity: 1, filled: 0, fills: {}, status: 'unknown', at: NOW };
        const p = projectRows(sources({ pendingConfirm: [item], exits: [exit] }));
        expect(p.rows.every(r => r.attention)).toBe(true);
        expect(p.rows.find(r => r.id === 'confirm:c1')!.actions.confirm).toBe(true);
        expect(p.rows.find(r => r.id === 'exit:ex-1')!.actions.acknowledge).toBe(true);
        // acknowledged: gone
        expect(projectRows(sources({ exits: [{ ...exit, acknowledged: true }] })).rows).toHaveLength(0);
    });

    it('today\'s finished triggers show what happened to their order', () => {
        const fired: EndedTrigger = { id: 'tg-9', trigger: trig({ id: 'tg-9' }), reason: 'fired', at: NOW };
        const exit: ExitRecord = { id: 'ex-tg-9', triggerId: 'tg-9', env: ENV, account: F, market: 'futures', orderCode: 'TXFJ6',
            action: 'Sell', reserveKey: 'k', requested: 1, kind: 'stop', quantity: 1, filled: 1, fills: { x: 1 }, status: 'filled', at: NOW };
        const p = projectRows(sources({ ended: [fired, { id: 'tg-8', trigger: trig({ id: 'tg-8' }), reason: 'cancelled', at: NOW - 10 }], exits: [exit] }));
        expect(p.ended.map(r => r.status.text)).toEqual(['已觸發 · 已出場 1/1', '已取消']);
        expect(p.counts.firedToday).toBe(1);
        expect(p.counts.byTab.ended).toBe(2);
    });

    it('background brackets: state words, 需要你處理 for lapsed, and only the contract\'s actions', () => {
        const v = (over: Partial<BracketView> = {}): BracketView => ({
            programId: 'bkt-1', levelId: 'l0', rearm: false, origin: 'entry', anomalous: 0, env: ENV, account: { accountType: 'F', brokerId: 'b', accountId: 'a1' },
            quoteCode: 'TXFR1', orderCode: 'TXFJ6', side: 'Buy', quantity: 2, stop: 48000, take: 48600, state: 'protected', paused: false,
            held: null, entryFilled: 2, position: 2, unprotected: 0, exit: null, pendingLeg: null, attention: false,
            actions: { markHandled: true, rearm: false, decide: false, pause: true, resume: false, remove: false },
            detail: null, createdAt: NOW - 100, updatedAt: NOW - 50, ...over,
        });
        const p = projectRows(sources({ bgBrackets: [v(), v({ programId: 'bkt-2', state: 'lapsed', attention: true,
            actions: { markHandled: true, rearm: true, decide: false, pause: false, resume: false, remove: false } })] }));
        expect(p.rows[0]).toMatchObject({ kind: 'bracket', attention: true, status: { text: '盤別已更換，保護未延續', tone: 'err' } });
        expect(p.rows[0]!.actions).toMatchObject({ rearm: true, handled: true, cancel: false, modify: false });
        expect(p.rows[1]!.status.text).toBe('保護中 · 成交 2/2');
        expect(p.rows[1]!.actions).toMatchObject({ pause: true, handled: true, modify: false });
        const done = projectRows(sources({ bgBrackets: [v({ state: 'handled',
            actions: { markHandled: false, rearm: false, decide: false, pause: false, resume: false, remove: true } })] }));
        expect(done.rows).toHaveLength(0);
        expect(done.ended[0]!.status.text).toBe('已改由你自行處理');
        const odd = projectRows(sources({ bgBrackets: [v({ state: 'unprotected', unprotected: 1, anomalous: 1 })] }));
        expect(odd.rows[0]).toMatchObject({ attention: true, status: { tone: 'err' } });
        expect(odd.rows[0]!.status.text).toContain('刪單成功後仍收到成交');
    });
});
