import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * A promoted reader's create-only property on a type OUTSIDE the hand-written
 * `ReplacementRulesRegistry` gets the same CFn-schema createOnly fallback the
 * ordinary diff uses (go-to-k/cdkd#3803). Before, both synthetic sites asked
 * the registry alone, so such a property was classified in-place and a moved
 * value was sent to `update()`.
 *
 * `DescribeType` is mocked to FAIL, so the committed schema snapshot answers,
 * exactly as it does for the ordinary diff in the other analyzer suites.
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
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { PropertyChange, StackState } from '../../../src/types/state.js';

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


const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

function crState(): StackState {
  const state = baseState();
  state.resources['Cr'] = {
    physicalId: 'cr-1',
    resourceType: 'Custom::Thing',
    properties: { ServiceToken: TOKEN, Seed: 'a' },
    attributes: { Text: 'text-a' },
  };
  return state;
}

const cr = (seed: string): CloudFormationTemplate['Resources'][string] => ({
  Type: 'Custom::Thing',
  Properties: { ServiceToken: TOKEN, Seed: seed },
});

function changeOf(
  changes: Map<string, { propertyChanges?: PropertyChange[] }>,
  id: string,
  path: string
): PropertyChange | undefined {
  return changes.get(id)?.propertyChanges?.find((pc) => pc.path === path);
}

describe('DiffCalculator - a promoted reader outside the replacement registry (go-to-k/cdkd#3803)', () => {
  it('marks a create-only property of an in-place reader as a replacement ceiling', async () => {
    const state = crState();
    state.resources['Policy'] = {
      physicalId: 'arn:aws:iam::123456789012:policy/p',
      resourceType: 'AWS::IAM::ManagedPolicy',
      properties: { Description: 'text-a', PolicyDocument: { Statement: [] } },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: cr('b'),
        Policy: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: {
            Description: { 'Fn::GetAtt': ['Cr', 'Text'] },
            PolicyDocument: { Statement: [] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    const pc = changeOf(changes, 'Policy', 'Description');
    expect(pc?.inPlacePropagated).toBe(true);
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('leaves an updatable property of the same type in place (the control)', async () => {
    const state = crState();
    state.resources['Policy'] = {
      physicalId: 'arn:aws:iam::123456789012:policy/p',
      resourceType: 'AWS::IAM::ManagedPolicy',
      properties: { Description: 'fixed', PolicyDocument: { Statement: [{ Sid: 'text-a' }] } },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: cr('b'),
        Policy: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: {
            Description: 'fixed',
            PolicyDocument: { Statement: [{ Sid: { 'Fn::GetAtt': ['Cr', 'Text'] } }] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    const pc = changeOf(changes, 'Policy', 'PolicyDocument');
    expect(pc?.inPlacePropagated).toBe(true);
    expect(pc?.requiresReplacement).toBe(false);
  });

  it('marks a create-only property of a replacement-propagated reader too', async () => {
    // `Up` is replaced (its create-only QueueName changed), and the reader's
    // create-only `Description` reads it.
    const state = baseState();
    state.resources['Up'] = {
      physicalId: 'https://sqs/q-1',
      resourceType: 'AWS::SQS::Queue',
      properties: { QueueName: 'q-1' },
      attributes: { Arn: 'arn:aws:sqs:us-east-1:123456789012:q-1' },
    };
    state.resources['Policy'] = {
      physicalId: 'arn:aws:iam::123456789012:policy/p',
      resourceType: 'AWS::IAM::ManagedPolicy',
      properties: {
        Description: 'arn:aws:sqs:us-east-1:123456789012:q-1',
        PolicyDocument: { Statement: [] },
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Up: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q-2' } },
        Policy: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: {
            Description: { 'Fn::GetAtt': ['Up', 'Arn'] },
            PolicyDocument: { Statement: [] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    const pc = changeOf(changes, 'Policy', 'Description');
    expect(pc?.replacementPropagated).toBe(true);
    expect(pc?.requiresReplacement).toBe(true);
  });

  it('still defers to a registry-classified property (registry first)', async () => {
    // The registry lists `AWS::IAM::Role.Path` as updatable while the schema
    // lists it create-only: the fallback fills gaps and never overrides a
    // deliberate classification, as in the ordinary diff.
    const state = crState();
    state.resources['Role'] = {
      physicalId: 'role',
      resourceType: 'AWS::IAM::Role',
      properties: { Path: 'text-a', AssumeRolePolicyDocument: { Statement: [] } },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: cr('b'),
        Role: {
          Type: 'AWS::IAM::Role',
          Properties: {
            Path: { 'Fn::GetAtt': ['Cr', 'Text'] },
            AssumeRolePolicyDocument: { Statement: [] },
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(state, template, makeResolver(state));

    const pc = changeOf(changes, 'Role', 'Path');
    expect(pc?.inPlacePropagated).toBe(true);
    expect(pc?.requiresReplacement).toBe(false);
  });

  describe('a NESTED createOnly path (AWS::Glue::Connection ConnectionInput.Name)', () => {
    // The engine lowers a ceiling by comparing the WHOLE top-level value with
    // the record, so a nested ceiling would stand whenever a mutable sibling
    // moved: a needless replacement. A nested path therefore raises none.
    async function glueDiff(input: Record<string, unknown>, recorded: Record<string, unknown>) {
      const state = crState();
      state.resources['Conn'] = {
        physicalId: 'conn',
        resourceType: 'AWS::Glue::Connection',
        properties: { CatalogId: '123456789012', ConnectionInput: recorded },
      };
      const template: CloudFormationTemplate = {
        Resources: {
          Cr: cr('b'),
          Conn: {
            Type: 'AWS::Glue::Connection',
            Properties: { CatalogId: '123456789012', ConnectionInput: input },
          },
        },
      };
      const changes = await new DiffCalculator().calculateDiff(
        state,
        template,
        makeResolver(state)
      );
      return changeOf(changes, 'Conn', 'ConnectionInput');
    }

    it('raises no ceiling when a stable intrinsic sits under the create-only sub-path', async () => {
      const pc = await glueDiff(
        {
          Name: { 'Fn::Sub': ['conn-x', {}] },
          Description: { 'Fn::GetAtt': ['Cr', 'Text'] },
          ConnectionType: 'JDBC',
        },
        { Name: 'conn-x', Description: 'text-a', ConnectionType: 'JDBC' }
      );
      expect(pc?.inPlacePropagated).toBe(true);
      expect(pc?.requiresReplacement).toBe(false);
    });

    it('raises none either when the read itself sits under the sub-path (residual: in place)', async () => {
      const pc = await glueDiff(
        { Name: { 'Fn::GetAtt': ['Cr', 'Text'] }, ConnectionType: 'JDBC' },
        { Name: 'text-a', ConnectionType: 'JDBC' }
      );
      expect(pc?.inPlacePropagated).toBe(true);
      expect(pc?.requiresReplacement).toBe(false);
    });
  });

  describe('DescribeType is asked only for types a promotion can reach', () => {
    const typesAsked = (): string[] =>
      mockCloudFormationSend.mock.calls.map(
        (c) => ((c as unknown[])[0] as { input?: { TypeName?: string } }).input?.TypeName ?? '?'
      );

    function policyState(): StackState {
      const state = crState();
      state.resources['Policy'] = {
        physicalId: 'arn:aws:iam::123456789012:policy/p',
        resourceType: 'AWS::IAM::ManagedPolicy',
        properties: { Description: 'text-a', PolicyDocument: { Statement: [] } },
      };
      state.resources['Other'] = {
        physicalId: '/other',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/other', Type: 'String', Value: 'v1' },
      };
      return state;
    }
    const policy = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        Description: { 'Fn::GetAtt': ['Cr', 'Text'] },
        PolicyDocument: { Statement: [] },
      },
    };

    it('asks nothing on an unchanged stack', async () => {
      const state = policyState();
      mockCloudFormationSend.mockClear();

      await new DiffCalculator().calculateDiff(
        state,
        {
          Resources: {
            Cr: cr('a'),
            Policy: policy,
            Other: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Name: '/other', Type: 'String', Value: 'v1' },
            },
          },
        },
        makeResolver(state)
      );

      expect(typesAsked()).not.toContain('AWS::IAM::ManagedPolicy');
    });

    it('does not ask for a reader no changed resource reaches', async () => {
      const state = policyState();
      mockCloudFormationSend.mockClear();

      await new DiffCalculator().calculateDiff(
        state,
        {
          Resources: {
            Cr: cr('a'),
            Policy: policy,
            Other: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Name: '/other', Type: 'String', Value: 'v2' },
            },
          },
        },
        makeResolver(state)
      );

      expect(typesAsked()).not.toContain('AWS::IAM::ManagedPolicy');
    });

    it('asks for a reader TWO hops from the change, which the replacement cascade reaches', async () => {
      // Up is replaced; Mid's create-only TopicName reads it (a registry
      // replacement); Policy's Description reads Mid.
      const state = baseState();
      state.resources['Up'] = {
        physicalId: 'https://sqs/q-1',
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: 'q-1' },
        attributes: { QueueName: 'q-1' },
      };
      state.resources['Mid'] = {
        physicalId: 'arn:aws:sns:us-east-1:123456789012:q-1',
        resourceType: 'AWS::SNS::Topic',
        properties: { TopicName: 'q-1' },
      };
      state.resources['Policy'] = {
        physicalId: 'arn:aws:iam::123456789012:policy/p',
        resourceType: 'AWS::IAM::ManagedPolicy',
        properties: {
          Description: 'arn:aws:sns:us-east-1:123456789012:q-1',
          PolicyDocument: { Statement: [] },
        },
      };
      mockCloudFormationSend.mockClear();

      const changes = await new DiffCalculator().calculateDiff(
        state,
        {
          Resources: {
            Up: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q-2' } },
            Mid: {
              Type: 'AWS::SNS::Topic',
              Properties: { TopicName: { 'Fn::GetAtt': ['Up', 'QueueName'] } },
            },
            Policy: {
              Type: 'AWS::IAM::ManagedPolicy',
              Properties: { Description: { Ref: 'Mid' }, PolicyDocument: { Statement: [] } },
            },
          },
        },
        makeResolver(state)
      );

      expect(typesAsked()).toContain('AWS::IAM::ManagedPolicy');
      expect(changeOf(changes, 'Policy', 'Description')?.requiresReplacement).toBe(true);
    });

    it('asks for a reader the updated custom resource reaches', async () => {
      const state = policyState();
      mockCloudFormationSend.mockClear();

      await new DiffCalculator().calculateDiff(
        state,
        { Resources: { Cr: cr('b'), Policy: policy } },
        makeResolver(state)
      );

      expect(typesAsked()).toContain('AWS::IAM::ManagedPolicy');
    });
  });
});
