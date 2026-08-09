import { describe, it, expect } from 'vite-plus/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  collectWrittenMemberNames,
  expandLiteralSegments,
  findDivergences,
  findStaleAllowListEntries,
  loadReport,
  lowerFirst,
  nestedKeysForTarget,
  wrapperInterfaceNames,
  type NestedKeyTarget,
  type SdkMemberType,
} from '../../../scripts/gen-nested-key-coverage.ts';
import {
  extractDefinitionShapes,
  extractNestedPropertyNames,
} from '../../../scripts/refresh-cfn-schemas.mjs';
import { parseProviderSource } from '../../../scripts/gen-property-coverage.ts';

const repoRoot = process.cwd();

const exactTarget: NestedKeyTarget = {
  resourceType: 'AWS::Fake::Thing',
  providerFile: 'fake-provider.ts',
  sdkClientPackage: '@aws-sdk/client-fake',
  keyStyle: 'exact',
  minNestedKeys: 0,
};

const freshTarget: NestedKeyTarget = { ...exactTarget, freshObjectMapper: true };

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

describe('classifyTarget (synthetic)', () => {
  const sdkMembers = new Set(['ACMCertificateArn', 'IsIPV6Enabled', 'Comment', 'items']);

  it('a same-spelling key on a NON-fresh-object target stays silent without any write', () => {
    // The forwarding case: the serializer carries the key through, so an
    // absent write proves nothing. Guards the opt-in from becoming default-on.
    const [e] = classifyTarget(exactTarget, ['Comment'], sdkMembers, new Set(), new Map(), new Set());
    expect(e?.bucket).toBe('same-spelling');
  });

  it('flags a same-spelling key with no write evidence on a fresh-object target (#1432)', () => {
    const [e] = classifyTarget(freshTarget, ['Comment'], sdkMembers, new Set(), new Map(), new Set());
    expect(e?.bucket).toBe('no-write-evidence');
    expect(e?.sdkNearMiss).toBe('Comment');
  });

  it('clears the same key once the provider writes the SDK member', () => {
    const [e] = classifyTarget(
      freshTarget,
      ['Comment'],
      sdkMembers,
      new Set(),
      new Map(),
      new Set(['Comment'])
    );
    expect(e?.bucket).toBe('same-spelling');
  });

  it('does NOT let the loose literal heuristic rescue a missing write', () => {
    // The CFn spelling named somewhere in the file is exactly the evidence
    // #1432 says is insufficient for a fresh-object mapper.
    const [e] = classifyTarget(
      freshTarget,
      ['Comment'],
      sdkMembers,
      new Set(['Comment']),
      new Map(),
      new Set()
    );
    expect(e?.bucket).toBe('no-write-evidence');
  });

  it('an allow-list entry silences a no-write-evidence key', () => {
    const allow = new Map([
      [allowKey(freshTarget.resourceType, 'Comment'), { rationale: 'deliberate' }],
    ]);
    const [e] = classifyTarget(freshTarget, ['Comment'], sdkMembers, new Set(), allow, new Set());
    expect(e?.bucket).toBe('allow-listed');
    expect(e?.rationale).toBe('deliberate');
  });

  it('lower-first styling applies to the write lookup too', () => {
    const camel = new Set(['batchReportMode']);
    const lowerFirstFresh: NestedKeyTarget = {
      ...exactTarget,
      keyStyle: 'lower-first',
      freshObjectMapper: true,
    };
    const [missing] = classifyTarget(
      lowerFirstFresh,
      ['BatchReportMode'],
      camel,
      new Set(),
      new Map(),
      new Set(['BatchReportMode']) // the CFn spelling written — wrong side
    );
    expect(missing?.bucket).toBe('no-write-evidence');
    const [ok] = classifyTarget(
      lowerFirstFresh,
      ['BatchReportMode'],
      camel,
      new Set(),
      new Map(),
      new Set(['batchReportMode'])
    );
    expect(ok?.bucket).toBe('same-spelling');
  });

  it('a no-write-evidence key is a CI-blocking divergence', () => {
    const entries = classifyTarget(
      freshTarget,
      ['Comment'],
      sdkMembers,
      new Set(),
      new Map(),
      new Set()
    );
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
    expect(d?.detail).toContain('never writes it');
  });

  it('classifies a same-spelling key as reachable', () => {
    const [e] = classifyTarget(exactTarget, ['Comment'], sdkMembers, new Set(), new Map());
    expect(e?.bucket).toBe('same-spelling');
  });

  it('classifies a provider-named key as provider-handled', () => {
    const [e] = classifyTarget(
      exactTarget,
      ['AcmCertificateArn'],
      sdkMembers,
      new Set(['AcmCertificateArn']),
      new Map()
    );
    expect(e?.bucket).toBe('provider-handled');
  });

  it('flags a case-insensitive near-miss as case-divergence with the SDK member named', () => {
    const [e] = classifyTarget(exactTarget, ['AcmCertificateArn'], sdkMembers, new Set(), new Map());
    expect(e?.bucket).toBe('case-divergence');
    expect(e?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('flags a key with no SDK member at all as no-sdk-member', () => {
    const [e] = classifyTarget(exactTarget, ['IPV6Enabled'], sdkMembers, new Set(), new Map());
    expect(e?.bucket).toBe('no-sdk-member');
  });

  it('classifies an allow-listed divergence as allow-listed with its rationale', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'IPV6Enabled'), { rationale: 'legacy member' }],
    ]);
    const [e] = classifyTarget(exactTarget, ['IPV6Enabled'], sdkMembers, new Set(), allow);
    expect(e?.bucket).toBe('allow-listed');
    expect(e?.rationale).toBe('legacy member');
  });

  it('an allow-listed near-miss still records the SDK member it shadows', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'AcmCertificateArn'), { rationale: 'deliberate' }],
    ]);
    const [e] = classifyTarget(exactTarget, ['AcmCertificateArn'], sdkMembers, new Set(), allow);
    expect(e?.bucket).toBe('allow-listed');
    expect(e?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('matches lower-first style against camelCase SDK members', () => {
    const target: NestedKeyTarget = { ...exactTarget, keyStyle: 'lower-first' };
    const camelMembers = new Set(['maximumPercent', 's3filesVolumeConfiguration']);
    const [max] = classifyTarget(target, ['MaximumPercent'], camelMembers, new Set(), new Map());
    expect(max?.bucket).toBe('same-spelling');
    // The irregular `s3filesVolumeConfiguration` (all-lowercase prefix) is NOT
    // a first-letter flip of the CFn key — must flag unless provider-handled.
    const [s3f] = classifyTarget(
      target,
      ['S3FilesVolumeConfiguration'],
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

describe('nestedKeysForTarget', () => {
  it('unions nested keys across handled top-levels only', () => {
    const fixture = {
      nestedProperties: {
        Handled: ['A', 'B'],
        AlsoHandled: ['B', 'C'],
        Unhandled: ['D'],
      },
    };
    expect(nestedKeysForTarget(fixture, new Set(['Handled', 'AlsoHandled']))).toEqual([
      'A',
      'B',
      'C',
    ]);
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
      ['AcmCertificateArn', 'NoSuchMember', 'Comment'],
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
      ['AcmCertificateArn', 'case-divergence'],
      ['NoSuchMember', 'no-sdk-member'],
    ]);
    expect(report.summary.caseDivergence).toBe(1);
    expect(report.summary.noSdkMember).toBe(1);
    expect(report.summary.sameSpelling).toBe(1);
  });

  it('findStaleAllowListEntries returns an entry that matches no audited divergence', () => {
    const allow = new Map([
      [allowKey('AWS::Fake::Thing', 'GoneKey'), { rationale: 'obsolete' }],
    ]);
    const entries = classifyTarget(exactTarget, ['Comment'], sdkMembers, new Set(), allow);
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
      const entry = cf.entries.find((e) => e.nestedKey === key);
      expect(entry?.bucket, key).toBe('provider-handled');
    }
  });

  it('fences the #1373-fixed ECS S3FilesVolumeConfiguration as provider-handled', () => {
    const td = report.targets.find((t) => t.resourceType === 'AWS::ECS::TaskDefinition')!;
    expect(td.entries.find((e) => e.nestedKey === 'S3FilesVolumeConfiguration')?.bucket).toBe(
      'provider-handled'
    );
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
      expect(s3.entries.find((e) => e.nestedKey === key)?.bucket, key).toBe('provider-handled');
    }
  });

  it('fences the #1304-fixed AnomalyDetector MetricTimeZone as provider-handled', () => {
    const ad = report.targets.find((t) => t.resourceType === 'AWS::CloudWatch::AnomalyDetector')!;
    expect(ad.entries.find((e) => e.nestedKey === 'MetricTimeZone')?.bucket).toBe(
      'provider-handled'
    );
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
    expect(cf.entries.find((e) => e.nestedKey === 'S3Origin')?.bucket).toBe('same-spelling');
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
  const cfNestedKeys = nestedKeysForTarget(cfFixture, new Set(['DistributionConfig', 'Tags']));

  it('flags the real provider with the AcmCertificateArn conversion removed (the #1370 rename)', () => {
    const regressed = cfSource.replaceAll('AcmCertificateArn', 'XcmCertificateArn');
    const literals = collectStringLiterals(regressed);
    const entries = classifyTarget(cfTarget, cfNestedKeys, cfSdkMembers, literals);
    const hit = entries.find((e) => e.nestedKey === 'AcmCertificateArn');
    expect(hit?.bucket).toBe('case-divergence');
    expect(hit?.sdkNearMiss).toBe('ACMCertificateArn');
  });

  it('flags the real provider with the OriginCustomHeaders rename removed (the #1373 catch)', () => {
    const regressed = cfSource.replaceAll('OriginCustomHeaders', 'RemovedCustomHeaders');
    const literals = collectStringLiterals(regressed);
    const entries = classifyTarget(cfTarget, cfNestedKeys, cfSdkMembers, literals);
    expect(entries.find((e) => e.nestedKey === 'OriginCustomHeaders')?.bucket).toBe(
      'no-sdk-member'
    );
  });

  it('the unregressed real provider classifies both keys as provider-handled', () => {
    const literals = collectStringLiterals(cfSource);
    const entries = classifyTarget(cfTarget, cfNestedKeys, cfSdkMembers, literals);
    expect(entries.find((e) => e.nestedKey === 'AcmCertificateArn')?.bucket).toBe(
      'provider-handled'
    );
    expect(entries.find((e) => e.nestedKey === 'OriginCustomHeaders')?.bucket).toBe(
      'provider-handled'
    );
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
  const s3NestedKeys = nestedKeysForTarget(s3Fixture, s3HandledTopLevels);

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
      expect(entries.find((e) => e.nestedKey === key)?.bucket, key).toBe('no-sdk-member');
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
    expect(entries.find((e) => e.nestedKey === 'TagFilters')?.bucket).toBe('provider-handled');
  });

  it('the unregressed real S3 provider classifies every probed key as provider-handled', () => {
    const entries = classifyTarget(
      s3Target,
      s3NestedKeys,
      s3SdkMembers,
      collectStringLiterals(s3Source)
    );
    for (const key of S3_DISCRIMINATING_KEYS) {
      expect(entries.find((e) => e.nestedKey === key)?.bucket, key).toBe('provider-handled');
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
  const cbNestedKeys = nestedKeysForTarget(cbFixture, cbHandledTopLevel);
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
      collectWrittenMemberNames(regressed)
    );
    const hit = entries.find((e) => e.nestedKey === 'BatchReportMode');
    expect(hit?.bucket).toBe('no-write-evidence');
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
      collectWrittenMemberNames(regressed)
    );
    expect(entries.find((e) => e.nestedKey === 'BatchReportMode')?.bucket).toBe('same-spelling');
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
      collectWrittenMemberNames(cbSource)
    );
    expect(entries.filter((e) => e.bucket === 'no-write-evidence')).toHaveLength(0);
    // Coverage floor: the pass must be auditing a real number of keys, not
    // vacuously green on an empty same-spelling set.
    expect(entries.filter((e) => e.bucket === 'same-spelling').length).toBeGreaterThanOrEqual(50);
  });

  it('write evidence is name-global, so a multiply-written member is NOT fenced (#1448)', () => {
    // Documents the pass's real bound rather than asserting a guarantee it does
    // not deliver. `BuildBatchConfig.ServiceRole` is the SIBLING of the
    // motivating member: deleting its forward write stays silent because the
    // top-level `serviceRole:` write vouches for the same spelling. Measured:
    // 11 of CodeBuild's 55 same-spelling keys have >1 write site, so the pass
    // fences the other 44 (BatchReportMode among them).
    const anchor = "serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,";
    expect(cbSource, 'anchor still present').toContain(anchor);
    const regressed = cbSource.replace(anchor, '');
    const entries = classifyTarget(
      cbTarget,
      cbNestedKeys,
      cbSdkMembers,
      collectStringLiterals(regressed),
      NESTED_KEY_ALLOW_LIST,
      collectWrittenMemberNames(regressed)
    );
    expect(entries.find((e) => e.nestedKey === 'ServiceRole')?.bucket).toBe('same-spelling');
    // ...and the uniquely-named member IS still fenced, so the limitation is a
    // bound on coverage rather than the pass being inert.
    expect(collectWrittenMemberNames(regressed).has('serviceRole')).toBe(true);
  });

  it('the write collector sees a real provider (parser-regression floor)', () => {
    const written = collectWrittenMemberNames(cbSource);
    expect(written.size).toBeGreaterThanOrEqual(MIN_WRITTEN_MEMBERS_PER_PROVIDER);
    expect(written.has('batchReportMode')).toBe(true);
  });

  it('the readCurrentState exclusion withdraws real reverse-map writes (#1393 item 2)', () => {
    // Measured on the real tree: `s3-bucket-provider.ts` is an `exact`-style
    // target, so its reverse map writes CFn spellings that ARE SDK member
    // spellings. Those are the names that would falsely vouch for a forward
    // mapper if the exclusion were dropped.
    const scoped = collectWrittenMemberNames(s3Source);
    const unscoped = collectWrittenMemberNames(s3Source, 's3-bucket-provider.ts', []);
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

describe('allow-list hygiene', () => {
  it('every allow-list entry names a target resource type', () => {
    const targetTypes = new Set(NESTED_KEY_TARGETS.map((t) => t.resourceType));
    for (const key of NESTED_KEY_ALLOW_LIST.keys()) {
      const [type] = key.split('#');
      expect(targetTypes.has(type!), key).toBe(true);
    }
  });
});
