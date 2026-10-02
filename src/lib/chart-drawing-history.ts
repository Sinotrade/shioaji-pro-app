// src/lib/chart-drawing-history.ts — 畫圖的復原／重做（每張圖各自一份）
//
// 遠端改動清除整個商品的歷史；逐物件差異只用來記錄本地操作與拖曳。

import type { Drawing } from './chart-drawings';
import { drawingRevision } from './chart-drawing-revision';

export interface HistoryChange {
    id: string;
    before: Drawing | null; // null＝這一步新增的
    after: Drawing | null; // null＝這一步刪掉的
    moved?: boolean;
}

export interface HistoryStep {
    key: string;
    changes: HistoryChange[];
    side: 'before' | 'after';
    order: string[];
    start: number;
}

export interface HistoryEntry {
    key: string;
    changes: HistoryChange[];
    beforeOrder: string[]; // 動到的物件在改動前後各自的圖層順序（整份 id）
    afterOrder: string[];
    // 連續的同類操作（拉填色滑桿、連按線寬）合併成一步
    tag?: string;
    at: number;
}

export const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

// before → after 之間，這一步動到的物件。ids 給了就只看這些（拖曳、文字
// 編輯這種跨時間的操作，期間別處的改動不算進來）
export function diffDrawings(
    before: Drawing[],
    after: Drawing[],
    ids?: Iterable<string>,
    trackOrder = ids === undefined,
): HistoryChange[] {
    const b = new Map(before.map((d) => [d.id, d]));
    const a = new Map(after.map((d) => [d.id, d]));
    const scope = ids ? new Set(ids) : new Set([...b.keys(), ...a.keys()]);
    const out: HistoryChange[] = [];
    for (const id of scope) {
        const x = b.get(id) ?? null;
        const y = a.get(id) ?? null;
        if (!x && !y) continue;
        // 前驅因新增／刪除／移動而改變，不代表這個鄰居也被修改。
        // 調整圖層的呼叫端會替實際移動的物件建立新版本。
        if (x !== y) {
            out.push({
                id,
                before: x,
                after: y,
                // 跨時間操作不追蹤順序；同步操作即使限定 ids，仍記實際圖層移動。
                moved: trackOrder && !!x && !!y &&
                    before.filter((d) => a.has(d.id)).findIndex((d) => d.id === id) !==
                    after.filter((d) => b.has(d.id)).findIndex((d) => d.id === id),
            });
        }
    }
    return out;
}

// 把 changes 套到 current：每個物件換成 pick 那一側的版本（null＝移除），
// 並依 order（那一側的圖層順序）放回位置
export function applyChanges(
    current: Drawing[],
    changes: HistoryChange[],
    side: 'before' | 'after',
    order: string[],
): Drawing[] {
    let next = [...current];
    for (const c of changes) {
        const target = c[side];
        const i = next.findIndex((d) => d.id === c.id);
        if (i >= 0 && target && c.before && c.after && !c.moved) {
            next[i] = target;
            continue;
        }
        if (i >= 0) next.splice(i, 1);
        if (!target) continue;
        // 接在目標順序裡排在它前面、而且現在還在的物件後面
        const pos = order.indexOf(c.id);
        let at = 0;
        for (let k = pos - 1; k >= 0; k--) {
            const j = next.findIndex((d) => d.id === order[k]);
            if (j >= 0) {
                at = j + 1;
                break;
            }
        }
        if (pos < 0) at = i >= 0 ? Math.min(i, next.length) : next.length;
        next = [...next.slice(0, at), target, ...next.slice(at)];
    }
    return next;
}

export class DrawingHistory {
    private _undo: HistoryEntry[] = [];
    private _redo: HistoryEntry[] = [];

    private starts = new Map<string, number>();

    constructor(private readonly _limit = HISTORY_LIMIT) {}

    begin(key: string, start: number) {
        if (![...this._undo, ...this._redo].some((e) => e.key === key)) this.starts.set(key, start);
    }

    get canUndo(): boolean {
        return this._undo.length > 0;
    }

    get canRedo(): boolean {
        return this._redo.length > 0;
    }

    // ids：只記操作本身寫入的物件；同步操作的排序另以 trackOrder 開啟。
    push(
        key: string,
        before: Drawing[],
        after: Drawing[],
        tag?: string,
        now = Date.now(),
        ids?: Iterable<string>,
        trackOrder = ids === undefined,
    ) {
        if (before === after) return;
        const changes = diffDrawings(before, after, ids, trackOrder);
        if (!changes.length) return;
        const beforeOrder = before.map((d) => d.id);
        const afterOrder = after.map((d) => d.id);
        const last = this._undo[this._undo.length - 1];
        if (
            tag &&
            last &&
            last.tag === tag &&
            last.key === key &&
            now - last.at < COALESCE_MS &&
            changes.every((c) =>
                last.changes.some((l) => l.id === c.id && l.after === c.before),
            )
        ) {
            for (const c of changes) {
                const previous = last.changes.find((l) => l.id === c.id)!;
                previous.after = c.after;
                previous.moved ||= c.moved;
            }
            last.afterOrder = afterOrder;
            last.at = now;
        } else {
            this._undo.push({ key, changes, beforeOrder, afterOrder, tag, at: now });
            if (this._undo.length > this._limit) this._undo.shift();
        }
        this._redo = [];
    }

    // 回傳待套用的步驟；鎖等待期間清除歷史，也會清空共用的 changes。
    undo(): HistoryStep | null {
        const e = this._undo.pop();
        if (!e) return null;
        this._redo.push(e);
        return { key: e.key, changes: e.changes, side: 'before', order: e.beforeOrder, start: this.starts.get(e.key) ?? 0 };
    }

    redo(): HistoryStep | null {
        const e = this._redo.pop();
        if (!e) return null;
        this._undo.push(e);
        return { key: e.key, changes: e.changes, side: 'after', order: e.afterOrder, start: this.starts.get(e.key) ?? 0 };
    }

    // 尚未套用的步驟作廢；其他已完成操作與之後新增的歷史仍然有效。
    discard(step: HistoryStep) {
        this._undo = this._undo.filter((e) => e.changes !== step.changes);
        this._redo = this._redo.filter((e) => e.changes !== step.changes);
        step.changes.splice(0);
    }

    // 取消已落地的拖曳後，把原物件的歷史快照接到取消版本。
    rebase(key: string, original: Drawing, restored: Drawing) {
        for (const e of [...this._undo, ...this._redo]) {
            if (e.key !== key) continue;
            for (const c of e.changes) for (const side of ['before', 'after'] as const) {
                const d = c[side];
                if (d?.id === original.id && drawingRevision(d) === drawingRevision(original)) c[side] = restored;
            }
        }
    }

    clear(key?: string): boolean {
        const entries = [...this._undo, ...this._redo].filter((e) => key === undefined || e.key === key);
        for (const e of entries) e.changes.splice(0);
        this._undo = this._undo.filter((e) => e.changes.length);
        this._redo = this._redo.filter((e) => e.changes.length);
        if (key === undefined) this.starts.clear();
        else this.starts.delete(key);
        return entries.length > 0;
    }
}
