const SEARCH_CONCURRENCY = 4;

interface ScheduledRequest {
    start: (release: () => void) => void;
    started: boolean;
}

// Shared only by search metadata sources, not by API requests or SSE globally.
const requestQueue: ScheduledRequest[] = [];
let activeRequests = 0;
let drainingQueue = false;

function drainQueue(): void {
    if (drainingQueue) return;
    drainingQueue = true;
    try {
        while (activeRequests < SEARCH_CONCURRENCY && requestQueue.length > 0) {
            const request = requestQueue.shift()!;
            request.started = true;
            activeRequests++;
            let released = false;
            request.start(() => {
                if (released) return;
                released = true;
                activeRequests--;
                drainQueue();
            });
        }
    } finally {
        drainingQueue = false;
    }
}

function scheduleRequest(start: ScheduledRequest['start']): () => void {
    const request: ScheduledRequest = { start, started: false };
    requestQueue.push(request);
    drainQueue();
    return () => {
        if (request.started) return;
        const index = requestQueue.indexOf(request);
        if (index >= 0) requestQueue.splice(index, 1);
    };
}

interface RequestReader<T> {
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    detach: () => void;
}

interface PendingRequest<T> {
    key: string;
    controller: AbortController;
    readers: Set<RequestReader<T>>;
    deadlineAt: number;
    closed: boolean;
    timer?: ReturnType<typeof setTimeout>;
    cancelQueued?: () => void;
    release?: () => void;
}

interface CachedResult<T> {
    value: T;
    expiresAt: number;
}

type RequestResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

function abortError(): DOMException {
    return new DOMException('商品搜尋已取消', 'AbortError');
}

function timeoutError(): Error {
    return new Error('商品資料來源回應逾時，請重試');
}

/**
 * Same-key readers share one metadata request but keep independent cancellation.
 * `limit` bounds successful LRU entries; pending readers are never evicted by it.
 * Deadlines include queue time. Releasing an aborted slot does not guarantee that
 * an underlying transport/server which ignores AbortSignal has stopped working.
 */
export class SearchRequestCache<T> {
    private readonly pending = new Map<string, PendingRequest<T>>();
    private readonly completed = new Map<string, CachedResult<T>>();

    constructor(private readonly options: { ttlMs: number; limit: number; deadlineMs: number }) {
        if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0
            || !Number.isInteger(options.limit) || options.limit < 1
            || !Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
            throw new Error('商品搜尋快取設定無效');
        }
    }

    read(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(abortError());

        const cached = this.completed.get(key);
        if (cached) {
            this.completed.delete(key);
            if (cached.expiresAt > Date.now()) {
                this.completed.set(key, cached);
                return Promise.resolve(cached.value);
            }
        }

        let entry = this.pending.get(key);
        const isNew = !entry;
        if (!entry) {
            entry = {
                key, controller: new AbortController(), readers: new Set(),
                deadlineAt: Date.now() + this.options.deadlineMs, closed: false,
            };
            this.pending.set(key, entry);
            const timedEntry = entry;
            entry.timer = setTimeout(() => {
                this.settle(timedEntry, { ok: false, error: timeoutError() });
            }, this.options.deadlineMs);
        }
        const request = entry;
        const result = new Promise<T>((resolve, reject) => {
            const onAbort = () => {
                if (!request.readers.delete(reader)) return;
                reader.detach();
                const error = abortError();
                reject(error);
                if (request.readers.size === 0) this.settle(request, { ok: false, error });
            };
            const reader: RequestReader<T> = {
                resolve, reject,
                detach: () => signal?.removeEventListener('abort', onAbort),
            };
            request.readers.add(reader);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });

        if (isNew && !request.closed) {
            request.cancelQueued = scheduleRequest(release => {
                request.release = release;
                if (request.closed || this.pending.get(key) !== request) {
                    release();
                    return;
                }
                // A preceding timeout can release a slot before this entry's
                // timer fires. Do not start an already-expired queued request.
                if (Date.now() >= request.deadlineAt) {
                    this.settle(request, { ok: false, error: timeoutError() });
                    return;
                }
                void this.run(request, load);
            });
        }
        return result;
    }

    clear(): void {
        this.completed.clear();
        const requests = [...this.pending.values()];
        // Invalidate every old entry before releasing any slot, so clear cannot
        // accidentally start its own queued work or delete a reentrant new read.
        this.pending.clear();
        for (const request of requests) request.cancelQueued?.();
        for (const request of requests) this.settle(request, { ok: false, error: abortError() });
    }

    private async run(request: PendingRequest<T>, load: (signal: AbortSignal) => Promise<T>): Promise<void> {
        try {
            const value = await load(request.controller.signal);
            this.settle(request, { ok: true, value });
        } catch (error) {
            this.settle(request, { ok: false, error });
        }
    }

    private settle(request: PendingRequest<T>, result: RequestResult<T>): void {
        if (request.closed) return;
        // A source promise can settle before an overdue timer gets CPU time.
        if (result.ok && Date.now() >= request.deadlineAt) result = { ok: false, error: timeoutError() };
        request.closed = true;
        const isCurrent = this.pending.get(request.key) === request;
        if (isCurrent) this.pending.delete(request.key);
        clearTimeout(request.timer);
        request.cancelQueued?.();

        if (result.ok && isCurrent && this.options.ttlMs > 0) {
            const now = Date.now();
            for (const [key, cached] of this.completed) {
                if (cached.expiresAt <= now) this.completed.delete(key);
            }
            this.completed.set(request.key, { value: result.value, expiresAt: now + this.options.ttlMs });
            while (this.completed.size > this.options.limit) {
                this.completed.delete(this.completed.keys().next().value!);
            }
        }

        for (const reader of request.readers) {
            reader.detach();
            if (result.ok) reader.resolve(result.value);
            else reader.reject(result.error);
        }
        request.readers.clear();
        if (!result.ok) request.controller.abort(result.error);
        request.release?.();
    }
}
