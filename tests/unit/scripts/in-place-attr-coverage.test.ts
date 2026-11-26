import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import {
  IN_PLACE_UPDATE_ATTRS_MOVED_BY,
  IN_PLACE_UPDATE_DERIVED_ATTRS,
  IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES,
} from '../../../src/analyzer/diff-calculator/shared.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import {
  OUT_JSON,
  OUT_MD,
  buildReport,
  classificationKeyFor,
  classifyByRule,
  loadInputs,
  renderJson,
  renderMarkdown,
  type TypeInput,
} from '../../../scripts/gen-in-place-attr-coverage.ts';
import {
  SDK_IN_PLACE_ATTR_CLASSIFICATION,
  type InPlaceAttrVerdict,
} from '../../../scripts/in-place-attr-classification.ts';

/**
 * go-to-k/cdkd#7001: the in-place attribute audit. The generator's `--check`
 * (CI) holds the population classified; this suite holds the hand verdicts
 * EQUAL to the shared.ts tables the diff and the export-change guard read
 * (the generator cannot import `src/`), and pins the rules' bounds.
 */

const committed = JSON.parse(readFileSync(OUT_JSON, 'utf8')) as {
  ccBaseline: Record<string, string[]>;
};
const inputs = loadInputs();
const { report, findings } = buildReport({
  ...inputs,
  classification: SDK_IN_PLACE_ATTR_CLASSIFICATION,
  baseline: committed.ccBaseline,
});

describe('the committed audit (#7001)', () => {
  it('classifies every pair, with no stale entry, and the generated files are current', () => {
    expect(findings).toEqual({
      unclassifiedSdk: [],
      staleClassification: [],
      unclassifiedCc: [],
      staleBaseline: [],
    });
    expect(readFileSync(OUT_JSON, 'utf8')).toBe(renderJson(report));
    expect(readFileSync(OUT_MD, 'utf8')).toBe(renderMarkdown(report));
  });

  it('sees its input: a floor per population and per rule', () => {
    // Literals from the #7001 measurement, never read back from the report.
    expect(report.summary.sdkTypes).toBeGreaterThanOrEqual(131);
    expect(report.summary.sdkPairs).toBeGreaterThanOrEqual(390);
    expect(report.summary.ccPairs).toBeGreaterThanOrEqual(5500);
    expect(report.summary.ccByRule['no-in-place-update']).toBeGreaterThan(1000);
    expect(report.summary.ccByRule['creation-timestamp']).toBeGreaterThan(300);
    expect(report.summary.ccBaseline).toBeGreaterThan(0);
    expect(report.summary.ccByRule['own-identity']).toBeGreaterThan(800);
    // A type the spec lacks is read from its schema fixture.
    expect(report.sdk.some((r) => r.type === 'AWS::BedrockAgentCore::Browser')).toBe(true);
  });
});

describe('the hand verdicts equal the shared.ts tables (#7001)', () => {
  const sdkTypes = new Set(report.sdk.map((r) => r.type));

  it('every moving verdict has its row, of the same kind and properties', () => {
    for (const r of report.sdk) {
      const movedBy = IN_PLACE_UPDATE_ATTRS_MOVED_BY[r.type]?.[r.attribute];
      const derived = IN_PLACE_UPDATE_DERIVED_ATTRS[r.type]?.has(r.attribute) === true;
      const where = `${r.type} ${r.attribute}`;
      if (r.verdict === 'moved-by') {
        expect([...(movedBy ?? [])].sort(), where).toEqual([...r.properties!].sort());
        expect(derived, where).toBe(false);
      } else if (r.verdict === 'any-update') {
        expect(derived, where).toBe(true);
        expect(movedBy, where).toBeUndefined();
      } else if (r.verdict === 'prefix') {
        expect(IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES[r.type], where).toContain(r.prefix);
      } else {
        expect(movedBy, where).toBeUndefined();
        expect(derived, where).toBe(false);
      }
    }
  });

  it('every shared.ts row of an SDK type has a moving verdict', () => {
    const verdictOf = (type: string, attr: string) =>
      report.sdk.find((r) => r.type === type && r.attribute === attr)?.verdict;
    for (const [type, byAttr] of Object.entries(IN_PLACE_UPDATE_ATTRS_MOVED_BY)) {
      for (const attr of Object.keys(byAttr)) {
        expect(sdkTypes.has(type), type).toBe(true);
        expect(verdictOf(type, attr), `${type} ${attr}`).toBe('moved-by');
      }
    }
    for (const [type, attrs] of Object.entries(IN_PLACE_UPDATE_DERIVED_ATTRS)) {
      // A row of a type the spec does not list as SDK-routed (LaunchTemplate)
      // is a Cloud Control row; it must still name a real pair.
      for (const attr of attrs) {
        if (sdkTypes.has(type)) {
          expect(verdictOf(type, attr), `${type} ${attr}`).toBe('any-update');
        } else {
          // A Cloud Control row must name a real pair that no rule calls `never`.
          const t = inputs.types.find((x) => x.type === type);
          expect(t?.attributes, `${type} ${attr}`).toContain(attr);
          expect(classifyByRule(t!, attr), `${type} ${attr}`).toBeUndefined();
        }
      }
    }
    for (const type of Object.keys(IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES)) {
      expect(report.sdk.some((r) => r.type === type && r.verdict === 'prefix'), type).toBe(true);
    }
  });
});

describe('the rules agree with cdkd replacement decisions (#7001)', () => {
  it('no-in-place-update settles no type whose replacement rule makes a create-only property in place', () => {
    // The rule reads the spec's `causesReplacement`; cdkd's registry can
    // override it (`updateableProperties`, or a conditional that answers in
    // place), and then an in-place update exists.
    const registry = new ReplacementRulesRegistry();
    const overridden: string[] = [];
    let checked = 0;
    for (const [type, rule] of registry.rules) {
      if (inputs.registered.has(type)) continue; // hand-classified
      const t = inputs.types.find((x) => x.type === type);
      if (t === undefined) continue;
      checked++;
      const inPlace = [
        ...(rule.updateableProperties ?? []),
        ...(rule.conditionalReplacements?.keys() ?? []),
      ].filter((p) => t.properties[p] === 'yes');
      if (inPlace.length === 0) continue;
      for (const a of t.attributes) {
        if (classifyByRule(t, a) === 'no-in-place-update') overridden.push(`${type}.${a} (${inPlace.join(', ')})`);
      }
    }
    expect(checked, 'Cloud Control types with a replacement rule').toBeGreaterThan(0);
    expect(overridden).toEqual([]);
  });
});

describe('classifyByRule (#7001)', () => {
  const input = (
    type: string,
    properties: Record<string, string | undefined>,
    attributes: string[] = []
  ): TypeInput => ({ type, properties, attributes });

  it('settles every pair of a type whose only in-place property is Tags, bar an update timestamp', () => {
    const t = input('AWS::X::Thing', { Name: 'yes', Config: 'yes', Tags: undefined });
    expect(classifyByRule(t, 'Status')).toBe('no-in-place-update');
    // A tag edit may stamp it.
    for (const a of ['UpdatedAt', 'LastModifiedTime', 'LastUpdatedDateTime', 'UpdateTime', 'LastModificationDate']) {
      expect(classifyByRule(t, a), a).toBeUndefined();
    }
  });

  it('settles an undotted creation timestamp, never an update one or a nested member', () => {
    const t = input('AWS::X::Thing', { Config: undefined });
    for (const a of ['CreatedAt', 'CreationTime', 'CreateDate', 'CreatedTimestamp']) {
      expect(classifyByRule(t, a), a).toBe('creation-timestamp');
    }
    // A nested object an update re-creates (an MSK configuration's latest
    // revision) carries its own creation time.
    for (const a of ['UpdatedAt', 'LastModifiedTime', 'CreatedBy', 'LatestRevision.CreationTime']) {
      expect(classifyByRule(t, a), a).toBeUndefined();
    }
  });

  it("settles the type's own id or ARN only", () => {
    const t = input('AWS::X::GraphQLApi', { Config: undefined });
    for (const a of ['Arn', 'Id', 'ApiId', 'GraphQLApiArn', 'Uuid']) {
      expect(classifyByRule(t, a), a).toBe('own-identity');
    }
    // Another resource's id, a list, a version, a dotted member: not settled.
    for (const a of ['VpcId', 'SnsTopicArn', 'NetworkInterfaceIds', 'DefaultVersionId', 'Endpoint.Id']) {
      expect(classifyByRule(t, a), a).toBeUndefined();
    }
  });

  it('settles no identity of a versioned type (its ARN can carry the version an update mints)', () => {
    // AWS::GameLift::ContainerGroupDefinition: `.../<name>:<version>`.
    const versionedAttr = input('AWS::X::ContainerGroupDefinition', { Config: undefined }, [
      'ContainerGroupDefinitionArn',
      'VersionNumber',
    ]);
    expect(classifyByRule(versionedAttr, 'ContainerGroupDefinitionArn')).toBeUndefined();
    const versionedProp = input('AWS::X::Thing', { Config: undefined, VersionDescription: undefined }, ['Arn']);
    expect(classifyByRule(versionedProp, 'Arn')).toBeUndefined();
    expect(classifyByRule(input('AWS::X::Thing', { Config: undefined }, ['Arn']), 'Arn')).toBe(
      'own-identity'
    );
  });

  it('settles no identity of a type with an in-place name or path (a rename moves the ARN)', () => {
    for (const writable of ['RepositoryName', 'Name', 'Path', 'EventBusName']) {
      const t = input('AWS::X::Repository', { [writable]: undefined });
      expect(classifyByRule(t, 'Arn'), writable).toBeUndefined();
      expect(classifyByRule(t, 'RepositoryId'), writable).toBeUndefined();
    }
    // A create-only name does not block it.
    expect(classifyByRule(input('AWS::X::Repository', { Name: 'yes', Config: 'maybe' }), 'Arn')).toBe(
      'own-identity'
    );
  });
});

describe('buildReport findings (#7001)', () => {
  const never = (reason: string): InPlaceAttrVerdict => ({ kind: 'never', reason });
  const types: TypeInput[] = [
    { type: 'AWS::S::Sdk', attributes: ['Arn', 'Family.A', 'Family.B', 'Loose'], properties: {} },
    { type: 'AWS::C::Cc', attributes: ['Arn', 'Status', 'Phase'], properties: { Config: undefined } },
  ];
  const build = (
    classification: Record<string, Record<string, InPlaceAttrVerdict>>,
    baseline: Record<string, string[]>
  ) =>
    buildReport({
      types,
      registered: new Set(['AWS::S::Sdk']),
      classification,
      baseline,
      specVersion: 'test',
    }).findings;

  it('names an unclassified SDK pair and a stale classification key; a Family.* key covers members', () => {
    const f = build(
      { 'AWS::S::Sdk': { Arn: never('r'), 'Family.*': never('r'), Gone: never('r') } },
      { 'AWS::C::Cc': ['Status', 'Phase'] }
    );
    expect(f.unclassifiedSdk).toEqual(['AWS::S::Sdk.Loose']);
    expect(f.staleClassification).toEqual(['AWS::S::Sdk.Gone']);
    expect(f.unclassifiedCc).toEqual([]);
  });

  it('fails a Cloud Control pair outside the baseline, and a baseline entry a rule settles', () => {
    const f = build(
      { 'AWS::S::Sdk': { Arn: never('r'), 'Family.*': never('r'), Loose: never('r') } },
      { 'AWS::C::Cc': ['Status', 'Arn'], 'AWS::C::Removed': ['X'] }
    );
    expect(f.unclassifiedCc).toEqual(['AWS::C::Cc.Phase']);
    expect(f.staleBaseline).toEqual(['AWS::C::Cc.Arn', 'AWS::C::Removed.X']);
  });

  it('looks a dotted attribute up by its nearest Family.* key', () => {
    const byAttr = { 'A.*': never('r'), 'A.B.*': never('r') };
    expect(classificationKeyFor(byAttr, 'A.B.C')).toBe('A.B.*');
    expect(classificationKeyFor(byAttr, 'A.X')).toBe('A.*');
    expect(classificationKeyFor(byAttr, 'A')).toBeUndefined();
  });
});
