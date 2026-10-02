/** Multi-WebView ledger. Atomic set/remove per operation avoids array RMW
 * lost updates. An ACK never erases another operation or a legacy array. */
export function pendingProtectionStore<T extends { id: string }>(key: string, valid: (v: unknown) => v is T,
    storage: () => Storage | undefined = () => globalThis.localStorage) {
    const prefix = `${key}:operation:`;
    const ackPrefix = `${key}:legacy-ack:`;
    const decode = (raw: string | null): unknown => { try { return JSON.parse(raw ?? 'null'); } catch { return null; } };
    const rows = (): T[] => {
        const s = storage();
        if (!s) return [];
        const all = new Map<string, T>();
        const legacy = decode(s.getItem(key));
        if (Array.isArray(legacy)) for (const row of legacy) {
            if (valid(row) && s.getItem(ackPrefix + encodeURIComponent(row.id)) !== JSON.stringify(row)) all.set(row.id, row);
        }
        for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (!k?.startsWith(prefix)) continue;
            const row = decode(s.getItem(k));
            if (valid(row) && k === prefix + encodeURIComponent(row.id)) all.set(row.id, row);
        }
        return [...all.values()];
    };
    return {
        rows,
        handles: (k: string | null) => k === null || k === key || !!k?.startsWith(prefix) || !!k?.startsWith(ackPrefix),
        write(row: T) { const s = storage(); if (!s) throw new Error('保護紀錄無法保存'); s.setItem(prefix + encodeURIComponent(row.id), JSON.stringify(row)); },
        complete(id: string) { const s = storage(); if (!s) throw new Error('保護紀錄無法更新'); s.removeItem(prefix + encodeURIComponent(id)); },
        acknowledge(id: string) {
            const s = storage(); if (!s) throw new Error('保護紀錄無法更新');
            const row = rows().find(r => r.id === id);
            if (!row) return;
            if (s.getItem(prefix + encodeURIComponent(id)) !== null) s.removeItem(prefix + encodeURIComponent(id));
            else s.setItem(ackPrefix + encodeURIComponent(id), JSON.stringify(row));
        },
    };
}
