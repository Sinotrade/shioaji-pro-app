// src/lib/company-data/store.ts — persistent cache for shioaji-data files.
//
// Files are content-addressed by the manifest's sha256, so a stored copy never
// expires on its own: it is reused while the manifest still lists the same
// hash (the reader re-hashes the text on every read), and replaced when a new
// release changes it. IndexedDB holds the raw text (edges.json alone is
// ~2.5 MB, beyond what localStorage can take). When IndexedDB is missing or
// blocked (private window, tests) the cache is memory-only and the App still
// works online.
//
// Both stores are bounded by entry count and total size and evict the least
// recently used entries first (the manifest is never evicted).

/** Release metadata a file was published under; served with it when offline. */
export interface StoredMeta {
    releaseId: string;
    builtAt: string;
    schemaVersion: string;
    officialFetchedAt: string | null;
    disclaimer: string | null;
}

export interface StoredFile {
    /** Manifest path, or '__manifest__' for the manifest itself. */
    key: string;
    sha256: string;
    text: string;
    /** as_of of the dataset when it was stored (shown when served offline). */
    asOf: string | null;
    storedAt: number;
    meta?: StoredMeta;
}

export interface CompanyDataStore {
    get(key: string): Promise<StoredFile | undefined>;
    put(file: StoredFile): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface StoreLimits {
    maxEntries: number;
    /** Approximate bytes (UTF-16 text size). */
    maxBytes: number;
}

export const DEFAULT_STORE_LIMITS: StoreLimits = { maxEntries: 400, maxBytes: 64 * 1024 * 1024 };
export const MANIFEST_STORE_KEY = '__manifest__';

export const storedBytes = (file: Pick<StoredFile, 'text'>) => file.text.length * 2;

export interface PruneEntry {
    key: string;
    /** Last write or read refresh (ms epoch). */
    usedAt: number;
    bytes: number;
}

/**
 * Keys to evict so the rest fit `limits`: least recently used first, never the
 * manifest, and never the most recently used entry (one oversize file still
 * gets cached).
 */
export function planPrune(entries: readonly PruneEntry[], limits: StoreLimits): string[] {
    const order = entries.slice().sort((a, b) => a.usedAt - b.usedAt);
    let count = order.length;
    let bytes = order.reduce((n, e) => n + e.bytes, 0);
    const evict: string[] = [];
    for (let i = 0; i < order.length - 1; i += 1) {
        if (count <= limits.maxEntries && bytes <= limits.maxBytes) break;
        const entry = order[i]!;
        if (entry.key === MANIFEST_STORE_KEY) continue;
        evict.push(entry.key);
        count -= 1;
        bytes -= entry.bytes;
    }
    return evict;
}

export function createMemoryStore(limits: StoreLimits = DEFAULT_STORE_LIMITS): CompanyDataStore {
    // Map order is the LRU order: reads and writes move an entry to the end.
    const files = new Map<string, StoredFile>();
    let bytes = 0;
    const remove = (key: string) => {
        const old = files.get(key);
        if (!old) return;
        bytes -= storedBytes(old);
        files.delete(key);
    };
    return {
        async get(key) {
            const file = files.get(key);
            if (file) {
                files.delete(key);
                files.set(key, file);
            }
            return file;
        },
        async put(file) {
            remove(file.key);
            files.set(file.key, file);
            bytes += storedBytes(file);
            for (const key of [...files.keys()]) {
                if (files.size <= limits.maxEntries && bytes <= limits.maxBytes) break;
                if (key === file.key) break;
                if (key !== MANIFEST_STORE_KEY) remove(key);
            }
        },
        async delete(key) {
            remove(key);
        },
    };
}

const DB_NAME = 'sj-pro-company-data';
// v2: records carry `bytes`, and the `lru` index lets pruning read sizes
// without loading file text. The v1 store is only cache, so it is dropped.
const DB_VERSION = 2;
const STORE = 'files';
const LRU_INDEX = 'lru';
/** A read refreshes an entry's LRU time at most this often (it rewrites the record). */
const TOUCH_AFTER_MS = 24 * 60 * 60_000;

interface DbRecord extends StoredFile {
    bytes: number;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = factory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
            const store = db.createObjectStore(STORE, { keyPath: 'key' });
            store.createIndex(LRU_INDEX, ['storedAt', 'bytes']);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('company-data cache blocked'));
    });
}

/**
 * IndexedDB-backed store; every failure degrades to "not cached" instead of
 * surfacing, because the cache is an optimisation plus offline fallback.
 * Pruning runs once when the database opens and after every write (coalesced),
 * so the limits hold across restarts.
 */
export function createIndexedDbStore(
    factory: IDBFactory | undefined = globalThis.indexedDB,
    limits: StoreLimits = DEFAULT_STORE_LIMITS,
    now: () => number = () => Date.now(),
): CompanyDataStore {
    if (!factory) return createMemoryStore(limits);
    let db: Promise<IDBDatabase | null> | null = null;
    let pruning: Promise<void> | null = null;
    let again = false;

    const prune = async (handle: IDBDatabase) => {
        const tx = handle.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const done = new Promise<void>((resolve) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
        const entries: PruneEntry[] = [];
        await new Promise<void>((resolve, reject) => {
            const cursorReq = store.index(LRU_INDEX).openKeyCursor();
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) return resolve();
                const [usedAt, bytes] = cursor.key as [number, number];
                entries.push({ key: String(cursor.primaryKey), usedAt, bytes });
                cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
        });
        for (const key of planPrune(entries, limits)) store.delete(key);
        await done;
    };
    const schedulePrune = (handle: IDBDatabase): Promise<void> => {
        if (pruning) {
            again = true;
            return pruning;
        }
        pruning = (async () => {
            do {
                again = false;
                await prune(handle).catch(() => undefined);
            } while (again);
        })().finally(() => {
            pruning = null;
        });
        return pruning;
    };
    const database = () => {
        db ??= openDb(factory).then(
            (handle) => {
                void schedulePrune(handle);
                return handle;
            },
            () => null,
        );
        return db;
    };
    const write = async (handle: IDBDatabase, file: StoredFile) => {
        const record: DbRecord = { ...file, bytes: storedBytes(file) };
        const tx = handle.transaction(STORE, 'readwrite');
        await request(tx.objectStore(STORE).put(record));
    };

    return {
        async get(key) {
            const handle = await database();
            if (!handle) return undefined;
            try {
                const tx = handle.transaction(STORE, 'readonly');
                const record = (await request(tx.objectStore(STORE).get(key))) as DbRecord | undefined;
                if (!record) return undefined;
                const { bytes: _bytes, ...file } = record;
                const t = now();
                if (t - file.storedAt > TOUCH_AFTER_MS) {
                    void write(handle, { ...file, storedAt: t }).catch(() => undefined);
                }
                return file;
            } catch {
                return undefined;
            }
        },
        async put(file) {
            const handle = await database();
            if (!handle) return;
            try {
                await write(handle, file);
            } catch {
                // quota or private mode: stay memory-only for this file
            }
            await schedulePrune(handle);
        },
        async delete(key) {
            const handle = await database();
            if (!handle) return;
            try {
                const tx = handle.transaction(STORE, 'readwrite');
                await request(tx.objectStore(STORE).delete(key));
            } catch {
                // nothing to do
            }
        },
    };
}
