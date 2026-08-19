// vite.config.ts

import fs from 'node:fs';
import path from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// closed-source modules (AI Agent, future tiered features) live in the
// private repo, checked out into ./modules on desktop builds; open-source
// builds resolve '@modules' to the empty stub manifest
const modulesDir = path.resolve(__dirname, './modules/index.ts');
const modulesTarget = fs.existsSync(modulesDir)
    ? modulesDir
    : path.resolve(__dirname, './src/modules-stub/index.ts');
const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version?: string };

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    return {
        base: env.VITE_BASE ?? '/',
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
            __KGI_APP_VERSION__: JSON.stringify(pkg.version ?? ''),
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
            // default stays 5173 for tauri dev. Bind loopback only so Vite
            // is never exposed to the LAN.
            host: '127.0.0.1',
            port: Number(process.env.PORT) || 5173,
            watch: {
                ignored: [
                    '**/.venv311/**',
                    '**/.venv/**',
                    '**/__pycache__/**',
                    '**/*.log',
                ],
            },
            proxy: {
                // React talks to the local KGI bridge. Override when testing a
                // bridge on another host/port.
                '/api': env.VITE_API_TARGET ?? 'http://127.0.0.1:21323',
            },
        },
    };
});
