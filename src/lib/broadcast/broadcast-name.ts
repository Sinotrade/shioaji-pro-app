// src/lib/broadcast/broadcast-name.ts — 商品名稱 → 念得出來的字串。
//
// 移植自 WpfApp6 的 MonitorItemViewModel.CheckAndBroadcast()，三個坑：
//   1. 名稱裡的 '-' 會被 TTS 念成英文 dash → 去掉（眾達-KY → 眾達KY）
//   2. 選擇權名稱照念又長又難懂
//      （台積電選擇權6月1900Call → 台積電 1900 Call）
//   3. 期貨名稱結尾的月份數字（TX期貨12 → TX期）

// 選擇權名稱格式：{標的}選擇權{月份字母}月{履約價}{C|P}
// WpfApp6 的正則只認單一的 C／P；這邊連 Call／Put 也收，
// 兩種券商命名都念得出來（超集，不會改掉原本行為）。
const OPTION_PATTERN =
    /^(.*?)選擇權[A-Za-z0-9]*月(\d+(?:\.\d+)?)(Call|Put|C|P)$/i;
// 期貨名稱結尾的月份數字
const FUTURES_PATTERN = /(期貨|期)\s*\d+$/g;

export function toSpeakName(raw: string): string {
    const name = raw.replace(/-/g, '');
    const option = OPTION_PATTERN.exec(name);
    if (option) {
        const base = option[1] ?? '';
        const strike = option[2] ?? '';
        const right = option[3] ?? 'C';
        const cp = right.toUpperCase().startsWith('C') ? 'Call' : 'Put';
        return `${base} ${strike} ${cp}`;
    }
    return name.replace(FUTURES_PATTERN, '期');
}
