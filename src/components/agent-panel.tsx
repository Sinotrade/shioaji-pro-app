// src/components/agent-panel.tsx — AI Agent: multi-provider agentic chat
// with the built-in shioaji skill, user-defined skills (/名稱 invokes),
// scheduled & triggered tasks, run history, and provider settings.

import {
    Brain,
    Check,
    ChevronRight,
    GitBranch,
    History,
    Package,
    Play,
    Plus,
    RefreshCw,
    Trash2,
    Wrench,
    X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    deleteSession,
    forkSession,
    getCurrentSessionId,
    getSession,
    historyForPreload,
    isHydrated,
    listSessions,
    newSessionId,
    saveSession,
    setCurrentSessionId,
    subscribeSessions,
    titleFrom,
    type ChatTurn,
} from '../lib/agent/sessions';
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
import {
    ensureShioajiPackage,
    getPackages,
    installFromRepo,
    removePackage,
    subscribePackages,
} from '../lib/agent/marketplace';
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

// proposals restored from a saved session are expired — prices are stale,
// they must never be re-confirmable
function expiredProposals(
    turns: ChatTurn[],
): Record<string, 'confirmed' | 'cancelled'> {
    const out: Record<string, 'confirmed' | 'cancelled'> = {};
    for (const t of turns)
        for (const b of t.blocks)
            if (b.type === 'proposal') out[b.id] = 'cancelled';
    return out;
}

function relTime(ts: number): string {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return `${m} 分鐘前`;
    if (m < 60 * 24) return `${Math.round(m / 60)} 小時前`;
    return `${Math.round(m / 1440)} 天前`;
}

// ---- Claude-Code-style tool rows: collapsed one-liner, click to expand ----

function briefArgs(args?: string): string {
    if (!args) return '';
    try {
        const o = JSON.parse(args) as Record<string, unknown>;
        return Object.entries(o)
            .slice(0, 3)
            .map(
                ([k, v]) =>
                    `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`,
            )
            .join(' ');
    } catch {
        return '';
    }
}

function pretty(json?: string): string {
    if (!json) return '';
    try {
        return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
        return json;
    }
}

type ToolBlockT = Extract<AgentBlock, { type: 'tool' }>;

// flatten chat turns into render items, merging consecutive calls of the
// same tool into one stacked group（get_quote ×9 → 一列收合）
type RenderItem =
    | { kind: 'user'; turnIndex: number; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tools'; name: string; calls: ToolBlockT[] }
    | { kind: 'proposal'; id: string; proposal: OrderProposal };

function toRenderItems(turns: ChatTurn[]): RenderItem[] {
    const out: RenderItem[] = [];
    turns.forEach((t, turnIndex) => {
        if (t.role === 'user') {
            out.push({
                kind: 'user',
                turnIndex,
                text: t.blocks
                    .map((b) => (b.type === 'text' ? b.text : ''))
                    .join(''),
            });
            return;
        }
        for (const b of t.blocks) {
            if (b.type === 'text') out.push({ kind: 'text', text: b.text });
            else if (b.type === 'thinking')
                out.push({ kind: 'thinking', text: b.text });
            else if (b.type === 'proposal')
                out.push({ kind: 'proposal', id: b.id, proposal: b.proposal });
            else {
                const last = out[out.length - 1];
                if (last && last.kind === 'tools' && last.name === b.name) {
                    last.calls.push(b);
                } else {
                    out.push({ kind: 'tools', name: b.name, calls: [b] });
                }
            }
        }
    });
    return out;
}

function ToolGroup({ name, calls }: { name: string; calls: ToolBlockT[] }) {
    if (calls.length === 1) return <ToolRow b={calls[0]!} />;
    const anyErr = calls.some((c) => c.isError);
    // one-line preview: the distinguishing arg of each call (e.g. codes)
    const brief = calls
        .map((c) => {
            try {
                const o = JSON.parse(c.args || '{}') as Record<string, unknown>;
                const v = o.code ?? o.codes ?? Object.values(o)[0];
                return typeof v === 'string' ? v : JSON.stringify(v);
            } catch {
                return '';
            }
        })
        .filter(Boolean)
        .join(' ');
    return (
        <details className={styles.toolRow}>
            <summary className={styles.toolHead}>
                <ChevronRight size={10} className={styles.toolChevron} />
                <span
                    className={anyErr ? styles.toolDotErr : styles.toolDotOk}
                />
                <Wrench size={10} />
                <span className={styles.toolName}>
                    {name} ×{calls.length}
                </span>
                <span className={styles.toolBrief}>{brief}</span>
            </summary>
            <div className={styles.toolDetail}>
                {calls.map((c, i) => (
                    <ToolRow key={i} b={c} />
                ))}
            </div>
        </details>
    );
}

function ToolRow({ b }: { b: Extract<AgentBlock, { type: 'tool' }> }) {
    return (
        <details className={styles.toolRow}>
            <summary className={styles.toolHead}>
                <ChevronRight size={10} className={styles.toolChevron} />
                <span
                    className={b.isError ? styles.toolDotErr : styles.toolDotOk}
                />
                <Wrench size={10} />
                <span className={styles.toolName}>{b.name}</span>
                <span className={styles.toolBrief}>
                    {briefArgs(b.args) || b.summary}
                </span>
            </summary>
            <div className={styles.toolDetail}>
                {b.args && b.args !== '{}' && (
                    <>
                        <span className={styles.toolDetailLabel}>參數</span>
                        <pre className={styles.toolPre}>{pretty(b.args)}</pre>
                    </>
                )}
                <span className={styles.toolDetailLabel}>
                    {b.isError ? '錯誤' : '結果'}
                </span>
                <pre className={styles.toolPre}>
                    {pretty(b.result) || b.summary}
                </pre>
            </div>
        </details>
    );
}

function ThinkingRow({ text }: { text: string }) {
    return (
        <details className={styles.thinkRow}>
            <summary className={styles.thinkHead}>
                <ChevronRight size={10} className={styles.toolChevron} />
                <Brain size={10} /> 思考過程
            </summary>
            <div className={styles.thinkBody}>{text}</div>
        </details>
    );
}

function ChatTab() {
    const [sessionId, setSessionId] = useState(
        () => getCurrentSessionId() || newSessionId(),
    );
    const [turns, setTurns] = useState<ChatTurn[]>(
        () => getSession(getCurrentSessionId())?.turns ?? [],
    );
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [, bumpList] = useState(0); // refresh history list after delete
    const [proposalDone, setProposalDone] = useState<
        Record<string, 'confirmed' | 'cancelled'>
    >(() => expiredProposals(getSession(getCurrentSessionId())?.turns ?? []));
    const sessionRef = useRef<AgentSession | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const touched = useRef(false); // user started a new conversation
    const skills = useSkills();

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [turns, busy]);

    // desktop loads sessions from disk asynchronously — once hydrated, restore
    // the last conversation, but never clobber one the user already started
    useEffect(() => {
        const restore = () => {
            if (touched.current || turns.length > 0) return;
            const cur = getCurrentSessionId();
            const s = cur ? getSession(cur) : null;
            if (s && s.turns.length) {
                setSessionId(cur);
                setTurns(s.turns);
                setProposalDone(expiredProposals(s.turns));
            }
        };
        if (!isHydrated()) restore();
        return subscribeSessions(restore);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // autosave the conversation on every turn
    useEffect(() => {
        if (turns.length === 0) return;
        saveSession({
            id: sessionId,
            provider: getAgentProvider(),
            model: getAgentModel(getAgentProvider()),
            createdAt: Date.now(),
            turns,
        });
        setCurrentSessionId(sessionId);
    }, [turns, sessionId]);

    // switch to a session (resume): restore turns, expire its proposals,
    // and rebuild the provider context on next send
    const openSession = (id: string) => {
        if (busy) return;
        const s = getSession(id);
        setSessionId(id);
        setTurns(s?.turns ?? []);
        setProposalDone(expiredProposals(s?.turns ?? []));
        setCurrentSessionId(id);
        sessionRef.current = null;
        setShowHistory(false);
    };

    const newChat = () => {
        if (busy) return;
        touched.current = true;
        const id = newSessionId();
        setSessionId(id);
        setTurns([]);
        setProposalDone({});
        setCurrentSessionId('');
        sessionRef.current = null;
        setShowHistory(false);
    };

    // fork: duplicate (optionally up to a turn index) and switch to the copy
    const doFork = (uptoTurn?: number) => {
        if (busy || turns.length === 0) return;
        const fork = forkSession(sessionId, uptoTurn);
        if (fork) openSession(fork.id);
    };

    const renderItems = useMemo(() => toRenderItems(turns), [turns]);

    // `/` opens a skill palette (Claude Code style slash commands)
    const slashQuery = input.startsWith('/')
        ? input.slice(1).trim().toLowerCase()
        : null;
    const slashMatches = useMemo(
        () =>
            slashQuery === null
                ? []
                : skills
                      .filter(
                          (s) =>
                              s.name.toLowerCase().includes(slashQuery) ||
                              s.description
                                  .toLowerCase()
                                  .includes(slashQuery),
                      )
                      .slice(0, 8),
        [slashQuery, skills],
    );
    const [slashIdx, setSlashIdx] = useState(0);
    useEffect(() => setSlashIdx(0), [input]);

    const send = async (overrideText?: string) => {
        let text = (overrideText ?? input).trim();
        if (!text || busy) return;
        touched.current = true; // disk hydrate must not clobber a live chat
        // /技能名 → run that skill's workflow
        if (text.startsWith('/')) {
            const skill = findSkill(text.slice(1).trim());
            if (skill) {
                text = `執行技能「${skill.name}」，照以下步驟：\n${skill.instructions}`;
            }
        }
        const displayText = (overrideText ?? input).trim();
        setInput('');
        const prior = turns;
        setTurns((p) => [
            ...p,
            { role: 'user', blocks: [{ type: 'text', text: displayText }] },
        ]);
        setBusy(true);
        try {
            if (!sessionRef.current) {
                // resumed/forked conversations replay their transcript
                sessionRef.current = createAgentSession(
                    undefined,
                    historyForPreload(prior),
                );
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

    const sessions = showHistory ? listSessions() : [];

    return (
        <>
            <div className={styles.sessionBar}>
                <button
                    className={styles.sessionIconBtn}
                    title='對話紀錄'
                    onClick={() => setShowHistory((v) => !v)}
                >
                    <History size={12} />
                </button>
                <span className={styles.sessionTitleTxt}>
                    {showHistory
                        ? `對話紀錄（${listSessions().length}）`
                        : turns.length > 0
                          ? titleFrom(turns)
                          : '新對話'}
                </span>
                <button
                    className={styles.sessionIconBtn}
                    title='分岔目前對話'
                    disabled={busy || turns.length === 0}
                    onClick={() => doFork()}
                >
                    <GitBranch size={12} />
                </button>
                <button
                    className={styles.sessionIconBtn}
                    title='新對話'
                    disabled={busy}
                    onClick={newChat}
                >
                    <Plus size={12} />
                </button>
            </div>
            {showHistory ? (
                <div className={styles.messages}>
                    {sessions.length === 0 && (
                        <div className={styles.emptyHint}>還沒有對話紀錄</div>
                    )}
                    {sessions.map((s) => (
                        <div key={s.id} className={styles.sessRow}>
                            <button
                                className={styles.sessMain}
                                onClick={() => openSession(s.id)}
                                title='繼續這段對話'
                            >
                                <span className={styles.sessTitle}>
                                    {s.id === sessionId ? '● ' : ''}
                                    {s.title || titleFrom(s.turns)}
                                </span>
                                <span className={styles.sessMeta}>
                                    {relTime(s.updatedAt)} · {s.turns.length} 則
                                    · {s.provider}
                                </span>
                            </button>
                            <button
                                className={styles.sessionIconBtn}
                                title='分岔成新對話'
                                onClick={() => {
                                    const f = forkSession(s.id);
                                    if (f) openSession(f.id);
                                }}
                            >
                                <GitBranch size={11} />
                            </button>
                            <button
                                className={styles.sessionIconBtn}
                                title='刪除'
                                onClick={() => {
                                    deleteSession(s.id);
                                    if (s.id === sessionId) {
                                        newChat();
                                        setShowHistory(true);
                                    }
                                    bumpList((v) => v + 1);
                                }}
                            >
                                <Trash2 size={11} />
                            </button>
                        </div>
                    ))}
                </div>
            ) : (
            <div ref={scrollRef} className={styles.messages}>
                {turns.length === 0 && (
                    <div className={styles.emptyHint}>
                        問行情、分析持倉，或輸入 /技能名 直接執行工作流程：
                        <br />
                        {skills.map((s) => `/${s.name}`).join('　')}
                    </div>
                )}
                {renderItems.map((it, i) => {
                    if (it.kind === 'user') {
                        return (
                            <div key={i} className={styles.userMsg}>
                                <button
                                    className={styles.msgForkBtn}
                                    title='從這裡分岔（不含此訊息之後的內容）'
                                    disabled={busy}
                                    onClick={() => doFork(it.turnIndex)}
                                >
                                    <GitBranch size={10} />
                                </button>
                                <span>{it.text}</span>
                            </div>
                        );
                    }
                    if (it.kind === 'text') {
                        return (
                            <div key={i} className={styles.aiMsg}>
                                <div className={styles.mdBody}>
                                    <Markdown remarkPlugins={[remarkGfm]}>
                                        {it.text}
                                    </Markdown>
                                </div>
                            </div>
                        );
                    }
                    if (it.kind === 'thinking') {
                        return <ThinkingRow key={i} text={it.text} />;
                    }
                    if (it.kind === 'tools') {
                        return (
                            <ToolGroup
                                key={i}
                                name={it.name}
                                calls={it.calls}
                            />
                        );
                    }
                    const state = proposalDone[it.id];
                    const p = it.proposal;
                    return (
                        <div key={i} className={styles.proposalCard}>
                            <span className={styles.proposalTitle}>
                                下單提案
                            </span>
                            <span className={styles.proposalBody}>
                                {p.action === 'Buy' ? '買進' : '賣出'} {p.code}{' '}
                                × {p.quantity} @{' '}
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
                                        onClick={() => void confirm(it.id, p)}
                                    >
                                        確認下單
                                    </button>
                                    <button
                                        className={styles.rejectBtn}
                                        onClick={() =>
                                            setProposalDone((s) => ({
                                                ...s,
                                                [it.id]: 'cancelled',
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
                {busy && <div className={styles.aiMsg}>思考中…</div>}
            </div>
            )}
            <div className={styles.inputRow} style={{ position: 'relative' }}>
                {slashMatches.length > 0 && (
                    <div className={styles.slashMenu}>
                        {slashMatches.map((s, i) => (
                            <button
                                key={s.id}
                                className={
                                    styles.slashItem[
                                        i === slashIdx ? 'on' : 'off'
                                    ]
                                }
                                onMouseEnter={() => setSlashIdx(i)}
                                onClick={() => void send(`/${s.name}`)}
                            >
                                <span className={styles.slashName}>
                                    /{s.name}
                                </span>
                                <span className={styles.slashDesc}>
                                    {s.description}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
                <input
                    className={styles.chatInput}
                    placeholder='分析持倉、巡檢風險、自動化流程，或 / 執行技能…'
                    value={input}
                    disabled={busy}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (slashMatches.length > 0) {
                            if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                setSlashIdx(
                                    (v) => (v + 1) % slashMatches.length,
                                );
                                return;
                            }
                            if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                setSlashIdx(
                                    (v) =>
                                        (v - 1 + slashMatches.length) %
                                        slashMatches.length,
                                );
                                return;
                            }
                            if (e.key === 'Tab') {
                                e.preventDefault();
                                setInput(
                                    `/${slashMatches[slashIdx]!.name}`,
                                );
                                return;
                            }
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                void send(
                                    `/${slashMatches[slashIdx]!.name}`,
                                );
                                return;
                            }
                            if (e.key === 'Escape') {
                                setInput('');
                                return;
                            }
                        }
                        if (e.key === 'Enter') void send();
                    }}
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
            <MarketplaceSection />
        </div>
    );
}

// skill packages installed from a Claude-plugin style marketplace repo
function MarketplaceSection() {
    const [, bump] = useState(0);
    const [repo, setRepo] = useState('Sinotrade/Shioaji');
    const [installing, setInstalling] = useState(false);
    const [msg, setMsg] = useState('');

    useEffect(() => subscribePackages(() => bump((v) => v + 1)), []);
    const pkgs = getPackages();

    const install = async () => {
        setInstalling(true);
        setMsg('');
        try {
            const res = await installFromRepo(repo);
            setMsg(`✓ 已安裝：${res.installed.join('、')}`);
        } catch (e) {
            setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setInstalling(false);
        }
    };

    return (
        <>
            <span className={styles.itemSub} style={{ marginTop: '8px' }}>
                技能市集（Claude plugin marketplace 格式）
            </span>
            {pkgs.map((p) => (
                <div key={p.id} className={styles.itemRow}>
                    <div className={styles.itemMain}>
                        <span className={styles.itemTitle}>
                            <Package size={11} /> {p.name}
                            <span className={styles.itemSub}>
                                {' '}
                                {p.repo}@{p.version} ·{' '}
                                {p.references.length} 份文件
                            </span>
                        </span>
                        <span className={styles.itemSub}>
                            {p.description.slice(0, 80)}
                        </span>
                    </div>
                    <button
                        className={styles.itemIconBtn}
                        title='重新安裝（更新）'
                        disabled={installing}
                        onClick={() => {
                            setRepo(p.repo);
                            void install();
                        }}
                    >
                        <RefreshCw size={11} />
                    </button>
                    <button
                        className={styles.itemIconBtn}
                        title='移除技能包'
                        onClick={() => removePackage(p.id)}
                    >
                        <Trash2 size={11} />
                    </button>
                </div>
            ))}
            <div className={styles.formRow}>
                <input
                    className={styles.chatInput}
                    placeholder='owner/repo，如 Sinotrade/Shioaji'
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                />
                <button
                    className={styles.sendBtn}
                    disabled={installing || !repo.trim()}
                    onClick={() => void install()}
                >
                    {installing ? '安裝中…' : '安裝'}
                </button>
            </div>
            {msg && <span className={styles.itemSub}>{msg}</span>}
        </>
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
    // pre-install the shioaji skill package once（背景靜默）
    useEffect(() => {
        ensureShioajiPackage();
    }, []);
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

