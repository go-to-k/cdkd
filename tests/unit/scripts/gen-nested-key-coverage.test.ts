import { afterAll, describe, it, expect } from 'vite-plus/test';
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
  allowKey,
  buildReport,
  classifyTarget,
  classifyTargetShapes,
  collectSdkInterfaces,
  collectSdkMemberNames,
  collectStringLiterals,
  collectWriteEvidence,
  collectWrittenMemberNames,
  expandLiteralSegments,
  findDivergences,
  findStaleAllowListEntries,
  loadReport,
  lowerFirst,
  lookupAllowEntry,
  nestedKeyPathsForTarget,
  wrapperInterfaceNames,
  type NestedKeyClassification,
  type NestedKeyPath,
  type NestedKeyTarget,
  type ProviderWriteEvidence,
  type SdkMemberType,
} from '../../../scripts/gen-nested-key-coverage.ts';
import {
  extractDefinitionShapes,
  extractNestedPropertyNames,
} from '../../../scripts/refresh-cfn-schemas.mjs';
import { parseProviderSource } from '../../../scripts/gen-property-coverage.ts';

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
 * Build the PATH-shaped audited units the classifier takes since #1448. Every
 * synthetic probe hangs its keys off one top-level so the scoped write lookup
 * has something to resolve against.
 */
const keyPaths = (topLevelProperty: string, ...keys: string[]): NestedKeyPath[] =>
  keys.map((key) => ({ topLevelProperty, key, path: `${topLevelProperty}.${key}` }));

/** Build write evidence from a `{ scopeName: [membersBeneathIt] }` sketch. */
const writeEvidence = (scopes: Record<string, readonly string[]>): ProviderWriteEvidence => ({
  written: new Set(Object.values(scopes).flat()),
  scopes: new Map(Object.entries(scopes).map(([k, v]) => [k, new Set(v)])),
});

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

  it('the exclusion prefix respects a word boundary', () => {
    // `readCurrentStateless…` is a different function and must NOT be swallowed.
    const written = collectWrittenMemberNames(`
      function readCurrentStatelessThing() { return { stillCounted: 1 }; }
      function readCurrentStateService() { return { notCounted: 1 }; }
    `);
    expect(written.has('stillCounted')).toBe(true);
    expect(written.has('notCounted')).toBe(false);
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

  it('records a member written ANY depth beneath the scope (the fixture is flat)', () => {
    // `nestedProperties` flattens the whole interior of a top-level property,
    // so `BuildBatchConfig.ComputeTypesAllowed` is an audited path even though
    // the member lives under `Restrictions`. The scope has to match that depth.
    const { scopes } = collectWriteEvidence(`
      const sdk = { buildBatchConfig: { restrictions: { computeTypesAllowed: [] } } };
    `);
    expect(scopes.get('buildBatchConfig')?.has('computeTypesAllowed')).toBe(true);
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
      // the CFn spellings written — wrong side, on both segments
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
    const [e] = classifyTarget(
      exactTarget,
      keyPaths('Top', 'AcmCertificateArn'),
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map()
    );
    expect(e?.bucket).toBe('provider-handled');
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

describe('nestedKeyPathsForTarget', () => {
  it('yields one PATH per (handled top-level, nested key) pair (#1448)', () => {
    const fixture = {
      nestedProperties: {
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

  it('de-duplicates a repeated name within one top-level', () => {
    const paths = nestedKeyPathsForTarget(
      { nestedProperties: { Handled: ['A', 'A'] } },
      new Set(['Handled'])
    );
    expect(paths.map((p) => p.path)).toEqual(['Handled.A']);
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
      'OriginSSLProtocols',
      'OriginCustomHeaders',
    ]) {
      expect(bucketOf(cf.entries, key), key).toBe('provider-handled');
    }
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
    // These four are the ONLY S3 keys whose bucket depends on the provider
    // still converting them: each has exactly ONE literal occurrence, so
    // removing that site flips it to `no-sdk-member`. Measured, not assumed —
    // running the critic against the real pre-#1426 provider flags exactly
    // these (minus EventBridgeEnabled, which #1430 itself introduced).
    //
    // `TagFilters` / `TransitionInDays` are deliberately NOT here: both are
    // named by `readCurrentState`'s reverse map too, so the file-global
    // literal heuristic reports `provider-handled` even with the write-side
    // conversion gone. Fencing them would pin a value that cannot change
    // (#1393 item 2).
    const s3 = report.targets.find((t) => t.resourceType === 'AWS::S3::Bucket')!;
    for (const key of [
      'Transition',
      'NoncurrentVersionTransition',
      'NoncurrentVersionExpirationInDays',
      'EventBridgeEnabled',
    ]) {
      expect(bucketOf(s3.entries, key), key).toBe('provider-handled');
    }
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
  ) as { nestedProperties: Record<string, string[]> };
  const cfSdkMembers = collectSdkMemberNames(
    resolve(repoRoot, 'node_modules/@aws-sdk/client-cloudfront/dist-types/models')
  );
  const cfSource = readFileSync(
    resolve(repoRoot, 'src/provisioning/providers/cloudfront-distribution-provider.ts'),
    'utf8'
  );
  const cfNestedKeys = nestedKeyPathsForTarget(cfFixture, new Set(['DistributionConfig', 'Tags']));

  it('flags the real provider with the AcmCertificateArn conversion removed (the #1370 rename)', () => {
    const regressed = cfSource.replaceAll('AcmCertificateArn', 'XcmCertificateArn');
    const literals = collectStringLiterals(regressed);
    const entries = classifyTarget(cfTarget, cfNestedKeys, cfSdkMembers, literals);
    const [hit] = entriesFor(entries, 'AcmCertificateArn');
    expect(hit?.bucket).toBe('case-divergence');
    expect(hit?.nestedKey).toBe('DistributionConfig.AcmCertificateArn');
    expect(hit?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('flags the real provider with the OriginCustomHeaders rename removed (the #1373 catch)', () => {
    const regressed = cfSource.replaceAll('OriginCustomHeaders', 'RemovedCustomHeaders');
    const literals = collectStringLiterals(regressed);
    const entries = classifyTarget(cfTarget, cfNestedKeys, cfSdkMembers, literals);
    expect(bucketOf(entries, 'OriginCustomHeaders')).toBe('no-sdk-member');
  });

  it('the unregressed real provider classifies both keys as provider-handled', () => {
    const literals = collectStringLiterals(cfSource);
    const entries = classifyTarget(cfTarget, cfNestedKeys, cfSdkMembers, literals);
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
  ) as { nestedProperties: Record<string, string[]> };
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
  const S3_DISCRIMINATING_KEYS = [
    'Transition',
    'NoncurrentVersionTransition',
    'NoncurrentVersionExpirationInDays',
    'EventBridgeEnabled',
  ];

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
      const entries = classifyTarget(
        s3Target,
        s3NestedKeys,
        s3SdkMembers,
        collectStringLiterals(stripKeyEvidence(s3Source, key))
      );
      expect(bucketOf(entries, key), key).toBe('no-sdk-member');
    });
  }

  it('does NOT flag TagFilters when only its write-side conversion is removed', () => {
    // The honest statement of the critic's limit, pinned so nobody re-adds the
    // false "TagFilters would have been caught" claim. `readCurrentState`
    // still names the key, and the evidence set is file-global, so the write
    // path can be entirely broken while the bucket stays `provider-handled`.
    // Tracked as item 2 of #1393; when that lands, this expectation flips.
    const writeSite = "(filter?.['TagFilters'] ?? rule['TagFilters'])";
    expect(s3Source, 'write-site anchor still present').toContain(writeSite);
    const regressed = s3Source.replace(writeSite, '(undefined)');
    const entries = classifyTarget(
      s3Target,
      s3NestedKeys,
      s3SdkMembers,
      collectStringLiterals(regressed)
    );
    expect(bucketOf(entries, 'TagFilters')).toBe('provider-handled');
  });

  it('the unregressed real S3 provider classifies every probed key as provider-handled', () => {
    const entries = classifyTarget(
      s3Target,
      s3NestedKeys,
      s3SdkMembers,
      collectStringLiterals(s3Source)
    );
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
  ) as { nestedProperties: Record<string, string[]> };
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

  it('DOES NOT fence a duplicate name INSIDE the same top-level (recorded bound, #1448)', () => {
    // The bound path-scoping narrows but does not close, pinned so nobody
    // writes "membership makes this non-regressing" again. The fixture's
    // `nestedProperties` capture is FLATTENED per top-level, so
    // `Environment.Type` and `Environment.EnvironmentVariables[].Type` are the
    // SAME audited path — and the scope index is flattened to match, so the
    // surviving sibling write vouches for the deleted one. Both deletions below
    // are GENUINE silent drops that stay silent; closing them needs a per-PATH
    // fixture capture (a `refresh-cfn-schemas.mjs` change + an AWS re-capture),
    // which is bigger than this critic.
    const cases = [
      {
        top: 'Environment',
        anchor:
          "        type: ((environment?.['Type'] as string) ?? 'LINUX_CONTAINER') as EnvironmentType,\n",
        survivor: 'environmentVariables[].type',
      },
      {
        top: 'Source',
        anchor: "      type: ((source['Type'] as string) ?? 'NO_SOURCE') as SourceType,\n",
        survivor: 'auth.type',
      },
    ];
    for (const { top, anchor, survivor } of cases) {
      expect(cbSource, `${top} anchor still present`).toContain(anchor);
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
      const hit = entries.find((e) => e.nestedKey === `${top}.Type`);
      expect(hit, `${top}.Type is audited`).toBeDefined();
      expect(hit?.bucket, `${top}.Type stays silent (covered by ${survivor})`).toBe(
        'same-spelling'
      );
      expect(evidence.scopes.get(lowerFirst(top))?.has('type')).toBe(true);
    }
  });

  it('scopes are keyed by NAME and unioned across write sites (recorded bound, #1448)', () => {
    // The name-global weakness reappearing one level down: `record()` merges
    // every write of a name, so two unrelated literals contribute to one scope
    // and a name that only ever appears NESTED still gets a scope of its own.
    const { scopes } = collectWriteEvidence(`
      class P {
        a() { return { environment: { alpha: 1 } }; }
        b() { return { environment: { beta: 2 } }; }
        c() { return { logsConfig: { cloudWatchLogs: { groupName: 3 } } }; }
      }
    `);
    // Unrelated write sites of the same name are indistinguishable...
    expect([...(scopes.get('environment') ?? [])].sort()).toEqual(['alpha', 'beta']);
    // ...and a purely nested name still yields a scope that a TOP-LEVEL CFn
    // property of that spelling would be checked against.
    expect([...(scopes.get('cloudWatchLogs') ?? [])].sort()).toEqual(['groupName']);
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
    const scope = collectWriteEvidence(cbSource).scopes.get('buildBatchConfig');
    expect([...(scope ?? [])].sort()).toEqual([
      'batchReportMode',
      'combineArtifacts',
      'computeTypesAllowed',
      'maximumBuildsAllowed',
      'restrictions',
      'serviceRole',
      'timeoutInMins',
    ]);
  });

  it('a scope resolves through a this.method(...) call returning a literal', () => {
    // `source: this.mapSource(source)` — the #1404-style hop. `Source.BuildSpec`
    // is deliberately absent from the SDK-member side, so the members below are
    // the ones the pass actually consults.
    const scope = collectWriteEvidence(cbSource).scopes.get('source');
    for (const member of ['type', 'location', 'gitCloneDepth', 'auth', 'buildStatusConfig']) {
      expect(scope?.has(member), member).toBe(true);
    }
    // ...and one level deeper, through the nested `auth: { … }` literal.
    expect(scope?.has('resource')).toBe(true);
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
    expect(withdrawn).toEqual([
      'AnalyticsConfigurations',
      'BucketEncryption',
      'BucketName',
      'CorsConfiguration',
      'IntelligentTieringConfigurations',
      'InventoryConfigurations',
      'LoggingConfiguration',
      'MetricsConfigurations',
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
describe('the shipped --check command', () => {
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

  it('exits 1 naming a STALE allow-list entry', () => {
    // `AWS::CodeBuild::Project#HostKernel` is allow-listed because no SDK member
    // exists. Naming the key in the provider flips it to `provider-handled`, so
    // the entry stops matching and must be reported rather than silently kept.
    const dir = regressedTree('providers-stale', 'codebuild-provider.ts', (source) =>
      source.replace(
        'export class CodeBuildProvider',
        "const NAMES_THE_KEY = ['HostKernel'];\nvoid NAMES_THE_KEY;\nexport class CodeBuildProvider"
      )
    );
    const { status, stderr } = runCheck(dir);
    expect(status).toBe(1);
    expect(stderr).toContain('stale NESTED_KEY_ALLOW_LIST');
    expect(stderr).toContain('AWS::CodeBuild::Project#HostKernel');
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

describe('target-table hygiene', () => {
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

  it('every minNestedKeys floor is calibrated to the PATH unit (#1448)', () => {
    // The floors were name-era values until #1448 re-derived them; a floor far
    // below the real yield fences nothing. Each must be within 40% of the
    // measured path count (and never above it).
    const report = loadReport();
    for (const t of NESTED_KEY_TARGETS) {
      const audited = report.targets.find((r) => r.resourceType === t.resourceType)!.nestedKeyCount;
      expect(t.minNestedKeys, `${t.resourceType} floor above yield`).toBeLessThanOrEqual(audited);
      if (audited >= 5) {
        expect(t.minNestedKeys, `${t.resourceType} floor too slack`).toBeGreaterThanOrEqual(
          Math.floor(audited * 0.6)
        );
      }
    }
  });

  it('every allow-list entry names a target resource type', () => {
    const targetTypes = new Set(NESTED_KEY_TARGETS.map((t) => t.resourceType));
    for (const key of NESTED_KEY_ALLOW_LIST.keys()) {
      const [type] = key.split('#');
      expect(targetTypes.has(type!), key).toBe(true);
    }
  });
});
