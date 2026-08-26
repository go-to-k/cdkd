/**
 * Issue #2228 — the `src/local/**` reachability critic.
 *
 * PROBES MUTATE A MAP, NOT THE TREE
 * ---------------------------------
 * `analyzeReachability` reads an in-memory `Map<path, source>`, so every probe
 * here takes the REAL source tree, edits one entry of the copy, and re-analyzes.
 * Nothing is written to disk, so there is no restore step to get wrong — a probe
 * loop killed by a timeout cannot leave a mutation behind, which is the failure
 * that has bitten this repo before. The last block proves the absence of writes
 * rather than asserting it, by digesting `src/` before and after.
 *
 * The probes still run against REAL code, which is the point: a synthetic
 * fixture shares the critic's blind spots, and the classifier's whole job is to
 * tell apart three real states (`live`, `loaded-only`, `unreferenced`) that
 * only the real import graph produces.
 *
 * BOTH DIRECTIONS
 * ---------------
 * A fence probed only on "it refuses what it must" cannot see an
 * over-tightening. So each block below pairs a RED probe (remove a live
 * importer; the symbols must be reported) with a GREEN one (the legitimate
 * re-export shims, and the tree as it stands, must stay silent).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import {
  analyzeReachability,
  checkBuildEntriesInSync,
  NO_LIVE_CALLER_TAG,
  readSourceTree,
  runSelfProbe,
  TEST_ONLY_TAG,
  type AnalysisInput,
  type Finding,
  type ReachabilityReport,
} from '../../../scripts/check-local-reachability.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-local-reachability.ts');
const SRC_ROOT = join(REPO_ROOT, 'src');
const LOCAL_ROOT = join(SRC_ROOT, 'local');
const ENTRIES = [join(SRC_ROOT, 'index.ts'), join(SRC_ROOT, 'cli', 'index.ts')];
const SPAWN_TIMEOUT_MS = 120_000;
/** The per-file annotation sweep re-analyzes the whole tree once per file. */
const SWEEP_TIMEOUT_MS = 120_000;

const REAL_SOURCES = readSourceTree(SRC_ROOT);

function analyze(sources: ReadonlyMap<string, string> = REAL_SOURCES): ReachabilityReport {
  const input: AnalysisInput = {
    sources,
    entries: ENTRIES,
    scopeRoot: LOCAL_ROOT,
    repoRoot: REPO_ROOT,
  };
  return analyzeReachability(input);
}

/**
 * A copy of the real tree with one file rewritten.
 *
 * The anchor's uniqueness is asserted rather than assumed: a probe anchored on
 * a string that occurs twice mutates something other than what it names, and a
 * probe whose replacement equals the original is a NO-OP that reads as "the
 * fence did not fire".
 */
function withMutation(relFile: string, from: string, to: string): Map<string, string> {
  const path = join(REPO_ROOT, relFile);
  const text = REAL_SOURCES.get(path);
  expect(text, `${relFile} must be part of the scanned tree`).toBeDefined();
  expect(text!.split(from).length - 1, `probe anchor must be unique in ${relFile}`).toBe(1);
  expect(from, 'probe must actually change something').not.toBe(to);
  const copy = new Map(REAL_SOURCES);
  copy.set(path, text!.replace(from, to));
  return copy;
}

const symbolsReported = (report: ReachabilityReport, kind?: Finding['kind']): Set<string> =>
  new Set(report.findings.filter((f) => !kind || f.kind === kind).map((f) => f.symbol));

describe('local reachability critic — the real tree', () => {
  it('reports nothing: every orphan is annotated and no annotation is stale', () => {
    expect(analyze().findings).toEqual([]);
  });

  it('sees the whole of src/, not a fragment', () => {
    const report = analyze();
    expect(report.parseErrors).toEqual([]);
    expect(report.filesScanned).toBeGreaterThanOrEqual(300);
    expect(report.loadedModules).toBeGreaterThanOrEqual(280);
    expect(report.reachableSymbols).toBeGreaterThanOrEqual(2000);
    expect(report.scopeFiles).toBeGreaterThanOrEqual(50);
  });

  it('classifies the three states a module-level rule collapses together', () => {
    const byFile = new Map(analyze().modules.map((m) => [m.file, m]));
    // LIVE: `cdkd local run-task` imports it directly.
    expect(byFile.get('src/local/ecs-task-runner.ts')?.moduleClass).toBe('live');
    // LOADED-ONLY: `rest-v1-integrations.ts` imports `evaluateVtl`, so ESM
    // evaluates the module, yet no exported symbol is ever reached. A rule
    // asking "does this file have a live importer" answers YES here and misses
    // the whole defect (issue #2203).
    expect(byFile.get('src/local/vtl-engine.ts')?.moduleClass).toBe('loaded-only');
    expect(byFile.get('src/local/vtl-engine.ts')?.loaded).toBe(true);
    expect(byFile.get('src/local/vtl-engine.ts')?.liveSymbols).toBe(0);
    // UNREFERENCED: nothing in `src/` imports it at all.
    expect(byFile.get('src/local/httpv2-service-integration.ts')?.moduleClass).toBe('unreferenced');
    expect(byFile.get('src/local/httpv2-service-integration.ts')?.loaded).toBe(false);
  });

  it('splits a module whose live and dead halves sit in one file', () => {
    const rie = analyze().modules.find((m) => m.file === 'src/local/rie-client.ts');
    expect(rie?.moduleClass).toBe('live-partial');
    // The correction that cost a review round: this file is NOT wholly dead.
    expect(rie?.liveSymbols).toBeGreaterThan(0);
    expect(rie?.deadSymbols).toContain('invokeRieStreaming');
    expect(rie?.deadSymbols).not.toContain('invokeRie');
    expect(rie?.deadSymbols).not.toContain('waitForRieReady');
  });
});

describe('local reachability critic — must NOT fire on legitimate shims', () => {
  it('exempts a consumed re-export shim, and there are many of them', () => {
    const report = analyze();
    const shims = report.modules.filter((m) => m.moduleClass === 'shim-consumed');
    expect(shims.length).toBeGreaterThanOrEqual(25);
    expect(shims.map((m) => m.file)).toContain('src/local/http-server.ts');
    // `startApiServer` is the live server; the shim is right, not an orphan.
    expect(symbolsReported(report)).not.toContain('startApiServer');
  });

  it('exempts a shim by CONSTRUCTION, so an unconsumed one is exempt too', () => {
    // A shim declares no value symbol of its own, so there is no cdkd-authored
    // body in it for a fix to land in. That is why the exemption needs no
    // allowlist — and why it cannot be quietly widened to cover a fork.
    const report = analyze();
    const orphanShims = report.modules.filter((m) => m.moduleClass === 'shim-unreferenced');
    expect(orphanShims.length).toBeGreaterThan(0);
    for (const shim of orphanShims) expect(shim.exportedSymbols).toBe(0);
  });

  it('does not resurrect a symbol through a TYPE-only import binding', () => {
    // The `refs` set holds NAMES, not resolved bindings, so a value-position
    // occurrence of a name that is imported type-only would otherwise create a
    // runtime edge and mark the target live. Here that would silently un-orphan
    // `createReloadOrchestrator` and turn its annotation into a false "stale".
    const mutated = withMutation(
      'src/cli/commands/local-start-api.ts',
      "import { type NextStateMaterial } from '../../local/reload-orchestrator.js';",
      "import {\n  type createReloadOrchestrator,\n  type NextStateMaterial,\n} from '../../local/reload-orchestrator.js';\nvoid createReloadOrchestrator;"
    );
    expect(analyze(mutated).findings).toEqual([]);
  });

  it('...but a VALUE import of the same name DOES resurrect it', () => {
    // The twin of the probe above: without it, a green there could mean the
    // fixture cannot discriminate rather than that the type-only rule works.
    const mutated = withMutation(
      'src/cli/commands/local-start-api.ts',
      "import { type NextStateMaterial } from '../../local/reload-orchestrator.js';",
      "import {\n  createReloadOrchestrator,\n  type NextStateMaterial,\n} from '../../local/reload-orchestrator.js';\nvoid createReloadOrchestrator;"
    );
    const stale = analyze(mutated).findings.filter((f) => f.kind === 'stale-annotation');
    expect(stale.map((f) => f.symbol)).toEqual(['createReloadOrchestrator']);
  });

  it('does not treat a file that only declares types as a fork', () => {
    const typesOnly = analyze().modules.filter((m) => m.moduleClass === 'types-only');
    for (const mod of typesOnly) expect(mod.deadSymbols).toEqual([]);
  });
});

describe('local reachability critic — RED probes against real code', () => {
  it('fires when a live module loses its last src/ importer', () => {
    // `local-run-task.ts` is the only `src/` consumer of the ECS task runner.
    const mutated = withMutation(
      'src/cli/commands/local-run-task.ts',
      '\n  cleanupEcsRun,\n  createEcsRunState,\n  runEcsTask,\n  type EcsRunState,',
      '\n  type EcsRunState,'
    );
    const before = analyze();
    const after = analyze(mutated);
    expect(before.findings).toEqual([]);
    expect(symbolsReported(after, 'unannotated')).toContain('runEcsTask');
    const runner = after.modules.find((m) => m.file === 'src/local/ecs-task-runner.ts');
    expect(runner?.moduleClass).toBe('loaded-only');
  });

  it('fires transitively, not just on the module that lost its importer', () => {
    // The point of a SYMBOL-level walk: dropping the top of a chain must take
    // everything below it with it, including files the mutation never named.
    const mutated = withMutation(
      'src/cli/commands/local-run-task.ts',
      '\n  cleanupEcsRun,\n  createEcsRunState,\n  runEcsTask,\n  type EcsRunState,',
      '\n  type EcsRunState,'
    );
    const reported = symbolsReported(analyze(mutated), 'unannotated');
    // `resolveEcsSecrets` lives in a DIFFERENT file, reached only through the
    // runner. It is live today (issue #2189's fix does reach users).
    expect(symbolsReported(analyze(), 'unannotated')).not.toContain('resolveEcsSecrets');
    expect(reported).toContain('resolveEcsSecrets');
  });

  it('fires when a live importer degrades to a TYPE-only import', () => {
    // The quietest way to orphan a module: the file still imports it, the
    // import still resolves, and nothing at runtime calls it any more.
    const mutated = withMutation(
      'src/cli/commands/local-start-api.ts',
      'import { warnSsrfRiskyUri }',
      'import { type warnSsrfRiskyUri as _WarnSsrfRiskyUri }'
    );
    const reported = symbolsReported(analyze(mutated), 'unannotated');
    expect(symbolsReported(analyze(), 'unannotated')).not.toContain('warnSsrfRiskyUri');
    expect(reported).toContain('warnSsrfRiskyUri');
    // ...and the helper only it reached goes with it.
    expect(reported).toContain('classifyInternalHost');
  });

  it('fires on a NEW unannotated export in a live file', () => {
    // Deliberately NOT `websocket-body.ts`: `websocket-server.ts` imports that
    // one as a NAMESPACE, and a namespace import marks every export of its
    // target reachable. That is the documented over-approximation, and picking
    // a file subject to it would make this probe pass for the wrong reason.
    const mutated = withMutation(
      'src/local/ecs-secrets-resolver.ts',
      'export function classifySecretArn',
      'export function neverCalledByAnything(): number {\n  return 1;\n}\n\nexport function classifySecretArn'
    );
    expect(symbolsReported(analyze(mutated), 'unannotated')).toContain('neverCalledByAnything');
  });

  it('fires when an annotation goes STALE because the symbol became live', () => {
    // The direction that stops the annotations rotting into decoration — and,
    // while orphans exist, the free defence against the reachability walk
    // degrading to "everything is reachable".
    // `rest-v1-integrations.ts` already imports `evaluateVtl`; the only thing
    // missing is a reference to it from a function that IS live.
    const mutated = withMutation(
      'src/local/rest-v1-integrations.ts',
      '  const classification = classifyInternalHost(host);',
      '  void evaluateVtl;\n  const classification = classifyInternalHost(host);'
    );
    const stale = analyze(mutated).findings.filter((f) => f.kind === 'stale-annotation');
    expect(stale.map((f) => f.symbol)).toContain('evaluateVtl');
    expect(stale[0]?.tag).toBe(NO_LIVE_CALLER_TAG);
  });

  it('fires when an annotation is a bare token with no reason', () => {
    // `reload-orchestrator.ts` carries exactly one annotation, so the anchor is
    // unique without having to pick an occurrence out of a repeated block.
    const mutated = withMutation(
      'src/local/reload-orchestrator.ts',
      ' * @no-live-caller superseded by `reloadAllServers` in `local-start-api.ts`, which drives the\n' +
        ' * `--watch` reload across the N-server topology. The only thing still imported from this\n' +
        ' * module is the `NextStateMaterial` type (issue #2228).',
      ' * @no-live-caller dead'
    );
    const bare = analyze(mutated).findings.filter((f) => f.kind === 'bare-annotation');
    expect(bare.map((f) => f.symbol)).toContain('createReloadOrchestrator');
  });

  it('reports a symbol whose annotation is DELETED, one file at a time', () => {
    // A per-file sweep, because a single probe proves only that ONE annotation
    // is load-bearing. Each is removed on its own and must be reported.
    const annotated = analyze().modules.filter((m) => m.deadSymbols.length > 0);
    expect(annotated.length).toBeGreaterThanOrEqual(8);
    for (const mod of annotated) {
      const path = join(REPO_ROOT, mod.file);
      const copy = new Map(REAL_SOURCES);
      copy.set(
        path,
        REAL_SOURCES.get(path)!
          .split(NO_LIVE_CALLER_TAG)
          .join('@was-no-live-caller')
          .split(TEST_ONLY_TAG)
          .join('@was-test-only-export')
      );
      const reported = symbolsReported(analyze(copy), 'unannotated');
      for (const symbol of mod.deadSymbols) {
        expect(reported, `${mod.file}: ${symbol} must be reported once unannotated`).toContain(
          symbol
        );
      }
    }
  }, SWEEP_TIMEOUT_MS);
});

describe('local reachability critic — defences against itself', () => {
  it('self-probes its own classifier and passes', () => {
    expect(runSelfProbe(analyzeReachability)).toEqual([]);
  });

  it('self-probe REJECTS a classifier that says everything is reachable', () => {
    const failures = runSelfProbe((input) => {
      const real = analyzeReachability(input);
      return { ...real, findings: real.findings.filter((f) => f.kind === 'stale-annotation') };
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toContain('orphan');
  });

  it('self-probe REJECTS a classifier that says everything is dead', () => {
    const failures = runSelfProbe((input) => {
      const real = analyzeReachability(input);
      const extra: Finding = {
        file: 'scope/live.ts',
        line: 1,
        symbol: 'entryUsed',
        kind: 'unannotated',
      };
      return { ...real, findings: [...real.findings, extra] };
    });
    expect(failures.join('\n')).toContain('entryUsed');
  });

  it('self-probe REJECTS a classifier that stops recognising shims', () => {
    const failures = runSelfProbe((input) => {
      const real = analyzeReachability(input);
      return { ...real, shimFiles: 0 };
    });
    expect(failures.join('\n')).toContain('expected 2 shims');
  });

  it('notices when the build entry points move out from under it', () => {
    expect(checkBuildEntriesInSync(readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8'))).toEqual(
      []
    );
    const failures = checkBuildEntriesInSync("pack: { entry: { cli: 'src/cli/main.ts' } }");
    expect(failures.length).toBe(2);
    expect(failures.join('\n')).toContain('ENTRY_RELATIVE');
  });

  it('fails loudly rather than silently when the tree stops parsing', () => {
    const path = join(LOCAL_ROOT, 'websocket-body.ts');
    const copy = new Map(REAL_SOURCES);
    copy.set(path, 'export function broken( {');
    expect(analyze(copy).parseErrors.length).toBeGreaterThan(0);
  });
});

describe('local reachability critic — the probes wrote nothing to src/', () => {
  it('leaves the real tree byte-identical', () => {
    // A probe harness that mutates on disk and dies mid-loop leaves the tree
    // broken and the next run's failures read as real bugs. This one cannot,
    // and that is worth proving rather than asserting: the digest is taken
    // from a FRESH read, not from the map the probes copied.
    const digest = (sources: ReadonlyMap<string, string>): string => {
      const hash = createHash('sha256');
      for (const path of [...sources.keys()].sort()) hash.update(path).update(sources.get(path)!);
      return hash.digest('hex');
    };
    expect(digest(readSourceTree(SRC_ROOT))).toBe(digest(REAL_SOURCES));
  });
});

describe('local reachability critic — CLI and wiring', () => {
  const run = (args: readonly string[] = []) =>
    spawnSync('node', ['--experimental-strip-types', SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });

  it('exits 0 on the current tree and says what it looked at', () => {
    const proc = run();
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('local reachability check OK');
    expect(proc.stdout).toContain('re-export shims');
  }, SPAWN_TIMEOUT_MS);

  it('emits COMPLETE json on a pipe', () => {
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    const parsed = JSON.parse(proc.stdout.slice(0, proc.stdout.lastIndexOf('}') + 1));
    expect(parsed.findings).toEqual([]);
    expect(parsed.modules.length).toBe(parsed.scopeFiles);
  }, SPAWN_TIMEOUT_MS);

  it('exits 1 when the self-probe fails, proving main consults it', () => {
    // The self-probe is the defence against the reachability walk degrading to
    // "everything is reachable". A unit test calling `runSelfProbe` directly
    // cannot tell whether the BINARY still consults it, so this forces a probe
    // failure through the real entry point.
    const proc = spawnSync('node', ['--experimental-strip-types', SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, CDKD_SELF_PROBE_FORCE_FAIL: '1' },
    });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain('forced failure');
  }, SPAWN_TIMEOUT_MS);

  it('rejects an unrecognized argument instead of silently doing nothing', () => {
    // A mistyped `--scope=` would otherwise report a green for the DEFAULT
    // scope, i.e. for a directory the caller never asked about.
    const proc = run(['--scoped=src']);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('Unrecognized argument');
  }, SPAWN_TIMEOUT_MS);

  it('still runs when invoked through a SYMLINK', () => {
    // Node resolves the main module to its realpath while `argv[1]` keeps the
    // link, so an `import.meta.url === \`file://${argv[1]}\`` guard would exit 0
    // having done nothing -- the vacuous green the floors exist to forbid.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-reach-link-'));
    try {
      const link = join(dir, 'link.ts');
      symlinkSync(SCRIPT, link);
      const proc = spawnSync('node', ['--experimental-strip-types', link], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain('local reachability check OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT_MS);

  it('is registered as a Vite+ task with the cache disabled', () => {
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const entry = config.slice(config.indexOf("'audit:local-reachability:check'"));
    expect(entry).toContain('scripts/check-local-reachability.ts');
    // A cached replay would report a stale green without having looked.
    expect(entry.slice(0, entry.indexOf('},'))).toContain('cache: false');
  });

  it('is invoked by CI, not merely registered', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('vp run audit:local-reachability:check');
  });
});
