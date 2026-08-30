// src/approval/main.tsx — Agent 交易核可視窗（獨立 Tauri window）
//
// 內容只來自 Rust state（agent_approval_pending，label 驗證），主 WebView
// 無法 script 或偽造本視窗。第一級可視化委託內容，技術細節收 detail
// 展開（docs/design/order-confirm-split.md）。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { darkTwClass } from '../theme.css';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './approval.css';

interface ApprovalRequest {
    id: string;
    kind: string;
    runtimeId: string;
    operation: string;
    accountId: string;
    environment: string;
    payload: unknown;
    ttlMs: number;
}

// place_order payload 的可視化摘要（其餘操作 fallback 到操作名）
function parseOrderSummary(payload: unknown): {
    action: 'Buy' | 'Sell';
    code: string;
    price: number | null;
    quantity: number;
} | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as {
        contract?: { code?: unknown };
        order?: {
            action?: unknown;
            price?: unknown;
            quantity?: unknown;
            price_type?: unknown;
        };
        stock_order?: unknown;
        futures_order?: unknown;
    };
    const order = (p.order ??
        p.stock_order ??
        p.futures_order) as typeof p.order;
    const code = p.contract?.code;
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
    const price = Number(order.price);
    return {
        action: order.action,
        code,
        price: market || !Number.isFinite(price) ? null : price,
        quantity,
    };
}

const OPERATION_LABEL: Record<string, string> = {
    place_order: '下單',
    cancel_order: '刪單',
    update_price: '改價',
    update_qty: '改量',
    place_comboorder: '組合下單',
    cancel_comboorder: '組合刪單',
    reserve_stock: '預約券',
    reserve_earmarking: '預收款券',
};

function maskAccount(id: string): string {
    if (id.length <= 4) return id;
    return `****${id.slice(-4)}`;
}

// 瀏覽器設計檢視用樣本（?preview）— 只在非 Tauri 環境生效：沒有
// invoke 就沒有真核可流程，這裡永遠到不了 Rust state
const PREVIEW_REQUEST: ApprovalRequest | null =
    !('__TAURI_INTERNALS__' in window) &&
    new URLSearchParams(window.location.search).has('preview')
        ? {
              id: 'approval-preview',
              kind: 'trading_grant',
              runtimeId: 'codex-a1b2c3',
              operation: 'place_order',
              accountId: 'F0021234567',
              environment: 'production',
              payload: {
                  contract: {
                      code: 'CCFI6',
                      security_type: 'FUT',
                      exchange: 'TAIFEX',
                  },
                  order: {
                      action: 'Buy',
                      price: 130.5,
                      quantity: 2,
                      price_type: 'LMT',
                      order_type: 'ROD',
                  },
              },
              ttlMs: 120_000,
          }
        : null;

function ApprovalApp() {
    const [request, setRequest] = useState<ApprovalRequest | null>(
        PREVIEW_REQUEST,
    );
    const [detailOpen, setDetailOpen] = useState(false);
    const [remaining, setRemaining] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = () =>
        invoke<ApprovalRequest | null>('agent_approval_pending')
            .then((next) => {
                setRequest(next);
                setDetailOpen(false);
                setRemaining(next ? Math.round(next.ttlMs / 1000) : null);
            })
            .catch(() => setRequest(PREVIEW_REQUEST));

    useEffect(() => {
        if (PREVIEW_REQUEST) {
            setRemaining(Math.round(PREVIEW_REQUEST.ttlMs / 1000));
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
        invoke('agent_approval_respond', { id: request.id, approved })
            .catch(() => undefined)
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

    const summary = parseOrderSummary(request.payload);
    const opLabel = OPERATION_LABEL[request.operation] ?? request.operation;
    const dir = summary?.action === 'Buy' ? ('up' as const) : ('down' as const);

    return (
        <div className={styles.shell}>
            <div className={styles.header}>
                Agent 交易核可
                <span
                    className={
                        styles.envBadge[
                            request.environment === 'production'
                                ? 'prod'
                                : 'sim'
                        ]
                    }
                >
                    {request.environment === 'production'
                        ? '正式環境'
                        : request.environment}
                </span>
            </div>
            <div className={styles.card}>
                {summary ? (
                    <>
                        <div className={styles.actionLine[dir]}>
                            {summary.action === 'Buy' ? '買進' : '賣出'}
                            <span className={styles.code}>{summary.code}</span>
                        </div>
                        <div className={styles.row}>
                            <span>價格</span>
                            <span className={styles.value}>
                                {summary.price === null
                                    ? '市價'
                                    : fmtPrice(summary.price)}
                            </span>
                        </div>
                        <div className={styles.row}>
                            <span>數量</span>
                            <span className={styles.value}>
                                {summary.quantity.toLocaleString()}
                            </span>
                        </div>
                    </>
                ) : (
                    <div className={styles.opLine}>{opLabel}</div>
                )}
                <div className={styles.row}>
                    <span>操作</span>
                    <span className={styles.value}>{opLabel}</span>
                </div>
                <div className={styles.row}>
                    <span>帳戶</span>
                    <span className={styles.value}>
                        {maskAccount(request.accountId)}
                    </span>
                </div>
                <div className={styles.row}>
                    <span>發起</span>
                    <span className={styles.value}>{request.runtimeId}</span>
                </div>
                {remaining !== null && (
                    <div className={styles.ttl}>
                        {remaining > 0
                            ? `未回應將於 ${remaining} 秒後自動拒絕`
                            : '已逾時 — 本請求將被拒絕'}
                    </div>
                )}
            </div>
            <button
                className={styles.detailToggle}
                onClick={() => setDetailOpen((open) => !open)}
            >
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
                    onClick={() => respond(false)}
                >
                    拒絕
                </button>
                <button
                    className={styles.approveBtn}
                    disabled={busy}
                    onClick={() => respond(true)}
                >
                    核准
                </button>
            </div>
            <div className={styles.hint}>
                只有你現在確實要讓這個 Agent 送出上述交易時才核准。
            </div>
        </div>
    );
}

document.documentElement.classList.add(darkTwClass);
createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <ApprovalApp />
    </StrictMode>,
);
