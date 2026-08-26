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
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import {
  analyzeReachability,
  checkBuildEntriesInSync,
  checkScopeIsNotVacuous,
  FLOORS,
  readPackEntries,
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
/**
 * Every real-tree probe analyzes ~330 files, and the ones that analyze TWICE
 * (baseline plus mutation) crossed vitest's default 5 s in 1 run of 14. A
 * CI-blocking critic that flakes teaches people to re-run rather than read.
 */
const ANALYZE_TIMEOUT_MS = 60_000;

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
  }, ANALYZE_TIMEOUT_MS);

  it('sees the whole of src/, not a fragment', () => {
    const report = analyze();
    expect(report.parseErrors).toEqual([]);
    expect(report.filesScanned).toBeGreaterThanOrEqual(300);
    expect(report.loadedModules).toBeGreaterThanOrEqual(280);
    expect(report.reachableSymbols).toBeGreaterThanOrEqual(2000);
    expect(report.scopeFiles).toBeGreaterThanOrEqual(50);
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

  it('splits a module whose live and dead halves sit in one file', () => {
    const rie = analyze().modules.find((m) => m.file === 'src/local/rie-client.ts');
    expect(rie?.moduleClass).toBe('live-partial');
    // The correction that cost a review round: this file is NOT wholly dead.
    expect(rie?.liveSymbols).toBeGreaterThan(0);
    expect(rie?.deadSymbols).toContain('invokeRieStreaming');
    expect(rie?.deadSymbols).not.toContain('invokeRie');
    expect(rie?.deadSymbols).not.toContain('waitForRieReady');
  }, ANALYZE_TIMEOUT_MS);
});

describe('local reachability critic — must NOT fire on legitimate shims', () => {
  it('exempts a consumed re-export shim, and there are many of them', () => {
    const report = analyze();
    const shims = report.modules.filter((m) => m.moduleClass === 'shim-consumed');
    expect(shims.length).toBeGreaterThanOrEqual(25);
    expect(shims.map((m) => m.file)).toContain('src/local/http-server.ts');
    // `startApiServer` is the live server; the shim is right, not an orphan.
    expect(symbolsReported(report)).not.toContain('startApiServer');
  }, ANALYZE_TIMEOUT_MS);

  it('exempts a shim by CONSTRUCTION, so an unconsumed one is exempt too', () => {
    // A shim declares no value symbol of its own, so there is no cdkd-authored
    // body in it for a fix to land in. That is why the exemption needs no
    // allowlist — and why it cannot be quietly widened to cover a fork.
    const report = analyze();
    const orphanShims = report.modules.filter((m) => m.moduleClass === 'shim-unreferenced');
    // `exportedSymbols === 0` is IMPLIED by the class (a file with exports can
    // never be classified a shim), so asserting it proves nothing and passes on
    // an empty list. Name the files instead: those are facts about the tree the
    // classification does not supply.
    expect(orphanShims.length).toBeGreaterThanOrEqual(5);
    expect(orphanShims.map((m) => m.file)).toEqual(
      expect.arrayContaining([
        'src/local/route-matcher.ts',
        'src/local/parameter-mapping.ts',
        'src/local/api-gateway-event.ts',
      ])
    );
    // ...and that none of them is a fork wearing a shim's classification.
    for (const shim of orphanShims) {
      const source = REAL_SOURCES.get(join(REPO_ROOT, shim.file));
      expect(source, `${shim.file} must be in the scanned tree`).toBeDefined();
      expect(source, `${shim.file} must re-export from cdk-local, not declare a body`).toContain(
        "from 'cdk-local"
      );
      expect(source).not.toMatch(/^export (async )?function /m);
    }
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
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

  it('does not treat a file that only declares types as a fork', () => {
    // `deadSymbols` is a subset of `exportedSymbols`, which `types-only` forces
    // to zero, so `toEqual([])` cannot fail and also passes over an empty list.
    // Assert the module that must be there and a property the class does NOT
    // imply: it is loaded at runtime, i.e. it is reached, just not for a value.
    const typesOnly = analyze().modules.filter((m) => m.moduleClass === 'types-only');
    expect(typesOnly.map((m) => m.file)).toContain('src/local/local-state-provider.ts');
    const mod = typesOnly.find((m) => m.file === 'src/local/local-state-provider.ts');
    // Not loaded at runtime either: every importer reaches it through a whole
    // `import type` declaration, which is erased. That is a fact about the tree,
    // not something `types-only` implies -- the class only says "zero value
    // exports", and a types-only module CAN be loaded (by a value import of a
    // sibling, or an inline `{ type X }` under verbatimModuleSyntax).
    expect(mod?.loaded).toBe(false);
    const source = REAL_SOURCES.get(join(REPO_ROOT, 'src/local/local-state-provider.ts'));
    expect(source).toMatch(/^export (interface|type) /m);
    expect(source).not.toMatch(/^export (async )?(function|class|const) /m);
  }, ANALYZE_TIMEOUT_MS);

  it('measures the ONE namespace edge, which clears every export of its target', () => {
    // A namespace / default import marks EVERY export of its target reachable,
    // because the binding's property accesses are not tracked. The single such
    // edge into this scope is `websocket-server.ts:28`'s `import * as
    // websocketBody`, and it is inert only while `websocket-body.ts` exports
    // exactly one value -- a second one would be live forever with no caller.
    // The measurement is asserted rather than written down, so it expires
    // loudly.
    const importer = REAL_SOURCES.get(join(REPO_ROOT, 'src/local/websocket-server.ts'));
    expect(importer).toContain("import * as websocketBody from './websocket-body.js';");
    const target = analyze().modules.find((m) => m.file === 'src/local/websocket-body.ts');
    expect(
      target?.exportedSymbols,
      'websocket-body.ts gained an export: it is now auto-live via the namespace ' +
        'import regardless of whether anything calls it. Either give the new symbol a ' +
        'real caller, or narrow the namespace edge in check-local-reachability.ts.'
    ).toBe(1);
    // No OTHER scope module may be pulled in by a namespace or default import.
    // The specifier is RESOLVED rather than pattern-matched: the one real edge
    // is a SIBLING import (`./websocket-body.js`), so a regex looking for
    // `/local/` in the path finds nothing and the sweep reads as clean.
    const edges: string[] = [];
    for (const [file, text] of REAL_SOURCES) {
      for (const m of text.matchAll(/^import (?:\* as \w+|\w+) from '([^']+)';$/gm)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) continue;
        const target = resolve(join(file, '..'), spec.replace(/\.js$/, '.ts'));
        if (target.startsWith(join(SRC_ROOT, 'local') + '/')) {
          edges.push(`${relative(REPO_ROOT, file)} -> ${relative(REPO_ROOT, target)}`);
        }
      }
    }
    expect(edges).toEqual(['src/local/websocket-server.ts -> src/local/websocket-body.ts']);
  }, ANALYZE_TIMEOUT_MS);
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
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

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
  }, ANALYZE_TIMEOUT_MS);

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

  it('refuses a vacuous scope WITHOUT consulting the floors', () => {
    // Both branches directly, because the second cannot be produced by any
    // directory in this repo -- and a clause no input exercises is one a later
    // refactor deletes with every test still green.
    expect(checkScopeIsNotVacuous({ scopeFiles: 0, scopeExportedSymbols: 0 }, 'src/nope')).toEqual([
      expect.stringContaining('matched NO files'),
    ]);
    expect(
      checkScopeIsNotVacuous({ scopeFiles: 12, scopeExportedSymbols: 0 }, 'src/nope')
    ).toEqual([expect.stringContaining('NOT ONE exported symbol')]);
    // ...and the healthy case stays silent.
    expect(checkScopeIsNotVacuous({ scopeFiles: 57, scopeExportedSymbols: 84 }, 'src/local')).toEqual(
      []
    );
  });

  it('reads pack.entry by PARSING it, not by matching the file text', () => {
    const config = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(readPackEntries(config)).toEqual({
      entries: ['src/index.ts', 'src/cli/index.ts'],
      unreadable: 0,
    });
    // A whole-file substring match is satisfied by a COMMENT naming the path,
    // so it survives the very rename it exists to catch.
    const commentOnly =
      "export default { pack: { entry: { cli: 'src/cli/main.ts' } } };\n// was 'src/index.ts'";
    expect(checkBuildEntriesInSync(commentOnly).length).toBeGreaterThan(0);
    // ...and refuses outright when the map cannot be read at all.
    expect(checkBuildEntriesInSync('export default {}').length).toBe(1);
    expect(checkBuildEntriesInSync('export default {}')[0]).toContain('pack.entry');
  });

  it('refuses a pack.entry MEMBER it cannot resolve, instead of skipping it', () => {
    // The silent half of the same hole. Skipping an unresolvable member leaves
    // the entry set short and the ADDED-entry list EMPTY, so a real new binary
    // passes at exit 0 -- measured across all four shapes below before the
    // member counter existed.
    const wrap = (members: string): string =>
      `export default { pack: { entry: { index: 'src/index.ts', cli: 'src/cli/index.ts', ${members} } } };`;
    const shapes: Record<string, string> = {
      spread: '...extraEntries',
      identifier: 'daemon: DAEMON_ENTRY',
      conditional: "daemon: isProd ? 'src/daemon/index.ts' : 'src/dev.ts'",
      template: 'daemon: `src/${name}/index.ts`',
      shorthand: 'daemon',
      call: 'daemon: resolveEntry()',
    };
    for (const [name, member] of Object.entries(shapes)) {
      const source = wrap(member);
      expect(readPackEntries(source)?.unreadable, `${name} must count as unreadable`).toBe(1);
      const failures = checkBuildEntriesInSync(source);
      expect(failures.length, `${name} must be refused`).toBe(1);
      expect(failures[0]).toContain('cannot resolve statically');
    }
    // ...and a readable member alongside them is still counted, so the refusal
    // is about the unreadable one rather than about the map being odd.
    expect(readPackEntries(wrap('...extra'))?.entries).toEqual([
      'src/index.ts',
      'src/cli/index.ts',
    ]);
  });

  it('notices when a build entry point is REMOVED', () => {
    expect(checkBuildEntriesInSync(readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf8'))).toEqual(
      []
    );
    const failures = checkBuildEntriesInSync(
      "export default { pack: { entry: { cli: 'src/cli/main.ts' } } };"
    );
    expect(failures.length).toBe(3);
    expect(failures.join('\n')).toContain('ENTRY_RELATIVE');
  });

  it('notices when a build entry point is ADDED, which is the SILENT direction', () => {
    // A missing entry is loud: the critic reports the whole tree dead. An ADDED
    // one is quiet -- symbols reachable only from the new binary read as
    // unreachable, and this critic's own message then tells the author to
    // ANNOTATE them, converting a wrong verdict into a self-certifying one.
    const failures = checkBuildEntriesInSync(
      "export default { pack: { entry: { index: 'src/index.ts', cli: 'src/cli/index.ts', " +
        "daemon: 'src/daemon/index.ts' } } };"
    );
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('src/daemon/index.ts');
    expect(failures[0]).toContain('Add it to ENTRY_RELATIVE');
  });

  it('fails loudly rather than silently when the tree stops parsing', () => {
    const path = join(LOCAL_ROOT, 'websocket-body.ts');
    const copy = new Map(REAL_SOURCES);
    copy.set(path, 'export function broken( {');
    expect(analyze(copy).parseErrors.length).toBeGreaterThan(0);
  }, ANALYZE_TIMEOUT_MS);
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
  }, ANALYZE_TIMEOUT_MS);
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
    // The assertion above matches an UNCONDITIONAL literal, so it holds for a
    // critic that examined nothing. Read the magnitudes back out of the summary
    // instead -- as a BAND, not an equality: a dark run reports 0, so a floor
    // catches it identically, while an exact pin would red on any correct
    // `src/local/**` addition and teach the next author to bump the number.
    const summary = /OK — (\d+) files in (\S+) \((\d+) re-export shims\)/.exec(proc.stdout);
    expect(summary, `summary line did not match: ${proc.stdout}`).not.toBeNull();
    expect(Number(summary![1])).toBeGreaterThanOrEqual(45);
    expect(summary![2]).toBe('src/local');
    expect(Number(summary![3])).toBeGreaterThanOrEqual(32);
  }, SPAWN_TIMEOUT_MS);

  it('emits json and NOTHING else on stdout, so it survives a pipe', () => {
    const proc = run(['--json']);
    expect(proc.status).toBe(0);
    // No `lastIndexOf('}')` slice: a test that trims trailing text to make the
    // parse succeed PINS the unpipeable output rather than catching it.
    const parsed = JSON.parse(proc.stdout);
    expect(parsed.findings).toEqual([]);
    // The human summary still has to go somewhere.
    expect(proc.stderr).toContain('local reachability check OK');
  }, SPAWN_TIMEOUT_MS);

  it('reports the REAL magnitudes, so a critic that examined nothing fails', () => {
    // Measured 2026-08-26. `modules.length === scopeFiles` is `0 === 0` for a
    // dark run, and `liveScopeSymbols` was asserted NOWHERE: zeroing all six
    // FLOORS and pointing the scope at a nonexistent directory produced
    // `check OK -- 0 files ... 0 exported symbols` at exit 0 with 30/30 green.
    //
    // Magnitudes are BANDS, invariants are EXACT, and the split is deliberate.
    // A dark run yields 0 for every one of these, so a floor discriminates just
    // as well as an equality -- while an equality also reds on any correct
    // addition under `src/local/**`, whose only remedy is to bump the number,
    // which is the reflex that makes an assertion worthless. go-to-k/cdkd#2277
    // (deleting the orphans) will move four of these BY DESIGN: it takes
    // scopeFiles 57 -> ~53 and scopeExportedSymbols 84 -> 55, so each band sits
    // BELOW that state as well as ABOVE the checker's own FLOORS -- above the
    // floors because a band equal to one adds nothing the floor does not
    // already catch, below the post-2277 state because a band that reds on a
    // planned, correct change is the same ratchet in the other direction.
    const proc = run(['--json']);
    const parsed = JSON.parse(proc.stdout);
    expect(parsed.scopeFiles).toBeGreaterThanOrEqual(45);
    expect(parsed.shimFiles).toBeGreaterThanOrEqual(32);
    expect(parsed.liveScopeSymbols).toBeGreaterThanOrEqual(45);
    expect(parsed.scopeExportedSymbols).toBeGreaterThanOrEqual(45);
    expect(parsed.filesScanned).toBeGreaterThanOrEqual(320);
    expect(parsed.loadedModules).toBeGreaterThanOrEqual(300);
    expect(parsed.reachableSymbols).toBeGreaterThanOrEqual(2300);
    // Invariants: these are relations the report must satisfy at ANY size, so
    // they neither ratchet nor weaken when the tree changes.
    expect(parsed.modules.length).toBe(parsed.scopeFiles);
    expect(parsed.deadScopeSymbols).toBe(
      parsed.annotatedNoLiveCaller + parsed.annotatedTestOnly
    );
    expect(parsed.liveScopeSymbols + parsed.deadScopeSymbols).toBe(parsed.scopeExportedSymbols);
  }, SPAWN_TIMEOUT_MS);

  it('pins the FLOOR constants, which can be neutralised with no verdict change', () => {
    // Literals, deliberately NOT derived from the exported record: a table
    // driven off the thing it validates cannot see a value being lowered.
    expect(FLOORS.srcFiles).toBe(250);
    expect(FLOORS.loadedModules).toBe(240);
    expect(FLOORS.reachableSymbols).toBe(900);
    expect(FLOORS.scopeFiles).toBe(40);
    expect(FLOORS.liveScopeSymbols).toBe(40);
    expect(FLOORS.shimFiles).toBe(30);
    expect(Object.keys(FLOORS).length).toBe(6);
  });

  it('refuses a scope that matched nothing, WITHOUT relying on a floor', () => {
    // Every FLOORS value can be zeroed in a one-line diff. "the scope matched no
    // files" is not a magnitude, so this refusal survives that diff and is what
    // makes the dark run fail at the script rather than only in this suite.
    const proc = run(['--scope=src/locale']);
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain('matched NO files');
    expect(proc.stderr).toContain('cannot report success');
  }, SPAWN_TIMEOUT_MS);

  it('refuses --scope= with an empty value instead of checking the default', () => {
    // `--scope=$DIR` with DIR unset. Falling back would report a green for a
    // directory the caller never named.
    const proc = run(['--scope=']);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('empty value');
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
