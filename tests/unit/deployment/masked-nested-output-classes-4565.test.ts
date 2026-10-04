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
  Parameters: {
    PassedClean: { Type: 'String' },
    PassedSecret: { Type: 'String' },
    PassedUnread: { Type: 'String' },
    PassedNoEcho: { Type: 'String', NoEcho: true },
    Defaulted: { Type: 'String', Default: 'dflt' },
    DefaultRef: { Type: 'String', Default: '{{resolve:ssm-secure:/d}}' },
    NoDefault: { Type: 'String' },
    HiddenDefault: { Type: 'String', NoEcho: true, Default: 'x' },
  },
  Conditions: {
    CleanCond: { 'Fn::Equals': [{ Ref: 'Defaulted' }, 'dflt'] },
    SecretCond: { 'Fn::Equals': [{ Ref: 'PassedNoEcho' }, 'x'] },
    UnreadCond: { 'Fn::Equals': [{ Ref: 'PassedUnread' }, 'x'] },
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
    ReadsUnread: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: { Ref: 'PassedUnread' }, Value: 'v' },
    },
    Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn' } },
    Grand: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } },
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
    MalformedGetAtt: { Value: { 'Fn::GetAtt': 5 } },
    GetAttUndeclared: { Value: { 'Fn::GetAtt': ['Nope', 'Arn'] } },
    RefNonString: { Value: { Ref: ['Target'] } },
    SubNonString: { Value: { 'Fn::Sub': [{ Ref: 'Target' }] } },
    SubVarSecret: { Value: { 'Fn::Sub': ['${V}', { V: { Ref: 'PassedNoEcho' } }] } },
    SubVarClean: { Value: { 'Fn::Sub': ['${V}-${Target.Arn}', { V: { Ref: 'Defaulted' } }] } },
    SubReference: { Value: { 'Fn::Sub': 'x-{{resolve:ssm-secure:/x}}' } },
    IfMalformed: { Value: { 'Fn::If': 'CleanCond' } },
    CondMalformed: { Condition: 5, Value: 'x' },
    NoValue: { Description: 'no value' },
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
    for (const output of ['Arn', 'Name', 'Literal', 'Pseudo', 'FromReadsClean', 'SubVarClean']) {
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

    // A child whose rows each pass the next row's output twice: 2^16 paths.
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
    const parentRows: CloudFormationTemplate = { Resources: {} };
    for (let i = 0; i < depth; i++) {
      parentRows.Resources[i === 0 ? 'Child' : `S${i}`] = {
        Type: 'AWS::CloudFormation::Stack',
        Properties: {
          TemplateURL: 'u',
          Parameters:
            i === depth - 1 ? {} : { G: getAtt('FromG', `S${i + 1}`), H: getAtt('FromG', `S${i + 1}`) },
        },
      };
    }
    const leafTemplate = { ...GRAND, Parameters: { G: { Type: 'String', Default: 'd' }, H: { Type: 'String' } } };
    // The same fan-out in the PARENT's rows: the budget stops it (2^16 rows
    // would be followed without it), and the output is kept as written.
    const parentLoads = vi.fn(() => ({
      template: leafTemplate,
      identity: 'leaf',
      childTemplate: () => undefined,
    }));
    expect(
      await classOf('FromG', {
        template: parentRows,
        loader: parentLoads,
        resolved: { [key('FromG', `S${depth - 1}`)]: 'd' },
      })
    ).toBe('unknown');
    expect(parentLoads.mock.calls.length).toBeLessThan(20_000);
    const leaf = { template: { ...GRAND, Parameters: { G: { Type: 'String', Default: 'd' } } }, identity: 'leaf', childTemplate: () => undefined };
    expect(
      await classOf('X', {
        loader: () => ({ template: wide, identity: 'wide', childTemplate: () => leaf }),
      })
    ).toBe('unknown');
    // The same tree, one level shallow enough to finish inside the budget.
    const narrow: CloudFormationTemplate = {
      Resources: { R0: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'u' } } },
      Outputs: { X: { Value: getAtt('FromG', 'R0') } },
    };
    expect(
      await classOf('X', {
        loader: () => ({ template: narrow, identity: 'narrow', childTemplate: () => leaf }),
      })
    ).toBe('clean');
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
