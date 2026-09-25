import { expect, it } from 'vitest';
import { withBlockPatch, type Workspace } from './workspace';

it('withBlockPatch merges fields into one block only and keeps the rest', () => {
    const w = { blocks: [{ id: 'a', type: 'flash', pin: null }, { id: 'b', type: 'flash', pin: 'TMF' }], layout: [] } as unknown as Workspace;
    const next = withBlockPatch(w, 'b', { flashAccounts: { F: 'F:BR:A' } });
    expect(next.blocks[1]).toEqual({ id: 'b', type: 'flash', pin: 'TMF', flashAccounts: { F: 'F:BR:A' } });
    expect(next.blocks[0]).toBe(w.blocks[0]);
    expect(w.blocks[1]).not.toHaveProperty('flashAccounts');
});
