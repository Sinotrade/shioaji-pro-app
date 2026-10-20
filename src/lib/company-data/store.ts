// src/lib/company-data/store.ts — persistent cache for shioaji-data files.
//
// Files are content-addressed by the manifest's sha256, so a stored copy never
// expires on its own: it is reused while the manifest still lists the same
// hash, and replaced when a new release changes it. IndexedDB holds the raw
// text (edges.json alone is ~2.5 MB, beyond what localStorage can take). When
// IndexedDB is missing or blocked (private window, tests) the cache is
// memory-only and the App still works online.

export interface StoredFile {
    /** Manifest path, or '__manifest__' for the manifest itself. */
    key: string;
    sha256: string;
    text: string;
    /** as_of of the dataset when it was stored (shown when served offline). */
    asOf: string | null;
    storedAt: number;
}

export interface CompanyDataStore {
    get(key: string): Promise<StoredFile | undefined>;
    put(file: StoredFile): Promise<void>;
}

export function createMemoryStore(): CompanyDataStore {
    const files = new Map<string, StoredFile>();
    return {
        async get(key) {
            return files.get(key);
        },
        async put(file) {
            files.set(file.key, file);
        },
    };
}

const DB_NAME = 'sj-pro-company-data';
const DB_VERSION = 1;
const STORE = 'files';
/** Per-company files beyond this many are pruned, oldest first. */
const MAX_FILES = 400;

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
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'key' });
                store.createIndex('storedAt', 'storedAt');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('company-data cache blocked'));
    });
}

/**
 * IndexedDB-backed store; every failure degrades to "not cached" instead of
 * surfacing, because the cache is an optimisation plus offline fallback.
 */
export function createIndexedDbStore(
    factory: IDBFactory | undefined = globalThis.indexedDB,
): CompanyDataStore {
    if (!factory) return createMemoryStore();
    let db: Promise<IDBDatabase | null> | null = null;
    const database = () => {
        db ??= openDb(factory).catch(() => null);
        return db;
    };
    let writes = 0;
    const prune = async (handle: IDBDatabase) => {
        const tx = handle.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const count = await request(store.count());
        let excess = count - MAX_FILES;
        if (excess <= 0) return;
        await new Promise<void>((resolve) => {
            const cursorReq = store.index('storedAt').openCursor();
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor || excess <= 0) return resolve();
                const value = cursor.value as StoredFile;
                // keep the manifest and the shared datasets; prune per-company files
                if (value.key.includes('/json/')) {
                    cursor.delete();
                    excess -= 1;
                }
                cursor.continue();
            };
            cursorReq.onerror = () => resolve();
        });
    };
    return {
        async get(key) {
            const handle = await database();
            if (!handle) return undefined;
            try {
                const tx = handle.transaction(STORE, 'readonly');
                return (await request(tx.objectStore(STORE).get(key))) as
                    | StoredFile
                    | undefined;
            } catch {
                return undefined;
            }
        },
        async put(file) {
            const handle = await database();
            if (!handle) return;
            try {
                const tx = handle.transaction(STORE, 'readwrite');
                await request(tx.objectStore(STORE).put(file));
                writes += 1;
                if (writes % 25 === 0) await prune(handle);
            } catch {
                // quota or private mode: stay memory-only for this file
            }
        },
    };
}
