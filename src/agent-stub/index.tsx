// src/agent-stub/index.tsx — open-source fallback for the '@agent' module.
// The AI Agent (multi-provider agentic chat, skills marketplace, scheduled
// tasks) is a desktop-only, closed-source feature; this stub keeps the open
// repo building and tells users where the real thing lives.

export function AgentPanel() {
    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: '8px',
                padding: '24px',
                textAlign: 'center',
                color: 'var(--muted-foreground, #8593b3)',
                fontSize: '0.78rem',
                lineHeight: 1.7,
            }}
        >
            <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                AI Agent 為桌面版專屬功能
            </span>
            <span>
                內建 shioaji 技能包、Claude／OpenAI／Codex 訂閱、
                <br />
                排程任務與操作觀察學習 — 請下載 Shioaji Pro 桌面版。
            </span>
            <a
                href='https://github.com/Sinotrade/shioaji-pro-app/releases/latest'
                target='_blank'
                rel='noopener'
                style={{ color: 'var(--accent, #4f8cff)' }}
            >
                下載桌面版 →
            </a>
        </div>
    );
}

export function ensureAgentScheduler() {
    // no-op in the open-source build
}
