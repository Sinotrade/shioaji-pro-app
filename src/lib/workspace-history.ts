// src/lib/workspace-history.ts — undo steps for whole-workspace changes made
// by the Agent (#331). In memory only: an undo step never survives a reload.
//
// One apply = one entry. An entry is undoable only while the panels and all
// their settings (including fields the spec never shows: accounts,
// quantities, order and indicator state, pins, link groups) still match what
// the apply produced. Moving or resizing panels afterwards keeps it undoable
// (undo reverts the arrangement anyway); any other edit, adding or removing a
// panel, or loading another layout makes it stale, so undo never silently
// throws away settings the user changed after the Agent's change.
//
// It also holds the validation tokens issued by validate_workspace_spec:
// random, single-use, short-lived, and bound host-side to the exact
// normalized spec and workspace revision, so apply cannot be reached without
// a real validation.

import type { Workspace } from './workspace';
import { workspaceContentRevision } from './workspace-spec';

export interface WorkspaceUndoEntry {
    id: string;
    label: string;
    at: number;
    before: Workspace;
    afterRevision: string;
}

export interface WorkspaceSpecValidation {
    /** normalizedSpecFingerprint of the validated spec. */
    spec: string;
    /** workspaceRevision of the workspace it was validated against. */
    base: string;
}

const TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_LIMIT = 32;

function randomToken(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type WorkspaceUndoResult =
    | { ok: true; entry: WorkspaceUndoEntry }
    | { ok: false; reason: 'empty' | 'stale' | 'mismatch' };

export class WorkspaceUndoHistory {
    private entries: WorkspaceUndoEntry[] = [];
    private listeners = new Set<() => void>();
    private version = 0;
    private sequence = 0;
    private tokens = new Map<string, WorkspaceSpecValidation & { expires: number }>();

    constructor(private readonly limit = 10) {}

    /** Record a successful validation; returns its single-use token. */
    issueValidation(binding: WorkspaceSpecValidation): string {
        const now = Date.now();
        for (const [token, entry] of this.tokens) {
            if (entry.expires <= now) this.tokens.delete(token);
        }
        while (this.tokens.size >= TOKEN_LIMIT) {
            const oldest = this.tokens.keys().next().value;
            if (oldest === undefined) break;
            this.tokens.delete(oldest);
        }
        const token = randomToken();
        this.tokens.set(token, { ...binding, expires: now + TOKEN_TTL_MS });
        return token;
    }

    /** Look up a token without consuming it. */
    peekValidation(token: string): WorkspaceSpecValidation | null {
        const entry = this.tokens.get(token);
        if (!entry) return null;
        if (entry.expires <= Date.now()) {
            this.tokens.delete(token);
            return null;
        }
        return { spec: entry.spec, base: entry.base };
    }

    /** Invalidate a token (used, or proven stale). */
    revokeValidation(token: string) {
        this.tokens.delete(token);
    }

    /**
     * `after` must be the workspace as stored after the change (after the
     * App's own normalisation), or the step is immediately stale.
     */
    push(before: Workspace, after: Workspace, label: string): WorkspaceUndoEntry {
        this.sequence += 1;
        const entry: WorkspaceUndoEntry = {
            id: `ws-undo-${Date.now().toString(36)}-${this.sequence}`,
            label,
            at: Date.now(),
            before: structuredClone(before),
            afterRevision: workspaceContentRevision(after),
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
        if (!top || top.afterRevision !== workspaceContentRevision(current)) return null;
        return top;
    }

    /** Remove and return the top step; `expectedId` guards against racing undos. */
    pop(current: Workspace, expectedId?: string): WorkspaceUndoResult {
        const top = this.entries.at(-1);
        if (!top) return { ok: false, reason: 'empty' };
        if (expectedId && expectedId !== top.id) return { ok: false, reason: 'mismatch' };
        if (top.afterRevision !== workspaceContentRevision(current)) {
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
