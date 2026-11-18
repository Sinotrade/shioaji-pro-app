// src/lib/us/us-account-batch.ts — 美股帳務的多帳戶批次查詢
//
// - 一批（例：損益＋股利、餘額＋交割）開始時記下伺服器與模式；批次結束時變了
//   就整批作廢重查一次，再變就丟錯（不把兩種模式的資料混在一起）。
// - 每個帳戶各自成功或失敗。失敗時保留這個帳戶上次成功的資料，標成 stale；
//   合計只算這次成功的帳戶（畫面註明部分帳戶查詢失敗）。
// - 503／404 是「服務尚未開放」，不是錯誤。
// - 刷新事件：dock「更新帳務」與美股下單／刪單／減量後要重查餘額。

import { getApiBase } from '../runtime';
import { getServerModeVersion } from '../server-info-store';
import type { Account } from '../types/portfolio';
import { isUsAccountUnavailable, usAccountErrorText } from './us-account-api';

export type PerAccount<T> = { account: Account } & (
    | { state: 'ok'; data: T }
    /** 這次失敗，顯示上次成功的資料；不算進合計 */
    | { state: 'stale'; data: T; error: string }
    | { state: 'unavailable' }
    | { state: 'error'; error: string }
);

export const US_MODE_CHANGED_ERROR = '查詢期間伺服器模式已變更，已丟棄回應；請重新更新';
const MODE_CHANGED = '伺服器模式已變更';

const accountKey = (a: Account) => `H:${a.broker_id}:${a.account_id}`;
const lastGood = new Map<string, unknown>();

/** 測試用 */
export function resetUsAccountBatchForTest() { lastGood.clear(); }

function scopeKey(kind: string, account: Account, scope: string) {
    return `${scope}|${kind}|${accountKey(account)}`;
}

/** 一批查詢的上下文：同一個伺服器與模式 */
export interface UsBatch {
    scope: string;
    each<T>(kind: string, accounts: Account[], fetch: (a: Account) => Promise<T>): Promise<PerAccount<T>[]>;
}

class ModeChanged extends Error {}

function makeBatch(scope: string, pending: Map<string, unknown>): UsBatch {
    return {
        scope,
        async each<T>(kind: string, accounts: Account[], fetch: (a: Account) => Promise<T>) {
            const settled = await Promise.allSettled(accounts.map(fetch));
            return settled.map((r, i): PerAccount<T> => {
                const account = accounts[i]!;
                const key = scopeKey(kind, account, scope);
                if (r.status === 'fulfilled') {
                    pending.set(key, r.value);
                    return { account, state: 'ok', data: r.value };
                }
                const message = r.reason instanceof Error ? r.reason.message : String(r.reason ?? '');
                if (message.includes(MODE_CHANGED)) throw new ModeChanged();
                if (isUsAccountUnavailable(r.reason)) return { account, state: 'unavailable' };
                const error = usAccountErrorText(r.reason);
                return lastGood.has(key)
                    ? { account, state: 'stale', data: lastGood.get(key) as T, error }
                    : { account, state: 'error', error };
            });
        },
    };
}

/**
 * 跑一批查詢。批次中伺服器或模式變了：整批丟掉重查一次；再變就丟出
 * US_MODE_CHANGED_ERROR（useQuery 保留上一次的資料）。成功的帳戶資料
 * 在整批確定有效後才記成「上次成功」。
 */
export async function runUsBatch<R>(run: (batch: UsBatch) => Promise<R>): Promise<R> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const base = getApiBase();
        const mode = getServerModeVersion();
        const scope = `${base}|${mode}`;
        const pending = new Map<string, unknown>();
        try {
            const result = await run(makeBatch(scope, pending));
            if (base === getApiBase() && mode === getServerModeVersion()) {
                pending.forEach((v, k) => lastGood.set(k, v));
                return result;
            }
        } catch (e) {
            if (!(e instanceof ModeChanged)) throw e;
        }
    }
    throw new Error(US_MODE_CHANGED_ERROR);
}

/** 只有「服務尚未開放」：整區顯示一行 */
export function allUnavailable<T>(rows: PerAccount<T>[] | undefined) {
    return !!rows && rows.length > 0 && rows.every(r => r.state === 'unavailable');
}

/** 每個（不是未開放的）帳戶這次都失敗：顯示錯誤狀態，不是「沒有資料」 */
export function allFailed<T>(rows: PerAccount<T>[] | undefined) {
    if (!rows || rows.length === 0) return false;
    const live = rows.filter(r => r.state !== 'unavailable');
    return live.length > 0 && live.every(r => r.state === 'stale' || r.state === 'error');
}

/** 有任何帳戶這次失敗（合計不完整） */
export function someFailed<T>(rows: PerAccount<T>[] | undefined) {
    return !!rows && rows.some(r => r.state === 'stale' || r.state === 'error');
}

export function failureText<T>(rows: PerAccount<T>[] | undefined): string {
    return [...new Set((rows ?? []).flatMap(r => (r.state === 'stale' || r.state === 'error' ? [r.error] : [])))].join('；');
}

export { onUsAccountRefresh, requestUsAccountRefresh } from './us-account-events';
