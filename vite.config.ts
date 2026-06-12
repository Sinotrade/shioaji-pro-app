// vite.config.ts

import fs from 'node:fs';
import path from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// the AI Agent module is closed-source (desktop builds check out the
// private submodule into ./agent); open-source builds get the stub
const agentDir = path.resolve(__dirname, './agent/index.ts');
const agentTarget = fs.existsSync(agentDir)
    ? agentDir
    : path.resolve(__dirname, './src/agent-stub/index.tsx');

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    return {
        base: env.VITE_BASE ?? '/',
        // shioaji app upload flattens nested paths — emit a flat bundle
        build: { assetsDir: '' },
        // react-draggable (react-grid-layout dep) reads process.env at runtime
        define: { 'process.env': {} },
        plugins: [vanillaExtractPlugin(), react()],
        resolve: {
            alias: {
                '@agent': agentTarget,
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
