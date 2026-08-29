import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // Integration tests each open their own SQLite database; running files in
    // parallel is safe, running tests inside a file in parallel is not.
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Several Solana packages ship ESM that imports named bindings from
    // CommonJS-only dependencies (notably `@coral-xyz/anchor`). Node's loader
    // cannot resolve those statically, so Vite is told to transform them
    // itself, which applies the interop the packages assume they will get.
    server: { deps: { inline: [/@pump-fun\//, /@coral-xyz\//] } },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/migrations/**', 'packages/web/**'],
      reporter: ['text-summary', 'html'],
    },
  },
  resolve: {
    alias: {
      '@solcoin/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
});
