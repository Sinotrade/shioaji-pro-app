// src/lib/esc-cancel-arm.ts — Esc×2 全部刪單的「第一下」狀態
//
// 放在獨立 module：use-hotkeys 讀寫它，畫圖工具、對話框等用掉 Esc 的介面
// 可以把它清掉（不必 import use-hotkeys 連帶載入下單模組）。先按一下 Esc
// 武裝、接著在畫圖 UI 裡按 Esc 取消東西、再按一下 Esc — 第三下不能跟第一下
// 湊成 Esc×2。

let lastEsc = 0;

export const ESC_CANCEL_WINDOW_MS = 600;

// 記一下 Esc；回傳 true 表示與前一下湊成 Esc×2（並清除狀態）
export function noteEscPress(now: number): boolean {
    if (lastEsc && now - lastEsc < ESC_CANCEL_WINDOW_MS) {
        lastEsc = 0;
        return true;
    }
    lastEsc = now;
    return false;
}

export function resetEscCancelArm() {
    lastEsc = 0;
}
