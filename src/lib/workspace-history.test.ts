import { describe, expect, it, vi } from 'vitest';
import { WorkspaceUndoHistory } from './workspace-history';
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

    it('stays undoable after moves but not after any panel or setting edit', () => {
        const history = new WorkspaceUndoHistory();
        const after = ws('a', 'b');
        history.push(ws('a'), after, 'x');
        const moved = structuredClone(after);
        moved.layout[1]!.y = 12;
        expect(history.peek(moved)).not.toBeNull();
        expect(history.peek(ws('a', 'b', 'c'))).toBeNull();
        const edited = structuredClone(after);
        edited.blocks[0]!.chartInterval = '1m';
        expect(history.peek(edited)).toBeNull();
        const hidden = structuredClone(after);
        (hidden.blocks[1] as { chartOrder?: unknown }).chartOrder = { STK: { qty: 2 } };
        expect(history.pop(hidden)).toEqual({ ok: false, reason: 'stale' });
        expect(history.pop(ws('a', 'b', 'c'))).toEqual({ ok: false, reason: 'stale' });
        expect(history.peek(after)).not.toBeNull();
    });

    it('absorbs defaults that new panels persist right after the apply', () => {
        const history = new WorkspaceUndoHistory();
        const after = ws('a', 'b');
        const entry = history.push(ws('a'), after, 'x');
        const mounted = structuredClone(after);
        (mounted.blocks[1] as { flashLot?: unknown }).flashLot = 'Common';
        expect(history.peek(mounted)).toBeNull();
        expect(history.settle(mounted, entry.at + 500)).toBe(true);
        expect(history.peek(mounted)).toBe(entry);
        // a changed value is user work, never absorbed
        const changed = structuredClone(mounted);
        (changed.blocks[1] as { flashLot?: unknown }).flashLot = 'IntradayOdd';
        expect(history.settle(changed, entry.at + 600)).toBe(false);
        // a field added to a panel that existed before the change is user work
        const kept = structuredClone(mounted);
        kept.blocks[0]!.chartInterval = '1D';
        expect(history.settle(kept, entry.at + 600)).toBe(false);
        expect(history.peek(kept)).toBeNull();
        // link group codes are never absorbed
        expect(history.settle({ ...mounted, linkGroups: { A: '2330' } }, entry.at + 600)).toBe(false);
        // additions after the window are not absorbed either
        const late = structuredClone(mounted);
        (late.blocks[1] as { flashQty?: unknown }).flashQty = { lot: 2 };
        expect(history.settle(late, entry.at + 5_000)).toBe(false);
        // panel list changes are never absorbed
        expect(history.settle(ws('a', 'b', 'c'), entry.at + 100)).toBe(false);
    });

    it('issues random single-use validation tokens that expire', () => {
        const history = new WorkspaceUndoHistory();
        const t1 = history.issueValidation({ spec: 's', base: 'b' });
        const t2 = history.issueValidation({ spec: 's', base: 'b' });
        expect(t1).toMatch(/^[0-9a-f]{16}$/);
        expect(t1).not.toBe(t2);
        expect(history.peekValidation(t1)).toEqual({ spec: 's', base: 'b' });
        history.revokeValidation(t1);
        expect(history.peekValidation(t1)).toBeNull();
        expect(history.peekValidation('0123456789abcdef')).toBeNull();
        const now = Date.now();
        const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
        expect(history.peekValidation(t2)).toBeNull();
        spy.mockRestore();
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

});
