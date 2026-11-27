import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import { CC_IN_PLACE_UPDATE_DERIVED_ATTRS } from '../../../src/analyzer/diff-calculator/in-place-cc-derived-attrs.generated.js';
import {
  HAND_IN_PLACE_UPDATE_DERIVED_ATTRS,
  IN_PLACE_UPDATE_ATTRS_MOVED_BY,
  IN_PLACE_UPDATE_DERIVED_ATTRS,
  IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES,
} from '../../../src/analyzer/diff-calculator/shared.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import {
  MOVING_RULES,
  NOT_UPDATE_MARKERS,
  OUT_JSON,
  OUT_MD,
  OUT_SRC,
  RULE_HELD_OUT,
  buildReport,
  classificationKeyFor,
  classifyByRule,
  loadInputs,
  registryTopLevelCreateOnly,
  typeInputFromSpec,
  renderJson,
  renderMarkdown,
  renderSrc,
  type RuleName,
  type TypeInput,
} from '../../../scripts/gen-in-place-attr-coverage.ts';
import {
  SDK_IN_PLACE_ATTR_CLASSIFICATION,
  type InPlaceAttrVerdict,
  mergeDisjoint,
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
    // #7007 part 5: a tag-only type's statuses left it for operational-status.
    expect(report.summary.ccByRule['no-in-place-update']).toBeGreaterThan(950);
    expect(report.summary.ccByRule['creation-timestamp']).toBeGreaterThan(300);
    expect(report.summary.ccBaseline).toBeGreaterThan(0);
    expect(report.summary.ccByRule['own-identity']).toBeGreaterThan(800);
    // Literals from the #7007 measurement.
    expect(report.summary.ccByRule['primary-identifier']).toBeGreaterThan(400);
    expect(report.summary.ccByRule['arn-template']).toBeGreaterThan(50);
    expect(report.summary.ccByRule['update-timestamp']).toBeGreaterThan(350);
    expect(report.summary.ccByRule.creator).toBeGreaterThan(20);
    expect(report.summary.ccByRule['owner-account']).toBeGreaterThan(25);
    expect(report.summary.ccByRule['identifier-arn-member']).toBeGreaterThan(60);
    expect(report.summary.ccByRule['update-marker']).toBeGreaterThan(130);
    expect(report.summary.ccByRule['parent-fixed']).toBeGreaterThan(0);
    // go-to-k/cdkd#7007 part 5.
    expect(report.summary.ccByRule['operational-status']).toBeGreaterThan(450);
    expect(report.summary.ccByRule['primary-identifier']).toBeGreaterThan(480);
    expect(report.summary.ccByRule['arn-template']).toBeGreaterThan(85);
    // #7007: the measured rename probes are hand verdicts, merged in without
    // dropping a type both tables name.
    const v: InPlaceAttrVerdict = { kind: 'never', reason: 'r' };
    expect(() => mergeDisjoint({ 'AWS::X::Y': { A: v } }, { 'AWS::X::Y': { B: v } })).toThrow(
      'classified twice: AWS::X::Y'
    );
    expect(report.summary.ccByHand).toBeGreaterThan(70);
    expect(report.ccHand).toContainEqual(
      expect.objectContaining({ type: 'AWS::EC2::PrefixList', attribute: 'Arn', verdict: 'never' })
    );
    // A type the spec lacks is read from its schema fixture.
    expect(report.sdk.some((r) => r.type === 'AWS::BedrockAgentCore::Browser')).toBe(true);
  });
});

describe('the hand verdicts equal the shared.ts tables (#7001)', () => {
  // go-to-k/cdkd#7007: a Cloud Control pair classified by hand is held equal too.
  const hand = [...report.sdk, ...report.ccHand];
  const sdkTypes = new Set(hand.map((r) => r.type));

  it('every moving verdict has its row, of the same kind and properties', () => {
    for (const r of hand) {
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
      hand.find((r) => r.type === type && r.attribute === attr)?.verdict;
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
        // An SDK type's row, or a Cloud Control pair classified by hand, is a
        // hand any-update; any other Cloud Control row is a rule's (#7007).
        if (inputs.registered.has(type) || verdictOf(type, attr) !== undefined) {
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

  it('no generated row is also a hand row (the export guard defers a generated one) (#7007)', () => {
    const overlap = Object.entries(CC_IN_PLACE_UPDATE_DERIVED_ATTRS).flatMap(([type, attrs]) =>
      attrs.filter((a) => HAND_IN_PLACE_UPDATE_DERIVED_ATTRS[type]?.has(a) === true).map((a) => `${type}.${a}`)
    );
    expect(Object.keys(HAND_IN_PLACE_UPDATE_DERIVED_ATTRS).length).toBeGreaterThan(0);
    expect(overlap).toEqual([]);
  });

  it('no Cloud Control hand never overrides a moving rule, nor a hand verdict a never rule it agrees with (#7007)', () => {
    expect(report.ccHand.length).toBeGreaterThan(0);
    for (const r of report.ccHand) {
      const t = inputs.types.find((x) => x.type === r.type)!;
      const rule = classifyByRule(t, r.attribute);
      const where = `${r.type}.${r.attribute}: ${rule} under a ${r.verdict} hand verdict`;
      // A hand never silencing a moving rule hides a move; a hand never over
      // a never rule is dead. A hand move over a never rule corrects a rule
      // reading the stale spec (the DataSync locations).
      if (r.verdict === 'never') expect(rule, where).toBeUndefined();
    }
    // The live registry makes the S3 location's Subdirectory in place, so no
    // rule settles its URI; the hand verdict moves it (#7007 part 5).
    const s3 = report.ccHand.find((r) => r.type === 'AWS::DataSync::LocationS3');
    expect(classifyByRule(inputs.types.find((x) => x.type === s3!.type)!, 'LocationUri')).toBeUndefined();
    expect(s3?.verdict).toBe('moved-by');
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
    expect(classifyByRule(t, 'Config2')).toBe('no-in-place-update');
    expect(classifyByRule(t, 'Status')).toBe('operational-status');
    // A tag edit may stamp it: moving, never `no-in-place-update`.
    for (const a of ['UpdatedAt', 'LastModifiedTime', 'LastUpdatedDateTime', 'UpdateTime', 'LastModificationDate']) {
      expect(classifyByRule(t, a), a).toBe('update-timestamp');
    }
    // The last writer is moving too (#7007), and so is a status (part 5).
    expect(classifyByRule(t, 'LastModifiedBy')).toBe('update-marker');
    expect(classifyByRule(t, 'UpdateStatus')).toBe('operational-status');
  });

  it('settles an undotted creation timestamp, never an update one or a nested member', () => {
    const t = input('AWS::X::Thing', { Config: undefined });
    for (const a of ['CreatedAt', 'CreationTime', 'CreateDate', 'CreatedTimestamp']) {
      expect(classifyByRule(t, a), a).toBe('creation-timestamp');
    }
    // A nested object an update re-creates (an MSK configuration's latest
    // revision) carries its own creation time.
    expect(classifyByRule(t, 'LatestRevision.CreationTime')).toBeUndefined();
    // #7007: the creator is a creation fact too.
    expect(classifyByRule(t, 'CreatedBy')).toBe('creator');
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
    for (const a of ['VpcId', 'SnsTopicArn', 'NetworkInterfaceIds', 'Endpoint.Id']) {
      expect(classifyByRule(t, a), a).toBeUndefined();
    }
    // A version is moving (#7007), never own identity.
    expect(classifyByRule(t, 'DefaultVersionId')).toBe('update-marker');
  });

  it('settles no own identity of a versioned type outside its primary identifier (its ARN can carry the version an update mints)', () => {
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
    // An ARN with no template on a VERSIONED type whose name or alias is in
    // place (MajorVersion, VersionBump): its ARN may carry the version.
    const activation = real('AWS::CloudFormation::TypeActivation');
    expect(activation.arnTemplate).toBeUndefined();
    expect(activation.primaryIdentifier).toContain('Arn');
    expect(classifyByRule(activation, 'Arn')).toBeUndefined();
    // sampling-rule/${SamplingRuleName} ends with the in-place RuleName.
    const sampling = real('AWS::XRay::SamplingRule');
    expect(sampling.primaryIdentifier).toContain('RuleARN');
    expect(classifyByRule(sampling, 'RuleARN')).toBeUndefined();
    // A composite identifier: each identity-shaped member.
    const alias = real('AWS::Bedrock::AgentAlias');
    expect(classifyByRule(alias, 'AgentAliasId')).toBe('primary-identifier');
    // A member of another shape is derived from writable input.
    const attachment = real('AWS::EC2::VPCGatewayAttachment');
    expect(attachment.primaryIdentifier).toContain('AttachmentType');
    expect(classifyByRule(attachment, 'AttachmentType')).toBeUndefined();
    // A version an update can mint: `...:message-template/<id>:<version>`.
    const version = real('AWS::Wisdom::MessageTemplateVersion');
    expect(version.primaryIdentifier).toContain('MessageTemplateVersionArn');
    expect(classifyByRule(version, 'MessageTemplateVersionArn')).toBeUndefined();
    // A primary-identifier ARN whose template names the in-place Name.
    const segment = real('AWS::Evidently::Segment');
    expect(segment.primaryIdentifier).toContain('Arn');
    expect(classifyByRule(segment, 'Arn')).toBeUndefined();
  });

  it('primary-identifier reads the name and the template (synthetic)', () => {
    const t = (attr: string, arnTemplate?: string): TypeInput => ({
      type: 'AWS::X::Widget',
      attributes: [attr, 'VersionNumber'],
      properties: { Name: undefined, Kind: 'yes' },
      primaryIdentifier: [attr],
      ...(arnTemplate !== undefined && { arnTemplate }),
    });
    // Versioned type, unversioned id: the contract settles it.
    expect(classifyByRule(t('WidgetId'), 'WidgetId')).toBe('primary-identifier');
    expect(classifyByRule(t('WidgetVersionArn'), 'WidgetVersionArn')).toBeUndefined();
    expect(classifyByRule(t('WidgetRevisionId'), 'WidgetRevisionId')).toBeUndefined();
    expect(classifyByRule(t('WidgetArn', 'arn:x:widget/${Kind}/${ResourceId}'), 'WidgetArn')).toBe(
      'primary-identifier'
    );
    for (const ph of ['Name', 'WidgetName', 'OtherWidgetName']) {
      expect(classifyByRule(t('WidgetArn', `arn:x:widget/\${${ph}}`), 'WidgetArn'), ph).toBeUndefined();
    }
  });

  it('settles no own id of an association an in-place target change re-creates', () => {
    // ReplaceRouteTableAssociation answers a new association id.
    const gateway = real('AWS::EC2::GatewayRouteTableAssociation');
    expect(gateway.properties.RouteTableId).not.toBe('yes');
    expect(classifyByRule(gateway, 'AssociationId')).toBeUndefined();
    // ...and its hand verdict wins over the rules.
    expect(report.ccHand).toContainEqual(
      expect.objectContaining({
        type: 'AWS::EC2::GatewayRouteTableAssociation',
        attribute: 'AssociationId',
        verdict: 'moved-by',
        properties: ['RouteTableId'],
      })
    );
    const synthetic = (type: string): TypeInput => ({
      type,
      attributes: ['AssociationId'],
      properties: { TargetId: undefined },
    });
    expect(classifyByRule(synthetic('AWS::X::ThingAssociation'), 'AssociationId')).toBeUndefined();
    expect(classifyByRule(synthetic('AWS::X::Association'), 'AssociationId')).toBeUndefined();
    expect(classifyByRule(synthetic('AWS::X::Thing'), 'Id')).toBe('own-identity');
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
    // ${ResourceId} is the own id, a primary-identifier member (DataSetId)
    // (#7007 part 5).
    expect(real('AWS::QuickSight::DataSet').primaryIdentifier).toContain('DataSetId');
    expect(classifyByRule(real('AWS::QuickSight::DataSet'), 'Arn')).toBe('arn-template');
    // eventbridge-rule-template:${EventBridgeRuleTemplateId} over the
    // primary identifier Identifier; a rename kept it (measured).
    expect(classifyByRule(real('AWS::MediaLive::EventBridgeRuleTemplate'), 'Arn')).toBe('arn-template');
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
    for (const bad of [
      'widget/${WidgetName}',
      'widget/${SpecialWidgetName}',
      'widget/${WidgetId}/${Name}',
      'widget/${Other}',
    ]) {
      expect(classifyByRule(t(env + bad), 'Arn'), bad).toBeUndefined();
    }
    const { arnTemplate: _, ...none } = t(env);
    expect(classifyByRule(none, 'Arn')).toBeUndefined();
  });
  it('arn-template takes an own-id placeholder only over a primary-identifier id (#7007 part 5)', () => {
    const t = (arnTemplate: string, primaryIdentifier: string[]): TypeInput => ({
      type: 'AWS::X::TaskDefinition',
      attributes: ['Arn'],
      properties: { Name: undefined },
      primaryIdentifier,
      arnTemplate: `arn:\${Partition}:x:\${Region}:\${Account}:${arnTemplate}`,
    });
    for (const ph of ['ResourceId', 'Id', 'Identifier', 'TaskDefinitionId', 'GatewayTaskDefinitionId']) {
      expect(classifyByRule(t(`task/\${${ph}}`, ['Id']), 'Arn'), ph).toBe('arn-template');
      // No id in the primary identifier (a name, an account): not settled.
      expect(classifyByRule(t(`task/\${${ph}}`, ['Name']), 'Arn'), ph).toBeUndefined();
      expect(classifyByRule(t(`task/\${${ph}}`, ['AwsAccountId']), 'Arn'), ph).toBeUndefined();
    }
    // Another resource's id is no own-id placeholder.
    for (const ph of ['VpcId', 'GatewayId', 'TaskId']) {
      expect(classifyByRule(t(`task/\${${ph}}`, ['Id']), 'Arn'), ph).toBeUndefined();
    }
  });

  it('primary-identifier settles a template-less ARN on an unversioned type with an in-place name (#7007 part 5)', () => {
    // Measured: BCM Dashboard / CloudWatch MetricDataQueryDefinition /
    // InspectorV2 Filter renames kept the ARN.
    for (const type of [
      'AWS::BCM::Dashboard',
      'AWS::CloudWatch::MetricDataQueryDefinition',
      'AWS::InspectorV2::Filter',
    ]) {
      expect(real(type).arnTemplate, type).toBeUndefined();
      expect(classifyByRule(real(type), 'Arn'), type).toBe('primary-identifier');
    }
    const t = (attributes: string[]): TypeInput => ({
      type: 'AWS::X::Widget',
      attributes,
      properties: { Name: undefined },
      primaryIdentifier: ['Arn'],
    });
    expect(classifyByRule(t(['Arn']), 'Arn')).toBe('primary-identifier');
    // A versioned type's ARN may carry the version.
    expect(classifyByRule(t(['Arn', 'VersionNumber']), 'Arn')).toBeUndefined();
    // An in-place parent or foreign reference the ARN may embed, or a name
    // that is not the resource's own: not settled.
    for (const prop of ['InstanceArn', 'ControlPanelArn', 'ParentId', 'GroupIdentifier', 'TypeName', 'SshKeyName']) {
      const withProp = { ...t(['Arn']), properties: { Name: undefined, [prop]: undefined } };
      expect(classifyByRule(withProp, 'Arn'), prop).toBeUndefined();
    }
    for (const prop of ['DisplayName', 'Path', 'WidgetName']) {
      const own = { ...t(['Arn']), properties: { [prop]: undefined } };
      expect(classifyByRule(own, 'Arn'), prop).toBe('primary-identifier');
    }
    // Real cases: `type-configuration/hook/<TypeName>/<alias>` over an
    // in-place TypeName; an ARN under an in-place control panel or instance.
    for (const [type, attr] of [
      ['AWS::CloudFormation::HookTypeConfig', 'ConfigurationArn'],
      ['AWS::Route53RecoveryControl::SafetyRule', 'SafetyRuleArn'],
      ['AWS::Connect::TestCase', 'TestCaseArn'],
      ['AWS::Connect::ContactFlow', 'ContactFlowArn'],
    ] as const) {
      expect(real(type).arnTemplate, type).toBeUndefined();
      expect(classifyByRule(real(type), attr), type).toBeUndefined();
      expect(report.ccBaseline[type], type).toContain(attr);
    }
  });

  it('operational-status settles a status, its explanation and a member status as moving (#7007 part 5)', () => {
    // Measured: a Description-only update moved State create-complete ->
    // modify-complete on both.
    expect(classifyByRule(real('AWS::EC2::IPAMPool'), 'State')).toBe('operational-status');
    expect(classifyByRule(real('AWS::EC2::IPAMResourceDiscovery'), 'State')).toBe(
      'operational-status'
    );
    const t: TypeInput = {
      type: 'AWS::X::Thing',
      attributes: [
        'Status',
        'ConnectionState',
        'StatusReason',
        'FailureReason',
        'Health',
        'Exclusions',
        'Exclusions.Nat.State',
        'Owner',
        'Stateful',
        'StatusArn',
      ],
      properties: { Config: undefined },
    };
    for (const a of ['Status', 'ConnectionState', 'StatusReason', 'FailureReason', 'Health', 'Exclusions.Nat.State']) {
      expect(classifyByRule(t, a), a).toBe('operational-status');
    }
    for (const a of ['Exclusions', 'Owner', 'Stateful', 'StatusArn']) {
      expect(classifyByRule(t, a), a).not.toBe('operational-status');
    }
    // A tag-only type's status is moving too; its other pairs stay settled.
    const tagOnly = { ...t, properties: { Config: 'yes' } };
    expect(classifyByRule(tagOnly, 'Status')).toBe('operational-status');
    expect(classifyByRule(tagOnly, 'Exclusions.Nat.State')).toBe('operational-status');
    expect(classifyByRule(tagOnly, 'Owner')).toBe('no-in-place-update');
  });

  it('reads create-only from the live registry snapshot, the spec only for a type it lacks (#7007 part 5)', () => {
    const created = registryTopLevelCreateOnly(new Map([['AWS::X::Thing', [['Name'], ['Config', 'Inner']]]]));
    // A nested create-only path leaves its top-level property in place.
    expect([...created.get('AWS::X::Thing')!]).toEqual(['Name']);
    const resource = {
      cloudFormationType: 'AWS::X::Thing',
      properties: { Name: {}, Config: { causesReplacement: 'yes' }, Path: { causesReplacement: 'yes' } },
      attributes: { Arn: {} },
    } as unknown as Parameters<typeof typeInputFromSpec>[0];
    expect(typeInputFromSpec(resource, created.get('AWS::X::Thing'))?.properties).toEqual({
      Name: 'yes',
      Config: undefined,
      Path: undefined,
    });
    expect(typeInputFromSpec(resource)?.properties).toEqual({ Name: undefined, Config: 'yes', Path: 'yes' });
    // The pinned spec calls the S3 location's Subdirectory create-only; the
    // live registry does not.
    expect(real('AWS::DataSync::LocationS3').properties.Subdirectory).toBeUndefined();
  });

  it('classifies every pair the stale spec settled differently from the live registry (#7078, #7007 part 5)', () => {
    // #7078 measured 21 pairs whose rule verdict changes under the live
    // create-only list: 5 move, 14 do not, 2 are held out.
    const sq = [
      'SQErrorReportConfiguration',
      'SQKmsKeyId',
      'SQName',
      'SQNotificationConfiguration',
      'SQQueryString',
      'SQScheduleConfiguration',
      'SQScheduledQueryExecutionRoleArn',
      'SQTargetConfiguration',
    ];
    const expected: Record<string, string> = {
      'AWS::DataSync::LocationEFS.LocationUri': 'moved-by',
      'AWS::DataSync::LocationFSxLustre.LocationUri': 'moved-by',
      'AWS::DataSync::LocationFSxONTAP.LocationUri': 'moved-by',
      'AWS::DataSync::LocationFSxOpenZFS.LocationUri': 'moved-by',
      'AWS::DataSync::LocationS3.LocationUri': 'moved-by',
      'AWS::Connect::ViewVersion.Version': 'never',
      'AWS::Connect::ViewVersion.ViewVersionArn': 'never',
      'AWS::DataSync::LocationFSxONTAP.FsxFilesystemArn': 'never',
      'AWS::EntityResolution::SchemaMapping.HasWorkflows': 'never',
      'AWS::EntityResolution::SchemaMapping.SchemaArn': 'never',
      'AWS::Location::Map.DataSource': 'never',
      ...Object.fromEntries(sq.map((a) => [`AWS::Timestream::ScheduledQuery.${a}`, 'never'])),
      'AWS::DataSync::LocationFSxONTAP.Protocol.SMB.ManagedSecretConfig': 'baseline',
      'AWS::DataSync::LocationFSxONTAP.Protocol.SMB.CmkSecretConfig.SecretArn': 'baseline',
    };
    expect(Object.keys(expected)).toHaveLength(21);
    for (const [pair, verdict] of Object.entries(expected)) {
      const i = pair.indexOf('.', pair.lastIndexOf('::'));
      const [type, attribute] = [pair.slice(0, i), pair.slice(i + 1)];
      const hand = report.ccHand.find((r) => r.type === type && r.attribute === attribute);
      const actual =
        hand?.verdict ?? (report.ccBaseline[type]?.includes(attribute) === true ? 'baseline' : 'rule');
      expect(actual, pair).toBe(verdict);
      // The stale spec's no-in-place-update no longer fires on any of them.
      expect(classifyByRule(real(type), attribute), pair).not.toBe('no-in-place-update');
    }
  });

  it('creator and owner-account settle creation facts; the owner only with no in-place account', () => {
    expect(classifyByRule(real('AWS::DataZone::Project'), 'CreatedBy')).toBe('creator');
    expect(classifyByRule(real('AWS::Route53Resolver::FirewallRuleGroup'), 'CreatorRequestId')).toBe(
      'creator'
    );
    expect(classifyByRule(real('AWS::NetworkManager::VpcAttachment'), 'OwnerAccountId')).toBe(
      'owner-account'
    );
    // An in-place billing owner account: not settled.
    const reservation = real('AWS::EC2::CapacityReservation');
    expect(Object.keys(reservation.properties).some((p) => /Account|Owner/.test(p))).toBe(true);
    expect(classifyByRule(reservation, 'OwnerId')).toBeUndefined();
    // A bare OwnerId can name another owner: a sync configuration's
    // repository owner moves with its RepositoryLinkId (a hand verdict).
    const sync = real('AWS::CodeStarConnections::SyncConfiguration');
    expect(sync.properties.RepositoryLinkId).not.toBe('yes');
    expect(classifyByRule(sync, 'OwnerId')).toBeUndefined();
    expect(report.ccHand).toContainEqual(
      expect.objectContaining({
        type: 'AWS::CodeStarConnections::SyncConfiguration',
        attribute: 'OwnerId',
        verdict: 'moved-by',
        properties: ['RepositoryLinkId'],
      })
    );
    // ...and so do the repository's name and provider.
    for (const attribute of ['RepositoryName', 'ProviderType']) {
      expect(report.ccHand, attribute).toContainEqual(
        expect.objectContaining({
          type: 'AWS::CodeStarConnections::SyncConfiguration',
          attribute,
          verdict: 'moved-by',
          properties: ['RepositoryLinkId'],
        })
      );
    }
    // A bare `Owner` may be a principal, not an account.
    expect(classifyByRule({ type: 'AWS::X::Thing', attributes: ['Owner'], properties: { Config: undefined } }, 'Owner')).toBeUndefined();
  });

  it('identifier-arn-member settles an id its fixed primary-identifier ARN embeds', () => {
    // flow/${FlowId} over the primary identifier Arn.
    const flow = real('AWS::Bedrock::Flow');
    expect(flow.primaryIdentifier).toEqual(['Arn']);
    expect(classifyByRule(flow, 'Id')).toBe('identifier-arn-member');
    // assessmentFramework/${AssessmentFrameworkId} holds FrameworkId.
    expect(classifyByRule(real('AWS::AuditManager::AssessmentFramework'), 'FrameworkId')).toBe(
      'identifier-arn-member'
    );
    // workspace/${ResourceId} names no attribute.
    expect(classifyByRule(real('AWS::AWSExternalAnthropic::Workspace'), 'Id')).toBeUndefined();
    const t = (arnTemplate: string, primaryIdentifier = ['WidgetArn']): TypeInput => ({
      type: 'AWS::X::Widget',
      attributes: ['WidgetArn', 'WidgetId', 'Id', 'OtherId'],
      properties: { Name: undefined },
      primaryIdentifier,
      arnTemplate,
    });
    const tpl = 'arn:${Partition}:x:${Region}:${Account}:widget/${WidgetId}';
    expect(classifyByRule(t(tpl), 'WidgetId')).toBe('identifier-arn-member');
    expect(classifyByRule(t(tpl), 'Id')).toBe('identifier-arn-member');
    expect(classifyByRule(t(tpl), 'OtherId')).toBeUndefined();
    // The ARN is not the primary identifier, or its template names the in-place Name.
    expect(classifyByRule(t(tpl, ['WidgetId']), 'Id')).toBeUndefined();
    expect(classifyByRule(t(`${tpl}/\${WidgetName}`), 'Id')).toBeUndefined();
  });

  it('update-marker settles a version or last writer as moving, never a fixed one', () => {
    expect(classifyByRule(real('AWS::CodePipeline::Pipeline'), 'Version')).toBe('update-marker');
    expect(classifyByRule(real('AWS::CloudFront::ConnectionGroup'), 'ETag')).toBe('update-marker');
    expect(classifyByRule(real('AWS::SSM::OpsItem'), 'LastModifiedBy')).toBe('update-marker');
    // A primary-identifier version is fixed by the contract; an initial one never moves.
    const plan = real('AWS::AutoScalingPlans::ScalingPlan');
    expect(plan.primaryIdentifier).toContain('ScalingPlanVersion');
    expect(classifyByRule(plan, 'ScalingPlanVersion')).toBeUndefined();
    expect(classifyByRule(real('AWS::Glue::Schema'), 'InitialSchemaVersionId')).toBeUndefined();
    // A snapshot's source version, and a service-side catalog or software
    // level, are not written by an update: hand verdicts, not markers.
    expect(classifyByRule(real('AWS::Redshift::Snapshot'), 'ClusterVersion')).toBeUndefined();
    for (const pair of NOT_UPDATE_MARKERS) {
      const i = pair.lastIndexOf('.');
      expect(classifyByRule(real(pair.slice(0, i)), pair.slice(i + 1)), pair).toBeUndefined();
      expect(
        report.ccHand.some((r) => `${r.type}.${r.attribute}` === pair && r.verdict === 'never'),
        pair
      ).toBe(true);
    }
    // An in-place AppVersion change moves the current version's end of life.
    expect(classifyByRule(real('AWS::SageMaker::PartnerApp'), 'CurrentVersionEolDate')).toBe(
      'update-marker'
    );
    // A version resource's own number is its identity, not a counter.
    expect(classifyByRule(real('AWS::Lambda::Version'), 'Version')).toBeUndefined();
    expect(MOVING_RULES.has('update-marker')).toBe(true);
    for (const r of ['creator', 'owner-account', 'identifier-arn-member'] as const) {
      expect(MOVING_RULES.has(r), r).toBe(false);
    }
  });

  it('a dotted member follows its settled parent attribute (#7007)', () => {
    // The member is part of the parent's value.
    const store = real('AWS::HealthLake::FHIRDatastore');
    expect(classifyByRule(store, 'CreatedAt')).toBe('creation-timestamp');
    expect(classifyByRule(store, 'CreatedAt.Seconds')).toBe('parent-fixed');
    const theme = real('AWS::QuickSight::Theme');
    expect(classifyByRule(theme, 'Version')).toBe('update-marker');
    expect(classifyByRule(theme, 'Version.Arn')).toBe('update-marker');
    // A member update time is moving even under a never parent.
    const contact = real('AWS::NotificationsContacts::EmailContact');
    expect(classifyByRule(contact, 'EmailContact')).toBe('no-in-place-update');
    expect(classifyByRule(contact, 'EmailContact.UpdateTime')).toBe('update-marker');
    // A member of an unsettled parent, or of a property, is not settled.
    const synthetic: TypeInput = {
      type: 'AWS::X::Thing',
      attributes: ['Endpoint', 'Endpoint.Address', 'Config.Id'],
      properties: { Config: undefined },
    };
    expect(classifyByRule(synthetic, 'Endpoint.Address')).toBeUndefined();
    expect(classifyByRule(synthetic, 'Config.Id')).toBeUndefined();
    expect(MOVING_RULES.has('parent-fixed')).toBe(false);
  });

  it('the reasoned hand verdicts include the DataSync URI moves (#7007)', () => {
    for (const [type, props] of [
      ['AWS::DataSync::LocationNFS', ['Subdirectory', 'ServerHostname']],
      ['AWS::DataSync::LocationFSxWindows', ['Subdirectory']],
      ['AWS::DataSync::LocationS3', ['Subdirectory']],
      ['AWS::DataSync::LocationFSxONTAP', ['Subdirectory', 'Protocol']],
      ['AWS::DataSync::LocationObjectStorage', ['Subdirectory', 'ServerHostname']],
      ['AWS::DataSync::LocationHDFS', ['Subdirectory', 'NameNodes']],
    ] as const) {
      expect(report.ccHand, type).toContainEqual(
        expect.objectContaining({ type, attribute: 'LocationUri', verdict: 'moved-by', properties: [...props] })
      );
    }
    expect(report.ccHand).toContainEqual(
      expect.objectContaining({ type: 'AWS::Lightsail::Instance', attribute: 'InstanceArn', verdict: 'never' })
    );
  });

  it('update-timestamp settles a real last-update time as moving', () => {
    const rule = real('AWS::AccessAnalyzer::ArchiveRule');
    expect(classifyByRule(rule, 'UpdatedAt')).toBe('update-timestamp');
    expect(MOVING_RULES.has('update-timestamp')).toBe(true);
    expect(MOVING_RULES.has('operational-status')).toBe(true);
    expect(MOVING_RULES.has('primary-identifier')).toBe(false);
    expect(MOVING_RULES.has('arn-template')).toBe(false);
  });
});

describe('buildReport findings (#7001)', () => {
  const never = (reason: string): InPlaceAttrVerdict => ({ kind: 'never', reason });
  const types: TypeInput[] = [
    { type: 'AWS::S::Sdk', attributes: ['Arn', 'Family.A', 'Family.B', 'Loose'], properties: {} },
    { type: 'AWS::C::Cc', attributes: ['Arn', 'Endpoint', 'Phase'], properties: { Config: undefined } },
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
      { 'AWS::C::Cc': ['Endpoint', 'Phase'] }
    );
    expect(f.unclassifiedSdk).toEqual(['AWS::S::Sdk.Loose']);
    expect(f.staleClassification).toEqual(['AWS::S::Sdk.Gone']);
    expect(f.unclassifiedCc).toEqual([]);
  });

  it('fails a Cloud Control pair outside the baseline, and a baseline entry a rule settles', () => {
    const f = build(
      { 'AWS::S::Sdk': { Arn: never('r'), 'Family.*': never('r'), Loose: never('r') } },
      { 'AWS::C::Cc': ['Endpoint', 'Arn'], 'AWS::C::Removed': ['X'] }
    );
    expect(f.unclassifiedCc).toEqual(['AWS::C::Cc.Phase']);
    expect(f.staleBaseline).toEqual(['AWS::C::Cc.Arn', 'AWS::C::Removed.X']);
  });

  it('settles no member of a parent the hand classification calls moving (#7007)', () => {
    const t: TypeInput = {
      type: 'AWS::C::Stamped',
      attributes: ['CreatedAt', 'CreatedAt.Seconds'],
      properties: { Config: undefined },
    };
    const run = (verdict: InPlaceAttrVerdict) =>
      buildReport({
        types: [t],
        registered: new Set(),
        classification: { 'AWS::C::Stamped': { CreatedAt: verdict } },
        baseline: {},
        specVersion: 'test',
      }).findings.unclassifiedCc;
    expect(classifyByRule(t, 'CreatedAt.Seconds')).toBe('parent-fixed');
    expect(run({ kind: 'any-update', reason: 'r' })).toEqual(['AWS::C::Stamped.CreatedAt.Seconds']);
    expect(run(never('r'))).toEqual([]);
  });

  it('looks a dotted attribute up by its nearest Family.* key', () => {
    const byAttr = { 'A.*': never('r'), 'A.B.*': never('r') };
    expect(classificationKeyFor(byAttr, 'A.B.C')).toBe('A.B.*');
    expect(classificationKeyFor(byAttr, 'A.X')).toBe('A.*');
    expect(classificationKeyFor(byAttr, 'A')).toBeUndefined();
  });
});
