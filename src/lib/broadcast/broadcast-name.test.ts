import { expect, it } from 'vitest';
import { toSpeakName } from './broadcast-name';

it('removes the dash so the TTS does not read it as an English word', () => {
    expect(toSpeakName('眾達-KY')).toBe('眾達KY');
});

it('rewrites an option name into base / strike / right', () => {
    expect(toSpeakName('台積電選擇權6月1900Call')).toBe('台積電 1900 Call');
    expect(toSpeakName('台積電選擇權6月1900Put')).toBe('台積電 1900 Put');
    expect(toSpeakName('小型選擇權月1900.5C')).toBe('小型 1900.5 Call');
    // WpfApp6 只認單一的 C／P，這邊一樣要能用
    expect(toSpeakName('台積電選擇權6月1900C')).toBe('台積電 1900 Call');
    expect(toSpeakName('台積電選擇權6月1900P')).toBe('台積電 1900 Put');
});

it('drops the delivery month from a futures name', () => {
    expect(toSpeakName('TX期貨12')).toBe('TX期');
    expect(toSpeakName('TX期12')).toBe('TX期');
    // 結尾沒有數字就不動（WPF 的正則要求 \d+$）
    expect(toSpeakName('小台期貨')).toBe('小台期貨');
    expect(toSpeakName('TX 12期')).toBe('TX 12期');
});

it('leaves a plain stock name untouched', () => {
    expect(toSpeakName('台積電')).toBe('台積電');
});
