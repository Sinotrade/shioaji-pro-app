// src/approval/main.tsx — Agent 交易核可視窗（獨立 Tauri window）
//
// 內容只來自 Rust state（agent_approval_pending，label 驗證），主 WebView
// 無法 script 或偽造本視窗。第一級可視化委託內容，技術細節收 detail
// 展開（docs/design/order-confirm-split.md）。
//
// 刪單／改價／減量是「對既有委託的操作」，payload 內的 order 是被操作的
// 原委託 — 絕不能把它的 action 當成新下單顯示成「買進 N 張」。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { darkTwClass } from '../theme.css';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './approval.css';

export interface ApprovalRequest {
    id: string;
    kind: string;
    runtimeId: string;
    operation: string;
    accountId: string;
    environment: string;
    payload: unknown;
    ttlMs: number;
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Obj)
        : null;
}

function num(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function unitOf(contract: Obj | null, order: Obj | null): string {
    if (contract?.security_type !== 'STK') return '口';
    return ['Odd', 'IntradayOdd'].includes(String(order?.order_lot)) ? '股' : '張';
}

export interface NewOrderSummary {
    kind: 'new';
    action: 'Buy' | 'Sell';
    code: string;
    market: boolean;
    price: number | null;
    quantity: number;
    unit: string;
    orderType: string;
    effect: string;
}

export interface ModifySummary {
    kind: 'modify';
    operation: 'cancel_order' | 'update_price' | 'update_qty';
    code: string | null;
    name: string | null;
    original: {
        action: 'Buy' | 'Sell' | null;
        market: boolean;
        price: number | null;
        quantity: number | null;
    };
    remaining: number | null;
    unit: string;
    orderNo: string | null;
    newPrice: number | null;
    reduceBy: number | null;
}

const MODIFY_OPERATIONS = new Set(['cancel_order', 'update_price', 'update_qty']);

// place_order payload 的可視化摘要
function parseNewOrder(payload: unknown): NewOrderSummary | null {
    const p = obj(payload);
    if (!p) return null;
    const contract = obj(p.contract);
    const order = obj(p.order ?? p.stock_order ?? p.futures_order);
    const code = contract?.code;
    if (
        typeof code !== 'string' ||
        !order ||
        (order.action !== 'Buy' && order.action !== 'Sell')
    ) {
        return null;
    }
    const quantity = Number(order.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    const market = order.price_type === 'MKT' || order.price_type === 'MKP';
    return {
        kind: 'new',
        action: order.action,
        code,
        market,
        price: market ? null : num(order.price),
        quantity,
        unit: unitOf(contract, order),
        orderType: String(order.order_type ?? '—'),
        effect: String(order.octype ?? order.order_lot ?? '—'),
    };
}

// 刪改單 payload：{operation, remaining_quantity, contract, order, status,
// request}。舊版 native 只送後四欄，剩餘量改由 status 推算；沒有
// status 就無從得知成交／取消量，顯示 — 而不是原委託量。
function parseModification(operation: string, payload: unknown): ModifySummary {
    const p = obj(payload);
    const contract = obj(p?.contract);
    const order = obj(p?.order);
    const status = obj(p?.status);
    const request = obj(p?.request);
    const ordered = status
        ? (num(status.order_quantity) ?? num(order?.quantity))
        : null;
    const derived =
        ordered === null
            ? null
            : ordered -
              (num(status?.deal_quantity) ?? 0) -
              (num(status?.cancel_quantity) ?? 0);
    const remaining =
        num(p?.remaining_quantity) ?? (derived !== null && derived >= 0 ? derived : null);
    const action =
        order?.action === 'Buy' || order?.action === 'Sell' ? order.action : null;
    const market = order?.price_type === 'MKT' || order?.price_type === 'MKP';
    const orderNo = [order?.ordno, order?.seqno].find(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    return {
        kind: 'modify',
        operation: operation as ModifySummary['operation'],
        code: typeof contract?.code === 'string' && contract.code ? contract.code : null,
        name: typeof contract?.name === 'string' && contract.name ? contract.name : null,
        original: {
            action,
            market,
            price: market ? null : num(order?.price),
            quantity: num(order?.quantity),
        },
        remaining,
        unit: unitOf(contract, order),
        orderNo: orderNo ?? null,
        newPrice: operation === 'update_price' ? num(request?.price) : null,
        reduceBy: operation === 'update_qty' ? num(request?.quantity) : null,
    };
}

/**
 * 依操作類型解析核可內容。外層 request.operation（Rust 核可狀態）是唯一
 * 依據；payload.operation 只是摘要附註，若與外層不一致就不解析內容，
 * 只顯示操作名稱 — 絕不在「核准刪單」上方畫出新單卡。
 */
export function summarizeApproval(
    request: Pick<ApprovalRequest, 'operation' | 'payload'>,
): NewOrderSummary | ModifySummary | null {
    const operation = request.operation;
    const declared = obj(request.payload)?.operation;
    if (declared !== undefined && declared !== operation) return null;
    if (MODIFY_OPERATIONS.has(operation)) {
        return parseModification(operation, request.payload);
    }
    return operation === 'place_order' ? parseNewOrder(request.payload) : null;
}

const OPERATION_LABEL: Record<string, string> = {
    place_order: '下單',
    cancel_order: '刪單',
    update_price: '改價',
    update_qty: '減量',
    place_comboorder: '組合下單',
    cancel_comboorder: '組合刪單',
    reserve_stock: '預約券',
    reserve_earmarking: '預收款券',
};

const APPROVE_LABEL: Record<string, string> = {
    cancel_order: '核准刪單',
    update_price: '核准改價',
    update_qty: '核准減量',
};

function maskAccount(id: string): string {
    if (id.length <= 4) return id;
    return `****${id.slice(-4)}`;
}

function qty(value: number | null, unit: string): string {
    return value === null ? '—' : `${value.toLocaleString()} ${unit}`;
}

// 市價只由 price_type 決定；限價卻缺價格時顯示 —，不猜成市價。
function priceLabel(market: boolean, price: number | null): string {
    if (market) return '市價';
    return price === null ? '—' : fmtPrice(price);
}

function sideLabel(action: 'Buy' | 'Sell' | null): string {
    return action === 'Buy' ? '買進' : action === 'Sell' ? '賣出' : '—';
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.row}>
            <span>{label}</span>
            <span className={styles.value}>{value}</span>
        </div>
    );
}

function ModifyDetails({ summary }: { summary: ModifySummary }) {
    const { original, unit, remaining } = summary;
    const originalPrice = priceLabel(original.market, original.price);
    return (
        <>
            <div className={styles.opLine}>
                {OPERATION_LABEL[summary.operation]}
                {summary.code && <span className={styles.code}> {summary.code}</span>}
            </div>
            <Row
                label="商品"
                value={
                    summary.code
                        ? [summary.code, summary.name].filter(Boolean).join(' ')
                        : '—'
                }
            />
            <Row
                label="原委託"
                value={`${sideLabel(original.action)} ${originalPrice} × ${qty(original.quantity, unit)}`}
            />
            {summary.orderNo && <Row label="委託書號" value={summary.orderNo} />}
            {summary.operation === 'cancel_order' ? (
                <Row label="刪除剩餘未成交" value={qty(remaining, unit)} />
            ) : (
                <Row label="剩餘未成交" value={qty(remaining, unit)} />
            )}
            {summary.operation === 'update_price' && (
                <Row
                    label="改價"
                    value={`${originalPrice} → ${summary.newPrice === null ? '—' : fmtPrice(summary.newPrice)}`}
                />
            )}
            {summary.operation === 'update_qty' && (
                <>
                    <Row label="減少" value={qty(summary.reduceBy, unit)} />
                    <Row
                        label="減量後剩餘"
                        value={
                            remaining === null || summary.reduceBy === null
                                ? '—'
                                : qty(Math.max(0, remaining - summary.reduceBy), unit)
                        }
                    />
                </>
            )}
        </>
    );
}

function NewOrderDetails({ summary }: { summary: NewOrderSummary }) {
    const dir = summary.action === 'Buy' ? ('up' as const) : ('down' as const);
    return (
        <>
            <div className={styles.actionLine[dir]}>
                {summary.action === 'Buy' ? '買進' : '賣出'}
                <span className={styles.code}>{summary.code}</span>
            </div>
            <Row
                label="價格"
                value={priceLabel(summary.market, summary.price)}
            />
            <Row label="數量" value={qty(summary.quantity, summary.unit)} />
            <Row
                label="委託條件／倉別或交易單位"
                value={`${summary.orderType} · ${summary.effect}`}
            />
        </>
    );
}

export interface ApprovalViewProps {
    request: ApprovalRequest;
    remaining: number | null;
    busy: boolean;
    error: string | null;
    detailOpen: boolean;
    onToggleDetail: () => void;
    onRespond: (approved: boolean) => void;
}

export function ApprovalView({
    request,
    remaining,
    busy,
    error,
    detailOpen,
    onToggleDetail,
    onRespond,
}: ApprovalViewProps) {
    const summary = summarizeApproval(request);
    const opLabel = OPERATION_LABEL[request.operation] ?? request.operation;
    const production = request.environment === 'production';

    return (
        <div className={styles.shell}>
            {error && (
                <div className={styles.error} role="alert">
                    核可未送出：{error}
                </div>
            )}
            <div className={styles.header}>
                Agent 交易核可
                <span className={styles.envBadge[production ? 'prod' : 'sim']}>
                    {production ? '正式環境' : request.environment}
                </span>
            </div>
            <div className={styles.card}>
                {request.kind === 'auto_session' && (
                    <div className={styles.hint}>
                        授權正式 Auto：送出本筆後，此 Agent 在本次 runtime、目前帳戶可依風控自動下單／刪單，不再逐筆詢問。停止 Agent、切換帳戶或重新啟動即失效。
                    </div>
                )}
                {summary?.kind === 'modify' ? (
                    <ModifyDetails summary={summary} />
                ) : summary?.kind === 'new' ? (
                    <NewOrderDetails summary={summary} />
                ) : (
                    <div className={styles.opLine}>{opLabel}</div>
                )}
                <Row label="操作" value={opLabel} />
                <Row label="帳戶" value={maskAccount(request.accountId)} />
                <Row label="發起" value={request.runtimeId} />
                {production && request.operation === 'place_order' && (
                    <div className={styles.hint}>
                        正式環境逐筆確認：核准時的報價須與提案時完全相同，且須在 15 秒內完成。報價若已跳動，本筆會退回並顯示「報價已變動，請重新確認」，請讓 Agent 依最新報價重新提案。
                    </div>
                )}
                {remaining !== null && (
                    <div className={styles.ttl}>
                        {remaining > 0
                            ? `未回應將於 ${remaining} 秒後自動拒絕`
                            : '已逾時 — 本請求將被拒絕'}
                    </div>
                )}
            </div>
            <button className={styles.detailToggle} onClick={onToggleDetail}>
                {detailOpen ? '收合技術細節' : '顯示技術細節'}
            </button>
            {detailOpen && (
                <pre className={styles.detail}>
                    {JSON.stringify(
                        {
                            id: request.id,
                            kind: request.kind,
                            operation: request.operation,
                            runtimeId: request.runtimeId,
                            accountId: request.accountId,
                            environment: request.environment,
                            ttlMs: request.ttlMs,
                            payload: request.payload,
                        },
                        null,
                        2,
                    )}
                </pre>
            )}
            <div className={styles.footer}>
                <button
                    className={styles.denyBtn}
                    disabled={busy}
                    onClick={() => onRespond(false)}
                >
                    拒絕
                </button>
                <button
                    className={styles.approveBtn}
                    disabled={busy || remaining === 0}
                    onClick={() => onRespond(true)}
                >
                    {request.kind === 'auto_session'
                        ? '授權本次 Auto 並送出'
                        : (APPROVE_LABEL[request.operation] ?? '核准')}
                </button>
            </div>
            <div className={styles.hint}>
                只有你現在確實要讓這個 Agent 送出上述交易時才核准。
            </div>
        </div>
    );
}

// 瀏覽器設計檢視與測試用樣本（去識別化）。?preview 或 ?preview=<key>
// 只在非 Tauri 環境生效：沒有 invoke 就沒有真核可流程，永遠到不了 Rust state。
const FIXTURE_CONTRACT = {
    security_type: 'STK',
    exchange: 'TSE',
    code: '2330',
    name: '台積電',
};
const FIXTURE_ORDER = {
    id: 'a1b2c3d4',
    seqno: '000123',
    ordno: 'W0001',
    action: 'Buy',
    price: 1000,
    quantity: 5,
    price_type: 'LMT',
    order_type: 'ROD',
    order_lot: 'Common',
};
const FIXTURE_STATUS = {
    id: 'a1b2c3d4',
    status: 'PartFilled',
    order_quantity: 5,
    deal_quantity: 2,
    cancel_quantity: 1,
};

function fixture(operation: string, payload: unknown): ApprovalRequest {
    return {
        id: `approval-preview-${operation}`,
        kind: 'exact_mutation',
        runtimeId: 'codex-a1b2c3',
        operation,
        accountId: 'S:9A95:0021234567',
        environment: 'production',
        payload,
        ttlMs: 15_000,
    };
}

const modification = (operation: string, request: Obj) => ({
    operation,
    remaining_quantity: 2,
    contract: FIXTURE_CONTRACT,
    order: FIXTURE_ORDER,
    status: FIXTURE_STATUS,
    request: { trade_id: 'a1b2c3d4', ...request },
});

export const APPROVAL_FIXTURES: Record<string, ApprovalRequest> = {
    place: fixture('place_order', {
        contract: { code: 'CCFI6', security_type: 'FUT', exchange: 'TAIFEX' },
        futures_order: {
            action: 'Buy',
            price: 130.5,
            quantity: 2,
            price_type: 'LMT',
            order_type: 'ROD',
            octype: 'Auto',
        },
    }),
    cancel: fixture('cancel_order', modification('cancel_order', {})),
    // 舊版 native payload（無 operation／remaining_quantity）也不得顯示成新單
    'cancel-legacy': fixture('cancel_order', {
        contract: FIXTURE_CONTRACT,
        order: FIXTURE_ORDER,
        status: FIXTURE_STATUS,
        request: { trade_id: 'a1b2c3d4' },
    }),
    update_price: fixture('update_price', modification('update_price', { price: 995 })),
    update_qty: fixture('update_qty', modification('update_qty', { quantity: 1 })),
};

function previewRequest(): ApprovalRequest | null {
    if ('__TAURI_INTERNALS__' in window) return null;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('preview')) return null;
    return APPROVAL_FIXTURES[params.get('preview') || 'place'] ?? APPROVAL_FIXTURES.place!;
}

function ApprovalApp({ preview }: { preview: ApprovalRequest | null }) {
    const [request, setRequest] = useState<ApprovalRequest | null>(preview);
    const [detailOpen, setDetailOpen] = useState(false);
    const [remaining, setRemaining] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = () =>
        invoke<ApprovalRequest | null>('agent_approval_pending')
            .then((next) => {
                setError(null);
                setRequest(next);
                setDetailOpen(false);
                setRemaining(
                    next
                        ? Math.ceil(Math.min(300_000, Math.max(0, next.ttlMs)) / 1000)
                        : null,
                );
            })
            .catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setRequest(preview);
            });

    useEffect(() => {
        if (preview) {
            setRemaining(Math.round(preview.ttlMs / 1000));
            return;
        }
        void refresh();
        const unlisten = listen('agent-approval:pending', () => {
            void refresh();
        });
        return () => {
            void unlisten.then((fn) => fn());
        };
    }, []);

    // TTL 倒數（顯示用 — 逾時由 Rust 端強制拒絕）
    useEffect(() => {
        if (remaining === null) return;
        const timer = setInterval(() => {
            setRemaining((r) => (r === null || r <= 0 ? r : r - 1));
        }, 1000);
        return () => clearInterval(timer);
    }, [remaining !== null]);

    const respond = (approved: boolean) => {
        if (!request || busy) return;
        setBusy(true);
        setError(null);
        invoke('agent_approval_respond', { id: request.id, approved })
            .catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => {
                setBusy(false);
                void refresh();
            });
    };

    if (!request) {
        return (
            <div className={styles.shell}>
                <div className={styles.empty}>沒有待核可的 Agent 交易請求</div>
            </div>
        );
    }

    return (
        <ApprovalView
            request={request}
            remaining={remaining}
            busy={busy}
            error={error}
            detailOpen={detailOpen}
            onToggleDetail={() => setDetailOpen((open) => !open)}
            onRespond={respond}
        />
    );
}

// 測試（node 環境）只 import 元件與解析函式，不掛載整頁。
const rootElement =
    typeof document === 'undefined' ? null : document.getElementById('root');
if (rootElement) {
    document.documentElement.classList.add(darkTwClass);
    createRoot(rootElement).render(
        <StrictMode>
            <ApprovalApp preview={previewRequest()} />
        </StrictMode>,
    );
}
