/**
 * go-to-k/cdkd#6840: a `--migrate-from-cloudformation` import records each
 * resource's properties as CloudFormation last DEPLOYED them, so a CDK change
 * made after that deploy is the next `cdkd diff` / `cdkd deploy` — as it would
 * be the next `cdk deploy`. This file fences the module's two halves directly;
 * `import.test.ts` fences the command wiring (root and nested child).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import {
  deployedPropertiesBlocker,
  overlayDeployedProperties,
  readDeployedTemplate,
  withDeployedDefinitions,
} from '../../../src/cli/commands/import/deployed-properties.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';
import type { ConsoleLogger } from '../../../src/utils/logger.js';

function logger(): { log: ConsoleLogger; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const info = vi.fn();
  return { log: { warn, info, debug: vi.fn() } as unknown as ConsoleLogger, warn, info };
}

const tpl = (
  resources: CloudFormationTemplate['Resources'],
  extra: Record<string, unknown> = {}
): CloudFormationTemplate => ({ Resources: resources, ...extra }) as CloudFormationTemplate;

describe('readDeployedTemplate', () => {
  it('asks for the PROCESSED stage of the named stack and parses JSON', async () => {
    const send = vi.fn(async () => ({
      TemplateBody: JSON.stringify({ Resources: { A: { Type: 'AWS::SNS::Topic' } } }),
    }));
    const result = await readDeployedTemplate({ send } as never, 'arn:aws:cloudformation:x', 'NOTHING WRITTEN.');
    const command = (send.mock.calls[0] as unknown[])[0] as GetTemplateCommand;
    expect(command).toBeInstanceOf(GetTemplateCommand);
    expect(command.input).toEqual({
      StackName: 'arn:aws:cloudformation:x',
      TemplateStage: 'Processed',
    });
    expect(result.Resources['A']!.Type).toBe('AWS::SNS::Topic');
  });

  it('parses a YAML body, short-form tags in their long form', async () => {
    const send = vi.fn(async () => ({
      TemplateBody: 'Resources:\n  A:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: !Ref Name\n',
    }));
    const result = await readDeployedTemplate({ send } as never, 'S', 'NOTHING WRITTEN.');
    expect(result.Resources['A']!.Properties).toEqual({ TopicName: { Ref: 'Name' } });
  });

  it('names the failure and the stage it stopped at', async () => {
    const send = vi.fn(async () => {
      throw new Error('Stack with id S does not exist');
    });
    await expect(readDeployedTemplate({ send } as never, 'S', 'NOTHING WRITTEN.')).rejects.toThrow(
      '--migrate-from-cloudformation: reading the template CloudFormation last deployed failed: Stack with id S does not exist. NOTHING WRITTEN.'
    );
  });

  it.each([
    ['no body', {}],
    ['no Resources section', { TemplateBody: '{"Outputs":{}}' }],
    ['an unparseable body', { TemplateBody: '{"Resources": {' }],
  ])('refuses %s, ending in the caller\'s consequence', async (_label, response) => {
    const send = vi.fn(async () => response);
    await expect(readDeployedTemplate({ send } as never, 'S', 'NOTHING WRITTEN.')).rejects.toThrow(
      /^--migrate-from-cloudformation: .* NOTHING WRITTEN\.$/
    );
  });
});

describe('deployedPropertiesBlocker', () => {
  const synth = tpl(
    { Sib: { Type: 'AWS::S3::Bucket' }, Me: { Type: 'AWS::SNS::Topic' } },
    {
      Parameters: { Stage: { Type: 'String', Default: 'dev' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] }, Outer: { 'Fn::Not': [{ Condition: 'IsProd' }] } },
      Mappings: { M: { a: { b: 'c' } } },
    }
  );

  it('admits pseudo parameters, declared parameters and declared resources, in every spelling', () => {
    expect(
      deployedPropertiesBlocker(
        {
          A: { Ref: 'AWS::Region' },
          B: { Ref: 'Stage' },
          C: { 'Fn::GetAtt': ['Sib', 'Arn'] },
          D: { 'Fn::GetAtt': 'Sib.Arn' },
          E: { 'Fn::Sub': '${Sib.Arn}/${AWS::AccountId}/${!Literal}' },
          F: { 'Fn::Sub': ['${Local}-${Stage}', { Local: { Ref: 'Sib' } }] },
          G: { 'Fn::If': ['Outer', 'x', { Ref: 'AWS::NoValue' }] },
          H: { 'Fn::FindInMap': ['M', 'a', 'b'] },
          // A literal single-key `Condition` object naming no declared condition
          // (SSM document content, say) is data, not a reference.
          I: { Condition: 'NotACondition' },
        },
        {},
        synth,
        synth
      )
    ).toBeUndefined();
  });

  it.each([
    ['Fn::GetAtt', { 'Fn::GetAtt': ['Sib', 'Arn'] }],
    ['Fn::Join', { 'Fn::Join': ['', ['a', { Ref: 'Sib' }]] }],
    ['Fn::Sub', { 'Fn::Sub': '${Sib}' }],
    ['Fn::Select', { 'Fn::Select': [0, ['a', 'b']] }],
    ['Fn::Split', { 'Fn::Split': [',', 'a,b'] }],
    ['Fn::If', { 'Fn::If': ['IsProd', 'a', 'b'] }],
    ['Fn::Equals', { 'Fn::Equals': ['a', 'b'] }],
    ['Fn::And', { 'Fn::And': [{ Condition: 'IsProd' }, { Condition: 'Outer' }] }],
    ['Fn::Or', { 'Fn::Or': [{ Condition: 'IsProd' }, { Condition: 'Outer' }] }],
    ['Fn::Not', { 'Fn::Not': [{ Condition: 'IsProd' }] }],
    ['Fn::FindInMap', { 'Fn::FindInMap': ['M', 'a', 'b'] }],
    ['Fn::Base64', { 'Fn::Base64': 'x' }],
    ['Fn::GetAZs', { 'Fn::GetAZs': '' }],
    ['Fn::Cidr', { 'Fn::Cidr': ['10.0.0.0/16', 2, 8] }],
  ])('admits %s, resolved from this stack alone, though the synthesized properties do not use it', (_label, node) => {
    expect(deployedPropertiesBlocker({ P: node }, { P: 'literal' }, synth, synth)).toBeUndefined();
  });

  it('counts a property-level `{Condition: X}` naming a DECLARED condition as that condition', () => {
    const deployed = tpl(synth.Resources, {
      Conditions: {
        ...(synth as unknown as { Conditions: Record<string, unknown> }).Conditions,
        IsProd: { 'Fn::Equals': ['x', 'y'] },
      },
    });
    expect(deployedPropertiesBlocker({ P: { Condition: 'IsProd' } }, {}, synth, deployed)).toBe(
      'they use condition IsProd, which the synthesized template defines differently'
    );
  });

  it('admits a sibling the code added after the last deploy (no deployed type to compare)', () => {
    const grown = tpl({ ...synth.Resources, Added: { Type: 'AWS::SQS::Queue' } }, {
      Parameters: (synth as unknown as { Parameters: unknown }).Parameters,
    });
    expect(deployedPropertiesBlocker({ P: { Ref: 'Added' } }, {}, grown, synth)).toBeUndefined();
  });

  it('refuses a sibling whose TYPE changed, which answers Ref / GetAtt as the new type', () => {
    const deployed = tpl({ ...synth.Resources, Sib: { Type: 'AWS::SQS::Queue' } });
    expect(
      deployedPropertiesBlocker({ P: { 'Fn::GetAtt': ['Sib', 'Arn'] } }, {}, synth, deployed)
    ).toBe('they reference Sib, whose type changed in the synthesized template');
  });

  it.each([
    ['Fn::ImportValue', { 'Fn::ImportValue': 'Producer:ExportsOutputRefOld' }],
    ['Fn::GetStackOutput', { 'Fn::GetStackOutput': { StackName: 'P', OutputName: 'Old' } }],
    ['an intrinsic the resolver does not model', { 'Fn::Unknown': ['x'] }],
  ])('refuses %s the synthesized properties no longer make', (_label, node) => {
    expect(deployedPropertiesBlocker({ P: node }, { P: 'literal' }, synth, synth)).toBe(
      'they read a value from another stack that the synthesized properties no longer read'
    );
  });

  it('admits a cross-stack read the synthesized properties make too, anywhere in them', () => {
    const read = { 'Fn::ImportValue': 'Producer:Shared' };
    expect(
      deployedPropertiesBlocker({ P: read, Q: 'old' }, { Other: [read], Q: 'new' }, synth, synth)
    ).toBeUndefined();
  });

  it.each([
    ['a Ref', { Ref: 'Gone' }],
    ['a GetAtt', { 'Fn::GetAtt': ['Gone', 'Arn'] }],
    ['a dotted GetAtt', { 'Fn::GetAtt': 'Gone.Arn' }],
    ['a Sub target', { 'Fn::Sub': 'x-${Gone}' }],
    ['a Sub variable value', { 'Fn::Sub': ['${V}', { V: { Ref: 'Gone' } }] }],
  ])('refuses %s naming something the synthesized template lost', (_label, value) => {
    expect(deployedPropertiesBlocker({ P: value }, {}, synth, synth)).toBe(
      'they reference Gone, which the synthesized template does not declare'
    );
  });

  it('refuses a condition defined differently, reached THROUGH another condition', () => {
    const deployed = tpl(synth.Resources, {
      Conditions: {
        IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'production'] },
        Outer: { 'Fn::Not': [{ Condition: 'IsProd' }] },
      },
    });
    expect(deployedPropertiesBlocker({ P: { 'Fn::If': ['Outer', 1, 2] } }, {}, synth, deployed)).toBe(
      'they use condition IsProd, which the synthesized template defines differently'
    );
  });

  it('refuses a mapping defined differently, and every mapping for a computed map name', () => {
    const deployed = tpl(synth.Resources, { Mappings: { M: { a: { b: 'OLD' } } } });
    expect(
      deployedPropertiesBlocker({ P: { 'Fn::FindInMap': ['M', 'a', 'b'] } }, {}, synth, deployed)
    ).toBe('they use mapping M, which the synthesized template defines differently');
    expect(
      deployedPropertiesBlocker({ P: { 'Fn::FindInMap': [{ Ref: 'Stage' }, 'a', 'b'] } }, {},
        synth,
        deployed
      )
    ).toMatch(/computed name/);
    expect(
      deployedPropertiesBlocker({ P: { 'Fn::FindInMap': [{ Ref: 'Stage' }, 'a', 'b'] } }, {}, synth, synth)
    ).toBeUndefined();
  });
});

describe('overlayDeployedProperties', () => {
  const role = (sub: unknown): TemplateResource => ({
    Type: 'AWS::IAM::Role',
    Properties: { AssumeRolePolicyDocument: { Condition: { sub } } },
    DependsOn: ['Other'],
    DeletionPolicy: 'Delete',
  });

  it('swaps in the deployed Properties only, keeping every other attribute and section synthesized', () => {
    const synth = tpl({ R: role(['a', 'b']) }, { Outputs: { O: { Value: 'synth' } } });
    const deployed = tpl(
      { R: { ...role('a'), DependsOn: [], DeletionPolicy: 'Retain' } },
      { Outputs: { O: { Value: 'deployed' } } }
    );
    const before = structuredClone(synth);
    const { log, info, warn } = logger();
    const out = overlayDeployedProperties(synth, deployed, log, 'S');
    expect(out.template.Resources['R']).toEqual({ ...role('a') });
    expect((out.template as unknown as { Outputs: unknown }).Outputs).toEqual({ O: { Value: 'synth' } });
    expect(synth).toEqual(before);
    expect(info.mock.calls.flat().join(' ')).toContain('1 resource(s) in S differ');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the synthesized Properties, silently, for a resource CloudFormation never deployed and for an unchanged one', () => {
    const synth = tpl({ New: role(['a']), Same: role('a') });
    const deployed = tpl({ Same: role('a') });
    const { log, info, warn } = logger();
    const out = overlayDeployedProperties(synth, deployed, log, 'S');
    expect(out.template.Resources).toEqual(synth.Resources);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a nested-stack row's synthesized Properties", () => {
    const nested = (url: string) => ({
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: url },
    });
    const { log } = logger();
    const out = overlayDeployedProperties(
      tpl({ Child: nested('synth') }),
      tpl({ Child: nested('deployed') }),
      log,
      'S'
    );
    expect(out.template.Resources['Child']!.Properties).toEqual({ TemplateURL: 'synth' });
  });

  it('keeps the synthesized Properties and WARNS when the type changed', () => {
    const { log, warn } = logger();
    const out = overlayDeployedProperties(
      tpl({ R: role(['a', 'b']) }),
      tpl({ R: { Type: 'AWS::IAM::User', Properties: {} } }),
      log,
      'S'
    );
    expect(out.template.Resources['R']!.Properties).toEqual(role(['a', 'b']).Properties);
    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toContain('R (AWS::IAM::Role) in S is recorded with the synthesized');
    expect(warned).toContain('CloudFormation deployed it as AWS::IAM::User');
  });

  it('keeps the synthesized Properties and WARNS when the deployed ones cannot be resolved', () => {
    const { log, warn } = logger();
    const out = overlayDeployedProperties(
      tpl({ R: role(['a', 'b']) }),
      tpl({ R: { ...role({ Ref: 'AssetParameterOld' }) } }),
      log,
      'S'
    );
    expect(out.template.Resources['R']!.Properties).toEqual(role(['a', 'b']).Properties);
    expect(warn.mock.calls.flat().join(' ')).toContain(
      'AssetParameterOld, which the synthesized template does not declare'
    );
  });

  it('records an EMPTY bag when CloudFormation deployed the resource with no Properties and the code added some', () => {
    const { log } = logger();
    const out = overlayDeployedProperties(
      tpl({ B: { Type: 'AWS::S3::Bucket', Properties: { VersioningConfiguration: { Status: 'Enabled' } } } }),
      tpl({ B: { Type: 'AWS::S3::Bucket' } }),
      log,
      'S'
    );
    expect(out.template.Resources['B']!.Properties).toEqual({});
    expect([...out.overlaid]).toEqual(['B']);
  });

  it('withDeployedDefinitions swaps in only the overlaid definitions, keeping the rest by identity', () => {
    const { log } = logger();
    const synth = tpl({ Changed: role(['a', 'b']), Same: role('a') });
    const overlay = overlayDeployedProperties(
      synth,
      tpl({ Changed: role('a'), Same: role('a') }),
      log,
      'S'
    );
    const rewritten = { Type: 'AWS::IAM::Role', Properties: { Rewritten: true } };
    const entries = [
      { logicalId: 'Changed', resource: synth.Resources['Changed']! },
      { logicalId: 'Same', resource: rewritten },
    ];
    const out = withDeployedDefinitions(entries, overlay);
    expect(out[0]!.resource.Properties).toEqual(role('a').Properties);
    expect(out[1]).toBe(entries[1]);
  });

  it('writes a `__proto__` logical id as an OWN key, never as the prototype', () => {
    const synth = tpl(JSON.parse('{"__proto__": {"Type": "AWS::SNS::Topic", "Properties": {"A": 1}}}'));
    const deployed = tpl(JSON.parse('{"__proto__": {"Type": "AWS::SNS::Topic", "Properties": {"A": 2}}}'));
    const { log } = logger();
    const out = overlayDeployedProperties(synth, deployed, log, 'S');
    expect(Object.getPrototypeOf(out.template.Resources)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out.template.Resources, '__proto__')).toBe(true);
    expect(out.template.Resources['__proto__']!.Properties).toEqual({ A: 2 });
  });
});
