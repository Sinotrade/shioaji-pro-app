// src/lib/agent/skills.ts — user-defined skills (像 Claude Code 的 skill):
// a named, reusable trading workflow the agent can invoke. The system
// prompt advertises name+description; the agent loads the full
// instructions on demand via the use_skill tool, or the user invokes one
// directly with /技能名 in chat / by binding it to a scheduled task.

import { useSyncExternalStore } from 'react';

export interface AgentSkill {
    id: string;
    name: string; // short, used as /name
    description: string; // one line — shown to the model in the prompt
    instructions: string; // the full workflow steps
    builtin?: boolean;
}

const STORE_KEY = 'sj-agent-skills';

// starter skills modeled on a TW trader's daily workflow — editable
const BUILTINS: AgentSkill[] = [
    {
        id: 'builtin-morning',
        name: '開盤巡檢',
        description: '開盤前/後巡檢：大盤、持倉、風險、在途委託',
        instructions: `依序執行：
1. get_quote 查加權指數(001)與台指期(TXFR1)，比較基差
2. get_positions 列出所有持倉與損益
3. get_account 檢查權益數與風險指標（<150% 要警告）
4. get_working_orders 檢查是否有忘記刪的隔夜掛單
5. 總結：大盤方向、持倉風險最高的前三檔、建議動作（不下單）`,
        builtin: true,
    },
    {
        id: 'builtin-inventory',
        name: '庫存健檢',
        description: '逐檔檢查持倉：虧損超過 5% 列警示與停損建議',
        instructions: `1. get_positions 取得全部持倉
2. 對每檔虧損超過 5% 的部位：get_quote 查現價、get_kbar_summary 查 20 日區間位置
3. 產出表格：代碼/損益%/現價相對20日高低位置/建議（續抱理由或停損價）
4. 若權限允許確認下單，對建議停損的部位用 place_order 提案停損單`,
        builtin: true,
    },
    {
        id: 'builtin-close',
        name: '收盤總結',
        description: '收盤後總結今日損益、成交、明日注意事項',
        instructions: `1. get_positions + get_account 統計今日未實現損益變化
2. get_working_orders 確認收盤後在途單狀態
3. get_scanner 看今日漲幅榜，找出與持倉同類股的強勢股
4. 寫 5 行以內的今日總結與明日開盤前要注意的事`,
        builtin: true,
    },
    {
        id: 'builtin-observe',
        name: '操作觀察學習',
        description:
            '看使用者最近的操作軌跡，找出重複的工作流程並收斂成技能',
        instructions: `1. get_user_activity 取最近 24 小時的操作軌跡
2. 找出重複出現的模式：固定時間做的事（如開盤先看哪幾檔）、固定順序的操作（如選商品→開閃電→下單）、反覆查看的同一組商品
3. 對每個明確的重複模式，用 save_skill 存成技能：名稱取自用途（如「早盤掃描」），instructions 寫成可重複執行的工具步驟
4. 已存在的同名技能用觀察到的新行為改進它
5. 最後用 2-3 行總結你觀察到什麼、學了/更新了哪些技能；沒有明確模式就說還在觀察，不要硬造技能`,
        builtin: true,
    },
];

function loadUser(): AgentSkill[] {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) return JSON.parse(raw) as AgentSkill[];
    } catch {
        // corrupted — start empty
    }
    return [];
}

let userSkills = loadUser();
let snapshot: AgentSkill[] = [...BUILTINS, ...userSkills];
const listeners = new Set<() => void>();

function persist() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(userSkills));
    } catch {
        // session only
    }
    snapshot = [...BUILTINS, ...userSkills];
    listeners.forEach((l) => l());
}

export function getSkills(): AgentSkill[] {
    return snapshot;
}

export function findSkill(name: string): AgentSkill | undefined {
    const q = name.trim().toLowerCase();
    return snapshot.find(
        (s) => s.name.toLowerCase() === q || s.id === name,
    );
}

export function saveSkill(skill: Omit<AgentSkill, 'id'> & { id?: string }) {
    if (skill.id) {
        const builtin = BUILTINS.find((b) => b.id === skill.id);
        if (builtin) {
            // editing a builtin forks it into a user skill (same name wins)
            userSkills = [
                ...userSkills.filter((s) => s.name !== skill.name),
                { ...skill, id: `user-${Date.now()}`, builtin: false },
            ];
        } else {
            userSkills = userSkills.map((s) =>
                s.id === skill.id ? { ...s, ...skill, builtin: false } : s,
            );
        }
    } else {
        userSkills = [
            ...userSkills,
            { ...skill, id: `user-${Date.now()}`, builtin: false },
        ];
    }
    persist();
}

export function deleteSkill(id: string) {
    userSkills = userSkills.filter((s) => s.id !== id);
    persist();
}

export function useSkills(): AgentSkill[] {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => snapshot,
    );
}

// the catalogue advertised in the system prompt
export function skillCatalogue(): string {
    const all = getSkills();
    if (all.length === 0) return '';
    return `\n## 可用技能（用 use_skill 工具載入完整步驟）\n${all
        .map((s) => `- ${s.name}：${s.description}`)
        .join('\n')}`;
}
