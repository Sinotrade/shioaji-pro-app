// 籌碼卡：處置清單回應格式不對時不可丟例外（Codex review）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: m.apiGet, apiPost: m.apiPost }));

import { fetchChips } from './chips-card';
import type { ContractInfo } from '../lib/types/contract';

const C = { security_type: 'STK', exchange: 'TSE', code: '2330' } as ContractInfo;

beforeEach(() => {
    m.apiGet.mockReset();
    m.apiPost.mockReset().mockResolvedValue([]);
});

describe('fetchChips punish guard', () => {
    it.each([[{}], [null], [{ code: null }], [{ code: '2330' }]])('treats %j as a failed punish read', async (body) => {
        m.apiGet.mockResolvedValue(body);
        const data = await fetchChips(C);
        expect(data.punished).toBeNull();
        expect(data.errors).toContain('處置查詢失敗');
    });

    it('still flags a listed code', async () => {
        m.apiGet.mockResolvedValue({ code: ['2330'] });
        const data = await fetchChips(C);
        expect(data.punished).toBe(true);
        expect(data.errors).toEqual([]);
    });
});
