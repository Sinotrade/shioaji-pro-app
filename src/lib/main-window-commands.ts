// src/lib/main-window-commands.ts — cross-window command bus with ACK and
// dedup for state that ONLY the main window may execute (protection
// triggers / bracket tracking, #102).
//
// Popouts, flash tiles and the tray (`?popout=…`) never execute orders for
// shared triggers. They send a command carrying a unique id; the main window
// applies it once (a repeated id replays the cached ACK instead of running
// again) and answers with an ACK. A popout resends the SAME id once when the
// ACK is late, then gives up with CommandNotAcknowledged — the command may or
// may not have been applied, so callers must surface "未確認" rather than
// assume either outcome. The main window also broadcasts a read-only state
// snapshot so mirrors can display it.

export function isMainWindow(): boolean {
    return typeof location === 'undefined' || !new URLSearchParams(location.search).has('popout');
}

/** Only one main-window instance per origin may execute protection (a web
 * build can have several tabs without `?popout`). The first tab to get the
 * Web Lock executes for its lifetime; the others stay read-only mirrors and
 * queue for the lock, taking over when the executor closes. Without Web
 * Locks (tests / old engines) the main window executes. */
export interface ExecutorClaim {
    settled: Promise<void>; // first attempt finished (executor or standby)
    acquired: Promise<void>; // this window now executes
}
let claim: ExecutorClaim | null = null;
let executor = false;
export function isExecutor(): boolean {
    return executor;
}
export function claimExecutor(name: string): ExecutorClaim {
    if (claim) return claim;
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks?.request) {
        executor = true;
        claim = { settled: Promise.resolve(), acquired: Promise.resolve() };
        return claim;
    }
    let settle!: () => void;
    let acquire!: () => void;
    const settled = new Promise<void>(r => { settle = r; });
    const acquired = new Promise<void>(r => { acquire = r; });
    const hold = (lock: Lock | null) => {
        if (!lock) return undefined;
        executor = true;
        settle();
        acquire();
        return new Promise<void>(() => undefined); // keep the lock until unload
    };
    void locks.request(name, { ifAvailable: true }, lock => {
        if (lock) return hold(lock);
        settle(); // standby: mirror now, take over when the executor leaves
        void locks.request(name, hold).catch(() => undefined);
        return undefined;
    }).catch(() => settle());
    claim = { settled, acquired };
    return claim;
}

export class CommandNotAcknowledged extends Error {
    constructor(message = '主視窗未回應，指令結果未確認') {
        super(message);
        this.name = 'CommandNotAcknowledged';
    }
}

type Envelope =
    | { kind: 'cmd'; id: string; cmd: unknown }
    | { kind: 'ack'; id: string; ok: boolean; result?: unknown; error?: string }
    | { kind: 'state'; state: unknown }
    | { kind: 'hello' };

export interface CommandBusOptions<C, S> {
    channel: Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'close'> | null;
    main: boolean | (() => boolean); // may change (standby tab taking over)
    ready?: Promise<unknown>; // role decided (executor claim settled)
    handle: (cmd: C) => unknown | Promise<unknown>;
    snapshot: () => S;
    onState?: (state: S) => void;
    retryMs?: number;
    timeoutMs?: number;
    newId?: () => string;
}

export interface CommandBus<C> {
    send(cmd: C, timeoutMs?: number): Promise<unknown>;
    publish(): void;
    hello(): void;
    close(): void;
}

const newUuid = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function createCommandBus<C, S>(opts: CommandBusOptions<C, S>): CommandBus<C> {
    const { channel } = opts;
    const isMain = () => typeof opts.main === 'function' ? opts.main() : opts.main;
    const retryMs = opts.retryMs ?? 1500;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const newId = opts.newId ?? newUuid;
    // main: id → settled ACK (bounded). Replays ACK for resent ids.
    const handled = new Map<string, Promise<Envelope>>();
    const waiting = new Map<string, (ack: Extract<Envelope, { kind: 'ack' }>) => void>();

    const run = (id: string, cmd: unknown): Promise<Envelope> => {
        let done = handled.get(id);
        if (!done) {
            done = Promise.resolve()
                .then(() => opts.handle(cmd as C))
                .then(result => ({ kind: 'ack', id, ok: true, result }) as Envelope,
                    error => ({ kind: 'ack', id, ok: false,
                        error: error instanceof Error ? error.message : String(error) }) as Envelope);
            handled.set(id, done);
            if (handled.size > 500) {
                const oldest = handled.keys().next().value;
                if (oldest !== undefined) handled.delete(oldest);
            }
        }
        return done;
    };

    const listener = (event: Event) => {
        const data = (event as MessageEvent).data as Envelope | undefined;
        if (!data || typeof data !== 'object') return;
        if (isMain()) {
            if (data.kind === 'cmd' && typeof data.id === 'string') {
                void run(data.id, data.cmd).then(ack => {
                    try { channel?.postMessage(ack); } catch { /* window closing */ }
                });
            } else if (data.kind === 'hello') {
                publish();
            }
            return;
        }
        if (data.kind === 'ack' && typeof data.id === 'string') {
            waiting.get(data.id)?.(data);
        } else if (data.kind === 'state') {
            opts.onState?.(data.state as S);
        }
    };
    channel?.addEventListener('message', listener);

    function publish() {
        if (!isMain()) return;
        try { channel?.postMessage({ kind: 'state', state: opts.snapshot() } satisfies Envelope); } catch { /* closed */ }
    }

    function hello() {
        if (isMain()) return;
        try { channel?.postMessage({ kind: 'hello' } satisfies Envelope); } catch { /* closed */ }
    }

    async function send(cmd: C, sendTimeoutMs = timeoutMs): Promise<unknown> {
        await opts.ready;
        if (isMain()) {
            const ack = await run(newId(), cmd) as Extract<Envelope, { kind: 'ack' }>;
            if (!ack.ok) throw new Error(ack.error);
            return ack.result;
        }
        if (!channel) throw new CommandNotAcknowledged('此視窗無法連到主視窗，指令未送出');
        const id = newId();
        const ack = await new Promise<Extract<Envelope, { kind: 'ack' }> | null>(resolve => {
            const timers: ReturnType<typeof setTimeout>[] = [];
            const finish = (value: Extract<Envelope, { kind: 'ack' }> | null) => {
                timers.forEach(clearTimeout);
                waiting.delete(id);
                resolve(value);
            };
            waiting.set(id, finish);
            const post = () => { try { channel.postMessage({ kind: 'cmd', id, cmd } satisfies Envelope); } catch { /* closed */ } };
            post();
            // Same id → main dedups; the resend only recovers a lost message.
            timers.push(setTimeout(post, retryMs));
            timers.push(setTimeout(() => finish(null), sendTimeoutMs));
        });
        if (!ack) throw new CommandNotAcknowledged();
        if (!ack.ok) throw new Error(ack.error);
        return ack.result;
    }

    void Promise.resolve(opts.ready).then(hello);

    return {
        send,
        publish,
        hello,
        close() {
            (channel as BroadcastChannel | null)?.removeEventListener?.('message', listener);
            waiting.clear();
        },
    };
}
