import type { Drawing } from './chart-drawings';

// Lamport counter＋writer 全序；時間只用於顯示。舊資料以時間
// 轉成 legacy counter，第一次修改即升級，不需整份遷移。
export type Revision = string;
export interface DrawingTombstone {
    revision: Revision;
    updatedAt: number;
    writers?: string[]; // JSON 中的集合；舊墓碑載入時升級
    writer?: string; // 相容既有資料
}
export type Tombstone = number | DrawingTombstone;

export function legacyRevision(at: number): Revision {
    return `${Math.max(0, Math.floor(at)).toString().padStart(16, '0')}:legacy`;
}

export function drawingRevision(d: Drawing): Revision {
    return d.revision ?? legacyRevision(d.updatedAt);
}

export function tombRevision(t: Tombstone): Revision {
    return typeof t === 'number' ? legacyRevision(t) : t.revision;
}

export function isRevision(v: unknown): v is Revision {
    return typeof v === 'string' && /^\d{16}:[\w-]+$/.test(v);
}

export function isTombstone(v: unknown): v is Tombstone {
    if (typeof v === 'number') return Number.isFinite(v);
    if (!v || typeof v !== 'object' || 'id' in v) return false;
    const t = v as DrawingTombstone;
    return isRevision(t.revision) && Number.isFinite(t.updatedAt) &&
        (t.writer === undefined || (typeof t.writer === 'string' && /^[\w-]+$/.test(t.writer))) &&
        (t.writers === undefined || (Array.isArray(t.writers) && t.writers.length > 0 &&
            t.writers.every((w) => typeof w === 'string' && /^[\w-]+$/.test(w))));
}

export function tombWriters(t: Tombstone): string[] {
    return typeof t === 'number' ? ['legacy'] : t.writers ?? [t.writer ?? 'legacy'];
}

export function mergeTombstones(a: Tombstone | undefined, b: Tombstone): DrawingTombstone {
    return {
        revision: a !== undefined && tombRevision(a) > tombRevision(b) ? tombRevision(a) : tombRevision(b),
        updatedAt: Math.max(a === undefined ? 0 : typeof a === 'number' ? a : a.updatedAt,
            typeof b === 'number' ? b : b.updatedAt),
        writers: [...new Set([...(a === undefined ? [] : tombWriters(a)), ...tombWriters(b)])].sort(),
    };
}
