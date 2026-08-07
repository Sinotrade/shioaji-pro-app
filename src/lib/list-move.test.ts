// src/lib/list-move.test.ts — watchlist 上移/下移 neighbor decision

import { describe, expect, it } from 'vitest';
import { neighborCode } from './list-move';

const CODES = ['2330', 'TXFH6', '2317', '0050'];

describe('neighborCode', () => {
    it('moves up toward the previous code', () => {
        expect(neighborCode(CODES, '2317', -1)).toBe('TXFH6');
    });

    it('moves down toward the next code', () => {
        expect(neighborCode(CODES, '2317', 1)).toBe('0050');
    });

    it('returns null at the top edge', () => {
        expect(neighborCode(CODES, '2330', -1)).toBeNull();
    });

    it('returns null at the bottom edge', () => {
        expect(neighborCode(CODES, '0050', 1)).toBeNull();
    });

    it('returns null for an unknown code', () => {
        expect(neighborCode(CODES, 'XXXX', 1)).toBeNull();
    });

    it('returns null for an empty list', () => {
        expect(neighborCode([], '2330', 1)).toBeNull();
    });
});
