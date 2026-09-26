// A desktop order mutation needs this page's boot to verify the listener's
// mode, version, scheme and Harness ownership. Persist the gate across the
// post-start reload and share it with child windows on the same origin.
import { isTauri } from './runtime';

const KEY = 'sj-pro-server-identity-verified';

export function setServerIdentityVerified(verified: boolean): void {
    if (!isTauri) return;
    try { localStorage.setItem(KEY, verified ? '1' : '0'); }
    catch { /* unavailable storage keeps desktop mutations blocked */ }
}

export function serverIdentityVerified(): boolean {
    if (!isTauri) return true;
    try { return localStorage.getItem(KEY) === '1'; }
    catch { return false; }
}
