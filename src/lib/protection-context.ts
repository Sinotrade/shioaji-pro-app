// Admission/report bindings are process-local. A persisted token cannot confirm a new host.
import { currentProtectionEnv, onProtectionEnvChange } from './protection-env';
import { getServerModeVersion } from './server-info-store';
import { getStreamStatus, subscribeStatusStore } from './stream';
const host = `context-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let generation = 0;
let previous = '';
function observe() {
    const next = JSON.stringify([currentProtectionEnv(), getServerModeVersion(), getStreamStatus()]);
    if (previous && previous !== next) generation++;
    previous = next;
}
observe();
onProtectionEnvChange(observe);
subscribeStatusStore(observe);
export function getProtectionContextVersion(): number { observe(); return generation; }
export function currentReportContext(): string | null {
    observe();
    return currentProtectionEnv() && getStreamStatus() === 'live' ? `${host}:${generation}` : null;
}
