import { afterAll, describe, it, expect, vi } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MIN_WRITTEN_MEMBERS_PER_PROVIDER,
  NESTED_KEY_ALLOW_LIST,
  NESTED_KEY_TARGETS,
  REVERSE_MAP_FUNCTION_PREFIXES,
  allowKey,
  buildReport,
  classifyTarget,
  classifyTargetShapes,
  collectSdkInterfaces,
  collectSdkMemberNames,
  collectStringLiterals,
  collectWriteEvidence,
  collectWrittenMemberNames,
  countExpandingHandoffPoints,
  expandLiteralSegments,
  findDivergences,
  findStaleAllowListEntries,
  findStaleSegmentRenames,
  findStaleTerminalRenames,
  isHandoffCovered,
  loadReport,
  lowerFirst,
  lookupAllowEntry,
  nestedKeyPathsForTarget,
  reachableSdkMemberNames,
  wrapperInterfaceNames,
  type AllowListEntry,
  type NestedKeyClassification,
  type NestedKeyPath,
  type NestedKeyTarget,
  type ProviderWriteEvidence,
  type SdkMemberType,
} from '../../../scripts/gen-nested-key-coverage.ts';
import {
  extractDefinitionShapes,
  extractNestedPropertyNames,
  extractNestedPropertyPaths,
} from '../../../scripts/refresh-cfn-schemas.mjs';
import { parseProviderSource } from '../../../scripts/gen-property-coverage.ts';

// Vitest's 5s default does not fit this file. 26 of its tests parse the WHOLE
// real `src/provisioning/providers` tree through the TypeScript compiler API,
// or spawn the shipped `--check` against a scratch copy of it — inherently
// 1-2s each locally and ~3x that on CI. Two of them (the opt-in-table and S3
// reason-(C) fences, 1.6s / 2.2s locally) timed out on CI at 5s while passing
// locally three runs in a row, which is exactly the boundary this raises off.
//
// Set once per FILE rather than per test on purpose: the failure that prompted
// it was a heavyweight test added WITHOUT a timeout argument, and the repo's
// per-test convention (`}, 15_000)`) guarantees that recurs every time this
// file grows. Slowness here is a property of the file, not of individual tests.
vi.setConfig({ testTimeout: 15_000 });

const repoRoot = process.cwd();
const SCRIPT = resolve(repoRoot, 'scripts/gen-nested-key-coverage.ts');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');

const exactTarget: NestedKeyTarget = {
  resourceType: 'AWS::Fake::Thing',
  providerFile: 'fake-provider.ts',
  sdkClientPackage: '@aws-sdk/client-fake',
  keyStyle: 'exact',
  minNestedKeys: 0,
};

const freshTarget: NestedKeyTarget = { ...exactTarget, freshObjectMapper: true };

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
  written: new Set(Object.values(scopes).flat()),
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

/** Every classification whose TERMINAL key is `key` (a key can span paths). */
const entriesFor = (
  entries: readonly NestedKeyClassification[],
  key: string
): NestedKeyClassification[] => entries.filter((e) => e.terminalKey === key);

/** The single bucket every path of `key` landed in (fails loudly if they differ). */
const bucketOf = (
  entries: readonly NestedKeyClassification[],
  key: string
): string | undefined => {
  const buckets = [...new Set(entriesFor(entries, key).map((e) => e.bucket))];
  return buckets.length === 1 ? buckets[0] : buckets.length === 0 ? undefined : buckets.join('+');
};

describe('collectWrittenMemberNames (synthetic)', () => {
  it('counts object-literal, shorthand and assignment writes', () => {
    const written = collectWrittenMemberNames(`
      const batchReportMode = 1;
      const sdk = { serviceRole: p['ServiceRole'], batchReportMode };
      sdk.timeoutInMins = 5;
      sdk['combineArtifacts'] = true;
    `);
    expect([...written].sort()).toEqual([
      'batchReportMode',
      'combineArtifacts',
      'serviceRole',
      'timeoutInMins',
    ]);
  });

  it('does NOT credit a VARIABLE key in an element-access write', () => {
    // `sdk[k] = v` names a variable, not a member. Crediting it would let a
    // local called `type` / `name` clear a CI-blocking bucket for the SDK
    // member of that name.
    const written = collectWrittenMemberNames(`
      const type = 'x';
      sdk[type] = 1;
      sdk['batchReportMode'] = 2;
    `);
    expect(written.has('type')).toBe(false);
    expect(written.has('batchReportMode')).toBe(true);
  });

  it('does NOT credit a computed object-literal property name', () => {
    const written = collectWrittenMemberNames(`const o = { [k]: 1, literal: 2 };`);
    expect(written.has('k')).toBe(false);
    expect(written.has('literal')).toBe(true);
  });

  it('does NOT credit a DESTRUCTURING-ASSIGNMENT target (it is a read)', () => {
    // `({ x } = src)` parses as an object literal on the LEFT of an `=`, so its
    // members look like property assignments while being reads off `src`.
    const written = collectWrittenMemberNames(`
      ({ batchReportMode } = desc);
      ({ timeoutInMins: t } = desc);
      const real = { combineArtifacts: 1 };
    `);
    expect(written.has('batchReportMode')).toBe(false);
    expect(written.has('timeoutInMins')).toBe(false);
    expect(written.has('combineArtifacts')).toBe(true);
  });

  it('does NOT credit a NESTED / ARRAY / for-of destructuring target', () => {
    // A depth-1 parent check misses all three of these — the inner literal's
    // parent is a PropertyAssignment / ArrayLiteralExpression / ForOfStatement
    // rather than the assignment itself.
    const written = collectWrittenMemberNames(`
      ({ outer: { batchReportMode } } = desc);
      [{ combineArtifacts }] = arr;
      for ({ timeoutInMins } of list) { use(timeoutInMins); }
      ({ serviceRole = 'x' } = desc);
      const real = { queuedTimeoutInMinutes: 1 };
    `);
    expect(written.has('batchReportMode')).toBe(false);
    expect(written.has('combineArtifacts')).toBe(false);
    expect(written.has('timeoutInMins')).toBe(false);
    expect(written.has('serviceRole')).toBe(false);
    expect(written.has('queuedTimeoutInMinutes')).toBe(true);
  });

  it('excludes an arrow-function PROPERTY reverse map, not just a method', () => {
    // A regression here fails in the DANGEROUS direction: reverse-map writes
    // would be silently re-credited, false-clearing a CI-blocking bucket.
    const source = `
      class P {
        readCurrentState = async () => { const r = {}; r['CorsConfiguration'] = 1; return r; };
        map(p) { return { forwardOnly: p['ForwardOnly'] }; }
      }
    `;
    expect(collectWrittenMemberNames(source).has('CorsConfiguration')).toBe(false);
    expect(collectWrittenMemberNames(source).has('forwardOnly')).toBe(true);
  });

  it('the exclusion matchers respect word boundaries (#1520 widened set)', () => {
    // `read` must sit at a camelCase boundary — `readonly…` is a different
    // word and must NOT be swallowed — and the `*ToCfn` suffix must sit at
    // the END of the name on a non-empty stem.
    const written = collectWrittenMemberNames(`
      function readonlyHelper() { return { stillCounted: 1 }; }
      function readCurrentStateService() { return { notCounted: 1 }; }
      function readLifecycle() { return { alsoNotCounted: 1 }; }
      function volumesToCfn() { return { suffixNotCounted: 1 }; }
      function toCfnFirst() { return { midNameCounted: 1 }; }
    `);
    expect(written.has('stillCounted')).toBe(true);
    expect(written.has('notCounted')).toBe(false);
    expect(written.has('alsoNotCounted')).toBe(false);
    expect(written.has('suffixNotCounted')).toBe(false);
    expect(written.has('midNameCounted')).toBe(true);
  });

  it('excludes writes in a nested function inside an excluded body', () => {
    const source = `
      class P {
        readCurrentState() {
          const build = () => ({ corsConfiguration: 1 });
          return build();
        }
      }
    `;
    expect(collectWrittenMemberNames(source).has('corsConfiguration')).toBe(false);
  });

  it('counts a string-literal property name and a template element-access key', () => {
    const written = collectWrittenMemberNames(
      "const o = { 'batchReportMode': 1 }; sdk[`combineArtifacts`] = 2;"
    );
    expect(written.has('batchReportMode')).toBe(true);
    expect(written.has('combineArtifacts')).toBe(true);
  });

  it('excludes reverse-map functions by PREFIX, not exact name', () => {
    // Real shape: `apigateway-provider.ts` splits the reverse map into
    // `readCurrentStateAuthorizer` / `...Resource` / `...Stage` / etc.
    const source = `
      class P {
        readCurrentStateAuthorizer() { const r = {}; r['CorsConfiguration'] = 1; return r; }
        map(p) { return { forwardOnly: p['ForwardOnly'] }; }
      }
    `;
    expect(collectWrittenMemberNames(source).has('CorsConfiguration')).toBe(false);
    expect(collectWrittenMemberNames(source).has('forwardOnly')).toBe(true);
  });

  it('does NOT count a read (the reverse-map direction)', () => {
    const written = collectWrittenMemberNames(`
      const out = {};
      out['BatchReportMode'] = desc.batchReportMode;
    `);
    expect(written.has('BatchReportMode')).toBe(true);
    expect(written.has('batchReportMode')).toBe(false);
  });

  it('skips the body of an excluded function (issue #1393 item 2)', () => {
    const source = `
      class P {
        map(p) { return { forwardOnly: p['ForwardOnly'] }; }
        async readCurrentState() {
          const r = {};
          r['CorsConfiguration'] = 1;
          return r;
        }
      }
    `;
    expect(collectWrittenMemberNames(source).has('CorsConfiguration')).toBe(false);
    expect(collectWrittenMemberNames(source).has('forwardOnly')).toBe(true);
    // With no exclusion set the same write IS collected — proving the
    // exclusion, not an unrelated parse miss, is what withdraws it.
    expect(collectWrittenMemberNames(source, 'p.ts', []).has('CorsConfiguration')).toBe(
      true
    );
  });
});

describe('collectWriteEvidence (synthetic)', () => {
  it('scopes a write to the members beneath the value it is written with (#1448)', () => {
    const { written, scopes } = collectWriteEvidence(`
      const sdk = {
        serviceRole: p['ServiceRole'],
        buildBatchConfig: { serviceRole: p['Inner'], batchReportMode: 1 },
      };
    `);
    // The name-global set cannot tell the two `serviceRole` writes apart...
    expect(written.has('serviceRole')).toBe(true);
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
    // FALSE-POSITIVE direction: un-peeled, `await this.build()` resolves to no
    // literals and every path under `source` flags with the misleading "the
    // provider never writes it". No opted-in provider awaits a mapper today, so
    // this synthetic case IS the fence.
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
    const written = collectWriteEvidence(`
      sdk.batchReportMode ??= 'REPORT_AGGREGATED_BATCH';
      sdk.timeoutInMins ||= 60;
      sdk['combineArtifacts'] &&= true;
      sdk.queuedTimeoutInMinutes += 1;
    `).written;
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
    const { written, scopes } = collectWriteEvidence(`
      Object.defineProperty(sdk, 'batchReportMode', {
        value: { serviceRole: 1 },
        writable: true,
        enumerable: true,
      });
    `);
    expect(written.has('batchReportMode')).toBe(true);
    expect(written.has('value')).toBe(false);
    expect(written.has('writable')).toBe(false);
    expect(written.has('enumerable')).toBe(false);
    // ...and the descriptor's `value` payload still becomes the member's scope.
    expect(scopes.get('batchReportMode')?.has('serviceRole')).toBe(true);
  });

  it('a computed / variable defineProperty name is not credited', () => {
    const written = collectWriteEvidence(
      `Object.defineProperty(sdk, key, { value: 1 });`
    ).written;
    expect(written.has('key')).toBe(false);
  });

  it('a COMPARISON-ONLY literal is not delivery (#1448 diff-is-not-delivery)', () => {
    // The change-detection idiom of a diff-heavy `update()`: the literal names
    // the member but nothing is ever sent.
    const written = collectWriteEvidence(`
      const changed =
        JSON.stringify({ batchReportMode: next }) !== JSON.stringify({ batchReportMode: prev });
      const empty = Object.keys({ combineArtifacts: next }).length === 0;
      const delivered = { timeoutInMins: 5 };
      send(delivered);
    `).written;
    expect(written.has('batchReportMode')).toBe(false);
    expect(written.has('combineArtifacts')).toBe(false);
    expect(written.has('timeoutInMins')).toBe(true);
  });

  it('the NESTED half of a comparison-only literal is not delivery either', () => {
    // `inner`'s own parent chain stops at a PropertyAssignment, so the check has
    // to climb to the OUTERMOST literal before asking what consumes it.
    const written = collectWriteEvidence(`
      const changed =
        JSON.stringify({ buildBatchConfig: { batchReportMode: next } }) !==
        JSON.stringify({ buildBatchConfig: { batchReportMode: prev } });
    `).written;
    expect(written.has('buildBatchConfig')).toBe(false);
    expect(written.has('batchReportMode')).toBe(false);
  });

  it('a literal serialized into a REQUEST is still delivery', () => {
    // The other side of the same rule: `body: JSON.stringify(x)` sends the value.
    const written = collectWriteEvidence(
      `const req = { body: JSON.stringify({ batchReportMode: 1 }) };`
    ).written;
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
    expect(collectWriteEvidence(source).written.has('Alpha')).toBe(true);
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
    // `glue-provider.ts`'s `renameRecordKeys` is the same shape one opt-in away.
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

  it('classifyTarget lands an excluded same-spelling key in no-write-evidence', () => {
    const evidence: ProviderWriteEvidence = {
      written: new Set(['DistributionConfig']),
      scopes: new Map([['DistributionConfig', new Set<string>()]]),
      handoffScopes: new Set(['DistributionConfig']),
      handoffExclusions: new Map([['DistributionConfig', new Set(['ipv6enabled'])]]),
    };
    const out = classifyTarget(
      freshTarget,
      keyPaths('DistributionConfig', 'IPV6Enabled', 'PriceClass'),
      new Set(['IPV6Enabled', 'PriceClass']),
      new Set<string>(),
      new Map(),
      evidence
    );
    expect(bucketOf(out, 'IPV6Enabled')).toBe('no-write-evidence');
    expect(bucketOf(out, 'PriceClass')).toBe('same-spelling');
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
      written: new Set(['linuxParameters', 'name', 'swappiness']),
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
      written: new Set(['a']),
      scopes: new Map([['a', new Set(['b'])]]),
      handoffScopes: new Set(),
    };
    expect(countExpandingHandoffPoints(evidence, interfaces)).toBe(0);
  });
});

describe('classifyTarget (synthetic)', () => {
  const sdkMembers = new Set(['ACMCertificateArn', 'IsIPV6Enabled', 'Comment', 'items']);
  const commentPath = keyPaths('Top', 'Comment');

  it('a same-spelling key on a NON-fresh-object target stays silent without any write', () => {
    // The forwarding case: the serializer carries the key through, so an
    // absent write proves nothing. Guards the opt-in from becoming default-on.
    const [e] = classifyTarget(exactTarget, commentPath, sdkMembers, new Set(), new Map());
    expect(e?.bucket).toBe('same-spelling');
  });

  it('the audited unit is the PATH, not the bare key (#1448)', () => {
    const entries = classifyTarget(
      exactTarget,
      [...keyPaths('Alpha', 'Comment'), ...keyPaths('Beta', 'Comment')],
      sdkMembers,
      new Set(),
      new Map()
    );
    expect(entries.map((e) => e.nestedKey)).toEqual(['Alpha.Comment', 'Beta.Comment']);
    expect(entries.map((e) => e.terminalKey)).toEqual(['Comment', 'Comment']);
    expect(entries.map((e) => e.topLevelProperty)).toEqual(['Alpha', 'Beta']);
  });

  it('flags a same-spelling key with no write evidence on a fresh-object target (#1432)', () => {
    const [e] = classifyTarget(freshTarget, commentPath, sdkMembers, new Set(), new Map());
    expect(e?.bucket).toBe('no-write-evidence');
    expect(e?.sdkNearMiss).toBe('Comment');
  });

  it('clears the same key once the provider writes the SDK member IN THAT SCOPE', () => {
    const [e] = classifyTarget(
      freshTarget,
      commentPath,
      sdkMembers,
      new Set(),
      new Map(),
      writeEvidence({ Top: ['Comment'] })
    );
    expect(e?.bucket).toBe('same-spelling');
  });

  it('does NOT clear a key written under a DIFFERENT scope (the #1448 fix)', () => {
    // The name-global model cleared this: `Comment` is written somewhere, so
    // every `*.Comment` path was vouched for. Scoped evidence sees that the
    // write is under `Elsewhere`, not under this path's `Top`.
    const [e] = classifyTarget(
      freshTarget,
      commentPath,
      sdkMembers,
      new Set(),
      new Map(),
      writeEvidence({ Elsewhere: ['Comment'], Top: ['SomethingElse'] })
    );
    expect(e?.bucket).toBe('no-write-evidence');
  });

  it('does NOT clear a key when the top-level scope resolves to nothing at all', () => {
    const [e] = classifyTarget(
      freshTarget,
      commentPath,
      sdkMembers,
      new Set(),
      new Map(),
      writeEvidence({ Comment: ['Comment'] }) // a scope NAMED like the key, not the parent
    );
    expect(e?.bucket).toBe('no-write-evidence');
  });

  it('does NOT let the loose literal heuristic rescue a missing write', () => {
    // The CFn spelling named somewhere in the file is exactly the evidence
    // #1432 says is insufficient for a fresh-object mapper.
    const [e] = classifyTarget(
      freshTarget,
      commentPath,
      sdkMembers,
      new Set(['Comment']),
      new Map()
    );
    expect(e?.bucket).toBe('no-write-evidence');
  });

  it('an allow-list entry silences a no-write-evidence key ONLY with the write pass opted in', () => {
    const shapeOnly = new Map([
      [allowKey(freshTarget.resourceType, 'Comment'), { rationale: 'deliberate' }],
    ]);
    // Default passes are ['key','shape'] — the #1378 cross-pass sharing, which
    // predates the write pass and says nothing about delivery (#1448).
    expect(
      classifyTarget(freshTarget, commentPath, sdkMembers, new Set(), shapeOnly)[0]?.bucket
    ).toBe('no-write-evidence');

    const writeOptIn = new Map([
      [
        allowKey(freshTarget.resourceType, 'Comment'),
        { rationale: 'deliberate', passes: ['write'] as const },
      ],
    ]);
    const [e] = classifyTarget(freshTarget, commentPath, sdkMembers, new Set(), writeOptIn);
    expect(e?.bucket).toBe('allow-listed');
    expect(e?.rationale).toBe('deliberate');
    expect(e?.allowMatchKey).toBe('AWS::Fake::Thing#Comment');
  });

  it('a PATH-precise allow-list entry beats the terminal-name fallback', () => {
    const allow = new Map([
      [
        allowKey(freshTarget.resourceType, 'Top.Comment'),
        { rationale: 'scoped to this path', passes: ['write'] as const },
      ],
    ]);
    const [scoped] = classifyTarget(freshTarget, commentPath, sdkMembers, new Set(), allow);
    expect(scoped?.bucket).toBe('allow-listed');
    expect(scoped?.allowMatchKey).toBe('AWS::Fake::Thing#Top.Comment');
    // ...and it does NOT silence the same key under another top-level.
    const [other] = classifyTarget(
      freshTarget,
      keyPaths('Other', 'Comment'),
      sdkMembers,
      new Set(),
      allow
    );
    expect(other?.bucket).toBe('no-write-evidence');
  });

  it('lookupAllowEntry prefers the path, falls back to the terminal name', () => {
    const allow = new Map([
      [allowKey('T', 'A.B'), { rationale: 'path' }],
      [allowKey('T', 'B'), { rationale: 'terminal' }],
    ]);
    expect(lookupAllowEntry(allow, 'T', 'A.B', 'B', 'key')?.entry.rationale).toBe('path');
    expect(lookupAllowEntry(allow, 'T', 'C.B', 'B', 'key')?.entry.rationale).toBe('terminal');
    expect(lookupAllowEntry(allow, 'T', 'C.B', 'B', 'write')).toBeUndefined();
  });

  it('lower-first styling applies to the write lookup on BOTH path segments', () => {
    const camel = new Set(['batchReportMode']);
    const lowerFirstFresh: NestedKeyTarget = {
      ...exactTarget,
      keyStyle: 'lower-first',
      freshObjectMapper: true,
    };
    const path = keyPaths('BuildBatchConfig', 'BatchReportMode');
    const [missing] = classifyTarget(
      lowerFirstFresh,
      path,
      camel,
      new Set(),
      new Map(),
      // the CFn spellings written. Since #1464 the PARENT is matched
      // case-insensitively, so `BuildBatchConfig` resolves — the TERMINAL
      // `BatchReportMode` is what fails, and it is the only one that may.
      writeEvidence({ BuildBatchConfig: ['BatchReportMode'] })
    );
    expect(missing?.bucket).toBe('no-write-evidence');
    const [ok] = classifyTarget(
      lowerFirstFresh,
      path,
      camel,
      new Set(),
      new Map(),
      writeEvidence({ buildBatchConfig: ['batchReportMode'] })
    );
    expect(ok?.bucket).toBe('same-spelling');
  });

  it('the PARENT chain is case-folded and the TERMINAL is NOT (#1464)', () => {
    // `normalizeWritePath`'s whole contract, in one probe. The relaxation this
    // PR adds is on a CI-BLOCKING pass, so both directions are pinned: a parent
    // whose casing diverges (the real `EFSVolumeConfiguration` ->
    // `efsVolumeConfiguration` shape) must still clear, and a TERMINAL whose
    // casing diverges must still flag.
    const fresh: NestedKeyTarget = { ...exactTarget, freshObjectMapper: true };
    const sdk = new Set(['RootDirectory']);
    const path = keyPaths('Volumes', 'EFSVolumeConfiguration.RootDirectory');
    const [parentDiverges] = classifyTarget(
      fresh,
      path,
      sdk,
      new Set(),
      new Map(),
      writeEvidence({ volumes: ['efsVolumeConfiguration'], 'volumes.efsVolumeConfiguration': ['RootDirectory'] })
    );
    expect(parentDiverges?.bucket, 'divergent PARENT casing clears').toBe('same-spelling');
    const [terminalDiverges] = classifyTarget(
      fresh,
      path,
      sdk,
      new Set(),
      new Map(),
      writeEvidence({
        Volumes: ['EFSVolumeConfiguration'],
        'Volumes.EFSVolumeConfiguration': ['rootdirectory'],
      })
    );
    expect(terminalDiverges?.bucket, 'divergent TERMINAL casing flags').toBe('no-write-evidence');
  });

  it('the case-fold is per LEVEL, not a global union of the write index (#1464)', () => {
    // A whole-file lowercase fold merges the MEMBER SETS of every same-spelled
    // scope — measured at 80 collision groups on `ecs-provider.ts`. Descending
    // level by level keeps them apart: `a.Name` is matched against `a`'s own
    // children only, so an unrelated root `name` cannot vouch for it.
    const fresh: NestedKeyTarget = { ...exactTarget, freshObjectMapper: true };
    const [entry] = classifyTarget(
      fresh,
      keyPaths('Alpha', 'Name.Value'),
      new Set(['Value']),
      new Set(),
      new Map(),
      writeEvidence({
        Alpha: ['Name'],
        'Alpha.Name': [],
        // A DIFFERENT `name` scope elsewhere in the file that DOES carry the
        // member. A global fold would union it in and clear the path.
        name: ['Value'],
      })
    );
    expect(entry?.bucket).toBe('no-write-evidence');
  });

  it('segmentRenames resolves an intermediate segment the provider RENAMES (#1464)', () => {
    // The real shape: CFn `ProxyConfiguration.ProxyConfigurationProperties` is
    // the SDK's `ProxyConfiguration.properties`. Case-folding cannot bridge a
    // rename, so without the map the children of a member the provider DOES
    // write report `no-write-evidence`.
    const target: NestedKeyTarget = { ...exactTarget, freshObjectMapper: true };
    const paths = keyPaths('ProxyConfiguration', 'ProxyConfigurationProperties.Name');
    const evidence = writeEvidence({
      ProxyConfiguration: ['properties'],
      'ProxyConfiguration.properties': ['Name'],
    });
    const [without] = classifyTarget(target, paths, new Set(['Name']), new Set(), new Map(), evidence);
    expect(without?.bucket).toBe('no-write-evidence');
    const renamed: NestedKeyTarget = {
      ...target,
      segmentRenames: { ProxyConfigurationProperties: 'properties' },
    };
    const used = new Set<string>();
    const [with_] = classifyTarget(
      renamed,
      paths,
      new Set(['Name']),
      new Set(),
      new Map(),
      evidence,
      used
    );
    expect(with_?.bucket).toBe('same-spelling');
    expect([...used]).toEqual(['ProxyConfigurationProperties']);
  });

  it('segmentRenames NEVER applies to the terminal segment (#1464)', () => {
    // The terminal IS the audited key. Renaming it would let the map answer the
    // pass's own question, which is the rubber stamp the whole critic avoids.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      segmentRenames: { Name: 'properties' },
    };
    const [entry] = classifyTarget(
      target,
      keyPaths('Top', 'Name'),
      new Set(['Name']),
      new Set(),
      new Map(),
      writeEvidence({ Top: ['properties'] })
    );
    expect(entry?.bucket).toBe('no-write-evidence');
  });

  it('a segmentRename whose UN-RENAMED chain resolves is reported unused (#1464)', () => {
    // The staleness fence's input. An entry goes unused exactly when the
    // un-renamed chain resolves — the SDK renamed the member back and the map
    // is now redundant — so `findStaleSegmentRenames` forces its removal.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      segmentRenames: { Middle: 'renamedMiddle' },
    };
    const used = new Set<string>();
    classifyTarget(
      target,
      keyPaths('Top', 'Middle.Leaf'),
      new Set(['Leaf']),
      new Set(),
      new Map(),
      writeEvidence({ Top: ['Middle'], 'Top.Middle': ['Leaf'] }),
      used
    );
    expect([...used]).toEqual([]);
  });

  it('a segmentRename stays USED when the provider stops writing the member (#1464)', () => {
    // The fence must not MASK the finding it exists to make reachable. With
    // neither chain resolving, the entry is still the right bridge and the
    // divergence is the thing to report — a stale-map error standing in front
    // of it would hide a real silent drop behind a tooling complaint.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      segmentRenames: { Middle: 'renamedMiddle' },
    };
    const used = new Set<string>();
    const [entry] = classifyTarget(
      target,
      keyPaths('Top', 'Middle.Leaf'),
      new Set(['Leaf']),
      new Set(),
      new Map(),
      writeEvidence({ Top: ['renamedMiddle'], 'Top.renamedMiddle': [] }),
      used
    );
    expect(entry?.bucket).toBe('no-write-evidence');
    expect([...used]).toEqual(['Middle']);
  });

  it('findStaleSegmentRenames reports the entry the classifier never needed', () => {
    const target: NestedKeyTarget = {
      ...exactTarget,
      resourceType: 'AWS::Fake::Thing',
      segmentRenames: { Middle: 'renamedMiddle', Gone: 'nope' },
    };
    const report = buildReport([
      {
        resourceType: target.resourceType,
        providerFile: target.providerFile,
        sdkClientPackage: target.sdkClientPackage,
        keyStyle: target.keyStyle,
        freshObjectMapper: true,
        nestedKeyCount: 0,
        entries: [],
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: ['Middle'],
        usedTerminalRenames: [],
      },
    ]);
    expect(findStaleSegmentRenames(report, [target])).toEqual(['AWS::Fake::Thing#Gone']);
  });

  it('a SCOPED segmentRenames key applies only under its declared parent (#1540)', () => {
    // Two families share a segment NAME (`Rules`); only the one under `S3Key`
    // is renamed. A bare-name entry would corrupt the lifecycle chain — the
    // collision class that blocked the notification renames until scoping.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      segmentRenames: { 'S3Key.Rules': 'FilterRules' },
    };
    const evidence = writeEvidence({
      Top: ['S3Key', 'Lifecycle'],
      'Top.S3Key': ['FilterRules'],
      'Top.S3Key.FilterRules': ['Name'],
      'Top.Lifecycle': ['Rules'],
      'Top.Lifecycle.Rules': ['Name'],
    });
    const used = new Set<string>();
    const [notif] = classifyTarget(
      target,
      keyPaths('Top', 'S3Key.Rules.Name'),
      new Set(['Name']),
      new Set(),
      new Map(),
      evidence,
      used
    );
    expect(notif?.bucket).toBe('same-spelling');
    expect([...used]).toEqual(['S3Key.Rules']);
    // The same-named `Rules` under a DIFFERENT parent is untouched: the
    // scoped key does not match there, so the plain chain resolves and the
    // used set stays empty.
    const usedElsewhere = new Set<string>();
    const [lifecycle] = classifyTarget(
      target,
      keyPaths('Top', 'Lifecycle.Rules.Name'),
      new Set(['Name']),
      new Set(),
      new Map(),
      evidence,
      usedElsewhere
    );
    expect(lifecycle?.bucket).toBe('same-spelling');
    expect([...usedElsewhere]).toEqual([]);
  });

  it('a SCOPED segmentRenames key WINS over a bare-name entry for the same segment (#1540)', () => {
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      segmentRenames: { Middle: 'bareTarget', 'Top.Middle': 'scopedTarget' },
    };
    const used = new Set<string>();
    const [entry] = classifyTarget(
      target,
      keyPaths('Top', 'Middle.Leaf'),
      new Set(['Leaf']),
      new Set(),
      new Map(),
      writeEvidence({ Top: ['scopedTarget'], 'Top.scopedTarget': ['Leaf'] }),
      used
    );
    expect(entry?.bucket).toBe('same-spelling');
    expect([...used]).toEqual(['Top.Middle']);
  });

  it('terminalRenames redirects the terminal judgment to the declared SDK spelling (#1540)', () => {
    // Pure rename: CFn `Enabled` is the SDK's `IsEnabled`. The check stays
    // strict — the RENAMED member must be scope-written verbatim.
    const paths = keyPaths('Top', 'Enabled');
    const evidence = writeEvidence({ Top: ['IsEnabled'] });
    const [without] = classifyTarget(
      { ...exactTarget, freshObjectMapper: true },
      paths,
      new Set(['Enabled']),
      new Set(),
      new Map(),
      evidence
    );
    expect(without?.bucket).toBe('no-write-evidence');
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      terminalRenames: { 'Top.Enabled': 'IsEnabled' },
    };
    const usedTerminals = new Set<string>();
    const [with_] = classifyTarget(
      target,
      paths,
      new Set(['Enabled']),
      new Set(),
      new Map(),
      evidence,
      undefined,
      usedTerminals
    );
    expect(with_?.bucket).toBe('same-spelling');
    expect([...usedTerminals]).toEqual(['Top.Enabled']);
  });

  it('a DOTTED terminalRenames value relocates the terminal under an inserted scope (#1540)', () => {
    // Relocation: CFn puts `Prefix` at the config level, the SDK nests it
    // under `Filter` — the value's non-last parts extend the parent chain.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      terminalRenames: { 'Top.Prefix': 'Filter.Prefix' },
    };
    const [entry] = classifyTarget(
      target,
      keyPaths('Top', 'Prefix'),
      new Set(['Prefix']),
      new Set(),
      new Map(),
      writeEvidence({ Top: ['Filter'], 'Top.Filter': ['Prefix'] })
    );
    expect(entry?.bucket).toBe('same-spelling');
  });

  it('a terminalRenames entry whose PLAIN terminal resolves is reported unused (#1540)', () => {
    // The staleness fence's input, mirroring segmentRenames: a redundant
    // entry must be removed, and this is what caught the three hand-authored
    // `BucketArn` / `BucketAccountId` entries the seed-key hand-off aliases
    // already covered.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      terminalRenames: { 'Top.Leaf': 'RenamedLeaf' },
    };
    const usedTerminals = new Set<string>();
    classifyTarget(
      target,
      keyPaths('Top', 'Leaf'),
      new Set(['Leaf']),
      new Set(),
      new Map(),
      writeEvidence({ Top: ['Leaf'] }),
      undefined,
      usedTerminals
    );
    expect([...usedTerminals]).toEqual([]);
  });

  it('a terminalRenames entry stays USED when neither spelling resolves (#1540)', () => {
    // Same negation as segmentRenames: the entry is still the right bridge,
    // and the divergence — not a stale-map error — is what must surface.
    const target: NestedKeyTarget = {
      ...exactTarget,
      freshObjectMapper: true,
      terminalRenames: { 'Top.Leaf': 'RenamedLeaf' },
    };
    const usedTerminals = new Set<string>();
    const [entry] = classifyTarget(
      target,
      keyPaths('Top', 'Leaf'),
      new Set(['Leaf']),
      new Set(),
      new Map(),
      writeEvidence({ Top: [] }),
      undefined,
      usedTerminals
    );
    expect(entry?.bucket).toBe('no-write-evidence');
    expect([...usedTerminals]).toEqual(['Top.Leaf']);
  });

  it('findStaleTerminalRenames reports the entry the classifier never needed (#1540)', () => {
    const target: NestedKeyTarget = {
      ...exactTarget,
      resourceType: 'AWS::Fake::Thing',
      terminalRenames: { 'Top.Used': 'X', 'Top.Gone': 'Y' },
    };
    const report = buildReport([
      {
        resourceType: target.resourceType,
        providerFile: target.providerFile,
        sdkClientPackage: target.sdkClientPackage,
        keyStyle: target.keyStyle,
        freshObjectMapper: true,
        nestedKeyCount: 0,
        entries: [],
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: ['Top.Used'],
      },
    ]);
    expect(findStaleTerminalRenames(report, [target])).toEqual(['AWS::Fake::Thing#Top.Gone']);
  });

  it('a no-write-evidence key is a CI-blocking divergence', () => {
    const entries = classifyTarget(freshTarget, commentPath, sdkMembers, new Set(), new Map());
    const report = buildReport([
      {
        resourceType: freshTarget.resourceType,
        providerFile: freshTarget.providerFile,
        sdkClientPackage: freshTarget.sdkClientPackage,
        keyStyle: freshTarget.keyStyle,
        freshObjectMapper: true,
        nestedKeyCount: entries.length,
        entries,
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: [],
      },
    ]);
    expect(report.summary.noWriteEvidence).toBe(1);
    expect(report.summary.freshObjectTargets).toBe(1);
    const [d] = findDivergences(report);
    expect(d?.bucket).toBe('no-write-evidence');
    expect(d?.nestedKey).toBe('Top.Comment');
    expect(d?.detail).toContain('never writes it');
  });

  it('classifies a same-spelling key as reachable', () => {
    const [e] = classifyTarget(exactTarget, commentPath, sdkMembers, new Set(), new Map());
    expect(e?.bucket).toBe('same-spelling');
  });

  it('classifies a provider-named key as provider-handled', () => {
    // A target WITHOUT the write-evidence opt-in keeps the file-global
    // literal rescue — there is no scope index to check against (#1393).
    const [e] = classifyTarget(
      exactTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map()
    );
    expect(e?.bucket).toBe('provider-handled');
  });

  it('a fresh-object target rejects a file-global literal alone (#1393 item 2)', () => {
    // The same call as above but on the opted-in target: the literal used to
    // rescue this to `provider-handled`; without scoped delivery evidence the
    // masked near-miss now surfaces (#1393 item 1).
    const [e] = classifyTarget(
      freshTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map()
    );
    expect(e?.bucket).toBe('case-divergence');
    expect(e?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('a fresh-object target accepts the literal with a ci-matching SDK member written at the resolved scope (#1393 item 2)', () => {
    const [e] = classifyTarget(
      freshTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map(),
      writeEvidence({ Top: ['ACMCertificateArn'] })
    );
    expect(e?.bucket).toBe('provider-handled');
  });

  it('a ci-matching write that is NOT an SDK member does not rescue (#1393 item 2)', () => {
    // A provider writing a case-mangled non-member at the right scope is the
    // bug itself, not evidence — the member check is load-bearing.
    const [e] = classifyTarget(
      freshTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map(),
      writeEvidence({ Top: ['acmCERTIFICATEArn'] })
    );
    expect(e?.bucket).toBe('case-divergence');
  });

  it('a whole-blob hand-off does not vouch for a divergent key (#1393 item 2)', () => {
    // A verbatim forward delivers the CFn spelling, which by this branch's
    // premise matches no SDK member — the serializer drops it on the wire.
    const [e] = classifyTarget(
      freshTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map(),
      writeEvidence({ Top: [] }, ['Top'])
    );
    expect(e?.bucket).toBe('case-divergence');
  });

  it('a declared terminal rename resolves a divergent key and is recorded as used (#1393 item 2)', () => {
    const target: NestedKeyTarget = {
      ...freshTarget,
      terminalRenames: { 'Top.IPV6Enabled': 'IsIPV6Enabled' },
    };
    const usedTerminals = new Set<string>();
    const [e] = classifyTarget(
      target,
      keyPaths('Top', 'IPV6Enabled'),
      sdkMembers,
      new Set(['IPV6Enabled']),
      new Map(),
      writeEvidence({ Top: ['IsIPV6Enabled'] }),
      undefined,
      usedTerminals
    );
    expect(e?.bucket).toBe('provider-handled');
    expect([...usedTerminals]).toEqual(['Top.IPV6Enabled']);
  });

  it('a declared terminal rename that does not resolve keeps the divergence reported (#1393 item 2)', () => {
    const target: NestedKeyTarget = {
      ...freshTarget,
      terminalRenames: { 'Top.IPV6Enabled': 'IsIPV6Enabled' },
    };
    const [e] = classifyTarget(
      target,
      keyPaths('Top', 'IPV6Enabled'),
      sdkMembers,
      new Set(['IPV6Enabled']),
      new Map(),
      writeEvidence({ Top: [] })
    );
    expect(e?.bucket).toBe('no-sdk-member');
  });

  it('flags a case-insensitive near-miss as case-divergence with the SDK member named', () => {
    const [e] = classifyTarget(
      exactTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(),
      new Map()
    );
    expect(e?.bucket).toBe('case-divergence');
    expect(e?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('flags a key with no SDK member at all as no-sdk-member', () => {
    const [e] = classifyTarget(
      exactTarget,
      keyPaths('Top', 'IPV6Enabled'),
      sdkMembers,
      new Set(),
      new Map()
    );
    expect(e?.bucket).toBe('no-sdk-member');
  });

  it('classifies an allow-listed divergence as allow-listed with its rationale', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'IPV6Enabled'), { rationale: 'legacy member' }],
    ]);
    const [e] = classifyTarget(
      exactTarget,
      keyPaths('Top', 'IPV6Enabled'),
      sdkMembers,
      new Set(),
      allow
    );
    expect(e?.bucket).toBe('allow-listed');
    expect(e?.rationale).toBe('legacy member');
  });

  it('an allow-listed near-miss still records the SDK member it shadows', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'AcmCertificateArn'), { rationale: 'deliberate' }],
    ]);
    const [e] = classifyTarget(
      exactTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(),
      allow
    );
    expect(e?.bucket).toBe('allow-listed');
    expect(e?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('matches lower-first style against camelCase SDK members', () => {
    const target: NestedKeyTarget = { ...exactTarget, keyStyle: 'lower-first' };
    const camelMembers = new Set(['maximumPercent', 's3filesVolumeConfiguration']);
    const [max] = classifyTarget(
      target,
      keyPaths('Top', 'MaximumPercent'),
      camelMembers,
      new Set(),
      new Map()
    );
    expect(max?.bucket).toBe('same-spelling');
    // The irregular `s3filesVolumeConfiguration` (all-lowercase prefix) is NOT
    // a first-letter flip of the CFn key — must flag unless provider-handled.
    const [s3f] = classifyTarget(
      target,
      keyPaths('Top', 'S3FilesVolumeConfiguration'),
      camelMembers,
      new Set(),
      new Map()
    );
    expect(s3f?.bucket).toBe('case-divergence');
    expect(s3f?.sdkNearMiss).toBe('s3filesVolumeConfiguration');
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

  it('findDivergences surfaces both blocking buckets through buildReport', () => {
    const entries = classifyTarget(
      exactTarget,
      keyPaths('Top', 'AcmCertificateArn', 'NoSuchMember', 'Comment'),
      sdkMembers,
      new Set(),
      new Map()
    );
    const report = buildReport([
      {
        resourceType: exactTarget.resourceType,
        providerFile: exactTarget.providerFile,
        sdkClientPackage: exactTarget.sdkClientPackage,
        keyStyle: exactTarget.keyStyle,
        freshObjectMapper: false,
        nestedKeyCount: entries.length,
        entries,
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: [],
      },
    ]);
    const divergences = findDivergences(report);
    expect(divergences.map((d) => [d.nestedKey, d.bucket])).toEqual([
      ['Top.AcmCertificateArn', 'case-divergence'],
      ['Top.NoSuchMember', 'no-sdk-member'],
    ]);
    expect(report.summary.caseDivergence).toBe(1);
    expect(report.summary.noSdkMember).toBe(1);
    expect(report.summary.sameSpelling).toBe(1);
  });

  it('findStaleAllowListEntries returns an entry that matches no audited divergence', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'GoneKey'), { rationale: 'obsolete' }],
    ]);
    const entries = classifyTarget(
      exactTarget,
      keyPaths('Top', 'Comment'),
      sdkMembers,
      new Set(),
      allow
    );
    const report = buildReport([
      {
        resourceType: exactTarget.resourceType,
        providerFile: exactTarget.providerFile,
        sdkClientPackage: exactTarget.sdkClientPackage,
        keyStyle: exactTarget.keyStyle,
        freshObjectMapper: false,
        nestedKeyCount: entries.length,
        entries,
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: [],
      },
    ]);
    expect(findStaleAllowListEntries(report, allow)).toEqual(['AWS::Fake::Thing#GoneKey']);
  });

  it('a TERMINAL-name allow entry that matched a PATH is not reported stale (#1448)', () => {
    // The audited unit is `Top.IPV6Enabled`; the entry is keyed on the bare
    // name. Re-deriving the allow key from `nestedKey` would call it stale.
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'IPV6Enabled'), { rationale: 'legacy member' }],
    ]);
    const entries = classifyTarget(
      exactTarget,
      keyPaths('Top', 'IPV6Enabled'),
      sdkMembers,
      new Set(),
      allow
    );
    expect(entries[0]?.bucket).toBe('allow-listed');
    const report = buildReport([
      {
        resourceType: exactTarget.resourceType,
        providerFile: exactTarget.providerFile,
        sdkClientPackage: exactTarget.sdkClientPackage,
        keyStyle: exactTarget.keyStyle,
        freshObjectMapper: false,
        nestedKeyCount: entries.length,
        entries,
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: [],
      },
    ]);
    expect(findStaleAllowListEntries(report, allow)).toEqual([]);
  });

  it('findDivergences surfaces both SHAPE blocking buckets through buildReport (#1378)', () => {
    const report = buildReport([
      {
        resourceType: exactTarget.resourceType,
        providerFile: exactTarget.providerFile,
        sdkClientPackage: exactTarget.sdkClientPackage,
        keyStyle: exactTarget.keyStyle,
        freshObjectMapper: false,
        nestedKeyCount: 0,
        entries: [],
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
        ],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: [],
      },
    ]);
    expect(findDivergences(report).map((d) => [d.nestedKey, d.bucket])).toEqual([
      ['WrappedList', 'array-vs-wrapper'],
      ['MovedMember', 'definition-member-missing'],
    ]);
    expect(report.summary.arrayVsWrapper).toBe(1);
    expect(report.summary.definitionMemberMissing).toBe(1);
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
    // Pick the stand-in DYNAMICALLY: most committed fixtures predate the shape
    // capture, but re-capturing any single one must not silently defuse this
    // fence. (It did — #1430 re-captured AWS::S3::Bucket, which this test had
    // hardcoded.) A minNestedKeys: 0 target passes the nestedProperties gate
    // and must still fail loudly on the missing definitionShapes.
    const fixtureDir = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
    const preShapeCapture = readdirSync(fixtureDir)
      // `readdirSync` order is filesystem-dependent (it differs between macOS
      // and the Linux CI runner), so sort for a deterministic pick. And
      // require a string `resourceType`: the directory holds at least one
      // bookkeeping file without one, which would make `loadReport` throw a
      // TypeError instead of the /definitionShapes/ error this asserts.
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8')) as Record<string, unknown>)
      .find(
        (s) => s['definitionShapes'] === undefined && typeof s['resourceType'] === 'string'
      );
    // Never let the probe pass vacuously: if every fixture has been
    // re-captured this fence needs a synthetic fixture instead of a stand-in.
    // That day WILL come — `loadReport` hardcodes the fixture dir, so there is
    // no seam to point it at a synthetic file, and the fix at that point is to
    // add one (mirroring the existing `resolveModelsDir` seam). Failing here
    // with this message is the intended way to find out.
    expect(preShapeCapture, 'no pre-shape-capture fixture left to probe with').toBeDefined();
    expect(() =>
      loadReport([
        {
          ...realTarget,
          resourceType: preShapeCapture!['resourceType'] as string,
          minNestedKeys: 0,
        },
      ])
    ).toThrow(/definitionShapes/);
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

  it('fires the write-collector NAME floor (red direction, #1432 / #1448)', () => {
    const cb = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::CodeBuild::Project')!;
    expect(() => loadReport([{ ...cb, minWrittenMembers: 100_000 }])).toThrow(
      /written-member parse .* collapsed/
    );
  });

  it('fires the write-SCOPE floor, and it is a SEPARATE fence from the name floor', () => {
    // Red direction for the second floor. Deliberately named for what it pins
    // — that the fence is wired and reachable — rather than for a scenario it
    // does not build: reaching it through `--providers-dir=` would need a
    // synthetic provider file, which proves less than the collector-level
    // scenario test below (`the two collector outputs regress independently`).
    const cb = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::CodeBuild::Project')!;
    expect(() => loadReport([{ ...cb, minWriteScopes: 100_000 }])).toThrow(
      /write-scope resolution .* collapsed/
    );
    // ...and it is NOT the name floor firing under another message.
    expect(() => loadReport([{ ...cb, minWriteScopes: 100_000 }])).not.toThrow(
      /written-member parse/
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
    // The KEY pass's strict set would NOT credit this (segment expansion is
    // shape-pass-only).
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

  it('skips keys with no same-spelled SDK member anywhere (the KEY pass domain)', () => {
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

  it('fences the #1370/#1373-fixed CloudFront keys as provider-handled', () => {
    const cf = report.targets.find((t) => t.resourceType === 'AWS::CloudFront::Distribution')!;
    for (const key of [
      'AcmCertificateArn',
      'SslSupportMethod',
      'IamCertificateId',
      'IPV6Enabled',
      'OriginCustomHeaders',
    ]) {
      expect(bucketOf(cf.entries, key), key).toBe('provider-handled');
    }
    // `OriginSSLProtocols` exists at TWO paths since the scoped literal rule
    // (#1393 item 2) split their verdicts: the MODERN path resolves through
    // its declared terminal rename, the legacy pre-2012 CustomOrigin path is
    // a path-scoped allow-list entry.
    const byPath = new Map(cf.entries.map((e) => [e.nestedKey, e.bucket]));
    expect(byPath.get('DistributionConfig.Origins.CustomOriginConfig.OriginSSLProtocols')).toBe(
      'provider-handled'
    );
    expect(byPath.get('DistributionConfig.CustomOrigin.OriginSSLProtocols')).toBe('allow-listed');
  });

  it('fences the #1373-fixed ECS S3FilesVolumeConfiguration as provider-handled', () => {
    const td = report.targets.find((t) => t.resourceType === 'AWS::ECS::TaskDefinition')!;
    expect(bucketOf(td.entries, 'S3FilesVolumeConfiguration')).toBe('provider-handled');
  });

  it('audits the S3 Bucket target with a healthy nested-key count (#1430)', () => {
    const s3 = report.targets.find((t) => t.resourceType === 'AWS::S3::Bucket');
    expect(s3).toBeDefined();
    expect(s3!.nestedKeyCount).toBeGreaterThanOrEqual(100);
  });

  it('fences the S3 keys the critic can actually discriminate as provider-handled (#1430)', () => {
    // The legacy-singular lifecycle keys' buckets depend on the provider
    // still converting them (literal + resolving terminal rename). Since the
    // scoped literal rule (#1393 item 2) the discrimination goes FURTHER than
    // the literal: `TagFilters` / `TransitionInDays` — which the old
    // file-global heuristic could never discriminate (named by the reverse
    // map too) — are now write-verified per family through their terminal
    // renames, and the strip probes below prove the write-side direction.
    const s3 = report.targets.find((t) => t.resourceType === 'AWS::S3::Bucket')!;
    for (const key of [
      'Transition',
      'NoncurrentVersionTransition',
      'NoncurrentVersionExpirationInDays',
    ]) {
      expect(bucketOf(s3.entries, key), key).toBe('provider-handled');
    }
    // EventBridgeEnabled is presence-encoded (the SDK block is an empty
    // struct), so no write evidence can exist — it carries a reviewed
    // allow-list entry since #1393 item 2.
    expect(bucketOf(s3.entries, 'EventBridgeEnabled')).toBe('allow-listed');
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
    // The eight verbatim-forwarded blobs the opt-in exists to fence are all
    // actually reached — a `handledProperties` parse that lost them would
    // leave this target vacuously clean rather than failing.
    const tops = new Set(esm!.entries.map((e) => e.topLevelProperty));
    for (const blob of [
      'SelfManagedKafkaEventSourceConfig',
      'AmazonManagedKafkaEventSourceConfig',
      'DocumentDBEventSourceConfig',
      'ScalingConfig',
      'DestinationConfig',
      'LoggingConfig',
      'MetricsConfig',
      'ProvisionedPollerConfig',
    ]) {
      expect(tops.has(blob), blob).toBe(true);
    }
  });

  it('keeps the EventSourceMapping target OUT of the write-evidence pass (verbatim forwards)', () => {
    // The decision the target comment records: the blobs are cast
    // pass-throughs, so the key pass IS the audit. If a future change makes
    // the provider hand-build SDK objects, this expectation is the prompt to
    // re-measure and opt in rather than leave the write pass silently unused.
    const esm = NESTED_KEY_TARGETS.find(
      (t) => t.resourceType === 'AWS::Lambda::EventSourceMapping'
    )!;
    expect(esm.freshObjectMapper).toBeUndefined();
    expect(esm.minWrittenMembers).toBeUndefined();
  });

  it('allow-lists only the two EventSourceMapping Tags paths, for the list-to-map fold', () => {
    const esm = report.targets.find(
      (t) => t.resourceType === 'AWS::Lambda::EventSourceMapping'
    )!;
    expect(
      esm.entries.filter((e) => e.bucket === 'allow-listed').map((e) => e.nestedKey).sort()
    ).toEqual(['Tags.Key', 'Tags.Value']);
    // The #1384 key stays visible as provider-handled: the provider names the
    // literal, which is the only evidence available for a map keyed by an
    // enum value (the class this target deliberately does NOT close).
    const byPath = new Map(esm.entries.map((e) => [e.nestedKey, e.bucket]));
    expect(byPath.get('SelfManagedEventSource.Endpoints.KafkaBootstrapServers')).toBe(
      'provider-handled'
    );
  });

  it('fences the #1304-fixed AnomalyDetector MetricTimeZone as provider-handled', () => {
    const ad = report.targets.find((t) => t.resourceType === 'AWS::CloudWatch::AnomalyDetector')!;
    expect(bucketOf(ad.entries, 'MetricTimeZone')).toBe('provider-handled');
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

  it('fences the legacy S3Origin as shape-allow-listed (invisible to the key pass)', () => {
    const cf = report.targets.find((t) => t.resourceType === 'AWS::CloudFront::Distribution')!;
    const s3Origin = cf.shapeEntries.find((e) => e.nestedKey === 'S3Origin');
    expect(s3Origin?.bucket).toBe('allow-listed');
    // The key pass must NOT list S3Origin at all — the StreamingDistribution
    // API's same-spelled member makes it same-spelling there.
    expect(bucketOf(cf.entries, 'S3Origin')).toBe('same-spelling');
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

  it('holds the API Gateway v2 opt-in floors it declares', () => {
    // Read the floors off the target table rather than restating them, so a
    // recalibration cannot leave this assertion pinning the old numbers.
    const apigw = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::ApiGatewayV2::Api')!;
    const evidence = evidenceFor('apigatewayv2-provider.ts');
    expect(evidence.written.size).toBeGreaterThanOrEqual(apigw.minWrittenMembers!);
    expect([...evidence.scopes.values()].filter((s) => s.size > 0).length).toBeGreaterThanOrEqual(
      apigw.minWriteScopes!
    );
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

  it('keeps CodeBuild independent of the walk (its opt-in predates it)', () => {
    const codebuild = NESTED_KEY_TARGETS.find(
      (t) => t.resourceType === 'AWS::CodeBuild::Project'
    )!;
    expect(codebuild.minHandoffPoints).toBeUndefined();
  });

  it('reproduces the measured opt-in table in the script header', () => {
    // The header's before/after table is a CLAIM about the real tree; this is
    // the fence that keeps it true. Every non-zero entry is a RECORDED reason a
    // target stays out, so a provider fix (or a walk improvement) has to update
    // the header rather than silently drift from it.
    const forced = NESTED_KEY_TARGETS.map((t) => ({ ...t, freshObjectMapper: true }));
    const report = loadReport(forced);
    const counts = new Map(
      report.targets.map((t) => [
        t.resourceType,
        t.entries.filter((e) => e.bucket === 'no-write-evidence').length,
      ])
    );
    expect(Object.fromEntries(counts)).toEqual({
      // 0 at opt-in (the issue #609 GraphQLApi backfill): every nested member
      // of the five config blobs is named on the forward path, and the two
      // `Tags.*` paths are allow-listed for the list-to-map fold.
      'AWS::AppSync::GraphQLApi': 0,
      // 0 at opt-in (issue #1597), but only after the fix: the opt-in run
      // itself reported 10 — `HttpConfig.AuthorizationConfig` (the drop the
      // issue named) and the `DynamoDBConfig.DeltaSyncConfig` / `.Versioned`
      // family the critic found on its own — all of which are now forwarded.
      'AWS::AppSync::DataSource': 0,
      // 0 on the FIRST run: the #609 Resolver backfill had already wired every
      // member of `CachingConfig` / `PipelineConfig` / `Runtime` / `SyncConfig`.
      'AWS::AppSync::Resolver': 0,
      'AWS::ApiGatewayV2::Api': 0,
      'AWS::ApiGatewayV2::Authorizer': 0,
      'AWS::ApiGatewayV2::Integration': 0,
      'AWS::ApiGatewayV2::Route': 0,
      'AWS::ApiGatewayV2::Stage': 0,
      'AWS::CodeBuild::Project': 0,
      'AWS::CloudFront::Distribution': 0,
      'AWS::CloudWatch::AnomalyDetector': 0,
      'AWS::ECS::Service': 0,
      'AWS::ECS::TaskDefinition': 0,
      // 0 at opt-in (issue #1393 item 3) even under the FORCED fresh-object
      // pass, which is the measurement that says the real target does not
      // need it: the provider forwards each blob verbatim
      // (`params.X = properties['X'] as <SdkType>`), so the top-level member
      // write vouches for every path beneath it and the write pass has
      // nothing left to find.
      'AWS::Lambda::EventSourceMapping': 0,
      // 81 before issue #1520 (segment renames + widened reverse-map
      // exclusion, -> 50), 0 since issue #1540 (builder-behind-binding hop,
      // for-of taint hop, scoped + terminal renames) opted the target in —
      // the trajectory is recorded in header reason (C).
      'AWS::S3::Bucket': 0,
    });
  });

  // The two tests below used to carry a MEASURED LIMITATION: with the
  // exclusion prefix-only (`readCurrentState`), the CFn-spelled writes #1495
  // added inside `readEncryption` / `readLifecycle` / `readLogging` /
  // `readReplication` landed in `evidence.written` and vouched for the forward
  // mapper — a variant with the entire WRITE half reverted still reported all
  // 17 members "written", so both tests passed on it and only the opaque count
  // pin above failed. Issue #1520 widened the exclusion to the `read*` /
  // `*ToCfn` reverse families, which makes the empty-never-written assertion a
  // REAL by-name re-drop fence; the RED-direction probe further below proves
  // that direction against the real provider source.
  it('keeps S3 reason (C) CLOSED: the opted-in target audits at ZERO, with the once-never-written spellings covered by their declared bridges (#1495/#1520/#1540)', () => {
    // Reason (C) in the header, RESOLVED in three steps this test's history
    // mirrors: #1495 wired the 20 confirmed silent drops (the original pin),
    // #1520 made the never-written set a real by-name fence (widened
    // reverse-map exclusion), and #1540 closed the structural residual and
    // opted the target in. The fence is now the OPT-IN itself — any provider
    // re-drop or bridge regression surfaces as a `no-write-evidence` entry,
    // which this asserts is empty on the REAL tree (and which `--check`
    // blocks CI with, by member name).
    const s3 = loadReport().targets.find((t) => t.resourceType === 'AWS::S3::Bucket')!;
    expect(s3.freshObjectMapper).toBe(true);
    const flagged = s3.entries
      .filter((e) => e.bucket === 'no-write-evidence')
      .map((e) => e.nestedKey)
      .sort();
    expect(flagged).toEqual([]);
    // The three CFn spellings the #1520-era fence pinned as "never written by
    // design" are now COVERED, each through its declared bridge rather than a
    // loose literal: `Enabled` via the `IsEnabled` terminal rename, the two
    // `BucketArn`s via the hand-off seed-key alias of the bag-derived
    // `Bucket: (s3Dest['BucketArn'] ?? …)` forwards. Asserted as
    // `same-spelling` (the covered verdict) so a bridge regression re-flags
    // them by name here as well as in `--check`.
    for (const path of [
      'AnalyticsConfigurations.StorageClassAnalysis.DataExport.Destination.BucketArn',
      'InventoryConfigurations.Destination.BucketArn',
      'InventoryConfigurations.Enabled',
    ]) {
      const entry = s3.entries.find((e) => e.nestedKey === path);
      expect(entry?.bucket, `${path} must be covered`).toBe('same-spelling');
    }
  });

  it('pins the #1495 members as present in the write-evidence name set', () => {
    // Companion to the fence above. Since #1520 widened the reverse-map
    // exclusion, the read-side helpers no longer contribute these CFn
    // spellings, so this now pins the FORWARD writes themselves: a provider
    // re-drop (or a walk regression) makes a name vanish and fails here by
    // member name.
    const evidence = collectWriteEvidence(
      readFileSync(join(PROVIDERS_DIR, 's3-bucket-provider.ts'), 'utf8'),
      's3-bucket-provider.ts'
    );
    for (const member of [
      'TargetObjectKeyFormat',
      'SimplePrefix',
      'PartitionedPrefix',
      'PartitionDateSource',
      'AccessControlTranslation',
      'Owner',
      'EncryptionConfiguration',
      'ReplicaKmsKeyID',
      'Metrics',
      'EventThreshold',
      'ReplicationTime',
      'SourceSelectionCriteria',
      'ReplicaModifications',
      'SseKmsEncryptedObjects',
      'TransitionDefaultMinimumObjectSize',
      'BlockedEncryptionTypes',
      'EncryptionType',
    ]) {
      expect(evidence.written.has(member), `${member} must be WRITTEN (#1495)`).toBe(true);
    }
  });

  it('RED probe (#1520): dropping a #1495 forward write is caught BY NAME, which the old prefix-only exclusion missed', () => {
    // Real-code proof of what the #1520 widening closes. Renaming every quoted
    // occurrence of `SseKmsEncryptedObjects` simulates the provider dropping
    // the member's handling entirely — the exact #1495 regression shape.
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
    // spelling, so `written` keeps the member — the documented limitation the
    // two tests above used to carry.
    const oldExclusion = collectWriteEvidence(regressed, 's3-bucket-provider.ts', [
      'readCurrentState',
    ]);
    expect(oldExclusion.written.has('SseKmsEncryptedObjects')).toBe(true);

    // Under the widened DEFAULT exclusion the reverse body no longer vouches,
    // so the member vanishes from `written` and the never-written fence above
    // fails by name on exactly this variant.
    const widened = collectWriteEvidence(regressed, 's3-bucket-provider.ts');
    expect(widened.written.has('SseKmsEncryptedObjects')).toBe(false);

    // ...and the unregressed source keeps the member under the SAME defaults,
    // so this probe cannot pass vacuously.
    const clean = collectWriteEvidence(source, 's3-bucket-provider.ts');
    expect(clean.written.has('SseKmsEncryptedObjects')).toBe(true);
  });

  it('RED probe (#1540): dropping a lifecycle BUILDER mutation is caught at its scope', () => {
    // Real-code proof of the builder-behind-binding hop: the lifecycle rules
    // are built by mutating `sdkRule` inside a `.map()` callback held in a
    // plain binding — the exact shape the hop credits. Stripping the
    // `AbortIncompleteMultipartUpload` mutation must remove the member from
    // the `LifecycleConfiguration.Rules` scope (which the opted-in write pass
    // then flags by name), and the unregressed source must carry it — the
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

  it('keeps the six #1472/#1473 ECS silent drops CLOSED (fixed, both targets opted in)', () => {
    // Reason (A) in the header, RESOLVED: the six paths this test used to pin
    // as no-write-evidence are now written by the provider (the port range
    // explicitly, the blue/green block via the pascalToCamelCaseKeys
    // hand-off), which is exactly what unblocked the ECS opt-in. Pinning the
    // shipped targets at ZERO findings — by the same flagged() extraction the
    // pre-fix pin used — is what turns each of the six from "known bug" into
    // "non-regressing": dropping any one write re-fails this test by name.
    const report = loadReport(
      NESTED_KEY_TARGETS.filter((t) => t.providerFile === 'ecs-provider.ts')
    );
    const flagged = (type: string): string[] =>
      report
        .targets.find((t) => t.resourceType === type)!
        .entries.filter((e) => e.bucket === 'no-write-evidence')
        .map((e) => e.nestedKey)
        .sort();
    expect(flagged('AWS::ECS::TaskDefinition')).toEqual([]);
    expect(flagged('AWS::ECS::Service')).toEqual([]);
    // The shipped table entries carry the opt-in (not a forced override).
    for (const t of NESTED_KEY_TARGETS.filter((x) => x.providerFile === 'ecs-provider.ts')) {
      expect(t.freshObjectMapper, t.resourceType).toBe(true);
    }
  });

  describe('re-flags the #1472/#1473 drops when their writes are deleted (real-code probes)', () => {
    // Checker rules: a fence must be proven to FAIL. Strip each fix from a
    // scratch COPY of the REAL providers tree (loadReport's providersDir
    // seam) and the shipped opted-in targets must re-surface the exact
    // pre-fix findings by name.
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-nkc-ecs-'));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    const regressedProviders = (name: string, edit: (source: string) => string): string => {
      const dir = join(scratch, name);
      cpSync(PROVIDERS_DIR, dir, { recursive: true });
      const path = join(dir, 'ecs-provider.ts');
      const before = readFileSync(path, 'utf8');
      const after = edit(before);
      expect(after, `the ${name} probe changed nothing — anchor drifted?`).not.toBe(before);
      writeFileSync(path, after);
      return dir;
    };

    const flaggedFrom = (dir: string, type: string): string[] => {
      const target = NESTED_KEY_TARGETS.find((t) => t.resourceType === type)!;
      return loadReport([target], undefined, dir)
        .targets[0]!.entries.filter((e) => e.bucket === 'no-write-evidence')
        .map((e) => e.nestedKey)
        .sort();
    };

    it('ContainerDefinitions.PortMappings.ContainerPortRange (#1472)', () => {
      const dir = regressedProviders('portrange', (source) =>
        source.replace(/^\s*containerPortRange: m\['ContainerPortRange'\] as string \| undefined,\n/m, '')
      );
      expect(flaggedFrom(dir, 'AWS::ECS::TaskDefinition')).toEqual([
        'ContainerDefinitions.PortMappings.ContainerPortRange',
      ]);
    });

    it('the LoadBalancers blue/green block (#1473)', () => {
      const dir = regressedProviders('bluegreen', (source) =>
        source.replace(
          /^\s*advancedConfiguration: lb\['AdvancedConfiguration'\]\n\s*\? \(pascalToCamelCaseKeys\(lb\['AdvancedConfiguration'\]\) as AdvancedConfiguration\)\n\s*: undefined,\n/m,
          ''
        )
      );
      expect(flaggedFrom(dir, 'AWS::ECS::Service')).toEqual([
        'LoadBalancers.AdvancedConfiguration',
        'LoadBalancers.AdvancedConfiguration.AlternateTargetGroupArn',
        'LoadBalancers.AdvancedConfiguration.ProductionListenerRule',
        'LoadBalancers.AdvancedConfiguration.RoleArn',
        'LoadBalancers.AdvancedConfiguration.TestListenerRule',
      ]);
    });
  });

  it('keeps the CloudFront Distribution opt-in at ZERO findings (#1475)', () => {
    // The positive half of the spread recognizer against REAL code: the 162
    // paths reason (D) recorded as unmeasurable are delivered by the spread
    // (bounded by the delete exclusions), except the two Tags entries that are
    // genuinely written one SDK wrapper level below the CFn chain — those must
    // stay VISIBLE as write-pass allow-list verdicts, never as silence.
    const target = NESTED_KEY_TARGETS.find(
      (t) => t.resourceType === 'AWS::CloudFront::Distribution'
    )!;
    expect(target.freshObjectMapper).toBe(true);
    const entries = loadReport([target]).targets[0]!.entries;
    expect(entries.filter((e) => e.bucket === 'no-write-evidence')).toEqual([]);
    const writeAllowed = entries
      .filter((e) => e.bucket === 'allow-listed' && e.sdkNearMiss === e.terminalKey)
      .map((e) => e.nestedKey)
      .sort();
    expect(writeAllowed).toEqual(['Tags.Key', 'Tags.Value']);
  });

  it('keeps the CloudWatch AnomalyDetector opt-in at ZERO findings (#1474)', () => {
    // The positive half of the builder recognizer against REAL code: the three
    // paths reason (B) recorded as unmeasurable were never drops, and the
    // shipped target now carries the opt-in rather than a forced override.
    const target = NESTED_KEY_TARGETS.find(
      (t) => t.resourceType === 'AWS::CloudWatch::AnomalyDetector'
    )!;
    expect(target.freshObjectMapper).toBe(true);
    expect(
      loadReport([target]).targets[0]!.entries.filter((e) => e.bucket === 'no-write-evidence')
    ).toEqual([]);
  });

  describe('re-flags the builder-delivered writes when they are deleted (real-code probes)', () => {
    // Checker rules again, now for the BUILDER recognizer: a fence that only
    // ever CLEARS is a rubber stamp, so both directions are exercised against a
    // scratch COPY of the REAL providers tree — the assignment ONTO the builder,
    // and a hand-named member inside the value that assignment carries.
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-nkc-builder-'));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    const regressed = (name: string, edit: (source: string) => string): string[] => {
      const dir = join(scratch, name);
      cpSync(PROVIDERS_DIR, dir, { recursive: true });
      const path = join(dir, 'cloudwatch-anomaly-detector-provider.ts');
      const before = readFileSync(path, 'utf8');
      const after = edit(before);
      expect(after, `the ${name} probe changed nothing — anchor drifted?`).not.toBe(before);
      writeFileSync(path, after);
      const target = NESTED_KEY_TARGETS.find(
        (t) => t.resourceType === 'AWS::CloudWatch::AnomalyDetector'
      )!;
      return loadReport([target], undefined, dir)
        .targets[0]!.entries.filter((e) => e.bucket === 'no-write-evidence')
        .map((e) => e.nestedKey)
        .sort();
    };

    it('deleting the `mapped.ExcludedTimeRanges = …` assignment re-flags all three', () => {
      expect(
        regressed('excludedranges', (source) =>
          source.replace(
            /^\s*if \(ranges !== undefined\) \{\n\s*mapped\.ExcludedTimeRanges = ranges\.map\(\(r\) => \(\{\n(?:.*\n)*?\s*\}\)\);\n\s*\}\n/m,
            ''
          )
        )
      ).toEqual([
        'Configuration.ExcludedTimeRanges',
        'Configuration.ExcludedTimeRanges.EndTime',
        'Configuration.ExcludedTimeRanges.StartTime',
      ]);
    });

    it('deleting one HAND-NAMED member inside the builder value re-flags only it', () => {
      // The precision half: the builder credit must not blanket the value it
      // carries. `StartTime` stays clean while `EndTime` flags.
      expect(
        regressed('endtime', (source) =>
          source.replace("        EndTime: toDate(r['EndTime']),\n", '')
        )
      ).toEqual(['Configuration.ExcludedTimeRanges.EndTime']);
    });
  });

  describe('the EventSourceMapping opt-in fires on a real divergence (#1393 item 3)', () => {
    // The target measures 0 findings today, which is exactly the state in
    // which a fence can be vacuous — so prove the RED direction. The realistic
    // regression for a VERBATIM forwarder is CFn-side: AWS publishes a nested
    // member under one of the forwarded blobs whose SDK spelling differs (or
    // does not exist), and the cast carries it to AWS as an unknown key with
    // no code change to notice. Injected into a scratch COPY of the fixture
    // tree via loadReport's fixtureDir seam, with the committed fixture
    // untouched.
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-nkc-esm-'));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    const withInjectedPath = (name: string, blob: string, path: string): string[] => {
      const dir = join(scratch, name);
      cpSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas'), dir, { recursive: true });
      const file = join(dir, 'AWS-Lambda-EventSourceMapping.json');
      const fixture = JSON.parse(readFileSync(file, 'utf8')) as {
        nestedPropertyPaths: Record<string, string[]>;
      };
      const before = fixture.nestedPropertyPaths[blob];
      expect(before, `${blob} missing from the capture — anchor drifted?`).toBeDefined();
      fixture.nestedPropertyPaths[blob] = [...before!, path];
      writeFileSync(file, JSON.stringify(fixture, null, 2));
      const target = NESTED_KEY_TARGETS.find(
        (t) => t.resourceType === 'AWS::Lambda::EventSourceMapping'
      )!;
      return loadReport([target], undefined, undefined, dir)
        .targets[0]!.entries.filter(
          (e) => e.bucket === 'case-divergence' || e.bucket === 'no-sdk-member'
        )
        .map((e) => `${e.bucket}:${e.nestedKey}`)
        .sort();
    };

    it('flags a nested member with NO SDK counterpart under a forwarded blob', () => {
      expect(withInjectedPath('nomember', 'ScalingConfig', 'MaximumConcurrencyLimit')).toEqual([
        'no-sdk-member:ScalingConfig.MaximumConcurrencyLimit',
      ]);
    });

    it('flags a nested member the SDK spells with different CASE', () => {
      // `MaximumPollers` exists on the SDK's ProvisionedPollerConfig; a
      // CFn-side `Maximumpollers` would ride the cast unrecognized.
      expect(
        withInjectedPath('casediverge', 'ProvisionedPollerConfig', 'Maximumpollers')
      ).toEqual(['case-divergence:ProvisionedPollerConfig.Maximumpollers']);
    });
  });
});

describe('real-code regression probes (per the repo checker rules)', () => {
  // Prove each CI-blocking verdict against REAL code: strip the real
  // provider's handling of a real key and assert the classifier flags it —
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
  const cfNestedKeys = nestedKeyPathsForTarget(cfFixture, new Set(['DistributionConfig', 'Tags']));

  // The scoped literal rule (#1393 item 2) judges these keys through the
  // write index + declared terminal renames, so every probe classifies with
  // the evidence collected from the SAME source it classifies (regressed
  // probes collect from the regressed source — differing from the unregressed
  // run ONLY by the strip).
  const cfClassify = (source: string) =>
    classifyTarget(
      cfTarget,
      cfNestedKeys,
      cfSdkMembers,
      collectStringLiterals(source),
      undefined,
      collectWriteEvidence(source, cfTarget.providerFile, REVERSE_MAP_FUNCTION_PREFIXES)
    );

  it('flags the real provider with the AcmCertificateArn conversion removed (the #1370 rename)', () => {
    const regressed = cfSource.replaceAll('AcmCertificateArn', 'XcmCertificateArn');
    const entries = cfClassify(regressed);
    const [hit] = entriesFor(entries, 'AcmCertificateArn');
    expect(hit?.bucket).toBe('case-divergence');
    // The FULL chain since #1464 — the member lives under `ViewerCertificate`,
    // which the flattened capture could not say.
    expect(hit?.nestedKey).toBe('DistributionConfig.ViewerCertificate.AcmCertificateArn');
    expect(hit?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('flags the real provider with the OriginCustomHeaders rename removed (the #1373 catch)', () => {
    const regressed = cfSource.replaceAll('OriginCustomHeaders', 'RemovedCustomHeaders');
    expect(bucketOf(cfClassify(regressed), 'OriginCustomHeaders')).toBe('no-sdk-member');
  });

  it('the unregressed real provider classifies both keys as provider-handled', () => {
    const entries = cfClassify(cfSource);
    expect(bucketOf(entries, 'AcmCertificateArn')).toBe('provider-handled');
    expect(bucketOf(entries, 'OriginCustomHeaders')).toBe('provider-handled');
  });

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

  // AWS::S3::Bucket (issue #1430). The target was added BECAUSE the #1388 /
  // #1424 lifecycle defects were fixed by hand in PR #1426 with no mechanical
  // backstop; these probes prove the critic would now reject each of those
  // conversions being removed from the REAL provider, so the fixes cannot
  // silently regress. A synthetic fixture would only encode our own model of
  // the defect (see the checker rules in .claude/rules/testing.md).
  //
  // The probed keys are chosen by MEASUREMENT: running the critic against the
  // real pre-#1426 provider flags `Transition`, `NoncurrentVersionTransition`
  // and `NoncurrentVersionExpirationInDays`, and each has exactly ONE literal
  // occurrence today, so stripping it is a regression that can really happen.
  // `TagFilters` (17 occurrences) and `TransitionInDays` (4) are excluded: the
  // extra sites are `readCurrentState`'s reverse map, so a strip-EVERY-
  // occurrence probe on them would pass while testing a shape no real
  // regression produces (#1393 item 2). An earlier draft of this file probed
  // exactly those two and was green for that reason.
  const s3Target = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::S3::Bucket')!;
  const s3Fixture = JSON.parse(
    readFileSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas/AWS-S3-Bucket.json'), 'utf8')
  ) as { nestedPropertyPaths: Record<string, string[]> };
  const s3SdkMembers = collectSdkMemberNames(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-s3/dist-types/models')
  );
  const s3Source = readFileSync(
    resolve(repoRoot, 'src/provisioning/providers/s3-bucket-provider.ts'),
    'utf8'
  );
  const s3HandledTopLevels = new Set([
    'VersioningConfiguration',
    'Tags',
    'OwnershipControls',
    'NotificationConfiguration',
    'CorsConfiguration',
    'LifecycleConfiguration',
    'PublicAccessBlockConfiguration',
    'BucketEncryption',
    'LoggingConfiguration',
    'WebsiteConfiguration',
    'AccelerateConfiguration',
    'MetricsConfigurations',
    'AnalyticsConfigurations',
    'IntelligentTieringConfigurations',
    'InventoryConfigurations',
    'ReplicationConfiguration',
    'ObjectLockConfiguration',
  ]);
  const s3NestedKeys = nestedKeyPathsForTarget(s3Fixture, s3HandledTopLevels);

  it('SDK member parse floor holds for the real S3 model (parser-regression fence)', () => {
    expect(s3SdkMembers.size).toBeGreaterThanOrEqual(50);
    // The lifecycle members the #1426 conversions map ONTO — if these vanish
    // the probes below would pass vacuously.
    expect(s3SdkMembers.has('NoncurrentDays')).toBe(true);
    expect(s3SdkMembers.has('Tags')).toBe(true);
  });

  // Each of these has exactly ONE literal site in the real provider, so
  // removing it is the regression a careless refactor actually produces.
  // `EventBridgeEnabled` left this list with #1393 item 2: it is
  // presence-encoded (no write to verify), so it is allow-list-gated now and
  // probed separately below.
  const S3_DISCRIMINATING_KEYS = [
    'Transition',
    'NoncurrentVersionTransition',
    'NoncurrentVersionExpirationInDays',
  ];

  // Classify with the evidence collected from the SAME source (see the
  // CloudFront probes above for why).
  const s3Classify = (source: string, allowList?: Map<string, AllowListEntry>) =>
    classifyTarget(
      s3Target,
      s3NestedKeys,
      s3SdkMembers,
      collectStringLiterals(source),
      allowList,
      collectWriteEvidence(source, s3Target.providerFile, REVERSE_MAP_FUNCTION_PREFIXES)
    );

  /**
   * Strip every EVIDENCE-bearing spelling of a key from the source. The
   * critic's evidence set is `collectStringLiterals`, which counts quoted
   * literals AND object-literal property names — so a probe that rewrites
   * only `'Key'` leaves a bare `Key:` behind and silently tests nothing. That
   * is not hypothetical: `EventBridgeEnabled` is quoted on the write side and
   * an object-literal key on the read side, and the first version of this
   * probe passed for exactly that reason.
   */
  const stripKeyEvidence = (source: string, key: string): string =>
    source
      .replaceAll(`'${key}'`, `'Removed${key}'`)
      // Anchored on a non-identifier boundary so probing `Transition` does not
      // also rewrite `NoncurrentVersionTransition:`. Collateral stripping could
      // only ever REMOVE evidence (each probe asserts its own key, so no false
      // pass is reachable either way), but an unanchored probe does not mean
      // what it says, and the next reader would have to re-derive that.
      .replace(new RegExp(`(^|[^A-Za-z0-9_$])${key}:`, 'g'), `$1Removed${key}:`);

  it('the probes below actually remove the key from the evidence set (probe-validity fence)', () => {
    // Self-validation, and the reason it exists: without it a future refactor
    // that introduces a THIRD evidence spelling would turn every strip-probe
    // vacuous while leaving them green.
    for (const key of S3_DISCRIMINATING_KEYS) {
      expect(collectStringLiterals(s3Source).has(key), `${key} present before`).toBe(true);
      expect(
        collectStringLiterals(stripKeyEvidence(s3Source, key)).has(key),
        `${key} still in evidence after strip`
      ).toBe(false);
    }
    // The control: TagFilters CANNOT be stripped down to zero evidence by a
    // realistic single-site regression, which is why it is not probed.
    expect(s3Source.split(`'TagFilters'`).length - 1).toBeGreaterThan(1);
  });

  for (const key of S3_DISCRIMINATING_KEYS) {
    it(`flags the real S3 provider with the ${key} conversion removed`, () => {
      const entries = s3Classify(stripKeyEvidence(s3Source, key));
      expect(bucketOf(entries, key), key).toBe('no-sdk-member');
    });
  }

  it('flags AnalyticsConfigurations.TagFilters when its write-side conversion is removed (#1393 item 2)', () => {
    // The expectation this test carried before #1393 item 2 was the honest
    // statement of the OLD limit: `readCurrentState` still names the key and
    // the evidence set was FILE-GLOBAL, so a broken write path kept the bucket
    // `provider-handled`. The scoped rule closes exactly that: the analytics
    // family's `TagFilters` is judged by its OWN terminal rename
    // (`Filter.And.Tags`) resolving against the write index, so stripping the
    // analytics And-branch write flips the path to `no-sdk-member` even though
    // every `TagFilters` literal in the file survives the strip untouched.
    const writeSite = 'analyticsConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };';
    expect(s3Source, 'write-site anchor still present').toContain(writeSite);
    const regressed = s3Source.replace(
      writeSite,
      'analyticsConfig.Filter = { And: { Prefix: prefix } };'
    );
    const byPath = new Map(s3Classify(regressed).map((e) => [e.nestedKey, e.bucket]));
    expect(byPath.get('AnalyticsConfigurations.TagFilters')).toBe('no-sdk-member');
    // The sibling families are untouched by the strip — path-scoped renames
    // cannot leak a neighbour's regression onto them.
    expect(byPath.get('MetricsConfigurations.TagFilters')).toBe('provider-handled');
    expect(byPath.get('IntelligentTieringConfigurations.TagFilters')).toBe('provider-handled');
  });

  it('lifecycle TagFilters stays allow-list-gated (the destructured-gatherScope residue)', () => {
    // The one TagFilters family the write walk still cannot see: the array
    // reaches the write as a destructured member of gatherScope's returned
    // literal (same class as its `.Key` / `.Value` write-pass entries). The
    // allow entry is load-bearing: without it the UNREGRESSED provider flags,
    // proving the key is reviewed rather than silently green.
    const byPath = new Map(s3Classify(s3Source).map((e) => [e.nestedKey, e.bucket]));
    expect(byPath.get('LifecycleConfiguration.Rules.TagFilters')).toBe('allow-listed');
    const withoutEntry = new Map(NESTED_KEY_ALLOW_LIST);
    withoutEntry.delete(allowKey('AWS::S3::Bucket', 'LifecycleConfiguration.Rules.TagFilters'));
    const stripped = new Map(s3Classify(s3Source, withoutEntry).map((e) => [e.nestedKey, e.bucket]));
    expect(stripped.get('LifecycleConfiguration.Rules.TagFilters')).toBe('no-sdk-member');
  });

  it('EventBridgeEnabled is allow-list-gated (presence-encoded, no write to verify)', () => {
    // Same load-bearing proof for the presence-encoded boolean: the SDK
    // EventBridgeConfiguration is an EMPTY struct, so no write evidence can
    // exist and the scoped rule cannot rescue it — the reviewed allow entry
    // is the fence, and removing it flags the key rather than passing green.
    const byPath = new Map(s3Classify(s3Source).map((e) => [e.nestedKey, e.bucket]));
    const path = 'NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled';
    expect(byPath.get(path)).toBe('allow-listed');
    const withoutEntry = new Map(NESTED_KEY_ALLOW_LIST);
    withoutEntry.delete(allowKey('AWS::S3::Bucket', path));
    const stripped = new Map(s3Classify(s3Source, withoutEntry).map((e) => [e.nestedKey, e.bucket]));
    expect(stripped.get(path)).toBe('no-sdk-member');
  });

  it('the unregressed real S3 provider classifies every probed key as provider-handled', () => {
    const entries = s3Classify(s3Source);
    for (const key of S3_DISCRIMINATING_KEYS) {
      expect(bucketOf(entries, key), key).toBe('provider-handled');
    }
  });

  // WRITE-EVIDENCE pass (issue #1432). Same real-code discipline: the bucket is
  // CI-blocking, so it has to be shown rejecting a REAL regression. The probed
  // defect is the one #1386 shipped and #1432 filed — `mapProperties` rebuilding
  // `buildBatchConfig` without naming `batchReportMode`.
  const cbTarget = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::CodeBuild::Project')!;
  const cbFixture = JSON.parse(
    readFileSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas/AWS-CodeBuild-Project.json'), 'utf8')
  ) as { nestedPropertyPaths: Record<string, string[]> };
  const cbSdkMembers = collectSdkMemberNames(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-codebuild/dist-types/models')
  );
  const cbSource = readFileSync(
    resolve(repoRoot, 'src/provisioning/providers/codebuild-provider.ts'),
    'utf8'
  );
  // The provider's OWN handled top-levels, exactly as `loadReport` scopes them
  // — an unhandled top-level is pre-flight-rejected by `property-coverage`, so
  // auditing its interior here would probe keys the critic never sees.
  const cbHandledTopLevel = parseProviderSource(
    cbSource,
    resolve(repoRoot, 'src/provisioning/providers/codebuild-provider.ts')
  ).handled.get('AWS::CodeBuild::Project')!;
  const cbNestedKeys = nestedKeyPathsForTarget(cbFixture, cbHandledTopLevel);
  // The FORWARD mapper's single write site. Deleting just this line reproduces
  // the #1386 defect exactly, and deliberately leaves `readCurrentState`'s
  // reverse map (`bbc['BatchReportMode'] = project.buildBatchConfig.batchReportMode`)
  // intact — the check must still fail with that vouching evidence present.
  const CB_FORWARD_WRITE =
    "batchReportMode: cfnBuildBatchConfig['BatchReportMode'] as BatchReportModeType | undefined,";

  it('CodeBuild is opted into the write-evidence pass', () => {
    expect(cbTarget.freshObjectMapper).toBe(true);
  });

  it('the forward-write anchor is still present (probe-validity fence)', () => {
    expect(cbSource).toContain(CB_FORWARD_WRITE);
  });

  it('flags the real provider with the forward batchReportMode write deleted (#1386 / #1432)', () => {
    const regressed = cbSource.replace(CB_FORWARD_WRITE, '');
    const entries = classifyTarget(
      cbTarget,
      cbNestedKeys,
      cbSdkMembers,
      collectStringLiterals(regressed),
      NESTED_KEY_ALLOW_LIST,
      collectWriteEvidence(regressed)
    );
    const [hit] = entriesFor(entries, 'BatchReportMode');
    expect(hit?.bucket).toBe('no-write-evidence');
    expect(hit?.nestedKey).toBe('BuildBatchConfig.BatchReportMode');
    expect(hit?.sdkNearMiss).toBe('batchReportMode');
    // The reverse map still writes the CFn spelling and reads the SDK one —
    // proving neither rescues the forward mapper.
    expect(regressed).toContain("bbc['BatchReportMode'] = project.buildBatchConfig.batchReportMode");
  });

  it('the SAME regression is invisible without the pass (the gap #1432 filed)', () => {
    const regressed = cbSource.replace(CB_FORWARD_WRITE, '');
    const entries = classifyTarget(
      { ...cbTarget, freshObjectMapper: false },
      cbNestedKeys,
      cbSdkMembers,
      collectStringLiterals(regressed),
      NESTED_KEY_ALLOW_LIST,
      collectWriteEvidence(regressed)
    );
    expect(bucketOf(entries, 'BatchReportMode')).toBe('same-spelling');
    expect(findDivergences(buildReport([
      {
        resourceType: cbTarget.resourceType,
        providerFile: cbTarget.providerFile,
        sdkClientPackage: cbTarget.sdkClientPackage,
        keyStyle: cbTarget.keyStyle,
        freshObjectMapper: false,
        nestedKeyCount: entries.length,
        entries,
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
        usedSegmentRenames: [],
        usedTerminalRenames: [],
      },
    ]))).toHaveLength(0);
  });

  it('the unregressed real CodeBuild provider has zero no-write-evidence keys', () => {
    const entries = classifyTarget(
      cbTarget,
      cbNestedKeys,
      cbSdkMembers,
      collectStringLiterals(cbSource),
      NESTED_KEY_ALLOW_LIST,
      collectWriteEvidence(cbSource)
    );
    expect(entries.filter((e) => e.bucket === 'no-write-evidence')).toHaveLength(0);
    // Coverage floor: the pass must be auditing a real number of key PATHS, not
    // vacuously green on an empty same-spelling set.
    expect(entries.filter((e) => e.bucket === 'same-spelling').length).toBeGreaterThanOrEqual(80);
  });

  it('FENCES a MULTIPLY-written member once evidence is path-scoped (#1448)', () => {
    // `BuildBatchConfig.ServiceRole` is the SIBLING of the member that motivated
    // #1432 and the sharpest case of the name-global bound: deleting its forward
    // write used to stay silent because the unrelated top-level `serviceRole:`
    // write carried the same spelling. Scoped evidence looks only under
    // `buildBatchConfig`, so the deletion is now a divergence.
    const anchor = "serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,";
    expect(cbSource, 'anchor still present').toContain(anchor);
    const regressed = cbSource.replace(anchor, '');
    const evidence = collectWriteEvidence(regressed);
    const entries = classifyTarget(
      cbTarget,
      cbNestedKeys,
      cbSdkMembers,
      collectStringLiterals(regressed),
      NESTED_KEY_ALLOW_LIST,
      evidence
    );
    const [hit] = entriesFor(entries, 'ServiceRole');
    expect(hit?.nestedKey).toBe('BuildBatchConfig.ServiceRole');
    expect(hit?.bucket).toBe('no-write-evidence');
    // ...and the OLD name-global evidence still contains the spelling, which is
    // what proves the scoping (not an unrelated parse change) is doing the work.
    expect(evidence.written.has('serviceRole')).toBe(true);
    expect(evidence.scopes.get('buildBatchConfig')?.has('serviceRole')).toBe(false);
  });

  it('FENCES a duplicate name INSIDE the same top-level (#1464 — the #1448 bound, inverted)', () => {
    // The INVERSION of #1448's recorded bound. The fixture then flattened
    // `Environment.Type` and `Environment.EnvironmentVariables.Type` into one
    // audited path, so deleting either write left the other vouching for it and
    // both genuine silent drops stayed silent. The per-PATH capture separates
    // them, so each deletion now names ITS OWN path — and, just as importantly,
    // leaves the cousin clean.
    const cases = [
      {
        path: 'Environment.Type',
        cousin: 'Environment.EnvironmentVariables.Type',
        anchor:
          "        type: readConfigString(\n" +
          "          environment,\n" +
          "          'Type',\n" +
          "          'LINUX_CONTAINER',\n" +
          "          'AWS::CodeBuild::Project Environment'\n" +
          "        ) as EnvironmentType,\n",
      },
      {
        path: 'Environment.EnvironmentVariables.Type',
        cousin: 'Environment.Type',
        anchor: "              type: (v.Type ?? 'PLAINTEXT') as EnvironmentVariableType,\n",
      },
    ];
    for (const { path, cousin, anchor } of cases) {
      expect(cbSource, `${path} anchor still present`).toContain(anchor);
      const regressed = cbSource.replace(anchor, '');
      const entries = classifyTarget(
        cbTarget,
        cbNestedKeys,
        cbSdkMembers,
        collectStringLiterals(regressed),
        NESTED_KEY_ALLOW_LIST,
        collectWriteEvidence(regressed)
      );
      expect(entries.find((e) => e.nestedKey === path)?.bucket, path).toBe('no-write-evidence');
      expect(entries.find((e) => e.nestedKey === cousin)?.bucket, cousin).toBe('same-spelling');
    }
    // The UNREGRESSED provider keeps both clean — so the assertions above are
    // about the deletion, not about a target that flags either way.
    const clean = classifyTarget(
      cbTarget,
      cbNestedKeys,
      cbSdkMembers,
      collectStringLiterals(cbSource),
      NESTED_KEY_ALLOW_LIST,
      collectWriteEvidence(cbSource)
    );
    for (const path of ['Environment.Type', 'Environment.EnvironmentVariables.Type']) {
      expect(clean.find((e) => e.nestedKey === path)?.bucket, path).toBe('same-spelling');
    }
  });

  it('a SECOND REAL WRITE of the same path still clears it — Source.Type (#1464)', () => {
    // #1448 also listed `source: { type: … }` as a cousin-vouching case. Under
    // per-PATH scoping the exit code is unchanged (0), and the REASON is not:
    // `mapSource`'s guard arm `return { type: 'NO_SOURCE' }` is a genuine second
    // write of `type` under `source`. Deleting BOTH arms flags. Pinned so the
    // distinction between "a real second write" and "a cousin one level down"
    // stays visible.
    const forward =
      "      type: readConfigString(source, 'Type', 'NO_SOURCE', containerPath) as SourceType,\n";
    const guard = "      return { type: 'NO_SOURCE' as SourceType };\n";
    expect(cbSource).toContain(forward);
    expect(cbSource).toContain(guard);
    const classify = (source: string): NestedKeyClassification[] =>
      classifyTarget(
        cbTarget,
        cbNestedKeys,
        cbSdkMembers,
        collectStringLiterals(source),
        NESTED_KEY_ALLOW_LIST,
        collectWriteEvidence(source)
      );
    const forwardGone = classify(cbSource.replace(forward, ''));
    expect(forwardGone.find((e) => e.nestedKey === 'Source.Type')?.bucket).toBe('same-spelling');
    // ...and it is THE GUARD ARM that supplies the evidence, not some other
    // clearing path: `source` scopes to a `type` even with the forward gone,
    // and no wildcard covers the path. Without this half a future hand-off (or
    // a looser fold) could satisfy the assertion above for the wrong reason.
    const guardOnly = collectWriteEvidence(cbSource.replace(forward, ''));
    expect(guardOnly.scopes.get('source')?.has('type')).toBe(true);
    expect(isHandoffCovered(guardOnly.handoffScopes, 'source', 'type')).toBe(false);
    const bothGone = classify(
      cbSource.replace(forward, '').replace(guard, '      return {};\n')
    );
    expect(bothGone.find((e) => e.nestedKey === 'Source.Type')?.bucket).toBe('no-write-evidence');
  });

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

  it('the two collector outputs regress independently (why there are two floors)', () => {
    // The real scenario behind `minWriteScopes`: when no write VALUE resolves to
    // a literal, every NAME is still collected and every scope is empty. The
    // name floor cannot see this; the scope floor is the only thing that can.
    const { written, scopes } = collectWriteEvidence(`
      const sdk = {
        source: external(a),
        environment: external(b),
        cache: external(c),
        artifacts: external(d),
      };
    `);
    expect([...written].sort()).toEqual(['artifacts', 'cache', 'environment', 'source']);
    expect([...scopes.values()].filter((v) => v.size > 0)).toHaveLength(0);
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

  it('the write collector sees a real provider (parser-regression floors)', () => {
    const evidence = collectWriteEvidence(cbSource);
    expect(evidence.written.size).toBeGreaterThanOrEqual(MIN_WRITTEN_MEMBERS_PER_PROVIDER);
    expect(evidence.written.size).toBeGreaterThanOrEqual(cbTarget.minWrittenMembers ?? 0);
    expect(evidence.written.has('batchReportMode')).toBe(true);
    const populated = [...evidence.scopes.values()].filter((v) => v.size > 0).length;
    expect(populated).toBeGreaterThanOrEqual(cbTarget.minWriteScopes ?? 0);
  });

  it('every write SHAPE the collector claims is anchored on REAL provider code', () => {
    // Per-SHAPE real-code floors (issue #1448 comment item 4): the aggregate
    // `written.size` floor cannot see a PARTIAL collapse — one dead shape hides
    // under it. Each assertion below names a real site in a real provider.
    const evidence = collectWriteEvidence(cbSource);
    // object-literal property: `batchReportMode: cfnBuildBatchConfig['BatchReportMode']`
    expect(evidence.written.has('batchReportMode'), 'property assignment').toBe(true);
    // shorthand property: `buildBatchConfig,` in mapProperties\' return literal
    expect(cbSource).toMatch(/^\s{6}buildBatchConfig,$/m);
    expect(evidence.written.has('buildBatchConfig'), 'shorthand property').toBe(true);
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
    expect(cfEvidence.written.has('OriginKeepaliveTimeout'), 'element access').toBe(true);
    // property-access assignment: `this.client = new CodeBuildClient(…)` is the
    // only write of `client` in the file, and it is a property access. The
    // earlier revision only regex-matched the SOURCE here and asserted nothing
    // about the collector at all.
    expect(cbSource).toContain('this.client = new CodeBuildClient(');
    expect(evidence.written.has('client'), 'property access').toBe(true);
  });

  it('the readCurrentState exclusion withdraws real reverse-map writes (#1393 item 2)', () => {
    // Measured on the real tree: `s3-bucket-provider.ts` is an `exact`-style
    // target, so its reverse map writes CFn spellings that ARE SDK member
    // spellings. Those are the names that would falsely vouch for a forward
    // mapper if the exclusion were dropped.
    const scoped = collectWrittenMemberNames(s3Source);
    const unscoped = collectWrittenMemberNames(s3Source, 's3-bucket-provider.ts', []);
    // The ECS number is the one that proves the PREFIX match earns its keep:
    // `ecs-provider.ts` splits its reverse map into `readCurrentStateService` /
    // `readCurrentStateTaskDefinition`, which an EXACT-name match reached not
    // at all (it withdrew 0). Pinned so the file header's measured numbers
    // cannot drift away from the code again.
    const ecsSource = readFileSync(
      resolve(repoRoot, 'src/provisioning/providers/ecs-provider.ts'),
      'utf8'
    );
    const ecsWithdrawn =
      collectWrittenMemberNames(ecsSource, 'ecs-provider.ts', []).size -
      collectWrittenMemberNames(ecsSource).size;
    expect(ecsWithdrawn).toBeGreaterThanOrEqual(40);

    const withdrawn = [...unscoped].filter((n) => !scoped.has(n)).sort();
    // Re-measured for #1520: the widened `read*` / `*ToCfn` exclusion
    // withdraws the whole reverse-map surface (30 names), not just the 8 the
    // original `readCurrentState`-only prefix reached — the added 22 are the
    // CFn spellings the `read<Block>` builder helpers and the `*SdkToCfn`
    // converters write on the read-back path.
    //
    // Re-measured again for #1707 / #1717 / #1718, which took the list 30 -> 27:
    // `Enabled`, `ScheduleFrequency` and `BucketArn` left it because the
    // effective-item folds (`effectiveInventoryItem` /
    // `effectiveS3BucketDestination`) now write those CFn spellings OUTSIDE any
    // reverse-map function, so they are no longer withdrawn-because-only-a-
    // reverse-map-writes-them.
    //
    // No VERDICT moved — the committed matrix does not drift a byte — and the
    // hazard that WOULD matter (a RECORDING write vouching for a forward mapper
    // that stopped writing the SDK member) was measured away rather than
    // reasoned away, on each of the two names the write pass audits. Deleting
    // the wire write from a scratch copy of the REAL provider still fails:
    //   - `IsEnabled: config['Enabled'] ?? …`
    //     -> `InventoryConfigurations.Enabled [no-write-evidence]`
    //   - `Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket'])`
    //     -> `InventoryConfigurations.Destination.BucketArn [no-write-evidence]`
    // (`ScheduleFrequency` is `provider-handled` via the key pass, so the write
    // pass never audits it.)
    //
    // Re-measured again for #1754 / #1755 / #1759, which took the list 27 -> 26:
    // `TagFilters` left it because `foldLifecycleScope` writes that CFn spelling
    // OUTSIDE any reverse-map function, the same mechanism that retired the
    // three names above. `EventBridgeEnabled` did NOT leave, and the reason is
    // worth recording because the first cut of that fold DID retire it: writing
    // the block under a COMPUTED key (`{ ...config, [EVENTBRIDGE_CONFIG_KEY]:
    // { EventBridgeEnabled } }`) — done for the #1475 hand-off reason the
    // provider states in-code — also keeps the nested member out of the
    // unscoped name set. Measured both ways.
    //
    // MEASURED, not reasoned: `--check` reports byte-identical totals before and
    // after the change (874 paths / 801 same-spelling / 51 provider-handled /
    // 22 allow-listed / 0 divergences in all three passes, run against a scratch
    // copy of the pre-change provider through the `--providers-dir=` seam), so no
    // verdict moved and the committed matrix does not drift. The hazard that
    // WOULD matter — a fold's write vouching for a forward mapper that stopped
    // writing the SDK member — was probed on the real tree rather than argued:
    // deleting `Prefix: useFilterForm ? undefined : …` from a scratch copy of the
    // provider still fails with
    // `LifecycleConfiguration.Rules.Prefix [no-write-evidence]`, although
    // `foldLifecycleScope` writes `out['Prefix']`, because the fold's writes land
    // at a path no audited chain resolves to. The EventBridge fold additionally
    // writes its block under a COMPUTED key for the #1475 reason the provider
    // states in-code.
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
    // The key pass used to accept a CFn key mentioned only by `readCurrentState`
    // as proof the FORWARD mapper converts it — the write pass excluded the
    // reverse map and the key pass did not. Measured on the real tree, applying
    // the exclusion moves no key into a blocking bucket, so this is a free
    // tightening; the assertion pins that the exclusion is actually applied.
    const scoped = collectStringLiterals(cbSource, 'codebuild-provider.ts');
    const unscoped = collectStringLiterals(cbSource, 'codebuild-provider.ts', []);
    const withdrawn = [...unscoped].filter((n) => !scoped.has(n));
    // Measured on `codebuild-provider.ts`: these CFn spellings appear ONLY in
    // `readCurrentState`, so before the exclusion each was "provider names this
    // key" evidence produced entirely by the read path.
    for (const key of ['BucketOwnerAccess', 'ResourceAccessRole', 'Value']) {
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

// The probes above all drive the library functions. This block drives the
// SHIPPED command — argv parsing, `loadReport`, the failure text and the EXIT
// CODE — because that is what CI actually runs, and because two fences (the
// write-collector floors) are unreachable any other way: `loadReport`'s
// handledProperties throw precedes them unless the providers tree itself is
// swapped. Pattern copied from `gen-handled-property-wiring.test.ts` (#1448).
describe('the shipped --check command', { timeout: 30_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'cdkd-nkc-cli-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const runCheck = (providersDir?: string): { status: number; stderr: string } => {
    const args = ['--check', ...(providersDir ? [`--providers-dir=${providersDir}`] : [])];
    const run = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.error, 'the critic must be spawnable').toBeUndefined();
    return { status: run.status ?? -1, stderr: run.stderr };
  };

  /** A scratch COPY of the REAL providers tree, with one regression injected. */
  const regressedTree = (name: string, file: string, edit: (source: string) => string): string => {
    const dir = join(scratch, name);
    cpSync(PROVIDERS_DIR, dir, { recursive: true });
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    expect(after, `the ${name} probe changed nothing — anchor drifted?`).not.toBe(before);
    writeFileSync(path, after);
    return dir;
  };

  it('exits 0 and reports its coverage on the real providers tree', () => {
    const { status, stderr } = runCheck();
    expect(status).toBe(0);
    expect(stderr).toContain('nested-key-coverage: OK');
    expect(stderr).toContain('0 divergences');
  });

  it('exits 1 naming BuildBatchConfig.ServiceRole when its forward write is deleted (#1448)', () => {
    // The issue's acceptance criterion, run end to end against REAL provider
    // source: a MULTIPLY-written member whose forward write is gone. Under the
    // name-global evidence of #1432 this exited 0.
    const dir = regressedTree('providers-scoped', 'codebuild-provider.ts', (source) =>
      source.replace("        serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,\n", '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CodeBuild::Project: BuildBatchConfig.ServiceRole');
    expect(stderr).toContain('no-write-evidence');
  });

  // The #1464 acceptance, end to end against REAL provider source: two writes of
  // `type` under ONE top-level, each fenced by its own path. Through #1448 both
  // deletions exited 0 (the flattened fixture made them the same audited unit),
  // so these are the shipped-command twins of the inverted library probes above.
  const DUPLICATE_NAME_PROBES: ReadonlyArray<{
    readonly name: string;
    readonly anchor: string;
    readonly flagged: string;
    readonly clean: string;
  }> = [
    {
      name: 'environment-type',
      anchor:
        "        type: readConfigString(\n" +
        "          environment,\n" +
        "          'Type',\n" +
        "          'LINUX_CONTAINER',\n" +
        "          'AWS::CodeBuild::Project Environment'\n" +
        "        ) as EnvironmentType,\n",
      flagged: 'AWS::CodeBuild::Project: Environment.Type',
      clean: 'Environment.EnvironmentVariables.Type',
    },
    {
      name: 'environment-variables-type',
      anchor: "              type: (v.Type ?? 'PLAINTEXT') as EnvironmentVariableType,\n",
      flagged: 'AWS::CodeBuild::Project: Environment.EnvironmentVariables.Type',
      clean: 'Environment.Type',
    },
  ];

  for (const { name, anchor, flagged, clean } of DUPLICATE_NAME_PROBES) {
    it(`exits 1 naming ${flagged.split(': ')[1]}, leaving its cousin clean (#1464)`, () => {
      const dir = regressedTree(`providers-${name}`, 'codebuild-provider.ts', (source) => {
        expect(source, `${name} anchor drifted`).toContain(anchor);
        return source.replace(anchor, '');
      });
      const { status, stderr } = runCheck(dir);
      expect(status).toBe(1);
      expect(stderr).toContain('nested-key-coverage: FAIL');
      expect(stderr).toContain(flagged);
      expect(stderr).toContain('no-write-evidence');
      // The cousin must NOT be reported — this is the half that proves the two
      // paths are separated rather than both flagging.
      expect(stderr).not.toContain(`AWS::CodeBuild::Project: ${clean} [`);
    });
  }

  it('exits 1 naming BuildBatchConfig.BatchReportMode when its forward write is deleted', () => {
    const dir = regressedTree('providers-batchreport', 'codebuild-provider.ts', (source) =>
      source.replace(
        "batchReportMode: cfnBuildBatchConfig['BatchReportMode'] as BatchReportModeType | undefined,",
        ''
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('AWS::CodeBuild::Project: BuildBatchConfig.BatchReportMode');
  });

  // WHOLE-BLOB HAND-OFF probes (issue #1445), on the newly opted-in
  // `AWS::ApiGatewayV2::Stage`. `DefaultRouteSettings` is forwarded whole at
  // TWO sites (create + update) and the scope index unions write sites, so
  // every probe below edits BOTH — see the module header's known bound (2),
  // which the first probe pins.
  const ROUTE_SETTINGS_CREATE =
    "          DefaultRouteSettings: properties['DefaultRouteSettings'] as RouteSettings | undefined,\n";
  const ROUTE_SETTINGS_UPDATE =
    "      input.DefaultRouteSettings = properties['DefaultRouteSettings'] as RouteSettings;\n";
  const editRouteSettings =
    (create: string, update: string) =>
    (source: string): string => {
      expect(source, 'create-side anchor drifted').toContain(ROUTE_SETTINGS_CREATE);
      expect(source, 'update-side anchor drifted').toContain(ROUTE_SETTINGS_UPDATE);
      return source
        .replace(ROUTE_SETTINGS_CREATE, create)
        .replace(ROUTE_SETTINGS_UPDATE, update);
    };

  it('exits 1 naming every DefaultRouteSettings member when BOTH forwards are deleted', () => {
    const dir = regressedTree(
      'providers-handoff-gone',
      'apigatewayv2-provider.ts',
      editRouteSettings('', '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const key of [
      'DataTraceEnabled',
      'DetailedMetricsEnabled',
      'LoggingLevel',
      'ThrottlingBurstLimit',
      'ThrottlingRateLimit',
    ]) {
      expect(stderr, key).toContain(`AWS::ApiGatewayV2::Stage: DefaultRouteSettings.${key}`);
    }
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 0 when only ONE of the two forwards is deleted (known bound 2, measured)', () => {
    // Hand-off points are unioned across write sites exactly as scopes are, so
    // a provider that stops forwarding on ONE path is not fenced. Recorded as a
    // bound rather than discovered later.
    const dir = regressedTree('providers-handoff-one-site', 'apigatewayv2-provider.ts', (source) =>
      source.replace(ROUTE_SETTINGS_CREATE, '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(0);
    // Not just "exit 0": assert the run actually AUDITED and found nothing, so
    // a target silently dropping out of the table cannot satisfy this probe.
    expect(stderr).toContain('nested-key-coverage: OK');
    expect(stderr).toContain('0 divergences');
    expect(stderr).toContain('14 fresh-object target(s)');
  });

  it('exits 1 naming ONLY the members a partial hand-mapping leaves out', () => {
    // The discrimination the whole issue turns on: the moment the provider
    // stops handing the blob over whole and starts naming members, every member
    // it does NOT name has to prove itself — and the one it does name passes.
    const dir = regressedTree(
      'providers-handoff-partial',
      'apigatewayv2-provider.ts',
      editRouteSettings(
        '          DefaultRouteSettings: {\n' +
          "            LoggingLevel: (properties['DefaultRouteSettings'] as RouteSettings | undefined)\n" +
          '              ?.LoggingLevel,\n' +
          '          },\n',
        '      input.DefaultRouteSettings = {\n' +
          "        LoggingLevel: (properties['DefaultRouteSettings'] as RouteSettings).LoggingLevel,\n" +
          '      };\n'
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const key of [
      'DataTraceEnabled',
      'DetailedMetricsEnabled',
      'ThrottlingBurstLimit',
      'ThrottlingRateLimit',
    ]) {
      expect(stderr, key).toContain(`AWS::ApiGatewayV2::Stage: DefaultRouteSettings.${key}`);
    }
    expect(stderr).not.toContain('DefaultRouteSettings.LoggingLevel');
  });

  it('exits 0 when the forward is routed through the REAL generic converter', () => {
    // The positive half of the acceptance: a generic-converter-delivered key
    // does NOT flag, proven end to end against real provider source and the
    // real sibling-module `pascalToCamelCaseKeys`.
    const dir = regressedTree('providers-handoff-generic', 'apigatewayv2-provider.ts', (source) =>
      "import { pascalToCamelCaseKeys } from './agentcore-case-convert.js';\n" +
      editRouteSettings(
        '          DefaultRouteSettings: pascalToCamelCaseKeys(\n' +
          "            properties['DefaultRouteSettings']\n" +
          '          ) as RouteSettings | undefined,\n',
        '      input.DefaultRouteSettings = pascalToCamelCaseKeys(\n' +
          "        properties['DefaultRouteSettings']\n" +
          '      ) as RouteSettings;\n'
      )(source)
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(0);
    expect(stderr).toContain('nested-key-coverage: OK');
  });

  it('exits 1 on the SAME shape when the blob is not read off the property bag', () => {
    // Identical syntax, different origin: the taint root is what stops an
    // AWS-response echo from counting as a template forward.
    const dir = regressedTree('providers-handoff-untainted', 'apigatewayv2-provider.ts', (source) =>
      source
        .replace(
          ROUTE_SETTINGS_CREATE,
          "          DefaultRouteSettings: this.echoed['DefaultRouteSettings'] as RouteSettings | undefined,\n"
        )
        .replace(
          ROUTE_SETTINGS_UPDATE,
          "      input.DefaultRouteSettings = this.echoed['DefaultRouteSettings'] as RouteSettings;\n"
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('AWS::ApiGatewayV2::Stage: DefaultRouteSettings.LoggingLevel');
  });

  it('exits 1 on a collapsed hand-off walk, naming the walk (not 13 divergences)', () => {
    // Renaming the desired-state bag out of `HANDOFF_BAG_PARAM_NAMES` is a real
    // shape of collapse: every write NAME and every SCOPE survives, so only the
    // dedicated floor can name the cause.
    const dir = regressedTree('providers-handoff-collapsed', 'apigatewayv2-provider.ts', (source) =>
      source.replaceAll(/\bproperties\b/g, 'bag')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('whole-blob hand-off walk for apigatewayv2-provider.ts collapsed');
    expect(stderr).toContain('parser regression?');
    expect(stderr).not.toContain('no-write-evidence');
  });

  it('exits 1 on a collapsed write-collector parse, naming the parser (not 90 divergences)', () => {
    // Renaming the forward mappers into the reverse-map prefix is a real shape
    // of collapse (the exclusion swallows them), and it is the ONLY way to
    // reach `MIN_WRITTEN_MEMBERS_PER_PROVIDER` — hence the providers-dir seam.
    const dir = regressedTree('providers-collapsed', 'codebuild-provider.ts', (source) => {
      let out = source;
      for (const name of ['mapProperties', 'mapSource', 'mapArtifacts']) {
        out = out.replaceAll(name, `readCurrentState${name[0]!.toUpperCase()}${name.slice(1)}`);
      }
      return out;
    });
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('written-member parse for codebuild-provider.ts collapsed');
    expect(stderr).toContain('parser regression?');
    // ...and NOT a wall of bogus per-key divergences.
    expect(stderr).not.toContain('no-write-evidence');
  });

  // One spawned case per CI-BLOCKING verdict, per the repo's checker rules —
  // "each" means each, and four of these were previously proven only through
  // the library functions. Each regression below is the same one the
  // corresponding library-level probe injects, so the two stay in step.
  const BLOCKING_VERDICT_PROBES: ReadonlyArray<{
    readonly bucket: string;
    readonly file: string;
    readonly named: string;
    readonly edit: (source: string) => string;
  }> = [
    {
      bucket: 'no-sdk-member',
      file: 'cloudfront-distribution-provider.ts',
      named: 'OriginCustomHeaders',
      edit: (source) => source.replaceAll('OriginCustomHeaders', 'RemovedCustomHeaders'),
    },
    {
      bucket: 'case-divergence',
      file: 'cloudfront-distribution-provider.ts',
      named: 'AcmCertificateArn',
      edit: (source) => source.replaceAll('AcmCertificateArn', 'XcmCertificateArn'),
    },
    {
      bucket: 'array-vs-wrapper',
      file: 'cloudfront-distribution-provider.ts',
      named: 'Aliases',
      edit: (source) => source.replaceAll('Aliases', 'Xliases'),
    },
    {
      bucket: 'definition-member-missing',
      file: 'cloudfront-distribution-provider.ts',
      named: 'CachedMethods',
      edit: (source) => source.replaceAll('CachedMethods', 'XachedMethods'),
    },
  ];

  for (const { bucket, file, named, edit } of BLOCKING_VERDICT_PROBES) {
    it(`exits 1 naming a real ${bucket} divergence from the seam`, () => {
      const dir = regressedTree(`providers-${bucket}`, file, edit);
      const { status, stderr } = runCheck(dir);
      expect(status).toBe(1);
      expect(stderr).toContain('nested-key-coverage: FAIL');
      expect(stderr).toContain(named);
      expect(stderr).toContain(bucket);
    });
  }

  it('exits 1 when a BUILDER-delivered write is deleted (#1474)', () => {
    // The library-level twin of this probe asserts the FINDING SET; this one
    // asserts the shipped process EXIT CODE, which is what CI acts on.
    // CloudWatch AnomalyDetector is the write-evidence pass's first
    // builder-dependent opt-in, so "a CloudWatch finding actually exits 1" has
    // to be proven, not inferred from the sibling ECS probes (#1474 review).
    const dir = regressedTree(
      'providers-builder-assignment',
      'cloudwatch-anomaly-detector-provider.ts',
      (source) =>
        source.replace(
          /^\s*if \(ranges !== undefined\) \{\n\s*mapped\.ExcludedTimeRanges = ranges\.map\(\(r\) => \(\{\n(?:.*\n)*?\s*\}\)\);\n\s*\}\n/m,
          ''
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CloudWatch::AnomalyDetector');
    expect(stderr).toContain('Configuration.ExcludedTimeRanges');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 naming ONLY the hand-named member deleted inside a builder value (#1474)', () => {
    // The precision half at the exit-code level: the builder credit must not
    // blanket the value it carries, so `StartTime` must stay out of the report.
    const dir = regressedTree(
      'providers-builder-member',
      'cloudwatch-anomaly-detector-provider.ts',
      (source) => source.replace("        EndTime: toDate(r['EndTime']),\n", '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('Configuration.ExcludedTimeRanges.EndTime');
    expect(stderr).not.toContain('Configuration.ExcludedTimeRanges.StartTime');
  });

  it('exits 1 naming DistributionConfig.IPV6Enabled when the rename map entry is deleted (#1475)', () => {
    // The issue's REQUIRED fence: the spread recognizer must not turn the
    // CloudFront opt-in into a rubber stamp, so deleting the
    // `IPV6Enabled -> IsIPV6Enabled` rename from the real provider must still
    // exit non-zero. The failing pass is the KEY pass (`case-divergence` — the
    // map entry carried the only literal evidence for the CFn spelling, and
    // the installed SDK model carries `Ipv6Enabled` as the near-miss), which
    // is precisely why the write-pass wildcard cannot silence it: the deleted
    // key is EXCLUDED from the spread's credit, and the key pass judges the
    // non-SDK spelling at full strictness regardless.
    const dir = regressedTree(
      'providers-spread-rename',
      'cloudfront-distribution-provider.ts',
      (source) => source.replace("  IPV6Enabled: 'IsIPV6Enabled',\n", '')
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CloudFront::Distribution: DistributionConfig.IPV6Enabled');
    expect(stderr).toContain('case-divergence');
  });

  it('exits 1 when a same-spelling member is deleted off the spread seed (#1475)', () => {
    // The DELETE-EXCLUSION fence live on real code: inserting
    // `delete result['Aliases']` after the spread removes the member from the
    // delivered object, so the wildcard must stop vouching for it.
    const dir = regressedTree(
      'providers-spread-delete',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          "    const result = { ...config };\n    delete result['Aliases'];\n"
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('AWS::CloudFront::Distribution: DistributionConfig.Aliases');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 on an UNRESOLVABLE delete key — the registration refuses fail-closed (#1475)', () => {
    // A delete whose key set cannot be bounded must refuse the WHOLE spread
    // credit, which re-flags the entire wildcard-covered interior — the loud
    // direction, proven at the exit-code level.
    const dir = regressedTree(
      'providers-spread-unresolvable',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          '    const result = { ...config };\n' +
            '    const dynamicKey = Object.keys(config)[0]!;\n' +
            '    delete result[dynamicKey];\n'
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('nested-key-coverage: FAIL');
    expect(stderr).toContain('no-write-evidence');
  });

  it('exits 1 when the spread seed stops being bag-derived (#1475)', () => {
    // Every CloudFront hand-off point derives from the root spread (the nested
    // seeds spread `result['X']`, whose taint flows from `{ ...config }`), so
    // removing the seed collapses the walk to zero points and the
    // `minHandoffPoints` floor fires — one legible error, not 160 findings.
    // This is the collapse mode that floor exists for, proven on real code.
    const dir = regressedTree(
      'providers-spread-seedless',
      'cloudfront-distribution-provider.ts',
      (source) =>
        source.replace(
          '    const result = { ...config };\n',
          '    const result: Record<string, unknown> = {};\n'
        )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('whole-blob hand-off walk for cloudfront-distribution-provider.ts');
    expect(stderr).toContain('collapsed to 0 blob-carrying hand-off point(s)');
  });

  it('exits 1 naming a STALE segmentRenames entry (#1464)', () => {
    // The other staleness fence, proven RED against real code. Renaming the SDK
    // member `properties` back to the CFn spelling makes the un-renamed chain
    // resolve, so `ProxyConfigurationProperties -> properties` stops earning
    // its place and must be reported rather than left as an inert exception —
    // the discipline `NESTED_KEY_ALLOW_LIST` has carried since #1373.
    const dir = regressedTree('providers-stale-rename', 'ecs-provider.ts', (source) =>
      source.replace(
        "      properties: this.convertEnvironment(\n",
        "      proxyConfigurationProperties: this.convertEnvironment(\n"
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale segmentRenames');
    expect(stderr).toContain('AWS::ECS::TaskDefinition#ProxyConfigurationProperties');
  });

  it('exits 1 on the ECS ProxyConfiguration children when the rename map is the only bridge', () => {
    // The POSITIVE half, inverted: the rename exists because deleting the
    // provider's write must still flag. Strip the `properties:` write entirely
    // and the two children re-surface by name — which is what proves the map is
    // a spelling bridge, not a silencer.
    const dir = regressedTree('providers-proxy-props-gone', 'ecs-provider.ts', (source) =>
      source.replace(
        "      properties: this.convertEnvironment(\n" +
          "        config['ProxyConfigurationProperties'] as Array<Record<string, unknown>> | undefined\n" +
          '      ),\n',
        ''
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    for (const key of ['Name', 'Value']) {
      expect(stderr, key).toContain(
        `AWS::ECS::TaskDefinition: ProxyConfiguration.ProxyConfigurationProperties.${key}`
      );
    }
  });

  it('exits 1 when a target fixture has no nestedPropertyPaths capture (#1464)', () => {
    // The RED direction of `loadReport`'s new loud failure, the twin of the
    // `definitionShapes` probe. A fixture tree that was only PARTIALLY
    // re-captured must name the missing capture and the command that fixes it,
    // not silently audit zero paths.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'cdkd-nkc-fx-'));
    cpSync(resolve(repoRoot, 'tests/fixtures/cfn-schemas'), fixtureDir, { recursive: true });
    const path = join(fixtureDir, 'AWS-CodeBuild-Project.json');
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete fixture['nestedPropertyPaths'];
    writeFileSync(path, JSON.stringify(fixture, null, 2));
    const target = NESTED_KEY_TARGETS.find((t) => t.resourceType === 'AWS::CodeBuild::Project')!;
    expect(() => loadReport([target], undefined, undefined, fixtureDir)).toThrow(
      /has no nestedPropertyPaths capture/
    );
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('exits 1 naming a STALE allow-list entry', () => {
    // The stale-entry fence, red-proven through the scoped literal rule
    // (#1393 item 2). A floating literal can no longer flip a key to
    // `provider-handled` (that rubber stamp is exactly what the rule
    // removed — the HostKernel form this probe used pre-#1393 now
    // correctly changes nothing), so the probe targets an entry whose
    // SCOPED evidence already exists: `CorsConfiguration.CorsRules` is
    // allow-listed only because the provider reads the CFn key via typed
    // property access — the write index already carries the ci-matching
    // SDK member `CORSRules` at the resolved parent scope. Naming the
    // literal makes the key `provider-handled`, the entry stops matching,
    // and `--check` must report it rather than silently keep it.
    const dir = regressedTree('providers-stale', 's3-bucket-provider.ts', (source) =>
      source.replace(
        'export class S3BucketProvider',
        "const NAMES_THE_KEY = ['CorsRules'];\nvoid NAMES_THE_KEY;\nexport class S3BucketProvider"
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale NESTED_KEY_ALLOW_LIST');
    expect(stderr).toContain('AWS::S3::Bucket#CorsConfiguration.CorsRules');
  });

  it('rejects an unrecognized flag instead of falling through to WRITER mode', () => {
    // `--chekc` used to REWRITE the committed matrix and exit 0 — the same
    // silent-full-run trap `refresh-cfn-schemas.mjs --help` had before its
    // guard (#1378 rider). The SPACE form of the seam is caught here too: it
    // does not match the `--providers-dir=` prefix, so without this guard it
    // would slip into the writer path.
    for (const flag of ['--chekc', '-c', '--providers-dir']) {
      const run = spawnSync(process.execPath, [SCRIPT, flag, '/tmp'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(run.status, flag).toBe(1);
      expect(run.stderr, flag).toContain('Usage:');
      expect(run.stdout, flag).not.toContain('wrote nested-key-coverage');
    }
  });

  it('--help prints usage and exits 0 without writing anything', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage:');
    expect(run.stderr).not.toContain('wrote nested-key-coverage');
  });

  it('refuses --providers-dir= in WRITER mode instead of rewriting the matrix', () => {
    // Without the guard the seam renders docs/_generated from a scratch tree.
    const run = spawnSync(process.execPath, [SCRIPT, `--providers-dir=${PROVIDERS_DIR}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--check-only test seam');
  });
});

describe('target-table hygiene', { timeout: 30_000 }, () => {
  it('every freshObjectMapper target declares BOTH write floors (#1448)', () => {
    // `minWrittenMembers` falls back to MIN_WRITTEN_MEMBERS_PER_PROVIDER, but
    // `minWriteScopes` is skipped entirely when undefined — deliberately, since
    // real-tree scope counts span 51 down to 1 and no shared default is a real
    // fence. That decline is only defensible if opting in FORCES the target to
    // declare its own, which is what this test makes true.
    for (const t of NESTED_KEY_TARGETS.filter((x) => x.freshObjectMapper === true)) {
      expect(t.minWrittenMembers, `${t.resourceType} minWrittenMembers`).toBeGreaterThan(0);
      expect(t.minWriteScopes, `${t.resourceType} minWriteScopes`).toBeGreaterThan(0);
    }
  });

  // Explicit timeouts on the three hygiene probes below: each re-classifies
  // EVERY opted-in target from source, so their cost grows with the audited
  // path set rather than with the change under test. This one measured 7.3s
  // locally and 31.8s on CI right after the #609 API Gateway v2 backfill added
  // its nested paths — i.e. it blew the 30s default without anything being
  // wrong. The values are ~4x the observed CI time so the next target to opt
  // in does not re-break them.
  const HYGIENE_PROBE_TIMEOUT_MS = 120_000;

  it('a WALK-DEPENDENT opt-in must declare minHandoffPoints (#1445)', () => {
    // "Walk-dependent" is derived, not judged: re-classify the target with its
    // hand-off points stripped and see whether anything flips to
    // `no-write-evidence`. A target that only reaches 0 findings BECAUSE of the
    // walk has to carry the walk's own floor; CodeBuild, which reaches 0 on
    // per-member writes alone, must NOT (its provider hands nothing off, so a
    // floor would fail on correct code).
    for (const target of NESTED_KEY_TARGETS.filter((t) => t.freshObjectMapper === true)) {
      const withoutWalk = loadReport([{ ...target, minHandoffPoints: undefined }]).targets[0]!;
      const source = readFileSync(join(PROVIDERS_DIR, target.providerFile), 'utf8');
      const evidence = collectWriteEvidence(source, target.providerFile, ['readCurrentState'], (s) =>
        s === './agentcore-case-convert.js' ? CASE_CONVERT_SOURCE : undefined
      );
      const stripped = classifyTarget(
        target,
        nestedKeyPathsForTarget(
          JSON.parse(
            readFileSync(
              resolve(
                repoRoot,
                `tests/fixtures/cfn-schemas/${target.resourceType.replace(/::/g, '-')}.json`
              ),
              'utf8'
            )
          ) as { nestedPropertyPaths?: Record<string, string[]> },
          parseProviderSource(source, join(PROVIDERS_DIR, target.providerFile)).handled.get(
            target.resourceType
          )!
        ),
        collectSdkMemberNames(
          resolve(repoRoot, `node_modules/${target.sdkClientPackage}/dist-types/models`)
        ),
        collectStringLiterals(source, target.providerFile),
        NESTED_KEY_ALLOW_LIST,
        { ...evidence, handoffScopes: new Set<string>() }
      );
      const walkDependent = stripped.some((e) => e.bucket === 'no-write-evidence');
      expect(withoutWalk.entries.filter((e) => e.bucket === 'no-write-evidence')).toEqual([]);
      if (walkDependent) {
        expect(
          target.minHandoffPoints,
          `${target.resourceType} clears only via the hand-off walk, so it must declare minHandoffPoints`
        ).toBeGreaterThan(0);
      } else if (stripped.length > 0) {
        // A target with audited paths that clears WITHOUT the walk must not
        // declare the floor — its provider hands nothing off, so the floor
        // would fail on correct code. (`ApiGatewayV2::Integration` / `::Route`
        // audit ZERO paths, so they are neither dependent nor independent; they
        // inherit the file's shared floors and are skipped here.)
        expect(
          target.minHandoffPoints,
          `${target.resourceType} does not depend on the walk, so minHandoffPoints would fence nothing`
        ).toBeUndefined();
      }
    }
  }, HYGIENE_PROBE_TIMEOUT_MS);

  it('the write floors are calibrated to their measured yields (#1445)', () => {
    // The `minNestedKeys` band below has kept that floor honest; the WRITE
    // floors had no equivalent, so `minHandoffPoints: 20` sat above a
    // meaningful count of 3 and fenced nothing. Every floor must be at or below
    // what the provider actually yields, and `minWrittenMembers` must stay
    // within a band of it.
    for (const target of NESTED_KEY_TARGETS.filter((t) => t.freshObjectMapper === true)) {
      const source = readFileSync(join(PROVIDERS_DIR, target.providerFile), 'utf8');
      const evidence = collectWriteEvidence(source, target.providerFile, ['readCurrentState'], (s) =>
        s === './agentcore-case-convert.js' ? CASE_CONVERT_SOURCE : undefined
      );
      const label = target.resourceType;
      expect(target.minWrittenMembers!, `${label} minWrittenMembers above yield`).toBeLessThanOrEqual(
        evidence.written.size
      );
      expect(target.minWrittenMembers!, `${label} minWrittenMembers too slack`).toBeGreaterThanOrEqual(
        Math.floor(evidence.written.size * 0.5)
      );
      const scopes = [...evidence.scopes.values()].filter((s) => s.size > 0).length;
      expect(target.minWriteScopes!, `${label} minWriteScopes above yield`).toBeLessThanOrEqual(
        scopes
      );
      // ...and banded from BELOW like `minWrittenMembers`, which it was not
      // until the #1464 review pointed out the asymmetry: an upper bound alone
      // lets a floor drift arbitrarily far under the yield and fence nothing.
      // The band is looser (0.25 vs 0.5) because this count is the one that
      // legitimately collapses toward 1 on a blob-forwarding provider — API
      // Gateway v2 measures exactly 1, which is why the floor there is 1 and is
      // recorded as fencing nothing.
      expect(target.minWriteScopes!, `${label} minWriteScopes too slack`).toBeGreaterThanOrEqual(
        Math.floor(scopes * 0.25)
      );
      if (target.minHandoffPoints !== undefined) {
        const expanding = countExpandingHandoffPoints(
          evidence,
          collectSdkInterfaces(
            resolve(repoRoot, `node_modules/${target.sdkClientPackage}/dist-types/models`)
          )
        );
        // Redundant-by-construction rather than vacuous, and worth saying so:
        // a floor ABOVE the yield makes the SHIPPED floor throw at load time,
        // so `loadReport()` in this file's other describes aborts the whole
        // suite before this assertion runs (measured by setting it to 5 against
        // a yield of 3). It stays as the assertion that NAMES the miscalibration
        // if the runtime floor is ever relaxed.
        expect(
          target.minHandoffPoints,
          `${label} minHandoffPoints above yield`
        ).toBeLessThanOrEqual(expanding);
        // …and deliberately NOT banded from below the way minWrittenMembers is.
        // A floor AT the measurement turns every provider-side change into
        // "parser regression?" instead of the divergences it really causes; the
        // collapse mode this floor exists for yields 0, so >= 1 is the fence.
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
