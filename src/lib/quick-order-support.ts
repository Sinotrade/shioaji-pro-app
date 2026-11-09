import type { SecurityType } from './types/contract';
import type { BlockType } from './workspace';

/**
 * 權證可以用閃電下單（整張、現股，跳動價位走權證表）；網格與整零價差
 * 仍不開放：網格引擎沒有權證規則，整零價差需要零股（權證不得零股交易）。
 */
export function quickOrderBlockMessage(
    securityType: SecurityType | undefined,
    type: BlockType,
): string | null {
    if (securityType === 'WRT' && type === 'oddspread') {
        return '權證不得零股交易，沒有整零價差；請使用閃電下單或下單面板';
    }
    if (securityType === 'WRT' && type === 'grid') {
        return '權證不支援網格下單，請使用閃電下單或下單面板';
    }
    return null;
}
