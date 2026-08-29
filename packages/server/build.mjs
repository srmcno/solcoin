import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/**
 * The server is bundled rather than run from loose files.
 *
 * This is not a packaging preference, it is a correctness requirement. Several
 * dependencies in the Solana ecosystem are CommonJS-only — `@coral-xyz/anchor`
 * chief among them — and are imported with named bindings by other packages
 * (`import { BN } from '@coral-xyz/anchor'`). Node's ESM loader resolves those
 * bindings by statically lexing the CJS module, which fails on anchor's build,
 * so the process dies at link time with "does not provide an export named BN".
 *
 * Bundling resolves the interop at build time with an explicit shim, which is
 * both the standard fix and the one that keeps development and production
 * running identical code paths. It also collapses deployment to a single file
 * plus one native module.
 */
const options = {
  entryPoints: [resolve(here, 'src/main.ts'), resolve(here, 'src/cli/doctor.ts'), resolve(here, 'src/cli/migrate.ts')],
  outdir: resolve(here, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Native addons cannot be bundled; better-sqlite3 loads a .node binary.
  external: ['better-sqlite3', 'pino-pretty'],
  // Several bundled dependencies are CJS and reference these at module scope.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: false,
};

await rm(resolve(here, 'dist'), { recursive: true, force: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  // eslint-disable-next-line no-console
  console.log('esbuild watching for changes');
} else {
  await build(options);
}
