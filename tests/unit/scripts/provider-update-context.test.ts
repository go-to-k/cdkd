/**
 * Issue #2613 remedy 1 — the SDK-provider `UpdateContext` declaration fence.
 *
 * `ResourceProvider.update`'s `context` parameter is optional, so a provider
 * that omits it compiles, the deploy engine keeps passing `expectedRegion`, and
 * `assertRegionMatch` simply never runs for that provider. Nothing reds. This
 * suite is what stops the omitting set widening while remedies 2 (backfill the
 * parameter plus the guard call) and 3 (drop the `?`) stay open.
 *
 * TWO INDEPENDENT INSTRUMENTS, which must agree
 * ---------------------------------------------
 *  1. STATIC — `scripts/check-provider-update-context.ts` parses every class
 *     under `src/provisioning/providers/` with the TypeScript compiler and
 *     classifies its `update()` signature. Its own doc comment carries the
 *     population rule, the refusal rule and the measured limits.
 *  2. RUNTIME — `registerAllProviders` is run against a recording stand-in and
 *     every provider OBJECT it builds is asked for `update.length`. That is a
 *     property of the constructed function; no formatting, comment, line break
 *     or `async` keyword can fake it, and it covers a provider whose `update`
 *     arrives from somewhere the source scan does not model.
 *
 * A disagreement between the two FAILS. That is the guard-the-guard: instrument
 * 1 collapsing toward "everything declares" leaves its own counts and floors
 * untouched, and only instrument 2 (or the checker's self-probes) sees it.
 *
 * NO probe writes to `src/`, and that is the safety claim — not the stronger
 * "every probe uses a scratch copy", which review measured as false: the ones
 * that MUTATE a provider run against a scratch COPY through the checker's
 * `--providers-dir=` seam, while three others read the real tree unmodified,
 * the default root, or an empty temp directory.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  FLOORS,
  OMITS_UPDATE_CONTEXT,
  SELF_PROBE_CASES,
  buildReport,
  findViolations,
  runSelfProbes,
} from '../../../scripts/check-provider-update-context.ts';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-provider-update-context.ts');
const PROVIDERS_DIR = join(REPO_ROOT, 'src/provisioning/providers');
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * Provider classes defined under `providers/` that `registerAllProviders` does
 * NOT register, pinned by name so a provider dropping out of registration is a
 * failure rather than a silent exemption. `CustomResourceProvider` is owned by
 * `ProviderRegistry` itself (`new CustomResourceProvider()` in its
 * constructor), which is why it is reachable without being registered.
 */
const UNREGISTERED_PROVIDER_CLASSES = ['CustomResourceProvider'];

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function copyProvidersTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-2613-probe-'));
  scratchDirs.push(dir);
  const dest = join(dir, 'providers');
  cpSync(PROVIDERS_DIR, dest, { recursive: true });
  return dest;
}

/** Replace a UNIQUE anchor in a copied provider file. Uniqueness is asserted. */
function mutate(dir: string, file: string, from: string, to: string): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  expect(text.split(from).length - 1, `probe anchor must be unique in ${file}`).toBe(1);
  writeFileSync(path, text.replace(from, to));
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The ONE place this file spawns the checker. Every caller goes through it so
 * the timeout and the `proc.error` assertion cannot be forgotten at one call
 * site — which is precisely what review found had happened.
 */
function runArgs(args: readonly string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    // `it`'s own bound cannot interrupt a SYNCHRONOUS spawn, so a hung checker
    // would hang the worker rather than fail the case (found in review).
    timeout: SPAWN_TIMEOUT_MS,
  });
  expect(proc.error, 'the checker must be spawnable').toBeUndefined();
  return proc;
}

function runCheck(providersDir: string, env: NodeJS.ProcessEnv = {}): RunResult {
  return runArgs([`--providers-dir=${providersDir}`], env);
}

/**
 * The five-parameter `update()` every omitting provider spells. The whole
 * method header is the anchor, not just its tail: the private `applyUpdate`
 * helpers end in the same two lines, and an anchor matching both would mutate
 * the wrong one (`mutate` asserts uniqueness, so this is enforced, not hoped).
 */
const FIVE_PARAM_UPDATE = `  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {`;

/** ...and the six-parameter form the declaring ones spell. */
const SIX_PARAM_UPDATE = `  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {`;

/** Parsed once — both describes below read the same report. */
const report = buildReport(PROVIDERS_DIR);

describe('provider UpdateContext fence — the real tree', () => {
  it('the checker classifies its input (coverage floors)', () => {
    // Measured 2026-09-06 on 6ba3cf16: 82 files, 85 provider classes, 18
    // declaring / 67 omitting. The floors are the collapse guard; the exact
    // split is pinned by the allow-list assertions below, not by these numbers.
    expect(report.files.length).toBeGreaterThanOrEqual(FLOORS.files);
    expect(report.classes.length).toBeGreaterThanOrEqual(FLOORS.providerClasses);
    expect(report.declaring.length).toBeGreaterThanOrEqual(FLOORS.declaring);
    expect(report.classes.length).toBe(report.declaring.length + report.omitting.length);
  });

  it('refuses nothing — every provider shape in the tree is modelled', () => {
    expect(report.refusals).toEqual([]);
  });

  it('the recorded omitting set is exactly what the tree holds', () => {
    // The single assertion this whole file exists for. It fails in all three
    // directions with its own message: a NEW provider without the parameter, a
    // provider that GAINED it (delete the entry), and an entry naming a
    // provider that no longer exists.
    expect(findViolations(report, OMITS_UPDATE_CONTEXT).map((f) => f.message)).toEqual([]);
    expect([...report.omitting].sort()).toEqual([...OMITS_UPDATE_CONTEXT].sort());
  });

  it('the allow-list is sorted and free of duplicates', () => {
    expect([...OMITS_UPDATE_CONTEXT]).toEqual([...OMITS_UPDATE_CONTEXT].sort());
    expect(new Set(OMITS_UPDATE_CONTEXT).size).toBe(OMITS_UPDATE_CONTEXT.length);
  });

  it('pins the providers that DECLARE the parameter, by name', () => {
    // The complement of the worklist, asserted by NAME rather than by count:
    // a provider silently losing the parameter has to be visible as a name
    // leaving this list, not as an integer moving.
    //
    // Read it as "the guard COULD run here", never as "the guard runs here":
    // `S3BucketProvider.update` is on this list and its region check compares
    // against the CLIENT's region rather than `context.expectedRegion` (its own
    // comment says consuming that field is the remaining half of issue #2245).
    // Calling the guard is remedy 2.
    expect([...report.declaring].sort()).toEqual([
      'ASGProvider',
      'ApiGatewayV2Provider',
      'AppSyncProvider',
      'BudgetsBudgetProvider',
      'CloudWatchAnomalyDetectorProvider',
      'CognitoUserPoolProvider',
      'CustomResourceProvider',
      'DynamoDBGlobalTableProvider',
      'DynamoDBTableProvider',
      'EC2Provider',
      'ELBv2Provider',
      'KinesisStreamProvider',
      'LambdaFunctionProvider',
      'Route53Provider',
      'S3BucketProvider',
      'SNSTopicProvider',
      'SSMParameterProvider',
      'ServiceDiscoveryProvider',
    ]);
  });

  it('the two non-async update() providers are classified, not skipped', () => {
    // Issue #2613's own measurement grepped `async update(` and so could see
    // NEITHER of these — they fell out of both of its buckets, which is part of
    // why its 17 / 60 over 77 files is 18 / 67 over 85 classes here.
    // ServiceDiscoveryProvider DECLARES the parameter; EFSProvider omits it.
    const byName = new Map(report.classes.map((c) => [c.name, c.verdict]));
    expect(byName.get('ServiceDiscoveryProvider')).toBe('declares');
    expect(byName.get('EFSProvider')).toBe('omits');
  });
});

describe('provider UpdateContext fence — the runtime witness', () => {
  /** Every provider object `registerAllProviders` builds, deduped by class. */
  const registered = new Map<string, ResourceProvider>();
  const recorder = {
    register(_type: string, provider: ResourceProvider): void {
      registered.set(provider.constructor.name, provider);
    },
  } as unknown as ProviderRegistry;
  registerAllProviders(recorder);

  const staticVerdicts = new Map(report.classes.map((c) => [c.name, c.verdict]));

  it('registers a plausible number of distinct provider classes', () => {
    // 84 at the time of writing (85 classes minus the registry-owned
    // CustomResourceProvider).
    expect(registered.size).toBeGreaterThanOrEqual(
      FLOORS.providerClasses - UNREGISTERED_PROVIDER_CLASSES.length
    );
  });

  it('every registered provider is one the source scan found', () => {
    const missing = [...registered.keys()].filter((name) => !staticVerdicts.has(name));
    expect(
      missing,
      'a provider the deploy engine can route update() to is invisible to the source scan — it is defined outside src/provisioning/providers/, or inherits update() from a base class'
    ).toEqual([]);
  });

  it('every provider class the scan found is registered, or pinned as unregistered', () => {
    const unregistered = report.classes
      .map((c) => c.name)
      .filter((name) => !registered.has(name))
      .sort();
    expect(unregistered).toEqual([...UNREGISTERED_PROVIDER_CLASSES].sort());
  });

  it('the runtime arity agrees with the source verdict for every provider', () => {
    // `Function.length` counts the parameters before the first DEFAULTED or
    // REST one, so the equivalence holds only while `update` has neither. That
    // is a precondition, not a law (review found this comment stating it
    // unconditionally): the checker now REFUSES a defaulted parameter
    // anywhere in `update`, and a rest element in the SIXTH position. A rest
    // element EARLIER (`update(a, b, c, d, ...rest)`) still classifies `omits`
    // with `update.length` of 4 — the VERDICTS agree, which is what this arm
    // compares, so the equivalence asserted here holds while the arities
    // themselves may not.
    // Under it, a 5-parameter update() reports 5 and a 6-parameter one 6 — an
    // optional TypeScript parameter is a plain parameter in the emitted
    // function. A disagreement means one of the two instruments is lying, and
    // the fence must not be read as green in that state.
    const disagreements: string[] = [];
    for (const [name, provider] of registered) {
      const runtime = provider.update.length >= 6 ? 'declares' : 'omits';
      // No `&&` guard on the lookup: an ABSENT static verdict is itself a
      // disagreement (a total source-scan collapse would otherwise make this
      // loop skip every provider and pass vacuously — found in review).
      const asStatic = staticVerdicts.get(name) ?? 'MISSING FROM THE SOURCE SCAN';
      if (runtime !== asStatic) {
        disagreements.push(
          `${name}: source says ${asStatic}, update.length is ${provider.update.length}`
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("every provider's declared parameter count matches its verdict", () => {
    // `updateParams` is DERIVED from the parsed parameter list rather than
    // written as a literal at each `classes.push` — review found the literal
    // form made this assertion unfailable. Deriving it was necessary and NOT
    // sufficient: measured, an arity-classifier mutation (`=== 6` widened to
    // `>= 6`) still leaves this arm green over the REAL tree, because no
    // provider there has an arity outside 5/6, so there is nothing for the bug
    // to mis-bucket. Over the real tree this therefore states a true property
    // and discriminates nothing; the arm below supplies the input that does.
    for (const cls of report.classes) {
      expect(cls.updateParams, `${cls.name} (${cls.file})`).toBe(
        cls.verdict === 'declares' ? 6 : 5
      );
    }
  });

  it('a 7-parameter update() is refused, never classified with arity 7', () => {
    // The discriminating input for the `updateParams` ASSERTION above — not
    // for the arity mutation as a whole, which the self-probe case
    // 'a 7th parameter is refused' already caught before this test existed
    // (review). A classifier that admitted any arity >= 6 as `declares` would
    // land this provider in `classes` with `updateParams: 7`; correct code
    // refuses it and `classes` stays clean.
    const dir = copyProvidersTree();
    writeFileSync(
      join(dir, 'zzz-seven-param.ts'),
      `import type { UpdateContext } from '../../types/resource.js';
export class SevenParamProvider {
  async create(a: string): Promise<void> {}
  async update(
    a: string, b: string, c: string, d: object, e: object,
    context: UpdateContext,
    extra: string
  ): Promise<void> {}
  async delete(a: string): Promise<void> {}
}
`
    );
    const scratch = buildReport(dir);
    expect(scratch.classes.map((c) => c.name)).not.toContain('SevenParamProvider');
    expect(scratch.refusals.map((r) => r.name)).toContain('SevenParamProvider');
    for (const cls of scratch.classes) {
      expect(cls.updateParams, `${cls.name} (${cls.file})`).toBe(
        cls.verdict === 'declares' ? 6 : 5
      );
    }
  });

  it('the runtime omitting set matches the recorded worklist', () => {
    // The allow-list assertion again, taken from the OTHER instrument — so the
    // list is pinned even if the source scan is what has broken.
    const omitting = [...registered.entries()]
      .filter(([, provider]) => provider.update.length < 6)
      .map(([name]) => name)
      .sort();
    expect(omitting).toEqual([...OMITS_UPDATE_CONTEXT].sort());
  });
});

describe('provider UpdateContext fence — the checker still discriminates', () => {
  it('every self-probe case reaches its expected verdict', () => {
    expect(runSelfProbes(PROVIDERS_DIR)).toEqual([]);
  });

  it('the self-probe corpus covers every verdict INCLUDING the failing ones', () => {
    const expectations = new Set(SELF_PROBE_CASES.map((c) => c.expect));
    expect([...expectations].sort()).toEqual(['declares', 'ignored', 'omits', 'refused']);
    // A LITERAL, not a slack floor: three cases could vanish under `>= 12` with
    // nothing noticing (found in review). Raise it when you add one.
    expect(SELF_PROBE_CASES.length).toBe(38);
    // Every REFUSAL case must name a substring of its own arm, or the corpus
    // cannot tell one refusal arm from another.
    const unreasoned = SELF_PROBE_CASES.filter(
      (c) => c.expect === 'refused' && (c.expectReason ?? '') === ''
    ).map((c) => c.label);
    expect(unreasoned).toEqual([]);
  });

  it('the corpus covers every hole review PROVED was fail-open', () => {
    // Pinned by NAME rather than by count: each of these was a silent pass
    // before — the class in neither `classes` nor `refusals`, rc=0 — so a case
    // quietly disappearing must fail here and not merely shrink a number.
    const labels = SELF_PROBE_CASES.map((c) => c.label);
    for (const needle of [
      // first review round
      'REST 6th parameter',
      'class EXPRESSION',
      'declaring ONLY update',
      'mytypes/resource.js',
      // second review round: shapes `memberSignature` used to drop
      'NON-function property',
      'STRING-LITERAL member names',
      'COMPUTED member name over a string literal',
      'unresolvable COMPUTED member name',
      'STATIC update is not credited',
      'SUBCLASS short of the triple',
      'DEFAULTED update parameter',
      // ...and the calibration controls that keep those from over-firing.
      // Every one of these was REFUSED by the previous split gate, and the
      // cache made the shipped binary exit 1 on a real provider tree.
      'STATIC helper beside a real instance update',
      'declaring NONE of the three is ignored',
      'CONTROL: a static factory',
      'CONTROL: a `get create()` accessor',
      'CONTROL: an options bag',
      'CONTROL: `class LruCache extends Map`',
      'CONTROL: a factory subclass declaring only `create`',
      'subclass naming `update` in an unreadable shape IS refused',
    ]) {
      expect(labels.filter((l) => l.includes(needle)).length, needle).toBe(1);
    }
  });

  it('the SPAWNED binary consults the self-probe before reading the tree', () => {
    const result = runCheck(PROVIDERS_DIR, { CDKD_SELF_PROBE_FORCE_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('self-probe FAILED');
    expect(result.stderr).toContain('the real-tree result below is meaningless');
  }, SPAWN_TIMEOUT_MS);

  it('refuses a mistyped flag rather than reading it as a pass', () => {
    // A `--porviders-dir=` typo that fell through to the default root would
    // report a green about a tree the caller never named.
    for (const arg of ['--porviders-dir=/tmp', '--providers-dir=']) {
      // Through the same helper as every other spawn, so it carries the
      // timeout and the `proc.error` assertion: review found this one call
      // re-introducing exactly the hang `runCheck` had just been fixed for.
      const proc = runArgs([arg]);
      expect(proc.status, `\`${arg}\` must be refused`).toBe(2);
      expect(proc.stdout).toBe('');
    }
  }, SPAWN_TIMEOUT_MS);

  it('the unmutated copy is green (the probes below start from a pass)', () => {
    const result = runCheck(copyProvidersTree());
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }, SPAWN_TIMEOUT_MS);

  it('a NEW provider written without the parameter fails, naming it', () => {
    const dir = copyProvidersTree();
    writeFileSync(
      join(dir, 'zzz-new-provider.ts'),
      `export class BrandNewProvider {
  async create(a: string): Promise<void> {}
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<void> {}
  async delete(a: string): Promise<void> {}
}
`
    );
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[new-omitting]');
    expect(result.stderr).toContain('BrandNewProvider');
    // The message must lead with the remedy, not with "add it to the list".
    expect(result.stderr).toContain('Declare the parameter');
  }, SPAWN_TIMEOUT_MS);

  it('a DECLARING provider that loses the parameter fails, naming it', () => {
    const dir = copyProvidersTree();
    mutate(dir, 's3-bucket-provider.ts', SIX_PARAM_UPDATE, FIVE_PARAM_UPDATE);
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[new-omitting]');
    expect(result.stderr).toContain('S3BucketProvider');
  }, SPAWN_TIMEOUT_MS);

  it('an OMITTING provider that gains the parameter fails with the good news', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'logs-loggroup-provider.ts',
      `  ResourceImportResult,
} from '../../types/resource.js';`,
      `  ResourceImportResult,
  UpdateContext,
} from '../../types/resource.js';`
    );
    mutate(dir, 'logs-loggroup-provider.ts', FIVE_PARAM_UPDATE, SIX_PARAM_UPDATE);
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[newly-declaring]');
    expect(result.stderr).toContain('good news');
    expect(result.stderr).toContain('LogsLogGroupProvider');
  }, SPAWN_TIMEOUT_MS);

  it('a RENAMED provider leaves a stale allow-list entry and fails', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'kms-provider.ts',
      'export class KMSProvider implements ResourceProvider {',
      'export class KMSKeyProvider implements ResourceProvider {'
    );
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[stale-entry]');
    expect(result.stderr).toContain('KMSProvider');
    // ...and the renamed class is itself an unrecorded omitter.
    expect(result.stderr).toContain('KMSKeyProvider');
  }, SPAWN_TIMEOUT_MS);

  it('a 6th parameter typed `unknown` is REFUSED, not counted as declaring', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'logs-loggroup-provider.ts',
      FIVE_PARAM_UPDATE,
      `  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: unknown
  ): Promise<ResourceUpdateResult> {`
    );
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[refusal]');
    expect(result.stderr).toContain('LogsLogGroupProvider');
    expect(result.stderr).toContain('not `UpdateContext`');
    // The refusal must NOT quietly reclassify it as declaring.
    expect(result.stderr).not.toContain('[newly-declaring]');
    // ...nor report the provider as a DEAD allow-list entry. Review measured
    // exactly that: a refused provider also produced `[stale-entry] … no
    // longer exist … Remove or rename the entries`, and obeying it would have
    // deleted a live worklist entry for a provider still sitting in the tree.
    expect(result.stderr).not.toContain('[stale-entry]');
    expect(result.stderr).not.toContain('no longer exist');
  }, SPAWN_TIMEOUT_MS);

  it('a provider in a `.mts` file is SCANNED, not skipped', () => {
    // Review: narrowing the file filter back to /\.ts$/ leaves both the
    // self-probes green (they bypass `buildReport`'s filter entirely) and the
    // real-tree run green (no such file exists), so the widening had nothing
    // watching it. This is the only arm that does.
    const dir = copyProvidersTree();
    writeFileSync(
      join(dir, 'zzz-x-provider.mts'),
      `export class MtsOnlyProvider {
  async create(a: string): Promise<void> {}
  async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
  async delete(a: string): Promise<void> {}
}
`
    );
    const scratch = buildReport(dir);
    expect(scratch.files).toContain('zzz-x-provider.mts');
    expect(scratch.classes.map((c) => c.name)).toContain('MtsOnlyProvider');
    // ...and end to end, the unrecorded omitter reds the run.
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MtsOnlyProvider');
  }, SPAWN_TIMEOUT_MS);

  it('a provider hidden in a SUBDIRECTORY is refused, not scanned past', () => {
    // The scan is not recursive, so before this refusal such a provider was
    // invisible and the run exited 0 (found in review).
    const dir = copyProvidersTree();
    mkdirSync(join(dir, 'nested'));
    writeFileSync(
      join(dir, 'nested', 'hidden-provider.ts'),
      `export class HiddenProvider {
  async create(a: string): Promise<void> {}
  async update(a: string, b: string, c: string, d: object, e: object): Promise<void> {}
  async delete(a: string): Promise<void> {}
}
`
    );
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[refusal]');
    expect(result.stderr).toContain('nested/');
    expect(result.stderr).toContain('not recursive');
  }, SPAWN_TIMEOUT_MS);

  it('two provider classes sharing a name fail — the list cannot address either', () => {
    const dir = copyProvidersTree();
    mutate(
      dir,
      'wait-condition-handle-provider.ts',
      'export class WaitConditionHandleProvider implements ResourceProvider {',
      'export class KMSProvider implements ResourceProvider {'
    );
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[duplicate-name]');
    expect(result.stderr).toContain('KMSProvider');
  }, SPAWN_TIMEOUT_MS);

  it('an emptied provider tree fails on the floors instead of passing vacuously', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-2613-empty-'));
    scratchDirs.push(dir);
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[floor]');
    expect(result.stderr).toContain('not seeing the provider tree');
    // A stale-entry finding for all 67 names is the second, louder signal.
    expect(result.stderr).toContain('[stale-entry]');
  }, SPAWN_TIMEOUT_MS);
});
