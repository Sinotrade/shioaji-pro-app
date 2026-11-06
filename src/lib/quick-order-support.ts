import type { SecurityType } from './types/contract';
import type { BlockType } from './workspace';

/** 搜尋開放權證不代表快速下單已支援；不可讓 WRT 落入期貨路徑。 */
export function quickOrderBlockMessage(
    securityType: SecurityType | undefined,
    type: BlockType,
): string | null {
    if (securityType === 'WRT' && (type === 'flash' || type === 'grid' || type === 'oddspread')) {
        return '權證不支援快速下單，請使用下單面板';
    }
    return null;
}
