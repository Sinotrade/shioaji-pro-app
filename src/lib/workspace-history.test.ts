import { describe, expect, it } from 'vitest';
import { panelSignature, WorkspaceUndoHistory } from './workspace-history';
import type { Workspace } from './workspace';

const ws = (...ids: string[]): Workspace => ({
    blocks: ids.map((id) => ({ id, type: 'chart' as const, pin: null })),
    layout: ids.map((id, i) => ({ i: id, x: i * 72, y: 0, w: 72, h: 10 })),
});

describe('WorkspaceUndoHistory', () => {
    it('one push is one undo step and undo returns the exact prior workspace', () => {
        const history = new WorkspaceUndoHistory();
        const before = ws('a');
        const after = ws('a', 'b');
        const entry = history.push(before, after, '研究版面');
        before.blocks[0]!.pin = 'MUTATED';
        expect(history.peek(after)).toBe(entry);
        const result = history.pop(after);
        expect(result.ok && result.entry.before).toEqual(ws('a'));
        expect(history.pop(after)).toEqual({ ok: false, reason: 'empty' });
    });

    it('stays undoable after moves but not after the panel set changes', () => {
        const history = new WorkspaceUndoHistory();
        const after = ws('a', 'b');
        history.push(ws('a'), after, 'x');
        const moved = structuredClone(after);
        moved.layout[1]!.y = 12;
        expect(history.peek(moved)).not.toBeNull();
        expect(history.peek(ws('a', 'b', 'c'))).toBeNull();
        expect(history.pop(ws('a', 'b', 'c'))).toEqual({ ok: false, reason: 'stale' });
        expect(history.peek(after)).not.toBeNull();
    });

    it('guards against undoing a different step than the caller saw', () => {
        const history = new WorkspaceUndoHistory();
        const first = history.push(ws('a'), ws('a', 'b'), 'one');
        history.push(ws('a', 'b'), ws('a', 'b', 'c'), 'two');
        expect(history.pop(ws('a', 'b', 'c'), first.id)).toEqual({ ok: false, reason: 'mismatch' });
        expect(history.pop(ws('a', 'b', 'c')).ok).toBe(true);
        expect(history.pop(ws('a', 'b'), first.id).ok).toBe(true);
    });

    it('keeps a bounded number of steps and notifies subscribers', () => {
        const history = new WorkspaceUndoHistory(2);
        let calls = 0;
        const off = history.subscribe(() => { calls += 1; });
        history.push(ws('a'), ws('b'), '1');
        history.push(ws('b'), ws('c'), '2');
        history.push(ws('c'), ws('d'), '3');
        expect(calls).toBe(3);
        expect(history.pop(ws('d')).ok).toBe(true);
        expect(history.pop(ws('c')).ok).toBe(true);
        expect(history.pop(ws('b'))).toEqual({ ok: false, reason: 'empty' });
        off();
        expect(history.getVersion()).toBe(5);
    });

    it('signature ignores panel order', () => {
        expect(panelSignature(ws('a', 'b'))).toBe(panelSignature(ws('b', 'a')));
    });
});
