// src/components/agent-panel.tsx — AI Agent: multi-provider agentic chat
// with the built-in shioaji skill, user-defined skills (/名稱 invokes),
// scheduled & triggered tasks, run history, and provider settings.

import { Check, Play, Trash2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
    getAgentKey,
    getAgentModel,
    getAgentPolicy,
    getAgentProvider,
    setAgentKey,
    setAgentModel,
    setAgentPolicy,
    setAgentProvider,
} from '../lib/agent/config';
import { createAgentSession, type AgentSession } from '../lib/agent/runner';
import {
    deleteSkill,
    findSkill,
    saveSkill,
    useSkills,
} from '../lib/agent/skills';
import {
    deleteTask,
    runTaskNow,
    saveTask,
    setTaskEnabled,
    useAgentRuns,
    useAgentTasks,
} from '../lib/agent/tasks';
import type {
    AgentBlock,
    AgentPolicy,
    AgentProvider,
    AgentTask,
    OrderProposal,
    TaskTrigger,
} from '../lib/agent/types';
import { codexLoginStatus } from '../lib/agent/codex-auth';
import { listModels } from '../lib/agent/models';
import { ensureContract } from '../lib/contracts-cache';
import { notify, placeQuickOrder } from '../lib/trade';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './assistant-panel.css';

type Tab = 'chat' | 'skills' | 'tasks' | 'runs' | 'settings';

const TABS: { key: Tab; label: string }[] = [
    { key: 'chat', label: '對話' },
    { key: 'skills', label: '技能' },
    { key: 'tasks', label: '任務' },
    { key: 'runs', label: '紀錄' },
    { key: 'settings', label: '設定' },
];

const POLICIES: { key: AgentPolicy; label: string; hint: string }[] = [
    { key: 'readonly', label: '唯讀', hint: '只能查詢分析，無交易工具' },
    { key: 'confirm', label: '確認下單', hint: '提案卡需手動確認才送出' },
    { key: 'auto', label: '自動下單', hint: '⚠ 直接送單（受風控限制）' },
];

interface ChatTurn {
    role: 'user' | 'assistant';
    blocks: AgentBlock[];
}

function ChatTab() {
    const [turns, setTurns] = useState<ChatTurn[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [proposalDone, setProposalDone] = useState<
        Record<string, 'confirmed' | 'cancelled'>
    >({});
    const sessionRef = useRef<AgentSession | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const skills = useSkills();

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [turns, busy]);

    const send = async () => {
        let text = input.trim();
        if (!text || busy) return;
        // /技能名 → run that skill's workflow
        if (text.startsWith('/')) {
            const skill = findSkill(text.slice(1).trim());
            if (skill) {
                text = `執行技能「${skill.name}」，照以下步驟：\n${skill.instructions}`;
            }
        }
        setInput('');
        setTurns((p) => [
            ...p,
            { role: 'user', blocks: [{ type: 'text', text: input.trim() }] },
        ]);
        setBusy(true);
        try {
            if (!sessionRef.current) {
                sessionRef.current = createAgentSession();
            }
            await sessionRef.current.send(text, (blocks) =>
                setTurns((p) => [...p, { role: 'assistant', blocks }]),
            );
        } catch (e) {
            setTurns((p) => [
                ...p,
                {
                    role: 'assistant',
                    blocks: [
                        {
                            type: 'text',
                            text: `[錯誤] ${e instanceof Error ? e.message : String(e)}`,
                        },
                    ],
                },
            ]);
        } finally {
            setBusy(false);
        }
    };

    const confirm = async (id: string, p: OrderProposal) => {
        setProposalDone((s) => ({ ...s, [id]: 'confirmed' }));
        try {
            const c = await ensureContract(p.code);
            const trade = await placeQuickOrder(c, p.action, p.price, p.quantity);
            notify({
                kind: 'ok',
                title: '🤖 提案已確認下單',
                body: `${p.code} ${p.action === 'Buy' ? '買' : '賣'} ${p.quantity} @ ${p.price === null ? '市價' : fmtPrice(p.price)}（${trade.status.status}）`,
            });
        } catch (e) {
            setProposalDone((s) => {
                const next = { ...s };
                delete next[id];
                return next;
            });
            notify({
                kind: 'err',
                title: '下單失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        }
    };

    return (
        <>
            <div ref={scrollRef} className={styles.messages}>
                {turns.length === 0 && (
                    <div className={styles.emptyHint}>
                        問行情、分析持倉，或輸入 /技能名 直接執行工作流程：
                        <br />
                        {skills.map((s) => `/${s.name}`).join('　')}
                    </div>
                )}
                {turns.map((t, i) => (
                    <div
                        key={i}
                        className={t.role === 'user' ? styles.userMsg : styles.aiMsg}
                    >
                        {t.blocks.map((b, j) => {
                            if (b.type === 'text') {
                                return <span key={j}>{b.text}</span>;
                            }
                            if (b.type === 'tool') {
                                return (
                                    <span key={j} className={styles.toolNote}>
                                        <Wrench size={9} /> {b.name}
                                    </span>
                                );
                            }
                            const state = proposalDone[b.id];
                            const p = b.proposal;
                            return (
                                <div key={j} className={styles.proposalCard}>
                                    <span className={styles.proposalTitle}>
                                        下單提案
                                    </span>
                                    <span className={styles.proposalBody}>
                                        {p.action === 'Buy' ? '買進' : '賣出'}{' '}
                                        {p.code} × {p.quantity} @{' '}
                                        {p.price === null
                                            ? '市價'
                                            : fmtPrice(p.price)}
                                        <br />
                                        <span className={styles.proposalReason}>
                                            {p.reason}
                                        </span>
                                    </span>
                                    {!state ? (
                                        <div className={styles.proposalBtns}>
                                            <button
                                                className={styles.confirmBtn}
                                                onClick={() => void confirm(b.id, p)}
                                            >
                                                確認下單
                                            </button>
                                            <button
                                                className={styles.rejectBtn}
                                                onClick={() =>
                                                    setProposalDone((s) => ({
                                                        ...s,
                                                        [b.id]: 'cancelled',
                                                    }))
                                                }
                                            >
                                                取消
                                            </button>
                                        </div>
                                    ) : (
                                        <span className={styles.proposalDone}>
                                            {state === 'confirmed'
                                                ? '✓ 已確認下單'
                                                : '已取消'}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}
                {busy && <div className={styles.aiMsg}>思考中…</div>}
            </div>
            <div className={styles.inputRow}>
                <input
                    className={styles.chatInput}
                    placeholder='問行情、下指令，或 /技能名…'
                    value={input}
                    disabled={busy}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void send()}
                />
                <button
                    className={styles.sendBtn}
                    disabled={busy || !input.trim()}
                    onClick={() => void send()}
                >
                    送出
                </button>
            </div>
        </>
    );
}

function SkillsTab() {
    const skills = useSkills();
    const [editing, setEditing] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');
    const [inst, setInst] = useState('');

    const startEdit = (id?: string) => {
        const s = id ? skills.find((x) => x.id === id) : null;
        setEditing(id ?? 'new');
        setName(s?.name ?? '');
        setDesc(s?.description ?? '');
        setInst(s?.instructions ?? '');
    };

    if (editing) {
        return (
            <div className={styles.formCol}>
                <input
                    className={styles.chatInput}
                    placeholder='技能名稱（對話可用 /名稱 執行）'
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <input
                    className={styles.chatInput}
                    placeholder='一句話描述（agent 會看到）'
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                />
                <textarea
                    className={styles.formArea}
                    placeholder={'工作流程步驟，例如：\n1. get_positions 查持倉\n2. 對虧損 >5% 的部位…'}
                    value={inst}
                    onChange={(e) => setInst(e.target.value)}
                />
                <div className={styles.proposalBtns}>
                    <button
                        className={styles.confirmBtn}
                        disabled={!name.trim() || !inst.trim()}
                        onClick={() => {
                            saveSkill({
                                id: editing === 'new' ? undefined : editing,
                                name: name.trim(),
                                description: desc.trim(),
                                instructions: inst,
                            });
                            setEditing(null);
                        }}
                    >
                        儲存技能
                    </button>
                    <button
                        className={styles.rejectBtn}
                        onClick={() => setEditing(null)}
                    >
                        取消
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.listCol}>
            <span className={styles.emptyHint}>
                把你的日常 workflow 存成技能：對話輸入 /名稱 直接執行，或綁定排程任務
            </span>
            {skills.map((s) => (
                <div key={s.id} className={styles.itemRow}>
                    <button
                        className={styles.itemMain}
                        onClick={() => startEdit(s.id)}
                    >
                        <span className={styles.itemTitle}>
                            /{s.name}
                            {s.builtin && (
                                <span className={styles.itemBadge}>內建</span>
                            )}
                        </span>
                        <span className={styles.itemSub}>{s.description}</span>
                    </button>
                    {!s.builtin && (
                        <button
                            className={styles.itemIconBtn}
                            title='刪除技能'
                            onClick={() => deleteSkill(s.id)}
                        >
                            <Trash2 size={12} />
                        </button>
                    )}
                </div>
            ))}
            <button className={styles.sendBtn} onClick={() => startEdit()}>
                ＋ 新增技能
            </button>
        </div>
    );
}

function triggerLabel(t: TaskTrigger): string {
    switch (t.type) {
        case 'daily':
            return `每天 ${t.time}`;
        case 'interval':
            return `每 ${t.minutes} 分鐘`;
        case 'price':
            return `${t.code} ${t.condition === 'above' ? '≥' : '≤'} ${t.price}`;
        case 'order_event':
            return '委託/成交事件';
    }
}

function TasksTab() {
    const tasks = useAgentTasks();
    const skills = useSkills();
    const [editing, setEditing] = useState<AgentTask | 'new' | null>(null);
    // editor fields
    const [name, setName] = useState('');
    const [prompt, setPrompt] = useState('');
    const [trigType, setTrigType] = useState<TaskTrigger['type']>('daily');
    const [time, setTime] = useState('08:50');
    const [minutes, setMinutes] = useState('5');
    const [code, setCode] = useState('');
    const [cond, setCond] = useState<'above' | 'below'>('above');
    const [price, setPrice] = useState('');
    const [rearm, setRearm] = useState('0');
    const [policy, setPolicy] = useState<AgentPolicy>('readonly');

    const startEdit = (t?: AgentTask) => {
        setEditing(t ?? 'new');
        setName(t?.name ?? '');
        setPrompt(t?.prompt ?? '');
        setPolicy(t?.policy ?? 'readonly');
        const trig = t?.trigger;
        setTrigType(trig?.type ?? 'daily');
        if (trig?.type === 'daily') setTime(trig.time);
        if (trig?.type === 'interval') setMinutes(String(trig.minutes));
        if (trig?.type === 'price') {
            setCode(trig.code);
            setCond(trig.condition);
            setPrice(String(trig.price));
            setRearm(String(trig.rearmMinutes));
        }
    };

    if (editing) {
        const trigger: TaskTrigger =
            trigType === 'daily'
                ? { type: 'daily', time }
                : trigType === 'interval'
                  ? { type: 'interval', minutes: Math.max(1, Number(minutes) || 5) }
                  : trigType === 'price'
                    ? {
                          type: 'price',
                          code: code.toUpperCase(),
                          condition: cond,
                          price: Number(price) || 0,
                          rearmMinutes: Math.max(0, Number(rearm) || 0),
                      }
                    : { type: 'order_event' };
        return (
            <div className={styles.formCol}>
                <input
                    className={styles.chatInput}
                    placeholder='任務名稱'
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <select
                    className={styles.formSelect}
                    value=''
                    onChange={(e) => {
                        const s = skills.find((x) => x.id === e.target.value);
                        if (s) {
                            setPrompt(
                                `執行技能「${s.name}」：\n${s.instructions}`,
                            );
                            if (!name) setName(s.name);
                        }
                    }}
                >
                    <option value=''>（可選）從技能帶入指示…</option>
                    {skills.map((s) => (
                        <option key={s.id} value={s.id}>
                            /{s.name} — {s.description}
                        </option>
                    ))}
                </select>
                <textarea
                    className={styles.formArea}
                    placeholder='要 agent 做什麼（任務每次觸發都執行這段指示）'
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                />
                <div className={styles.formRow}>
                    <select
                        className={styles.formSelect}
                        value={trigType}
                        onChange={(e) =>
                            setTrigType(e.target.value as TaskTrigger['type'])
                        }
                    >
                        <option value='daily'>每天定時</option>
                        <option value='interval'>每 N 分鐘</option>
                        <option value='price'>到價觸發</option>
                        <option value='order_event'>委託/成交事件</option>
                    </select>
                    {trigType === 'daily' && (
                        <input
                            className={styles.chatInput}
                            type='time'
                            value={time}
                            onChange={(e) => setTime(e.target.value)}
                        />
                    )}
                    {trigType === 'interval' && (
                        <input
                            className={styles.chatInput}
                            placeholder='分鐘'
                            value={minutes}
                            inputMode='numeric'
                            onChange={(e) => setMinutes(e.target.value)}
                        />
                    )}
                </div>
                {trigType === 'price' && (
                    <div className={styles.formRow}>
                        <input
                            className={styles.chatInput}
                            placeholder='代碼'
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                        />
                        <select
                            className={styles.formSelect}
                            value={cond}
                            onChange={(e) =>
                                setCond(e.target.value as 'above' | 'below')
                            }
                        >
                            <option value='above'>漲破 ≥</option>
                            <option value='below'>跌破 ≤</option>
                        </select>
                        <input
                            className={styles.chatInput}
                            placeholder='價格'
                            value={price}
                            inputMode='decimal'
                            onChange={(e) => setPrice(e.target.value)}
                        />
                        <input
                            className={styles.chatInput}
                            placeholder='重置分鐘(0=一次)'
                            title='觸發後幾分鐘可再次觸發；0 = 觸發一次後停用'
                            value={rearm}
                            inputMode='numeric'
                            onChange={(e) => setRearm(e.target.value)}
                        />
                    </div>
                )}
                <div className={styles.formRow}>
                    {POLICIES.map((p) => (
                        <button
                            key={p.key}
                            className={
                                policy === p.key
                                    ? styles.confirmBtn
                                    : styles.rejectBtn
                            }
                            title={p.hint}
                            onClick={() => setPolicy(p.key)}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
                {policy === 'auto' && (
                    <span className={styles.warnLine}>
                        ⚠ 自動下單會直接送出委託（仍受風控引擎限制），盈虧自負
                    </span>
                )}
                <div className={styles.proposalBtns}>
                    <button
                        className={styles.confirmBtn}
                        disabled={!name.trim() || !prompt.trim()}
                        onClick={() => {
                            saveTask({
                                id: editing === 'new' ? undefined : editing.id,
                                name: name.trim(),
                                prompt,
                                trigger,
                                policy,
                                enabled:
                                    editing === 'new'
                                        ? true
                                        : editing.enabled,
                            });
                            setEditing(null);
                        }}
                    >
                        儲存任務
                    </button>
                    <button
                        className={styles.rejectBtn}
                        onClick={() => setEditing(null)}
                    >
                        取消
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.listCol}>
            {tasks.length === 0 && (
                <span className={styles.emptyHint}>
                    排程或事件觸發的 agent 任務：每天看庫存、每 5 分鐘巡價、到價自動分析/操作…
                </span>
            )}
            {tasks.map((t) => (
                <div key={t.id} className={styles.itemRow}>
                    <button
                        className={styles.itemMain}
                        onClick={() => startEdit(t)}
                    >
                        <span className={styles.itemTitle}>
                            {t.name}
                            <span className={styles.itemBadge}>
                                {triggerLabel(t.trigger)}
                            </span>
                            <span className={styles.itemBadge}>
                                {POLICIES.find((p) => p.key === t.policy)?.label}
                            </span>
                        </span>
                        <span className={styles.itemSub}>
                            {t.lastRunAt
                                ? `上次執行 ${new Date(t.lastRunAt).toLocaleTimeString('en-GB')}`
                                : '尚未執行'}
                        </span>
                    </button>
                    <button
                        className={styles.itemIconBtn}
                        title='立即執行一次'
                        onClick={() => void runTaskNow(t, '手動執行')}
                    >
                        <Play size={12} />
                    </button>
                    <button
                        className={
                            t.enabled ? styles.toggleOn : styles.toggleOff
                        }
                        title={t.enabled ? '停用' : '啟用'}
                        onClick={() => setTaskEnabled(t.id, !t.enabled)}
                    >
                        {t.enabled ? <Check size={12} /> : <X size={12} />}
                    </button>
                    <button
                        className={styles.itemIconBtn}
                        title='刪除任務'
                        onClick={() => deleteTask(t.id)}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            ))}
            <button className={styles.sendBtn} onClick={() => startEdit()}>
                ＋ 新增任務
            </button>
        </div>
    );
}

function RunsTab() {
    const runs = useAgentRuns();
    const [open, setOpen] = useState<string | null>(null);
    return (
        <div className={styles.listCol}>
            {runs.length === 0 && (
                <span className={styles.emptyHint}>尚無執行紀錄</span>
            )}
            {runs.map((r) => (
                <div key={r.id} className={styles.itemRow}>
                    <button
                        className={styles.itemMain}
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                    >
                        <span className={styles.itemTitle}>
                            {r.ok ? '✓' : '✕'} {r.name}
                            {r.proposals > 0 && (
                                <span className={styles.itemBadge}>
                                    {r.proposals} 提案待確認
                                </span>
                            )}
                        </span>
                        <span className={styles.itemSub}>
                            {new Date(r.at).toLocaleString('en-GB')}
                            {open === r.id && (
                                <>
                                    <br />
                                    {r.summary}
                                </>
                            )}
                        </span>
                    </button>
                </div>
            ))}
        </div>
    );
}

function SettingsTab() {
    const [provider, setProvider] = useState<AgentProvider>(getAgentProvider);
    const [model, setModel] = useState(() => getAgentModel(getAgentProvider()));
    const [keyAnth, setKeyAnth] = useState(() => getAgentKey('anthropic'));
    const [keyOa, setKeyOa] = useState(() => getAgentKey('openai'));
    const [policy, setPolicyState] = useState<AgentPolicy>(getAgentPolicy);
    const [models, setModels] = useState<string[]>([]);
    const [codexStatus, setCodexStatus] = useState('檢查登入狀態…');

    // available models come from the provider's API, not user guessing
    useEffect(() => {
        let cancelled = false;
        setModels([]);
        listModels(provider)
            .then((m) => !cancelled && setModels(m))
            .catch(() => undefined);
        if (provider === 'codex') {
            codexLoginStatus().then(
                (s) => !cancelled && setCodexStatus(s),
            );
        }
        return () => {
            cancelled = true;
        };
    }, [provider, keyAnth, keyOa]);

    return (
        <div className={styles.formCol}>
            <span className={styles.itemSub}>Provider</span>
            <div className={styles.formRow}>
                {(
                    [
                        ['anthropic', 'Claude API'],
                        ['openai', 'OpenAI API'],
                        ['codex', 'Codex 訂閱'],
                    ] as [AgentProvider, string][]
                ).map(([p, label]) => (
                    <button
                        key={p}
                        className={
                            provider === p ? styles.confirmBtn : styles.rejectBtn
                        }
                        onClick={() => {
                            setProvider(p);
                            setAgentProvider(p);
                            setModel(getAgentModel(p));
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {provider === 'codex' && (
                <span className={styles.itemSub}>
                    使用 Codex CLI 的 ChatGPT 登入（~/.codex/auth.json），
                    額度計入訂閱方案 — {codexStatus}
                </span>
            )}
            <span className={styles.itemSub}>模型</span>
            {models.length > 0 ? (
                <select
                    className={styles.formSelect}
                    value={model}
                    onChange={(e) => {
                        setModel(e.target.value);
                        setAgentModel(provider, e.target.value);
                    }}
                >
                    {!models.includes(model) && (
                        <option value={model}>{model}</option>
                    )}
                    {models.map((m) => (
                        <option key={m} value={m}>
                            {m}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    className={styles.chatInput}
                    value={model}
                    placeholder='填入金鑰後自動載入模型清單'
                    onChange={(e) => {
                        setModel(e.target.value);
                        setAgentModel(provider, e.target.value.trim());
                    }}
                />
            )}
            {provider === 'anthropic' && (
                <>
                    <span className={styles.itemSub}>
                        Anthropic API Key（存本機）
                    </span>
                    <input
                        className={styles.chatInput}
                        type='password'
                        placeholder='sk-ant-…'
                        value={keyAnth}
                        onChange={(e) => {
                            setKeyAnth(e.target.value);
                            setAgentKey('anthropic', e.target.value.trim());
                        }}
                    />
                </>
            )}
            {provider === 'openai' && (
                <>
                    <span className={styles.itemSub}>
                        OpenAI API Key（存本機）
                    </span>
                    <input
                        className={styles.chatInput}
                        type='password'
                        placeholder='sk-…'
                        value={keyOa}
                        onChange={(e) => {
                            setKeyOa(e.target.value);
                            setAgentKey('openai', e.target.value.trim());
                        }}
                    />
                </>
            )}
            <span className={styles.itemSub}>預設權限（對話使用）</span>
            <div className={styles.formRow}>
                {POLICIES.map((p) => (
                    <button
                        key={p.key}
                        className={
                            policy === p.key
                                ? styles.confirmBtn
                                : styles.rejectBtn
                        }
                        title={p.hint}
                        onClick={() => {
                            setPolicyState(p.key);
                            setAgentPolicy(p.key);
                        }}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            <span className={styles.warnLine}>
                OpenAI 在瀏覽器版因 CORS 僅桌面版可用；金鑰只存於本機，直連官方 API
            </span>
        </div>
    );
}

export function AgentPanel() {
    const [tab, setTab] = useState<Tab>('chat');
    return (
        <div className={styles.wrap}>
            <div className={styles.tabBar}>
                {TABS.map((t) => (
                    <button
                        key={t.key}
                        className={
                            tab === t.key ? styles.tabOn : styles.tabOff
                        }
                        onClick={() => setTab(t.key)}
                    >
                        {t.label}
                    </button>
                ))}
            </div>
            {tab === 'chat' && <ChatTab />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'tasks' && <TasksTab />}
            {tab === 'runs' && <RunsTab />}
            {tab === 'settings' && <SettingsTab />}
            <span className={styles.disclaimer}>
                AI 分析僅供參考；確認模式下單需手動點擊，自動模式風險自負
            </span>
        </div>
    );
}

