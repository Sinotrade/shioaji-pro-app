// src/lib/chain-map.ts — shioaji-data structure helpers for 產業鏈資金流向.
//
// Pure lookups over themes / chains (stages and members). Live numbers live
// in chain-flow.ts; this file only knows the structure.

import type { ContractBase } from './types/contract';
import type { ChainTier, Theme, ThemeStage } from './company-data/types';

const TIER_ORDER: Record<string, number> = { upstream: 0, midstream: 1, downstream: 2 };

export function tierRank(tier: ChainTier): number {
    return TIER_ORDER[tier] ?? 3;
}

/** Stages in chain order: upstream → midstream → downstream, data order within a tier. */
export function orderedStages(theme: Theme): ThemeStage[] {
    return theme.stages
        .map((stage, index) => ({ stage, index }))
        .sort((a, b) => tierRank(a.stage.tier) - tierRank(b.stage.tier) || a.index - b.index)
        .map(({ stage }) => stage);
}

/** `tw.2330` + market → the stock contract used for snapshots and K-bar subscriptions. */
export function stockContract(code: string, market: string | undefined): ContractBase {
    return {
        security_type: 'STK',
        exchange: market === 'tpex' ? 'OTC' : 'TSE',
        code,
        target_code: null,
    };
}

/** Every Taiwan member code across the given themes (deduplicated, stable order). */
export function memberCodes(themes: readonly Theme[]): string[] {
    const seen = new Set<string>();
    for (const theme of themes) {
        for (const member of theme.members) {
            if (member.id.startsWith('tw.')) seen.add(member.id.slice(3));
        }
    }
    return [...seen];
}

/** Taiwan member codes of one theme. */
export function themeCodes(theme: Theme): string[] {
    return memberCodes([theme]);
}

/** Taiwan members per stage, deduplicated within a stage. */
export function stageMembers(theme: Theme): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const stage of theme.stages) map.set(stage.id, []);
    for (const member of theme.members) {
        if (!member.id.startsWith('tw.')) continue;
        const list = map.get(member.stage);
        const code = member.id.slice(3);
        if (list && !list.includes(code)) list.push(code);
    }
    return map;
}

/** Codes the 1-minute K-bar stream accepts (four ASCII digits, measured on 1.7.7). */
export function isKbarCode(code: string): boolean {
    return /^\d{4}$/.test(code);
}

export function fmtSignedPct(value: number | null | undefined, digits = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '--';
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** TWD in 兆 / 億 / 萬, with a sign when asked. */
export function fmtTwd(value: number | null | undefined, signed = false): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '--';
    const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
    const abs = Math.abs(value);
    if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)} 兆`;
    if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(abs >= 1e10 ? 0 : abs >= 1e9 ? 1 : 2)} 億`;
    if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString('en-US')} 萬`;
    return abs === 0 ? '0' : `${sign}${Math.round(abs)}`;
}
