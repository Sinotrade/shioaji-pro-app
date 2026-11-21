import { style } from '@vanilla-extract/css';
import { resetBtn } from './hud-header.css';

// 1600px 以下（頂欄改用小間距的同一個斷點）只留開關：1401～1440px 是頂欄最滿的寬度，
// 多「螢幕鎖」三個字就會換成兩列。按鈕本身有 aria-label，報讀名稱不受影響
const compact = '(max-width: 1600px)';

export const capsule = style([resetBtn, {
    borderRadius: '999px', padding: '0 6px 0 10px', gap: '6px',
    '@media': { [compact]: { padding: '0 6px', gap: 0 } },
}]);
export const label = style({ '@media': { [compact]: { display: 'none' } } });
