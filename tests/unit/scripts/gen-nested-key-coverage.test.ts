import { afterAll, describe, it, expect, vi } from 'vite-plus/test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  NESTED_KEY_ALLOW_LIST,
  NESTED_KEY_TARGETS,
  REVERSE_MAP_FUNCTION_PREFIXES,
  allowKey,
  buildReport,
  classifyTargetShapes,
  collectSdkInterfaces,
  collectSdkMemberNames,
  collectStringLiterals,
  collectWriteEvidence,
  countExpandingHandoffPoints,
  expandLiteralSegments,
  findDivergences,
  findStaleAllowListEntries,
  findStaleSegmentRenames,
  isHandoffCovered,
  loadReport,
  lowerFirst,
  nestedKeyPathsForTarget,
  reachableSdkMemberNames,
  inputReachableInterfaces,
  resolveDefinitionInterface,
  wholeDeliveredPathsFor,
  wrapperInterfaceNames,
  type NestedKeyPath,
  type NestedKeyTarget,
  type ProviderWriteEvidence,
  type SdkMemberType,
  type TargetReport,
} from '../../../scripts/gen-nested-key-coverage.ts';
import {
  extractDefinitionRequired,
  extractDefinitionShapes,
  extractNestedPropertyNames,
  extractNestedPropertyPaths,
} from '../../../scripts/refresh-cfn-schemas.mjs';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

// Vitest's 5s default does not fit this file. Many of its tests parse the WHOLE
// real `src/provisioning/providers` tree through the TypeScript compiler API —
// inherently SECONDS each locally and ~3x that on CI. Two of them (the opt-in-table and S3
// reason-(C) fences, 1.6s / 2.2s locally) timed out on CI at 5s while passing
// locally three runs in a row, which is exactly the boundary this raises off.
//
// Set once per FILE rather than per test on purpose: the failure that prompted
// it was a heavyweight test added WITHOUT a timeout argument, and the repo's
// per-test convention (`}, 15_000)`) guarantees that recurs every time this
// file grows. Slowness here is a property of the file, not of individual tests.
//
// RAISED 15s -> 60s (issues #1754 / #1755 / #1759), and the reason is the
// growth this comment predicted rather than a new slow test: that PR grew
// `s3-bucket-provider.ts` by ~17%, and every one of these tests parses it. The
// cost is not evenly spread — RE-MEASURED locally, the slowest test is 15.2s (`a
// WALK-DEPENDENT opt-in must declare minHandoffPoints`), i.e. already AT the old
// cap, with the two that actually failed CI at 5.3s and 5.0s locally. So the old
// figure of "1-2s each" was stale by an order of magnitude on the tail, and 15s
// left no headroom at all for the ~3x CI factor this file's own note records.
// 60s restores it. A number this large is only defensible because the file is
// pure offline static analysis with no network and no AWS: the only thing a
// generous cap can hide here is a genuine performance regression in the critic.
//
// NO NUMERIC RUNTIME FENCE, and that is a decision rather than an omission (PR
// review asked for one or for this paragraph). The gap is real — at a 60s cap
// and a 15.2s slowest test, a 3.9x critic slowdown lands at 59s and passes
// silently. But every candidate fence is worse than the gap:
//   - A wall-clock `expect(elapsed).toBeLessThan(N)` has to straddle a
//     local-to-CI factor this file's own header measures at ~3x and which moves
//     with runner contention. Any N tight enough to catch 2x (i.e. under ~30s)
//     false-fires on a loaded runner; any N loose enough not to (45s+) catches
//     less than the 60s cap already does on the slowest test.
//   - A tighter PER-TEST timeout on the heavy probes cannot work either: the
//     slowest is already 15.2s locally, so its own CI budget is ~45s.
// So the fence stays the cap, and the mitigation is measurement rather than
// assertion: `vp test run <this file> --reporter=verbose` prints per-test
// durations, and the numbers above are the baseline to compare against
// (2026-08-13, local: slowest 15.2s). Re-measure
// and update them when this file's cost changes; a bump made without new numbers
// is the thing this note exists to prevent.
//
// RAISED 60s -> CONTENDED_CASE_TIMEOUT_MS (300s), with the new numbers
// (go-to-k/cdkd#3607, 2026-09-26). Alone, this file's slowest per-case times are
// now 33.5s (the hygiene probe below, then on a 120s bound) and 11.3-11.5s for
// the opt-in-table and S3 reason-(C) fences. In a full suite with another
// session's suite on the same machine, three cases blew the 60s cap at 72.1s,
// 82.0s and 90.5s: the contention factor is about 8x, not the ~3x this note
// assumed. What this gives up is the one thing the paragraph above says the cap
// still buys: on the slowest case this file-level cap governs (11.5s alone) a
// critic slowdown now has to exceed ~26x (60s reported ~5x) before the cap
// reports it, and on the hygiene probe, which carries its own bound, ~9x
// (120s reported ~3.6x). That is the same trade the paragraph
// made at 60s, re-priced on measured contention — a cap tight enough to catch
// 4x fires on a busy machine, which is what this issue recorded.
//
// go-to-k/cdkd#3723 retired the KEY and WRITE passes (the sdk-wire unit harness
// catches those classes now), and with them the cases the measurements above
// name — the opt-in-table, S3 reason-(C) and walk-dependent probes. The heavy
// cases left are the real-repo `loadReport()` describes and the walk-floor
// hygiene probe. The cap is unchanged; re-measure before lowering it.
vi.setConfig({ testTimeout: CONTENDED_CASE_TIMEOUT_MS });

const repoRoot = process.cwd();
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');

const exactTarget: NestedKeyTarget = {
  resourceType: 'AWS::Fake::Thing',
  providerFile: 'fake-provider.ts',
  sdkClientPackage: '@aws-sdk/client-fake',
  keyStyle: 'exact',
  minNestedKeys: 0,
};

/**
 * Build the PATH-shaped audited units the classifier takes since #1448, at the
 * FULL depth it audits since #1464. Every synthetic probe hangs its chains off
 * one top-level so the scoped write lookup has something to resolve against;
 * a chain may be dotted (`'EnvironmentVariables.Type'`) to probe depth.
 */
const keyPaths = (topLevelProperty: string, ...chains: string[]): NestedKeyPath[] =>
  chains.map((chain) => {
    const segments = [topLevelProperty, ...chain.split('.')];
    return {
      topLevelProperty,
      key: segments[segments.length - 1]!,
      path: segments.join('.'),
      segments,
    };
  });

/** Build write evidence from a `{ scopePath: [membersDirectlyBeneathIt] }` sketch. */
const writeEvidence = (
  scopes: Record<string, readonly string[]>,
  handoffScopes: readonly string[] = []
): ProviderWriteEvidence => ({
  scopes: new Map(Object.entries(scopes).map(([k, v]) => [k, new Set(v)])),
  handoffScopes: new Set(handoffScopes),
});

/** The sibling module the real generic converter lives in (issue #1445). */
const CASE_CONVERT_SOURCE = readFileSync(
  join(PROVIDERS_DIR, 'agentcore-case-convert.ts'),
  'utf8'
);
const resolveCaseConvert = (specifier: string): string | undefined =>
  specifier === './agentcore-case-convert.js' ? CASE_CONVERT_SOURCE : undefined;

/**
 * Every hand-off POINT recorded anywhere in a provider's evidence — the
 * terminal segment of each hand-off PATH, which is the unit the pre-#1464
 * probes were written against and the unit
 * {@link countExpandingHandoffPoints} still counts.
 */
const allHandoffPoints = (evidence: ProviderWriteEvidence): Set<string> =>
  new Set([...evidence.handoffScopes].map((p) => p.slice(p.lastIndexOf('.') + 1)));

/**
 * Every member NAME the collector recorded a write of, at any depth: the
 * terminal segment of each scope key. A write at a path always opens that
 * path's scope (even when its value resolves to no literal), so this is the
 * name-level view of the scope index, for probes that ask "was this member
 * written at all" rather than "under which parent".
 */
const writtenNames = (evidence: ProviderWriteEvidence): Set<string> =>
  new Set([...evidence.scopes.keys()].map((p) => p.slice(p.lastIndexOf('.') + 1)));

/** A synthetic TargetReport with every list empty, for the report-plumbing probes. */
const targetReport = (overrides: Partial<TargetReport> = {}): TargetReport => ({
  resourceType: exactTarget.resourceType,
  providerFile: exactTarget.providerFile,
  sdkClientPackage: exactTarget.sdkClientPackage,
  keyStyle: exactTarget.keyStyle,
  nestedKeyCount: 0,
  wholeDeliveredPaths: [],
  shapeEntries: [],
  shapeCleanCount: 0,
  unmatchedDefinitions: [],
  usedSegmentRenames: [],
  ...overrides,
});

describe('collectWriteEvidence (synthetic)', () => {
  it('scopes a write to the members beneath the value it is written with (#1448)', () => {
    const evidence = collectWriteEvidence(`
      const sdk = {
        serviceRole: p['ServiceRole'],
        buildBatchConfig: { serviceRole: p['Inner'], batchReportMode: 1 },
      };
    `);
    const { scopes } = evidence;
    // A name-level view cannot tell the two `serviceRole` writes apart...
    expect(writtenNames(evidence).has('serviceRole')).toBe(true);
    // ...the scope index can.
    expect([...(scopes.get('buildBatchConfig') ?? [])].sort()).toEqual([
      'batchReportMode',
      'serviceRole',
    ]);
    expect(scopes.get('serviceRole')?.size ?? 0).toBe(0);
  });

  it('resolves a scope through a const binding, a call and a .map callback', () => {
    const { scopes } = collectWriteEvidence(`
      class P {
        build() { return { type: 'X', location: 'Y' }; }
        map(p) {
          const cache = { modes: p['Modes'] };
          return {
            source: this.build(),
            cache,
            tags: p['Tags'].map((t) => ({ key: t.Key, value: t.Value })),
          };
        }
      }
    `);
    expect([...(scopes.get('source') ?? [])].sort()).toEqual(['location', 'type']);
    expect([...(scopes.get('cache') ?? [])].sort()).toEqual(['modes']);
    expect([...(scopes.get('tags') ?? [])].sort()).toEqual(['key', 'value']);
  });

  it('resolves both arms of a conditional / ?? and merges a spread', () => {
    const { scopes } = collectWriteEvidence(`
      const sdk = {
        auth: flag ? { type: 1 } : { resource: 2 },
        env: base ?? { image: 3 },
        merged: { ...{ inner: 4 }, own: 5 },
      };
    `);
    expect([...(scopes.get('auth') ?? [])].sort()).toEqual(['resource', 'type']);
    expect([...(scopes.get('env') ?? [])].sort()).toEqual(['image']);
    expect([...(scopes.get('merged') ?? [])].sort()).toEqual(['inner', 'own']);
  });

  it('records a nested member at its OWN path, not flattened into the ancestor (#1464)', () => {
    // The #1464 inversion of "records a member written ANY depth beneath the
    // scope": the CFn side now audits `BuildBatchConfig.Restrictions.
    // ComputeTypesAllowed`, so the write index must place the member one level
    // down instead of merging it into `buildBatchConfig`. Merging is what let a
    // member vouch for its same-named cousin.
    const { scopes } = collectWriteEvidence(`
      const sdk = { buildBatchConfig: { restrictions: { computeTypesAllowed: [] } } };
    `);
    expect([...(scopes.get('buildBatchConfig') ?? [])]).toEqual(['restrictions']);
    expect([...(scopes.get('buildBatchConfig.restrictions') ?? [])]).toEqual([
      'computeTypesAllowed',
    ]);
  });

  it('keeps two same-named members at DIFFERENT depths apart (#1464)', () => {
    // The bug the whole issue is about, in miniature: `Environment.Type` and
    // `Environment.EnvironmentVariables.Type` are separate facts, so deleting
    // one write must not leave the other vouching for it.
    const { scopes } = collectWriteEvidence(`
      const sdk = {
        environment: {
          type: p['Type'],
          environmentVariables: vars.map((v) => ({ name: v.Name, type: v.Type })),
        },
      };
    `);
    expect([...(scopes.get('environment') ?? [])].sort()).toEqual([
      'environmentVariables',
      'type',
    ]);
    expect([...(scopes.get('environment.environmentVariables') ?? [])].sort()).toEqual([
      'name',
      'type',
    ]);
  });

  it('a purely NESTED write opens no root scope of its own (#1464, bound 2 closed)', () => {
    // Through #1448 every property assignment in the file opened a root scope,
    // so `cloudWatchLogs` looked like a top-level even though it only ever
    // appears nested — and a CFn top-level of that spelling was checked against
    // it. Lexical nesting is now recorded only under its parent's path.
    const { scopes } = collectWriteEvidence(`
      class P {
        c() { return { logsConfig: { cloudWatchLogs: { groupName: 3 } } }; }
      }
    `);
    expect(scopes.has('cloudWatchLogs')).toBe(false);
    expect([...(scopes.get('logsConfig.cloudWatchLogs') ?? [])]).toEqual(['groupName']);
  });

  it('peels `await` off a resolved value', () => {
    // Un-peeled, `await this.build()` resolves to no literals and the `source`
    // scope comes out empty. No audited provider awaits a mapper today, so this
    // synthetic case IS the fence.
    const { scopes } = collectWriteEvidence(`
      class P {
        async build() { return { type: 1, location: 2 }; }
        async map() { return { source: await this.build() }; }
      }
    `);
    expect([...(scopes.get('source') ?? [])].sort()).toEqual(['location', 'type']);
  });

  it('climbs OUT to an enclosing scope for a binding, but not into sibling functions', () => {
    // A module-level `const DEFAULTS = { … }` used inside a method is a real
    // shape; not finding it flags CORRECT code. The climb must NOT reach a
    // same-named binding in an unrelated method, and a PARAMETER of the nearest
    // scope stops it entirely.
    const { scopes } = collectWriteEvidence(`
      const DEFAULTS = { alpha: 1 };
      class P {
        other() { const cfg = { fromSibling: 1 }; return cfg; }
        map(cfg) { return { environment: DEFAULTS, cache: cfg }; }
      }
    `);
    expect([...(scopes.get('environment') ?? [])].sort()).toEqual(['alpha']);
    // `cfg` is a PARAMETER here — the sibling method's `const cfg` must not
    // resolve it, or an unrelated literal would vouch for a CI-blocking bucket.
    expect([...(scopes.get('cache') ?? [])]).toEqual([]);
  });

  it('does NOT resolve a same-named method on an UNRELATED receiver', () => {
    // `client.mapSource(x)` is not the provider's own mapper. Crediting it was
    // a false CLEAR on a CI-blocking bucket, so only `this.helper(…)` and a
    // bare `helper(…)` resolve.
    const source = `
      class P {
        mapSource(s) { return { type: 1, location: 2 }; }
        own() { return { source: this.mapSource(s) }; }
        foreign() { return { artifacts: client.mapSource(s) }; }
      }
    `;
    const { scopes } = collectWriteEvidence(source);
    expect([...(scopes.get('source') ?? [])].sort()).toEqual(['location', 'type']);
    expect([...(scopes.get('artifacts') ?? [])]).toEqual([]);
  });

  it('resolves filter / find / concat through the RECEIVER, not the predicate', () => {
    // `filter` / `find` were briefly treated as callback-returning, which
    // resolves a PREDICATE and yields nothing; the delivered value comes from
    // the array. `concat` delivers the receiver AND its arguments.
    const { scopes } = collectWriteEvidence(`
      const pool = [{ alpha: 1 }];
      const extra = [{ beta: 2 }];
      const sdk = {
        picked: pool.find((x) => x.alpha === 1),
        kept: pool.filter((x) => Boolean(x)),
        joined: pool.concat(extra),
      };
    `);
    expect([...(scopes.get('picked') ?? [])].sort()).toEqual(['alpha']);
    expect([...(scopes.get('kept') ?? [])].sort()).toEqual(['alpha']);
    expect([...(scopes.get('joined') ?? [])].sort()).toEqual(['alpha', 'beta']);
  });

  it('counts compound assignment operators as writes (#1448 comment item 1)', () => {
    // `??=` / `||=` / `+=` are writes. Treating them as non-writes would fail CI
    // with the MISLEADING "the provider never writes it" after a refactor.
    const written = writtenNames(collectWriteEvidence(`
      sdk.batchReportMode ??= 'REPORT_AGGREGATED_BATCH';
      sdk.timeoutInMins ||= 60;
      sdk['combineArtifacts'] &&= true;
      sdk.queuedTimeoutInMinutes += 1;
    `));
    expect([...written].sort()).toEqual([
      'batchReportMode',
      'combineArtifacts',
      'queuedTimeoutInMinutes',
      'timeoutInMins',
    ]);
  });

  it('recognizes Object.defineProperty WITHOUT crediting the descriptor keys', () => {
    // The descriptor literal would otherwise put `value` / `get` / `writable`
    // into the set — and `value` IS a real CodeBuild member (`Value`).
    const evidence = collectWriteEvidence(`
      Object.defineProperty(sdk, 'batchReportMode', {
        value: { serviceRole: 1 },
        writable: true,
        enumerable: true,
      });
    `);
    const written = writtenNames(evidence);
    const { scopes } = evidence;
    expect(written.has('batchReportMode')).toBe(true);
    expect(written.has('value')).toBe(false);
    expect(written.has('writable')).toBe(false);
    expect(written.has('enumerable')).toBe(false);
    // ...and the descriptor's `value` payload still becomes the member's scope.
    expect(scopes.get('batchReportMode')?.has('serviceRole')).toBe(true);
  });

  it('a computed / variable defineProperty name is not credited', () => {
    const written = writtenNames(collectWriteEvidence(
      `Object.defineProperty(sdk, key, { value: 1 });`
    ));
    expect(written.has('key')).toBe(false);
  });

  it('a COMPARISON-ONLY literal is not delivery (#1448 diff-is-not-delivery)', () => {
    // The change-detection idiom of a diff-heavy `update()`: the literal names
    // the member but nothing is ever sent.
    const written = writtenNames(collectWriteEvidence(`
      const changed =
        JSON.stringify({ batchReportMode: next }) !== JSON.stringify({ batchReportMode: prev });
      const empty = Object.keys({ combineArtifacts: next }).length === 0;
      const delivered = { timeoutInMins: 5 };
      send(delivered);
    `));
    expect(written.has('batchReportMode')).toBe(false);
    expect(written.has('combineArtifacts')).toBe(false);
    expect(written.has('timeoutInMins')).toBe(true);
  });

  it('the NESTED half of a comparison-only literal is not delivery either', () => {
    // `inner`'s own parent chain stops at a PropertyAssignment, so the check has
    // to climb to the OUTERMOST literal before asking what consumes it.
    const written = writtenNames(collectWriteEvidence(`
      const changed =
        JSON.stringify({ buildBatchConfig: { batchReportMode: next } }) !==
        JSON.stringify({ buildBatchConfig: { batchReportMode: prev } });
    `));
    expect(written.has('buildBatchConfig')).toBe(false);
    expect(written.has('batchReportMode')).toBe(false);
  });

  it('a literal serialized into a REQUEST is still delivery', () => {
    // The other side of the same rule: `body: JSON.stringify(x)` sends the value.
    const written = writtenNames(collectWriteEvidence(
      `const req = { body: JSON.stringify({ batchReportMode: 1 }) };`
    ));
    expect(written.has('batchReportMode')).toBe(true);
  });
});

describe('the BUILDER idiom (synthetic, issue #1474)', () => {
  /** The members the write at `path` is scoped to, sorted. */
  const scopeAt = (source: string, path: string): string[] =>
    [...(collectWriteEvidence(source).scopes.get(path) ?? [])].sort();

  it('credits an EMPTY-literal seed populated by property assignment', () => {
    // `CloudWatchAnomalyDetectorProvider.buildPutParams` in miniature: the
    // members ARE written, per member, on the forward path — only their AST
    // location differs from a literal's, which is what made all three of that
    // target's residuals FALSE POSITIVES.
    const source = `
      class P {
        build(configuration) {
          const mapped = {};
          mapped.MetricTimezone = configuration['MetricTimeZone'];
          mapped.ExcludedTimeRanges = ranges.map((r) => ({
            StartTime: toDate(r['StartTime']),
            EndTime: toDate(r['EndTime']),
          }));
          return mapped;
        }
        put(p) { return { Configuration: this.build(p) }; }
      }
    `;
    expect(scopeAt(source, 'Configuration')).toEqual([
      'ExcludedTimeRanges',
      'MetricTimezone',
    ]);
    expect(scopeAt(source, 'Configuration.ExcludedTimeRanges')).toEqual([
      'EndTime',
      'StartTime',
    ]);
  });

  it('credits a PARTIAL-literal seed alongside an element-access assignment', () => {
    // `S3BucketProvider.applyWebsiteConfiguration`'s shape: the seed carries
    // some members and `sdkConfig['X'] = …` adds the rest. Both halves land at
    // the same path.
    const source = `
      class P {
        apply(cfg) {
          const sdkConfig = { RedirectAllRequestsTo: { HostName: cfg['HostName'] } };
          sdkConfig['IndexDocument'] = { Suffix: cfg['IndexDocument'] };
          return send({ WebsiteConfiguration: sdkConfig });
        }
      }
    `;
    expect(scopeAt(source, 'WebsiteConfiguration')).toEqual([
      'IndexDocument',
      'RedirectAllRequestsTo',
    ]);
    expect(scopeAt(source, 'WebsiteConfiguration.IndexDocument')).toEqual(['Suffix']);
    expect(scopeAt(source, 'WebsiteConfiguration.RedirectAllRequestsTo')).toEqual(['HostName']);
  });

  it('credits a builder SPREAD into the returned object, alongside the literal half', () => {
    const source = `
      class P {
        build() {
          const partial = {};
          partial.Alpha = 1;
          return { ...partial, Beta: 2 };
        }
        put() { return { Configuration: this.build() }; }
      }
    `;
    expect(scopeAt(source, 'Configuration')).toEqual(['Alpha', 'Beta']);
  });

  it('follows a builder through EARLY-RETURN arms and through a `?:`', () => {
    // The delivery test is existential, exactly as it is for a literal: the
    // `return undefined` guard arm carries nothing and must not disqualify the
    // arm that carries the builder.
    expect(
      scopeAt(
        `
      class P {
        build(cfg) {
          const out = {};
          if (!cfg) return undefined;
          out.Alpha = cfg['Alpha'];
          return out;
        }
        put(cfg) { return { Configuration: this.build(cfg) }; }
      }
    `,
        'Configuration'
      )
    ).toEqual(['Alpha']);
    expect(
      scopeAt(
        `
      class P {
        put(flag) {
          const a = {};
          a.Alpha = 1;
          const b = {};
          b.Beta = 2;
          return { Configuration: flag ? a : b };
        }
      }
    `,
        'Configuration'
      )
    ).toEqual(['Alpha', 'Beta']);
  });

  it('an assignment CHAIN lands at its own depth, not flattened onto the builder', () => {
    // The depth-scoping #1464 established has to hold for a builder too:
    // `out.Rule.DefaultRetention = { Mode }` is three facts, not one.
    const source = `
      class P {
        build(cfg) {
          const out = {};
          out.Rule = {};
          out.Rule.DefaultRetention = { Mode: cfg['Mode'] };
          return out;
        }
        put(cfg) { return { ObjectLockConfiguration: this.build(cfg) }; }
      }
    `;
    expect(scopeAt(source, 'ObjectLockConfiguration')).toEqual(['Rule']);
    expect(scopeAt(source, 'ObjectLockConfiguration.Rule')).toEqual(['DefaultRetention']);
    expect(scopeAt(source, 'ObjectLockConfiguration.Rule.DefaultRetention')).toEqual(['Mode']);
  });

  // ---- NOT A RUBBER STAMP: the shapes the recognizer must REFUSE.

  it('a builder that is never DELIVERED credits nothing at the write path', () => {
    // Written, but never handed to a write.
    const source = `
      class P {
        build(cfg) {
          const unused = {};
          unused.Alpha = 1;
          return { Beta: 2 };
        }
        put(cfg) { return { Configuration: this.build(cfg) }; }
      }
    `;
    const { scopes } = collectWriteEvidence(source);
    expect([...(scopes.get('Configuration') ?? [])]).toEqual(['Beta']);
    // The ROOT scope `unused.Alpha = 1` opens is the pre-existing bound (2)
    // residue: the assignment IS recorded, at depth 1, and the recognizer did
    // not remove that. Asserting it positively is what keeps this test from
    // passing on a harness that simply produced nothing.
    expect(scopes.has('Alpha')).toBe(true);
    expect(scopes.has('Configuration.Alpha')).toBe(false);
  });

  it('a builder whose only consumer is a DIFF is not delivery', () => {
    // The write-site `feedsOnlyComparison` rule reaches the builder for free,
    // because `walkBuilderAt` only ever runs from a write the rule already
    // filtered. Nothing opens a `Configuration` scope at all.
    const { scopes } = collectWriteEvidence(`
      class P {
        unchanged(prev) {
          const probe = {};
          probe.Alpha = 1;
          return JSON.stringify({ Configuration: probe }) === JSON.stringify(prev);
        }
      }
    `);
    expect(scopes.has('Configuration')).toBe(false);
  });

  it('an assignment onto a SAME-NAMED binding in another METHOD does not vouch', () => {
    // Declaration IDENTITY, not the bare name — the bare-name weakness of
    // known bound (3), deliberately not inherited by this recognizer.
    const source = `
      class P {
        other() { const out = {}; out.Foreign = 1; return out; }
        build() { const out = {}; out.Own = 2; return out; }
        put() { return { Configuration: this.build() }; }
      }
    `;
    expect(scopeAt(source, 'Configuration')).toEqual(['Own']);
  });

  it('two same-named builders in ONE function do not cross-credit (#1474 review)', () => {
    // The sibling-METHOD case above passed from the start; the intra-FUNCTION
    // case did NOT. `declarationOf` searched the nearest FUNCTION scope and
    // descended fully, taking the first textual match, so both `cfg` bindings
    // collapsed onto one declaration and their member sets MERGED — `BlobA`
    // measured `{Alpha, Beta}` and `BlobB` the same. That is the false-CLEAR
    // direction on a CI-blocking bucket, and it directly contradicted the
    // header's "never the bare name" claim. Fixed by resolving through BLOCK
    // scopes, which is what `const` actually obeys.
    const source = `
      class P {
        build(props) {
          const params = {};
          if (props['A']) { const cfg = {}; cfg.Alpha = 1; params.BlobA = cfg; }
          else { const cfg = {}; cfg.Beta = 2; params.BlobB = cfg; }
          return params;
        }
        put(props) { return { Root: this.build(props) }; }
      }
    `;
    expect(scopeAt(source, 'Root.BlobA')).toEqual(['Alpha']);
    expect(scopeAt(source, 'Root.BlobB')).toEqual(['Beta']);
  });

  it('a nested arrow declaring the same name does not capture the outer builder', () => {
    // The worse half of the same defect: with the ARROW's `cfg` declared
    // textually first, the outer `cfg` resolved to it, so `Cfg` measured
    // `{Inner}` — the outer member falsely FLAGGED and the inner one falsely
    // CLEARED, both at once.
    const source = `
      class P {
        build(props) {
          const inner = props['Xs'].map(() => { const cfg = {}; cfg.Inner = 1; return cfg; });
          const cfg = {};
          cfg.Outer = 2;
          return { Cfg: cfg, Inner: inner };
        }
        put(props) { return { Root: this.build(props) }; }
      }
    `;
    // `['Outer']` exactly — the outer member is credited AND `Inner` is not
    // borrowed from the arrow's same-named binding, which is both halves of
    // the inversion.
    expect(scopeAt(source, 'Root.Cfg')).toEqual(['Outer']);
    // `Root.Inner` used to be empty because `inner` binds to a `.map(…)` call
    // rather than a literal seed — the under-crediting gap issue #1540's
    // BUILDER-BEHIND-BINDING hop closed: `resolveBuilders` now follows the
    // plain binding's initializer (same declaration-identity strictness), so
    // the callback's builder credits its members here. The assertion above
    // still proves the arrow's same-named `cfg` did NOT leak into `Root.Cfg`.
    expect(scopeAt(source, 'Root.Inner')).toEqual(['Inner']);
  });

  it('the builder-behind-binding hop refuses a wholly-reassigned binding (#1540)', () => {
    // The false-CLEAR guard on the new hop itself, asserted on the shape the
    // REGRESSION would credit: the binding holds a builder-producing `.map()`
    // at declaration, then is reassigned to an opaque value before delivery.
    // Crediting the callback's builder MUTATIONS for a value that is no longer
    // that value is exactly what `isWhollyReassigned` refuses — same reason
    // `builderDeclarationOf` refuses it for a directly-held builder. The SEED
    // member still appears via `resolveLiterals`, which resolves reassigned
    // bindings by design (the recorded bound (8) note) — the hop's own
    // contract is only that `Mutated` is not borrowed.
    const source = `
      class P {
        build(props) {
          let rules = props['Rules'].map(() => { const sdkRule = { Seed: 1 }; sdkRule.Mutated = 2; return sdkRule; });
          rules = opaque(props);
          return { Rules: rules };
        }
        put(props) { return { Cfg: this.build(props) }; }
      }
    `;
    expect(scopeAt(source, 'Cfg.Rules')).toEqual(['Seed']);
    // The control: without the reassignment the SAME source credits the
    // mutation, proving the refusal above is the guard and not a dead branch.
    const withoutReassignment = source.replace('rules = opaque(props);', '');
    expect(scopeAt(withoutReassignment, 'Cfg.Rules').sort()).toEqual(['Mutated', 'Seed']);
  });

  it('skips a REVERSE-MAP helper nested inside the builder scope', () => {
    // The only builder refusal in the OVER-crediting direction, and it had no
    // test (#1474 review). `builderMembers` re-applies the
    // REVERSE_MAP_FUNCTION_PREFIXES skip, so a `readCurrentState*` helper that
    // writes CFn spellings onto the forward builder contributes nothing. The
    // control below — the identical helper under a non-reverse name — is what
    // proves the branch is load-bearing rather than inert.
    const withReverseMap = `
      class P {
        build(cfg) {
          const out = {};
          out.Forward = 1;
          function readCurrentStateInner() { out.Reverse = 2; }
          return out;
        }
        put(cfg) { return { Configuration: this.build(cfg) }; }
      }
    `;
    const withPlainHelper = withReverseMap.replace(
      'readCurrentStateInner',
      'patchInner'
    );
    expect(scopeAt(withReverseMap, 'Configuration')).toEqual(['Forward']);
    expect(scopeAt(withPlainHelper, 'Configuration')).toEqual(['Forward', 'Reverse']);
  });

  it('credits ONLY the builder, never its enclosing scope', () => {
    // The #1445 review's `ContainerPortRange` trap, one recognizer over: a
    // sibling object mutated in the same function must not ride along, or a
    // real silent drop is silenced.
    const source = `
      class P {
        build(cfg) {
          const out = {};
          const sibling = {};
          out.Delivered = 1;
          sibling.NotDelivered = 2;
          send(sibling);
          return out;
        }
        put(cfg) { return { Configuration: this.build(cfg) }; }
      }
    `;
    expect(scopeAt(source, 'Configuration')).toEqual(['Delivered']);
  });

  it('a COMPUTED key on a builder names a VARIABLE, not a member', () => {
    const source = `
      class P {
        build(k) {
          const out = {};
          out[k] = 1;
          out['Literal'] = 2;
          return out;
        }
        put(k) { return { Configuration: this.build(k) }; }
      }
    `;
    expect(scopeAt(source, 'Configuration')).toEqual(['Literal']);
  });

  // ---- BOUND (8): shapes the recognizer refuses on purpose, pinned so the
  // refusal cannot silently widen into a rubber stamp.

  /**
   * The bound probes below all assert an EMPTY credit, which a totally broken
   * harness also produces. Each pairs its refusal with the identical source in
   * its ACCEPTED spelling, so the pair proves the refusal is the thing being
   * measured rather than the walk having stopped working (#1474 review).
   */
  const refusedVsAccepted = (refused: string, accepted: string): void => {
    const { scopes } = collectWriteEvidence(refused);
    expect(scopes.has('Configuration'), 'the write itself must still be seen').toBe(true);
    expect([...(scopes.get('Configuration') ?? [])]).toEqual([]);
    expect(scopeAt(accepted, 'Configuration'), 'the accepted twin must credit').toEqual(['Alpha']);
  };

  it('BOUND: a binding whose initializer is NOT an object literal is not a builder', () => {
    refusedVsAccepted(
      `
      class P {
        build() { const out = makeThing(); out.Alpha = 1; return out; }
        put() { return { Configuration: this.build() }; }
      }
    `,
      `
      class P {
        build() { const out = {}; out.Alpha = 1; return out; }
        put() { return { Configuration: this.build() }; }
      }
    `
    );
  });

  it('BOUND: a `let` seeded by a LATER assignment is not a builder', () => {
    // `resolveLiterals` DOES resolve this binding to the `{}` (its identifier
    // branch reads assignments too), so the scope EXISTS and is empty — which
    // `refusedVsAccepted` asserts positively. The builder credit is what is
    // withheld, because the DECLARATION carries no literal and the object's
    // identity is therefore not established there.
    refusedVsAccepted(
      `
      class P {
        build() { let out; out = {}; out.Alpha = 1; return out; }
        put() { return { Configuration: this.build() }; }
      }
    `,
      `
      class P {
        build() { let out = {}; out.Alpha = 1; return out; }
        put() { return { Configuration: this.build() }; }
      }
    `
    );
  });

  it('BOUND: a binding REASSIGNED as a whole is not a builder', () => {
    // Only the initializer was inspected until the #1474 review: the seed's
    // members were credited even though the value actually delivered is the
    // opaque one. False-CLEAR direction, so the whole binding is dropped.
    refusedVsAccepted(
      `
      class P {
        build(props) { let out = {}; out.Alpha = 1; out = opaque(props); return out; }
        put(props) { return { Configuration: this.build(props) }; }
      }
    `,
      `
      class P {
        build(props) { let out = {}; out.Alpha = 1; return out; }
        put(props) { return { Configuration: this.build(props) }; }
      }
    `
    );
  });

  it('BOUND: Object.defineProperty onto a builder is not credited under it', () => {
    // Recorded as a ROOT write by the top-level walk (so the name is in the
    // set), but not scoped to the builder. No provider does this today.
    const source = `
      class P {
        build() {
          const out = {};
          Object.defineProperty(out, 'Alpha', { value: 1 });
          out.Beta = 2;
          return out;
        }
        put() { return { Configuration: this.build() }; }
      }
    `;
    expect(writtenNames(collectWriteEvidence(source)).has('Alpha')).toBe(true);
    expect(scopeAt(source, 'Configuration')).toEqual(['Beta']);
  });

  it('BOUND: the walk is FLOW-INSENSITIVE — a post-delivery assignment still counts', () => {
    // The union-across-sites residue of bound (1), at statement granularity.
    // Over-crediting direction, so it is pinned rather than left implicit; no
    // provider in the tree writes a builder after handing it off.
    const source = `
      class P {
        put(cfg) {
          const out = {};
          send({ Configuration: out });
          out.Late = 1;
        }
      }
    `;
    expect(scopeAt(source, 'Configuration')).toEqual(['Late']);
  });
});

describe('whole-blob hand-off walk (synthetic, issue #1445)', () => {
  /** Wrap a body in a `create(…, properties)` so the bag taint root exists. */
  const inCreate = (body: string): string => `
    class P {
      async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
        ${body}
      }
      ${'' /* helpers appended by callers below */}
    }
  `;

  const pointsOf = (source: string, resolveImport?: (s: string) => string | undefined): Set<string> =>
    allHandoffPoints(
      collectWriteEvidence(source, 'provider.ts', ['readCurrentState'], resolveImport)
    );

  it('records a VERBATIM whole-blob forward off the property bag', () => {
    // `ApiGatewayV2Provider`'s real shape: CFn and SDK spell the blob the same,
    // so the provider hands it over untouched and every member lands.
    const points = pointsOf(
      inCreate(`await this.send({ CorsConfiguration: properties['CorsConfiguration'] });`)
    );
    expect(points.has('CorsConfiguration')).toBe(true);
  });

  it('follows the forward through a const binding', () => {
    // `CloudWatchAnomalyDetectorProvider.buildPutParams`'s shape.
    const points = pointsOf(
      inCreate(`
        const single = properties['SingleMetricAnomalyDetector'] as unknown;
        const params: Record<string, unknown> = {};
        params.SingleMetricAnomalyDetector = single;
      `)
    );
    expect(points.has('SingleMetricAnomalyDetector')).toBe(true);
  });

  it('follows the blob into a same-file GENERIC converter and back out', () => {
    const points = pointsOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { linuxParameters: this.convertLinuxParameters(properties['LinuxParameters']) };
        }
        private convertLinuxParameters(config?: unknown) {
          if (!config) return undefined;
          return flip(config);
        }
      }
      function flip(value: unknown): unknown {
        if (typeof value !== 'object' || value === null) return value;
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          result[key.charAt(0).toLowerCase() + key.slice(1)] = flip(val);
        }
        return result;
      }
    `);
    expect(points.has('linuxParameters')).toBe(true);
  });

  it('follows the blob into the REAL sibling-module pascalToCamelCaseKeys', () => {
    // Cross-module resolution is load-bearing, not a nicety: the tree's only
    // generic converter lives in `agentcore-case-convert.ts`.
    const source = `
      import { pascalToCamelCaseKeys } from './agentcore-case-convert.js';
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { runtimePlatform: pascalToCamelCaseKeys(properties['RuntimePlatform']) };
        }
      }
    `;
    expect(pointsOf(source, resolveCaseConvert).has('runtimePlatform')).toBe(true);
    // …and WITHOUT the resolver the same callee is unresolvable, so it is not
    // credited. That is the fail-closed direction, asserted rather than assumed.
    expect(pointsOf(source).has('runtimePlatform')).toBe(false);
  });

  it('applies the genericity test ACROSS modules, not just within the provider file', () => {
    // The header's safety argument rests on genericity holding for an imported
    // callee too. Same import machinery as the case above, but the sibling
    // module's function NAMES a member — so it must be refused, and the
    // resolver must not become a way to launder a member-naming helper.
    const sibling = `
      export function reshape(value: unknown): unknown {
        const v = value as Record<string, unknown>;
        return { logDriver: v['LogDriver'] };
      }
    `;
    const source = `
      import { reshape } from './reshape-helper.js';
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { logConfig: reshape(properties['LogConfig']) };
        }
      }
    `;
    const resolve = (specifier: string): string | undefined =>
      specifier === './reshape-helper.js' ? sibling : undefined;
    expect(pointsOf(source, resolve).has('logConfig')).toBe(false);
  });

  it('refuses a DELEGATING GUARD whose helper names the members (transitive genericity)', () => {
    // The hole a BODY-LOCAL genericity test leaves: `convertLog` names nothing
    // and the delivery test is existential, so the `return cfg` guard arm alone
    // satisfies it while `buildLog` does the member-naming work. A silent clear
    // on a CI-blocking bucket, so `namesOwnMember` descends into callees.
    const points = pointsOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { logConfig: this.convertLog(properties['LogConfig'] as Record<string, unknown>) };
        }
        private convertLog(cfg?: Record<string, unknown>) {
          if (!cfg) return cfg;
          return this.buildLog(cfg);
        }
        private buildLog(cfg: Record<string, unknown>) {
          return { logDriver: cfg['LogDriver'] };
        }
      }
    `);
    expect(points.has('logConfig')).toBe(false);
  });

  it('refuses a converter that names a member through a COMPUTED literal key', () => {
    // `{ ['Foo']: v }` is a ComputedPropertyName, which the write collector's
    // stricter `propertyName` ignores — so without the dedicated widening a
    // converter could name members in a spelling the genericity test cannot see.
    const points = pointsOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { logConfig: this.convertLog(properties['LogConfig'] as Record<string, unknown>) };
        }
        private convertLog(cfg?: Record<string, unknown>) {
          if (!cfg) return cfg;
          return { ['logDriver']: cfg['LogDriver'] };
        }
      }
    `);
    expect(points.has('logConfig')).toBe(false);
  });

  it('RECORDED BOUND (5): a key-FILTERING converter names nothing and IS credited', () => {
    // Pinning the bound rather than the behaviour we want: this converter drops
    // every key in `DROP` and still passes, because "names no member" is the
    // whole test. No such shape is a hand-off callee in the tree today, but
    // `glue-provider.ts`'s `renameRecordKeys` is the same shape.
    // If a future change makes this expectation FAIL, that is an improvement —
    // update the module header's known bound (5) with the new measurement.
    const points = pointsOf(`
      const DROP = new Set(['Secret']);
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { logConfig: this.filterKeys(properties['LogConfig'] as Record<string, unknown>) };
        }
        private filterKeys(blob?: Record<string, unknown>) {
          if (!blob) return blob;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(blob)) {
            if (DROP.has(k)) continue;
            out[k] = v;
          }
          return out;
        }
      }
    `);
    expect(points.has('logConfig')).toBe(true);
  });

  it('refuses a converter that NAMES A MEMBER of its own', () => {
    // `ECSProvider.convertLoadBalancers`'s shape — per-member re-shaping, so
    // every member keeps having to prove itself.
    const points = pointsOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { loadBalancers: this.convertLoadBalancers(properties['LoadBalancers']) };
        }
        private convertLoadBalancers(lbs?: Array<Record<string, unknown>>) {
          return lbs?.map((lb) => ({ targetGroupArn: lb['TargetGroupArn'] }));
        }
      }
    `);
    expect(points.has('loadBalancers')).toBe(false);
  });

  it('credits a spread-and-patch converter through the SPREAD, not genericity (#1475)', () => {
    // The genericity test still rejects `toSdk` (it names `Comment`), which
    // is what this test used to pin. Since issue #1475 the SPREAD of the
    // tainted seed registers the point itself — the fourth recognizer.
    const evidence = collectWriteEvidence(
      `
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { DistributionConfig: this.toSdk(properties['DistributionConfig']) };
        }
        private toSdk(config: Record<string, unknown>) {
          const result = { ...config };
          result['Comment'] = '';
          return result;
        }
      }
      `,
      'provider.ts',
      ['readCurrentState']
    );
    expect(allHandoffPoints(evidence).has('DistributionConfig')).toBe(true);
    // No deletes on the binding, so the wildcard carries no exclusions.
    expect(evidence.handoffExclusions?.get('DistributionConfig')).toBeUndefined();
  });

  it('refuses a blob that did NOT come off the property bag', () => {
    // The measured false clear this taint root exists to stop: CloudFront's
    // disable-then-delete path re-sends the config it just READ from AWS.
    const points = pointsOf(`
      class P {
        async delete(logicalId: string, physicalId: string) {
          const response = await this.client.send(new GetDistributionConfigCommand({}));
          const config = response.DistributionConfig!;
          await this.client.send(new UpdateDistributionCommand({ DistributionConfig: config }));
        }
      }
    `);
    expect(points.has('DistributionConfig')).toBe(false);
  });

  it('taint is DECLARATION-scoped: the same identifier can be bag-derived in one method and not in another', () => {
    // The fence the real `cloudfront-distribution-provider.ts` cannot provide:
    // BOTH of its `config` bindings come from AWS responses, so a bare-NAME
    // taint set would keep that file green. Here one method binds `config` off
    // the property bag and the other off a `Get…` response, under the SAME
    // name — the create-side write must be credited and the delete-side write
    // must not.
    const evidence = collectWriteEvidence(
      `
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const config = properties['TemplateConfig'] as Record<string, unknown>;
          await this.send({ FromTemplate: config });
        }
        async delete(logicalId: string, physicalId: string) {
          const response = await this.client.send(new GetConfigCommand({}));
          const config = response.LiveConfig!;
          await this.send({ FromResponse: config });
        }
      }
      `,
      'provider.ts'
    );
    const points = allHandoffPoints(evidence);
    expect(points.has('FromTemplate')).toBe(true);
    expect(points.has('FromResponse')).toBe(false);
  });

  it('refuses a blob read off the PREVIOUS bag', () => {
    const points = pointsOf(`
      class P {
        async update(id: string, properties: Record<string, unknown>, previousProperties: Record<string, unknown>) {
          await this.send({ CorsConfiguration: previousProperties['CorsConfiguration'] });
        }
      }
    `);
    expect(points.has('CorsConfiguration')).toBe(false);
  });

  it('refuses a hand-off whose result only feeds a comparison', () => {
    const points = pointsOf(
      inCreate(`
        const changed =
          JSON.stringify({ CorsConfiguration: properties['CorsConfiguration'] }) !==
          JSON.stringify({ CorsConfiguration: {} });
      `)
    );
    expect(points.has('CorsConfiguration')).toBe(false);
  });

  it('sees through `?:` / `??` guard arms and a spread-only literal', () => {
    const points = pointsOf(
      inCreate(`
        await this.send({
          A: properties['A'] ? properties['A'] : undefined,
          B: properties['B'] ?? undefined,
          C: { ...(properties['C'] as Record<string, unknown>) },
        });
      `)
    );
    expect([...points].sort()).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });

  it('registers the point under the SEED key too, so a plural/singular rename resolves', () => {
    // `ECSProvider` writes `placementStrategy` for CFn's `PlacementStrategies`;
    // keying only by the write name leaves the CFn top-level with no scope.
    const evidence = collectWriteEvidence(
      `
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { placementStrategy: this.pass(properties['PlacementStrategies']) };
        }
        private pass(items?: unknown) { return items; }
      }
      `,
      'provider.ts'
    );
    expect(evidence.handoffScopes.has('placementStrategy')).toBe(true);
    // …and the CFn spelling is registered as a SIBLING path (both renderings),
    // which is what the audited `PlacementStrategies.Type` resolves against.
    expect(evidence.handoffScopes.has('PlacementStrategies')).toBe(true);
    expect(evidence.handoffScopes.has('placementStrategies')).toBe(true);
  });

  it('records a NESTED hand-off at its FULL path, so the credit is prefix-bounded', () => {
    const evidence = collectWriteEvidence(
      `
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return {
            containerDefinitions: (properties['ContainerDefinitions'] as Array<Record<string, unknown>>).map((def) => ({
              name: def['Name'],
              linuxParameters: this.pass(def['LinuxParameters']),
            })),
          };
        }
        private pass(config?: unknown) { return config; }
      }
      `,
      'provider.ts'
    );
    expect(evidence.handoffScopes.has('containerDefinitions.linuxParameters')).toBe(true);
    // The bounding, restated in the #1464 shape: the SIBLING blob is NOT
    // wildcarded, so `containerDefinitions.portMappings.containerPortRange`
    // (the #1472 drop) keeps having to prove itself.
    expect(isHandoffCovered(evidence.handoffScopes, 'containerDefinitions')).toBe(false);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'containerDefinitions.linuxParameters.capabilities',
        'add'
      )
    ).toBe(true);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'containerDefinitions.portMappings',
        'containerPortRange'
      )
    ).toBe(false);
  });
});

describe('the SPREAD-AND-PATCH forwarder (synthetic, issue #1475)', () => {
  /** The CloudFront shape, parameterized by the converter body. */
  const converter = (body: string): string => `
    class P {
      async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
        return { DistributionConfig: this.toSdk(properties['DistributionConfig']) };
      }
      private toSdk(config: Record<string, unknown>) {
        ${body}
      }
    }
  `;
  const evidenceOf = (source: string) =>
    collectWriteEvidence(source, 'provider.ts', ['readCurrentState']);

  it('a LITERAL-key delete on the seeded binding becomes an exclusion, not a refusal', () => {
    // Delete-only on purpose: a rename WRITE with literal keys
    // (`result['IsIPV6Enabled'] = result['IPV6Enabled']`) would ALSO register
    // the member as a hand-off under its CFn spelling via the seed-key alias
    // (`registerSeedKeyHandoffs`) — correct, since the value IS delivered
    // under the renamed key — and that would mask the exclusion this test
    // exists to prove. The real provider's rename loop uses COMPUTED keys, so
    // no alias fires there.
    const evidence = evidenceOf(
      converter(`
        const result = { ...config };
        delete result['IPV6Enabled'];
        return result;
      `)
    );
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(true);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'ipv6enabled',
    ]);
    // The exclusion is what the coverage test consults: the deleted key (and
    // anything beneath it) is refused, a sibling is covered.
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig',
        'IPV6Enabled',
        evidence.handoffExclusions
      )
    ).toBe(false);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig.IPV6Enabled',
        'Anything',
        evidence.handoffExclusions
      )
    ).toBe(false);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig',
        'PriceClass',
        evidence.handoffExclusions
      )
    ).toBe(true);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig.Origins',
        'Id',
        evidence.handoffExclusions
      )
    ).toBe(true);
    // A first-segment the caller cannot supply fails CLOSED.
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig',
        undefined,
        evidence.handoffExclusions
      )
    ).toBe(false);
  });

  it('resolves delete keys through an Object.entries(TABLE) rename loop (the real shape)', () => {
    const evidence = evidenceOf(`
      const CFN_TO_SDK: Record<string, string> = { IPV6Enabled: 'IsIPV6Enabled', Staging: 'IsStaging' };
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { DistributionConfig: this.toSdk(properties['DistributionConfig']) };
        }
        private toSdk(config: Record<string, unknown>) {
          const result = { ...config };
          for (const [cfnKey, sdkKey] of Object.entries(CFN_TO_SDK)) {
            result[sdkKey] = result[cfnKey];
            delete result[cfnKey];
          }
          return result;
        }
      }
    `);
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(true);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])].sort()).toEqual([
      'ipv6enabled',
      'staging',
    ]);
    // A COMPUTED-key rename write (`result[sdkKey] = result[cfnKey]`) yields
    // no seed-key alias, so the exclusion is the last word — pinned here
    // because the literal-key rename shape DOES alias (see the first test's
    // comment) and the two must not be confused.
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig',
        'IPV6Enabled',
        evidence.handoffExclusions
      )
    ).toBe(false);
  });

  it('resolves delete keys through for-of over a literal array and Object.keys(TABLE)', () => {
    const evidence = evidenceOf(`
      const DROP_LIST = ['Alpha', 'Beta'];
      const DROP_MAP = { Gamma: 1 };
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { DistributionConfig: this.toSdk(properties['DistributionConfig']) };
        }
        private toSdk(config: Record<string, unknown>) {
          const result = { ...config };
          for (const k of DROP_LIST) delete result[k];
          for (const k of Object.keys(DROP_MAP)) delete result[k];
          return result;
        }
      }
    `);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])].sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('an UNRESOLVABLE delete key refuses the whole registration (fail closed)', () => {
    const evidence = evidenceOf(
      converter(`
        const result = { ...config };
        const dynamic = Object.keys(config)[0]!;
        delete result[dynamic];
        return result;
      `)
    );
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(false);
  });

  it('a delete through a LONGER chain excludes its first segment wholesale', () => {
    const evidence = evidenceOf(
      converter(`
        const result = { ...config };
        delete (result['Restrictions'] as Record<string, unknown>)['GeoRestriction'];
        return result;
      `)
    );
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'restrictions',
    ]);
  });

  it('BOUND (9): an OVERWRITTEN member stays credited through the spread', () => {
    // The named patch is a write of the member (walked on its own), and the
    // wildcard deliberately does not exclude it — the issue's "patches only
    // rename / wrap" model. If a future change tightens this, update bound (9).
    const evidence = evidenceOf(
      converter(`
        const result = { ...config };
        result['Logging'] = { Enabled: false };
        return result;
      `)
    );
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig.Logging',
        'IncludeCookies',
        evidence.handoffExclusions
      )
    ).toBe(true);
  });

  it('a binding REASSIGNED as a whole is refused (the delivered value may not be the seed)', () => {
    const evidence = evidenceOf(
      converter(`
        let result = { ...config };
        result = {};
        return result;
      `)
    );
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(false);
  });

  it('a delete on the RECEIVING binding of a helper-returned seed still excludes (#1475 review)', () => {
    // The seed literal lives inside the helper, so its HOLDER is the callee's
    // return — the delete is on the CALLER's binding, visible only through
    // the chain-source walk from the write value.
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const config = properties['DistributionConfig'] as Record<string, unknown>;
          const result = this.seed(config);
          delete result['IPV6Enabled'];
          await this.send({ DistributionConfig: result });
        }
        private seed(config: Record<string, unknown>) {
          return { ...config };
        }
      }
    `);
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(true);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'ipv6enabled',
    ]);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig',
        'IPV6Enabled',
        evidence.handoffExclusions
      )
    ).toBe(false);
  });

  it('a VERBATIM member forward whose subtree the function deletes into is refused (#1475 review)', () => {
    // deliversWholeBlob's access branch: `delete config['VC']['Id']` mutates
    // the very object `config['VC']` then forwards it whole. No literal
    // remains to register a bounded credit, so the refusal is total — loud.
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const config = properties['DistributionConfig'] as Record<string, unknown>;
          delete (config['ViewerCertificate'] as Record<string, unknown>)['IamCertificateId'];
          await this.send({
            DistributionConfig: { ViewerCertificate: config['ViewerCertificate'] },
          });
        }
      }
    `);
    expect(evidence.handoffScopes.has('DistributionConfig.ViewerCertificate')).toBe(false);
    expect(
      isHandoffCovered(
        evidence.handoffScopes,
        'DistributionConfig.ViewerCertificate',
        'IamCertificateId',
        evidence.handoffExclusions
      )
    ).toBe(false);
    // ...while a SIBLING member the deletes never touch still forwards whole.
    const sibling = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const config = properties['DistributionConfig'] as Record<string, unknown>;
          delete config['Staging'];
          await this.send({
            DistributionConfig: { ViewerCertificate: config['ViewerCertificate'] },
          });
        }
      }
    `);
    expect(sibling.handoffScopes.has('DistributionConfig.ViewerCertificate')).toBe(true);
  });

  it('a delete on an EARLIER binding in the spread chain still excludes (#1475 review)', () => {
    // `{ ...b }` where `const a = { ...config }; delete a['K']; const b = { ...a }`
    // delivers the object a's delete already mutated — the exclusion must
    // travel through the binding chain, not just the literal's own holder.
    const evidence = evidenceOf(
      converter(`
        const a = { ...config };
        delete a['IPV6Enabled'];
        const b = { ...a };
        return b;
      `)
    );
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(true);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'ipv6enabled',
    ]);
  });

  it('a delete on the SEED PARAMETER itself excludes (#1475 review)', () => {
    const evidence = evidenceOf(
      converter(`
        delete config['IPV6Enabled'];
        const result = { ...config };
        return result;
      `)
    );
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(true);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'ipv6enabled',
    ]);
  });

  it('a VERBATIM forward of a deleted-from parameter is refused as a full hand-off (#1475 review)', () => {
    // Reaches deliversWholeBlob's parameter branch, not the spread walk: the
    // helper deletes off its own tainted parameter and forwards it whole. A
    // full hand-off here would silently vouch for the deleted key.
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { CorsConfiguration: this.pass(properties['CorsConfiguration'] as Record<string, unknown>) };
        }
        private pass(config: Record<string, unknown>) {
          delete config['AllowOrigins'];
          return config;
        }
      }
    `);
    expect(evidence.handoffScopes.has('CorsConfiguration')).toBe(false);
  });

  it('a REASSIGNED delete-key table refuses the registration (#1475 review)', () => {
    // The table's initial literal is stale after `TABLE = OTHER;` — resolving
    // it anyway would under-exclude, so the whole registration refuses.
    const evidence = evidenceOf(`
      const OTHER = { Staging: 1 };
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { DistributionConfig: this.toSdk(properties['DistributionConfig']) };
        }
        private toSdk(config: Record<string, unknown>) {
          let TABLE: Record<string, number> = { IPV6Enabled: 1 };
          TABLE = OTHER;
          const result = { ...config };
          for (const k of Object.keys(TABLE)) delete result[k];
          return result;
        }
      }
    `);
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(false);
  });

  it('resolves VALUE-side delete keys of an Object.entries loop (elementIndex 1)', () => {
    const evidence = evidenceOf(`
      const SDK_TO_CFN: Record<string, string> = { IsIPV6Enabled: 'IPV6Enabled' };
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          return { DistributionConfig: this.toSdk(properties['DistributionConfig']) };
        }
        private toSdk(config: Record<string, unknown>) {
          const result = { ...config };
          for (const [sdkKey, cfnKey] of Object.entries(SDK_TO_CFN)) {
            delete result[cfnKey];
          }
          return result;
        }
      }
    `);
    expect([...(evidence.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'ipv6enabled',
    ]);
  });

  it('two BOUNDED registrations at one path INTERSECT their exclusions (union of coverage)', () => {
    // Both sites carry deletes, so BOTH register bounded (a delete-free site
    // would register a FULL hand-off through deliversWholeBlob and supersede —
    // the next test). Coverage is the union: a key only ONE site deletes is
    // delivered by the other, so the merged exclusion drops it; a key BOTH
    // delete must survive — that surviving-key half is the fail-open direction
    // if the merge ever regresses to always-clearing.
    const both = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const a = { ...(properties['Cfg'] as Record<string, unknown>) };
          delete a['Shared'];
          delete a['OnlyA'];
          await this.send({ Cfg: a });
        }
        async update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const b = { ...(properties['Cfg'] as Record<string, unknown>) };
          delete b['Shared'];
          await this.send({ Cfg: b });
        }
      }
    `);
    expect(both.handoffScopes.has('Cfg')).toBe(true);
    expect([...(both.handoffExclusions?.get('Cfg') ?? [])]).toEqual(['shared']);
    expect(isHandoffCovered(both.handoffScopes, 'Cfg', 'Shared', both.handoffExclusions)).toBe(
      false
    );
    expect(isHandoffCovered(both.handoffScopes, 'Cfg', 'OnlyA', both.handoffExclusions)).toBe(
      true
    );
  });

  it('a delete-free second site supersedes via a FULL hand-off (exclusion entry cleared)', () => {
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const a = { ...(properties['Cfg'] as Record<string, unknown>) };
          delete a['Dropped'];
          await this.send({ Cfg: a });
        }
        async update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const b = { ...(properties['Cfg'] as Record<string, unknown>) };
          await this.send({ Cfg: b });
        }
      }
    `);
    expect(evidence.handoffScopes.has('Cfg')).toBe(true);
    expect(evidence.handoffExclusions?.get('Cfg')).toBeUndefined();
  });

  it('a FULL hand-off at the path supersedes a bounded registration', () => {
    // One site forwards the blob VERBATIM (a full hand-off), another spreads a
    // deleted-from copy — the verbatim forward delivers everything, so the
    // exclusion entry must not survive.
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const a = { ...(properties['Cfg'] as Record<string, unknown>) };
          delete a['Dropped'];
          await this.send({ Cfg: a });
        }
        async update(logicalId: string, physicalId: string, resourceType: string, properties: Record<string, unknown>) {
          await this.send({ Cfg: properties['Cfg'] });
        }
      }
    `);
    expect(evidence.handoffScopes.has('Cfg')).toBe(true);
    expect(evidence.handoffExclusions?.get('Cfg')).toBeUndefined();
  });

  it('a binding seeded by LATE ASSIGNMENT is refused (its deletes would be invisible)', () => {
    // `let x; x = { ...bag }` reaches the literal through the assignment, not
    // the declaration, so the delete scan cannot anchor — and a
    // `delete x['K']` after it would silently survive the wildcard. Refused
    // outright, the loud direction (same classification isWhollyReassigned
    // gives the builder recognizer).
    const evidence = evidenceOf(
      converter(`
        let result: Record<string, unknown>;
        result = { ...config };
        delete result['IPV6Enabled'];
        return result;
      `)
    );
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(false);
  });

  it('a NON-BAG seed is refused (the #1445 taint root)', () => {
    const evidence = evidenceOf(`
      class P {
        async delete(logicalId: string, physicalId: string) {
          const response = await this.client.send(new GetDistributionConfigCommand({}));
          const config = response.DistributionConfig!;
          const result = { ...config };
          result['Enabled'] = false;
          await this.client.send(new UpdateDistributionCommand({ DistributionConfig: result }));
        }
      }
    `);
    expect(evidence.handoffScopes.has('DistributionConfig')).toBe(false);
  });

  it('a MIXED literal `{ ...bag, Extra }` registers too (the old crude-safe refusal)', () => {
    // deliversWholeBlob still requires spread-ONLY; the recognizer credits the
    // literal from walkLiteralAt regardless of named siblings — the sibling is
    // an overwrite, bound (9).
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          await this.send({
            CorsConfiguration: { ...(properties['CorsConfiguration'] as Record<string, unknown>), AllowCredentials: true },
          });
        }
      }
    `);
    expect(evidence.handoffScopes.has('CorsConfiguration')).toBe(true);
  });

  it('deliversWholeBlob refuses a deleted-from binding, handing it to the bounded path', () => {
    // Before #1475 this shape registered a FULL hand-off (spread-only literal
    // through a binding) and the delete was silently ignored — the exclusion
    // fence never fired. Now the full path refuses and the bounded
    // registration carries the exclusion.
    const evidence = evidenceOf(`
      class P {
        async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
          const vc = { ...(properties['ViewerCertificate'] as Record<string, unknown>) };
          delete vc['AcmCertificateArn'];
          await this.send({ ViewerCertificate: vc });
        }
      }
    `);
    expect(evidence.handoffScopes.has('ViewerCertificate')).toBe(true);
    expect([...(evidence.handoffExclusions?.get('ViewerCertificate') ?? [])]).toEqual([
      'acmcertificatearn',
    ]);
  });

  it('an excluded key is not delivered whole, while its un-excluded sibling is', () => {
    // The spread-and-patch exclusion as the shape pass consumes it: a member the
    // converter `delete`s is re-shaped by hand, so the spread must not count as
    // delivering it.
    const evidence: ProviderWriteEvidence = {
      scopes: new Map([['DistributionConfig', new Set<string>()]]),
      handoffScopes: new Set(['DistributionConfig']),
      handoffExclusions: new Map([['DistributionConfig', new Set(['ipv6enabled'])]]),
    };
    const whole = wholeDeliveredPathsFor(
      exactTarget,
      keyPaths('DistributionConfig', 'IPV6Enabled', 'PriceClass'),
      new Set(['IPV6Enabled', 'PriceClass']),
      evidence
    );
    expect([...whole]).toEqual(['DistributionConfig.PriceClass']);
  });
});

describe('reachableSdkMemberNames + hand-off credit bounding (issues #1445 / #1464)', () => {
  const interfaces = new Map<string, Map<string, SdkMemberType>>([
    [
      'ContainerDefinition',
      new Map<string, SdkMemberType>([
        ['name', { kind: 'scalar' }],
        ['linuxParameters', { kind: 'ref', refName: 'LinuxParameters' }],
        // A SIBLING sub-blob the provider re-shapes per member. Reachable from
        // `ContainerDefinition` but NOT from `linuxParameters`, which is what
        // makes the anti-wildcard assertion below non-vacuous.
        ['portMappings', { kind: 'array', refName: 'PortMapping' }],
      ]),
    ],
    [
      'PortMapping',
      new Map<string, SdkMemberType>([
        ['containerPort', { kind: 'scalar' }],
        ['containerPortRange', { kind: 'scalar' }],
      ]),
    ],
    [
      'LinuxParameters',
      new Map<string, SdkMemberType>([
        ['capabilities', { kind: 'ref', refName: 'KernelCapabilities' }],
        ['tmpfs', { kind: 'array', refName: 'Tmpfs' }],
        ['swappiness', { kind: 'scalar' }],
      ]),
    ],
    [
      'KernelCapabilities',
      new Map<string, SdkMemberType>([
        ['add', { kind: 'array' }],
        ['drop', { kind: 'array' }],
      ]),
    ],
    [
      'Tmpfs',
      new Map<string, SdkMemberType>([
        ['containerPath', { kind: 'scalar' }],
        ['mountOptions', { kind: 'array' }],
      ]),
    ],
  ]);

  it('walks ref AND array-element edges transitively', () => {
    expect([...reachableSdkMemberNames('linuxParameters', interfaces)].sort()).toEqual([
      'add',
      'capabilities',
      'containerPath',
      'drop',
      'mountOptions',
      'swappiness',
      'tmpfs',
    ]);
  });

  it('expands a SCALAR member to nothing at all', () => {
    // Why bound (5) is inert: a converter that returns a scalar credits only the
    // name that was already a recorded write.
    expect(reachableSdkMemberNames('swappiness', interfaces).size).toBe(0);
  });

  it('survives a reference cycle', () => {
    const cyclic = new Map<string, Map<string, SdkMemberType>>([
      ['Holder', new Map<string, SdkMemberType>([['node', { kind: 'ref', refName: 'Node' }]])],
      [
        'Node',
        new Map<string, SdkMemberType>([
          ['child', { kind: 'ref', refName: 'Node' }],
          ['leaf', { kind: 'scalar' }],
        ]),
      ],
    ]);
    expect([...reachableSdkMemberNames('node', cyclic).values()].sort()).toEqual([
      'child',
      'leaf',
    ]);
  });

  it('bounds the hand-off credit to the blob, by PATH PREFIX (#1464)', () => {
    // The #1445 fold through the SDK model is gone; the credit is now a prefix
    // test over the write path. Same guard, stated in the new unit:
    // `containerDefinitions` as a whole is NOT wildcarded, so the SIBLING
    // `portMappings.containerPortRange` (the drop issue #1472 tracks) keeps
    // having to prove itself.
    const handoffScopes = new Set(['containerDefinitions.linuxParameters']);
    const split = (path: string): [string, string] => [
      path.slice(0, path.lastIndexOf('.')),
      path.slice(path.lastIndexOf('.') + 1),
    ];
    for (const covered of [
      'containerDefinitions.linuxParameters',
      'containerDefinitions.linuxParameters.capabilities',
      'containerDefinitions.linuxParameters.capabilities.add',
      'containerDefinitions.linuxParameters.tmpfs.mountOptions',
    ]) {
      expect(isHandoffCovered(handoffScopes, ...split(covered)), covered).toBe(true);
    }
    for (const uncovered of [
      'containerDefinitions',
      'containerDefinitions.name',
      'containerDefinitions.portMappings.containerPortRange',
      // A PREFIX that is not a path SEGMENT boundary must not match.
      'containerDefinitions.linuxParametersExtra.add',
    ]) {
      expect(isHandoffCovered(handoffScopes, ...split(uncovered)), uncovered).toBe(false);
    }
    // The TERMINAL of a SELF hand-off is compared VERBATIM, unlike the parent
    // chain — a wildcard spelled `…CORSRules.ID` must not vouch for `….Id`.
    const cased = new Set(['corsConfiguration.CORSRules.ID']);
    expect(isHandoffCovered(cased, 'corsConfiguration.CorsRules', 'ID')).toBe(true);
    expect(isHandoffCovered(cased, 'corsConfiguration.CorsRules', 'Id')).toBe(false);
    // ...while an ANCESTOR hand-off delivers whatever is beneath it, so the
    // chain's own casing is still folded (there is no written terminal to
    // compare against in that case).
    const ancestor = new Set(['corsConfiguration.CORSRules']);
    expect(isHandoffCovered(ancestor, 'corsConfiguration.CorsRules', 'Id')).toBe(true);
    // Sanity: the SDK model WOULD have reached the sibling one level up, so the
    // assertions above are about the BOUNDING, not about a name being absent.
    expect(reachableSdkMemberNames('portMappings', interfaces).has('containerPortRange'))
      .toBe(true);
  });

  it('counts only BLOB-CARRYING hand-off points, not inert scalar forwards', () => {
    // Why `minHandoffPoints` counts expanding points: a raw count is dominated
    // by scalar forwards that can never clear an audited path.
    const evidence: ProviderWriteEvidence = {
      scopes: new Map(),
      handoffScopes: new Set([
        'containerDefinitions.linuxParameters',
        'containerDefinitions.name',
        'containerDefinitions.swappiness',
      ]),
    };
    expect(countExpandingHandoffPoints(evidence, interfaces)).toBe(1);
  });

  it('counts zero when the provider hands nothing off', () => {
    const evidence: ProviderWriteEvidence = {
      scopes: new Map([['a', new Set(['b'])]]),
      handoffScopes: new Set(),
    };
    expect(countExpandingHandoffPoints(evidence, interfaces)).toBe(0);
  });
});

describe('wholeDeliveredPathsFor: segmentRenames (synthetic)', () => {
  it('segmentRenames resolves an intermediate segment for the hand-off mapping (#1464)', () => {
    // The real shape: CFn `ProxyConfiguration.ProxyConfigurationProperties` is
    // the SDK's `ProxyConfiguration.properties`. Case-folding cannot bridge a
    // rename, so without the map a hand-off recorded at the SDK spelling never
    // reaches the CFn path beneath it.
    const paths = keyPaths('ProxyConfiguration', 'ProxyConfigurationProperties.Name');
    const evidence = writeEvidence(
      { ProxyConfiguration: ['properties'], 'ProxyConfiguration.properties': [] },
      ['ProxyConfiguration.properties']
    );
    expect([...wholeDeliveredPathsFor(exactTarget, paths, new Set(['Name']), evidence)]).toEqual(
      []
    );
    const renamed: NestedKeyTarget = {
      ...exactTarget,
      segmentRenames: { ProxyConfigurationProperties: 'properties' },
    };
    const used = new Set<string>();
    expect([
      ...wholeDeliveredPathsFor(renamed, paths, new Set(['Name']), evidence, used),
    ]).toEqual(['ProxyConfiguration.ProxyConfigurationProperties.Name']);
    expect([...used]).toEqual(['ProxyConfigurationProperties']);
  });

  it('segmentRenames NEVER applies to the terminal segment (#1464)', () => {
    // The terminal IS the delivered member: renaming it would let the map pick
    // which SDK member a forward carries. With `Name` absent from the SDK and
    // only the rename's target present, a terminal rename would credit the
    // path; it must not, and the entry must not be recorded as used.
    const target: NestedKeyTarget = { ...exactTarget, segmentRenames: { Name: 'properties' } };
    const evidence = writeEvidence({ Top: [] }, ['Top']);
    const used = new Set<string>();
    expect([
      ...wholeDeliveredPathsFor(target, keyPaths('Top', 'Name'), new Set(['properties']), evidence, used),
    ]).toEqual([]);
    expect([...used]).toEqual([]);
    // Control: the same hand-off DOES deliver the path when the SDK spells the
    // terminal as CFn does, so the empty result above is about the rename.
    expect([
      ...wholeDeliveredPathsFor(target, keyPaths('Top', 'Name'), new Set(['Name']), evidence),
    ]).toEqual(['Top.Name']);
  });

  it('a segmentRename whose UN-RENAMED chain resolves is reported unused (#1464)', () => {
    // The staleness fence's input. An entry goes unused exactly when the
    // un-renamed chain resolves — the SDK renamed the member back and the map
    // is now redundant — so `findStaleSegmentRenames` forces its removal.
    const target: NestedKeyTarget = {
      ...exactTarget,
      segmentRenames: { Middle: 'renamedMiddle' },
    };
    const used = new Set<string>();
    wholeDeliveredPathsFor(
      target,
      keyPaths('Top', 'Middle.Leaf'),
      new Set(['Leaf']),
      writeEvidence({ Top: ['Middle'], 'Top.Middle': ['Leaf'] }),
      used
    );
    expect([...used]).toEqual([]);
  });

  it('a segmentRename stays USED when neither chain resolves (#1464)', () => {
    // With the provider writing only the renamed spelling (or nothing at all),
    // the entry is still the right bridge — a stale-map error here would stand
    // in front of whatever the provider actually stopped doing.
    const target: NestedKeyTarget = {
      ...exactTarget,
      segmentRenames: { Middle: 'renamedMiddle' },
    };
    const used = new Set<string>();
    wholeDeliveredPathsFor(
      target,
      keyPaths('Top', 'Middle.Leaf'),
      new Set(['Leaf']),
      writeEvidence({ Top: ['renamedMiddle'], 'Top.renamedMiddle': [] }),
      used
    );
    expect([...used]).toEqual(['Middle']);
  });

  it('findStaleSegmentRenames reports the entry no path needed', () => {
    const target: NestedKeyTarget = {
      ...exactTarget,
      resourceType: 'AWS::Fake::Thing',
      segmentRenames: { Middle: 'renamedMiddle', Gone: 'nope' },
    };
    const report = buildReport([targetReport({ usedSegmentRenames: ['Middle'] })]);
    expect(findStaleSegmentRenames(report, [target])).toEqual(['AWS::Fake::Thing#Gone']);
  });

  it('a SCOPED segmentRenames key applies only under its declared parent (#1540)', () => {
    // Two families share a segment NAME (`Rules`); only the one under `S3Key`
    // is renamed. A bare-name entry would corrupt the lifecycle chain — the
    // collision class that blocked the notification renames until scoping.
    const target: NestedKeyTarget = {
      ...exactTarget,
      segmentRenames: { 'S3Key.Rules': 'FilterRules' },
    };
    const evidence = writeEvidence(
      {
        Top: ['S3Key', 'Lifecycle'],
        'Top.S3Key': ['FilterRules'],
        'Top.S3Key.FilterRules': ['Name'],
        'Top.Lifecycle': ['Rules'],
        'Top.Lifecycle.Rules': ['Name'],
      },
      ['Top.S3Key.FilterRules', 'Top.Lifecycle.Rules']
    );
    const used = new Set<string>();
    expect([
      ...wholeDeliveredPathsFor(target, keyPaths('Top', 'S3Key.Rules.Name'), new Set(['Name']), evidence, used),
    ]).toEqual(['Top.S3Key.Rules.Name']);
    expect([...used]).toEqual(['S3Key.Rules']);
    // The same-named `Rules` under a DIFFERENT parent is untouched: the scoped
    // key does not match there, so the plain chain maps onto its own hand-off
    // and the used set stays empty.
    const usedElsewhere = new Set<string>();
    expect([
      ...wholeDeliveredPathsFor(
        target,
        keyPaths('Top', 'Lifecycle.Rules.Name'),
        new Set(['Name']),
        evidence,
        usedElsewhere
      ),
    ]).toEqual(['Top.Lifecycle.Rules.Name']);
    expect([...usedElsewhere]).toEqual([]);
  });

  it('a SCOPED segmentRenames key WINS over a bare-name entry for the same segment (#1540)', () => {
    const target: NestedKeyTarget = {
      ...exactTarget,
      segmentRenames: { Middle: 'bareTarget', 'Top.Middle': 'scopedTarget' },
    };
    const used = new Set<string>();
    const whole = wholeDeliveredPathsFor(
      target,
      keyPaths('Top', 'Middle.Leaf'),
      new Set(['Leaf']),
      writeEvidence({ Top: ['scopedTarget'], 'Top.scopedTarget': [] }, ['Top.scopedTarget']),
      used
    );
    expect([...whole]).toEqual(['Top.Middle.Leaf']);
    expect([...used]).toEqual(['Top.Middle']);
  });

  it('lowerFirst flips only the first character', () => {
    expect(lowerFirst('MaximumPercent')).toBe('maximumPercent');
    expect(lowerFirst('')).toBe('');
  });
});

describe('collectStringLiterals', () => {
  it('skips the reverse map body (#1448 comment item 2)', () => {
    const source = `
      class P {
        map(p) { return { forward: p['ForwardOnly'] }; }
        readCurrentStateStage() { const r = {}; r['ReadOnlyKey'] = 1; return r; }
      }
    `;
    expect(collectStringLiterals(source).has('ForwardOnly')).toBe(true);
    expect(collectStringLiterals(source).has('ReadOnlyKey')).toBe(false);
    // With no exclusion set the same literal IS collected — proving the
    // exclusion, not an unrelated parse miss, is what withdraws it.
    expect(collectStringLiterals(source, 'p.ts', []).has('ReadOnlyKey')).toBe(true);
  });

  it('collects string literals, object-literal property names, and template literals — not comments', () => {
    const literals = collectStringLiterals(`
      // AcmCommentOnly should not count
      const MAP = { AcmCertificateArn: 'ACMCertificateArn' };
      const x = obj['OriginSSLProtocols'];
      const t = \`IPV6Enabled\`;
    `);
    expect(literals.has('AcmCertificateArn')).toBe(true);
    expect(literals.has('ACMCertificateArn')).toBe(true);
    expect(literals.has('OriginSSLProtocols')).toBe(true);
    expect(literals.has('IPV6Enabled')).toBe(true);
    expect(literals.has('AcmCommentOnly')).toBe(false);
  });
});

describe('extractNestedPropertyNames (fixture capture)', () => {
  it('walks properties, $refs (cycle-guarded), items, and combinators', () => {
    const schema = JSON.stringify({
      properties: {
        Config: { $ref: '#/definitions/Config' },
        Scalar: { type: 'string' },
        List: { type: 'array', items: { properties: { Entry: { type: 'string' } } } },
      },
      definitions: {
        Config: {
          properties: {
            Name: { type: 'string' },
            Self: { $ref: '#/definitions/Config' },
            Choice: { oneOf: [{ properties: { OptionA: { type: 'string' } } }] },
          },
        },
      },
    });
    const nested = extractNestedPropertyNames(schema);
    expect(nested['Config']).toEqual(['Choice', 'Name', 'OptionA', 'Self']);
    expect(nested['List']).toEqual(['Entry']);
    // Scalar top-levels with no nested names get NO entry (fixture stays small).
    expect(nested['Scalar']).toBeUndefined();
  });
});

describe('extractNestedPropertyPaths (fixture capture, issue #1464)', () => {
  const schema = JSON.stringify({
    properties: {
      Config: { $ref: '#/definitions/Config' },
      Scalar: { type: 'string' },
      List: { type: 'array', items: { properties: { Entry: { type: 'string' } } } },
    },
    definitions: {
      Config: {
        properties: {
          Name: { type: 'string' },
          Self: { $ref: '#/definitions/Config' },
          Choice: { oneOf: [{ properties: { OptionA: { type: 'string' } } }] },
        },
      },
    },
  });

  it('keeps the full chain where the flattened capture keeps only names', () => {
    const paths = extractNestedPropertyPaths(schema);
    // `Config` is ALREADY on the branch when `Self` re-references it, so the
    // ancestor guard stops there — `Self` is recorded, its interior is not.
    // Without the guard this call never returns.
    expect(paths['Config']).toEqual(['Choice', 'Choice.OptionA', 'Name', 'Self']);
    // Arrays are TRANSPARENT — no `[]` marker, matching the write side.
    expect(paths['List']).toEqual(['Entry']);
    expect(paths['Scalar']).toBeUndefined();
  });

  it('re-visits a definition reached down TWO sibling branches', () => {
    // The flattened capture shares one `seenRefs` set per top-level, so a
    // definition referenced twice contributes once — harmless for names,
    // lossy for paths.
    const shared = JSON.stringify({
      properties: {
        Top: {
          properties: {
            Left: { $ref: '#/definitions/Leaf' },
            Right: { $ref: '#/definitions/Leaf' },
          },
        },
      },
      definitions: { Leaf: { properties: { Value: { type: 'string' } } } },
    });
    expect(extractNestedPropertyPaths(shared)['Top']).toEqual([
      'Left',
      'Left.Value',
      'Right',
      'Right.Value',
    ]);
    // ...where the flattened capture reports `Value` once, with no chain.
    expect(extractNestedPropertyNames(shared)['Top']).toEqual(['Left', 'Right', 'Value']);
  });

  it('walks patternProperties, additionalProperties, anyOf and allOf', () => {
    // Floor per input SHAPE: the walk CLAIMS these four containers, and the
    // headline probe above only exercises `properties` / `$ref` / array `items`
    // / `oneOf`. A container silently dropped from the walk is a capture that
    // under-reports, i.e. a bucket that goes quiet for the wrong reason.
    const shaped = JSON.stringify({
      properties: {
        Pattern: { patternProperties: { '^x-': { properties: { Inner: { type: 'string' } } } } },
        Map: { additionalProperties: { properties: { Value: { type: 'string' } } } },
        Any: { anyOf: [{ properties: { FromAny: { type: 'string' } } }] },
        All: { allOf: [{ properties: { FromAll: { type: 'string' } } }] },
      },
    });
    const paths = extractNestedPropertyPaths(shaped);
    // A `patternProperties` KEY is a regex, not a property name — only the
    // value schema's members are captured.
    expect(paths['Pattern']).toEqual(['Inner']);
    expect(paths['Map']).toEqual(['Value']);
    expect(paths['Any']).toEqual(['FromAny']);
    expect(paths['All']).toEqual(['FromAll']);
  });

  it('throws a NAMED error on a diamond-shaped definition graph', () => {
    // Per-branch ancestry is right for paths and drops the flattened walk's
    // linear bound: a diamond is 2^k paths. Measured at k=18: 786,430 paths in
    // about a second, and `processType` runs this for EVERY refreshed type — so
    // an AWS schema of that shape would hang the refresher and emit a
    // multi-megabyte fixture. The cap must fail LOUDLY and name the type.
    const definitions: Record<string, unknown> = {};
    const depth = 18;
    for (let i = 0; i < depth; i++) {
      definitions[`D${i}`] = {
        properties: {
          L: { $ref: `#/definitions/D${i + 1}` },
          R: { $ref: `#/definitions/D${i + 1}` },
        },
      };
    }
    definitions[`D${depth}`] = { properties: { Leaf: { type: 'string' } } };
    const diamond = JSON.stringify({
      properties: { Top: { $ref: '#/definitions/D0' } },
      definitions,
    });
    expect(() => extractNestedPropertyPaths(diamond, 'AWS::Fake::Diamond')).toThrow(
      /AWS::Fake::Diamond: nested path capture for "Top" exceeded/
    );
  });

  it('every flattened name reappears as a PATH terminal under the same top-level', () => {
    // The consistency fence between the two committed captures. Nothing else
    // ties them together, so a partially re-captured (or hand-edited) fixture
    // tree — the exact failure mode a targeted refresh can leave behind — would
    // otherwise pass every check while the critic audits a stale interior.
    // ONE-DIRECTIONAL on purpose: paths legitimately outnumber names (a name
    // reachable down two branches is two paths), so the reverse would fail.
    for (const file of readdirSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas'))) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const fixture = JSON.parse(
        readFileSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas', file), 'utf8')
      ) as {
        nestedProperties?: Record<string, string[]>;
        nestedPropertyPaths?: Record<string, string[]>;
      };
      if (fixture.nestedPropertyPaths === undefined) continue; // not re-captured yet
      for (const [top, names] of Object.entries(fixture.nestedProperties ?? {})) {
        const terminals = new Set(
          (fixture.nestedPropertyPaths[top] ?? []).map((p) => p.slice(p.lastIndexOf('.') + 1))
        );
        for (const name of names) {
          expect(terminals.has(name), `${file} ${top}.${name}`).toBe(true);
        }
      }
    }
  });

  it('every audited fixture carries the capture the critic reads', () => {
    // A missing capture is a LOUD failure in `loadReport`, but only for a target
    // whose `minNestedKeys` is non-zero — this makes the whole audited set an
    // assertion, so a partially re-captured fixture tree cannot slip through.
    for (const target of NESTED_KEY_TARGETS) {
      const fixture = JSON.parse(
        readFileSync(
          resolve(
            repoRoot,
            `tests/fixtures/cfn-schemas/${target.resourceType.replace(/::/g, '-')}.json`
          ),
          'utf8'
        )
      ) as { nestedPropertyPaths?: Record<string, string[]> };
      expect(fixture.nestedPropertyPaths, target.resourceType).toBeDefined();
    }
  });
});

describe('nestedKeyPathsForTarget', () => {
  it('yields one PATH per (handled top-level, nested chain) pair (#1448)', () => {
    const fixture = {
      nestedPropertyPaths: {
        Handled: ['A', 'B'],
        AlsoHandled: ['B', 'C'],
        Unhandled: ['D'],
      },
    };
    const paths = nestedKeyPathsForTarget(fixture, new Set(['Handled', 'AlsoHandled']));
    // `B` is reachable beneath BOTH handled top-levels, and the two are now
    // DIFFERENT audited units — the de-duplication that collapsed them is
    // exactly what let one write vouch for the other.
    expect(paths.map((p) => p.path)).toEqual([
      'AlsoHandled.B',
      'AlsoHandled.C',
      'Handled.A',
      'Handled.B',
    ]);
    expect(paths.map((p) => p.topLevelProperty)).toEqual([
      'AlsoHandled',
      'AlsoHandled',
      'Handled',
      'Handled',
    ]);
  });

  it('keeps the FULL chain, and the terminal name as the key (#1464)', () => {
    // The whole point of the per-PATH capture: two same-named members at
    // different depths of ONE top-level stay distinct audited units.
    const paths = nestedKeyPathsForTarget(
      { nestedPropertyPaths: { Environment: ['Type', 'EnvironmentVariables', 'EnvironmentVariables.Type'] } },
      new Set(['Environment'])
    );
    expect(paths.map((p) => p.path)).toEqual([
      'Environment.EnvironmentVariables',
      'Environment.EnvironmentVariables.Type',
      'Environment.Type',
    ]);
    expect(paths.map((p) => p.key)).toEqual(['EnvironmentVariables', 'Type', 'Type']);
    expect(paths.map((p) => p.segments)).toEqual([
      ['Environment', 'EnvironmentVariables'],
      ['Environment', 'EnvironmentVariables', 'Type'],
      ['Environment', 'Type'],
    ]);
    // Every chain stays rooted at its top-level, which is what the write-side
    // parent lookup is built from.
    expect(new Set(paths.map((p) => p.topLevelProperty))).toEqual(new Set(['Environment']));
  });

  it('de-duplicates a repeated chain within one top-level', () => {
    const paths = nestedKeyPathsForTarget(
      { nestedPropertyPaths: { Handled: ['A', 'A'] } },
      new Set(['Handled'])
    );
    expect(paths.map((p) => p.path)).toEqual(['Handled.A']);
  });

  it('reads nestedPropertyPaths, NOT the flattened nestedProperties (#1464)', () => {
    // The flattened capture is still emitted for the shape pass and the floor
    // calibration story; consulting it here would silently restore the bug.
    expect(
      nestedKeyPathsForTarget(
        { nestedProperties: { Handled: ['A'] } } as { nestedPropertyPaths?: Record<string, string[]> },
        new Set(['Handled'])
      )
    ).toEqual([]);
  });
});

describe('report plumbing (positive direction)', () => {
  // The clean-repo assertions below prove the green path; these prove the
  // RED path actually reaches the report — a filter regression here would
  // make `--check` vacuously green while every other test stays passing.
  const sdkMembers = new Set(['ACMCertificateArn', 'Comment']);

  it('findStaleAllowListEntries returns an entry that matches no allow-listed shape verdict', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'UsedKey'), { rationale: 'kept' }],
      [allowKey('AWS::Fake::Thing', 'GoneKey'), { rationale: 'obsolete' }],
    ]);
    const report = buildReport([
      targetReport({
        shapeEntries: [
          {
            resourceType: exactTarget.resourceType,
            nestedKey: 'UsedKey',
            definition: 'Config',
            pass: 'definition',
            bucket: 'allow-listed',
            rationale: 'kept',
            allowMatchKey: allowKey('AWS::Fake::Thing', 'UsedKey'),
          },
        ],
      }),
    ]);
    expect(findStaleAllowListEntries(report, allow)).toEqual(['AWS::Fake::Thing#GoneKey']);
  });

  it('findDivergences surfaces both SHAPE blocking buckets through buildReport (#1378)', () => {
    const report = buildReport([
      targetReport({
        nestedKeyCount: 3,
        wholeDeliveredPaths: ['Top.A', 'Top.B'],
        shapeEntries: [
          {
            resourceType: exactTarget.resourceType,
            nestedKey: 'WrappedList',
            definition: 'Config',
            pass: 'wrapper',
            bucket: 'array-vs-wrapper',
            sdkDetail: 'SDK wraps it as `WrappedList` ({ Quantity, Items })',
          },
          {
            resourceType: exactTarget.resourceType,
            nestedKey: 'MovedMember',
            definition: 'Config',
            pass: 'definition',
            bucket: 'definition-member-missing',
          },
          // Visible but NON-blocking: must not reach findDivergences.
          {
            resourceType: exactTarget.resourceType,
            nestedKey: 'Mixed',
            definition: 'Config',
            pass: 'wrapper',
            bucket: 'ambiguous',
          },
        ],
      }),
    ]);
    expect(findDivergences(report).map((d) => [d.nestedKey, d.bucket])).toEqual([
      ['WrappedList', 'array-vs-wrapper'],
      ['MovedMember', 'definition-member-missing'],
    ]);
    expect(report.summary.arrayVsWrapper).toBe(1);
    expect(report.summary.definitionMemberMissing).toBe(1);
    expect(report.summary.shapeAmbiguous).toBe(1);
    expect(report.summary.wholeDeliveredPathCount).toBe(2);
    expect(report.summary.nestedKeyCount).toBe(3);
  });
});

describe('loadReport loud-failure fences', () => {
  const realTarget = NESTED_KEY_TARGETS[0]!;

  it('throws on a target whose fixture is missing', () => {
    expect(() =>
      loadReport([{ ...realTarget, resourceType: 'AWS::NoSuch::Type', minNestedKeys: 1 }])
    ).toThrow(/missing CFn schema fixture/);
  });

  it('throws when the nested-key yield falls below the per-target floor', () => {
    expect(() => loadReport([{ ...realTarget, minNestedKeys: 100000 }])).toThrow(
      /fixture capture or handledProperties regression/
    );
  });

  it('throws on a fixture without a definitionShapes capture (#1378)', () => {
    // This probe used to pick a STAND-IN dynamically from the committed tree,
    // because most fixtures predated the shape capture. That day the old
    // comment predicted has arrived: issue #1800's full re-capture gave every
    // fixture a `definitionShapes` section (`#top` is always present, so the
    // field only stays out for a schema with no properties at all), leaving
    // the probe with nothing to select and failing with its own
    // "no pre-shape-capture fixture left" message.
    //
    // The prescribed fix was to add a fixture-dir seam. One already exists —
    // `loadReport`'s fourth parameter, added by #1464 for the sibling
    // `nestedPropertyPaths` fence — so the probe now builds its own partially
    // captured tree instead of depending on the committed tree's history. That
    // also makes it immune to the next re-capture, which is the property the
    // dynamic pick was reaching for and could not actually hold.
    //
    // A `minNestedKeys: 0` target passes the nestedProperties gate and must
    // still fail loudly on the missing definitionShapes.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'cdkd-nkc-shapes-'));
    try {
      cpSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas'), fixtureDir, { recursive: true });
      const path = join(fixtureDir, 'AWS-CodeBuild-Project.json');
      const fixture = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      // Non-vacuity: the deletion only proves anything if the section WAS
      // there. A committed fixture that had already lost it would make this
      // probe pass for the wrong reason.
      expect(fixture['definitionShapes'], 'fixture had no definitionShapes to remove').toBeDefined();
      delete fixture['definitionShapes'];
      writeFileSync(path, JSON.stringify(fixture, null, 2));

      expect(() =>
        loadReport(
          [{ ...realTarget, resourceType: 'AWS::CodeBuild::Project', minNestedKeys: 0 }],
          undefined,
          undefined,
          fixtureDir
        )
      ).toThrow(/definitionShapes/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('fires the SDK MEMBER-parse floor on a collapsed model dir (red direction)', () => {
    // A models dir whose lone .d.ts declares almost nothing: both parses
    // collapse; the member floor (checked first) must fire.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-nkc-members-'));
    writeFileSync(join(dir, 'models_0.d.ts'), 'export interface A { M1?: string; }\n');
    try {
      expect(() => loadReport([realTarget], () => dir)).toThrow(
        /SDK member parse .* collapsed/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fires the SDK INTERFACE-parse floor when only the interface visitor collapses (red direction)', () => {
    // PropertySignatures inside a TYPE LITERAL are counted by
    // collectSdkMemberNames but NOT by collectSdkInterfaces — the two are
    // separate visitors, so this shape passes the member floor while the
    // interface floor must fire (a regression in the interface visitor
    // alone would otherwise leave the shape pass vacuously green).
    const members = Array.from({ length: 60 }, (_, i) => `M${i}?: string;`).join(' ');
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-nkc-ifaces-'));
    writeFileSync(join(dir, 'models_0.d.ts'), `export type Blob = { ${members} };\n`);
    try {
      expect(() => loadReport([realTarget], () => dir)).toThrow(
        /SDK interface parse .* collapsed/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fires the write-SCOPE floor (red direction, #1448)', () => {
    // Red direction for the floor `findStaleSegmentRenames` leans on. Reaching
    // it through `--providers-dir=` would need a synthetic provider file, which
    // proves less than the collector-level scenario test below (`a collapsed
    // scope index still records every written name`).
    const td = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::ECS::TaskDefinition')!;
    expect(td.minWriteScopes, 'the probed target declares the floor').toBeDefined();
    expect(() => loadReport([{ ...td, minWriteScopes: 100_000 }])).toThrow(
      /write-scope resolution .* collapsed/
    );
  });

  it('fires the hand-off floor (red direction, #1445)', () => {
    const svc = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::ECS::Service')!;
    expect(() => loadReport([{ ...svc, minHandoffPoints: 100_000 }])).toThrow(
      /whole-blob hand-off walk .* collapsed/
    );
  });

  it('throws when the provider declares no handledProperties for the target type', () => {
    expect(() =>
      loadReport([
        { ...realTarget, resourceType: 'AWS::CloudWatch::AnomalyDetector', minNestedKeys: 0 },
      ])
    ).toThrow(/declares no handledProperties/);
  });
});

describe('shape pass (synthetic)', () => {
  const iface = (members: Record<string, SdkMemberType>): Map<string, SdkMemberType> =>
    new Map(Object.entries(members));
  const sdk = new Map<string, Map<string, SdkMemberType>>([
    // Wrapper interface (has Quantity).
    ['Aliases', iface({ Quantity: { kind: 'scalar' }, Items: { kind: 'array' } })],
    [
      'DistributionConfig',
      iface({ Aliases: { kind: 'ref', refName: 'Aliases' }, Comment: { kind: 'scalar' } }),
    ],
    [
      'AllowedMethods',
      iface({
        Quantity: { kind: 'scalar' },
        Items: { kind: 'array' },
        CachedMethods: { kind: 'ref', refName: 'CachedMethods' },
      }),
    ],
    ['CachedMethods', iface({ Quantity: { kind: 'scalar' }, Items: { kind: 'array' } })],
    [
      'CacheBehavior',
      iface({ AllowedMethods: { kind: 'ref', refName: 'AllowedMethods' } }),
    ],
    ['Other', iface({ BareList: { kind: 'array' } })],
  ]);

  it('flags a CFn bare array whose only SDK members are wrapper refs', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { DistributionConfig: { Aliases: 'array' } },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.entries).toEqual([
      {
        resourceType: exactTarget.resourceType,
        nestedKey: 'Aliases',
        definition: 'DistributionConfig',
        pass: 'wrapper',
        bucket: 'array-vs-wrapper',
        sdkDetail: 'SDK wraps it as `Aliases` ({ Quantity, Items })',
      },
    ]);
  });

  it('credits a dotted-path literal for shape handling (segment expansion)', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { DistributionConfig: { Aliases: 'array' } },
      sdk,
      new Set(['SomeParent.Aliases']),
      new Map()
    );
    expect(result.entries[0]?.bucket).toBe('provider-handled');
    // Segment expansion is the shape pass's own literal set; the raw set would
    // NOT credit this.
    expect(expandLiteralSegments(new Set(['SomeParent.Aliases'])).has('Aliases')).toBe(true);
  });

  it('segment expansion ignores non-key-path dotted literals (filenames, messages)', () => {
    const expanded = expandLiteralSegments(
      new Set(['index.html', 'some error. Retry later', 'ForwardedValues.Headers'])
    );
    expect(expanded.has('html')).toBe(false);
    expect(expanded.has('Retry later')).toBe(false);
    expect(expanded.has('Headers')).toBe(true);
  });

  it('classifies a mixed CFn shape as ambiguous instead of silently skipping it', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { DistributionConfig: { Aliases: 'mixed' } },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.entries).toEqual([
      {
        resourceType: exactTarget.resourceType,
        nestedKey: 'Aliases',
        definition: 'DistributionConfig',
        pass: 'wrapper',
        bucket: 'ambiguous',
      },
    ]);
  });

  it('counts a bare-array pair as clean when any same-named SDK member is an array', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { Other: { BareList: 'array' } },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.entries).toEqual([]);
    expect(result.cleanCount).toBe(1);
  });

  it('flags a member missing from its same-named SDK interface (sibling-vs-nested)', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { CacheBehavior: { AllowedMethods: 'array', CachedMethods: 'array' } },
      sdk,
      new Set(),
      new Map()
    );
    const definitionEntry = result.entries.find(
      (e) => e.pass === 'definition' && e.nestedKey === 'CachedMethods'
    );
    expect(definitionEntry?.bucket).toBe('definition-member-missing');
    expect(definitionEntry?.sdkDetail).toContain('no `CachedMethods` member');
    // AllowedMethods IS a member of the SDK CacheBehavior — no definition entry.
    expect(
      result.entries.find((e) => e.pass === 'definition' && e.nestedKey === 'AllowedMethods')
    ).toBeUndefined();
  });

  it('skips keys with no same-spelled SDK member anywhere (no interface to ask)', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { DistributionConfig: { NoSuchKeyAnywhere: 'array' } },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.entries).toEqual([]);
    expect(result.cleanCount).toBe(0);
  });

  it('classifies an unjudgeable array pair as ambiguous unless provider-named', () => {
    const oddSdk = new Map([['X', iface({ Tags: { kind: 'ref', refName: 'NotAWrapper' } })]]);
    const ambiguous = classifyTargetShapes(
      exactTarget,
      { '#top': { Tags: 'array' } },
      oddSdk,
      new Set(),
      new Map()
    );
    expect(ambiguous.entries[0]?.bucket).toBe('ambiguous');
    const named = classifyTargetShapes(
      exactTarget,
      { '#top': { Tags: 'array' } },
      oddSdk,
      new Set(['Tags']),
      new Map()
    );
    expect(named.entries[0]?.bucket).toBe('provider-handled');
  });

  it('honors the allow-list for both shape buckets', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'Aliases'), { rationale: 'deliberate' }],
    ]);
    const result = classifyTargetShapes(
      exactTarget,
      { DistributionConfig: { Aliases: 'array' } },
      sdk,
      new Set(),
      allow
    );
    expect(result.entries[0]?.bucket).toBe('allow-listed');
    expect(result.entries[0]?.rationale).toBe('deliberate');
  });

  it('lists definitions with no same-named SDK interface as unmatched', () => {
    const result = classifyTargetShapes(
      exactTarget,
      { LegacyThing: { Comment: 'scalar' } },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.unmatchedDefinitions).toEqual(['LegacyThing']);
  });

  it('wrapper verdicts dedupe per key across definitions', () => {
    const result = classifyTargetShapes(
      exactTarget,
      {
        DistributionConfig: { Aliases: 'array' },
        SomeOtherDef: { Aliases: 'array' },
      },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.entries.filter((e) => e.pass === 'wrapper')).toHaveLength(1);
  });
});

describe('shape pass: a literal does not vouch for a member a generic converter forwards (PR #4324)', () => {
  // `ecs-provider.ts`' shape: `LoadBalancer.AdvancedConfiguration` is a real SDK
  // member the provider names, while `VpcLatticeConfigurations` goes whole
  // through `pascalToCamelCaseKeys` into an SDK interface with no such member.
  const iface = (members: Record<string, SdkMemberType>): Map<string, SdkMemberType> =>
    new Map(Object.entries(members));
  const lowerFirstTarget: NestedKeyTarget = { ...exactTarget, keyStyle: 'lower-first' };
  const sdk = new Map<string, Map<string, SdkMemberType>>([
    [
      'CreateServiceRequest',
      iface({
        loadBalancers: { kind: 'array', refName: 'LoadBalancer' },
        vpcLatticeConfigurations: { kind: 'array', refName: 'VpcLatticeConfiguration' },
        pair: { kind: 'ref', refName: 'Pair' },
      }),
    ],
    ['Pair', iface({ roleArn: { kind: 'scalar' } })],
    [
      'LoadBalancer',
      iface({
        advancedConfiguration: { kind: 'ref', refName: 'AdvancedConfiguration' },
        targetGroupArn: { kind: 'scalar' },
      }),
    ],
    [
      'VpcLatticeConfiguration',
      iface({ roleArn: { kind: 'scalar' }, targetGroupArn: { kind: 'scalar' } }),
    ],
    ['AdvancedConfiguration', iface({ testListenerRule: { kind: 'scalar' } })],
  ]);
  const definitions = {
    LoadBalancer: { AdvancedConfiguration: 'object', TargetGroupArn: 'scalar' },
    VpcLatticeConfiguration: {
      AdvancedConfiguration: 'object',
      RoleArn: 'scalar',
      TargetGroupArn: 'scalar',
    },
  };
  const nestedKeys = [
    ...keyPaths('LoadBalancers', 'AdvancedConfiguration', 'TargetGroupArn'),
    ...keyPaths('VpcLatticeConfigurations', 'AdvancedConfiguration', 'RoleArn', 'TargetGroupArn'),
  ];
  const latticeBucket = (
    defs: Readonly<Record<string, Record<string, string>>>,
    paths: readonly string[] | undefined
  ): string | undefined =>
    classifyTargetShapes(
      lowerFirstTarget,
      defs,
      sdk,
      new Set(['AdvancedConfiguration']),
      new Map(),
      paths === undefined ? undefined : { nestedKeys, paths: new Set(paths) }
    ).entries.find((e) => e.definition === 'VpcLatticeConfiguration')?.bucket;

  it('withdraws the rescue when the definition is handed off whole and another definition explains the literal', () => {
    expect(
      latticeBucket(definitions, ['VpcLatticeConfigurations.AdvancedConfiguration'])
    ).toBe('definition-member-missing');
  });

  it('keeps the rescue without whole-delivery evidence', () => {
    expect(latticeBucket(definitions, undefined)).toBe('provider-handled');
    expect(latticeBucket(definitions, [])).toBe('provider-handled');
  });

  it('keeps the rescue when the whole-delivered path is an instance of ANOTHER definition', () => {
    expect(latticeBucket(definitions, ['LoadBalancers.AdvancedConfiguration'])).toBe(
      'provider-handled'
    );
  });

  it('keeps the rescue when nothing else explains the literal (a relocating converter)', () => {
    const { LoadBalancer: _explainer, ...withoutExplainer } = definitions;
    expect(
      latticeBucket(withoutExplainer, ['VpcLatticeConfigurations.AdvancedConfiguration'])
    ).toBe('provider-handled');
  });

  it('the hand-off rule reports a path whose parent is handed off, never a per-member hand-off', () => {
    // `loadBalancers.advancedConfiguration` is a SELF hand-off (the member
    // itself is the forwarded value): it delivers the member's interior, not
    // the member as an instance of its parent definition, so
    // `LoadBalancers.AdvancedConfiguration` must stay out.
    const whole = wholeDeliveredPathsFor(
      lowerFirstTarget,
      nestedKeys,
      new Set(['advancedConfiguration', 'roleArn', 'targetGroupArn']),
      writeEvidence({ loadBalancers: ['targetGroupArn'] }, [
        'vpcLatticeConfigurations',
        'loadBalancers.advancedConfiguration',
      ])
    );
    expect([...whole].sort()).toEqual([
      'VpcLatticeConfigurations.AdvancedConfiguration',
      'VpcLatticeConfigurations.RoleArn',
      'VpcLatticeConfigurations.TargetGroupArn',
    ]);
  });

  it('the hand-off rule reports a spread-and-patch parent for every member it does not delete', () => {
    const whole = wholeDeliveredPathsFor(
      lowerFirstTarget,
      nestedKeys,
      new Set(['advancedConfiguration', 'roleArn', 'targetGroupArn']),
      {
        ...writeEvidence({ vpcLatticeConfigurations: ['roleArn'] }, ['vpcLatticeConfigurations']),
        handoffExclusions: new Map([['vpcLatticeConfigurations', new Set(['rolearn'])]]),
      }
    );
    expect([...whole].sort()).toEqual([
      'VpcLatticeConfigurations.AdvancedConfiguration',
      'VpcLatticeConfigurations.TargetGroupArn',
    ]);
  });

  it('a smaller definition does not claim a larger definition’s whole-delivered parent', () => {
    // `Pair` fits inside the lattice parent's children, but the parent is an
    // instance of `VpcLatticeConfiguration`, the larger shape it carries whole.
    const withPair = {
      ...definitions,
      Pair: { AdvancedConfiguration: 'object', RoleArn: 'scalar' },
    };
    const pairBucket = classifyTargetShapes(
      lowerFirstTarget,
      withPair,
      sdk,
      new Set(['AdvancedConfiguration']),
      new Map(),
      { nestedKeys, paths: new Set(['VpcLatticeConfigurations.AdvancedConfiguration']) }
    ).entries.find((e) => e.definition === 'Pair')?.bucket;
    expect(pairBucket).toBe('provider-handled');
    expect(
      latticeBucket(withPair, ['VpcLatticeConfigurations.AdvancedConfiguration'])
    ).toBe('definition-member-missing');
  });

  // End to end through `loadReport`, so the PLUMBING is pinned too: the real
  // tree withdraws no rescue today, so a `loadReport` that stopped handing the
  // whole-delivered paths to the shape pass would otherwise stay green.
  describe('through loadReport (synthetic provider, fixture and SDK model)', () => {
    const fakeTarget: NestedKeyTarget = {
      resourceType: 'AWS::Fake::Thing',
      providerFile: 'fake-provider.ts',
      sdkClientPackage: '@aws-sdk/client-fake',
      keyStyle: 'exact',
      minNestedKeys: 3,
    };
    const filler = Array.from({ length: 60 }, (_, i) => `M${i}?: string;`).join(' ');
    const providerSource = (outerWrite: string): string => `
export class FakeProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::Fake::Thing', new Set(['Outer', 'Other'])],
  ]);
  async create(logicalId: string, resourceType: string, properties: Record<string, unknown>) {
    const outer = properties['Outer'] as Record<string, unknown>;
    const other = properties['Other'] as Record<string, unknown>;
    await this.client.send(new CreateThingCommand({ Outer: ${outerWrite}, Other: { Extra: other['Extra'] } }));
  }
}
`;
    const run = (outerWrite: string) => {
      const root = mkdtempSync(join(tmpdir(), 'cdkd-nkc-4324-'));
      try {
        const models = join(root, 'models');
        const fixtures = join(root, 'fixtures');
        const providers = join(root, 'providers');
        for (const d of [models, fixtures, providers]) mkdirSync(d, { recursive: true });
        writeFileSync(
          join(models, 'models_0.d.ts'),
          'export interface CreateThingRequest { Outer?: Outer; Other?: Other; }\n' +
            'export interface Outer { Name?: string; }\n' +
            'export interface Other { Extra?: string; }\n' +
            `export interface Filler { ${filler} }\n`
        );
        writeFileSync(
          join(fixtures, 'AWS-Fake-Thing.json'),
          JSON.stringify({
            nestedPropertyPaths: { Outer: ['Name', 'Extra'], Other: ['Extra'] },
            definitionShapes: {
              Outer: { Name: 'scalar', Extra: 'scalar' },
              Other: { Extra: 'scalar' },
            },
          })
        );
        writeFileSync(join(providers, 'fake-provider.ts'), providerSource(outerWrite));
        const target = loadReport([fakeTarget], () => models, providers, fixtures).targets[0]!;
        return {
          whole: target.wholeDeliveredPaths,
          bucket: target.shapeEntries.find((e) => e.definition === 'Outer' && e.nestedKey === 'Extra')
            ?.bucket,
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it('a verbatim forward of the definition withdraws the literal rescue', () => {
      const { whole, bucket } = run("properties['Outer']");
      expect(whole).toContain('Outer.Extra');
      expect(bucket).toBe('definition-member-missing');
    });

    it('a per-member write keeps the rescue (control)', () => {
      const { whole, bucket } = run("{ Name: outer['Name'], Extra: outer['Extra'] }");
      expect(whole).not.toContain('Outer.Extra');
      expect(bucket).toBe('provider-handled');
    });
  });
});

describe('extractDefinitionShapes (fixture capture)', () => {
  it('classifies members to terminal kinds, resolving refs with a cycle guard', () => {
    const schema = JSON.stringify({
      properties: { Config: { $ref: '#/definitions/Config' }, Name: { type: 'string' } },
      definitions: {
        Config: {
          properties: {
            List: { type: 'array' },
            Nested: { $ref: '#/definitions/Inner' },
            Self: { $ref: '#/definitions/Config' },
            Mixed: { oneOf: [{ type: 'string' }, { type: 'array' }] },
            Agreeing: { oneOf: [{ type: 'string' }, { type: 'string' }] },
            // The map idiom (ECS DockerLabels) — patternProperties only.
            LabelMap: { patternProperties: { '.*': { type: 'string' } } },
            // JSON-Schema array-form type — must surface as mixed, not scalar.
            ArrayFormType: { type: ['array', 'string'] },
          },
        },
        Inner: { type: 'object', properties: { Leaf: { type: 'integer' } } },
        NoProps: { type: 'string' },
      },
    });
    const shapes = extractDefinitionShapes(schema);
    expect(shapes['#top']).toEqual({ Config: 'object', Name: 'scalar' });
    expect(shapes['Config']).toEqual({
      List: 'array',
      Nested: 'object',
      Self: 'object',
      Mixed: 'mixed',
      Agreeing: 'scalar',
      LabelMap: 'object',
      ArrayFormType: 'mixed',
    });
    expect(shapes['Inner']).toEqual({ Leaf: 'scalar' });
    // Definitions with no properties block get no entry.
    expect(shapes['NoProps']).toBeUndefined();
  });
});

describe('extractDefinitionRequired (fixture capture, issue #1800)', () => {
  it('captures each definition required list, sorted, with the top-level under #top', () => {
    const schema = JSON.stringify({
      required: ['Name', 'Cluster'],
      properties: { Name: { type: 'string' }, Config: { $ref: '#/definitions/Config' } },
      definitions: {
        Config: {
          required: ['Rollback', 'Enable'],
          properties: { Enable: { type: 'boolean' }, Rollback: { type: 'boolean' } },
        },
        // No `required` at all — the reachable-partial case #1806 is about.
        Optional: { properties: { StepPercent: { type: 'integer' } } },
        // Present but empty: identical meaning to absent, so identical output.
        EmptyRequired: { required: [], properties: { A: { type: 'string' } } },
        NotAnObject: 'string',
      },
    });

    const required = extractDefinitionRequired(schema);

    expect(required['#top']).toEqual(['Cluster', 'Name']);
    expect(required['Config']).toEqual(['Enable', 'Rollback']);
    // A definition that requires nothing gets NO entry — a consumer must read
    // an absent key as "nothing required here", which is why these are
    // `toBeUndefined()` rather than `toEqual([])`.
    expect(required['Optional']).toBeUndefined();
    expect(required['EmptyRequired']).toBeUndefined();
    expect(required['NotAnObject']).toBeUndefined();
    // And nothing else leaked in — the key set is exactly the two above.
    expect(Object.keys(required).sort()).toEqual(['#top', 'Config']);
  });

  it('returns an empty map for a schema that requires nothing anywhere', () => {
    // Drives the omit-when-empty branch in `processType`: such a type must get
    // no `definitionRequired` section at all rather than an empty object.
    const schema = JSON.stringify({
      properties: { Name: { type: 'string' } },
      definitions: { Inner: { properties: { Leaf: { type: 'string' } } } },
    });

    expect(extractDefinitionRequired(schema)).toEqual({});
  });

  it('does NOT see required-ness expressed by a combinator or an inline nested object', () => {
    // The capture's KNOWN BOUND, pinned so a consumer cannot read a missing
    // entry as proof that CloudFormation requires nothing. Both shapes are
    // real (measured live, us-east-1, 2026-08-13): `AWS::S3::Bucket`'s
    // `TargetObjectKeyFormat` puts its required-ness in `oneOf` arms, and
    // `AWS::WAFv2::WebACL`'s `FieldToMatch.SingleHeader` is an inline object
    // with no definition key to hang an entry on.
    //
    // This test asserts the CURRENT, deliberately-limited behavior. If a
    // future change starts capturing either shape, this test SHOULD fail —
    // that is the signal to update the contract note in
    // `extractDefinitionRequired`'s JSDoc, not to delete the assertion.
    const schema = JSON.stringify({
      properties: { Logging: { $ref: '#/definitions/Logging' } },
      definitions: {
        TargetObjectKeyFormat: {
          oneOf: [{ required: ['SimplePrefix'] }, { required: ['PartitionedPrefix'] }],
          properties: { SimplePrefix: { type: 'object' }, PartitionedPrefix: { type: 'object' } },
        },
        Logging: {
          properties: {
            SingleHeader: { type: 'object', required: ['Name'], properties: { Name: {} } },
          },
        },
      },
    });

    const required = extractDefinitionRequired(schema);

    // Neither shape is captured — the absence here means "no PLAIN required
    // list", NOT "nothing is required".
    expect(required['TargetObjectKeyFormat']).toBeUndefined();
    expect(required['SingleHeader']).toBeUndefined();
    expect(required['Logging']).toBeUndefined();
    expect(required).toEqual({});
  });

  it('ignores non-string members and a non-array required', () => {
    const schema = JSON.stringify({
      required: 'Name',
      definitions: { Mixed: { required: ['Real', 42, null] } },
    });

    const required = extractDefinitionRequired(schema);

    expect(required['#top']).toBeUndefined();
    expect(required['Mixed']).toEqual(['Real']);
  });
});

describe('collectSdkInterfaces (real repo)', () => {
  const interfaces = collectSdkInterfaces(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-cloudfront/dist-types/models')
  );

  it('parses member type kinds from the real CloudFront model', () => {
    const cacheBehavior = interfaces.get('CacheBehavior');
    expect(cacheBehavior?.get('AllowedMethods')).toEqual({
      kind: 'ref',
      refName: 'AllowedMethods',
    });
    expect(cacheBehavior?.get('TargetOriginId')?.kind).toBe('scalar');
  });

  it('carries a map member’s VALUE type, keeping `refName` the member’s own', () => {
    // Real anchor rather than a synthetic one: apigatewayv2 declares
    // `RequestParameters?: Record<string, ParameterConstraints>`, and
    // `ParameterConstraints` hangs off a request through NOTHING else — so
    // `inputReachableInterfaces` reaches it only across this edge.
    // Pins live `@aws-sdk/client-apigatewayv2` typings: a rename of
    // `ParameterConstraints`, or a codegen switch to an index signature
    // (a `TypeLiteralNode`, which classifies `scalar`), reds this case on an
    // SDK bump rather than on a generator defect.
    const apigw = collectSdkInterfaces(
      resolve(repoRoot, 'node_modules/@aws-sdk/client-apigatewayv2/dist-types/models')
    );
    expect(apigw.get('CreateRouteRequest')?.get('RequestParameters')).toEqual({
      kind: 'ref',
      refName: 'Record',
      valueRefName: 'ParameterConstraints',
    });
    // `refName` stays the member's OWN type name: the shape pass reads it to
    // decide wrapper-ness, and overwriting it with the value type would make it
    // read a wrapper's name for a member that is not one.
    expect(inputReachableInterfaces(apigw).has('ParameterConstraints')).toBe(true);
  });

  it('detects the { Quantity, Items } wrapper interfaces', () => {
    const wrappers = wrapperInterfaceNames(interfaces);
    for (const name of ['Aliases', 'Origins', 'AllowedMethods', 'CachedMethods']) {
      expect(wrappers.has(name), name).toBe(true);
    }
    expect(wrappers.has('CacheBehavior')).toBe(false);
  });
});

describe('real-repo audit (regression floors)', () => {
  const report = loadReport();

  it('reports zero blocking divergences', () => {
    expect(findDivergences(report)).toEqual([]);
  });

  it('has no stale allow-list entries', () => {
    expect(findStaleAllowListEntries(report)).toEqual([]);
  });

  it('audits the CloudFront target with a healthy nested-key count', () => {
    const cf = report.targets.find((t) => t.resourceType === 'AWS::CloudFront::Distribution');
    expect(cf).toBeDefined();
    expect(cf!.nestedKeyCount).toBeGreaterThanOrEqual(100);
  });

  it('audits the S3 Bucket target with a healthy nested-key count (#1430)', () => {
    const s3 = report.targets.find((t) => t.resourceType === 'AWS::S3::Bucket');
    expect(s3).toBeDefined();
    expect(s3!.nestedKeyCount).toBeGreaterThanOrEqual(100);
  });

  it('audits the Lambda EventSourceMapping target with a healthy nested-key count (#1393 item 3)', () => {
    const esm = report.targets.find(
      (t) => t.resourceType === 'AWS::Lambda::EventSourceMapping'
    );
    expect(esm).toBeDefined();
    // Read the floor off the target table rather than restating it, so a
    // recalibration cannot leave this assertion pinning the old number, and
    // assert HEADROOM rather than `>=`: `loadReport` already throws below the
    // floor, so a `>=` here is satisfied by construction. Strict `>` is the
    // part the generator does not already enforce — it fails if the yield ever
    // collapses to exactly the floor, which is the shape a partial capture or
    // a `handledProperties` parse regression would produce.
    const declared = NESTED_KEY_TARGETS.find(
      (t) => t.resourceType === 'AWS::Lambda::EventSourceMapping'
    )!;
    expect(esm!.nestedKeyCount).toBeGreaterThan(declared.minNestedKeys);
  });

  it('audits the mixed-case-island targets with healthy nested-key counts (#1393 item 3)', () => {
    // The nine types issue #1393 item 1 named as the motivating evidence:
    // `client-eventbridge` / `client-scheduler` / `client-glue` are PascalCase
    // models with camelCase ISLANDS, and none of them was audited at all before
    // this slice. Floors are read off the target table rather than restated,
    // and asserted with HEADROOM (`>`), because `loadReport` already throws
    // below the floor — a `>=` here would be satisfied by construction, while
    // `>` fails if the yield ever collapses TO the floor, which is the shape a
    // partial capture or a `handledProperties` parse regression produces.
    const declared = new Map(NESTED_KEY_TARGETS.map((t) => [t.resourceType, t]));
    for (const type of [
      'AWS::Events::Rule',
      'AWS::Scheduler::Schedule',
      'AWS::Glue::Crawler',
      'AWS::Glue::Table',
      'AWS::Glue::Connection',
      'AWS::Glue::Trigger',
      'AWS::Glue::Database',
      'AWS::Glue::SecurityConfiguration',
      'AWS::Glue::Job',
    ]) {
      const audited = report.targets.find((t) => t.resourceType === type);
      expect(audited, type).toBeDefined();
      expect(audited!.nestedKeyCount, type).toBeGreaterThan(declared.get(type)!.minNestedKeys);
    }
  });

  it('declares every mixed-case-island target `exact` (#1393 item 1)', () => {
    // `exact` is the load-bearing half of the item-1 fix: declaring
    // `lower-first` because a handful of members are camelCase would lowercase
    // every PascalCase member before the whole-delivery lookup and re-hide the
    // very islands this slice exists to surface.
    for (const type of [
      'AWS::Events::Rule',
      'AWS::Scheduler::Schedule',
      'AWS::Glue::Crawler',
      'AWS::Glue::Table',
      'AWS::Glue::Connection',
      'AWS::Glue::Trigger',
      'AWS::Glue::Database',
      'AWS::Glue::SecurityConfiguration',
      'AWS::Glue::Job',
    ]) {
      const target = NESTED_KEY_TARGETS.find((t) => t.resourceType === type);
      expect(target, type).toBeDefined();
      expect(target!.keyStyle, type).toBe('exact');
    }
  });

  it('credits Glue DynamoDBTarget.ScanAll to the provider conversion in the shape pass (#1393 item 1)', () => {
    // `DynamoDBTarget` has no PascalCase `ScanAll` member — only the sibling
    // `MongoDBTarget` spells it that way (`@aws-sdk/client-glue`
    // `models_0.d.ts`) — so the definition sub-pass reports the divergence, and
    // `CFN_TO_SDK_DYNAMODB_TARGET_KEYS` naming the CFn spelling is what rescues
    // it. A provider that drops that conversion fails here by name.
    const crawlerShapes = report.targets
      .find((t) => t.resourceType === 'AWS::Glue::Crawler')!
      .shapeEntries.filter((e) => e.nestedKey === 'ScanAll');
    expect(crawlerShapes.map((e) => e.bucket)).toEqual(['provider-handled']);
  });

  it('leaves AWS::Glue::Workflow unregistered — it has nothing to audit', () => {
    // The recorded exclusion at the end of NESTED_KEY_TARGETS, asserted from
    // the fixture rather than from the comment.
    //
    // THE CAPTURE FRESHNESS ASSERTION IS LOAD-BEARING, and its absence is what
    // made the first cut of this test unfalsifiable. `nestedPropertyPaths` did
    // not exist as a fixture field until 2026-08-10, so EVERY stale capture
    // lacks it — including `AWS-AutoScaling-AutoScalingGroup.json`, which is
    // full of nested structures. Asserting only "the key is absent" against the
    // then-stale Workflow capture was therefore guaranteed by the fixture's AGE
    // rather than by the type's shape, and could never have "failed the day AWS
    // gives the type a structured property". The fixture has since been
    // re-captured (`node scripts/refresh-cfn-schemas.mjs 'AWS::Glue::Workflow'`).
    //
    // WHICH assertion carries the freshness claim matters, and the obvious
    // answer is wrong: `definitionShapes` is NOT it. That field landed
    // 2026-08-09 (b99fe610) and `nestedPropertyPaths` 2026-08-10 (6d26bca2), so
    // a capture taken in that one-day window has the first and lacks the second
    // — `AWS-ECS-Cluster.json` is exactly that shape today (9 `definitionShapes`,
    // no `nestedPropertyPaths`), which is a live counterexample to
    // "`definitionShapes` present proves post-extension".
    //
    // The two assertions that DO carry it:
    //   - `generatedAt >= '2026-08-10'` dates the capture past BOTH extensions,
    //     which is the direct claim and the cheap one;
    //   - `Object.keys(definitionShapes) === ['#top']` is the SHAPE claim and
    //     the one that survives any future field churn: `#top` being the only
    //     definition means the type has no modeled sub-structure at all, which
    //     is what makes the absence of `nestedPropertyPaths` a fact about the
    //     TYPE rather than about the capture. It is the discriminator, and the
    //     freshness check is what stops it being read out of a stale file.
    expect(
      NESTED_KEY_TARGETS.some((t) => t.resourceType === 'AWS::Glue::Workflow')
    ).toBe(false);
    const fixture = JSON.parse(
      readFileSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas/AWS-Glue-Workflow.json'), 'utf8')
    ) as {
      generatedAt?: string;
      nestedPropertyPaths?: Record<string, string[]>;
      definitionShapes?: Record<string, Record<string, string>>;
      primaryIdentifier?: string[];
    };
    // Freshness: dated past BOTH capture extensions (2026-08-09 / 2026-08-10).
    // ISO `YYYY-MM-DD` compares correctly as a string.
    expect(
      fixture.generatedAt ?? '',
      'capture predates the nestedPropertyPaths extension — re-run the refresher'
    ).not.toBe('');
    expect(fixture.generatedAt! >= '2026-08-10', `stale capture: ${fixture.generatedAt}`).toBe(
      true
    );
    // Shape: `#top` alone means the type has no modeled sub-structure.
    expect(Object.keys(fixture.definitionShapes ?? {})).toEqual(['#top']);
    expect(fixture.primaryIdentifier).toBeDefined();
    expect(fixture.nestedPropertyPaths).toBeUndefined();
    // Control. NOTE what this does and does not cover: it is a COMMITTED
    // fixture, so it discriminates against a broken re-capture SWEEP (someone
    // regenerates the tree and every file loses the key, leaving the Workflow
    // assertion vacuously green). It does NOT prove the live refresher still
    // emits the field — nothing here runs it. The refresher's own extraction is
    // covered by the `extractNestedPropertyPaths` unit tests earlier in this
    // file.
    const control = JSON.parse(
      readFileSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas/AWS-Glue-Crawler.json'), 'utf8')
    ) as { nestedPropertyPaths?: Record<string, string[]>; definitionRequired?: unknown };
    expect(control.nestedPropertyPaths).toBeDefined();

    // The same discrimination for `definitionRequired` (issue #1800). Its
    // omit-when-empty rule is the load-bearing half of its contract — a
    // consumer must read a MISSING key as "nothing required here" — and
    // nothing else pins it at the FIXTURE level, so a spread regression that
    // emitted `{}` unconditionally would leave every unit test green. This
    // type requires nothing anywhere, so it must carry NO section at all,
    // while the control above does.
    expect((fixture as { definitionRequired?: unknown }).definitionRequired).toBeUndefined();
    expect(control.definitionRequired).toBeDefined();
  });

  it('pins the shape pass BLIND SPOT on these targets — unmatchedDefinitions (#1393 item 5)', () => {
    // Bound (iii) in the script header. The shape pass only reaches a CFn
    // definition that has a SAME-NAMED SDK interface. One that does not lands in
    // `unmatchedDefinitions` and is not shape-audited — non-blocking by design,
    // counted in the generated matrix, and until now pinned by nothing.
    //
    // Pinned EXACTLY (not as a count) so the set cannot grow silently: a new
    // unmatched definition is a new hole and must be a deliberate edit here.
    // Closing the class needs the shape-aware v2 of #1378 (issue #1393 item 5).
    const unmatched = Object.fromEntries(
      report.targets
        .filter((t) =>
          ['AWS::Events::Rule', 'AWS::Scheduler::Schedule'].includes(t.resourceType) ||
          t.resourceType.startsWith('AWS::Glue::')
        )
        .map((t) => [t.resourceType, t.unmatchedDefinitions])
    );
    expect(unmatched).toEqual({
      'AWS::Events::Rule': [],
      'AWS::Scheduler::Schedule': [],
      'AWS::Glue::Connection': [],
      'AWS::Glue::SecurityConfiguration': [],
      'AWS::Glue::Trigger': [],
      // The six holes, all Glue, all free-form or CFn-only shapes:
      'AWS::Glue::Crawler': ['Targets'],
      'AWS::Glue::Database': ['PrincipalPrivileges'],
      'AWS::Glue::Job': ['DefaultArguments', 'NonOverridableArguments'],
      'AWS::Glue::Table': ['IcebergTableInput', 'SerdeInfo'],
    });
  });

  it('shape pass reports zero blocking divergences with healthy floors (#1378)', () => {
    expect(report.summary.arrayVsWrapper).toBe(0);
    expect(report.summary.definitionMemberMissing).toBe(0);
    // The QUANTITY_ITEM_FIELDS family alone is ~13 handled re-shapings; a
    // parse collapse would drop these counts, not raise them.
    expect(report.summary.shapeHandled).toBeGreaterThanOrEqual(10);
    expect(report.summary.shapeClean).toBeGreaterThanOrEqual(40);
  });

  it('fences the CloudFront wrapper family + CachedMethods placement as provider-handled', () => {
    const cf = report.targets.find((t) => t.resourceType === 'AWS::CloudFront::Distribution')!;
    const wrapperHandled = cf.shapeEntries.filter(
      (e) => e.pass === 'wrapper' && e.bucket === 'provider-handled'
    );
    for (const key of ['Aliases', 'Origins', 'CacheBehaviors', 'AllowedMethods']) {
      expect(
        wrapperHandled.some((e) => e.nestedKey === key),
        key
      ).toBe(true);
    }
    const cachedMethods = cf.shapeEntries.find(
      (e) => e.pass === 'definition' && e.nestedKey === 'CachedMethods'
    );
    expect(cachedMethods?.bucket).toBe('provider-handled');
  });

  it('fences the legacy S3Origin as shape-allow-listed', () => {
    const cf = report.targets.find((t) => t.resourceType === 'AWS::CloudFront::Distribution')!;
    const s3Origin = cf.shapeEntries.find((e) => e.nestedKey === 'S3Origin');
    expect(s3Origin?.bucket).toBe('allow-listed');
  });
});

describe('whole-blob hand-off walk (real repo, issue #1445)', () => {
  const providerSource = (file: string): string =>
    readFileSync(join(PROVIDERS_DIR, file), 'utf8');
  const evidenceFor = (file: string): ProviderWriteEvidence =>
    collectWriteEvidence(providerSource(file), file, ['readCurrentState'], resolveCaseConvert);
  const ecsInterfaces = collectSdkInterfaces(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-ecs/dist-types/models')
  );

  it('reports VpcLatticeConfigurations as delivered whole, which the shape pass relies on (PR #4324)', () => {
    // Pinned on the SHIPPED report field, so a regression anywhere between the
    // walk and `TargetReport.wholeDeliveredPaths` (the shape pass's input)
    // fails here rather than only in a unit of the walk.
    const ecsService = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::ECS::Service')!;
    const [svc] = loadReport([ecsService]).targets;
    expect(
      svc!.wholeDeliveredPaths.filter((p) => p.startsWith('VpcLatticeConfigurations.'))
    ).toEqual([
      // The PR #4324 path itself: `AdvancedConfiguration` is a real SDK member
      // (of `LoadBalancer`), forwarded here whole into an interface without it.
      'VpcLatticeConfigurations.AdvancedConfiguration',
      'VpcLatticeConfigurations.AdvancedConfiguration.AlternateTargetGroupArn',
      'VpcLatticeConfigurations.AdvancedConfiguration.ProductionListenerRule',
      'VpcLatticeConfigurations.AdvancedConfiguration.TestListenerRule',
      'VpcLatticeConfigurations.PortName',
      'VpcLatticeConfigurations.RoleArn',
      'VpcLatticeConfigurations.TargetGroupArn',
    ]);
  });

  it('credits the members of LinuxParameters, and ONLY through the walk', () => {
    // The issue's headline case, against the real `ecs-provider.ts`:
    // `convertLinuxParameters` is `return pascalToCamelCaseKeys(config)`, so
    // there is no per-member write anywhere in the tree to find. Since #1464 the
    // credit is a path PREFIX rather than a fold through the SDK model, so the
    // assertion is stated in paths — and it is the same claim: nothing under
    // `linuxParameters` has a write, and all of it is delivered.
    const raw = evidenceFor('ecs-provider.ts');
    const handoff = 'containerDefinitions.linuxParameters';
    expect(raw.handoffScopes.has(handoff)).toBe(true);
    for (const member of [
      'capabilities',
      'devices',
      'tmpfs',
      'swappiness',
      'maxSwap',
      'sharedMemorySize',
      'initProcessEnabled',
      // …and two levels down.
      'capabilities.add',
      'capabilities.drop',
      'devices.hostPath',
      'tmpfs.mountOptions',
    ]) {
      const path = `${handoff}.${member}`;
      const parent = path.slice(0, path.lastIndexOf('.'));
      const terminal = path.slice(path.lastIndexOf('.') + 1);
      expect(
        raw.scopes.get(parent)?.has(terminal) ?? false,
        `${member} must have no per-member write`
      ).toBe(false);
      expect(isHandoffCovered(raw.handoffScopes, parent, terminal), `${member} must be credited`)
        .toBe(true);
    }
    // Since #1472 `containerPortRange` is DIRECTLY written by
    // convertPortMappings, so it sits in its own path's scope with no wildcard.
    expect(
      raw.scopes.get('containerDefinitions.portMappings')?.has('containerPortRange')
    ).toBe(true);
    // The rubber-stamp guard: a SIBLING of the handed-off blob that the
    // provider re-shapes per member is NOT credited by the hand-off. With the
    // #1472 direct write present the live tree can no longer distinguish
    // wildcard-credit from write-credit, so the guard is asserted on evidence
    // with that write stripped: the prefix test alone must not resurrect it.
    const strippedSource = providerSource('ecs-provider.ts').replace(
      /^\s*containerPortRange: m\['ContainerPortRange'\] as string \| undefined,\n/m,
      ''
    );
    expect(strippedSource).not.toBe(providerSource('ecs-provider.ts'));
    const stripped = collectWriteEvidence(
      strippedSource,
      'ecs-provider.ts',
      ['readCurrentState'],
      resolveCaseConvert
    );
    expect(stripped.scopes.get('containerDefinitions.portMappings')?.has('containerPortRange'))
      .toBe(false);
    expect(
      isHandoffCovered(
        stripped.handoffScopes,
        'containerDefinitions.portMappings',
        'containerPortRange'
      )
    ).toBe(false);
    // ...and the SDK model still reaches it, so the guard is about the
    // bounding rather than about an absent name.
    expect(reachableSdkMemberNames('portMappings', ecsInterfaces).has('containerPortRange'))
      .toBe(true);
  });

  it('records the real ECS / API Gateway v2 hand-off points and skips the naming converters', () => {
    const ecs = allHandoffPoints(evidenceFor('ecs-provider.ts'));
    for (const point of [
      'linuxParameters',
      'repositoryCredentials',
      'systemControls',
      'extraHosts',
      'restartPolicy',
      'resourceRequirements',
      'runtimePlatform',
      'ephemeralStorage',
      'deploymentConfiguration',
    ]) {
      expect(ecs.has(point), point).toBe(true);
    }
    // `convertContainerDefinitions` / `convertLoadBalancers` / `convertPortMappings`
    // all name members, so their blobs keep proving themselves write by write.
    for (const point of ['containerDefinitions', 'loadBalancers', 'portMappings']) {
      expect(ecs.has(point), point).toBe(false);
    }
    const apigw = allHandoffPoints(evidenceFor('apigatewayv2-provider.ts'));
    for (const point of ['CorsConfiguration', 'DefaultRouteSettings', 'JwtConfiguration']) {
      expect(apigw.has(point), point).toBe(true);
    }
    // CloudFront's spread-and-patch is NOT generic (the genericity test still
    // rejects the member-naming `convertToSdkFormat`) — but since issue #1475
    // the SPREAD itself registers the point, bounded by the delete exclusions.
    const cloudfront = evidenceFor('cloudfront-distribution-provider.ts');
    expect(allHandoffPoints(cloudfront).has('DistributionConfig')).toBe(true);
    expect([...(cloudfront.handoffExclusions?.get('DistributionConfig') ?? [])]).toEqual([
      'ipv6enabled',
    ]);
  });

  it('holds the API Gateway v2 hand-off floor it declares', () => {
    // Read the floor off the target table rather than restating it, so a
    // recalibration cannot leave this assertion pinning the old number.
    const apigw = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::ApiGatewayV2::Api')!;
    expect(apigw.minHandoffPoints, 'the probed target declares the floor').toBeDefined();
    const evidence = evidenceFor('apigatewayv2-provider.ts');
    expect(
      countExpandingHandoffPoints(
        evidence,
        collectSdkInterfaces(
          resolve(repoRoot, 'node_modules/@aws-sdk/client-apigatewayv2/dist-types/models')
        )
      )
    ).toBeGreaterThanOrEqual(apigw.minHandoffPoints!);
    // The measured spread the floor comment records: 35 raw points, 3 that
    // carry a blob. If this stops holding, the floor comment is stale.
    expect(allHandoffPoints(evidence).size).toBeGreaterThan(20);
  });

  it('RED probe (#1520): the widened reverse-map exclusion withdraws a read-back write the old prefix-only exclusion kept', () => {
    // Real-code proof of what the #1520 widening closes: with only the FORWARD
    // write of `SseKmsEncryptedObjects` stripped, a reverse read-back must not
    // stand in for it in the write index (whose scopes the hand-off mapping and
    // the `segmentRenames` staleness fence read).
    const source = readFileSync(
      join(PROVIDERS_DIR, 's3-bucket-provider.ts'),
      'utf8'
    );
    // Only the FORWARD write is stripped (single occurrence): the reverse
    // read-back in `readReplication` keeps its spelling, which is exactly
    // what used to falsely vouch under the prefix-only exclusion.
    const regressed = source.replace(
      "sdkCriteria['SseKmsEncryptedObjects']",
      "sdkCriteria['XseKmsEncryptedObjects']"
    );
    expect(regressed).not.toBe(source);

    // Under the OLD prefix-only exclusion the regression is INVISIBLE: the
    // reverse write inside `readReplication` still contributes the CFn
    // spelling, so the member keeps a recorded write.
    const oldExclusion = collectWriteEvidence(regressed, 's3-bucket-provider.ts', [
      'readCurrentState',
    ]);
    expect(writtenNames(oldExclusion).has('SseKmsEncryptedObjects')).toBe(true);

    // Under the widened DEFAULT exclusion the reverse body no longer
    // contributes, so the member's write vanishes on exactly this variant.
    const widened = collectWriteEvidence(regressed, 's3-bucket-provider.ts');
    expect(writtenNames(widened).has('SseKmsEncryptedObjects')).toBe(false);

    // ...and the unregressed source keeps the member under the SAME defaults,
    // so this probe cannot pass vacuously.
    const clean = collectWriteEvidence(source, 's3-bucket-provider.ts');
    expect(writtenNames(clean).has('SseKmsEncryptedObjects')).toBe(true);
  });

  it('RED probe (#1540): dropping a lifecycle BUILDER mutation is caught at its scope', () => {
    // Real-code proof of the builder-behind-binding hop: the lifecycle rules
    // are built by mutating `sdkRule` inside a `.map()` callback held in a
    // plain binding — the exact shape the hop credits. Stripping the
    // `AbortIncompleteMultipartUpload` mutation must remove the member from
    // the `LifecycleConfiguration.Rules` scope, and the unregressed source must
    // carry it — the
    // credit comes from the real mutation write, not from anywhere looser.
    const source = readFileSync(join(PROVIDERS_DIR, 's3-bucket-provider.ts'), 'utf8');
    const regressed = source.replace(
      /^\s*sdkRule\.AbortIncompleteMultipartUpload = \{\n[^}]*\};\n/m,
      ''
    );
    expect(regressed).not.toBe(source);
    const stripped = collectWriteEvidence(regressed, 's3-bucket-provider.ts');
    expect(
      stripped.scopes.get('LifecycleConfiguration.Rules')?.has('AbortIncompleteMultipartUpload')
    ).toBe(false);
    const clean = collectWriteEvidence(source, 's3-bucket-provider.ts');
    expect(
      clean.scopes.get('LifecycleConfiguration.Rules')?.has('AbortIncompleteMultipartUpload')
    ).toBe(true);
    expect(
      clean.scopes.get('LifecycleConfiguration.Rules.AbortIncompleteMultipartUpload')?.has(
        'DaysAfterInitiation'
      )
    ).toBe(true);
  });

  it('the for-of taint hop registers a verbatim forward inside a config loop as a hand-off (#1540)', () => {
    // The statement-form twin of the `.map((element) => …)` callback hop: the
    // element of a bag-derived array is bag data. Without it, every per-item
    // S3 config loop broke the taint chain at the loop variable and the
    // `Tags: tagFilters` forward never registered.
    const src = `
      class P {
        apply(properties) {
          const configs = properties['MetricsConfigurations'];
          for (const config of configs) {
            const tagFilters = config['TagFilters'];
            this.client.send(
              new Cmd({ MetricsConfiguration: { Filter: { And: { Tags: tagFilters } } } })
            );
          }
        }
      }
    `;
    const ev = collectWriteEvidence(src, 'p.ts');
    expect(ev.handoffScopes.has('MetricsConfiguration.Filter.And.Tags')).toBe(true);
    // The seed-key ALIAS carries the CFn spelling too, which is what the
    // scoped `TagFilters` rename resolves against on the real tree.
    expect(ev.handoffScopes.has('MetricsConfiguration.Filter.And.TagFilters')).toBe(true);
  });
});

describe('real-code regression probes (per the repo checker rules)', () => {
  // Prove each CI-blocking shape verdict against REAL code: strip the real
  // provider's handling of a real key and assert the shape pass flags it —
  // a synthetic fixture would share the checker's own blind spots.
  const cfTarget = NESTED_KEY_TARGETS.find(
    (t) => t.resourceType === 'AWS::CloudFront::Distribution'
  )!;
  const cfFixture = JSON.parse(
    readFileSync(
      resolve(repoRoot, 'tests/fixtures/cfn-schemas/AWS-CloudFront-Distribution.json'),
      'utf8'
    )
  ) as { nestedPropertyPaths: Record<string, string[]> };
  const cfSdkMembers = collectSdkMemberNames(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-cloudfront/dist-types/models')
  );
  const cfSource = readFileSync(
    resolve(repoRoot, 'src/provisioning/providers/cloudfront-distribution-provider.ts'),
    'utf8'
  );
  it('SDK member parse floor holds (parser-regression fence)', () => {
    expect(cfSdkMembers.size).toBeGreaterThanOrEqual(50);
    expect(cfSdkMembers.has('ACMCertificateArn')).toBe(true);
  });

  // Shape-pass probes (issue #1378) — same real-code discipline.
  const cfShapes = (
    cfFixture as unknown as { definitionShapes: Record<string, Record<string, string>> }
  ).definitionShapes;
  const cfInterfaces = collectSdkInterfaces(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-cloudfront/dist-types/models')
  );

  it('flags the real provider with the Aliases wrap handling removed (array-vs-wrapper)', () => {
    // Full-word removal: `Aliases` also appears as a REMOVAL_RESET_DEFAULTS
    // property name, which legitimately counts as handling evidence.
    const regressed = cfSource.replaceAll('Aliases', 'Xliases');
    const result = classifyTargetShapes(
      cfTarget,
      cfShapes,
      cfInterfaces,
      collectStringLiterals(regressed)
    );
    const hit = result.entries.find((e) => e.nestedKey === 'Aliases' && e.pass === 'wrapper');
    expect(hit?.bucket).toBe('array-vs-wrapper');
  });

  it('flags the real provider with the CachedMethods handling removed (definition-member-missing)', () => {
    const regressed = cfSource.replaceAll('CachedMethods', 'XachedMethods');
    const result = classifyTargetShapes(
      cfTarget,
      cfShapes,
      cfInterfaces,
      collectStringLiterals(regressed)
    );
    const hit = result.entries.find(
      (e) => e.nestedKey === 'CachedMethods' && e.pass === 'definition'
    );
    expect(hit?.bucket).toBe('definition-member-missing');
  });

  it('the unregressed real provider classifies both shape keys as provider-handled', () => {
    const result = classifyTargetShapes(
      cfTarget,
      cfShapes,
      cfInterfaces,
      collectStringLiterals(cfSource)
    );
    expect(
      result.entries.find((e) => e.nestedKey === 'Aliases' && e.pass === 'wrapper')?.bucket
    ).toBe('provider-handled');
    expect(
      result.entries.find((e) => e.nestedKey === 'CachedMethods' && e.pass === 'definition')
        ?.bucket
    ).toBe('provider-handled');
  });

  // Real-code anchors for the write COLLECTOR — the scope index the hand-off
  // mapping and the `segmentRenames` staleness fence read.
  const s3Source = readFileSync(
    resolve(repoRoot, 'src/provisioning/providers/s3-bucket-provider.ts'),
    'utf8'
  );
  const cbSource = readFileSync(
    resolve(repoRoot, 'src/provisioning/providers/codebuild-provider.ts'),
    'utf8'
  );
  it('a purely NESTED write opens no root scope (#1464 — the #1448 bound, inverted)', () => {
    // The INVERSION of "scopes are keyed by NAME and unioned across write
    // sites". Two halves of that bound: (a) unrelated write SITES of one name
    // merge, which is intrinsic and STAYS (recorded bound 1); (b) a name that
    // only ever appears nested got a root-level scope a CFn top-level of that
    // spelling was then checked against — closed here.
    const { scopes } = collectWriteEvidence(`
      class P {
        a() { return { environment: { alpha: 1 } }; }
        b() { return { environment: { beta: 2 } }; }
        c() { return { logsConfig: { cloudWatchLogs: { groupName: 3 } } }; }
      }
    `);
    // (a) still true — a key is cleared when ANY site covers it, which IS the
    // union, so per-site sets would not change the answer.
    expect([...(scopes.get('environment') ?? [])].sort()).toEqual(['alpha', 'beta']);
    // (b) closed: the nested name lives ONLY under its parent path now.
    expect(scopes.has('cloudWatchLogs')).toBe(false);
    expect([...(scopes.get('logsConfig.cloudWatchLogs') ?? [])]).toEqual(['groupName']);
  });

  it('a collapsed scope index still records every written name (why the scope floor exists)', () => {
    // The real scenario behind `minWriteScopes`: when no write VALUE resolves to
    // a literal, every write still opens its (empty) scope, so a name-level view
    // looks healthy while the index carries no member at all. Only a count of
    // NON-EMPTY scopes — what the floor counts — sees it.
    const evidence = collectWriteEvidence(`
      const sdk = {
        source: external(a),
        environment: external(b),
        cache: external(c),
        artifacts: external(d),
      };
    `);
    expect([...writtenNames(evidence)].sort()).toEqual([
      'artifacts',
      'cache',
      'environment',
      'source',
    ]);
    expect([...evidence.scopes.values()].filter((v) => v.size > 0)).toHaveLength(0);
  });

  it('the unregressed BuildBatchConfig scope resolves through a let-bound literal', () => {
    // `buildBatchConfig` is a `let` assigned an object literal and delivered as a
    // SHORTHAND property of `mapProperties`\' return — so the scope only resolves
    // if the binding walk works. Pinned because a regression there would flag all
    // seven members at once with a misleading "never writes it".
    const { scopes } = collectWriteEvidence(cbSource);
    expect([...(scopes.get('buildBatchConfig') ?? [])].sort()).toEqual([
      'batchReportMode',
      'combineArtifacts',
      'restrictions',
      'serviceRole',
      'timeoutInMins',
    ]);
    // ...and the two members one level deeper sit under THEIR path since #1464,
    // which is where `BuildBatchConfig.Restrictions.*` now looks for them.
    expect([...(scopes.get('buildBatchConfig.restrictions') ?? [])].sort()).toEqual([
      'computeTypesAllowed',
      'maximumBuildsAllowed',
    ]);
  });

  it('a scope resolves through a this.method(...) call returning a literal', () => {
    // `source: this.mapSource(source)` — the #1404-style hop. `Source.BuildSpec`
    // is deliberately absent from the SDK-member side, so the members below are
    // the ones the pass actually consults.
    const { scopes } = collectWriteEvidence(cbSource);
    const scope = scopes.get('source');
    for (const member of ['type', 'location', 'gitCloneDepth', 'auth', 'buildStatusConfig']) {
      expect(scope?.has(member), member).toBe(true);
    }
    // ...and one level deeper, through the nested `auth: { … }` literal — at
    // its own path since #1464, NOT merged into `source`.
    expect(scope?.has('resource')).toBe(false);
    expect([...(scopes.get('source.auth') ?? [])].sort()).toEqual(['resource', 'type']);
  });

  it('a scope resolves through an array .map(cb) callback literal', () => {
    // `tags: tags.map((t) => ({ key: t.Key, value: t.Value }))`.
    const scope = collectWriteEvidence(cbSource).scopes.get('tags');
    expect([...(scope ?? [])].sort()).toEqual(['key', 'value']);
  });

  it('every write SHAPE the collector claims is anchored on REAL provider code', () => {
    // Per-SHAPE real-code floors (issue #1448 comment item 4): an aggregate
    // count cannot see a PARTIAL collapse — one dead shape hides under it. Each assertion below names a real site in a real provider.
    const evidence = collectWriteEvidence(cbSource);
    // object-literal property: `batchReportMode: cfnBuildBatchConfig['BatchReportMode']`
    expect(writtenNames(evidence).has('batchReportMode'), 'property assignment').toBe(true);
    // shorthand property: `buildBatchConfig,` in mapProperties\' return literal
    expect(cbSource).toMatch(/^\s{6}buildBatchConfig,$/m);
    expect(writtenNames(evidence).has('buildBatchConfig'), 'shorthand property').toBe(true);
    // element-access assignment with a literal key, on a genuine FORWARD path:
    // `CloudFrontDistributionProvider.completeRequiredUpdateFields` fills the
    // members UpdateDistribution requires. The name has to be reachable through
    // THAT SHAPE ALONE — an earlier revision asserted `written.size > 100` on
    // `ecs-provider.ts`, which stays at 158 with the element-access branch
    // entirely dead (a vacuous floor), and its `out['DockerVolumeConfiguration']`
    // site is a REVERSE `volumesToCfn` map besides.
    // `c['OriginKeepaliveTimeout'] = 5` is the only write of this name.
    const cfEvidence = collectWriteEvidence(cfSource, 'cloudfront-distribution-provider.ts');
    expect(cfSource).toContain("c['OriginKeepaliveTimeout'] = 5");
    expect(writtenNames(cfEvidence).has('OriginKeepaliveTimeout'), 'element access').toBe(true);
    // property-access assignment: `this.client = new CodeBuildClient(…)` is the
    // only write of `client` in the file, and it is a property access. The
    // earlier revision only regex-matched the SOURCE here and asserted nothing
    // about the collector at all.
    expect(cbSource).toContain('this.client = new CodeBuildClient(');
    expect(writtenNames(evidence).has('client'), 'property access').toBe(true);
  });

  it('the readCurrentState exclusion withdraws real reverse-map writes (#1393 item 2)', () => {
    // Measured on the real tree: `s3-bucket-provider.ts` is an `exact`-style
    // target, so its reverse map writes CFn spellings that ARE SDK member
    // spellings. Without the exclusion those read-back writes would open scopes
    // in the write index — where a hand-off or an un-renamed chain could
    // resolve against them.
    const scoped = writtenNames(collectWriteEvidence(s3Source));
    const unscoped = writtenNames(collectWriteEvidence(s3Source, 's3-bucket-provider.ts', []));
    // The ECS number is the one that proves the PREFIX match earns its keep:
    // `ecs-provider.ts` splits its reverse map into `readCurrentStateService` /
    // `readCurrentStateTaskDefinition`, which an EXACT-name match reached not
    // at all (it withdrew 0).
    const ecsSource = readFileSync(
      resolve(repoRoot, 'src/provisioning/providers/ecs-provider.ts'),
      'utf8'
    );
    const ecsWithdrawn =
      writtenNames(collectWriteEvidence(ecsSource, 'ecs-provider.ts', [])).size -
      writtenNames(collectWriteEvidence(ecsSource)).size;
    expect(ecsWithdrawn).toBeGreaterThanOrEqual(40);

    const withdrawn = [...unscoped].filter((n) => !scoped.has(n)).sort();
    // The measurement history: #1520 widened the exclusion from the
    // `readCurrentState` prefix (8 names) to the `read*` / `*ToCfn` reverse
    // families (30); #1707 / #1717 / #1718 took it to 27 (`Enabled`,
    // `ScheduleFrequency` and `BucketArn` are now ALSO written by the
    // effective-item folds, outside any reverse-map function); #1754 / #1755 /
    // #1759 took it to 26 (`TagFilters`, via `foldLifecycleScope`).
    // `EventBridgeEnabled` stays because the fold writes it under a COMPUTED
    // key, for the #1475 hand-off reason the provider states in-code.
    expect(withdrawn).toEqual([
      'AnalyticsConfigurations',
      'BucketEncryption',
      'BucketName',
      'ContinuationToken',
      'CorsConfiguration',
      'CorsRules',
      'DestinationBucketName',
      'EventBridgeEnabled',
      'ExposedHeaders',
      'Function',
      'IntelligentTieringConfigurations',
      'InventoryConfigurations',
      'LambdaConfigurations',
      'LogFilePrefix',
      'LoggingConfiguration',
      'MaxAge',
      'MetricsConfigurations',
      'Queue',
      'RedirectRule',
      'RoutingRuleCondition',
      'S3Key',
      'ServerSideEncryptionByDefault',
      'TagFilter',
      'Topic',
      'TransitionDate',
      'TransitionInDays',
    ]);
  });

  it('the reverse map no longer supplies LITERAL evidence either (#1448 comment item 2)', () => {
    // The literal pool (the shape pass's `provider-handled` evidence) applies the
    // same reverse-map exclusion the write walk does, so a CFn key mentioned
    // only by `readCurrentState` is not proof the FORWARD mapper re-shapes it.
    // The assertion pins that the exclusion is actually applied.
    const scoped = collectStringLiterals(cbSource, 'codebuild-provider.ts');
    const unscoped = collectStringLiterals(cbSource, 'codebuild-provider.ts', []);
    const withdrawn = [...unscoped].filter((n) => !scoped.has(n));
    // Measured on `codebuild-provider.ts`: these CFn spellings appear ONLY in
    // `readCurrentState`, so before the exclusion each was "provider names this
    // key" evidence produced entirely by the read path.
    // (`ResourceAccessRole` left the list once go-to-k/cdkd#2762 wired it.)
    for (const key of ['BucketOwnerAccess', 'Value']) {
      expect(withdrawn, key).toContain(key);
    }
  });
});

describe('refresh-cfn-schemas CLI guard (#1378 rider)', () => {
  const script = resolve(repoRoot, 'scripts/refresh-cfn-schemas.mjs');

  it('--help prints usage and exits 0 without fetching anything', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--help'], {
      timeout: 10_000,
    });
    expect(stdout).toContain('Usage:');
    expect(stdout).not.toContain('Refreshing CFn schemas');
    // Pin the guarded log string to the script SOURCE: if the fetch-start
    // message is ever reworded, this fails and forces the negative
    // assertion above to be updated — without it, that assertion would go
    // silently vacuous.
    expect(readFileSync(script, 'utf8')).toContain('Refreshing CFn schemas');
  });

  it('an unknown flag exits 1 with usage on stderr instead of silently full-refetching', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    // The 10s timeout is the offline fail-fast: a guard regression would
    // fall through to a full ~135-type live fetch here.
    await expect(
      promisify(execFile)(process.execPath, [script, '--bogus'], { timeout: 10_000 })
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage:') });
  });

  it('a single-dash typo is rejected as a flag attempt, not a type filter', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await expect(
      promisify(execFile)(process.execPath, [script, '-only-missing'], { timeout: 10_000 })
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe('target-table hygiene', { timeout: CONTENDED_CASE_TIMEOUT_MS }, () => {
  it('every target with segmentRenames declares minWriteScopes, and only those do (#1448)', () => {
    // The scope floor exists for `findStaleSegmentRenames`: a collapsed scope
    // index resolves no un-renamed chain, so every rename would look used and
    // the staleness fence would go quiet. A target WITHOUT renames has nothing
    // that floor protects (the hand-off credit reads `handoffScopes`, which
    // `minHandoffPoints` fences), so a declaration there would fence nothing.
    for (const t of NESTED_KEY_TARGETS) {
      if (Object.keys(t.segmentRenames ?? {}).length > 0) {
        expect(t.minWriteScopes, `${t.resourceType} minWriteScopes`).toBeGreaterThan(0);
      } else {
        expect(
          t.minWriteScopes,
          `${t.resourceType} declares minWriteScopes without segmentRenames`
        ).toBeUndefined();
      }
    }
    // Non-vacuity: the table does carry renaming targets for the loop to check.
    expect(
      NESTED_KEY_TARGETS.filter((t) => t.segmentRenames !== undefined)
        .map((t) => t.resourceType)
        .sort()
    ).toEqual(['AWS::ECS::TaskDefinition', 'AWS::S3::Bucket']);
  });

  it('every target the hand-off walk delivers a path for declares minHandoffPoints (#1445 / PR #4324)', () => {
    // The shape successor of the retired "WALK-DEPENDENT opt-in" check. A
    // target with a non-empty whole delivery has shape verdicts the walk can
    // change; without the floor, a walk that collapsed to zero hand-offs would
    // silently restore every literal rescue PR #4324 withdraws. Derived from
    // the real tree, so a provider that starts handing a blob off is pulled in.
    const report = loadReport();
    const dependent = report.targets.filter((t) => t.wholeDeliveredPaths.length > 0);
    for (const t of dependent) {
      const declared = NESTED_KEY_TARGETS.find((d) => d.resourceType === t.resourceType);
      expect(declared?.minHandoffPoints, `${t.resourceType} minHandoffPoints`).toBeGreaterThanOrEqual(
        1
      );
    }
    // Non-vacuity: the four targets this check was restored for are in the
    // measured set, alongside the ones already fenced before it.
    expect(dependent.map((t) => t.resourceType)).toEqual(
      expect.arrayContaining([
        'AWS::CloudWatch::AnomalyDetector',
        'AWS::ECS::Service',
        'AWS::ECS::TaskDefinition',
        'AWS::S3::Bucket',
        'AWS::CloudFront::Distribution',
        'AWS::ApiGatewayV2::Api',
      ])
    );
  });

  // The two probes below re-walk every provider file a floor is declared on,
  // so their cost grows with the provider tree rather than with the change
  // under test; they carry the shared contended bound (go-to-k/cdkd#3607).
  const HYGIENE_PROBE_TIMEOUT_MS = CONTENDED_CASE_TIMEOUT_MS;

  it('the write-walk floors are calibrated to their measured yields (#1445)', () => {
    // The `minNestedKeys` band below keeps that floor honest; the walk floors
    // need the same, or a floor drifts above a meaningful count (the
    // `minHandoffPoints: 20` that sat above a real 3) and fences nothing.
    const declared = NESTED_KEY_TARGETS.filter(
      (t) => t.minWriteScopes !== undefined || t.minHandoffPoints !== undefined
    );
    expect(declared.length, 'no target declares a walk floor').toBeGreaterThan(0);
    for (const target of declared) {
      const source = readFileSync(join(PROVIDERS_DIR, target.providerFile), 'utf8');
      const evidence = collectWriteEvidence(
        source,
        target.providerFile,
        REVERSE_MAP_FUNCTION_PREFIXES,
        resolveCaseConvert
      );
      const label = target.resourceType;
      if (target.minWriteScopes !== undefined) {
        const scopes = [...evidence.scopes.values()].filter((s) => s.size > 0).length;
        expect(target.minWriteScopes, `${label} minWriteScopes above yield`).toBeLessThanOrEqual(
          scopes
        );
        // Banded from BELOW too (the #1464 review): an upper bound alone lets a
        // floor drift arbitrarily far under the yield and fence nothing.
        expect(target.minWriteScopes, `${label} minWriteScopes too slack`).toBeGreaterThanOrEqual(
          Math.floor(scopes * 0.25)
        );
      }
      if (target.minHandoffPoints !== undefined) {
        const expanding = countExpandingHandoffPoints(
          evidence,
          collectSdkInterfaces(
            resolve(repoRoot, `node_modules/${target.sdkClientPackage}/dist-types/models`)
          )
        );
        // Redundant-by-construction rather than vacuous: a floor ABOVE the
        // yield makes the SHIPPED floor throw at load time, so `loadReport()`
        // elsewhere in this file aborts first. It stays as the assertion that
        // NAMES the miscalibration if the runtime floor is ever relaxed.
        expect(target.minHandoffPoints, `${label} minHandoffPoints above yield`).toBeLessThanOrEqual(
          expanding
        );
        // Deliberately NOT banded from below: a floor AT the measurement turns
        // every provider-side change into "parser regression?", while the
        // collapse this floor exists for yields 0, so >= 1 is the fence.
        expect(target.minHandoffPoints, `${label} minHandoffPoints`).toBeGreaterThanOrEqual(1);
      }
    }
  }, HYGIENE_PROBE_TIMEOUT_MS);

  it('every minNestedKeys floor is calibrated to the PATH unit (#1448 / #1464)', () => {
    // The floors were name-era values until #1448 re-derived them, and
    // 2-segment-era values until #1464 did; a floor far below the real yield
    // fences nothing. Each must be within 40% of the measured path count.
    //
    // The upper bound is STRICTLY below the yield, not `<=`: a floor sitting
    // exactly AT the measurement is the "every legitimate change is a false
    // alarm" shape — the moment AWS removes one property from the schema, the
    // refresher's next run aborts with "fixture capture regression?" instead of
    // reporting the one path that went away. Two targets used to sit there
    // (`AWS::ApiGatewayV2::Stage` at 5/5 and `::Authorizer` at 2/2); the
    // exemption below is only for targets too small for headroom to exist.
    const report = loadReport();
    for (const t of NESTED_KEY_TARGETS) {
      const audited = report.targets.find((r) => r.resourceType === t.resourceType)!.nestedKeyCount;
      if (audited >= 3) {
        expect(t.minNestedKeys, `${t.resourceType} floor at or above yield`).toBeLessThan(audited);
      } else {
        expect(t.minNestedKeys, `${t.resourceType} floor above yield`).toBeLessThanOrEqual(audited);
      }
      if (audited >= 5) {
        expect(t.minNestedKeys, `${t.resourceType} floor too slack`).toBeGreaterThanOrEqual(
          Math.floor(audited * 0.6)
        );
      }
    }
  }, HYGIENE_PROBE_TIMEOUT_MS);

  it('every allow-list entry names a target resource type', () => {
    const targetTypes = new Set(NESTED_KEY_TARGETS.map((t) => t.resourceType));
    for (const key of NESTED_KEY_ALLOW_LIST.keys()) {
      const [type] = key.split('#');
      expect(targetTypes.has(type!), key).toBe(true);
    }
  });
});

/**
 * Definition -> SDK interface resolution (issue go-to-k/cdkd#2821).
 *
 * CFn definition names and SDK interface names are INDEPENDENT namespaces, and
 * several services name the request shape `<X>Input` while `<X>` is the
 * response. An exact-name match then lands on a shape no request can carry, and
 * every member that exists only on the request twin reports
 * `definition-member-missing` about a key the provider delivers.
 *
 * It is not a stable mismatch either: AWS RENAMED the `AWS::Glue::Connection`
 * definitions from `AuthenticationConfigurationInput` to
 * `AuthenticationConfiguration`, which turned four clean keys into blocking
 * divergences whose documented remedy is a `NESTED_KEY_ALLOW_LIST` entry — a
 * standing promise cdkd never sends the value, recorded about one it does.
 */
describe('input-reachable interface resolution', () => {
  const iface = (members: Record<string, SdkMemberType>): Map<string, SdkMemberType> =>
    new Map(Object.entries(members));

  // Two shapes spelled the same way apart from the suffix: the response
  // `AuthenticationConfiguration` reachable from nothing, and the request
  // `AuthenticationConfigurationInput` reachable through the operation input.
  const sdk = new Map<string, Map<string, SdkMemberType>>([
    [
      'CreateConnectionRequest',
      iface({ ConnectionInput: { kind: 'ref', refName: 'ConnectionInput' } }),
    ],
    [
      'ConnectionInput',
      iface({
        AuthenticationConfiguration: {
          kind: 'ref',
          refName: 'AuthenticationConfigurationInput',
        },
      }),
    ],
    [
      'AuthenticationConfigurationInput',
      iface({ AuthenticationType: { kind: 'scalar' }, BasicAuthenticationCredentials: { kind: 'scalar' } }),
    ],
    ['AuthenticationConfiguration', iface({ AuthenticationType: { kind: 'scalar' } })],
    // A list-valued edge, because that is how most nested shapes hang off a
    // request. `ChangeDetail` carries NO input-root suffix, so it is reachable
    // only by following the array edge — with a ref-only walk it drops out, and
    // a fixture whose array target happened to end in `Input` would be a root
    // already and could not tell the two apart (measured: it did not).
    ['BatchRequest', iface({ Changes: { kind: 'array', refName: 'ChangeDetail' } })],
    ['ChangeDetail', iface({ Action: { kind: 'scalar' } })],
    // BOTH spellings input-reachable. The exact one must win, or a service that
    // legitimately declares `<X>` on a request gets judged against `<X>Input`.
    ['Retry', iface({ MaxAttempts: { kind: 'scalar' }, OnlyOnExact: { kind: 'scalar' } })],
    ['RetryInput', iface({ MaxAttempts: { kind: 'scalar' } })],
    ['StartRequest', iface({ Retry: { kind: 'ref', refName: 'Retry' }, R2: { kind: 'ref', refName: 'RetryInput' } })],
    // Reachable from nothing at all, and no twin either.
    ['OrphanShape', iface({ Whatever: { kind: 'scalar' } })],
  ]);

  it('walks ref AND array edges out of the input roots', () => {
    const reachable = inputReachableInterfaces(sdk);
    expect([...reachable].sort()).toEqual([
      'AuthenticationConfigurationInput',
      'BatchRequest',
      'ChangeDetail',
      'ConnectionInput',
      'CreateConnectionRequest',
      'Retry',
      'RetryInput',
      'StartRequest',
    ]);
    // Reached ONLY across an array edge, and carrying no root suffix of its own.
    expect(reachable.has('ChangeDetail')).toBe(true);
    // The shapes a request cannot carry.
    expect(reachable.has('AuthenticationConfiguration')).toBe(false);
    expect(reachable.has('OrphanShape')).toBe(false);
  });

  it('prefers the exact name when BOTH spellings are input-reachable', () => {
    // A service that legitimately puts `<X>` on a request must be judged
    // against `<X>`, not against a same-service `<X>Input` that means something
    // else. Every currently-green verdict takes this path, so a rule that
    // always preferred the twin would move buckets on untouched targets.
    const reachable = inputReachableInterfaces(sdk);
    const resolved = resolveDefinitionInterface('Retry', sdk, reachable);
    expect(resolved?.name).toBe('Retry');
    expect(resolved?.via).toBe('exact');
    expect(resolved?.members.has('OnlyOnExact')).toBe(true);
  });

  it('prefers the input-reachable twin when the exact name is response-only', () => {
    const reachable = inputReachableInterfaces(sdk);
    const resolved = resolveDefinitionInterface('AuthenticationConfiguration', sdk, reachable);
    expect(resolved?.name).toBe('AuthenticationConfigurationInput');
    expect(resolved?.via).toBe('Input');
    // The member that only exists on the request twin — the whole point.
    expect(resolved?.members.has('BasicAuthenticationCredentials')).toBe(true);
  });

  it('keeps the exact match when it IS input-reachable', () => {
    // Every currently-green verdict resolves this way, so a rule that always
    // preferred the twin would move buckets on targets nobody touched.
    const reachable = inputReachableInterfaces(sdk);
    const resolved = resolveDefinitionInterface('ConnectionInput', sdk, reachable);
    expect(resolved?.name).toBe('ConnectionInput');
    expect(resolved?.via).toBe('exact');
  });

  it('falls back to the exact match when NEITHER candidate is input-reachable', () => {
    // One real definition is this shape (`Glue::Crawler`'s `Schedule`). An
    // unreachable interface is still the closest answer; returning undefined
    // would report it as UNMATCHED, which says something different and louder.
    //
    // `via` DISCRIMINATES the two exact arms. Same name, same members, but not
    // the same claim — `exact` says a request can carry this shape, this says
    // nothing provably can — and one shared value would leave a consumer
    // branching on `via` unable to tell them apart.
    const reachable = inputReachableInterfaces(sdk);
    const resolved = resolveDefinitionInterface('OrphanShape', sdk, reachable);
    expect(resolved?.name).toBe('OrphanShape');
    expect(resolved?.via).toBe('exact-unreachable');
    // The reachable arm keeps the plain value, so the two are distinguishable.
    expect(resolveDefinitionInterface('ConnectionInput', sdk, reachable)?.via).toBe('exact');
  });

  it('REFUSES a twin that shares too few members with the exact shape', () => {
    // `Type` and `Message` are in the suffix list for the query protocol, so a
    // definition named `Filter` can meet an unrelated `FilterType` and bind to
    // it on the strength of the NAME alone. A false clean there is silent — a
    // request shape carries many members, so the audited key is likely present
    // in it by accident — which is why the twin has to look like the same
    // shape. Falling back to the exact match is the LOUD direction: its
    // divergences block CI.
    const unrelated = new Map<string, Map<string, SdkMemberType>>([
      ['ListRequest', iface({ F: { kind: 'ref', refName: 'FilterType' } })],
      ['Filter', iface({ Key: { kind: 'scalar' }, Values: { kind: 'array' } })],
      // Nothing in common with `Filter` beyond the name prefix.
      ['FilterType', iface({ Unit: { kind: 'scalar' }, Precision: { kind: 'scalar' } })],
    ]);
    const reachable = inputReachableInterfaces(unrelated);
    const resolved = resolveDefinitionInterface('Filter', unrelated, reachable);
    expect(resolved?.name).toBe('Filter');
    expect(resolved?.via).toBe('exact-unreachable');
    // And the gate is not a blanket refusal: HALF the exact shape's members is
    // enough, which every real pair clears (measured at 100 / 100 / 83 / 100 /
    // 100 percent across the five in the tree).
    const related = new Map(unrelated);
    related.set('FilterType', iface({ Key: { kind: 'scalar' }, Unit: { kind: 'scalar' } }));
    expect(resolveDefinitionInterface('Filter', related, inputReachableInterfaces(related))?.name).toBe(
      'FilterType'
    );

    // An EMPTY exact shape is refused rather than twinned. Without `shared > 0`
    // the arithmetic alone (`shared * 2 >= 0`) accepts it, so this is the only
    // case that can fail when that clause is dropped — and it fixes the answer
    // as a DECISION (no relatedness evidence exists, so the name alone must not
    // bind) rather than leaving it to an accident of the comparison.
    const empty = new Map(unrelated);
    empty.set('Filter', iface({}));
    expect(resolveDefinitionInterface('Filter', empty, inputReachableInterfaces(empty))?.via).toBe(
      'exact-unreachable'
    );
  });

  it('follows a MAP-VALUE edge, so a shape carried only as a map value is reachable', () => {
    // `Record<string, Y>` puts `Y` on the wire exactly as a list-valued member
    // carries its element. Before this the walk stopped at the map, `Y` looked
    // unreachable, and a definition of that name fell to the twin branch — the
    // one place an unrelated interface can be bound. Real instance:
    // `AWS::ApiGatewayV2::Route`'s `ParameterConstraints`, reachable ONLY
    // through `RequestParameters?: Record<string, ParameterConstraints>`.
    const mapped = new Map<string, Map<string, SdkMemberType>>([
      [
        'CreateRouteRequest',
        iface({ Params: { kind: 'ref', refName: 'Record', valueRefName: 'Constraint' } }),
      ],
      ['Constraint', iface({ Required: { kind: 'scalar' } })],
    ]);
    expect(inputReachableInterfaces(mapped).has('Constraint')).toBe(true);
  });

  it('resolves nothing when the definition names no interface at all', () => {
    const reachable = inputReachableInterfaces(sdk);
    expect(resolveDefinitionInterface('NoSuchThing', sdk, reachable)).toBeUndefined();
  });

  it('reports the interface it CONSULTED, not the definition name', () => {
    // A reader sent to `AuthenticationConfiguration` when the check read
    // `AuthenticationConfigurationInput` looks at the wrong shape and reaches
    // the opposite conclusion — which is how the allow-list entry gets written.
    const result = classifyTargetShapes(
      exactTarget,
      { AuthenticationConfiguration: { NotAMember: 'scalar' } },
      // `NotAMember` must exist SOMEWHERE for the definition sub-pass to run.
      new Map([...sdk, ['SomeOtherShape', iface({ NotAMember: { kind: 'scalar' } })]]),
      new Set(),
      new Map()
    );
    const missing = result.entries.filter((e) => e.bucket === 'definition-member-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.sdkDetail).toContain('`AuthenticationConfigurationInput`');
    expect(missing[0]!.sdkDetail).not.toContain('`AuthenticationConfiguration` has');
  });

  it('clears a member that exists only on the request twin', () => {
    // The go-to-k/cdkd#2784 shape, end to end: under the exact-name rule this
    // is a blocking `definition-member-missing`.
    const result = classifyTargetShapes(
      exactTarget,
      { AuthenticationConfiguration: { BasicAuthenticationCredentials: 'scalar' } },
      sdk,
      new Set(),
      new Map()
    );
    expect(result.entries.filter((e) => e.bucket === 'definition-member-missing')).toEqual([]);
  });
});

describe('input-root suffixes beyond `Input`', () => {
  const iface = (members: Record<string, SdkMemberType>): Map<string, SdkMemberType> =>
    new Map(Object.entries(members));

  // The QUERY-protocol spellings. Leaving `Type` / `Message` out of the list
  // made whole services — rds, neptune, auto-scaling, docdb, elasticache —
  // unreachable from any input root, which is why the sibling list in
  // `scripts/offline-property-evidence.ts` carries them. Nothing exercised them
  // here: deleting both survived every other case (measured).
  const sdk = new Map<string, Map<string, SdkMemberType>>([
    // `Type` root (auto-scaling's shape), reaching a nested shape by array edge.
    ['UpdateGroupType', iface({ Members: { kind: 'array', refName: 'GroupMember' } })],
    ['GroupMember', iface({ Weight: { kind: 'scalar' } })],
    // `Message` root (query protocol), reaching a nested shape by ref.
    ['SendMessage', iface({ Body: { kind: 'ref', refName: 'BodyPart' } })],
    ['BodyPart', iface({ Text: { kind: 'scalar' } })],
    // `CommandInput` root.
    ['DoThingCommandInput', iface({ Opt: { kind: 'scalar' } })],
    // A definition whose ONLY twin uses the `CommandInput` suffix. Its ROOT
    // pinning below is vacuous by construction — every `<X>CommandInput` name
    // also ends in `Input` — so the twin lookup is the only thing that can
    // discriminate that entry, and renaming it in both files survived until
    // this case existed.
    ['Widget', iface({ Shared: { kind: 'scalar' } })],
    ['WidgetCommandInput', iface({ Shared: { kind: 'scalar' }, OnlyOnCommandInput: { kind: 'scalar' } })],
    // A definition whose exact name is response-only and whose twin uses the
    // `Request` suffix rather than `Input`.
    ['Policy', iface({ Version: { kind: 'scalar' } })],
    ['PolicyRequest', iface({ Version: { kind: 'scalar' }, Statements: { kind: 'array' } })],
    ['PolicyInput', iface({ SomethingElse: { kind: 'scalar' } })],
    ['AttachRequest', iface({ Policy: { kind: 'ref', refName: 'PolicyRequest' } })],
  ]);

  it('seeds every suffix in the list as a root', () => {
    const reachable = inputReachableInterfaces(sdk);
    for (const root of ['UpdateGroupType', 'SendMessage', 'DoThingCommandInput', 'AttachRequest']) {
      expect(reachable.has(root), `${root} is not seeded as an input root`).toBe(true);
    }
    // And reaches through them, so a suffix that seeds nothing is not enough.
    expect(reachable.has('GroupMember')).toBe(true);
    expect(reachable.has('BodyPart')).toBe(true);
  });

  it('resolves a twin through a NON-`Input` suffix', () => {
    const reachable = inputReachableInterfaces(sdk);
    const resolved = resolveDefinitionInterface('Policy', sdk, reachable);
    expect(resolved?.name).toBe('PolicyRequest');
    expect(resolved?.via).toBe('Request');
  });

  it('resolves a twin through the `CommandInput` suffix', () => {
    // `CommandInput` cannot be discriminated as a ROOT — `<X>CommandInput` ends
    // in `Input` — so this is the only case that can fail when the entry is
    // removed from the list.
    const reachable = inputReachableInterfaces(sdk);
    const resolved = resolveDefinitionInterface('Widget', sdk, reachable);
    expect(resolved?.name).toBe('WidgetCommandInput');
    expect(resolved?.via).toBe('CommandInput');
    expect(resolved?.members.has('OnlyOnCommandInput')).toBe(true);
  });

  it('takes the suffixes in list order, so `Request` beats `Input`', () => {
    // Both twins exist here. The order is the shared list's, not a preference
    // of `resolveDefinitionInterface` — reordering the list changes the answer,
    // and nothing else in this suite would notice.
    const reachable = inputReachableInterfaces(sdk);
    expect(resolveDefinitionInterface('Policy', sdk, reachable)?.members.has('Statements')).toBe(
      true
    );
    expect(resolveDefinitionInterface('Policy', sdk, reachable)?.members.has('SomethingElse')).toBe(
      false
    );
  });

  it('does NOT rebind a definition that matches no interface at all', () => {
    // 53 of the 357 definitions across the current targets match nothing and
    // report as `unmatchedDefinitions`. Without the exact-exists gate, a
    // `<X>Type` or `<X>Message` shape — in the list for the query protocol —
    // could silently become the audited interface for one of them. Measured
    // over the refreshed fixtures the case is empty, so the gate is
    // behaviour-identical today and exists to keep it that way.
    const reachable = inputReachableInterfaces(sdk);
    // Both halves must have a twin that WOULD be taken without the gate;
    // a name with no twin either returns `undefined` under the old code too.
    expect(resolveDefinitionInterface('UpdateGroup', sdk, reachable)).toBeUndefined();
    expect(resolveDefinitionInterface('Attach', sdk, reachable)).toBeUndefined();
  });
});

describe('the two INPUT_ROOT_SUFFIXES lists stay in step', () => {
  it('declares the same suffixes as scripts/offline-property-evidence.ts', async () => {
    // Two files carry the list and the walk that consumes it, and the only
    // thing keeping them equal was a comment in each. The repo's own answer to
    // that shape is a sync fence (`cross-cutting-list-sync.test.ts`); this is
    // the two-file version. Neither list is exported, so both are read out of
    // the SOURCE — which is also what makes the fence honest: an export would
    // let one file silently consume the other's list while claiming to have
    // its own.
    const read = async (rel: string) => {
      const src = readFileSync(resolve(repoRoot, rel), 'utf8');
      const m = /const INPUT_ROOT_SUFFIXES = \[([^\]]+)\]/.exec(src);
      expect(m, `${rel} no longer declares INPUT_ROOT_SUFFIXES as a literal array`).not.toBeNull();
      return m![1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter((s) => s.length > 0);
    };
    const critic = await read('scripts/gen-nested-key-coverage.ts');
    const evidence = await read('scripts/offline-property-evidence.ts');
    // Pinned LITERALLY, not merely to a length. A magic `>= 5` cannot see both
    // lists collapsing to the same WRONG value — renaming one entry in both
    // files kept the arrays equal and the length unchanged (measured).
    expect(critic).toEqual(['Request', 'Input', 'CommandInput', 'Type', 'Message']);
    expect(critic).toEqual(evidence);
  });
});
