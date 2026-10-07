import { describe, it, expect } from 'vitest';
import { externalIdentity } from './core';
import table from './identity-truth-table.json';

describe('external broker identity truth table', () => {
    for (const [i, row] of table.entries()) {
        it(`case ${i + 1}: ${row.expected}`, () => {
            expect(externalIdentity(row.a, row.b)).toBe(row.expected);
            expect(externalIdentity(row.b, row.a)).toBe(row.expected);
        });
    }
});
