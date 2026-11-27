import { describe, it, expect, vi } from 'vite-plus/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// go-to-k/cdkd#7024, go-to-k/cdkd#7038: every replace-or-update verdict cdkd
// makes by hand, or that disagrees with the committed schema fixture or with
// @aws-cdk/aws-service-spec (what `cdk diff` reads), or that the fixture's
// `conditionalCreateOnlyPropertyPaths` say may replace, must have a row in
// REPLACEMENT_EVIDENCE saying why it is what CloudFormation does. See the
// module's doc comment for why both directions are destructive.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { PROVIDER_REPLACEMENT_PLANNERS } from '../../../src/analyzer/diff-calculator/provider-replacement.js';
import { REPLACEMENT_EVIDENCE } from '../../../src/analyzer/replacement-rules/evidence.js';
import { UNMEASURED_SPEC_REPLACEMENT_CANDIDATES } from '../../../src/analyzer/replacement-rules/evidence-baseline.js';
import { withSpecReplacementPaths } from '../../../src/provisioning/create-only-properties.js';
import {
  candidateKey,
  loadSpecReplacementCandidates,
  readRegistryCreateOnlySnapshot,
  SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA,
} from '../../../scripts/spec-replacement-candidates.ts';
import { labelOf, renderRow } from '../../../scripts/gen-spec-replacement-properties.ts';

const FIXTURES = join(__dirname, '../../fixtures/cfn-schemas');

type Spec = 'yes' | 'no' | 'maybe';
type Verdict = 'replace' | 'update' | 'conditional' | 'nested';

interface Fixture {
  resourceType: string;
  properties: string[];
  createOnlyPropertyPaths?: string[][];
  conditionalCreateOnlyPropertyPaths?: string[][];
}

function loadFixtures(): Map<string, Fixture> {
  const out = new Map<string, Fixture>();
  for (const file of readdirSync(FIXTURES)) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const fixture = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Fixture;
    if (typeof fixture.resourceType === 'string') out.set(fixture.resourceType, fixture);
  }
  return out;
}

function loadSpec(): (type: string, prop: string) => Spec | undefined {
  const require = createRequire(__filename);
  const { loadAwsServiceSpecSync } = require('@aws-cdk/aws-service-spec') as {
    loadAwsServiceSpecSync: () => {
      lookup: (
        ...a: string[]
      ) => Array<{ properties: Record<string, { causesReplacement?: Spec }> }>;
    };
  };
  const db = loadAwsServiceSpecSync();
  return (type, prop) => {
    const resource = db.lookup('resource', 'cloudFormationType', 'equals', type)[0];
    const property = resource?.properties[prop];
    return property === undefined ? undefined : (property.causesReplacement ?? 'no');
  };
}

interface Entry {
  key: string;
  verdict: Verdict;
  ruled: boolean;
  /** A spec-replacement candidate (go-to-k/cdkd#7070) no hand rule decides. */
  candidate?: boolean;
  fixture: Fixture | undefined;
  spec: Spec | undefined;
}

/** Every property cdkd has a verdict for, with the oracles' answers. */
function collectEntries(): Entry[] {
  const registry = new ReplacementRulesRegistry();
  const fixtures = loadFixtures();
  const spec = loadSpec();
  const entries = new Map<string, Entry>();
  const add = (type: string, prop: string, verdict: Verdict, ruled: boolean): void => {
    const key = `${type}#${prop}`;
    entries.set(key, { key, verdict, ruled, fixture: fixtures.get(type), spec: spec(type, prop) });
  };
  for (const [type, fixture] of fixtures) {
    const paths = withSpecReplacementPaths(type, fixture.createOnlyPropertyPaths ?? []);
    for (const prop of fixture.properties) {
      if (registry.isClassified(type, prop)) continue;
      const whole = paths.some((p) => p.length === 1 && p[0] === prop);
      const nested = paths.some((p) => p.length > 1 && p[0] === prop);
      add(type, prop, whole ? 'replace' : nested ? 'nested' : 'update', false);
    }
  }
  for (const [type, planner] of PROVIDER_REPLACEMENT_PLANNERS) {
    for (const prop of planner.properties) add(type, prop, 'conditional', true);
  }
  // Added in REVERSE of `requiresReplacement`'s precedence (replacement,
  // then updateable, then conditional), so the one it reads wins.
  for (const [type, rule] of registry.rules) {
    for (const prop of rule.conditionalReplacements?.keys() ?? []) {
      add(type, prop, 'conditional', true);
    }
    for (const prop of rule.updateableProperties ?? []) add(type, prop, 'update', true);
    for (const prop of rule.replacementProperties) add(type, prop, 'replace', true);
  }
  // go-to-k/cdkd#7070: every spec-replacement candidate on ANY type. Its
  // verdict is cdkd's: replaced when the paths the diff reads (the schema's,
  // unioned with the generated table) cover it.
  const registrySnapshot = readRegistryCreateOnlySnapshot();
  for (const c of loadSpecReplacementCandidates().candidates) {
    const top = c.path[0]!;
    if (isHandDecided(registry, c.type, top)) continue;
    const key = candidateKey(c.type, c.path);
    const existing = entries.get(key);
    if (existing) {
      existing.candidate = true;
      continue;
    }
    const schemaPaths =
      fixtures.get(c.type)?.createOnlyPropertyPaths ?? registrySnapshot.get(c.type) ?? [];
    const covered = withSpecReplacementPaths(c.type, schemaPaths).some(
      (p) => p.length <= c.path.length && p.every((segment, i) => segment === c.path[i])
    );
    entries.set(key, {
      key,
      verdict: covered ? 'replace' : 'update',
      ruled: false,
      candidate: true,
      fixture: fixtures.get(c.type),
      spec: c.spec,
    });
  }
  return [...entries.values()];
}

/** A hand rule or a provider-replacement planner decides the property. */
function isHandDecided(registry: ReplacementRulesRegistry, type: string, prop: string): boolean {
  return (
    registry.isClassified(type, prop) ||
    (PROVIDER_REPLACEMENT_PLANNERS.get(type)?.properties.includes(prop) ?? false)
  );
}

/** Whether the entry's verdict needs a row: hand logic, a disagreement, or no oracle. */
function needsEvidence(e: Entry): boolean {
  if (e.verdict === 'conditional') return true;
  // A spec-replacement candidate needs a measured verdict, or a baseline line.
  if (e.candidate) return !UNMEASURED_SPEC_REPLACEMENT_CANDIDATES.has(e.key);
  const prop = e.key.split('#')[1];
  // The registry schema says CloudFormation may replace on some changes of
  // it, so a verdict that never depends on the change needs its reason.
  if (e.fixture?.conditionalCreateOnlyPropertyPaths?.some((p) => p[0] === prop)) return true;
  const paths = e.fixture?.createOnlyPropertyPaths ?? [];
  // Only a hand-made verdict can disagree with the fixture it overrides.
  const fixtureAgrees =
    !e.ruled || e.fixture === undefined
      ? undefined
      : e.verdict === 'replace'
        ? paths.some((p) => p.length === 1 && p[0] === prop)
        : !paths.some((p) => p[0] === prop);
  const specAgrees =
    e.spec === undefined
      ? undefined
      : e.verdict === 'replace'
        ? e.spec === 'yes'
        : e.verdict === 'nested'
          ? e.spec !== 'no'
          : e.spec === 'no';
  if (fixtureAgrees === false || specAgrees === false) return true;
  return e.ruled && fixtureAgrees === undefined && specAgrees === undefined;
}

describe('replacement verdict evidence (go-to-k/cdkd#7024, #7038)', () => {
  const fixtures = loadFixtures();
  const entries = collectEntries();
  const needing = new Set(entries.filter(needsEvidence).map((e) => e.key));

  it('reads every source (floors, so an empty one cannot pass)', () => {
    expect(entries.filter((e) => e.ruled).length).toBeGreaterThanOrEqual(150);
    expect(entries.filter((e) => !e.ruled).length).toBeGreaterThanOrEqual(1400);
    expect(entries.filter((e) => e.spec !== undefined).length).toBeGreaterThanOrEqual(1500);
    expect(entries.filter((e) => e.verdict === 'conditional').length).toBeGreaterThanOrEqual(36);
  });

  it('every hand-made or disagreeing verdict names its evidence', () => {
    expect([...needing].filter((key) => !REPLACEMENT_EVIDENCE.has(key)).sort()).toEqual([]);
  });

  it('every evidence row still matches such a verdict', () => {
    expect([...REPLACEMENT_EVIDENCE.keys()].filter((key) => !needing.has(key)).sort()).toEqual([]);
  });

  it('every row vouches for the verdict cdkd makes today', () => {
    const byKey = new Map(entries.map((e) => [e.key, e.verdict]));
    const flipped = [...REPLACEMENT_EVIDENCE]
      .filter(([key, evidence]) => byKey.has(key) && byKey.get(key) !== evidence.verdict)
      .map(([key, evidence]) => `${key}: row ${evidence.verdict}, cdkd ${byKey.get(key)}`);
    expect(flipped).toEqual([]);
  });

  // go-to-k/cdkd#7070: the spec is a candidate list, never an oracle, so each
  // candidate is either measured (a `replace` / `update` row) or baselined.
  it('every baseline line is a candidate with no measured verdict', () => {
    const candidates = new Set(entries.filter((e) => e.candidate).map((e) => e.key));
    expect(candidates.size).toBeGreaterThanOrEqual(200);
    const stale = [...UNMEASURED_SPEC_REPLACEMENT_CANDIDATES].filter(
      (key) => !candidates.has(key) || REPLACEMENT_EVIDENCE.has(key)
    );
    expect(stale.sort()).toEqual([]);
  });

  // The generator cannot load the hand rules, so its `hand rule` label is
  // vouched for here; and a member of an array or map cannot be replaced per
  // element, so no such row may say `replace`.
  it('the generated labels hold: hand rule iff a hand rule, no element replace', () => {
    const registry = new ReplacementRulesRegistry();
    const { candidates } = loadSpecReplacementCandidates();
    const misread = candidates
      .filter(
        (c) => (labelOf(c) === 'hand rule') !== isHandDecided(registry, c.type, c.path[0]!)
      )
      .map((c) => candidateKey(c.type, c.path));
    expect(misread).toEqual([]);
    expect(candidates.filter((c) => labelOf(c) === 'unclassified')).toEqual([]);
    expect(candidates.filter((c) => labelOf(c) === 'hand rule').length).toBeGreaterThanOrEqual(40);
    const elementReplace = candidates
      .filter((c) => c.path.includes('*') && labelOf(c) === 'replace')
      .map((c) => candidateKey(c.type, c.path));
    expect(elementReplace).toEqual([]);
    expect(candidates.filter((c) => c.path.includes('*')).length).toBeGreaterThanOrEqual(30);
  });

  // The generated table must be what `vp fmt` leaves (#7083), or a formatter
  // run reds `audit:spec-replacement-properties:check`. Each branch below was
  // checked stable under `vp fmt`.
  it('a generated row breaks where the formatter breaks it', () => {
    expect(renderRow('AWS::A::B', [['X']])).toEqual(["  ['AWS::A::B', [['X']]],"]);
    expect(renderRow('AWS::A::B', [['X'], ['Y', 'Z']])).toEqual([
      "  ['AWS::A::B', [['X'], ['Y', 'Z']]],",
    ]);
    // Every path two segments or more: one per line, however short.
    expect(renderRow('AWS::A::B', [['X', 'Y'], ['X', 'Z']])).toEqual([
      '  [',
      "    'AWS::A::B',",
      '    [',
      "      ['X', 'Y'],",
      "      ['X', 'Z'],",
      '    ],',
      '  ],',
    ]);
    const mid = [['A'.repeat(30)], ['B'.repeat(25)], ['C'.repeat(20)]];
    expect(renderRow('AWS::Batch::ComputeEnvironment', mid)).toEqual([
      '  [',
      "    'AWS::Batch::ComputeEnvironment',",
      `    [['${'A'.repeat(30)}'], ['${'B'.repeat(25)}'], ['${'C'.repeat(20)}']],`,
      '  ],',
    ]);
    const long = [['A'.repeat(45)], ['B'.repeat(40)], ['C'.repeat(35)]];
    expect(renderRow('AWS::Batch::ComputeEnvironment', long)).toHaveLength(8);
  });

  // The skip set is pinned whole: a type dropping out of the snapshot (a
  // truncated refresh) or gaining a schema must be a deliberate edit.
  it('the spec types with no registry schema are exactly the committed list', () => {
    const { typesWithoutSchema } = loadSpecReplacementCandidates();
    expect(typesWithoutSchema).toEqual([...SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA.keys()].sort());
    for (const [type, kind] of SPEC_TYPES_WITHOUT_REGISTRY_SCHEMA) {
      expect(kind === 'sam-transform', type).toBe(type.startsWith('AWS::Serverless::'));
    }
  });

  it('every measured candidate is a plain replace or update', () => {
    const odd = entries
      .filter((e) => e.candidate && REPLACEMENT_EVIDENCE.has(e.key))
      .filter((e) => !['replace', 'update'].includes(REPLACEMENT_EVIDENCE.get(e.key)!.verdict))
      .map((e) => e.key);
    expect(odd).toEqual([]);
  });

  it('every row names where its evidence is recorded', () => {
    for (const [key, evidence] of REPLACEMENT_EVIDENCE) {
      if (evidence.kind === 'schema-nested') {
        const [type, prop] = key.split('#');
        const fixture = fixtures.get(type);
        expect(
          fixture?.createOnlyPropertyPaths?.some((p) => p.length > 1 && p[0] === prop),
          key
        ).toBe(true);
      } else {
        expect(evidence.refs.length, key).toBeGreaterThan(0);
      }
    }
  });

  // The reference page is not evidence on its own: it read "Some
  // interruptions" for a DynamoDB KeySchema and an Events rule's
  // EventBusName, and CloudFormation replaced both (measured on #7038). So a
  // `cfn-docs` row must say why no A/B is possible here, and it may only vouch
  // for `update`: a wrong `replace` deletes the resource (#7048).
  it('the reference alone backs only an update no A/B can measure', () => {
    const docsOnly = [...REPLACEMENT_EVIDENCE]
      .filter(
        ([, evidence]) =>
          // A `cannot-probe` row (#7083) owes the same stated reason.
          ['cfn-docs', 'cannot-probe'].includes(evidence.kind) !==
            (evidence.unmeasurable !== undefined) ||
          (['cfn-docs', 'cannot-probe'].includes(evidence.kind) &&
            (evidence.verdict !== 'update' || !evidence.unmeasurable?.trim()))
      )
      .map(([key]) => key);
    expect(docsOnly).toEqual([]);
  });

  it('a fixture-less type is still covered by the spec', () => {
    // Types with rules but no committed fixture (the corpus holds registered
    // SDK types only) are still judged against the spec.
    for (const type of [
      'AWS::Lambda::Version',
      'AWS::SSM::Document',
      'AWS::EC2::Volume',
      'AWS::ElasticLoadBalancingV2::ListenerRule',
    ]) {
      expect(existsSync(join(FIXTURES, `${type.replace(/::/g, '-')}.json`))).toBe(false);
      expect(entries.some((e) => e.key.startsWith(`${type}#`) && e.spec !== undefined)).toBe(true);
    }
  });
});
