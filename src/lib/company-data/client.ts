// src/lib/company-data/client.ts — read and cache shioaji-data (#337, #338).
//
// One reader shared by the company panel and the Agent tools:
// - Only `v1/manifest.json` is a fixed URL; every other file is read from the
//   path the manifest lists, never a hard-coded path.
// - Downloads use `path?v=<sha256>` to skip the Pages CDN cache (600 s) and are
//   verified against that sha256. A mismatch refetches the manifest once (the
//   release may have moved on) before failing as an integrity error.
// - A file whose sha256 has not changed is never downloaded again: parsed
//   copies stay in memory, raw text in IndexedDB.
// - Cached text is re-hashed on every read from the persistent store; a copy
//   that no longer matches is evicted and downloaded again.
// - The manifest is fresh for MANIFEST_TTL_MS (the data is rebuilt a few
//   times a day). When the network fails, the last manifest fetched over
//   HTTPS (stored with its own sha256 and re-checked) and the cached files
//   keep serving, flagged `stale` = not verified as the latest release.
//   shioaji-data publishes no manifest signature, so trust rests on HTTPS to
//   GitHub Pages; the local sha256 only catches a corrupted cache, not a
//   local process able to rewrite the App's own storage.
// - A file served from cache after a failed download keeps the release
//   metadata it was published under; it is never relabelled as the newer
//   release the manifest now lists.
// - Unknown major schema versions are refused instead of guessed at.

import { MANIFEST_STORE_KEY, createIndexedDbStore, type CompanyDataStore, type StoredMeta } from './store';
import type {
    Company,
    DatasetKey,
    Edge,
    Entity,
    Financials,
    Manifest,
    ManifestEntry,
    ManifestFile,
    MarketDaily,
    Sources,
    Theme,
} from './types';

export const SHIOAJI_DATA_BASE_URL = 'https://sinotrade.github.io/shioaji-data/';
export const MANIFEST_PATH = 'v1/manifest.json';
/** How long a fetched manifest is trusted before it is checked again. */
export const MANIFEST_TTL_MS = 10 * 60_000;
/** After a failed manifest check, wait this long before trying the network again. */
export const OFFLINE_RETRY_MS = 60_000;

/** Major versions this App understands, per dataset. */
export const SUPPORTED_MAJOR = {
    manifest: 1,
    company: 1,
    financials: 1,
    'tw/cards': 1,
    'tw/edges': 1,
    'tw/themes': 1,
    'tw/market': 2,
    'tw/revenue': 1,
    'global/entities': 1,
    'global/sources': 1,
    'global/taxonomy': 1,
} as const satisfies Record<'manifest' | 'company' | 'financials' | DatasetKey, number>;

export type CompanyDataErrorCode =
    /** No network and nothing cached to fall back on. */
    | 'offline'
    /** HTTP error or a network failure the cache could not cover. */
    | 'network'
    /** Downloaded bytes did not match the manifest sha256. */
    | 'integrity'
    /** The data uses a major schema this App does not know. */
    | 'unsupported_schema'
    /** The code / dataset is not listed in the manifest. */
    | 'not_found'
    /** The file is not valid JSON or not the expected shape. */
    | 'invalid_data';

export class CompanyDataError extends Error {
    readonly code: CompanyDataErrorCode;
    constructor(code: CompanyDataErrorCode, message: string) {
        super(message);
        this.name = 'CompanyDataError';
        this.code = code;
    }
}

export function isCompanyDataError(error: unknown): error is CompanyDataError {
    return error instanceof CompanyDataError;
}

/** User-facing (zh-TW) text for an error, used by the panel and the tools. */
export function companyDataErrorText(error: unknown): string {
    if (!isCompanyDataError(error)) {
        return `公司資料讀取失敗：${error instanceof Error ? error.message : String(error)}`;
    }
    switch (error.code) {
        case 'offline':
            return '無法連線到公司資料來源，且本機沒有快取';
        case 'network':
            return `公司資料下載失敗：${error.message}`;
        case 'integrity':
            return '公司資料檔案驗證失敗（sha256 不符），已停止使用';
        case 'unsupported_schema':
            return '公司資料格式已更新，請更新 Shioaji Pro 後再使用';
        case 'not_found':
            return error.message;
        case 'invalid_data':
            return `公司資料格式錯誤：${error.message}`;
    }
}

export interface ManifestState {
    manifest: Manifest;
    /** When the manifest was last confirmed from the network (ms epoch). */
    fetchedAt: number;
    /** True when served from cache because the network check failed. */
    stale: boolean;
}

export interface DataMeta {
    path: string;
    sha256: string;
    asOf: string | null;
    schemaVersion: string;
    releaseId: string;
    builtAt: string;
    officialFetchedAt: string | null;
    disclaimer: string | null;
    /**
     * True when the manifest or this file came from cache after a network
     * failure: the data is verified against what was fetched earlier, but not
     * confirmed to be the latest release.
     */
    stale: boolean;
}

/** zh-TW label for stale data (panel and tools). */
export const STALE_TEXT = '離線快取・未驗證最新';


export interface Loaded<T> {
    data: T;
    meta: DataMeta;
}

export type CompanyDataStatus =
    | { phase: 'idle' }
    | { phase: 'ok'; releaseId: string; builtAt: string; fetchedAt: number }
    | {
          phase: 'stale';
          releaseId: string;
          builtAt: string;
          fetchedAt: number;
          error: string;
      };

export interface CompanyDataClientOptions {
    baseUrl?: string;
    fetch?: typeof fetch;
    store?: CompanyDataStore;
    now?: () => number;
    manifestTtlMs?: number;
}

export interface DatasetTypes {
    'tw/cards': unknown[];
    'tw/edges': Edge[];
    'tw/themes': Theme[];
    'tw/market': MarketDaily;
    'tw/revenue': Record<string, unknown>;
    'global/entities': Entity[];
    'global/sources': Sources;
    'global/taxonomy': Record<string, unknown>;
}

const MANIFEST_KEY = MANIFEST_STORE_KEY;
/** Per-company parsed files kept in memory (shared datasets are always kept). */
const MEMORY_COMPANY_FILES = 48;

function majorOf(version: unknown): number | null {
    if (typeof version !== 'string') return null;
    const major = Number(version.split('.')[0]);
    return Number.isInteger(major) ? major : null;
}

function assertMajor(kind: keyof typeof SUPPORTED_MAJOR, version: unknown) {
    const major = majorOf(version);
    if (major !== SUPPORTED_MAJOR[kind]) {
        throw new CompanyDataError(
            'unsupported_schema',
            `${kind} schema ${String(version)} is not supported (expected ${SUPPORTED_MAJOR[kind]}.x)`,
        );
    }
}

/** Manifest paths are relative `v1/...` paths; anything else is refused. */
function assertSafePath(path: unknown): asserts path is string {
    if (
        typeof path !== 'string' ||
        !path.startsWith('v1/') ||
        path.includes('..') ||
        path.includes('\\') ||
        /[?#]|:\/\//.test(path)
    ) {
        throw new CompanyDataError('invalid_data', `unexpected manifest path: ${String(path)}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(text: string): Manifest {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new CompanyDataError('invalid_data', 'manifest is not JSON');
    }
    if (!isRecord(raw)) throw new CompanyDataError('invalid_data', 'manifest is not an object');
    assertMajor('manifest', raw.manifest_schema_version);
    if (!isRecord(raw.files) || !isRecord(raw.companies) || !isRecord(raw.financials)) {
        throw new CompanyDataError('invalid_data', 'manifest is missing files / companies / financials');
    }
    return raw as unknown as Manifest;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

async function sha256Hex(bytes: BufferSource): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Keep a BOM in the text so re-encoding reproduces the downloaded bytes.
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const textSha256 = (text: string) => sha256Hex(new TextEncoder().encode(text));

/** Accepts `2330`, `tw.2330` (any case, surrounding spaces). Other regions → null. */
export function normalizeCompanyCode(input: unknown): string | null {
    if (typeof input !== 'string' && typeof input !== 'number') return null;
    const text = String(input).trim();
    const match = /^(?:tw\.)?(\d[0-9A-Za-z]{3,5})$/i.exec(text);
    return match ? match[1]!.toUpperCase() : null;
}

export function companyEntityId(code: string): string {
    return `tw.${code}`;
}

interface MemoryEntry {
    sha256: string;
    value: Promise<unknown>;
    /** Release the file was published under (served with it if offline). */
    origin: StoredMeta & { asOf: string | null };
}

export function createCompanyDataClient(options: CompanyDataClientOptions = {}) {
    const baseUrl = (options.baseUrl ?? SHIOAJI_DATA_BASE_URL).replace(/\/?$/, '/');
    const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    const store = options.store ?? createIndexedDbStore();
    const now = options.now ?? (() => Date.now());
    const ttl = options.manifestTtlMs ?? MANIFEST_TTL_MS;

    let current: ManifestState | null = null;
    let retryAt = 0;
    let inflight: Promise<ManifestState> | null = null;
    let status: CompanyDataStatus = { phase: 'idle' };
    const listeners = new Set<() => void>();
    const memory = new Map<string, MemoryEntry>();

    const setStatus = (next: CompanyDataStatus) => {
        status = next;
        listeners.forEach((listener) => listener());
    };

    async function fetchManifest(): Promise<ManifestState> {
        let response: Response;
        try {
            response = await doFetch(`${baseUrl}${MANIFEST_PATH}`, { cache: 'no-cache' });
        } catch (error) {
            throw new CompanyDataError('network', error instanceof Error ? error.message : String(error));
        }
        if (!response.ok) throw new CompanyDataError('network', `manifest HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const text = utf8Decoder.decode(bytes);
        const manifest = parseManifest(text);
        const fetchedAt = now();
        void store.put({
            key: MANIFEST_KEY,
            sha256: await sha256Hex(bytes),
            text,
            asOf: manifest.built_at,
            storedAt: fetchedAt,
        });
        return { manifest, fetchedAt, stale: false };
    }

    async function refreshManifest(): Promise<ManifestState> {
        try {
            const fresh = await fetchManifest();
            current = fresh;
            retryAt = 0;
            setStatus({
                phase: 'ok',
                releaseId: fresh.manifest.release_id,
                builtAt: fresh.manifest.built_at,
                fetchedAt: fresh.fetchedAt,
            });
            return fresh;
        } catch (error) {
            // A schema this App cannot read is never papered over with cache.
            if (isCompanyDataError(error) && error.code !== 'network') throw error;
            let fallback = current;
            if (!fallback) {
                const stored = await store.get(MANIFEST_KEY);
                // Only a manifest that was fetched online and still hashes to
                // the sha256 recorded then is used.
                if (stored && SHA256_HEX.test(stored.sha256) && (await textSha256(stored.text)) === stored.sha256) {
                    try {
                        fallback = { manifest: parseManifest(stored.text), fetchedAt: stored.storedAt, stale: true };
                    } catch {
                        fallback = null;
                    }
                }
            }
            if (!fallback) {
                throw new CompanyDataError(
                    'offline',
                    error instanceof Error ? error.message : String(error),
                );
            }
            current = { ...fallback, stale: true };
            retryAt = now() + OFFLINE_RETRY_MS;
            setStatus({
                phase: 'stale',
                releaseId: current.manifest.release_id,
                builtAt: current.manifest.built_at,
                fetchedAt: current.fetchedAt,
                error: error instanceof Error ? error.message : String(error),
            });
            return current;
        }
    }

    function getManifest(opts: { force?: boolean } = {}): Promise<ManifestState> {
        const t = now();
        if (current && !opts.force) {
            if (!current.stale && t - current.fetchedAt < ttl) return Promise.resolve(current);
            if (current.stale && t < retryAt) return Promise.resolve(current);
        }
        inflight ??= refreshManifest().finally(() => {
            inflight = null;
        });
        return inflight;
    }

    function metaFor(
        state: ManifestState,
        entry: ManifestEntry | ManifestFile,
        schemaVersion: string,
        stale: boolean,
    ): DataMeta {
        return {
            path: entry.path,
            sha256: entry.sha256,
            asOf: entry.as_of ?? null,
            schemaVersion,
            releaseId: state.manifest.release_id,
            builtAt: state.manifest.built_at,
            officialFetchedAt: state.manifest.official_fetched_at ?? null,
            disclaimer: state.manifest.disclaimer ?? null,
            stale: stale || state.stale,
        };
    }

    async function download(entry: ManifestEntry): Promise<string> {
        let response: Response;
        try {
            response = await doFetch(`${baseUrl}${entry.path}?v=${entry.sha256}`);
        } catch (error) {
            throw new CompanyDataError('network', error instanceof Error ? error.message : String(error));
        }
        if (!response.ok) throw new CompanyDataError('network', `${entry.path} HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const actual = await sha256Hex(bytes);
        if (actual !== entry.sha256) {
            throw new CompanyDataError('integrity', `${entry.path} sha256 mismatch`);
        }
        return utf8Decoder.decode(bytes);
    }

    /**
     * Resolve `lookup` against the current manifest and return the parsed file.
     * Order: memory (same sha) → IndexedDB (same sha) → network (verified);
     * on network failure an older cached copy is served as stale.
     */
    async function load<T>(
        lookup: (manifest: Manifest) => { entry: ManifestEntry | ManifestFile; schemaVersion: string; kind: keyof typeof SUPPORTED_MAJOR },
        perCompany: boolean,
    ): Promise<Loaded<T>> {
        let state = await getManifest();
        let resolved = lookup(state.manifest);
        for (let attempt = 0; ; attempt += 1) {
            const { entry, schemaVersion, kind } = resolved;
            assertSafePath(entry.path);
            assertMajor(kind, schemaVersion);
            if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
                throw new CompanyDataError('invalid_data', `${entry.path} has no valid sha256`);
            }
            const origin = originOf(state, entry, schemaVersion);
            const cached = memory.get(entry.path);
            if (cached && cached.sha256 === entry.sha256) {
                if (perCompany) {
                    memory.delete(entry.path);
                    memory.set(entry.path, cached);
                }
                return { data: (await cached.value) as T, meta: metaFor(state, entry, schemaVersion, false) };
            }
            let stored = await store.get(entry.path);
            // Re-hash the persisted text: the record's sha256 field alone
            // proves nothing about the bytes next to it.
            if (stored && !(await storedIntact(stored))) {
                void store.delete(entry.path);
                stored = undefined;
            }
            if (stored && stored.sha256 === entry.sha256) {
                const value = parseJson(entry.path, stored.text);
                remember(entry.path, entry.sha256, value, perCompany, origin);
                return { data: value as T, meta: metaFor(state, entry, schemaVersion, false) };
            }
            try {
                const text = await download(entry);
                const value = parseJson(entry.path, text);
                remember(entry.path, entry.sha256, value, perCompany, origin);
                const { asOf, ...meta } = origin;
                void store.put({ key: entry.path, sha256: entry.sha256, text, asOf, storedAt: now(), meta });
                return { data: value as T, meta: metaFor(state, entry, schemaVersion, false) };
            } catch (error) {
                if (isCompanyDataError(error) && error.code === 'integrity' && attempt === 0) {
                    // The manifest may have moved to a new release mid-download.
                    state = await getManifest({ force: true });
                    const next = lookup(state.manifest);
                    if (next.entry.sha256 !== entry.sha256) {
                        resolved = next;
                        continue;
                    }
                    throw error;
                }
                if (isCompanyDataError(error) && error.code === 'network') {
                    // Serve the older copy under the release it came from.
                    const older = olderCopy(entry.path, kind, cached, stored);
                    if (older) {
                        const { asOf, ...rest } = older.origin;
                        return {
                            data: (await older.value) as T,
                            meta: { path: entry.path, sha256: older.sha256, asOf, ...rest, stale: true },
                        };
                    }
                    if (state.stale) {
                        throw new CompanyDataError('offline', `${entry.path} is not cached`);
                    }
                }
                throw error;
            }
        }
    }

    function originOf(state: ManifestState, entry: ManifestEntry | ManifestFile, schemaVersion: string): MemoryEntry['origin'] {
        return {
            releaseId: state.manifest.release_id,
            builtAt: state.manifest.built_at,
            schemaVersion,
            officialFetchedAt: state.manifest.official_fetched_at ?? null,
            disclaimer: state.manifest.disclaimer ?? null,
            asOf: entry.as_of ?? null,
        };
    }

    async function storedIntact(stored: { sha256: string; text: string }): Promise<boolean> {
        return SHA256_HEX.test(stored.sha256) && (await textSha256(stored.text)) === stored.sha256;
    }

    /** An earlier release's copy (already hash-checked) with its own metadata, if usable. */
    function olderCopy(
        path: string,
        kind: keyof typeof SUPPORTED_MAJOR,
        cached: MemoryEntry | undefined,
        stored: Awaited<ReturnType<CompanyDataStore['get']>>,
    ): MemoryEntry | null {
        const candidate: MemoryEntry | null = cached
            ? cached
            : stored?.meta
              ? {
                    sha256: stored.sha256,
                    value: Promise.resolve().then(() => parseJson(path, stored.text)),
                    origin: { ...stored.meta, asOf: stored.asOf },
                }
              : null;
        if (!candidate) return null;
        try {
            assertMajor(kind, candidate.origin.schemaVersion);
        } catch {
            return null;
        }
        return candidate;
    }

    function parseJson(path: string, text: string): unknown {
        try {
            return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        } catch {
            throw new CompanyDataError('invalid_data', `${path} is not JSON`);
        }
    }

    function remember(path: string, sha256: string, value: unknown, perCompany: boolean, origin: MemoryEntry['origin']) {
        memory.delete(path);
        memory.set(path, { sha256, value: Promise.resolve(value), origin });
        if (!perCompany) return;
        let companyFiles = 0;
        for (const key of memory.keys()) if (key.includes('/json/')) companyFiles += 1;
        for (const key of memory.keys()) {
            if (companyFiles <= MEMORY_COMPANY_FILES) break;
            if (key.includes('/json/')) {
                memory.delete(key);
                companyFiles -= 1;
            }
        }
    }

    function getDataset<K extends DatasetKey>(key: K): Promise<Loaded<DatasetTypes[K]>> {
        return load<DatasetTypes[K]>((manifest) => {
            const entry = manifest.files[key];
            if (!entry) throw new CompanyDataError('not_found', `公司資料沒有 ${key} 資料集`);
            return { entry, schemaVersion: entry.schema_version, kind: key };
        }, false);
    }

    async function hasCompany(code: string): Promise<boolean> {
        const { manifest } = await getManifest();
        return Object.prototype.hasOwnProperty.call(manifest.companies, code);
    }

    function getCompany(input: string): Promise<Loaded<Company>> {
        const code = normalizeCompanyCode(input);
        return load<Company>((manifest) => {
            const entry = code ? manifest.companies[code] : undefined;
            if (!code || !entry) {
                throw new CompanyDataError('not_found', `公司資料沒有 ${String(input)}（僅收錄上市櫃公司）`);
            }
            return { entry, schemaVersion: manifest.files['tw/cards']?.schema_version ?? '', kind: 'company' };
        }, true);
    }

    function getFinancials(input: string): Promise<Loaded<Financials>> {
        const code = normalizeCompanyCode(input);
        return load<Financials>((manifest) => {
            const entry = code ? manifest.financials[code] : undefined;
            if (!code || !entry) {
                throw new CompanyDataError('not_found', `公司資料沒有 ${String(input)} 的財報`);
            }
            return { entry, schemaVersion: manifest.financials_schema_version, kind: 'financials' };
        }, true);
    }

    return {
        baseUrl,
        getManifest,
        getDataset,
        hasCompany,
        getCompany,
        getFinancials,
        getThemes: () => getDataset('tw/themes'),
        getEdges: () => getDataset('tw/edges'),
        getEntities: () => getDataset('global/entities'),
        getMarket: () => getDataset('tw/market'),
        getSources: () => getDataset('global/sources'),
        getStatus: () => status,
        subscribeStatus(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export type CompanyDataClient = ReturnType<typeof createCompanyDataClient>;
