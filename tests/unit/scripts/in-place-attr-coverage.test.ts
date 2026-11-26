import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import {
  IN_PLACE_UPDATE_ATTRS_MOVED_BY,
  IN_PLACE_UPDATE_DERIVED_ATTRS,
  IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES,
} from '../../../src/analyzer/diff-calculator/shared.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import {
  MOVING_RULES,
  OUT_JSON,
  OUT_MD,
  OUT_SRC,
  RULE_HELD_OUT,
  buildReport,
  classificationKeyFor,
  classifyByRule,
  loadInputs,
  renderJson,
  renderMarkdown,
  renderSrc,
  type RuleName,
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
    expect(readFileSync(OUT_SRC, 'utf8')).toBe(renderSrc(report));
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
    // Literals from the #7007 measurement.
    expect(report.summary.ccByRule['primary-identifier']).toBeGreaterThan(500);
    expect(report.summary.ccByRule['arn-template']).toBeGreaterThan(50);
    expect(report.summary.ccByRule['update-timestamp']).toBeGreaterThan(350);
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
          const rule = classifyByRule(t!, attr);
          expect(rule === undefined || MOVING_RULES.has(rule), `${type} ${attr}: ${rule}`).toBe(true);
        }
      }
    }
    for (const type of Object.keys(IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES)) {
      expect(report.sdk.some((r) => r.type === type && r.verdict === 'prefix'), type).toBe(true);
    }
  });

  it('every Cloud Control pair a moving rule settles is an IN_PLACE_UPDATE_DERIVED_ATTRS row (#7007)', () => {
    const pairs = Object.entries(report.ccMoving).flatMap(([type, attrs]) =>
      attrs.map((a) => [type, a] as const)
    );
    expect(pairs.length).toBeGreaterThan(350);
    for (const [type, attr] of pairs) {
      expect(IN_PLACE_UPDATE_DERIVED_ATTRS[type]?.has(attr), `${type} ${attr}`).toBe(true);
    }
  });
});

/**
 * go-to-k/cdkd#7007: the hand verdicts of the SDK-provider types are ground
 * truth the rules never read. A `never` rule run over those types must settle
 * no pair a hand verdict calls moving.
 */
function neverRuleOverMoving(
  classify: (t: TypeInput, a: string) => RuleName | undefined
): { conflicts: string[]; checked: number } {
  const conflicts: string[] = [];
  let checked = 0;
  for (const r of report.sdk) {
    if (r.verdict === 'never') continue;
    const t = inputs.types.find((x) => x.type === r.type);
    if (t === undefined || !t.attributes.includes(r.attribute)) continue;
    checked++;
    const rule = classify(t, r.attribute);
    if (rule !== undefined && !MOVING_RULES.has(rule)) {
      conflicts.push(`${r.type}.${r.attribute} (${r.verdict}) settled by ${rule}`);
    }
  }
  return { conflicts, checked };
}

describe('the never rules agree with the hand verdicts (#7007)', () => {
  it('no never rule settles an attribute a hand verdict calls moving', () => {
    const { conflicts, checked } = neverRuleOverMoving(classifyByRule);
    expect(checked, 'moving SDK pairs the spec carries').toBeGreaterThan(40);
    expect(conflicts).toEqual([]);
  });

  it('the check sees a rule that settles a moving attribute (it is not vacuous)', () => {
    // AWS::EC2::VPCGatewayAttachment's AttachmentType is a primary-identifier
    // member an internet / VPN gateway swap moves.
    const unshaped = (t: TypeInput, a: string): RuleName | undefined =>
      (t.primaryIdentifier ?? []).includes(a) ? 'primary-identifier' : classifyByRule(t, a);
    expect(neverRuleOverMoving(unshaped).conflicts).toContain(
      'AWS::EC2::VPCGatewayAttachment.AttachmentType (moved-by) settled by primary-identifier'
    );
  });
});

/**
 * Cloud Control pairs the no-in-place-update rule settles although `registry`
 * makes one of the type's create-only (spec `causesReplacement: yes`)
 * properties in place, through `updateableProperties` or a conditional.
 */
function overSettledByRegistry(registry: ReplacementRulesRegistry): {
  overridden: string[];
  checked: number;
} {
  const overridden: string[] = [];
  let checked = 0;
  {
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
  }
  return { overridden, checked };
}

describe('the rules agree with cdkd replacement decisions (#7001)', () => {
  it('no-in-place-update settles no type whose replacement rule makes a create-only property in place', () => {
    const { overridden, checked } = overSettledByRegistry(new ReplacementRulesRegistry());
    expect(checked, 'Cloud Control types with a replacement rule').toBeGreaterThan(0);
    expect(overridden).toEqual([]);
  });

  it('the check sees an injected override (it is not vacuous)', () => {
    const target = inputs.types.find(
      (t) =>
        !inputs.registered.has(t.type) &&
        t.attributes.some((a) => classifyByRule(t, a) === 'no-in-place-update')
    )!;
    const createOnly = Object.keys(target.properties).find((p) => target.properties[p] === 'yes')!;
    const registry = new ReplacementRulesRegistry();
    registry.rules.set(target.type, {
      replacementProperties: new Set(),
      updateableProperties: new Set([createOnly]),
    });
    expect(overSettledByRegistry(registry).overridden.length).toBeGreaterThan(0);
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
    // A tag edit may stamp it: moving, never `no-in-place-update`.
    for (const a of ['UpdatedAt', 'LastModifiedTime', 'LastUpdatedDateTime', 'UpdateTime', 'LastModificationDate']) {
      expect(classifyByRule(t, a), a).toBe('update-timestamp');
    }
    for (const a of ['LastModifiedBy', 'UpdateStatus']) {
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
    for (const a of ['CreatedBy', 'LatestRevision.CreationTime']) {
      expect(classifyByRule(t, a), a).toBeUndefined();
    }
    for (const a of ['UpdatedAt', 'LastModifiedTime']) {
      expect(classifyByRule(t, a), a).toBe('update-timestamp');
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
    // A revision no name shows: `job-definition/<name>:<revision>`.
    const batch = inputs.types.find((t) => t.type === 'AWS::Batch::JobDefinition')!;
    expect(classifyByRule(batch, 'JobDefinitionArn')).toBeUndefined();
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

describe('the #7007 rules, on real spec inputs', () => {
  const real = (type: string): TypeInput => {
    const t = inputs.types.find((x) => x.type === type);
    expect(t, type).toBeDefined();
    return t!;
  };

  it('primary-identifier settles an identity-shaped primary-identifier member only', () => {
    // AgentName is in place, so own-identity cannot settle AgentId.
    const agent = real('AWS::Bedrock::Agent');
    expect(agent.primaryIdentifier).toEqual(['AgentId']);
    expect(classifyByRule(agent, 'AgentId')).toBe('primary-identifier');
    expect(classifyByRule(agent, 'AgentArn')).toBeUndefined();
    // A composite identifier: each identity-shaped member.
    const alias = real('AWS::Bedrock::AgentAlias');
    expect(classifyByRule(alias, 'AgentAliasId')).toBe('primary-identifier');
    // A member of another shape is derived from writable input.
    const attachment = real('AWS::EC2::VPCGatewayAttachment');
    expect(attachment.primaryIdentifier).toContain('AttachmentType');
    expect(classifyByRule(attachment, 'AttachmentType')).toBeUndefined();
  });

  it('holds out a pair whose live probe is pending', () => {
    const link = real('AWS::ApiGatewayV2::VpcLink');
    expect(link.primaryIdentifier).toEqual(['VpcLinkId']);
    expect(RULE_HELD_OUT.has('AWS::ApiGatewayV2::VpcLink.VpcLinkId')).toBe(true);
    expect(classifyByRule(link, 'VpcLinkId')).toBeUndefined();
  });

  it('arn-template settles an ARN built only from fixed values', () => {
    // fleet/${FleetName} over the create-only primary identifier Name.
    expect(classifyByRule(real('AWS::AppStream::Fleet'), 'Arn')).toBe('arn-template');
    // knowledge-base/${KnowledgeBaseId}, the primary identifier.
    expect(classifyByRule(real('AWS::Bedrock::KnowledgeBase'), 'KnowledgeBaseArn')).toBe(
      'arn-template'
    );
    // bot:${BotName} names the in-place Name: not settled.
    expect(classifyByRule(real('AWS::Lex::Bot'), 'Arn')).toBeUndefined();
    // ${ResourceId} names no property or identifier.
    expect(classifyByRule(real('AWS::QuickSight::DataSet'), 'Arn')).toBeUndefined();
    // A versioned type: the ARN can carry the version an update mints.
    expect(
      classifyByRule(real('AWS::GameLift::ContainerGroupDefinition'), 'ContainerGroupDefinitionArn')
    ).toBeUndefined();
  });

  it('arn-template reads every placeholder (synthetic)', () => {
    const t = (arnTemplate: string): TypeInput => ({
      type: 'AWS::X::Widget',
      attributes: ['Arn'],
      properties: { Name: undefined, Kind: 'yes' },
      primaryIdentifier: ['WidgetId'],
      arnTemplate,
    });
    const env = 'arn:${Partition}:x:${Region}:${Account}:';
    for (const ok of ['widget/${WidgetId}', 'widget/${Kind}/${WidgetId}']) {
      expect(classifyByRule(t(env + ok), 'Arn'), ok).toBe('arn-template');
    }
    for (const bad of ['widget/${WidgetName}', 'widget/${WidgetId}/${Name}', 'widget/${Other}']) {
      expect(classifyByRule(t(env + bad), 'Arn'), bad).toBeUndefined();
    }
    const { arnTemplate: _, ...none } = t(env);
    expect(classifyByRule(none, 'Arn')).toBeUndefined();
  });

  it('update-timestamp settles a real last-update time as moving', () => {
    const rule = real('AWS::AccessAnalyzer::ArchiveRule');
    expect(classifyByRule(rule, 'UpdatedAt')).toBe('update-timestamp');
    expect(MOVING_RULES.has('update-timestamp')).toBe(true);
    expect(MOVING_RULES.has('primary-identifier')).toBe(false);
    expect(MOVING_RULES.has('arn-template')).toBe(false);
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
