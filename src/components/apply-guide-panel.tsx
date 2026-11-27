// src/components/apply-guide-panel.tsx — App 裡的「申請／下載憑證導覽」面板。
//
// 和首次設定同一套導覽（apply-guide.tsx）與同一個申請視窗，但不蓋住整個畫面：
// 面板貼齊主視窗左側（申請視窗蓋住主視窗右側時，原生端本來就保留左側給導覽），
// 主畫面照常運作。開始頁先選要做的事；關閉面板時一併關掉申請視窗
// （官網登入保存在申請視窗自己的資料區，下次打開通常不用重新登入）。

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { InAppGuideTask } from '../lib/apply-guide-config';
import { closeApplyWindow } from '../lib/apply-guide-native';
import type { DesktopSettings } from '../lib/tauri';
import { ApplyGuide, useApplyGuide } from './apply-guide';
import * as g from './apply-guide.css';

export function ApplyGuidePanel({ settings, request, onClose, onChanged, onOpenAccount }: {
    settings: DesktopSettings;
    /** 要做的事（null：先選要做的事）；seq 每次要求都不同，同一件事再要求一次也會切過去 */
    request: { task: InAppGuideTask | null; seq: number };
    onClose: () => void;
    /** 金鑰或憑證存進帳號了：重新讀取帳號清單 */
    onChanged: () => void;
    /** 到帳號設定編輯這個帳號（輸入憑證密碼） */
    onOpenAccount: (profileId: string) => void;
}) {
    const guide = useApplyGuide(() => onChanged(), { task: request.task ?? 'sign', onChanged });
    // 每次要求（捷徑或設定裡的按鈕）都照做：指定的事直接開始，null 回到選擇
    const handled = useRef(0);
    useEffect(() => {
        if (handled.current === request.seq) return;
        handled.current = request.seq;
        if (request.task) void guide.chooseTask(request.task);
        else if (guide.step !== 'start') guide.backToTasks();
    }, [request.seq]); // eslint-disable-line react-hooks/exhaustive-deps
    const close = () => { void closeApplyWindow(); onClose(); };
    // 到帳號設定輸入憑證密碼：申請視窗是原生視窗、會蓋在設定上面，先關掉（官網登入保留）
    const openAccount = (profileId: string) => { void closeApplyWindow(); onOpenAccount(profileId); };
    const panel = <div className={`${g.tokens} ${g.panel}`} data-testid="apply-guide-panel">
        <ApplyGuide guide={guide} settings={settings} busy={false} docked inApp fab={false}
            onClose={close} onOpenAccount={openAccount}
            onManual={() => openAccount('')} onStart={async () => undefined} />
    </div>;
    return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
