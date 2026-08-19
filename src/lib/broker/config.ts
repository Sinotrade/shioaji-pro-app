// src/lib/broker/config.ts

export type BrokerId = 'kgi';

function envFlag(name: string): string | undefined {
    const value = import.meta.env[name] as string | undefined;
    return value?.trim();
}

export function getBrokerId(): BrokerId {
    return 'kgi';
}

export function isKgiBrokerEnabled(): boolean {
    return true;
}

export function isKgiMockMode(): boolean {
    const raw =
        envFlag('VITE_KGI_MOCK') ??
        envFlag('VITE_BROKER_MOCK') ??
        envFlag('VITE_MOCK_BROKER');
    return raw === undefined ? true : raw.toLowerCase() !== 'false';
}

export function getKgiBackendBase(): string {
    const env = envFlag('VITE_KGI_BACKEND_BASE');
    return env?.replace(/\/$/, '') || 'http://127.0.0.1:21323';
}

export function getKgiStreamBase(): string {
    const env = envFlag('VITE_KGI_STREAM_BASE');
    return env?.replace(/\/$/, '') || getKgiBackendBase();
}

export function activeBrokerLabel(): string {
    return isKgiMockMode() ? 'KGI SuperPy mock' : 'KGI SuperPy';
}
