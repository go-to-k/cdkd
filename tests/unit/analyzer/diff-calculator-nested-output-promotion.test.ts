import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * A resource reading a nested stack's `Outputs.<Key>` is promoted when the
 * nested stack updates in place (issue
 * [#3631](https://github.com/go-to-k/cdkd/issues/3631)).
 *
 * The parent's diff runs BEFORE the child deploys, so the reader's
 * `Fn::GetAtt [Child, 'Outputs.<Key>']` resolves against the PERSISTED `Child`
 * row — the previous value — and compares equal: NO_CHANGE, and the reader is
 * never re-provisioned. The `Child` row's own UPDATE changes only
 * `TemplateURL` / `Parameters`, so neither the changed-property-name arm nor
 * the #985 derived-attribute list could see it.
 *
 * The create-only lookup is mocked to FAIL, as in `diff-calculator.test.ts`
 * (issue #2081): every assertion here is about the registry-only
 * classification, the fallback a failed `DescribeType` takes.
 */
const mockCloudFormationSend = vi.fn(() =>
  Promise.reject(
    Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403, requestId: 'test-request-id' },
    })
  )
);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const baseState = (): StackState => ({
  version: 1,
  stackName: 'TestStack',
  resources: {},
  outputs: {},
  lastModified: 0,
});

/**
 * Resolves against the PERSISTED state, which is what the deploy's diff
 * context does: `Ref` -> physical id, `Fn::GetAtt` (both spellings, the string
 * one split on its FIRST dot like the real resolver) -> the recorded attribute.
 * An unresolvable reference throws, so the diff keeps the raw intrinsic.
 */
const makeResolver =
  (state: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const getAtt = (id: string, attr: string): unknown => {
      const attrValue = state.resources[id]?.attributes?.[attr];
      if (attrValue === undefined) throw new Error(`GetAtt ${id}.${attr} not found`);
      return attrValue;
    };
    const resolve = async (v: unknown): Promise<unknown> => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return Promise.all(v.map((item) => resolve(item)));
      const obj = v as Record<string, unknown>;
      if ('Ref' in obj && Object.keys(obj).length === 1) {
        const res = state.resources[obj['Ref'] as string];
        if (!res) throw new Error(`Ref ${String(obj['Ref'])} not found`);
        return res.physicalId;
      }
      if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
        const ga = obj['Fn::GetAtt'];
        if (typeof ga === 'string') {
          const dot = ga.indexOf('.');
          return getAtt(ga.slice(0, dot), ga.slice(dot + 1));
        }
        const [id, attr] = ga as [string, string];
        return getAtt(id, attr);
      }
      if ('Fn::Sub' in obj && Object.keys(obj).length === 1) {
        const [body] = obj['Fn::Sub'] as [string, Record<string, unknown>];
        return body.replace(/\$\{([^}.]+)\.([^}]+)\}/g, (_m, id: string, attr: string) =>
          String(getAtt(id, attr))
        );
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = await resolve(val);
      return out;
    };
    return resolve(value);
  };

const CHILD_V1_URL = 'https://s3.us-east-1.amazonaws.com/assets/child-v1.json';
const CHILD_V2_URL = 'https://s3.us-east-1.amazonaws.com/assets/child-v2.json';

/** A `Child` nested-stack row whose PERSISTED outputs are the previous deploy's. */
function stateWithChild(): StackState {
  const state = baseState();
  state.resources['Child'] = {
    physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/Child',
    resourceType: 'AWS::CloudFormation::Stack',
    properties: { TemplateURL: CHILD_V1_URL },
    attributes: { 'Outputs.PlainValue': 'plain-v1', 'Outputs.ParamName': '/app/name' },
  };
  return state;
}

/** An SSM parameter row as the engine persists it: RESOLVED values. */
function readerRow(value: string): StackState['resources'][string] {
  return {
    physicalId: '/app/reader',
    resourceType: 'AWS::SSM::Parameter',
    properties: { Name: '/app/reader', Type: 'String', Value: value },
    attributes: {},
  };
}

function childResource(url: string): CloudFormationTemplate['Resources'][string] {
  return { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: url } };
}

function readerResource(value: unknown): CloudFormationTemplate['Resources'][string] {
  return {
    Type: 'AWS::SSM::Parameter',
    Properties: { Name: '/app/reader', Type: 'String', Value: value },
  };
}

describe('DiffCalculator - readers of a nested stack output (issue #3631)', () => {
  it('promotes a NO_CHANGE reader of Fn::GetAtt [Child, Outputs.<Key>] when the nested stack updates in place', async () => {
    const state = stateWithChild();
    state.resources['Reader'] = readerRow('plain-v1');
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Reader: readerResource({ 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    // The upstream is an IN-PLACE update: the arm under test, not #807's.
    const child = changes.get('Child');
    expect(child?.changeType).toBe('UPDATE');
    expect(child?.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);

    const reader = changes.get('Reader');
    expect(reader?.changeType).toBe('UPDATE');
    // Exactly the referencing property, as an in-place change: `Value` is
    // updatable on an SSM parameter.
    expect(reader?.propertyChanges).toEqual([
      {
        path: 'Value',
        oldValue: 'plain-v1',
        newValue: { 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] },
        requiresReplacement: false,
      },
    ]);
  });

  it('promotes a reader spelling the output as Fn::Sub ${Child.Outputs.<Key>}', async () => {
    const state = stateWithChild();
    state.resources['Reader'] = readerRow('value=plain-v1');
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Reader: readerResource({ 'Fn::Sub': ['value=${Child.Outputs.PlainValue}', {}] }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.propertyChanges?.map((pc) => pc.path)).toEqual(['Value']);
  });

  it('promotes a reader spelling Fn::GetAtt as the STRING form "Child.Outputs.<Key>"', async () => {
    // The resolver accepts `!GetAtt Child.Outputs.Foo` (split on the FIRST
    // dot), so it resolves to the stale value and compares equal exactly like
    // the array spelling; the reference extraction must see it too.
    const state = stateWithChild();
    state.resources['Reader'] = readerRow('plain-v1');
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Reader: readerResource({ 'Fn::GetAtt': 'Child.Outputs.PlainValue' }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.propertyChanges?.map((pc) => pc.path)).toEqual(['Value']);
  });

  it('does not promote a reader of an output whose PERSISTED value is the redaction mask', async () => {
    // A `NoEcho` custom resource's value persists as `***` (issue #2274).
    // Promoted, the reader's UPDATE would read that mask whenever the child did
    // not re-mint the value in this run, and the deploy would refuse it as a
    // redacted read. The unmasked sibling in the same stack is still promoted,
    // which is what shows the exclusion is per attribute.
    const state = stateWithChild();
    state.resources['Child']!.attributes = {
      ...state.resources['Child']!.attributes,
      'Outputs.Secret': '***',
      'Outputs.SecretList': ['a', '***'],
    };
    state.resources['Reader'] = readerRow('plain-v1');
    state.resources['SecretReader'] = { ...readerRow('***'), physicalId: '/app/secret' };
    state.resources['SecretListReader'] = { ...readerRow('a,***'), physicalId: '/app/list' };
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Reader: readerResource({ 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] }),
        SecretReader: readerResource({ 'Fn::GetAtt': ['Child', 'Outputs.Secret'] }),
        SecretListReader: readerResource({
          'Fn::Join': [',', { 'Fn::GetAtt': ['Child', 'Outputs.SecretList'] }],
        }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, async (v) => {
      // The Join is not modelled by this file's resolver; answer it directly
      // with what the persisted list joins to, so it compares equal.
      const obj = v as Record<string, unknown> | null;
      if (obj && typeof obj === 'object' && 'Fn::Join' in obj) return 'a,***';
      return makeResolver(state)(v);
    });

    expect(changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(changes.get('SecretReader')?.changeType).toBe('NO_CHANGE');
    expect(changes.get('SecretListReader')?.changeType).toBe('NO_CHANGE');
  });

  it('does not promote a reader whose OTHER reads include a masked attribute, from any upstream', async () => {
    // The exclusion is per DEPENDENT: the engine resolves every property, so a
    // masked read anywhere — another output of the same child, or a `NoEcho`
    // custom resource in this stack — is refused however the reader was
    // promoted. `Plain` reads the same unmasked output and still is promoted.
    const state = stateWithChild();
    state.resources['Child']!.attributes = {
      ...state.resources['Child']!.attributes,
      'Outputs.Secret': '***',
    };
    state.resources['Cr'] = {
      physicalId: 'cr-1',
      resourceType: 'Custom::Thing',
      properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
      attributes: { Token: '***' },
    };
    state.resources['Plain'] = readerRow('plain-v1');
    state.resources['SameChild'] = {
      ...readerRow('plain-v1'),
      physicalId: '/app/same-child',
      properties: { Name: '/app/reader', Type: 'String', Value: 'plain-v1', Description: '***' },
    };
    state.resources['OtherUpstream'] = {
      ...readerRow('plain-v1'),
      physicalId: '/app/other-upstream',
      properties: { Name: '/app/reader', Type: 'String', Value: 'plain-v1', Description: '***' },
    };
    const plainRead = { 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] };
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Cr: {
          Type: 'Custom::Thing',
          Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
        },
        Plain: readerResource(plainRead),
        SameChild: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            Value: plainRead,
            Description: { 'Fn::GetAtt': ['Child', 'Outputs.Secret'] },
          },
        },
        OtherUpstream: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            Value: plainRead,
            Description: { 'Fn::Sub': ['${Cr.Token}', {}] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Plain')?.changeType).toBe('UPDATE');
    expect(changes.get('SameChild')?.changeType).toBe('NO_CHANGE');
    expect(changes.get('OtherUpstream')?.changeType).toBe('NO_CHANGE');
  });

  it('finds a masked attribute persisted as a NESTED object, the way the resolver does', async () => {
    // A Cloud Control record keeps `Endpoint.Password` as `{Endpoint: {Password}}`,
    // and the resolver walks the dotted path when the flat key misses. The
    // unmasked `Endpoint.Address` beside it keeps its reader promotable.
    const state = stateWithChild();
    state.resources['Db'] = {
      physicalId: 'db-1',
      resourceType: 'AWS::RDS::DBCluster',
      properties: {},
      attributes: { Endpoint: { Address: 'db.example', Password: '***' } },
    };
    state.resources['Masked'] = {
      ...readerRow('plain-v1'),
      physicalId: '/app/masked',
      properties: { Name: '/app/reader', Type: 'String', Value: 'plain-v1', Description: '***' },
    };
    state.resources['Unmasked'] = {
      ...readerRow('plain-v1'),
      physicalId: '/app/unmasked',
      properties: {
        Name: '/app/reader',
        Type: 'String',
        Value: 'plain-v1',
        Description: 'db.example',
      },
    };
    const plainRead = { 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] };
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Db: { Type: 'AWS::RDS::DBCluster', Properties: {} },
        Masked: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            Value: plainRead,
            Description: { 'Fn::GetAtt': ['Db', 'Endpoint.Password'] },
          },
        },
        Unmasked: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            Value: plainRead,
            Description: { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] },
          },
        },
      },
    };
    // This file's resolver reads flat keys only; answer the nested reads with
    // what the real one returns, so both readers compare equal before promotion.
    const resolver = makeResolver(state);
    const changes = await new DiffCalculator().calculateDiff(state, template, async (v) => {
      const ga = (v as Record<string, unknown> | null)?.['Fn::GetAtt'];
      if (Array.isArray(ga) && ga[0] === 'Db') {
        return ga[1] === 'Endpoint.Password' ? '***' : 'db.example';
      }
      return resolver(v);
    });

    expect(changes.get('Unmasked')?.changeType).toBe('UPDATE');
    expect(changes.get('Masked')?.changeType).toBe('NO_CHANGE');
  });

  it('keeps the FIRST round of the changed-property arm as it was, a masked read included', async () => {
    // Arm 1 in round 1 matches a property that really changed, so its reader
    // is stale for certain: it is promoted as before this issue, and a masked
    // read in it is the engine's refusal to report, not a guess to withhold.
    const state = baseState();
    state.resources['Base'] = {
      physicalId: 'base',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: 'base', Type: 'String', Value: 'world' },
      attributes: { Value: 'world' },
    };
    state.resources['Cr'] = {
      physicalId: 'cr-1',
      resourceType: 'Custom::Thing',
      properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
      attributes: { Token: '***' },
    };
    state.resources['Reader'] = {
      ...readerRow('world'),
      properties: { Name: '/app/reader', Type: 'String', Value: 'world', Description: '***' },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Base: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'base', Type: 'String', Value: 'world2' },
        },
        Cr: {
          Type: 'Custom::Thing',
          Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
        },
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            // The STRING spelling, through arm 1 rather than arm 3.
            Value: { 'Fn::GetAtt': 'Base.Value' },
            Description: { 'Fn::GetAtt': ['Cr', 'Token'] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.propertyChanges?.map((pc) => pc.path)).toEqual(['Value']);
  });

  it('withholds a LATER-round promotion of the changed-property arm from a dependent with a masked read', async () => {
    // Round 1 promotes Middle (it reads the nested output, a guess); round 2
    // would promote Reader through arm 1, because Middle's `Value` now carries
    // a synthetic change — a guess built on a guess. Reader also reads a
    // `NoEcho` custom resource's masked attribute, so it is withheld; Twin,
    // the same read without the mask, is still promoted.
    const state = stateWithChild();
    state.resources['Cr'] = {
      physicalId: 'cr-1',
      resourceType: 'Custom::Thing',
      properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
      attributes: { Token: '***' },
    };
    state.resources['Middle'] = {
      physicalId: '/app/middle',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: '/app/middle', Type: 'String', Value: 'plain-v1' },
      attributes: { Value: 'plain-v1' },
    };
    state.resources['Twin'] = { ...readerRow('plain-v1'), physicalId: '/app/twin' };
    state.resources['Reader'] = {
      ...readerRow('plain-v1'),
      properties: { Name: '/app/reader', Type: 'String', Value: 'plain-v1', Description: '***' },
    };
    const middleRead = { 'Fn::GetAtt': ['Middle', 'Value'] };
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Cr: {
          Type: 'Custom::Thing',
          Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
        },
        Middle: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/middle',
            Type: 'String',
            Value: { 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] },
          },
        },
        Twin: readerResource(middleRead),
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: '/app/reader',
            Type: 'String',
            Value: middleRead,
            Description: { 'Fn::GetAtt': ['Cr', 'Token'] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Middle')?.changeType).toBe('UPDATE');
    expect(changes.get('Twin')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });

  it('leaves the reader NO_CHANGE when the nested stack itself is NO_CHANGE', async () => {
    const state = stateWithChild();
    state.resources['Reader'] = readerRow('plain-v1');
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V1_URL),
        Reader: readerResource({ 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Child')?.changeType).toBe('NO_CHANGE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });

  it('leaves a Ref-only reader of an updated nested stack NO_CHANGE (the physical id does not move)', async () => {
    const state = stateWithChild();
    const childArn = state.resources['Child']!.physicalId;
    state.resources['Reader'] = readerRow(childArn);
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Reader: readerResource({ Ref: 'Child' }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Child')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });

  it('does not treat an `Outputs.`-prefixed attribute of ANOTHER type as a nested output', async () => {
    // The prefix table is keyed by type: a custom resource whose Data happens
    // to carry an `Outputs.X` key is not a nested stack, and its in-place
    // update of `Seed` names no attribute the reader reads.
    const state = baseState();
    state.resources['Cr'] = {
      physicalId: 'cr-1',
      resourceType: 'Custom::Thing',
      properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h', Seed: 'a' },
      attributes: { 'Outputs.PlainValue': 'plain-v1' },
    };
    state.resources['Reader'] = readerRow('plain-v1');
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: {
          Type: 'Custom::Thing',
          Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h', Seed: 'b' },
        },
        Reader: readerResource({ 'Fn::GetAtt': ['Cr', 'Outputs.PlainValue'] }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Cr')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });

  it('promotes TRANSITIVELY: a sibling nested stack fed by the output, then a reader of THAT stack', async () => {
    // ChildA updates in place; ChildB's `Parameters` read ChildA's output, so
    // ChildB is promoted to an in-place UPDATE; Reader reads ChildB's output,
    // which only moves because ChildB redeploys. One pass promotes ChildB; the
    // reader needs the pass after it.
    const state = baseState();
    state.resources['ChildA'] = {
      physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/ChildA',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { TemplateURL: CHILD_V1_URL },
      attributes: { 'Outputs.Seed': 'seed-v1' },
    };
    state.resources['ChildB'] = {
      physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/TestStack/ChildB',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { TemplateURL: 'https://example/child-b.json', Parameters: { Seed: 'seed-v1' } },
      attributes: { 'Outputs.Derived': 'derived-v1' },
    };
    state.resources['Reader'] = readerRow('derived-v1');
    const template: CloudFormationTemplate = {
      Resources: {
        ChildA: childResource(CHILD_V2_URL),
        ChildB: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://example/child-b.json',
            Parameters: { Seed: { 'Fn::GetAtt': ['ChildA', 'Outputs.Seed'] } },
          },
        },
        Reader: readerResource({ 'Fn::GetAtt': ['ChildB', 'Outputs.Derived'] }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('ChildB')?.changeType).toBe('UPDATE');
    expect(changes.get('ChildB')?.propertyChanges?.map((pc) => pc.path)).toEqual(['Parameters']);
    expect(changes.get('Reader')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.propertyChanges?.map((pc) => pc.path)).toEqual(['Value']);
  });

  it('carries a promotion that turns into a REPLACEMENT on to the Ref readers of the replaced resource', async () => {
    // Reader's `Name` (create-only on an SSM parameter) reads the nested
    // output, so its promotion is a replacement; Consumer reads Reader by
    // `Ref`, i.e. its physical id, which the replacement moves. Only the
    // replacement pass promotes a `Ref` reader, and it ran before Reader was
    // promoted, so this needs the fixpoint.
    const state = stateWithChild();
    state.resources['Reader'] = {
      physicalId: '/app/name',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: '/app/name', Type: 'String', Value: 'x' },
      attributes: {},
    };
    state.resources['Consumer'] = {
      physicalId: '/app/consumer',
      resourceType: 'AWS::SSM::Parameter',
      properties: { Name: '/app/consumer', Type: 'String', Value: '/app/name' },
      attributes: {},
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Child: childResource(CHILD_V2_URL),
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Name: { 'Fn::GetAtt': ['Child', 'Outputs.ParamName'] },
            Type: 'String',
            Value: 'x',
          },
        },
        Consumer: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/consumer', Type: 'String', Value: { Ref: 'Reader' } },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    const reader = changes.get('Reader');
    expect(reader?.changeType).toBe('UPDATE');
    expect(reader?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Name', requiresReplacement: true }),
    ]);
    const consumer = changes.get('Consumer');
    expect(consumer?.changeType).toBe('UPDATE');
    expect(consumer?.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', replacementPropagated: true }),
    ]);
  });

  it('promotes a reader of a REPLACED nested stack once, through the replacement arm', async () => {
    // A replaced upstream is excluded from the in-place arms, so the reader's
    // `Value` must carry exactly one synthetic change, not one per arm.
    const spy = vi
      .spyOn(ReplacementRulesRegistry.prototype, 'requiresReplacement')
      .mockImplementation(
        (resourceType: string, propertyPath: string) =>
          resourceType === 'AWS::CloudFormation::Stack' && propertyPath === 'TemplateURL'
      );
    try {
      const state = stateWithChild();
      state.resources['Reader'] = readerRow('plain-v1');
      const template: CloudFormationTemplate = {
        Resources: {
          Child: childResource(CHILD_V2_URL),
          Reader: readerResource({ 'Fn::GetAtt': ['Child', 'Outputs.PlainValue'] }),
        },
      };

      const changes = await new DiffCalculator().calculateDiff(
        state,
        template,
        makeResolver(state)
      );

      expect(changes.get('Child')?.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(
        true
      );
      expect(changes.get('Reader')?.changeType).toBe('UPDATE');
      expect(changes.get('Reader')?.propertyChanges).toEqual([
        expect.objectContaining({ path: 'Value', replacementPropagated: true }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not crash on an upstream whose TYPE names an Object.prototype member', async () => {
    // Both derived-attribute tables are looked up by template text. A bare
    // lookup of `constructor` answers with `Object`'s own function, whose
    // missing `.has` / `.some` would throw inside the diff.
    const state = baseState();
    state.resources['Odd'] = {
      physicalId: 'odd-1',
      resourceType: 'constructor',
      properties: { Knob: 'a' },
      attributes: { Value: 'v1' },
    };
    state.resources['Reader'] = readerRow('v1');
    const template: CloudFormationTemplate = {
      Resources: {
        Odd: { Type: 'constructor', Properties: { Knob: 'b' } },
        Reader: readerResource({ 'Fn::GetAtt': ['Odd', 'Value'] }),
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    expect(changes.get('Odd')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });
});
