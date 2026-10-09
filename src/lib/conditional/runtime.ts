// src/lib/conditional/runtime.ts — panel-wide actions of the 條件單管理面板
// (#226): 全部暫停／全部恢復 and 全平並取消 (also run by a 收盤前平倉 time
// order in the executing main window). Every step goes through the engine
// that owns the order.

import { dismissBracket, getBrackets } from '../bracket';
import { isLive } from '../bracket-core';
import { getBackgroundPrograms, markBackgroundHandled, pauseBackgroundProgram, resumeBackgroundProgram } from '../execution/background';
import { bracketViews } from '../execution/bracket-contract';
import { notify } from '../trade';
import { getDisplayTriggers, getExits, onTimedFlatten, removeTriggerStrict, setTriggerGroup, setTriggerPaused, type TriggerOrder } from '../trigger-engine';
import { executeFlatten, inScope, type FlattenResult, type FlattenScope } from './flatten';
import { getConditionalSettings } from './settings';

const codesOf = (t: Pick<TriggerOrder, 'code' | 'orderCode'>) => [t.code, t.orderCode].filter((c): c is string => !!c);

/** Step 1 of 全平並取消: stop every conditional order in scope. */
export async function stopConditionalInScope(scope: FlattenScope): Promise<{ stopped: number; failed: string[] }> {
    let stopped = 0;
    const failed: string[] = [];
    const tryDo = async (what: string, fn: () => Promise<unknown>) => {
        try { await fn(); stopped += 1; } catch (e) { failed.push(`${what}：${e instanceof Error ? e.message : String(e)}`); }
    };
    const groups = new Map<string, string[]>();
    for (const t of getDisplayTriggers()) {
        if (t.bracketId || !codesOf(t).some(c => inScope(scope, t.account, c))) continue;
        // 二擇一: both legs in one step, so neither can fire in between
        if (t.group) { groups.set(`${t.env}|${t.group}`, [...(groups.get(`${t.env}|${t.group}`) ?? []), t.id]); continue; }
        await tryDo(`${t.code} 觸價單`, () => removeTriggerStrict(t.id));
    }
    for (const ids of groups.values()) {
        try { await setTriggerGroup(ids, 'remove'); stopped += ids.length; } catch (e) { failed.push(`二擇一：${e instanceof Error ? e.message : String(e)}`); }
    }
    for (const p of getBrackets()) {
        if (p.dismissed || !isLive(p) || !(inScope(scope, p.account, p.orderCode) || inScope(scope, p.account, p.quoteCode))) continue;
        await tryDo(`${p.quoteCode} 括號單`, () => dismissBracket(p.id));
    }
    for (const v of bracketViews(getBackgroundPrograms())) {
        const account = { account_type: v.account.accountType, broker_id: v.account.brokerId, account_id: v.account.accountId };
        if (!v.actions.markHandled || !(inScope(scope, account, v.orderCode) || inScope(scope, account, v.quoteCode))) continue;
        await tryDo(`${v.quoteCode} 括號單`, () => markBackgroundHandled(v.programId, v.levelId));
    }
    return { stopped, failed };
}

export function flattenSummary(r: FlattenResult): string {
    const parts = [
        `停止條件單 ${r.stopped} 張`,
        `刪除委託 ${r.cancelled} 筆`,
        r.sent.length ? `送出平倉 ${r.sent.map(s => `${s.code} ${s.action === 'Buy' ? '買' : '賣'} ${s.quantity}${s.market === 'stock' ? ' 股' : ' 口'}`).join('、')}` : '沒有需要平倉的部位',
    ];
    const problems = [...r.cancelFailed, ...r.notSent, ...r.skipped];
    return `${parts.join('；')}${problems.length ? `。需要你處理：${problems.join('；')}` : ''}`;
}

export const IN_FLIGHT_WAIT_MS = 10_000;
/** A conditional order that already fired is sending its order: wait for its answer. */
export async function waitInFlight(scope: FlattenScope, maxMs = IN_FLIGHT_WAIT_MS): Promise<boolean> {
    const busy = () => getExits().some(e => e.status === 'sending' && inScope(scope, e.account, e.orderCode));
    const until = Date.now() + maxMs;
    while (busy()) {
        if (Date.now() >= until) return false;
        await new Promise(r => setTimeout(r, 200));
    }
    return true;
}

let flattening = false;
export async function runFlatten(scope: FlattenScope): Promise<FlattenResult> {
    // one at a time: two runs could read the same holdings and both close them
    if (flattening) throw new Error('全平並取消正在執行，請等它完成');
    flattening = true;
    let r: FlattenResult;
    try {
        r = await executeFlatten(scope, { stopConditional: () => stopConditionalInScope(scope), waitInFlight: () => waitInFlight(scope) });
    } finally {
        flattening = false;
    }
    const bad = r.cancelFailed.length + r.notSent.length + r.skipped.length > 0;
    notify({ kind: bad ? 'err' : 'ok', title: bad ? '全平並取消未完全完成' : '全平並取消已送出', body: flattenSummary(r) });
    return r;
}

/** Whether 全部暫停 pauses this trigger: new entries (面板的觸價單、指定時間送單);
 * protective stops / takes and 收盤前平倉 only with the setting on. */
export function pauseAllEligible(t: Pick<TriggerOrder, 'role' | 'kind' | 'time' | 'bracketId'>, exitsToo: boolean): boolean {
    if (t.bracketId) return false;
    if (t.role === 'entry') return true;
    return exitsToo && t.kind !== 'alert';
}

/** 全部暫停 pauses new entries (entry triggers, time orders, brackets still
 * waiting for their entry); stop / take keep watching unless the setting
 * says otherwise. 全部恢復 resumes what is paused. */
export async function pauseAll(pause: boolean): Promise<{ changed: number; failed: string[] }> {
    const exitsToo = getConditionalSettings().pauseStopsExits;
    let changed = 0;
    const failed: string[] = [];
    for (const t of getDisplayTriggers()) {
        if (t.bracketId || t.pending || !!t.paused === pause) continue;
        // resume: everything paused; pause: entries (and exits when the setting says so)
        if (pause && !pauseAllEligible(t, exitsToo)) continue;
        try { await setTriggerPaused(t.id, pause); changed += 1; } catch (e) { failed.push(`${t.code}：${e instanceof Error ? e.message : String(e)}`); }
    }
    for (const v of bracketViews(getBackgroundPrograms())) {
        const can = pause ? v.actions.pause : v.actions.resume;
        if (!can) continue;
        try {
            await (pause ? pauseBackgroundProgram(v.programId) : resumeBackgroundProgram(v.programId));
            changed += 1;
        } catch (e) { failed.push(`${v.quoteCode}：${e instanceof Error ? e.message : String(e)}`); }
    }
    return { changed, failed };
}

/** Main window: a due 收盤前平倉 time order runs 全平並取消 here. */
export function startConditionalRuntime(): void {
    onTimedFlatten(t => {
        if (!t.account) return;
        const scope: FlattenScope = t.time?.kind === 'flatten' && t.time.scope === 'account'
            ? { type: 'account', account: t.account }
            : { type: 'code', codes: codesOf(t), account: t.account };
        void runFlatten(scope).catch(e => notify({ kind: 'err', title: '收盤前平倉沒有完成', body: e instanceof Error ? e.message : String(e) }));
    });
}
