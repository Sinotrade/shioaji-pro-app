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

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    return {
        base: env.VITE_BASE ?? '/',
        // shioaji app upload flattens nested paths — emit a flat bundle
        build: { assetsDir: '' },
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
        },
        plugins: [vanillaExtractPlugin(), react()],
        resolve: {
            alias: {
                '@modules': modulesTarget,
                '@': path.resolve(__dirname, './src'),
            },
        },
        server: {
            proxy: {
                '/api': 'http://localhost:8080',
            },
        },
    };
});
