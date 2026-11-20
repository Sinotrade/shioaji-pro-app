// src/components/account-query-failure.tsx — 台股帳務查詢失敗的共用呈現（#434 起）。
// 交割、預收、今日／歷史已實現損益、持倉、期貨保證金都經券商 TKAP01 損益後台或 r6，
// 夜間偶發 503、TKAP01 6044（目前以裸 500 Internal Server Error 回）、AS400 未連線。
// 這些暫時性／未開放失敗用灰字＋小重試（原始訊息放 title），其他才是紅字錯誤。

import { RotateCw } from 'lucide-react';
import { classifyAccountQueryError, type AccountQueryErrorKind } from '../lib/trading-limits-error';
import { AsyncStatus } from './async-status';
import * as styles from './bottom-dock.css';

export function RetryButton({ onRetry }: { onRetry: () => void }) {
    return (
        <button type='button' className={styles.acctRetry} onClick={onRetry}>
            <RotateCw size={11} aria-hidden /> 重試
        </button>
    );
}

export function QueryError({ text, onRetry }: { text: string; onRetry: () => void }) {
    return (
        <AsyncStatus
            phase='error'
            text={text}
            className={styles.acctError}
            action={<RetryButton onRetry={onRetry} />}
        />
    );
}

/** 暫時性／未開放失敗的灰字文案 */
export function accountQueryHintText(what: string, kind: Exclude<AccountQueryErrorKind, null>): string {
    return kind === 'unavailable' ? `券商${what}服務目前未開放` : '券商暫時查不到資料，稍後再試';
}

/**
 * 查詢失敗的呈現：暫時性失敗灰字＋小重試，真正的錯誤紅字＋重試。
 * `kind` 給了就不再分類（多帳戶合併的原始訊息無法整段分類時由呼叫端先分好）。
 */
export function AccountQueryFailure({ what, error, onRetry, kind }: {
    what: string;
    error: string;
    onRetry: () => void;
    kind?: AccountQueryErrorKind;
}) {
    const k = kind === undefined ? classifyAccountQueryError(error) : kind;
    if (!k) return <QueryError text={`${what}資訊查詢失敗：${error}`} onRetry={onRetry} />;
    return (
        <span className={styles.acctHint} title={error}>
            {accountQueryHintText(what, k)}
            {' '}<RetryButton onRetry={onRetry} />
        </span>
    );
}
