// src/lib/app-lock-crypto.ts — 解鎖密碼的 PBKDF2 雜湊與驗證。

import { ITERATIONS, passwordTooShort, type AppLockState } from './app-lock-state';

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
async function derive(password: string, salt: string, iterations: number): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const salted = { name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), iterations };
    return toBase64(new Uint8Array(await crypto.subtle.deriveBits(salted, key, 256)));
}
export async function hashed(password: string) {
    if (passwordTooShort(password)) throw new Error('password-too-short');
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, hash: await derive(password, salt, ITERATIONS), iterations: ITERATIONS };
}
export const verify = async (s: AppLockState | null, password: string) => !!s && (await derive(password, s.salt, s.iterations)) === s.hash;
