// useIndexComponents — retain 一組 (指數, 投影) 並回傳各投影目前狀態。
// projections 以 projectionKey 串接後當依賴，呼叫端請傳穩定的陣列
// （useMemo 或 module 常數），避免每 render 重訂閱。

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
    getIcBootstrapStatus,
    getIcState,
    getIcSubError,
    getIcVersion,
    projectionKey,
    retainIndexComponents,
    subscribeIcStore,
} from '../lib/index-components';
import type { ContractBase } from '../lib/types/contract';
import type { IcProjection, IcProjectionState } from '../lib/types/market';

export function useIndexComponents(
    index: ContractBase,
    projections: IcProjection[],
): {
    states: (IcProjectionState | undefined)[];
    subErrors: (string | undefined)[];
    bootstrap: ReturnType<typeof getIcBootstrapStatus>;
} {
    const keys = projections.map(projectionKey).join(',');
    useEffect(() => {
        const releases = projections.map((projection) =>
            retainIndexComponents(index, projection),
        );
        return () => releases.forEach((release) => release());
        // projections 內容以 keys 表達；index 以 code 表達
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index.code, keys]);
    const version = useSyncExternalStore(subscribeIcStore, getIcVersion);
    return useMemo(() => {
        void version;
        return {
            states: projections.map((projection) =>
                getIcState(index.code, projectionKey(projection)),
            ),
            subErrors: projections.map((projection) =>
                getIcSubError(index.code, projectionKey(projection)),
            ),
            bootstrap: getIcBootstrapStatus(index.code),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index.code, keys, version]);
}
