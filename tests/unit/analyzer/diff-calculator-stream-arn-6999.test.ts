import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6999: a DynamoDB stream view type change mints a new
 * `StreamArn`, and an event source mapping reading it must follow in the same
 * deploy. The diff resolves the mapping's `EventSourceArn` against the RECORDED
 * stream ARN, so without the `IN_PLACE_UPDATE_ATTRS_MOVED_BY` entry the mapping
 * stays NO_CHANGE and keeps reading the disabled stream.
 *
 * DescribeType answers the mapping's real create-only paths (and refuses every
 * other type, the registry-only fallback), so the synthetic change's
 * replacement ceiling is computed as in a live deploy; no AWS call is made.
 */
const mockCloudFormationSend = vi.fn((command: { input?: { TypeName?: string } }) => {
  if (command.input?.TypeName === 'AWS::Lambda::EventSourceMapping') {
    return Promise.resolve({
      Schema: JSON.stringify({
        createOnlyProperties: [
          '/properties/EventSourceArn',
          '/properties/StartingPosition',
          '/properties/StartingPositionTimestamp',
          '/properties/SelfManagedEventSource',
        ],
      }),
    });
  }
  return Promise.reject(
    Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403, requestId: 'test-request-id' },
    })
  );
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const OLD_STREAM = 'arn:aws:dynamodb:us-east-1:123456789012:table/T/stream/2026-11-25T19:17:54.859';

const resolverFor =
  (state: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const resolve = async (v: unknown): Promise<unknown> => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return Promise.all(v.map((item) => resolve(item)));
      const obj = v as Record<string, unknown>;
      if ('Ref' in obj && Object.keys(obj).length === 1) {
        return state.resources[obj['Ref'] as string]?.physicalId;
      }
      if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
        const [id, attr] = obj['Fn::GetAtt'] as [string, string];
        const attrValue = state.resources[id]?.attributes?.[attr];
        if (attrValue === undefined) throw new Error(`GetAtt ${id}.${attr} not found`);
        return attrValue;
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = await resolve(val);
      return out;
    };
    return resolve(value);
  };

function stateWith(tableType: string, tableProps: Record<string, unknown>): StackState {
  return {
    version: 1,
    stackName: 'TestStack',
    resources: {
      Table: {
        physicalId: 'T',
        resourceType: tableType,
        properties: tableProps,
        attributes: { Arn: 'arn:aws:dynamodb:us-east-1:123456789012:table/T', StreamArn: OLD_STREAM },
      },
      Esm: {
        physicalId: 'esm-uuid',
        resourceType: 'AWS::Lambda::EventSourceMapping',
        properties: {
          FunctionName: 'consumer',
          EventSourceArn: OLD_STREAM,
          StartingPosition: 'LATEST',
          BatchSize: 5,
        },
        attributes: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

function templateWith(tableType: string, tableProps: Record<string, unknown>): CloudFormationTemplate {
  return {
    Resources: {
      Table: { Type: tableType, Properties: tableProps },
      Esm: {
        Type: 'AWS::Lambda::EventSourceMapping',
        Properties: {
          FunctionName: 'consumer',
          EventSourceArn: { 'Fn::GetAtt': ['Table', 'StreamArn'] },
          StartingPosition: 'LATEST',
          BatchSize: 5,
        },
      },
    },
  };
}

const KEY = { KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] };

describe('a reader of a DynamoDB StreamArn follows a stream change (#6999)', () => {
  it.each(['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable'])(
    '%s: a StreamSpecification change promotes the event source mapping to a replacement of EventSourceArn',
    async (type) => {
      const before = { ...KEY, StreamSpecification: { StreamViewType: 'NEW_IMAGE' } };
      const after = { ...KEY, StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } };
      const state = stateWith(type, before);

      const changes = await new DiffCalculator().calculateDiff(
        state,
        templateWith(type, after),
        resolverFor(state)
      );

      expect(changes.get('Table')?.changeType).toBe('UPDATE');
      expect(changes.get('Esm')?.changeType).toBe('UPDATE');
      const pc = changes.get('Esm')?.propertyChanges?.find((c) => c.path === 'EventSourceArn');
      expect(pc?.inPlacePropagated).toBe(true);
      // EventSourceArn is create-only: the ceiling the engine lowers when the
      // resolved ARN turns out unchanged.
      expect(pc?.requiresReplacement).toBe(true);
    }
  );

  it('a table update that leaves StreamSpecification alone does not promote the mapping', async () => {
    const type = 'AWS::DynamoDB::Table';
    const stream = { StreamSpecification: { StreamViewType: 'NEW_IMAGE' } };
    const state = stateWith(type, { ...KEY, ...stream, BillingMode: 'PROVISIONED' });

    const changes = await new DiffCalculator().calculateDiff(
      state,
      templateWith(type, { ...KEY, ...stream, BillingMode: 'PAY_PER_REQUEST' }),
      resolverFor(state)
    );

    expect(changes.get('Table')?.changeType).toBe('UPDATE');
    expect(changes.get('Esm')?.changeType).toBe('NO_CHANGE');
  });
});
