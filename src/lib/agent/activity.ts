// src/lib/agent/activity.ts — ambient operation log: key user actions
// (symbol picks, panel opens, orders, presets) recorded locally so the
// resident observation task can mine recurring workflows and converge them
// into skills (Hermes-style procedural memory, learned by watching).

const KEY = 'sj-agent-activity-v1';
const ENABLE_KEY = 'sj-agent-observe';
const MAX_EVENTS = 400;

export interface ActivityEvent {
    ts: number;
    kind: string; // 選商品 / 開面板 / 關面板 / 套版面 / 下單 / 全刪 ...
    detail: string;
}

let buf: ActivityEvent[] = [];
try {
    const raw = localStorage.getItem(KEY);
    if (raw) buf = (JSON.parse(raw) as ActivityEvent[]).slice(-MAX_EVENTS);
} catch {
    buf = [];
}

export function observeEnabled(): boolean {
    try {
        return localStorage.getItem(ENABLE_KEY) !== '0'; // default ON
    } catch {
        return true;
    }
}

export function setObserveEnabled(v: boolean) {
    try {
        localStorage.setItem(ENABLE_KEY, v ? '1' : '0');
    } catch {
        // session only
    }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function trackActivity(kind: string, detail = '') {
    if (!observeEnabled()) return;
    const last = buf[buf.length - 1];
    // collapse rapid repeats of the identical action（如連點同一檔）
    if (
        last &&
        last.kind === kind &&
        last.detail === detail &&
        Date.now() - last.ts < 5000
    ) {
        last.ts = Date.now();
        return;
    }
    buf.push({ ts: Date.now(), kind, detail });
    if (buf.length > MAX_EVENTS) buf = buf.slice(-MAX_EVENTS);
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            try {
                localStorage.setItem(KEY, JSON.stringify(buf));
            } catch {
                // quota — drop oldest half and retry once
                buf = buf.slice(-Math.floor(MAX_EVENTS / 2));
                try {
                    localStorage.setItem(KEY, JSON.stringify(buf));
                } catch {
                    // give up silently
                }
            }
        }, 2000);
    }
}

// formatted log for the agent（時間 動作 細節, newest last）
export function activityLog(hours = 24): string[] {
    const cutoff = Date.now() - hours * 3600_000;
    return buf
        .filter((e) => e.ts >= cutoff)
        .map((e) => {
            const d = new Date(e.ts);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return `${hh}:${mm} ${e.kind}${e.detail ? ` ${e.detail}` : ''}`;
        });
}

export function clearActivity() {
    buf = [];
    try {
        localStorage.removeItem(KEY);
    } catch {
        // ignore
    }
}
