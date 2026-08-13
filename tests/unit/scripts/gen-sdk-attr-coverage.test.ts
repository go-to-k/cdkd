import { describe, it, expect } from 'vite-plus/test';
import {
  collectStoredAttributeKeys,
  collectConstructAttributeTypes,
  classifyType,
  buildReport,
  findGaps,
  loadAllFixtures,
  SDK_ATTR_ALLOW_LIST,
  type AllowListEntry,
} from '../../../scripts/gen-sdk-attr-coverage.js';
import { parseProviderSource } from '../../../scripts/gen-property-coverage.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two (type, ARN attribute) pairs issue 1824 fixed by caching, shared by the
 * two fences in `real repo coverage` below so they cannot name different pairs.
 */
const ISSUE_1824_CACHED_PAIRS = [
  ['AWS::RDS::DBSubnetGroup', 'DBSubnetGroupArn'],
  ['AWS::SSM::Parameter', 'Arn'],
] as const;

describe('collectStoredAttributeKeys', () => {
  it('collects object-literal keys, shorthand, and element-access assignment keys', () => {
    const src = `
      class P {
        create() {
          const attributes: Record<string, unknown> = { AgentRuntimeArn: x, 'AgentRuntimeId': y };
          attributes['AgentRuntimeVersion'] = z;
          const shorthand = { Status };
          return { physicalId: id, attributes };
        }
      }
    `;
    const keys = collectStoredAttributeKeys(src);
    expect(keys.has('AgentRuntimeArn')).toBe(true);
    expect(keys.has('AgentRuntimeId')).toBe(true);
    expect(keys.has('AgentRuntimeVersion')).toBe(true);
    expect(keys.has('Status')).toBe(true);
  });

  it('does NOT collect a `case` label / comparison literal (the #1179 precision)', () => {
    // The pre-#1179 shape: getAttribute COMPARES against 'AgentRuntimeArn' but
    // create stores the ARN under the wrong key `Arn`. The ARN name must NOT be
    // collected from the comparison, so the classifier still flags the gap.
    const src = `
      class P {
        create() { return { physicalId: id, attributes: { Arn: arn } }; }
        getAttribute(_id, _t, name) {
          if (name === 'AgentRuntimeArn') return this.fetchArn();
          switch (name) { case 'OtherArn': return 1; }
        }
      }
    `;
    const keys = collectStoredAttributeKeys(src);
    expect(keys.has('Arn')).toBe(true); // the (wrong) stored key
    expect(keys.has('AgentRuntimeArn')).toBe(false); // comparison, not stored
    expect(keys.has('OtherArn')).toBe(false); // case label, not stored
  });

  it('ignores camelCase SDK-input keys (they never collide with PascalCase CFn ARN names)', () => {
    const src = `class P { create() { const input = {}; input['agentRuntimeName'] = n; return { attributes: {} }; } }`;
    const keys = collectStoredAttributeKeys(src);
    expect(keys.has('agentRuntimeName')).toBe(true); // collected but harmless
    expect([...keys].some((k) => k.endsWith('Arn'))).toBe(false);
  });
});

describe('collectConstructAttributeTypes', () => {
  it('extracts AWS::X::Y literals from the constructAttribute method body only', () => {
    const src = `
      class R {
        private async constructAttribute(resource, name) {
          if (resource.resourceType === 'AWS::EC2::Instance') return this.ip();
          if (resource.resourceType === 'AWS::EC2::LaunchTemplate') return this.ver();
        }
        private other() { const t = 'AWS::S3::Bucket'; return t; }
      }
    `;
    const types = collectConstructAttributeTypes(src);
    expect(types.has('AWS::EC2::Instance')).toBe(true);
    expect(types.has('AWS::EC2::LaunchTemplate')).toBe(true);
    // A literal in a DIFFERENT method must not count.
    expect(types.has('AWS::S3::Bucket')).toBe(false);
  });

  it('returns an empty set when there is no constructAttribute method', () => {
    expect(collectConstructAttributeTypes('class X { foo() {} }').size).toBe(0);
  });
});

describe('classifyType', () => {
  const EMPTY = new Map<string, AllowListEntry>();

  it('flags an Arn readOnly that is neither cached nor constructAttribute-covered (the #1179 gap)', () => {
    const c = classifyType(
      'AWS::BedrockAgentCore::Runtime',
      ['AgentRuntimeArn', 'Status'],
      [],
      new Set(['Arn', 'AgentRuntimeId']), // wrong key cached, ARN missing
      new Set(), // not in constructAttribute
      EMPTY
    );
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['AgentRuntimeArn']);
  });

  it('marks cached when the provider records the ARN under its CFn name', () => {
    const c = classifyType(
      'AWS::BedrockAgentCore::Runtime',
      ['AgentRuntimeArn'],
      [],
      new Set(['AgentRuntimeArn']),
      new Set(),
      EMPTY
    );
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('cached');
  });

  it('marks construct-attribute when the resolver handles the type', () => {
    const c = classifyType('AWS::Foo::Bar', ['FooArn'], [], new Set(), new Set(['AWS::Foo::Bar']), EMPTY);
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('construct-attribute');
  });

  it('excludes a primaryIdentifier ARN (physicalId fallback resolves it)', () => {
    const c = classifyType('AWS::Foo::Bar', ['FooArn'], ['FooArn'], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('no-arn-attr');
    expect(c.arnAttributes).toEqual([]);
  });

  it('respects the allow-list', () => {
    const allow = new Map<string, AllowListEntry>([
      ['AWS::SNS::Subscription', { attributes: ['Arn'], rationale: 'Arn == physicalId' }],
    ]);
    const c = classifyType('AWS::SNS::Subscription', ['Arn'], [], new Set(), new Set(), allow);
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('allow-listed');
  });

  it('classifies a type with only non-ARN/URL readOnly attributes as no-arn-attr', () => {
    const c = classifyType('AWS::Foo::Bar', ['Id', 'Status'], [], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('no-arn-attr');
  });

  it('treats a *Url attribute the same as *Arn', () => {
    const c = classifyType('AWS::Foo::Bar', ['ServiceUrl'], [], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('gap');
    expect(c.gaps).toEqual(['ServiceUrl']);
  });
});

describe('buildReport / findGaps', () => {
  it('only classifies SDK-backed types and surfaces gaps', () => {
    const fixtures = [
      { resourceType: 'AWS::Sdk::Ok', readOnlyProperties: ['ThingArn'] },
      { resourceType: 'AWS::Sdk::Gap', readOnlyProperties: ['ThingArn'] },
      { resourceType: 'AWS::Cc::Only', readOnlyProperties: ['ThingArn'] }, // no SDK provider
    ];
    const report = buildReport(
      fixtures,
      new Set(['AWS::Sdk::Ok', 'AWS::Sdk::Gap']),
      new Map([['AWS::Sdk::Ok', new Set(['ThingArn'])]]),
      new Set()
    );
    expect(report.summary.classifiedCount).toBe(2); // pure-CC type excluded
    const gaps = findGaps(report);
    expect(gaps.map((g) => g.resourceType)).toEqual(['AWS::Sdk::Gap']);
  });
});

// The "a checker must prove it sees its input" guard (rules/testing.md): pin
// that the real generator actually parses providers + fixtures and lands the
// known allow-list entries, so a parser regression fails loudly instead of
// silently classifying nothing.
describe('real repo coverage (regression floor)', () => {
  const repoRoot = join(import.meta.dirname, '../../..');

  it('classifies a substantial number of SDK-backed types with an Arn/Url attribute', () => {
    const fixtures = loadAllFixtures(join(repoRoot, 'tests/fixtures/cfn-schemas'));
    const providersDir = join(repoRoot, 'src/provisioning/providers');
    const sdkBacked = new Set<string>();
    const cached = new Map<string, Set<string>>();
    for (const file of readdirSync(providersDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
      const src = readFileSync(join(providersDir, file), 'utf8');
      const parsed = parseProviderSource(src, file);
      if (parsed.handled.size === 0) continue;
      const keys = collectStoredAttributeKeys(src, file);
      for (const type of parsed.handled.keys()) {
        sdkBacked.add(type);
        const t = cached.get(type) ?? new Set<string>();
        for (const k of keys) t.add(k);
        cached.set(type, t);
      }
    }
    const ctorTypes = collectConstructAttributeTypes(
      readFileSync(join(repoRoot, 'src/deployment/intrinsic-function-resolver.ts'), 'utf8')
    );
    const report = buildReport(fixtures, sdkBacked, cached, ctorTypes);

    // Floors: the generator must actually see providers + fixtures.
    expect(report.summary.classifiedCount).toBeGreaterThan(100);
    const withArn = report.types.filter((t) => t.arnAttributes.length > 0);
    expect(withArn.length).toBeGreaterThan(30);
    // With the shipped allow-list, there must be zero un-allow-listed gaps
    // (the critic's green state).
    expect(findGaps(report)).toEqual([]);

    // STALE-ALLOW-LIST FENCE. `classifyType` tests `cachedKeys` BEFORE the
    // allow-list, so the moment a provider starts caching an allow-listed
    // attribute the entry silently classifies `cached` and becomes inert —
    // there is no `findStaleAllowListEntries` here the way there is in
    // `gen-nested-key-coverage.ts`. Asserting that every allow-listed
    // attribute still classifies `allow-listed` IS that detection: fixing
    // issue 1824 redded this test and forced both entries' removal, which is
    // what made the "DELETE this entry when it is fixed" note in the allow-list
    // enforceable rather than aspirational.
    //
    // The loop is VACUOUS while the list is empty (issue 1824 retired the last
    // two entries), so it is paired with the positive fence below rather than
    // relied on alone — a vacuous green is exactly what this file's sibling
    // rules forbid.
    for (const [resourceType, entry] of SDK_ATTR_ALLOW_LIST) {
      const classified = report.types.find((t) => t.resourceType === resourceType);
      expect(classified, `allow-list entry for ${resourceType} classifies nothing`).toBeDefined();
      for (const attr of entry.attributes) {
        const found = classified!.arnAttributes.find((a) => a.name === attr);
        expect(
          found?.status,
          `${resourceType}.${attr} no longer needs its allow-list entry — delete it`
        ).toBe('allow-listed');
      }
    }

    // POSITIVE FENCE for the two attributes issue 1824 fixed. `findGaps` above
    // only proves nothing is UN-allow-listed, and with the list now empty an
    // entry could be silently re-added to re-silence either type. Requiring
    // `cached` — not merely "not a gap" — pins that the classification comes from
    // real provider caching rather than from a carve-out.
    //
    // WHAT THIS DOES AND DOES NOT BIND. It binds the provider FILE, not a code
    // path: `collectStoredAttributeKeys` pools object-literal keys per file, so
    // any ONE of the create / update / import literals keeps the type `cached`.
    // Measured — neutralizing BOTH the create and update spreads leaves this test
    // and `--check` green off the `import()` occurrences alone, and only removing
    // all three reds them. So do NOT read this as "dropping the caching in
    // rds-provider.ts / ssm-parameter-provider.ts reds this test"; the per-path
    // discrimination lives in
    // `tests/unit/provisioning/uncached-arn-attributes-issue-1824.test.ts`, which
    // drives each path's real result through the resolver, and this fence's job
    // is only to keep the type off the allow list.
    for (const [resourceType, attr] of ISSUE_1824_CACHED_PAIRS) {
      const classified = report.types.find((t) => t.resourceType === resourceType);
      expect(classified, `${resourceType} classifies nothing`).toBeDefined();
      const found = classified!.arnAttributes.find((a) => a.name === attr);
      expect(
        found?.status,
        `${resourceType}.${attr} must be CACHED by its provider (issue 1824) — not allow-listed`
      ).toBe('cached');
    }
  });

  it('carries no KNOWN GAP entries — the issue-1824 pair was fixed, not carved out', () => {
    // Both kinds of entry have to share one list (the classifier needs the same
    // "not a gap" answer for both), but a NOT-A-BUG and a tracked, real
    // `Fn::GetAtt` hard-fail mean opposite things. The summary reports the
    // second kind on its own line rather than folding it into `covered`.
    //
    // The list held exactly two KNOWN GAPs (`AWS::RDS::DBSubnetGroup` /
    // `AWS::SSM::Parameter`, both added by the issue-1800 re-capture) until
    // issue 1824 cached both ARNs. Asserting ZERO keeps the debt line honest:
    // a future re-introduction has to change this test deliberately, and the
    // positive `cached` fence in the report test above is what proves the two
    // were fixed rather than merely un-listed.
    const knownGapTypes = [...SDK_ATTR_ALLOW_LIST]
      .filter(([, e]) => e.knownGap === true)
      .map(([t]) => t);

    expect(knownGapTypes).toEqual([]);

    // A SECOND assertion here — that neither issue-1824 type appears in the list
    // at all — was DROPPED in review round 3, and the measurement is worth
    // recording so it is not re-added on the reasoning that first put it in.
    //
    // Its stated rationale was that a NOT-A-BUG entry "would silence the
    // `cached` fence just as effectively as a KNOWN GAP one". That is
    // impossible: `classifyType` tests `cachedKeys` BEFORE the allow list, so
    // while the provider caches, an entry cannot produce `allow-listed` and the
    // fence keeps passing.
    //
    // What an entry added TODAY does hit is the per-entry staleness fence in the
    // report test above ("no longer needs its allow-list entry — delete it"),
    // and MEASURED by adding `['AWS::SSM::Parameter', {attributes: ['Arn']}]` to
    // the real list: that fence fails, as does this test's `knownGapTypes` line
    // when the entry carries `knownGap`. Dropping the caching instead fails the
    // `cached` fence. So the two existing fences already cover both directions
    // and the dropped assertion could never fire alone — a redundant assertion
    // whose comment claimed a mechanism the code does not have is worse than no
    // assertion, because the next reader trusts the claim.
  });

  it('no longer allow-lists AWS::SNS::Subscription — primaryIdentifier filtering covers it', () => {
    // Retired by the issue-1800 re-capture: the fixture predated the #1694
    // `primaryIdentifier` capture, so `Arn` reached the allow-list; now it is
    // filtered as the primaryIdentifier first, which is the auto-classification
    // that mechanism exists for. Asserting the ABSENCE keeps a future
    // re-introduction honest.
    expect(SDK_ATTR_ALLOW_LIST.has('AWS::SNS::Subscription')).toBe(false);
  });

  it('does NOT allow-list AWS::Lambda::EventSourceMapping (the #1190 gap was fixed by caching the ARN)', () => {
    // The ESM ARN is now cached in create()/update(), so it must be resolved as
    // `covered` by real caching — not carried as an allow-list carve-out. A
    // regression that drops the caching should re-flag it, not silently pass.
    expect(SDK_ATTR_ALLOW_LIST.has('AWS::Lambda::EventSourceMapping')).toBe(false);
  });
});
