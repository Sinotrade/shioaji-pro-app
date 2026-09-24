// src/components/external-link.tsx — 外部網頁連結。桌面版由 plugin-shell
// 交給系統瀏覽器開啟（WebView 內不導航離開 App）；瀏覽器版走新分頁。

import { ExternalLink as ExternalLinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { isTauri } from '../lib/runtime';
import { openExternalUrl } from '../lib/tauri';

export function ExternalLink({
    href,
    children,
    className,
}: {
    href: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <a
            href={href}
            target='_blank'
            rel='noopener noreferrer'
            className={className}
            onClick={(e) => {
                if (!isTauri) return;
                e.preventDefault();
                void openExternalUrl(href);
            }}
        >
            {children}
            <ExternalLinkIcon size={11} aria-hidden='true' />
        </a>
    );
}
