// src/lib/allocation.ts — split-order (分倉) quantity allocation.
//
// Pure integer allocation: contracts/lots are indivisible, so a ratio split
// uses the largest-remainder method — every account gets floor(share), then
// the leftover units go one-by-one to the largest fractional parts (ties
// break toward the earlier account, i.e. the user's account order). The sum
// of the result ALWAYS equals `total` (conservation), and zero-weight
// accounts never receive quantity.

export interface AllocPreset {
    name: string;
    // key = `${broker_id}-${account_id}` → percent weight
    ratios: Record<string, number>;
}

// Split `total` units across `weights` (any non-negative numbers; percents
// work but need not sum to 100 — allocation normalizes by the weight sum).
// Returns integer quantities, same order as `weights`, summing to `total`.
export function allocateByRatio(total: number, weights: number[]): number[] {
    if (!Number.isInteger(total) || total <= 0) {
        return weights.map(() => 0);
    }
    const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
    const sum = clean.reduce((s, w) => s + w, 0);
    if (sum <= 0) return weights.map(() => 0);

    const quotas = clean.map((w) => (total * w) / sum);
    const result = quotas.map((q) => Math.floor(q));
    let remainder = total - result.reduce((s, q) => s + q, 0);

    // hand out leftovers by fractional part, largest first; stable order on
    // ties (earlier account wins). Zero-weight accounts have fraction 0 and
    // can mathematically never be needed (positive fractions >= remainder),
    // but guard anyway.
    const byFraction = quotas
        .map((q, i) => ({ i, frac: q - Math.floor(q) }))
        .filter((e) => (clean[e.i] ?? 0) > 0)
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const e of byFraction) {
        if (remainder <= 0) break;
        result[e.i] = (result[e.i] ?? 0) + 1;
        remainder -= 1;
    }
    return result;
}

// ---- allocation presets (localStorage) ----

const PRESET_KEY = 'sj-pro-alloc-presets';

export function loadAllocPresets(): AllocPreset[] {
    try {
        const raw = localStorage.getItem(PRESET_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p): p is AllocPreset =>
                !!p &&
                typeof (p as AllocPreset).name === 'string' &&
                typeof (p as AllocPreset).ratios === 'object' &&
                (p as AllocPreset).ratios !== null,
        );
    } catch {
        return [];
    }
}

function persist(presets: AllocPreset[]) {
    try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    } catch {
        // storage unavailable — session only
    }
}

// save (replace an existing preset with the same name)
export function saveAllocPreset(preset: AllocPreset): AllocPreset[] {
    const next = [
        ...loadAllocPresets().filter((p) => p.name !== preset.name),
        preset,
    ];
    persist(next);
    return next;
}

export function deleteAllocPreset(name: string): AllocPreset[] {
    const next = loadAllocPresets().filter((p) => p.name !== name);
    persist(next);
    return next;
}
