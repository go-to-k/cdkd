import { describe, it, expect } from 'vite-plus/test';
import {
  collectStoredAttributeKeys,
  collectConstructAttributeTypes,
  classifyType,
  buildReport,
  findGaps,
  renderMarkdown,
  GAP_REMEDY,
  loadAllFixtures,
  SDK_ATTR_ALLOW_LIST,
  type AllowListEntry,
} from '../../../scripts/gen-sdk-attr-coverage.js';
import { parseProviderSource } from '../../../scripts/gen-property-coverage.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every (type, ARN attribute) pair fixed by CACHING rather than by an allow-list
 * entry, shared by the two fences in `real repo coverage` below so they cannot
 * name different pairs. Named for the RULE rather than for issue 1824, which
 * contributed only the first two — a name that dates itself invites the third
 * entry to be filed somewhere else.
 *
 * The first two are issue 1824's. `AWS::ApiGatewayV2::Api` joined them in issue
 * [#2833](https://github.com/go-to-k/cdkd/issues/2833): the issue-2821 schema
 * refresh published `ExecuteApiArn`, and a `knownGap` entry would have turned
 * the critic green in one line — the option the `carries no KNOWN GAP entries`
 * fence below exists to refuse, including to the author who found the gap.
 */
const CACHED_ARN_PAIRS = [
  ['AWS::RDS::DBSubnetGroup', 'DBSubnetGroupArn'],
  ['AWS::SSM::Parameter', 'Arn'],
  ['AWS::ApiGatewayV2::Api', 'ExecuteApiArn'],
  // Issue 3324's own regression, and the reason this pair is the right fence
  // for it rather than a new one: the attribute was never a gap and was never
  // allow-listed — the 2026-09-17 refresh flipped AWS's `primaryIdentifier`
  // for this type from `ApiId` to `Arn`, and the classifier's filter DELETED
  // the row from the matrix. Requiring `cached` fails on the deletion (the
  // pair classifies nothing) and on a re-added carve-out alike, neither of
  // which `findGaps(report)).toEqual([])` can see.
  ['AWS::AppSync::GraphQLApi', 'Arn'],
  // Issue 3329, and added for the same third shape the pair above exists for.
  // `findGaps(report)).toEqual([])` sees this type only if it comes BACK as a
  // gap; it is blind to the row being DELETED from the matrix — which is what a
  // schema refresh dropping `Arn` from the type's fixture would do, leaving
  // both that fence and the empty-allow-list assertion green. Requiring
  // `cached` is what makes "deleting the allow-list entry VERIFIES the caching"
  // true in both directions.
  ['AWS::SNS::Subscription', 'Arn'],
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
      new Set(['AgentRuntimeArn']),
      new Set(),
      EMPTY
    );
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('cached');
  });

  it('marks construct-attribute when the resolver handles the type', () => {
    const c = classifyType('AWS::Foo::Bar', ['FooArn'], new Set(), new Set(['AWS::Foo::Bar']), EMPTY);
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('construct-attribute');
  });

  it('respects the allow-list', () => {
    const allow = new Map<string, AllowListEntry>([
      ['AWS::SNS::Subscription', { attributes: ['Arn'], rationale: 'Arn == physicalId' }],
    ]);
    const c = classifyType('AWS::SNS::Subscription', ['Arn'], new Set(), new Set(), allow);
    expect(c.bucket).toBe('covered');
    expect(c.arnAttributes[0].status).toBe('allow-listed');
  });

  it('classifies a type with only non-ARN/URL readOnly attributes as no-arn-attr', () => {
    const c = classifyType('AWS::Foo::Bar', ['Id', 'Status'], new Set(), new Set(), EMPTY);
    expect(c.bucket).toBe('no-arn-attr');
  });

  it('treats a *Url attribute the same as *Arn', () => {
    const c = classifyType('AWS::Foo::Bar', ['ServiceUrl'], new Set(), new Set(), EMPTY);
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

  it('audits an ARN the FIXTURE names as its primaryIdentifier (issue 3324)', () => {
    // Deliberately written through `loadAllFixtures` + `buildReport` rather
    // than `classifyType`, and the level is the whole point. The removed
    // filter read a FIXTURE FIELD, and `classifyType` no longer has a
    // parameter that could express the old behaviour — a case written there
    // passes under BOTH implementations, since dropping an argument only
    // shifts the remaining ones along. Only a case that puts the field in a
    // fixture can tell the two apart: under the old code this type classified
    // `no-arn-attr` with an EMPTY `arnAttributes` and no gap.
    //
    // It is also the only fence here that does not self-retire. The real
    // `AWS::AppSync::GraphQLApi` pair in `CACHED_ARN_PAIRS` is latent until
    // that fixture's `primaryIdentifier` actually flips (the refresh carrying
    // it is still open), and the allow-list staleness loop disappears with its
    // entry the day `SNSSubscriptionProvider` caches `Arn` — the condition
    // that entry documents for its own removal.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-sdk-attr-pid-'));
    try {
      writeFileSync(
        join(dir, 'AWS-Sdk-IdIsArn.json'),
        JSON.stringify({
          resourceType: 'AWS::Sdk::IdIsArn',
          readOnlyProperties: ['ThingArn'],
          primaryIdentifier: ['ThingArn'],
        })
      );
      const report = buildReport(
        loadAllFixtures(dir),
        new Set(['AWS::Sdk::IdIsArn']),
        new Map(), // nothing cached
        new Set() // no constructAttribute handler
      );
      const classified = report.types.find((t) => t.resourceType === 'AWS::Sdk::IdIsArn');
      expect(classified?.arnAttributes.map((a) => a.name)).toEqual(['ThingArn']);
      expect(classified?.bucket).toBe('gap');
      expect(findGaps(report).map((g) => g.resourceType)).toEqual(['AWS::Sdk::IdIsArn']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderMarkdown', () => {
  it('prints the shared remedy in the gap section (the surface a real gap shows)', () => {
    // This section renders only when `gapTypes.length > 0`, and the tree has
    // none — so before issue 3324's round-5 pass nothing exercised it, and the
    // `.replace(/\n/g, ' ')` unwrap added in the same PR was dead to every
    // test. A synthetic gap is the only way in.
    const report = buildReport(
      [{ resourceType: 'AWS::Sdk::Gap', readOnlyProperties: ['ThingArn'] }],
      new Set(['AWS::Sdk::Gap']),
      new Map(),
      new Set()
    );
    const md = renderMarkdown(report);
    // SCOPED to the gap section. Round 6 measured that asserting the type name
    // over the WHOLE document is satisfied by the full-classification table
    // further down: deleting the gap-rows loop entirely left this case green,
    // so it covered the section's entry and its remedy but not the listing the
    // section exists for.
    const start = md.indexOf('## Latent gaps');
    expect(start, 'the gap section no longer renders for a report WITH a gap').toBeGreaterThan(0);
    const next = md.indexOf('\n## ', start + 1);
    const section = md.slice(start, next === -1 ? undefined : next);
    expect(section).toContain('`AWS::Sdk::Gap`');
    expect(section).toContain('`ThingArn`');
    // The remedy is the SAME text the other two surfaces state, unwrapped to a
    // single paragraph for markdown. Asserting the unwrapped constant pins both
    // the sharing and the unwrap: a stray newline here would break the line.
    expect(section).toContain(GAP_REMEDY.replace(/\n/g, ' '));
    expect(section).not.toContain('\n' + GAP_REMEDY.split('\n')[1]);
  });
});

// The "a checker must prove it sees its input" guard (rules/testing.md): pin
// that the real generator actually parses providers + fixtures and lands the
// known allow-list entries, so a parser regression fails loudly instead of
// silently classifying nothing.
describe('real repo coverage (regression floor)', () => {
  const repoRoot = join(import.meta.dirname, '../../..');

  // Declared bound for the ONE case in this block that reads the repo (issue
  // #3038): it loads every fixture under `tests/fixtures/cfn-schemas` and
  // parses every provider, so its cost grows with the repo and moves with
  // machine load -- measured at 0.6-0.7 s on a host at load 25-45
  // (2026-09-15), and observed crossing the 5 s in-process default while
  // three suites shared one machine. Per `.claude/rules/testing.md` the
  // bound stops a HANG rather than policing latency, so it is >= 80x the
  // measured cost. The three sibling cases below read only the
  // `SDK_ATTR_ALLOW_LIST` constant (0 ms measured) and keep the default.
  const REAL_REPO_TIMEOUT_MS = 60_000;

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
    // The loop is VACUOUS again, and this time it is a RECORD of the fence
    // working rather than an absence: issue 3324 restored the one
    // `AWS::SNS::Subscription` entry and stated its retirement condition —
    // `SNSSubscriptionProvider` caching `Arn` under its CFn name — and issue
    // 3329 met that condition, so the entry is gone. While the list is empty
    // this loop asserts nothing, which is why it is paired with the positive
    // fence below rather than relied on alone.
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
    // only proves nothing is UN-allow-listed, and an entry could be silently
    // added to re-silence either type (the list is no longer empty since issue
    // 3324, but it names neither of these). Requiring
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
    for (const [resourceType, attr] of CACHED_ARN_PAIRS) {
      const classified = report.types.find((t) => t.resourceType === resourceType);
      expect(classified, `${resourceType} classifies nothing`).toBeDefined();
      const found = classified!.arnAttributes.find((a) => a.name === attr);
      expect(
        found?.status,
        `${resourceType}.${attr} must be CACHED by its provider — not allow-listed, and not dropped from the matrix`
      ).toBe('cached');
    }
  }, REAL_REPO_TIMEOUT_MS);

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

  it('is EMPTY, and AWS::SNS::Subscription is not in it (issues 3324 / 3329)', () => {
    // History in one line: seeded at introduction, retired by the issue-1800
    // re-capture (which let the `primaryIdentifier` filter reach it first),
    // RESTORED by issue 3324 when that filter was removed as unsound for
    // Tier-1 types, and retired AGAIN by issue 3329 — this time by the
    // mechanism the list documents for itself, `SNSSubscriptionProvider.create`
    // recording the `Subscribe` response's `SubscriptionArn` under its CFn
    // name. `classifyType` reads `cachedKeys` BEFORE this list, so an entry
    // left behind would sit INERT while the matrix still reported the type as
    // a carve-out; deleting it is what VERIFIES the caching.
    //
    // Empty is the green state, the same one issue 1824 left it in. Adding an
    // entry back is a decision that needs a rationale and, for a real gap, a
    // tracking issue.
    expect([...SDK_ATTR_ALLOW_LIST.keys()]).toEqual([]);
  });

  it('does NOT allow-list AWS::Lambda::EventSourceMapping (the #1190 gap was fixed by caching the ARN)', () => {
    // The ESM ARN is now cached in create()/update(), so it must be resolved as
    // `covered` by real caching — not carried as an allow-list carve-out. A
    // regression that drops the caching should re-flag it, not silently pass.
    expect(SDK_ATTR_ALLOW_LIST.has('AWS::Lambda::EventSourceMapping')).toBe(false);
  });
});
