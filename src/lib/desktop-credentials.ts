import { isTauri } from './runtime';
import { isChildWindow } from './window-role';
import { cacheDesktopConfigured } from './desktop-setup-state';
import { cacheAgentHarnessEnabled } from './agent-harness-state';

export type CredentialEnvironment = 'simulation' | 'production';
export interface CredentialProfile {
    id: string;
    name: string;
    environment: CredentialEnvironment;
    createdAt: string;
    hasCA: boolean;
    hasCaPassword?: boolean;
    caPath: string;
    apiKeyMasked: string;
    secretState: 'pending' | 'stored' | 'pendingDelete' | 'missing' | 'unavailable';
    credentialBackend: 'system' | 'plaintext-fallback';
    revision: string;
}

// Read model: contains no API key, secret key, or CA password.
export interface DesktopSettings {
    profiles: CredentialProfile[];
    activeProfileId: string | null;
    configured: boolean;
    production: boolean;
    caPath: string;
    hasCaPassword: boolean;
    credentialRevision: string | null;
    credentialBackend: 'system' | 'plaintext-fallback';
    fallbackPath: string | null;
    migrationError: string | null;
    autoStart: boolean;
    httpsEnabled: boolean;
    agentHarnessEnabled: boolean;
}

// Write-only form values. Callers clear their draft after submitting; there
// is deliberately no native command for retrieving these fields.
export interface CredentialDraft {
    id?: string;
    name: string;
    environment: CredentialEnvironment;
    caPath: string;
    apiKey?: string;
    secretKey?: string;
    caPassword?: string;
}

export const EMPTY_DESKTOP_SETTINGS: DesktopSettings = {
    profiles: [], activeProfileId: null, configured: false, production: false,
    caPath: '', hasCaPassword: false, credentialRevision: null,
    credentialBackend: 'system', fallbackPath: null, migrationError: null,
    autoStart: true, httpsEnabled: false, agentHarnessEnabled: true,
};

let pendingRead: Promise<DesktopSettings> | null = null;
let generation = 0;

async function nativeSettings(command: string, args?: Record<string, unknown>): Promise<DesktopSettings> {
    if (isChildWindow()) throw new Error('本機設定只能在主視窗讀取或修改');
    if (!isTauri) return { ...EMPTY_DESKTOP_SETTINGS, profiles: [] };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<DesktopSettings>(command, args);
}

function publish(settings: DesktopSettings): DesktopSettings {
    cacheAgentHarnessEnabled(settings.agentHarnessEnabled);
    cacheDesktopConfigured(settings.configured);
    return settings;
}

export function loadDesktopSettings(): Promise<DesktopSettings> {
    if (!pendingRead) {
        const started = generation;
        const read = nativeSettings('credentials_status').then(settings => {
            if (started === generation) publish(settings);
            return settings;
        }).finally(() => { if (pendingRead === read) pendingRead = null; });
        pendingRead = read;
    }
    return pendingRead;
}

async function mutate(command: string, args?: Record<string, unknown>): Promise<DesktopSettings> {
    const started = ++generation;
    pendingRead = null;
    const settings = await nativeSettings(command, args);
    if (started === generation) {
        generation++;
        pendingRead = null;
        publish(settings);
    }
    return settings;
}

export function saveDesktopSettings(settings: Pick<DesktopSettings, 'autoStart' | 'httpsEnabled' | 'agentHarnessEnabled'>): Promise<DesktopSettings> {
    return mutate('credentials_preferences', { preferences: {
        autoStart: settings.autoStart, httpsEnabled: settings.httpsEnabled,
        agentHarnessEnabled: settings.agentHarnessEnabled,
    } });
}

export async function saveCredentialProfile(profile: CredentialDraft): Promise<DesktopSettings> {
    try { return await mutate('credentials_save', { profile }); }
    finally {
        // Wipe the caller's write-only payload before any restart/health wait.
        delete profile.apiKey; delete profile.secretKey; delete profile.caPassword;
    }
}
export const selectCredentialProfile = (id: string) => mutate('credentials_select', { id });
export const deleteCredentialProfile = (id: string) => mutate('credentials_delete', { id });
export const logoutCredentialProfile = () => mutate('credentials_logout');
export const importCredentialEnv = (path: string, name: string, environment: CredentialEnvironment) =>
    mutate('credentials_import_env', { path, name, environment });
