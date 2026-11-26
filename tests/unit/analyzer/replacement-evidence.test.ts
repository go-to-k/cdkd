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
    // A planner beside a rule keeps the stricter (hand-made) reading.
    if (entries.has(key) && !ruled) return;
    entries.set(key, { key, verdict, ruled, fixture: fixtures.get(type), spec: spec(type, prop) });
  };
  for (const [type, fixture] of fixtures) {
    const paths = fixture.createOnlyPropertyPaths ?? [];
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
  return [...entries.values()];
}

/** Whether the entry's verdict needs a row: hand logic, a disagreement, or no oracle. */
function needsEvidence(e: Entry): boolean {
  if (e.verdict === 'conditional') return true;
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

  it('every row names where its evidence is recorded', () => {
    for (const [key, evidence] of REPLACEMENT_EVIDENCE) {
      if (evidence.kind === 'schema-nested') {
        const [type, prop] = key.split('#');
        const fixture = loadFixtures().get(type);
        expect(
          fixture?.createOnlyPropertyPaths?.some((p) => p.length > 1 && p[0] === prop),
          key
        ).toBe(true);
      } else {
        expect(evidence.refs.length, key).toBeGreaterThan(0);
      }
    }
  });

  // The reference page is not evidence on its own for a verdict that may
  // DELETE the resource: it read "Some interruptions" for a DynamoDB KeySchema
  // and an Events rule's EventBusName, and CloudFormation replaced both
  // (measured on #7038).
  it('a verdict that can replace never rests on the documentation alone', () => {
    const docsOnly = [...REPLACEMENT_EVIDENCE]
      .filter(([key, evidence]) => {
        return evidence.kind === 'cfn-docs' && evidence.verdict !== 'update';
      })
      .map(([key]) => key);
    expect(docsOnly).toEqual([]);
  });

  it('a fixture-less type is still covered by the spec', () => {
    // EC2 Volume, Lambda Version, SSM Document and ELBv2 ListenerRule have no
    // committed fixture (the corpus holds registered SDK types only).
    for (const type of ['AWS::Lambda::Version', 'AWS::SSM::Document']) {
      expect(existsSync(join(FIXTURES, `${type.replace(/::/g, '-')}.json`))).toBe(false);
      expect(entries.some((e) => e.key.startsWith(`${type}#`) && e.spec !== undefined)).toBe(true);
    }
  });
});
