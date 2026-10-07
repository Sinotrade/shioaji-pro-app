// Inert pre-entry evidence. Receipts never grant order/protection authority.
import { pendingProtectionStore } from './pending-protection-store';
import { notify } from './trade';
import { nativeExecutionSupported } from './execution/native';
import type { BracketSpec, BracketAdmission } from './bracket';

export type ProtectionRequest = Omit<BracketSpec, 'orderId' | 'seqno' | 'ordno'> & {
    entryOrder: Readonly<Record<string, string | number | boolean | undefined>>;
};
export interface ProtectionObligation {
    id: string;
    schema: 'protection-obligation-v1';
    owner: BracketAdmission['owner'];
    contextGeneration: number;
    ownerGeneration: number;
    hostId: string | null;
    request: ProtectionRequest;
}
export interface ProtectionRecord {
    id: string;
    obligation: ProtectionObligation;
    receipt?: string;
    completed?: BracketSpec & { planId: string };
    acknowledged?: boolean;
}
export interface ProtectionReceipt { readonly record: Readonly<ProtectionRecord> }
const KEY = 'sj-pro-bracket-obligations';
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const valid = (v: unknown): v is ProtectionRecord => !!v && typeof v === 'object'
    && typeof (v as ProtectionRecord).id === 'string'
    && (v as ProtectionRecord).obligation?.schema === 'protection-obligation-v1'
    && (v as ProtectionRecord).id === (v as ProtectionRecord).obligation.id;
const ledger = pendingProtectionStore(KEY, valid);
const listeners = new Set<() => void>();
let rows: ProtectionRecord[] = [];
let hosted: ProtectionRecord[] = [];
const emit = () => { listeners.forEach(l => l()); };
function scan() {
    const combined = new Map(hosted.map(r => [r.id, r]));
    for (const r of ledger.rows()) {
        const h = combined.get(r.id);
        // A host's immutable record wins over a conflicting renderer cache.
        if (!h || canonical(h.obligation) === canonical(r.obligation)) combined.set(r.id, { ...h, ...r, acknowledged: h?.acknowledged || r.acknowledged });
    }
    rows = [...combined.values()];
    emit();
}
try { scan(); } catch { /* preparation/dispatch still refuse unreadable storage */ }
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return (await import('@tauri-apps/api/core')).invoke<T>(command, args);
}
export async function refreshProtectionObligations(): Promise<void> {
    try {
        if (nativeExecutionSupported()) hosted = await invoke<ProtectionRecord[]>('execution_protection_records');
    } catch (error) {
        notify({ kind: 'err', title: '保護義務紀錄無法確認', body: '請核對原帳戶委託、持倉與保護紀錄；紀錄查詢尚未確認，勿重送或另掛重複出場單' });
        throw error;
    }
    scan();
}
if (nativeExecutionSupported()) void refreshProtectionObligations().catch(() => undefined);
if (typeof window !== 'undefined') window.addEventListener?.('storage', e => {
    if (ledger.handles(e.key)) { try { scan(); } catch { /* keep prior risk */ } }
});
export const getProtectionObligations = () => rows;
export function subscribeProtectionObligations(listener: () => void) {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
function readExact(record: ProtectionRecord): ProtectionRecord {
    const persisted = ledger.rows().find(r => r.id === record.id);
    if (!persisted || canonical(persisted.obligation) !== canonical(record.obligation) || persisted.acknowledged)
        throw new Error('保護義務紀錄未持久確認，未送出進場單');
    return persisted;
}
export async function prepareProtectionObligation(request: ProtectionRequest, admission: BracketAdmission): Promise<ProtectionReceipt> {
    if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0
        || !['Buy','Sell'].includes(request.action) || !request.env?.match(/\|(simulation|production)$/)
        || !request.account?.broker_id || !request.account.account_id
        || !['F','S'].includes(request.account.account_type) || !['FUT','OPT','STK'].includes(request.securityType)
        || (request.securityType === 'STK') !== (request.account.account_type === 'S')
        || !request.orderCode || !request.quoteCode || request.entryOrder.quantity !== request.quantity
        || request.entryOrder.action !== request.action
        || !Number.isSafeInteger(admission.contextGeneration) || !Number.isSafeInteger(admission.ownerGeneration)
        || [request.stopPrice,request.takePrice].some(p => p !== null && (!Number.isFinite(p) || p <= 0))) {
        throw new Error('保護義務內容無效，未送出進場單');
    }
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const obligation: ProtectionObligation = { id, schema: 'protection-obligation-v1', owner: admission.owner,
        contextGeneration: admission.contextGeneration, ownerGeneration: admission.ownerGeneration,
        hostId: admission.hostId, request: JSON.parse(JSON.stringify(request)) as ProtectionRequest };
    const record: ProtectionRecord = { id, obligation };
    ledger.write(record); readExact(record); // denied/missing/mismatched Storage is pre-send failure
    if (nativeExecutionSupported()) {
        const ack = await invoke<ProtectionRecord>('execution_protection_prepare', { obligation });
        if (!ack.receipt || canonical(ack.obligation) !== canonical(obligation)) throw new Error('保護義務持久回覆不符，未送出進場單');
        record.receipt = ack.receipt;
        hosted = [...hosted.filter(r => r.id !== id), ack];
        ledger.write(record); readExact(record);
    }
    scan();
    return Object.freeze({ record: Object.freeze(JSON.parse(JSON.stringify(record)) as ProtectionRecord) });
}
/** Called at the real transport boundary after async loading. Not cached health. */
export async function verifyProtectionReceipt(receipt: ProtectionReceipt): Promise<void> {
    const record = receipt.record;
    if (readExact(record).completed) throw new Error('保護義務已有登記證據，進場單不會重送');
    if (nativeExecutionSupported()) {
        const valid = record.receipt && await invoke<boolean>('execution_protection_check',
            { obligation: record.obligation, receipt: record.receipt });
        if (!valid) throw new Error('保護義務持久回覆已失效，未送出進場單');
    }
    if (readExact(record).completed) throw new Error('保護義務已有登記證據，進場單不會重送');
}
/** Completion is evidence, not deletion. Cold UI suppresses it only beside an actual matching owner plan. */
export async function completeProtectionObligation(receipt: ProtectionReceipt, spec: BracketSpec, planId: string): Promise<void> {
    const current = readExact(receipt.record);
    const want = current.obligation.request;
    for (const key of ['env','account','quoteCode','orderCode','securityType','exchange','action','quantity','orderLot','stopPrice','takePrice'] as const) {
        if (canonical(want[key]) !== canonical(spec[key])) throw new Error('保護登記範圍與進場義務不符，登記仍待確認');
    }
    if (!spec.orderId || !(spec.seqno?.trim() || spec.ordno?.trim()) || !planId) throw new Error('保護登記委託身分尚未確認');
    const completed = { ...spec, planId };
    const record = { ...current, completed };
    if (nativeExecutionSupported()) {
        const ack = await invoke<ProtectionRecord>('execution_protection_complete', { id: current.id, receipt: current.receipt, completed });
        if (canonical(ack.completed) !== canonical(completed)) throw new Error('保護登記持久回覆尚未確認');
        hosted = [...hosted.filter(r => r.id !== current.id), ack];
    }
    ledger.write(record);
    if (canonical(readExact(record).completed) !== canonical(completed)) throw new Error('保護登記紀錄未保存確認，登記仍待確認');
    scan();
}
export async function acknowledgeProtectionObligation(id: string): Promise<void> {
    const row = rows.find(r => r.id === id);
    if (!row) return;
    if (nativeExecutionSupported()) {
        await invoke('execution_protection_acknowledge', { id, receipt: row.receipt });
        hosted = hosted.map(r => r.id === id ? { ...r, acknowledged: true } : r);
    }
    ledger.write({ ...row, acknowledged: true });
    if (!ledger.rows().find(r => r.id === id && r.acknowledged && canonical(r.obligation) === canonical(row.obligation))) {
        throw new Error('人工核對紀錄尚未保存，保留此提醒');
    }
    scan();
}
