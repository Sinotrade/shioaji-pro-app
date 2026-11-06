import * as styles from './derivative-explorer.css';

// 權證、個股期面板共用：標的目錄或衍生合約讀取失敗時保留上次資料，並可一起重讀
export function CatalogRetryAlert({
    catalogError,
    error,
    text,
    onRetry,
}: {
    catalogError: boolean;
    error: boolean;
    text: string;
    onRetry: () => void;
}) {
    if (!catalogError && !error) return null;
    return (
        <div role='alert' className={styles.error}>
            {catalogError ? '標的目錄載入失敗' : text}；保留上次資料
            <button type='button' onClick={onRetry}>重試商品資料</button>
        </div>
    );
}
