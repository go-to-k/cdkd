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
    // Off at the ROOT as well as per task. Every task below carries
    // `cache: false` and `tests/unit/scripts/vite-task-cache.test.ts` fences
    // that, but a task added later inherits this switch before it inherits any
    // fence, so the two are belt and braces rather than a duplication: the
    // switch makes a new task safe by default, the per-task flags keep the
    // policy visible where it is read, and the fence keeps them from being
    // quietly dropped.
    cache: {
      tasks: false,
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
      // `vp run check` is CI's required step and `/check` step 1 calls it "the
      // EXACT command CI runs", so its verdict is evidence twice over. The task
      // cache did not invalidate on a `src/**` change for `typecheck` (verified,
      // see that task below), and this task runs the same type-check.
      check: {
        command: 'vp check',
        cache: false,
      },
      // NOT cached, for the same reason `typecheck` / `typecheck:test` /
      // `test:once-leak` below are not: a correctness gate must never replay a
      // cached green. The cache cost two distinct false greens here rather than
      // one.
      //
      // 1. A REPLAY. A repeat invocation printed the previous run's summary
      //    verbatim -- same counts, same duration, same `Start at` -- with
      //    `cache hit, NNs saved` appended BELOW the green block, where a
      //    `tail` does not reach. The task key also ignores env vars, so a run
      //    under `CDKD_EXPECT_DIST=1` could be answered by one without it.
      // 2. A SILENT NO-OP. When the Vite+ cache encoder overflows its 4 MB
      //    preallocation while serialising this task's inputs, the lookup fails,
      //    NOTHING runs, no `Test Files` summary is printed, and the process
      //    exits 0 -- so `/check` would record its commit-gate marker over a
      //    suite that never executed. Reproduced on this repo 2026-08-30
      //    (`needed 6871312 bytes`) and recorded four separate times since
      //    2026-05-16, each time diagnosed from scratch.
      //
      // The cache bought a replay of a run whose inputs had not changed, which
      // in the dev loop is a run nobody makes. `check` / `lint` / `format:check`
      // / `verify` were the other four still caching and are uncached for the
      // same reason -- after this, NO task in this file caches, which is the
      // honest end state: every one of them either produces a verdict that is
      // read as evidence, or regenerates an artifact whose freshness is the
      // whole point.
      test: {
        command: 'vp test run',
        cache: false,
      },
      'test:watch': {
        command: 'vp test watch',
        cache: false,
      },
      'test:coverage': {
        command: 'vp test run --coverage',
        cache: false,
      },
      // Issue #1618 — the unit suite with the runtime `*Once`-leak detector
      // armed. `vp test run` rather than `vp run test` on purpose: the latter
      // USED to be cached, with a key that ignores env vars, so it could replay
      // an earlier green summary and report "no leaks" without having looked.
      // Nothing caches any more, but the direct spelling is still the one to
      // use — see the `test` task above.
      'test:once-leak': {
        command: 'CDKD_ONCE_LEAK_DETECT=1 vp test run',
        cache: false,
      },
      // Runs the deliberately-leaking canary suite with the grandfather list
      // ignored. Expected to FAIL — CI inverts the exit code. See the
      // `detector canary` step in .github/workflows/ci.yml.
      'test:once-leak-canary': {
        command:
          'CDKD_ONCE_LEAK_DETECT=1 CDKD_ONCE_LEAK_IGNORE_ALLOWLIST=1 ' +
          'vp test run tests/unit/scripts/once-leak-canary.test.ts',
        cache: false,
      },
      'gen:once-leak-allowlist': {
        command: 'node --experimental-strip-types scripts/gen-once-leak-allowlist.ts',
        cache: false,
      },
      // A replay measured 2026-08-30: two consecutive `vp run lint` printed a
      // byte-identical summary with `cache hit, 1.23s saved` BELOW it, where a
      // `tail` does not reach.
      lint: {
        command: 'vp lint',
        cache: false,
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
        cache: false,
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
      // Chains four gates, so a cache hit on the CHAIN would report all four
      // green without running any of them -- the same hazard one level up.
      verify: {
        command: 'vp run check && vp run typecheck:test && vp test run && vp run build',
        cache: false,
      },
      // The `.claude/hooks/**` smoke tests, run under every bash on the
      // machine. Before issue #1477 no task and no CI job ran them at all,
      // so a suite could rot unnoticed — `provider-integ-gate.test.sh` was
      // failing 3 of its 17 cases under macOS's system bash 3.2, and
      // #1458 shipped a bash-4-only `mapfile` into the shared matcher that
      // only an explicit `/bin/bash` run would have caught. NOT part of
      // `vp run check` / `verify`: the suites build throwaway git repos and
      // take ~6 minutes, which is the wrong cost for the inner dev loop.
      // `.github/workflows/hooks.yml` runs this on any `.claude/hooks/**`
      // change.
      'test:hooks': {
        command: 'bash .claude/hooks/run-tests.sh',
        // A correctness gate must never replay a cached green: the task's
        // inputs are shell scripts outside any source glob Vite+ tracks.
        cache: false,
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
      'audit:aws-client-defaults:check': {
        command: 'node scripts/check-aws-client-defaults.ts --check',
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
      'gen:update-wrap-coverage': {
        command: 'node --experimental-strip-types scripts/gen-update-wrap-coverage.ts',
        cache: false,
      },
      'audit:update-wrap-coverage:check': {
        command: 'node --experimental-strip-types scripts/gen-update-wrap-coverage.ts --check',
        cache: false,
      },
      // Re-captures the AWS CLI's removed-command table into
      // tests/fixtures/aws-cli-removed-commands.json (issue #1402). Needs a
      // locally installed AWS CLI v2, so it is deliberately NOT wired into CI:
      // the committed capture is the oracle, and a `--check` in CI would go red
      // whenever AWS ships a CLI that removes one more command — noise on a
      // schedule nobody controls. Run it by hand after an AWS CLI upgrade.
      'gen:aws-cli-removals': {
        command: 'node --experimental-strip-types scripts/refresh-aws-cli-removals.ts',
        cache: false,
      },
      'audit:aws-cli-removals:check': {
        command: 'node --experimental-strip-types scripts/refresh-aws-cli-removals.ts --check',
        cache: false,
      },
      'gen:nested-key-coverage': {
        command: 'node --experimental-strip-types scripts/gen-nested-key-coverage.ts',
        cache: false,
      },
      'audit:nested-key-coverage:check': {
        command: 'node --experimental-strip-types scripts/gen-nested-key-coverage.ts --check',
        cache: false,
      },
      'gen:handled-property-wiring': {
        command: 'node --experimental-strip-types scripts/gen-handled-property-wiring.ts',
        cache: false,
      },
      'audit:handled-property-wiring:check': {
        command: 'node --experimental-strip-types scripts/gen-handled-property-wiring.ts --check',
        cache: false,
      },
      // Issue #2040 — every provider `catch` site that wraps an AWS error must
      // thread it as `cause`, or `isTransientServerError` / `isThrottlingError`
      // / `isMarkedNonRetryable` (all of which walk `.cause`) are INERT for that
      // call and the same AWS failure is retryable in one provider and terminal
      // in another. `cache: false` for the same reason `typecheck` carries it:
      // a checker whose green can be replayed from cache is a false assurance —
      // it would report "no dropped causes" without having looked.
      'audit:provider-error-cause:check': {
        command: 'node --experimental-strip-types scripts/check-provider-error-cause.ts',
        cache: false,
      },
      // Issue #2053 — every `withRetry` under `src/provisioning/**` must thread
      // `isInterrupted` / `onInterrupted`. `withRetry` is the ONLY thing that
      // polls an interrupt DURING a backoff (the engine, `destroy-runner.ts`
      // and `rollback-executor.ts` all poll only BETWEEN operations), so a call
      // that omits the pair leaves Ctrl-C dead for its whole schedule — and on
      // the destroy path `withResourceTimeout` has by then abandoned the
      // promise, so the loop keeps issuing writes behind a run the user was
      // told had ended. `cache: false` for the same reason the sibling critic
      // carries it: a green that can be replayed from cache is a checker
      // reporting "all threaded" without having looked.
      'audit:withretry-interrupt:check': {
        command: 'node --experimental-strip-types scripts/check-withretry-interrupt.ts',
        cache: false,
      },
      // Issue #2178 — a provider interpolating a `properties`-derived value into
      // a message must mask it BEFORE `JSON.stringify`, not after. Masking the
      // finished message cannot recover it: `JSON.stringify` escapes `"` / `\` /
      // newlines so the secret no longer OCCURS in the line, and a message is
      // always longer than the value inside it so only `maskSecretsInText`'s
      // >= 4-character SUBSTRING arm is reachable. The rule has been prose since
      // issue #1932 and was violated anyway in files already hardened for it
      // (issue #2176), which is what turns it into a mechanical check. The
      // classifier is DATAFLOW-aware, so a mask applied upstream of the
      // stringify passes. `cache: false` for the same reason the two critics
      // above carry it: a green that can be replayed from cache is a checker
      // reporting "all masked" without having looked.
      'audit:provider-secret-mask:check': {
        command: 'node --experimental-strip-types scripts/check-provider-secret-mask.ts',
        cache: false,
      },
      // Issue #2228 — every exported value symbol with a cdkd-authored body under
      // `src/local/**` must be transitively reachable from a shipped entry point,
      // or carry `@no-live-caller` / `@test-only-export` saying it is not. Half of
      // that directory is a re-export surface over cdk-local and the boundary has
      // moved repeatedly; what a move leaves behind still compiles and still has
      // passing tests, so a fix landing in the orphan ships as a NO-OP with every
      // gate green (issue #2203 did exactly that). The rule is symbol-level, not
      // module-level, because `vtl-engine.ts` HAS a live importer and still runs
      // nothing. `cache: false` for the same reason the critics above carry it: a
      // green replayed from cache is a checker reporting "all reachable" without
      // having looked.
      'audit:local-reachability:check': {
        command: 'node --experimental-strip-types scripts/check-local-reachability.ts',
        cache: false,
      },
      // Escape hatch for issue #1842's evidence-loss verdict: the plain writer
      // above REFUSES to overwrite the matrix with weaker per-property evidence
      // than the committed one records. Use this only when the reduction is
      // intended (the property genuinely lost that seam) and say why in the PR
      // body — it prints every lost evidence shape and seeding member before
      // writing. Deliberately NOT part of `gen:all-matrices`: the aggregate must
      // stay the command that FAILS on an accidental degradation.
      'gen:handled-property-wiring:accept-loss': {
        command:
          'node --experimental-strip-types scripts/gen-handled-property-wiring.ts --accept-evidence-loss',
        cache: false,
      },
      // Regenerates EVERY CI-enforced matrix in one shot, so `/verify-pr` (and
      // anyone about to push) can check freshness without knowing the list.
      //
      // The list used to live only in `.claude/skills/verify-pr/SKILL.md`, and
      // it drifted: CI grew to NINE staleness guards while the skill still
      // named four. Issue #1417 — a private method rename staled
      // `handled-property-wiring`, `/verify-pr` reported clean, and CI failed.
      // `tests/unit/scripts/matrix-regen-coverage.test.ts` pins this task
      // against the guards actually present in `.github/workflows/ci.yml`, so a
      // NEW matrix cannot be added to CI without also landing here.
      //
      // Deliberately excludes `audit:coverage:regenerate` (needs AWS creds,
      // 10-30 min) and `gen:aws-cli-removals` (needs a local AWS CLI); neither
      // is a CI staleness guard.
      'gen:all-matrices': {
        command: [
          'vp run integ-coverage',
          'vp run scenario-coverage',
          'vp run cli-flag-coverage',
          'vp run gen:unsupported-types',
          'vp run gen:property-coverage',
          // The property-coverage codegen writes a raw multi-line shape while
          // the committed module is Prettier-formatted, so CI's guard runs
          // `format` before diffing. Regenerating WITHOUT it produces a
          // formatting-only diff that looks like real drift (hit live while
          // preparing #1416).
          'vp run format',
          'vp run gen:enrichment-coverage',
          'vp run gen:sdk-attr-coverage',
          'vp run gen:update-wrap-coverage',
          'vp run gen:nested-key-coverage',
          'vp run gen:handled-property-wiring',
          // Not a matrix, but the same class of CI guard: a rebase can
          // denormalize the committed integ ledger, and the failure looks
          // identical (regenerate-and-commit).
          'vp run integ-ledger-normalize',
        ].join(' && '),
        cache: false,
      },
      'compat-corpus': {
        command: 'node --experimental-strip-types scripts/compat-corpus.ts',
        cache: false,
      },
    },
  },
});
