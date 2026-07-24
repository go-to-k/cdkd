import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteBuilder } from 'vite-plus';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};
const sourceOnlyIgnorePatterns = ['**/*', '!src', '!src/**'];

const getVpCommand = (): string => {
  const localCommand = resolve(
    __dirname,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vp.cmd' : 'vp'
  );

  return existsSync(localCommand) ? localCommand : 'vp';
};

const isWatchBuild = (): boolean => process.argv.includes('--watch') || process.argv.includes('-w');

const runVpPack = (): void => {
  const result = spawnSync(getVpCommand(), ['pack', ...(isWatchBuild() ? ['--watch'] : [])], {
    cwd: __dirname,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`vp pack was terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`vp pack exited with code ${result.status ?? 1}`);
  }
};

const cdkdBuildPlugin: Plugin = {
  name: 'cdkd:vp-build',
  async buildApp(builder: ViteBuilder) {
    runVpPack();

    for (const environment of Object.values(builder.environments)) {
      environment.isBuilt = true;
    }
  },
};

export default defineConfig({
  plugins: [cdkdBuildPlugin],

  staged: {
    "*": "vp check --fix"
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },

  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.config.ts',
        '**/*.d.ts',
        'tests/**',
        'vite.config.ts',
      ],
    },
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    typecheck: {
      enabled: true,
      checker: 'tsc',
      tsconfig: './tsconfig.test.json',
      include: ['tests/**/*.test-d.ts', 'src/**/*.test-d.ts'],
    },
  },

  lint: {
    env: {
      node: true,
      es2022: true,
      vitest: true,
    },
    plugins: ['typescript', 'promise', 'vitest', 'eslint'],
    ignorePatterns: sourceOnlyIgnorePatterns,
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'off',
    },
  },

  fmt: {
    semi: true,
    trailingComma: 'es5',
    singleQuote: true,
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    arrowParens: 'always',
    endOfLine: 'lf',
    sortPackageJson: false,
    ignorePatterns: sourceOnlyIgnorePatterns,
  },

  pack: {
    entry: {
      index: 'src/index.ts',
      cli: 'src/cli/index.ts',
    },
    outDir: 'dist',
    platform: 'node',
    target: 'node20',
    format: 'esm',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    minify: false,
    define: {
      __CDKD_VERSION__: JSON.stringify(pkg.version),
    },
    deps: {
      neverBundle: [/^@aws-sdk\//, 'archiver', 'commander', 'graphlib', 'p-limit'],
    },
  },

  run: {
    cache: {
      tasks: true,
    },
    tasks: {
      build: {
        command: 'vp build',
        cache: false,
      },
      dev: {
        command: 'vp pack --watch',
        cache: false,
      },
      check: {
        command: 'vp check',
      },
      test: {
        command: 'vp test run',
      },
      'test:watch': {
        command: 'vp test watch',
        cache: false,
      },
      'test:coverage': {
        command: 'vp test run --coverage',
        cache: false,
      },
      lint: {
        command: 'vp lint',
      },
      'lint:fix': {
        command: 'vp lint --fix',
        cache: false,
      },
      format: {
        command: 'vp fmt',
        cache: false,
      },
      'format:check': {
        command: 'vp fmt --check',
      },
      typecheck: {
        command: 'tsc --project tsconfig.json --noEmit',
        // Same reason as `typecheck:test` below: Vite+'s task cache does not
        // invalidate on a `src/**` change, so a stale green replays as a
        // "cache hit" even after a real type error is introduced (verified).
        // A type-check gate must never be skipped by the cache.
        cache: false,
      },
      // `vp check` (and the `typecheck` task above) type-check only
      // tsconfig.json, whose `include` is `src/**` + `types/**` and whose
      // `exclude` drops `**/*.test.ts`. Test files were therefore never
      // type-checked by any gate — a wrong `import type` or a mock whose
      // shape no longer matches the real type slipped through both `vp check`
      // and `vp test` (whose "Type Errors" line only covers `*.test-d.ts`).
      // This task closes that hole by checking the test project explicitly;
      // CI runs it as its own step (issue #1133).
      'typecheck:test': {
        command: 'tsc --project tsconfig.test.json --noEmit',
        // Must NOT be cached: Vite+'s task cache did not invalidate on a
        // `tests/**/*.test.ts` content change (a deliberate bad-import break
        // replayed as a green "cache hit"), which would let exactly the
        // errors this gate exists to catch slip through both locally and in
        // CI. A ~1s type-check is cheap insurance against a false green.
        cache: false,
      },
      verify: {
        command: 'vp run check && vp run typecheck:test && vp run test && vp run build',
      },
      'runtime:smoke': {
        command: 'node dist/cli.js --version',
        dependsOn: ['build'],
        cache: false,
      },
      'audit:coverage': {
        command: 'node scripts/audit-provider-coverage.ts',
        cache: false,
      },
      'audit:coverage:regenerate': {
        command: 'node scripts/audit-provider-coverage.ts --regenerate',
        cache: false,
      },
      'audit:coverage:check': {
        command: 'node scripts/audit-provider-coverage.ts --check',
        cache: false,
      },
      'integ-coverage': {
        command: 'node --experimental-strip-types scripts/build-integ-coverage-matrix.ts',
        cache: false,
      },
      'cli-flag-coverage': {
        command: 'node --experimental-strip-types scripts/build-cli-flag-coverage-matrix.ts',
        cache: false,
      },
      'scenario-coverage': {
        command: 'node --experimental-strip-types scripts/build-scenario-coverage-matrix.ts',
        cache: false,
      },
      'integ-ledger-normalize': {
        command: 'node --experimental-strip-types scripts/normalize-integ-ledger.ts',
        cache: false,
      },
      'gen:unsupported-types': {
        command: 'node --experimental-strip-types scripts/gen-unsupported-types.ts',
        cache: false,
      },
      'gen:property-coverage': {
        command: 'node --experimental-strip-types scripts/gen-property-coverage.ts',
        cache: false,
      },
      'gen:enrichment-coverage': {
        command: 'node --experimental-strip-types scripts/gen-enrichment-coverage.ts',
        cache: false,
      },
      'audit:enrichment-coverage:check': {
        command: 'node --experimental-strip-types scripts/gen-enrichment-coverage.ts --check',
        cache: false,
      },
      'gen:sdk-attr-coverage': {
        command: 'node --experimental-strip-types scripts/gen-sdk-attr-coverage.ts',
        cache: false,
      },
      'audit:sdk-attr-coverage:check': {
        command: 'node --experimental-strip-types scripts/gen-sdk-attr-coverage.ts --check',
        cache: false,
      },
      'compat-corpus': {
        command: 'node --experimental-strip-types scripts/compat-corpus.ts',
        cache: false,
      },
    },
  },
});
