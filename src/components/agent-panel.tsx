import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Circle, RotateCcw, Send, ShieldCheck } from 'lucide-react';
import {
    fetchAgentStatus,
    startAgentConversation,
    streamAgentMessage,
    type AgentStatus,
} from '../lib/kgi-agent';
import * as styles from './agent-panel.css';

type ChatMessage =
    | { id: string; role: 'user'; content: string }
    | {
          id: string;
          role: 'assistant';
          content: string;
          streaming?: boolean;
          error?: boolean;
      };

export function AgentPanel({
    selectedCode,
}: {
    selectedCode?: string | null;
    onPick?: (code: string) => void;
}) {
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<AgentStatus | null>(null);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [threadId, setThreadId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            id: 'codex-welcome',
            role: 'assistant',
            content:
                'Codex 已連接到這個交易終端。這個 Phase 只提供聊天，不會使用 KGI 工具，也不會執行交易。',
        },
    ]);
    const bottomRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        let alive = true;
        async function refresh() {
            try {
                const nextStatus = await fetchAgentStatus();
                if (!alive) return;
                setStatus(nextStatus);
            } catch (error: unknown) {
                if (!alive) return;
                setStatus((current) =>
                    current
                        ? { ...current, connected: false }
                        : {
                              connected: false,
                              authenticated: false,
                              model: null,
                              models: [],
                              error:
                                  error instanceof Error
                                      ? error.message
                                      : String(error),
                          },
                );
            }
        }
        void refresh();
        const timer = window.setInterval(refresh, 15000);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [messages, busy]);

    async function send(text: string) {
        const trimmed = text.trim();
        if (!trimmed || busy) return;
        const assistantId = `assistant-${Date.now()}`;
        setMessages((current) => [
            ...current,
            { id: `user-${Date.now()}`, role: 'user', content: trimmed },
            { id: assistantId, role: 'assistant', content: '', streaming: true },
        ]);
        setInput('');
        setBusy(true);
        try {
            await streamAgentMessage(
                trimmed,
                { selectedCode, conversationId, threadId },
                (event) => {
                    if (event.type === 'conversation') {
                        setConversationId(event.conversation_id);
                        setThreadId(event.thread_id);
                        setStatus((current) =>
                            current
                                ? { ...current, model: event.model ?? current.model }
                                : current,
                        );
                        return;
                    }
                    if (event.type === 'assistant_delta') {
                        setMessages((current) =>
                            updateAssistant(current, assistantId, (message) => ({
                                ...message,
                                content: message.content + event.delta,
                            })),
                        );
                        return;
                    }
                    if (event.type === 'turn_completed') {
                        setConversationId(event.conversation_id);
                        setThreadId(event.thread_id);
                        setMessages((current) =>
                            updateAssistant(current, assistantId, (message) => ({
                                ...message,
                                content: event.content || message.content,
                                streaming: false,
                            })),
                        );
                        return;
                    }
                    if (event.type === 'warning') {
                        setMessages((current) =>
                            updateAssistant(current, assistantId, (message) => ({
                                ...message,
                                content:
                                    message.content ||
                                    `Codex 提示：${event.message}`,
                            })),
                        );
                        return;
                    }
                    if (event.type === 'error') {
                        setMessages((current) =>
                            updateAssistant(current, assistantId, (message) => ({
                                ...message,
                                content:
                                    message.content ||
                                    `Codex disconnected: ${event.message}`,
                                streaming: false,
                                error: true,
                            })),
                        );
                    }
                },
            );
        } catch (error) {
            setMessages((current) =>
                updateAssistant(current, assistantId, (message) => ({
                    ...message,
                    content:
                        error instanceof Error
                            ? `Codex disconnected: ${error.message}`
                            : 'Codex disconnected',
                    streaming: false,
                    error: true,
                })),
            );
        } finally {
            setBusy(false);
        }
    }

    async function newConversation() {
        if (busy) return;
        try {
            const next = await startAgentConversation();
            setConversationId(next.conversation_id);
            setThreadId(next.thread_id);
            setMessages([
                {
                    id: `codex-new-${Date.now()}`,
                    role: 'assistant',
                    content: '已建立新的 Codex 對話。',
                },
            ]);
        } catch (error) {
            setMessages((current) => [
                ...current,
                {
                    id: `codex-new-error-${Date.now()}`,
                    role: 'assistant',
                    content:
                        error instanceof Error
                            ? `無法建立新對話：${error.message}`
                            : '無法建立新對話',
                    error: true,
                },
            ]);
        }
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send(input);
        }
    }

    const threadLabel = threadId ? `${threadId.slice(0, 8)}...` : 'new';
    const footerText =
        status?.error ??
        (selectedCode ? `目前選取 ${selectedCode}` : '輸入訊息開始對話');

    return (
        <div className={styles.shell}>
            <div className={styles.statusBar}>
                <span className={styles.badge}>
                    <ShieldCheck size={13} />
                    Chat Only
                </span>
                <span className={styles.badge}>
                    <Circle
                        size={9}
                        fill={status?.connected ? 'currentColor' : 'none'}
                    />
                    {status?.connected ? 'Codex Connected' : 'Disconnected'}
                </span>
                <span className={styles.badge}>{status?.model ?? 'model'}</span>
                <span className={styles.badge}>thread {threadLabel}</span>
                <span className={styles.mutedText}>{footerText}</span>
            </div>

            <div className={styles.quickRow}>
                <button
                    className={styles.quickButton}
                    disabled={busy}
                    onClick={() => void newConversation()}
                    type="button"
                >
                    <RotateCcw size={13} />
                    New Conversation
                </button>
            </div>

            <div className={styles.transcript}>
                {messages.map((message) => (
                    <div
                        key={message.id}
                        className={`${styles.message} ${
                            message.role === 'user' ? styles.messageUser : ''
                        }`}
                    >
                        <div
                            className={`${styles.bubble} ${
                                message.role === 'user' ? styles.userBubble : ''
                            } ${
                                message.role === 'assistant' && message.error
                                    ? styles.errorBubble
                                    : ''
                            }`}
                        >
                            {message.role === 'assistant' && (
                                <Bot
                                    size={14}
                                    style={{
                                        marginRight: 6,
                                        verticalAlign: '-2px',
                                    }}
                                />
                            )}
                            {message.content}
                            {message.role === 'assistant' &&
                            message.streaming &&
                            !message.content
                                ? 'Codex 思考中...'
                                : ''}
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            <form
                className={styles.compose}
                onSubmit={(event) => {
                    event.preventDefault();
                    void send(input);
                }}
            >
                <textarea
                    className={styles.input}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder='輸入訊息，例如：你好'
                />
                <button
                    className={styles.sendButton}
                    disabled={busy || !input.trim()}
                    title='送出'
                    type='submit'
                >
                    <Send size={15} />
                </button>
            </form>
        </div>
    );
}

function updateAssistant(
    messages: ChatMessage[],
    id: string,
    update: (
        message: Extract<ChatMessage, { role: 'assistant' }>,
    ) => Extract<ChatMessage, { role: 'assistant' }>,
) {
    return messages.map((message) =>
        message.id === id && message.role === 'assistant'
            ? update(message)
            : message,
    );
}
