import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import {
  classifyPassedParameters,
  maskedInputFingerprint,
  nestedStackOutputClass,
  parameterInputsFor,
  type ChildTemplateLoader,
  type MaskedInputSources,
  type NestedTemplate,
} from '../../../src/deployment/masked-property-fingerprints.js';
import { childTemplateLoader } from '../../../src/deployment/nested-output-templates.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * A parent's masked property reading a nested stack's output
 * (go-to-k/cdkd#4565): the output is classified from the TEMPLATES alone, and
 * only a clean one is resolved (through the parent's own record of it).
 */
const SECRET = '{{resolve:ssm-secure:/app/pw}}';
const script = (input: unknown): unknown => ({
  'Fn::Base64': { 'Fn::Join': ['', ['t=', input, ';pw=', SECRET]] },
});
const getAtt = (output: string, stack = 'Child'): unknown => ({
  'Fn::GetAtt': [stack, `Outputs.${output}`],
});

/** A loader over in-memory templates, keyed by logical id per level. */
interface Tree {
  template: CloudFormationTemplate;
  identity?: string;
  children?: Record<string, Tree>;
}
function loaderOf(children: Record<string, Tree>, prefix = ''): ChildTemplateLoader {
  return (logicalId) => {
    if (!Object.hasOwn(children, logicalId)) return undefined;
    const tree = children[logicalId]!;
    const entry: NestedTemplate = {
      template: tree.template,
      identity: tree.identity ?? `${prefix}/${logicalId}`,
      childTemplate: loaderOf(tree.children ?? {}, `${prefix}/${logicalId}`),
    };
    return entry;
  };
}

const CHILD: CloudFormationTemplate = {
  Mappings: {
    // The leaf an output reads is plain; another leaf of the map is a reference.
    Secrets: { a: { plain: 'p', hidden: '{{resolve:secretsmanager:s}}' } },
    Plain: { a: { b: 'v' } },
  },
  Parameters: {
    PassedClean: { Type: 'String' },
    PassedSecret: { Type: 'String' },
    PassedUnread: { Type: 'String' },
    PassedNoEcho: { Type: 'String', NoEcho: true },
    Defaulted: { Type: 'String', Default: 'dflt' },
    DefaultRef: { Type: 'String', Default: '{{resolve:ssm-secure:/d}}' },
    NoDefault: { Type: 'String' },
    HiddenDefault: { Type: 'String', NoEcho: true, Default: 'x' },
    // `NoEcho` spelled as the string CloudFormation also accepts.
    HiddenString: { Type: 'String', NoEcho: 'true' as unknown as boolean, Default: 'x' },
  },
  Conditions: {
    CleanCond: { 'Fn::Equals': [{ Ref: 'Defaulted' }, 'dflt'] },
    SecretCond: { 'Fn::Equals': [{ Ref: 'PassedNoEcho' }, 'x'] },
    UnreadCond: { 'Fn::Equals': [{ Ref: 'PassedUnread' }, 'x'] },
    ResourceCond: { 'Fn::Equals': [{ Ref: 'Target' }, 'x'] },
    // A condition over a map that holds a reference: one bit of it.
    SecretMapCond: { 'Fn::Equals': [{ 'Fn::FindInMap': ['Secrets', 'a', 'plain'] }, 'x'] },
    DynamicMapCond: { 'Fn::Equals': [{ 'Fn::FindInMap': [{ Ref: 'Defaulted' }, 'a', 'b'] }, 'x'] },
  },
  Resources: {
    Target: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Value: 'v' } },
    ReadsSecret: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: 'n2', Value: '{{resolve:ssm-secure:/s}}' },
    },
    ReadsClean: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: { Ref: 'PassedClean' }, Value: 'v' },
    },
    // One step away from the output: a resource that reads the secret map.
    ReadsSecretMap: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: 'm', Value: { 'Fn::FindInMap': ['Secrets', 'a', 'plain'] } },
    },
    ReadsDynamicMap: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: 'm2', Value: { 'Fn::FindInMap': [{ Ref: 'Defaulted' }, 'a', 'b'] } },
    },
    ReadsCleanMap: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: 'm3', Value: { 'Fn::FindInMap': ['Plain', 'a', 'b'] } },
    },
    ReadsUnread: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: { Ref: 'PassedUnread' }, Value: 'v' },
    },
    Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn' } },
    Grand: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } },
    GrandPassingUnread: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'u', Parameters: { G: { Ref: 'PassedUnread' } } },
    },
    GrandIntrinsic: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'u', Parameters: { 'Fn::If': ['CleanCond', {}, {}] } },
    },
    GrandPassing: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: {
        TemplateURL: 'u',
        Parameters: { G: { Ref: 'PassedClean' }, H: { Ref: 'PassedNoEcho' } },
      },
    },
  },
  Outputs: {
    Arn: { Value: { 'Fn::GetAtt': ['Target', 'Arn'] } },
    Name: { Value: { Ref: 'Target' } },
    Literal: { Value: 'plain' },
    Pseudo: { Value: { 'Fn::Sub': '${AWS::Region}-${Target}' } },
    FromClean: { Value: { Ref: 'PassedClean' } },
    FromSecret: { Value: { Ref: 'PassedSecret' } },
    FromUnread: { Value: { Ref: 'PassedUnread' } },
    FromNoEcho: { Value: { Ref: 'PassedNoEcho' } },
    FromDefault: { Value: { Ref: 'Defaulted' } },
    FromDefaultRef: { Value: { Ref: 'DefaultRef' } },
    FromNoDefault: { Value: { Ref: 'NoDefault' } },
    FromHiddenDefault: { Value: { Ref: 'HiddenDefault' } },
    FromReadsSecret: { Value: { Ref: 'ReadsSecret' } },
    FromReadsClean: { Value: { 'Fn::GetAtt': ['ReadsClean', 'Arn'] } },
    Reference: { Value: { 'Fn::Join': ['', ['a', '{{resolve:secretsmanager:s}}']] } },
    Imported: { Value: { 'Fn::ImportValue': 'export-name' } },
    StackOutput: {
      Value: { 'Fn::GetStackOutput': { StackName: 's', OutputName: 'o' } },
    },
    Undeclared: { Value: { Ref: 'NotDeclared' } },
    UndeclaredSub: { Value: { 'Fn::Sub': '${NotDeclared}' } },
    CustomAttr: { Value: { 'Fn::GetAtt': ['Cr', 'Out'] } },
    CustomSub: { Value: { 'Fn::Sub': '${Cr.Out}' } },
    CustomRef: { Value: { Ref: 'Cr' } },
    IfClean: { Value: { 'Fn::If': ['CleanCond', { Ref: 'Target' }, 'b'] } },
    IfSecretCond: { Value: { 'Fn::If': ['SecretCond', 'a', 'b'] } },
    IfSecretBranch: { Value: { 'Fn::If': ['CleanCond', 'a', { Ref: 'PassedNoEcho' }] } },
    IfUnreadCond: { Value: { 'Fn::If': ['UnreadCond', 'a', 'b'] } },
    CondClean: { Condition: 'CleanCond', Value: { Ref: 'Target' } },
    CondSecret: { Condition: 'SecretCond', Value: { Ref: 'Target' } },
    GrandOut: { Value: { 'Fn::GetAtt': ['Grand', 'Outputs.Y'] } },
    GrandSub: { Value: { 'Fn::Sub': 'g-${Grand.Outputs.Y}' } },
    GrandSecret: { Value: { 'Fn::GetAtt': ['Grand', 'Outputs.Hidden'] } },
    GrandPassedClean: { Value: { 'Fn::GetAtt': ['GrandPassing', 'Outputs.FromG'] } },
    GrandPassedSecret: { Value: { 'Fn::GetAtt': ['GrandPassing', 'Outputs.FromH'] } },
    GrandNotOutput: { Value: { 'Fn::GetAtt': ['Grand', 'Arn'] } },
    ComputedAttrName: { Value: { 'Fn::GetAtt': ['Target', { Ref: 'PassedNoEcho' }] } },
    FromReadsUnread: { Value: { Ref: 'ReadsUnread' } },
    // A transient read beside a structural unknown: the structural one wins,
    // so the form does not depend on whether the read succeeded this time.
    UnreadAndCustom: {
      Value: { 'Fn::Join': ['', [{ Ref: 'PassedUnread' }, { 'Fn::GetAtt': ['Cr', 'Out'] }]] },
    },
    GrandIntrinsicOut: { Value: { 'Fn::GetAtt': ['GrandIntrinsic', 'Outputs.Y'] } },
    GrandPassedUnread: { Value: { 'Fn::GetAtt': ['GrandPassingUnread', 'Outputs.FromG'] } },
    GrandStringForm: { Value: { 'Fn::GetAtt': 'Grand.Outputs.Y' } },
    FromHiddenString: { Value: { Ref: 'HiddenString' } },
    IfUndeclaredCond: { Value: { 'Fn::If': ['NoSuchCondition', 'a', 'b'] } },
    IfResourceCond: { Value: { 'Fn::If': ['ResourceCond', 'a', 'b'] } },
    MapSecret: { Value: { 'Fn::FindInMap': ['Secrets', 'a', 'plain'] } },
    MapClean: { Value: { 'Fn::FindInMap': ['Plain', 'a', 'b'] } },
    MapSecretKey: { Value: { 'Fn::FindInMap': ['Plain', { Ref: 'PassedNoEcho' }, 'b'] } },
    MapDynamicName: { Value: { 'Fn::FindInMap': [{ Ref: 'Defaulted' }, 'a', 'b'] } },
    MapUndeclared: { Value: { 'Fn::FindInMap': ['Nope', 'a', 'b'] } },
    MapProto: { Value: { 'Fn::FindInMap': ['__proto__', 'a', 'b'] } },
    FromSecretMapResource: { Value: { 'Fn::GetAtt': ['ReadsSecretMap', 'Value'] } },
    FromDynamicMapResource: { Value: { Ref: 'ReadsDynamicMap' } },
    FromCleanMapResource: { Value: { 'Fn::GetAtt': ['ReadsCleanMap', 'Value'] } },
    CondSecretMap: { Condition: 'SecretMapCond', Value: 'x' },
    IfSecretMapCond: { Value: { 'Fn::If': ['SecretMapCond', 'a', 'b'] } },
    CondDynamicMap: { Condition: 'DynamicMapCond', Value: 'x' },
    MalformedGetAtt: { Value: { 'Fn::GetAtt': 5 } },
    GetAttUndeclared: { Value: { 'Fn::GetAtt': ['Nope', 'Arn'] } },
    RefNonString: { Value: { Ref: ['Target'] } },
    SubNonString: { Value: { 'Fn::Sub': [{ Ref: 'Target' }] } },
    SubVarSecret: { Value: { 'Fn::Sub': ['${V}', { V: { Ref: 'PassedNoEcho' } }] } },
    SubVarClean: { Value: { 'Fn::Sub': ['${V}-${Target.Arn}', { V: { Ref: 'Defaulted' } }] } },
    SubReference: { Value: { 'Fn::Sub': 'x-{{resolve:ssm-secure:/x}}' } },
    IfMalformed: { Value: { 'Fn::If': 'CleanCond' } },
    CondMalformed: { Condition: 5 as unknown as string, Value: 'x' },
    NoValue: { Description: 'no value' } as unknown as { Value: string },
    GrandNotOutputPrefixed: { Value: { 'Fn::GetAtt': ['Grand', 'Foobars.Y'] } },
  },
};
const GRAND: CloudFormationTemplate = {
  Parameters: {
    G: { Type: 'String' },
    H: { Type: 'String' },
    Hidden: { Type: 'String', NoEcho: true, Default: 'x' },
  },
  Resources: { Leaf: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 't' } } },
  Outputs: {
    Y: { Value: { Ref: 'Leaf' } },
    Hidden: { Value: { Ref: 'Hidden' } },
    FromG: { Value: { Ref: 'G' } },
    FromH: { Value: { Ref: 'H' } },
  },
};

const PARENT: CloudFormationTemplate = {
  Parameters: {
    P: { Type: 'String' },
    Hidden: { Type: 'String', NoEcho: true },
  },
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b' } },
    Unresolvable: { Type: 'AWS::SNS::Topic', Properties: {} },
    Child: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: {
        TemplateURL: 'u',
        Parameters: {
          PassedClean: { Ref: 'Bucket' },
          PassedSecret: { Ref: 'Hidden' },
          PassedUnread: { Ref: 'Unresolvable' },
          PassedNoEcho: { Ref: 'P' },
        },
      },
    },
    Sibling: {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'u', Parameters: { FromChild: getAtt('Name') } },
    },
    Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn' } },
  },
};
const TREE: Record<string, Tree> = {
  Child: {
    template: CHILD,
    children: {
      Grand: { template: GRAND },
      GrandPassing: { template: GRAND },
      GrandIntrinsic: { template: GRAND },
      GrandPassingUnread: { template: GRAND },
    },
  },
};

interface Fixture {
  template?: CloudFormationTemplate;
  loader?: ChildTemplateLoader | undefined;
  resolved?: Record<string, unknown>;
  recorded?: Record<string, string>;
}
function sources(f: Fixture = {}): MaskedInputSources & { resolve: ReturnType<typeof vi.fn> } {
  const template = f.template ?? PARENT;
  const { parameterInput } = parameterInputsFor({
    template,
    values: { P: 'one', Hidden: 'hidden-value-1' },
  });
  return {
    template,
    parameterInput,
    conditions: {},
    childTemplate: 'loader' in f ? f.loader : loaderOf(TREE),
    resolve: vi.fn((node: unknown) => {
      const key = JSON.stringify(node);
      const resolved = {
        [JSON.stringify({ Ref: 'Bucket' })]: 'bucket-1',
        ...(f.resolved ?? {}),
      };
      if (!Object.hasOwn(resolved, key)) return Promise.reject(new Error(`unresolvable ${key}`));
      const secrets = new Map<string, string>();
      const recorded = f.recorded?.[key];
      if (recorded !== undefined) secrets.set(recorded, SECRET);
      return Promise.resolve({ value: resolved[key], secrets });
    }),
  };
}
const classOf = (output: string, f?: Fixture) =>
  nestedStackOutputClass('Child', `Outputs.${output}`, sources(f));
const key = (output: string, stack = 'Child') => JSON.stringify(getAtt(output, stack));

describe('nestedStackOutputClass: taint over the child template (go-to-k/cdkd#4565)', () => {
  it('a resource, a literal, a pseudo parameter and a clean-resource attribute are clean', async () => {
    for (const output of [
      'Arn',
      'Name',
      'Literal',
      'Pseudo',
      'FromReadsClean',
      'SubVarClean',
      'MapClean',
      'FromCleanMapResource',
      'GrandStringForm',
    ]) {
      expect(await classOf(output), output).toBe('clean');
    }
  });

  it('a parameter: the class the PARENT gave its passed value, or its Default when not passed', async () => {
    expect(await classOf('FromClean')).toBe('clean');
    expect(await classOf('FromSecret')).toBe('secret');
    // The parent could not read it this time: neither compared nor hashed.
    expect(await classOf('FromUnread')).toBe('unread');
    expect(await classOf('FromReadsUnread')).toBe('unread');
    expect(await classOf('FromDefault')).toBe('clean');
    // A Default that is a reference, and a parameter with neither a passed
    // value nor a Default, fail closed.
    expect(await classOf('FromDefaultRef')).toBe('secret');
    expect(await classOf('FromNoDefault')).toBe('secret');
  });

  it('a child NoEcho parameter is secret whatever the parent passed, a clean value or its Default', async () => {
    // `PassedNoEcho` is passed `{Ref: P}`, which the parent classifies clean.
    const classes = await classifyPassedParameters(
      (PARENT.Resources['Child']!.Properties as Record<string, unknown>)['Parameters'],
      sources()
    );
    expect(classes.get('PassedNoEcho')).toBe('clean');
    expect(await classOf('FromNoEcho')).toBe('secret');
    expect(await classOf('FromHiddenDefault')).toBe('secret');
  });

  it('fails closed: a reference, a cross-stack read, an undeclared name, a secret-reading resource', async () => {
    for (const output of [
      'Reference',
      'Imported',
      'StackOutput',
      'Undeclared',
      'UndeclaredSub',
      'FromReadsSecret',
      'ComputedAttrName',
      'MalformedGetAtt',
      'GetAttUndeclared',
      'SubVarSecret',
      'SubReference',
      'FromHiddenString',
      // The mapping leaf is not in the operands: the whole map counts.
      'MapSecret',
      'MapSecretKey',
      // ...and one step away: a resource or a condition reading such a map.
      'FromSecretMapResource',
      'FromDynamicMapResource',
      'CondSecretMap',
      'IfSecretMapCond',
    ]) {
      expect(await classOf(output), output).toBe('secret');
    }
  });

  it("a custom resource's attribute inside the child is unknown (kept as written); its physical id is clean", async () => {
    expect(await classOf('CustomAttr')).toBe('unknown');
    expect(await classOf('CustomSub')).toBe('unknown');
    expect(await classOf('CustomRef')).toBe('clean');
  });

  it('the tree cannot say: no loader, a missing or throwing template, an undeclared output, a non-output attribute', async () => {
    expect(await classOf('Name', { loader: undefined })).toBe('unknown');
    expect(await classOf('Name', { loader: () => undefined })).toBe('unknown');
    expect(
      await classOf('Name', {
        loader: () => {
          throw new Error('unreadable');
        },
      })
    ).toBe('unknown');
    expect(await classOf('NotAnOutput')).toBe('unknown');
    for (const name of ['toString', 'constructor', '__proto__']) {
      expect(await classOf(name), name).toBe('unknown');
    }
    // Not an `Outputs.` attribute, even one whose tail names an output.
    expect(await nestedStackOutputClass('Child', 'Foobars.Name', sources())).toBe('unknown');
    expect(await classOf('GrandNotOutputPrefixed')).toBe('unknown');
    for (const output of [
      'RefNonString',
      'SubNonString',
      'IfMalformed',
      'CondMalformed',
      'NoValue',
      'UnreadAndCustom',
      'GrandIntrinsicOut',
      // Fixed by the template, not a read that failed this time.
      'IfUndeclaredCond',
      'IfResourceCond',
      'MapDynamicName',
      'MapUndeclared',
      'MapProto',
      'CondDynamicMap',
    ]) {
      expect(await classOf(output), output).toBe('unknown');
    }
    expect(
      await classOf('Name', {
        loader: () => ({ template: null as never, identity: 'x', childTemplate: () => undefined }),
      })
    ).toBe('unknown');
    expect(
      await classOf('GrandOut', {
        loader: () => ({
          template: CHILD,
          identity: 'c',
          childTemplate: () => {
            throw new Error('unreadable');
          },
        }),
      })
    ).toBe('unknown');
    expect(await nestedStackOutputClass('Child', undefined, sources())).toBe('unknown');
    // Only a nested-stack row has outputs, whatever the loader answers for it.
    expect(
      await nestedStackOutputClass(
        'Bucket',
        'Outputs.Name',
        sources({ loader: () => ({ template: CHILD, identity: 'c', childTemplate: () => undefined }) })
      )
    ).toBe('unknown');
    expect(await classOf('GrandNotOutput')).toBe('unknown');
  });

  it('a row whose Parameters is not a plain map is unknown', async () => {
    const template: CloudFormationTemplate = {
      ...PARENT,
      Conditions: { C: { 'Fn::Equals': ['a', 'a'] } },
      Resources: {
        ...PARENT.Resources,
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { 'Fn::If': ['C', {}, {}] } },
        },
      },
    };
    expect(await classOf('Name', { template })).toBe('unknown');
  });

  it('conditions: no child verdict is evaluated; an Fn::If needs a clean closure AND two clean branches', async () => {
    expect(await classOf('IfClean')).toBe('clean');
    expect(await classOf('IfSecretCond')).toBe('secret');
    // The condition reads only clean inputs, yet one branch is secret: the
    // verdict that would pick the clean branch is not evaluated.
    expect(await classOf('IfSecretBranch')).toBe('secret');
    expect(await classOf('IfUnreadCond')).toBe('unread');
    // An output that exists by a condition: secret when the closure reads
    // one (its presence is one bit of it), else as its Value.
    expect(await classOf('CondClean')).toBe('clean');
    expect(await classOf('CondSecret')).toBe('secret');
  });

  it('recursion: a grandchild output is classified with the passed classes computed over the CHILD template', async () => {
    expect(await classOf('GrandOut')).toBe('clean');
    expect(await classOf('GrandSub')).toBe('clean');
    expect(await classOf('GrandSecret')).toBe('secret');
    // `G` is the child's `{Ref: PassedClean}` (clean), `H` its NoEcho parameter.
    expect(await classOf('GrandPassedClean')).toBe('clean');
    expect(await classOf('GrandPassedSecret')).toBe('secret');
    // The child passes on a value the parent could not read: `unknown` to the
    // grandchild, so an output reading it is neither compared nor hashed.
    expect(await classOf('GrandPassedUnread')).toBe('unread');
    // A grandchild the tree does not hold.
    expect(
      await classOf('GrandOut', { loader: loaderOf({ Child: { template: CHILD } }) })
    ).toBe('unknown');
  });

  it('a cyclic template tree, and one deeper than the bound, are unknown; a row cycle terminates', async () => {
    // The grandchild IS the child's file.
    const cyclic: Record<string, Tree> = {
      Child: { template: CHILD, identity: 'same', children: { Grand: { template: CHILD, identity: 'same' } } },
    };
    const self: CloudFormationTemplate = {
      Resources: { Grand: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } } },
      Outputs: { Y: { Value: { 'Fn::GetAtt': ['Grand', 'Outputs.Y'] } } },
    };
    expect(
      await nestedStackOutputClass(
        'Child',
        'Outputs.Y',
        sources({ loader: loaderOf({ Child: { template: self, identity: 'same', children: { Grand: { template: self, identity: 'same' } } } }) })
      )
    ).toBe('unknown');
    expect(await classOf('GrandOut', { loader: loaderOf(cyclic) })).toBe('unknown');
    // Refused at its first repeat, not at the depth bound.
    const repeats: ChildTemplateLoader = vi.fn(() => ({
      template: self,
      identity: 'same',
      childTemplate: repeats,
    }));
    expect(await classOf('Y', { loader: repeats })).toBe('unknown');
    expect(repeats).toHaveBeenCalledTimes(2);
    // Distinct files all the way down: stopped by the depth bound.
    const endless: ChildTemplateLoader = (() => {
      let n = 0;
      const next: ChildTemplateLoader = () => ({
        template: self,
        identity: `level-${n++}`,
        childTemplate: next,
      });
      return next;
    })();
    expect(await nestedStackOutputClass('Child', 'Outputs.Y', sources({ loader: endless }))).toBe(
      'unknown'
    );
    // Two rows of one child, each passing the other's output.
    const rows: CloudFormationTemplate = {
      Resources: {
        A: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { G: { 'Fn::GetAtt': ['B', 'Outputs.FromG'] } } },
        },
        B: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { G: { 'Fn::GetAtt': ['A', 'Outputs.FromG'] } } },
        },
      },
      Outputs: { X: { Value: { 'Fn::GetAtt': ['A', 'Outputs.FromG'] } } },
    };
    expect(
      await nestedStackOutputClass(
        'Child',
        'Outputs.X',
        sources({
          loader: loaderOf({ Child: { template: rows, children: { A: { template: GRAND }, B: { template: GRAND } } } }),
        })
      )
    ).toBe('secret');
  });

  it('bounded: a row cycle in the PARENT stops at once, and an exponential tree at the step budget', async () => {
    // Two parent rows each passing the other's output.
    const template: CloudFormationTemplate = {
      Resources: {
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { G: getAtt('FromG', 'Sibling') } },
        },
        Sibling: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { G: getAtt('FromG', 'Child') } },
        },
      },
    };
    const loads = vi.fn(() => ({ template: GRAND, identity: 'g', childTemplate: () => undefined }));
    expect(await classOf('FromG', { template, loader: loads })).toBe('secret');
    expect(loads.mock.calls.length).toBeLessThan(5);

    // A child whose rows each pass the next row's output twice: 2^16 paths
    // without the memo, one classification per row and output with it.
    const depth = 16;
    const resources: CloudFormationTemplate['Resources'] = {};
    for (let i = 0; i < depth; i++) {
      resources[`R${i}`] = {
        Type: 'AWS::CloudFormation::Stack',
        Properties: {
          TemplateURL: 'u',
          Parameters:
            i === depth - 1
              ? {}
              : { G: getAtt('FromG', `R${i + 1}`), H: getAtt('FromG', `R${i + 1}`) },
        },
      };
    }
    const wide: CloudFormationTemplate = {
      Resources: resources,
      Outputs: { X: { Value: getAtt('FromG', 'R0') } },
    };
    const leafTemplate = {
      ...GRAND,
      Parameters: { G: { Type: 'String', Default: 'd' }, H: { Type: 'String' } },
    };
    const leafLoads = vi.fn(() => ({
      template: leafTemplate,
      identity: 'leaf',
      childTemplate: () => undefined,
    }));
    expect(
      await classOf('X', {
        loader: () => ({ template: wide, identity: 'wide', childTemplate: leafLoads }),
      })
    ).toBe('clean');
    expect(leafLoads.mock.calls.length).toBeLessThanOrEqual(2 * depth);

    // The same fan-out in the PARENT's rows.
    const parentRows: CloudFormationTemplate = { Resources: {} };
    const parentResolved: Record<string, unknown> = {};
    for (let i = 0; i < depth; i++) {
      parentRows.Resources[i === 0 ? 'Child' : `S${i}`] = {
        Type: 'AWS::CloudFormation::Stack',
        Properties: {
          TemplateURL: 'u',
          Parameters:
            i === depth - 1
              ? {}
              : { G: getAtt('FromG', `S${i + 1}`), H: getAtt('FromG', `S${i + 1}`) },
        },
      };
      if (i > 0) parentResolved[key('FromG', `S${i}`)] = 'd';
    }
    const parentLoads = vi.fn(() => ({
      template: leafTemplate,
      identity: 'leaf',
      childTemplate: () => undefined,
    }));
    expect(
      await classOf('FromG', { template: parentRows, loader: parentLoads, resolved: parentResolved })
    ).toBe('clean');
    expect(parentLoads.mock.calls.length).toBeLessThanOrEqual(2 * depth);
  });

  it('a CDK-shaped sibling chain (6 levels x 10 passed outputs) stays clean, in linear work', async () => {
    const levels = 6;
    const width = 10;
    const template: CloudFormationTemplate = { Resources: {} };
    const resolved: Record<string, unknown> = {};
    const outputs: Record<string, unknown> = {};
    const parameters: Record<string, unknown> = {};
    for (let j = 0; j < width; j++) {
      parameters[`P${j}`] = { Type: 'String' };
      outputs[`O${j}`] = { Value: { Ref: `P${j}` } };
    }
    for (let i = 0; i < levels; i++) {
      const row = i === 0 ? 'Child' : `L${i}`;
      const passed: Record<string, unknown> = {};
      for (let j = 0; j < width; j++) {
        passed[`P${j}`] = i === levels - 1 ? 'literal' : getAtt(`O${j}`, `L${i + 1}`);
        if (i > 0) resolved[key(`O${j}`, row)] = `v-${i}-${j}`;
      }
      template.Resources[row] = {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { TemplateURL: 'u', Parameters: passed },
      };
    }
    const loads = vi.fn(() => ({
      template: { Parameters: parameters, Resources: {}, Outputs: outputs } as CloudFormationTemplate,
      identity: 'level',
      childTemplate: () => undefined,
    }));
    const s = sources({ template, loader: loads, resolved });
    expect(await nestedStackOutputClass('Child', 'Outputs.O0', s)).toBe('clean');
    expect(loads.mock.calls.length).toBeLessThanOrEqual(levels * width);
    expect(s.resolve.mock.calls.length).toBeLessThanOrEqual(levels * width);
  });

  it('a chain of child templates whose outputs each read the next level twice stays clean', async () => {
    // Without the output memo this is 2^20 classifications, past the budget.
    const level = (i: number): NestedTemplate => ({
      template:
        i === 20
          ? { Resources: {}, Outputs: { X: { Value: 'leaf' }, Y: { Value: 'leaf' } } }
          : {
              Resources: { Next: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } } },
              Outputs: {
                X: { Value: { 'Fn::Join': ['', [getAtt('X', 'Next'), getAtt('Y', 'Next')]] } },
                Y: { Value: { 'Fn::Join': ['', [getAtt('X', 'Next'), getAtt('Y', 'Next')]] } },
              },
            },
      identity: `level-${i}`,
      childTemplate: () => level(i + 1),
    });
    expect(await classOf('X', { loader: () => level(0) })).toBe('clean');
  });

  it('the step budget stops a tree the memo cannot shorten, in the child and in the parent', async () => {
    const n = 12_000;
    // A child reading n rows, each its own template: n distinct classifications.
    const rows: CloudFormationTemplate = { Resources: {} };
    const reads: unknown[] = [];
    for (let i = 0; i < n; i++) {
      rows.Resources[`R${i}`] = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } };
      reads.push(getAtt('Y', `R${i}`));
    }
    rows.Outputs = { X: { Value: { 'Fn::Join': ['', reads] } } };
    expect(
      await classOf('X', {
        loader: () => ({
          template: rows,
          identity: 'rows',
          childTemplate: (id) => ({ template: GRAND, identity: id, childTemplate: () => undefined }),
        }),
      })
    ).toBe('unknown');
    // A parent passing n rows' outputs, all one template: n row classifications.
    const parent: CloudFormationTemplate = { Resources: {} };
    const parentReads: unknown[] = [];
    for (let i = 0; i < n; i++) {
      parent.Resources[`S${i}`] = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } };
      parentReads.push(getAtt('Y', `S${i}`));
    }
    const classes = await classifyPassedParameters(
      { P: { 'Fn::Join': ['', parentReads] } },
      {
        template: parent,
        parameterInput: () => ({ kind: 'secret' }),
        childTemplate: () => ({ template: GRAND, identity: 'g', childTemplate: () => undefined }),
        resolve: async () => ({ value: 'v' }),
      }
    );
    expect(classes.get('P')).toBe('secret');
  });

  it('two nested reads in one value give the same hash whatever order their resolutions settle in', async () => {
    // Read A spends all but one step of the budget, read B two: whichever is
    // classified LAST is cut off. In template order that is always B.
    const n = 9_997;
    const big: CloudFormationTemplate = { Parameters: { Q: { Type: 'String' } }, Resources: {} };
    const reads: unknown[] = [];
    for (let i = 0; i < n; i++) {
      big.Resources[`R${i}`] = { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } };
      reads.push(getAtt('Y', `R${i}`));
    }
    big.Outputs = { X: { Value: { 'Fn::Join': ['', reads] } } };
    const template: CloudFormationTemplate = {
      ...PARENT,
      Resources: {
        ...PARENT.Resources,
        Bucket2: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b2' } },
        Big: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { Q: { Ref: 'Bucket2' } } },
        },
      },
    };
    const loader: ChildTemplateLoader = (id) =>
      id === 'Big'
        ? {
            template: big,
            identity: 'big',
            childTemplate: (row) => ({ template: GRAND, identity: row, childTemplate: () => undefined }),
          }
        : loaderOf(TREE)(id);
    const answers: Record<string, unknown> = {
      [JSON.stringify({ Ref: 'Bucket' })]: 'b',
      [JSON.stringify({ Ref: 'Bucket2' })]: 'b2',
      [key('X', 'Big')]: 'x',
      [key('Name')]: 'n',
    };
    const delayed = (bucket: number, bucket2: number): MaskedInputSources => ({
      ...sources({ template, loader }),
      resolve: (node: unknown) => {
        const k = JSON.stringify(node);
        const delay =
          k === JSON.stringify({ Ref: 'Bucket' }) ? bucket : k === JSON.stringify({ Ref: 'Bucket2' }) ? bucket2 : 0;
        return new Promise((resolve, reject) =>
          setTimeout(
            () =>
              Object.hasOwn(answers, k) ? resolve({ value: answers[k] }) : reject(new Error('no')),
            delay
          )
        );
      },
    });
    const value = script({ 'Fn::Join': ['-', [getAtt('X', 'Big'), getAtt('Name')]] });
    // The two reads as an array (`Fn::Join`) and as a plain map's members.
    for (const shape of [value, { A: getAtt('X', 'Big'), B: getAtt('Name') }]) {
      const slowA = await maskedInputFingerprint(shape, delayed(0, 20));
      const slowB = await maskedInputFingerprint(shape, delayed(20, 0));
      expect(slowA).toMatch(/^inputs-sha256:/);
      expect(slowB).toBe(slowA);
    }
    // Control: B is the one cut off (kept as written), A is resolved.
    const both = sources({ template, loader, resolved: answers });
    await maskedInputFingerprint(value, both);
    expect(both.resolve).toHaveBeenCalledWith(getAtt('X', 'Big'));
    expect(both.resolve).not.toHaveBeenCalledWith(getAtt('Name'));
  });

  it('is deterministic: never resolves anything in the child, whatever the resolver answers', async () => {
    const answering = sources({ resolved: { [key('Name')]: 'child-ran' } });
    const silent = sources();
    expect(await nestedStackOutputClass('Child', 'Outputs.Name', answering)).toBe('clean');
    expect(await nestedStackOutputClass('Child', 'Outputs.Name', silent)).toBe('clean');
    // Only the PARENT row's passed values were resolved (`{Ref: Bucket}`,
    // `{Ref: Unresolvable}`), never a child node or the output itself.
    for (const s of [answering, silent]) {
      for (const [node] of s.resolve.mock.calls) {
        expect([JSON.stringify({ Ref: 'Bucket' }), JSON.stringify({ Ref: 'Unresolvable' })]).toContain(
          JSON.stringify(node)
        );
      }
    }
  });
});

describe('maskedInputFingerprint over a nested-stack output (go-to-k/cdkd#4565)', () => {
  it('a clean output is resolved from the parent and moves the hash when its value moves', async () => {
    const one = sources({ resolved: { [key('Name')]: 'target-one' } });
    const two = sources({ resolved: { [key('Name')]: 'target-two' } });
    const a = await maskedInputFingerprint(script(getAtt('Name')), one);
    const b = await maskedInputFingerprint(script(getAtt('Name')), two);
    expect(a).toMatch(/^inputs-sha256:/);
    expect(b).toMatch(/^inputs-sha256:/);
    expect(a).not.toBe(b);
    expect(one.resolve).toHaveBeenCalledWith(getAtt('Name'));
    // The same value again: the same hash (no churn).
    expect(await maskedInputFingerprint(script(getAtt('Name')), sources({ resolved: { [key('Name')]: 'target-one' } }))).toBe(a);
  });

  it('the string form of Fn::GetAtt reads it the same way', async () => {
    const value = script({ 'Fn::GetAtt': 'Child.Outputs.Name' });
    const one = sources({ resolved: { [JSON.stringify({ 'Fn::GetAtt': 'Child.Outputs.Name' })]: 'one' } });
    const a = await maskedInputFingerprint(value, one);
    const b = await maskedInputFingerprint(
      value,
      sources({ resolved: { [JSON.stringify({ 'Fn::GetAtt': 'Child.Outputs.Name' })]: 'two' } })
    );
    expect(a).toMatch(/^inputs-sha256:/);
    expect(a).not.toBe(b);
    expect(one.resolve).toHaveBeenCalledWith({ 'Fn::GetAtt': 'Child.Outputs.Name' });
  });

  it('a parent condition over a parameter not read this time still makes the value unknown, whatever its verdict', async () => {
    const template: CloudFormationTemplate = {
      Parameters: { Unbound: { Type: 'String' } },
      Conditions: { C: { 'Fn::Equals': [{ Ref: 'Unbound' }, 'x'] } },
      Resources: {},
    };
    expect(
      await maskedInputFingerprint(script({ 'Fn::If': ['C', 'a', 'b'] }), {
        template,
        parameterInput: parameterInputsFor({ template, values: {} }).parameterInput,
        conditions: { C: true },
        resolve: () => Promise.reject(new Error('none')),
      })
    ).toBeUndefined();
  });

  it('a same-stack masked property reading a resource built from a secret map keeps it as written', async () => {
    const template: CloudFormationTemplate = {
      ...PARENT,
      Mappings: { Secrets: { a: { plain: 'p', hidden: '{{resolve:secretsmanager:s}}' } } },
      Resources: {
        ...PARENT.Resources,
        MapReader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'm', Value: { 'Fn::FindInMap': ['Secrets', 'a', 'plain'] } },
        },
      },
    };
    const node = { 'Fn::GetAtt': ['MapReader', 'Value'] };
    const s = sources({ template, resolved: { [JSON.stringify(node)]: 'p' } });
    expect(await maskedInputFingerprint(script(node), s)).toMatch(/^inputs-sha256:/);
    expect(s.resolve).not.toHaveBeenCalledWith(node);
  });

  it('one template reached through two rows is classified per passed classes, never by the first read alone', async () => {
    // The same NestedStack class twice: A passes a literal, B a NoEcho value.
    const shared: CloudFormationTemplate = {
      Parameters: { X: { Type: 'String' } },
      Resources: {},
      Outputs: { O: { Value: { Ref: 'X' } } },
    };
    const template: CloudFormationTemplate = {
      ...PARENT,
      Resources: {
        A: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u', Parameters: { X: 'lit' } } },
        B: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { X: { Ref: 'Hidden' } } },
        },
      },
    };
    const s = sources({
      template,
      loader: () => ({ template: shared, identity: 'same', childTemplate: () => undefined }),
      resolved: { [key('O', 'A')]: 'a', [key('O', 'B')]: 'b' },
    });
    await maskedInputFingerprint(script({ 'Fn::Join': ['', [getAtt('O', 'A'), getAtt('O', 'B')]] }), s);
    expect(s.resolve).toHaveBeenCalledWith(getAtt('O', 'A'));
    expect(s.resolve).not.toHaveBeenCalledWith(getAtt('O', 'B'));
  });

  it("a child row is classified per the template it sits in, never by another template's row of the same name", async () => {
    // Two child templates, each with a `Grand` row passing `{Ref: P}`: A's
    // `P` is clean, B's is a NoEcho value.
    const child = (): CloudFormationTemplate => ({
      Parameters: { P: { Type: 'String' } },
      Resources: {
        Grand: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { G: { Ref: 'P' } } },
        },
      },
      Outputs: { X: { Value: getAtt('FromG', 'Grand') } },
    });
    const template: CloudFormationTemplate = {
      ...PARENT,
      Resources: {
        A: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u', Parameters: { P: 'lit' } } },
        B: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { P: { Ref: 'Hidden' } } },
        },
      },
    };
    const grand = { template: GRAND, identity: 'grand', childTemplate: () => undefined };
    const s = sources({
      template,
      loader: (id) => ({ template: child(), identity: `child-${id}`, childTemplate: () => grand }),
      resolved: { [key('X', 'A')]: 'a', [key('X', 'B')]: 'b' },
    });
    await maskedInputFingerprint(script({ 'Fn::Join': ['', [getAtt('X', 'A'), getAtt('X', 'B')]] }), s);
    expect(s.resolve).toHaveBeenCalledWith(getAtt('X', 'A'));
    expect(s.resolve).not.toHaveBeenCalledWith(getAtt('X', 'B'));
  });

  it('an Fn::Sub placeholder reads it the same way', async () => {
    const value = script({ 'Fn::Sub': 'x-${Child.Outputs.Name}' });
    const a = await maskedInputFingerprint(value, sources({ resolved: { [key('Name')]: 'one' } }));
    const b = await maskedInputFingerprint(value, sources({ resolved: { [key('Name')]: 'two' } }));
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('a non-clean output is kept as written and never resolved: its value never moves the hash', async () => {
    for (const output of ['FromSecret', 'FromNoEcho', 'CustomAttr', 'Imported', 'NotAnOutput']) {
      const one = sources({ resolved: { [key(output)]: 'value-one' } });
      const two = sources({ resolved: { [key(output)]: 'value-two' } });
      const a = await maskedInputFingerprint(script(getAtt(output)), one);
      expect(a, output).toBeDefined();
      expect(await maskedInputFingerprint(script(getAtt(output)), two), output).toBe(a);
      expect(one.resolve, output).not.toHaveBeenCalledWith(getAtt(output));
    }
  });

  it('an output the parent could not classify this time is neither compared nor hashed', async () => {
    expect(
      await maskedInputFingerprint(
        script(getAtt('FromUnread')),
        sources({ resolved: { [key('FromUnread')]: 'v' } })
      )
    ).toBeUndefined();
  });

  it("a clean output still takes the value checks: the mask, a reference, a value whose read recorded a secret", async () => {
    const asWritten = await maskedInputFingerprint(script(getAtt('Name')), sources({ loader: undefined }));
    for (const f of [
      { resolved: { [key('Name')]: '***' } },
      { resolved: { [key('Name')]: 'x-{{resolve:secretsmanager:s}}' } },
      { resolved: { [key('Name')]: 'carries-pw' }, recorded: { [key('Name')]: 'carries-pw' } },
    ]) {
      expect(await maskedInputFingerprint(script(getAtt('Name')), sources(f))).toBe(asWritten);
    }
  });

  it('an absent output (its read throws) is neither compared nor hashed', async () => {
    expect(await maskedInputFingerprint(script(getAtt('CondClean')), sources())).toBeUndefined();
  });

  it('Fn::ImportValue readers in the parent are unchanged by the loader', async () => {
    const value = script({ 'Fn::ImportValue': 'shared-export' });
    const resolved = { [JSON.stringify({ 'Fn::ImportValue': 'shared-export' })]: 'exported' };
    expect(await maskedInputFingerprint(value, sources({ resolved }))).toBe(
      await maskedInputFingerprint(value, sources({ resolved, loader: undefined }))
    );
  });

  it('a resource whose definition reads a nested output stays opaque (only the direct read is classified)', async () => {
    const template: CloudFormationTemplate = {
      ...PARENT,
      Resources: {
        ...PARENT.Resources,
        // The row passes only a literal, so nothing but the nested stack's
        // opacity can taint a resource that reads its output.
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'u', Parameters: { A: 'lit' } },
        },
        Reader: { Type: 'AWS::SNS::Topic', Properties: { TopicName: getAtt('Name') } },
      },
    };
    const s = sources({ template, resolved: { [JSON.stringify({ Ref: 'Reader' })]: 'topic' } });
    await maskedInputFingerprint(script({ Ref: 'Reader' }), s);
    expect(s.resolve).not.toHaveBeenCalledWith({ Ref: 'Reader' });
  });

  it('flips once when the child template makes an output clean, then settles', async () => {
    const edited: CloudFormationTemplate = {
      ...CHILD,
      Outputs: { ...CHILD.Outputs, FromSecret: { Value: { Ref: 'Target' } } },
    };
    const resolved = { [key('FromSecret')]: 'target-name' };
    const before = await maskedInputFingerprint(script(getAtt('FromSecret')), sources({ resolved }));
    const tree = loaderOf({ Child: { template: edited } });
    const after = await maskedInputFingerprint(
      script(getAtt('FromSecret')),
      sources({ resolved, loader: tree })
    );
    expect(after).not.toBe(before);
    expect(
      await maskedInputFingerprint(script(getAtt('FromSecret')), sources({ resolved, loader: tree }))
    ).toBe(after);
  });

  it('labels only: the classification hashes no value of the child, and a parent passing a sibling output classifies it', async () => {
    const classes = await classifyPassedParameters(
      { FromChild: getAtt('Name'), FromSecret: getAtt('FromSecret'), Opaque: { 'Fn::GetAtt': ['Cr', 'Out'] } },
      sources({ resolved: { [key('Name')]: 'target-one' } })
    );
    expect(Object.fromEntries(classes)).toEqual({
      FromChild: 'clean',
      FromSecret: 'secret',
      Opaque: 'secret',
    });
    // Without the tree, a sibling's output is kept as written as before.
    expect(
      Object.fromEntries(
        await classifyPassedParameters({ FromChild: getAtt('Name') }, sources({ loader: undefined }))
      )
    ).toEqual({ FromChild: 'secret' });
  });
});

describe('childTemplateLoader: the assembly reader both sides share (go-to-k/cdkd#4565)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads a child and its grandchildren from the asset paths, once each, and fails closed', () => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-4565-'));
    const grand = { Outputs: { Y: { Value: 'g' } } };
    const child = {
      Resources: {
        Grand: {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': 'grand.json' },
        },
        Escaping: {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': '../outside.json' },
        },
        Absolute: {
          Type: 'AWS::CloudFormation::Stack',
          Metadata: { 'aws:asset:path': '/etc/hosts' },
        },
      },
    };
    // The child sits one directory down; the escaping row names a file that
    // exists, so only the containment check keeps it out.
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'child.json'), JSON.stringify(child));
    writeFileSync(join(dir, 'sub', 'grand.json'), JSON.stringify(grand));
    writeFileSync(join(dir, 'outside.json'), JSON.stringify(grand));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'array.json'), '[]');
    // `path.join` keeps an absolute row INSIDE the directory: the file exists
    // there, so only the absolute-path refusal keeps it out.
    mkdirSync(join(dir, 'sub', 'etc'));
    writeFileSync(join(dir, 'sub', 'etc', 'hosts'), JSON.stringify(grand));
    const loader = childTemplateLoader({
      Child: join(dir, 'sub', 'child.json'),
      Broken: join(dir, 'broken.json'),
      Array: join(dir, 'array.json'),
      Missing: join(dir, 'missing.json'),
    })!;
    const loaded = loader('Child')!;
    expect(loaded.template).toEqual(child);
    expect(loader('Child')).toBe(loaded);
    expect(loaded.childTemplate('Grand')!.template).toEqual(grand);
    expect(loaded.childTemplate('Escaping')).toBeUndefined();
    expect(loaded.childTemplate('Absolute')).toBeUndefined();
    expect(loader('Broken')).toBeUndefined();
    expect(loader('Array')).toBeUndefined();
    expect(loader('Missing')).toBeUndefined();
    expect(loader('toString')).toBeUndefined();
    expect(loader('__proto__')).toBeUndefined();
    expect(childTemplateLoader(undefined)).toBeUndefined();
  });
});
