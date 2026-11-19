// One SSE owner per origin/API base. BroadcastChannel carries the original
// event name and JSON bytes; every window keeps its own local quote store.
// Web Locks is the arbiter, including when a leader exits without unload.
export type StreamWire =
    | { kind: 'event'; name: string; raw: string }
    | { kind: 'status'; status: 'connecting' | 'live' | 'down' | 'stale'; heartbeat: number };

// 'want'：非擁有者告訴擁有者「這個視窗需要哪些額外串流」（例：美股 SSE 只在有
// 美股訂閱時才開）。非擁有者每個 tick 重送一次，擁有者過期沒收到就當作視窗已關。
type Envelope = StreamWire | { kind: 'alive'; id: string; main: boolean } | { kind: 'yield'; id: string }
    | { kind: 'want'; id: string; keys: string[] };

/** 擁有者多久沒收到某視窗的 want 就當作它已關（隱藏視窗的計時器最慢約每分鐘一次） */
export const REMOTE_WANT_TTL_MS = 70_000;

export function createSharedStream(options: {
    name: string;
    main: boolean;
    onOwn: () => void;
    onRelease: () => void;
    onWire: (wire: StreamWire) => void;
    onMissing: () => void;
    /** 擁有者：其他視窗需要的額外串流集合變了（交出擁有權後清空，不再呼叫） */
    onRemoteWants?: (keys: ReadonlySet<string>) => void;
    snapshot: () => Extract<StreamWire, { kind: 'status' }>;
}) {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(options.name);
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    let owner = false;
    let closed = false;
    let claiming = false;
    let lastAlive = 0;
    let deferUntil = 0;
    let releaseLock: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let startup: ReturnType<typeof setTimeout> | null = null;

    const post = (message: Envelope) => { try { channel?.postMessage(message); } catch { /* closing */ } };
    const localWants = new Set<string>();
    const remoteWants = new Map<string, { keys: string[]; at: number }>();
    let remoteUnion = '';
    const announceWants = () => { if (!owner) post({ kind: 'want', id, keys: [...localWants] }); };
    const recomputeRemote = () => {
        const now = Date.now();
        for (const [win, entry] of remoteWants) if (now - entry.at > REMOTE_WANT_TTL_MS || !entry.keys.length) remoteWants.delete(win);
        const union = new Set<string>();
        remoteWants.forEach(entry => entry.keys.forEach(key => union.add(key)));
        const sig = [...union].sort().join('|');
        if (sig === remoteUnion) return;
        remoteUnion = sig;
        options.onRemoteWants?.(union);
    };
    const release = () => {
        if (!owner) return;
        owner = false;
        remoteWants.clear();
        remoteUnion = '';
        // 自己變成非擁有者：把這個視窗需要的串流告訴新的擁有者
        announceWants();
        options.onRelease();
        releaseLock?.();
        releaseLock = null;
    };
    const receive = (event: MessageEvent<Envelope>) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.kind === 'yield') {
            if (data.id !== id && !options.main) {
                deferUntil = Date.now() + 2000;
                if (owner) release();
            }
        } else if (data.kind === 'alive') {
            if (data.id === id) return;
            if (options.main && !owner && !data.main) {
                post({ kind: 'yield', id });
                setTimeout(claim, 0);
            }
            if (!owner) {
                lastAlive = Date.now();
                // 新擁有者上任（或例行 alive）：有需要的串流就立刻重報，不等下一個 tick
                if (localWants.size) announceWants();
            }
        } else if (data.kind === 'want') {
            if (!owner || data.id === id) return;
            remoteWants.set(data.id, { keys: data.keys, at: Date.now() });
            recomputeRemote();
        } else if (!owner && (data.kind === 'event' || data.kind === 'status')) {
            lastAlive = Date.now();
            options.onWire(data);
        }
    };

    const claim = () => {
        if (closed || claiming || owner || Date.now() < deferUntil) return;
        // A browser without both primitives cannot coordinate multiple tabs.
        // Fail closed instead of opening one EventSource per popout.
        if (typeof window !== 'undefined' && (!channel || !locks?.request)) {
            options.onMissing();
            return;
        }
        if (!channel || !locks?.request) {
            owner = true;
            options.onOwn();
            return;
        }
        claiming = true;
        void locks.request(options.name, { ifAvailable: true }, async lock => {
            claiming = false;
            if (!lock || closed) return;
            owner = true;
            options.onOwn();
            post({ kind: 'alive', id, main: options.main });
            post(options.snapshot());
            await new Promise<void>(resolve => { releaseLock = resolve; });
        }).catch(() => { claiming = false; });
    };

    channel?.addEventListener('message', receive);
    // The main window wins a simultaneous startup. A later main asks a child
    // owner to release its lock; the child waits before competing again.
    if (options.main) claim();
    else startup = setTimeout(claim, 350);
    timer = setInterval(() => {
        if (closed) return;
        if (owner) {
            post({ kind: 'alive', id, main: options.main });
            post(options.snapshot());
            if (remoteWants.size) recomputeRemote();
        }
        else if (options.main || Date.now() - lastAlive > 1700) {
            // A hidden owner may have throttled timers while still holding
            // the lock and receiving SSE. Only a successful lock claim proves
            // the old owner is gone; silence alone must not mark quotes DOWN.
            claim();
        }
        if (!owner && localWants.size) announceWants();
    }, 500);
    // 視窗關掉時立刻撤回需要的串流，不等擁有者的過期時間
    const onPageHide = () => { if (!owner && localWants.size) post({ kind: 'want', id, keys: [] }); };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', onPageHide);

    return {
        isOwner: () => owner,
        publish(wire: StreamWire) { if (owner) post(wire); },
        /** 這個視窗需不需要某個額外串流；非擁有者會轉告擁有者 */
        want(key: string, on: boolean) {
            if (on === localWants.has(key)) return;
            if (on) localWants.add(key); else localWants.delete(key);
            announceWants();
        },
        close() {
            if (!owner && localWants.size) post({ kind: 'want', id, keys: [] });
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('pagehide', onPageHide);
            closed = true;
            if (startup) clearTimeout(startup);
            if (timer) clearInterval(timer);
            release();
            channel?.removeEventListener('message', receive);
            channel?.close();
        },
    };
}
