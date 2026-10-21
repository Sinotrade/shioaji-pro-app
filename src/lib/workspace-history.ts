// src/lib/workspace-history.ts — undo steps for whole-workspace changes made
// by the Agent (#331). In memory only: an undo step never survives a reload.
//
// One apply = one entry. An entry is undoable only while the visible panel set
// (ids and types) still matches what the apply produced; moving or resizing
// panels afterwards keeps it undoable, but loading another layout or adding /
// removing panels makes it stale, so undo can never silently throw away a
// layout the user built after the Agent's change.

import type { Workspace } from './workspace';

export interface WorkspaceUndoEntry {
    id: string;
    label: string;
    at: number;
    before: Workspace;
    afterSignature: string;
}

export type WorkspaceUndoResult =
    | { ok: true; entry: WorkspaceUndoEntry }
    | { ok: false; reason: 'empty' | 'stale' | 'mismatch' };

export function panelSignature(workspace: Workspace): string {
    return workspace.blocks
        .map((block) => `${block.id}\u0000${block.type}`)
        .sort()
        .join('\u0001');
}

export class WorkspaceUndoHistory {
    private entries: WorkspaceUndoEntry[] = [];
    private listeners = new Set<() => void>();
    private version = 0;
    private sequence = 0;

    constructor(private readonly limit = 10) {}

    push(before: Workspace, after: Workspace, label: string): WorkspaceUndoEntry {
        this.sequence += 1;
        const entry: WorkspaceUndoEntry = {
            id: `ws-undo-${Date.now().toString(36)}-${this.sequence}`,
            label,
            at: Date.now(),
            before: structuredClone(before),
            afterSignature: panelSignature(after),
        };
        this.entries.push(entry);
        if (this.entries.length > this.limit) {
            this.entries.splice(0, this.entries.length - this.limit);
        }
        this.emit();
        return entry;
    }

    /** The step undo would revert now, or null when none applies to `current`. */
    peek(current: Workspace): WorkspaceUndoEntry | null {
        const top = this.entries.at(-1);
        if (!top || top.afterSignature !== panelSignature(current)) return null;
        return top;
    }

    /** Remove and return the top step; `expectedId` guards against racing undos. */
    pop(current: Workspace, expectedId?: string): WorkspaceUndoResult {
        const top = this.entries.at(-1);
        if (!top) return { ok: false, reason: 'empty' };
        if (expectedId && expectedId !== top.id) return { ok: false, reason: 'mismatch' };
        if (top.afterSignature !== panelSignature(current)) {
            return { ok: false, reason: 'stale' };
        }
        this.entries.pop();
        this.emit();
        return { ok: true, entry: top };
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getVersion = (): number => this.version;

    private emit() {
        this.version += 1;
        this.listeners.forEach((listener) => listener());
    }
}
