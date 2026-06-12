// src/lib/agent/tasks.ts — scheduled & triggered agent runs: 每天 HH:MM、
// 每 N 分鐘、到價觸發、委託/成交事件觸發. The scheduler starts with the
// app (boot) and runs while it's open (the tray keeps it alive). Runs are
// recorded and surfaced through 通知中心.

import { useSyncExternalStore } from 'react';
import { ensureContract } from '../contracts-cache';
import { getQuote, onOrderEvent, subscribeQuoteStore } from '../stream';
import { logNotice, notify } from '../trade';
import { createAgentSession } from './runner';
import type { AgentBlock, AgentTask, RunRecord } from './types';

const TASKS_KEY = 'sj-agent-tasks';
const RUNS_KEY = 'sj-agent-runs';
const RUNS_LIMIT = 100;

// ---- stores ----

function loadTasks(): AgentTask[] {
    try {
        const raw = localStorage.getItem(TASKS_KEY);
        if (raw) return JSON.parse(raw) as AgentTask[];
    } catch {
        // empty
    }
    return [];
}

function loadRuns(): RunRecord[] {
    try {
        const raw = localStorage.getItem(RUNS_KEY);
        if (raw) return JSON.parse(raw) as RunRecord[];
    } catch {
        // empty
    }
    return [];
}

let tasks = loadTasks();
let runs = loadRuns();
const taskListeners = new Set<() => void>();
const runListeners = new Set<() => void>();

function persistTasks() {
    try {
        localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
    } catch {
        // session only
    }
    taskListeners.forEach((l) => l());
    rebuildPriceWatchers();
}

function recordRun(rec: RunRecord) {
    runs = [rec, ...runs].slice(0, RUNS_LIMIT);
    try {
        localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
    } catch {
        // session only
    }
    runListeners.forEach((l) => l());
}

export function getTasks(): AgentTask[] {
    return tasks;
}

export function useAgentTasks(): AgentTask[] {
    return useSyncExternalStore(
        (l) => {
            taskListeners.add(l);
            return () => taskListeners.delete(l);
        },
        () => tasks,
    );
}

export function useAgentRuns(): RunRecord[] {
    return useSyncExternalStore(
        (l) => {
            runListeners.add(l);
            return () => runListeners.delete(l);
        },
        () => runs,
    );
}

export function saveTask(task: Omit<AgentTask, 'id' | 'createdAt'> & { id?: string }) {
    if (task.id) {
        tasks = tasks.map((t) =>
            t.id === task.id ? ({ ...t, ...task } as AgentTask) : t,
        );
    } else {
        tasks = [
            ...tasks,
            {
                ...task,
                id: `task-${Date.now()}`,
                createdAt: Date.now(),
            } as AgentTask,
        ];
    }
    persistTasks();
}

export function deleteTask(id: string) {
    tasks = tasks.filter((t) => t.id !== id);
    persistTasks();
}

export function setTaskEnabled(id: string, enabled: boolean) {
    tasks = tasks.map((t) => (t.id === id ? { ...t, enabled } : t));
    persistTasks();
}

// ---- execution ----

let runningTaskId: string | null = null;

export async function runTaskNow(task: AgentTask, context = '') {
    if (runningTaskId) {
        notify({
            kind: 'info',
            title: '🤖 Agent 忙碌中',
            body: `「${task.name}」已排隊略過（另一任務執行中）`,
        });
        return;
    }
    runningTaskId = task.id;
    tasks = tasks.map((t) =>
        t.id === task.id ? { ...t, lastRunAt: Date.now() } : t,
    );
    persistTasks();
    const texts: string[] = [];
    let proposals = 0;
    let ok = true;
    try {
        const session = createAgentSession(task.policy);
        const prompt = context
            ? `${task.prompt}\n\n[觸發內容]\n${context}`
            : task.prompt;
        await session.send(prompt, (blocks: AgentBlock[]) => {
            for (const b of blocks) {
                if (b.type === 'text') texts.push(b.text);
                if (b.type === 'proposal') {
                    proposals += 1;
                    // background proposals can't be clicked — surface them
                    notify({
                        kind: 'info',
                        title: `🤖 任務「${task.name}」提案待確認`,
                        body: `${b.proposal.action === 'Buy' ? '買' : '賣'} ${b.proposal.code} × ${b.proposal.quantity} @ ${b.proposal.price ?? '市價'} — ${b.proposal.reason}（請手動下單或改用自動權限）`,
                    });
                }
            }
        });
    } catch (e) {
        ok = false;
        texts.push(e instanceof Error ? e.message : String(e));
    } finally {
        runningTaskId = null;
    }
    const summary = texts.join('\n').slice(0, 600) || '(無輸出)';
    recordRun({
        id: `run-${Date.now()}`,
        taskId: task.id,
        name: task.name,
        at: Date.now(),
        ok,
        summary,
        proposals,
    });
    logNotice({
        kind: ok ? 'info' : 'err',
        title: `🤖 任務「${task.name}」${ok ? '完成' : '失敗'}`,
        body: summary.slice(0, 200),
    });
}

// ---- triggers ----

const firedPrice = new Map<string, number>(); // taskId → last fire ts
const priceUnsubs = new Map<string, () => void>();

function rebuildPriceWatchers() {
    for (const un of priceUnsubs.values()) un();
    priceUnsubs.clear();
    for (const task of tasks) {
        if (!task.enabled || task.trigger.type !== 'price') continue;
        const trig = task.trigger;
        void ensureContract(trig.code).catch(() => undefined);
        const check = () => {
            const t = tasks.find((x) => x.id === task.id);
            if (!t || !t.enabled) return;
            const q = getQuote(trig.code);
            if (!q?.tick) return;
            const price = Number(q.tick.close);
            const hit =
                trig.condition === 'above'
                    ? price >= trig.price
                    : price <= trig.price;
            if (!hit) return;
            const last = firedPrice.get(task.id) ?? 0;
            const rearmMs = trig.rearmMinutes * 60_000;
            if (last && (rearmMs === 0 || Date.now() - last < rearmMs)) {
                return;
            }
            firedPrice.set(task.id, Date.now());
            if (trig.rearmMinutes === 0) setTaskEnabled(task.id, false);
            void runTaskNow(
                t,
                `${trig.code} 價格 ${price} 已${trig.condition === 'above' ? '漲破' : '跌破'} ${trig.price}`,
            );
        };
        priceUnsubs.set(task.id, subscribeQuoteStore(trig.code, check));
    }
}

let started = false;

// resident observation task: watches the user's operation log daily and
// converges recurring workflows into skills（一次性播種，使用者可關閉/刪除）
const OBSERVE_SEEDED_KEY = 'sj-agent-observe-seeded';

function seedObservationTask() {
    try {
        if (localStorage.getItem(OBSERVE_SEEDED_KEY)) return;
        localStorage.setItem(OBSERVE_SEEDED_KEY, '1');
    } catch {
        return;
    }
    if (tasks.some((t) => t.name === '工作流程觀察')) return;
    saveTask({
        name: '工作流程觀察',
        prompt: '執行技能「操作觀察學習」：用 get_user_activity 看今天的操作軌跡，找重複 workflow，收斂成 save_skill 技能。',
        trigger: { type: 'daily', time: '13:50' },
        policy: 'readonly',
        enabled: true,
    });
}

export function ensureAgentScheduler() {
    if (started) return;
    started = true;
    seedObservationTask();
    rebuildPriceWatchers();

    // minute tick: daily + interval triggers
    setInterval(() => {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        for (const task of tasks) {
            if (!task.enabled) continue;
            const sinceLast = Date.now() - (task.lastRunAt ?? 0);
            if (task.trigger.type === 'daily') {
                if (task.trigger.time === hhmm && sinceLast > 120_000) {
                    void runTaskNow(task, `每日排程 ${hhmm}`);
                }
            } else if (task.trigger.type === 'interval') {
                if (sinceLast >= task.trigger.minutes * 60_000) {
                    void runTaskNow(task, `每 ${task.trigger.minutes} 分鐘排程`);
                }
            }
        }
    }, 30_000);

    // order/deal events (batched 3s so a burst becomes one run)
    let evTimer: ReturnType<typeof setTimeout> | null = null;
    let evBuffer: string[] = [];
    onOrderEvent((ev) => {
        const evTasks = tasks.filter(
            (t) => t.enabled && t.trigger.type === 'order_event',
        );
        if (evTasks.length === 0) return;
        evBuffer.push(JSON.stringify(ev).slice(0, 300));
        if (evTimer) clearTimeout(evTimer);
        evTimer = setTimeout(() => {
            const ctx = `委託/成交事件：\n${evBuffer.join('\n')}`;
            evBuffer = [];
            for (const t of evTasks) void runTaskNow(t, ctx);
        }, 3000);
    });
}
