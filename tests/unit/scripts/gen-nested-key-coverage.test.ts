import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NESTED_KEY_ALLOW_LIST,
  NESTED_KEY_TARGETS,
  allowKey,
  buildReport,
  classifyTarget,
  classifyTargetShapes,
  collectSdkInterfaces,
  collectSdkMemberNames,
  collectStringLiterals,
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

const repoRoot = process.cwd();

const exactTarget: NestedKeyTarget = {
  resourceType: 'AWS::Fake::Thing',
  providerFile: 'fake-provider.ts',
  sdkClientPackage: '@aws-sdk/client-fake',
  keyStyle: 'exact',
  minNestedKeys: 0,
};

describe('classifyTarget (synthetic)', () => {
  const sdkMembers = new Set(['ACMCertificateArn', 'IsIPV6Enabled', 'Comment', 'items']);

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
        nestedKeyCount: entries.length,
        entries,
        shapeEntries: [],
        shapeCleanCount: 0,
        unmatchedDefinitions: [],
      },
    ]);
    expect(findStaleAllowListEntries(report, allow)).toEqual(['AWS::Fake::Thing#GoneKey']);
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
});

describe('refresh-cfn-schemas CLI guard (#1378 rider)', () => {
  const script = resolve(repoRoot, 'scripts/refresh-cfn-schemas.mjs');

  it('--help prints usage and exits 0 without fetching anything', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('node', [script, '--help']);
    expect(stdout).toContain('Usage:');
    expect(stdout).not.toContain('Refreshing CFn schemas');
  });

  it('an unknown flag exits non-zero instead of silently full-refetching', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await expect(promisify(execFile)('node', [script, '--bogus'])).rejects.toMatchObject({
      code: 1,
    });
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
