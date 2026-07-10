// vite.config.ts

import fs from 'node:fs';
import path from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';

// closed-source modules (AI Agent, future tiered features) live in the
// private repo, checked out into ./modules on desktop builds; open-source
// builds resolve '@modules' to the empty stub manifest
const modulesDir = path.resolve(__dirname, './modules/index.ts');
const modulesTarget = fs.existsSync(modulesDir)
    ? modulesDir
    : path.resolve(__dirname, './src/modules-stub/index.ts');
// In the split public/private worktree, ./modules is a symlink into the
// private checkout. Vite resolves Worker URLs to that real path, so explicitly
// allow the resolved modules directory without hard-coding either repository.
const modulesAllowDir = path.dirname(fs.realpathSync(modulesTarget));
const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version?: string };

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    return {
        base: env.VITE_BASE ?? '/',
        // shioaji app upload flattens nested paths — emit a flat bundle.
        // target: old Intel Macs run older WKWebView (Safari 13–15 era);
        // Vite 8's default (baseline-widely-available ≈ Safari 16) emits
        // syntax those webviews cannot parse → white screen on launch (#4)
        build: { assetsDir: '', target: ['es2020', 'safari13'] },
        // react-draggable (react-grid-layout dep) reads process.env at runtime
        define: {
            'process.env': {},
            // feature-flag service client key (publishable) — from .env
            // locally, or the STATSIG_CLIENT_KEY secret in CI builds
            __STATSIG_CLIENT_KEY__: JSON.stringify(
                env.STATSIG_CLIENT_KEY ??
                    process.env.STATSIG_CLIENT_KEY ??
                    '',
            ),
            __SHIOAJI_APP_VERSION__: JSON.stringify(pkg.version ?? ''),
            // bundled server version（repo 根目錄 SHIOAJI_VERSION —
            // 與 CI 下載 sidecar 的同一個來源）— app 開機做版本握手
            __SHIOAJI_SERVER_VERSION__: JSON.stringify(
                fs
                    .readFileSync(
                        path.resolve(__dirname, 'SHIOAJI_VERSION'),
                        'utf8',
                    )
                    .trim(),
            ),
        },
        plugins: [vanillaExtractPlugin(), react()],
        resolve: {
            alias: {
                '@modules': modulesTarget,
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            // honor a harness-assigned port (preview tooling sets PORT);
            // default stays 5173 for tauri dev
            port: Number(process.env.PORT) || 5173,
            fs: {
                allow: [searchForWorkspaceRoot(process.cwd()), modulesAllowDir],
            },
            proxy: {
                // dev 打自帶 sidecar（scripts/dev-api.sh，與 CI 打包同版
                // binary、port 21322）— 確保 API/UI 版本相符，不依賴使用
                // 者自裝在 8080 的 CLI。要打別台時用 VITE_API_TARGET 蓋掉
                '/api': env.VITE_API_TARGET ?? 'http://127.0.0.1:21322',
            },
        },
    };
});
