// src/components/order-confirm-dialog.tsx — 可視化委託確認 host
//
// App 掛載一次；lib/order-confirm 服務有待確認委託時渲染 modal。
// 第一級只有交易員要看的東西：方向、商品、價格、數量、環境 —
// 不是 raw payload（docs/design/order-confirm-split.md）。

import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import {
    getPendingOrderConfirm,
    resolveOrderConfirm,
    subscribeOrderConfirm,
    type OrderConfirmRequest,
} from '../lib/order-confirm';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './order-confirm-dialog.css';

function ConfirmModal({ request }: { request: OrderConfirmRequest }) {
    // Esc＝取消，走 modal stack（不誤武裝 Esc-Esc 全刪單）
    useEscClose(() => resolveOrderConfirm(false));
    const dir = request.action === 'Buy' ? ('up' as const) : ('down' as const);
    return createPortal(
        <div
            className={styles.overlay}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) resolveOrderConfirm(false);
            }}
        >
            <div
                className={styles.dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby="order-confirm-title"
            >
                <div className={styles.header}>
                    <span id="order-confirm-title">委託確認</span>
                    {request.simulation !== null && (
                        <span
                            className={
                                styles.envBadge[
                                    request.simulation ? 'sim' : 'prod'
                                ]
                            }
                        >
                            {request.simulation ? '模擬環境' : '正式環境'}
                        </span>
                    )}
                </div>
                <div className={styles.body}>
                    <div className={styles.actionLine[dir]}>
                        {request.action === 'Buy' ? '買進' : '賣出'}
                        <span className={styles.contractName}>
                            {request.name || request.code}
                        </span>
                        {request.name && (
                            <span className={styles.note}>{request.code}</span>
                        )}
                    </div>
                    <div className={styles.detailRow}>
                        <span>價格</span>
                        <span className={styles.detailValue}>
                            {request.priceLabel ??
                                (request.price === null
                                    ? '市價'
                                    : fmtPrice(request.price))}
                        </span>
                    </div>
                    {request.accountLabel && (
                        <div className={styles.detailRow}>
                            <span>帳戶</span>
                            <span className={styles.detailValue}>
                                {request.accountLabel}
                            </span>
                        </div>
                    )}
                    <div className={styles.detailRow}>
                        <span>數量</span>
                        <span className={styles.detailValue}>
                            {request.quantity.toLocaleString()} {request.unit}
                        </span>
                    </div>
                    {request.note && (
                        <span className={styles.note}>{request.note}</span>
                    )}
                </div>
                <div className={styles.footer}>
                    <button
                        className={styles.cancelBtn}
                        autoFocus
                        onClick={() => resolveOrderConfirm(false)}
                    >
                        取消
                    </button>
                    <button
                        className={styles.confirmBtn[dir]}
                        onClick={() => resolveOrderConfirm(true)}
                    >
                        確認{request.action === 'Buy' ? '買進' : '賣出'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function OrderConfirmHost() {
    const request = useSyncExternalStore(
        subscribeOrderConfirm,
        getPendingOrderConfirm,
    );
    if (!request) return null;
    return <ConfirmModal request={request} />;
}
