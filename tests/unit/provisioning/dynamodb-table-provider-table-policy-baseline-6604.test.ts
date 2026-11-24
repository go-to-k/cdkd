import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import {
  DescribeTableCommand,
  GetResourcePolicyCommand,
  PolicyNotFoundException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => childLogger),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const DOC = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::111111111111:root' },
      Action: 'dynamodb:GetItem',
      Resource: '*',
    },
  ],
};
const OTHER_DOC = { ...DOC, Statement: [{ ...DOC.Statement[0], Action: 'dynamodb:Query' }] };

function tableProps(policy?: unknown): Record<string, unknown> {
  return {
    TableName: TABLE_NAME,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    ...(policy === undefined ? {} : { ResourcePolicy: { PolicyDocument: policy } }),
  };
}

/**
 * A table whose `GetResourcePolicy` answers from `answers` in order (the last
 * one repeats): a document object, `'none'` (PolicyNotFoundException), or an
 * Error to throw. Every other read answers empty.
 */
function primeAws(answers: Array<Record<string, unknown> | 'none' | Error>): void {
  let i = 0;
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        },
      });
    }
    if (cmd instanceof GetResourcePolicyCommand) {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer === 'none') {
        return Promise.reject(
          new PolicyNotFoundException({ message: 'Resource-based policy not found', $metadata: {} })
        );
      }
      return Promise.resolve({ Policy: JSON.stringify(answer) });
    }
    return Promise.resolve({});
  });
}

const throttle = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
  });

const policyReads = (): number =>
  mockSend.mock.calls.filter(([cmd]) => cmd instanceof GetResourcePolicyCommand).length;

function bagOf(
  r: Record<string, unknown> | typeof RESOURCE_NOT_FOUND | undefined
): Record<string, unknown> {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  expect(r).toBeDefined();
  return r as Record<string, unknown>;
}

describe('DynamoDB Table ResourcePolicy baseline after its own write (go-to-k/cdkd#6604)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new DynamoDBTableProvider();
    (provider as unknown as { streamMemberRereadDelaysMs: number[] }).streamMemberRereadDelaysMs =
      [0, 0, 0];
  });

  const capture = async (desired: Record<string, unknown>) =>
    bagOf(
      await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, desired, {
        afterOwnWrite: true,
      })
    );

  it('re-asks a just-DELETED policy until the read stops serving it, so a removal records no policy', async () => {
    // Measured us-east-1: the deleted policy is still served for ~2 reads.
    primeAws([DOC, DOC, 'none']);
    const baseline = await capture(tableProps());
    expect(baseline['ResourcePolicy']).toBeUndefined();
    expect(policyReads()).toBe(3);
  });

  it('re-asks a just-PUT policy that still reads "not found", and records the settled document', async () => {
    primeAws(['none', 'none', DOC]);
    const baseline = await capture(tableProps(DOC));
    expect(baseline['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
    expect(policyReads()).toBe(3);
  });

  it('re-asks a just-REPLACED policy still serving the previous document', async () => {
    primeAws([OTHER_DOC, DOC]);
    const baseline = await capture(tableProps(DOC));
    expect(baseline['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
    expect(policyReads()).toBe(2);
  });

  it('keeps the DECLARED policy when every read in the schedule still finds none', async () => {
    primeAws(['none']);
    const baseline = await capture(tableProps(DOC));
    expect(baseline['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
    expect(policyReads()).toBe(4);
  });

  it('keeps the DECLARED policy when the replaced document is still served once the schedule is spent', async () => {
    // Recording OTHER_DOC would let --revert re-grant the replaced policy.
    primeAws([OTHER_DOC]);
    const baseline = await capture(tableProps(DOC));
    expect(baseline['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
    expect(policyReads()).toBe(4);
  });

  it('keeps the declared policy when the read throws after a stale answer', async () => {
    primeAws([OTHER_DOC, throttle()]);
    expect((await capture(tableProps(DOC)))['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
  });

  it('rejects a removal capture that throws after the deleted policy was still served', async () => {
    // go-to-k/cdkd#6759: an undeclared policy's failed read rejects instead of recording none.
    primeAws([DOC, throttle()]);
    await expect(capture(tableProps())).rejects.toThrow();
  });

  it('a plain drift read that throws after a present answer records that answer', async () => {
    // An out-of-band change to another document, then a throttle on the re-ask.
    primeAws([OTHER_DOC, throttle()]);
    const live = bagOf(
      await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, tableProps(DOC))
    );
    expect(live['ResourcePolicy']).toEqual({ PolicyDocument: OTHER_DOC });
  });

  it('keeps the declared policy over a not-found arn right after a create', async () => {
    primeAws([
      new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} }),
    ]);
    expect((await capture(tableProps(DOC)))['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
  });

  it('keeps the declared policy over a TRANSIENT read failure, never over a deterministic one', async () => {
    primeAws([throttle()]);
    expect((await capture(tableProps(DOC)))['ResourcePolicy']).toEqual({ PolicyDocument: DOC });

    mockSend.mockReset();
    const denied = Object.assign(new Error('not authorized to perform dynamodb:GetResourcePolicy'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 400 },
    });
    primeAws([denied]);
    // go-to-k/cdkd#6759: a deterministic failure rejects the read instead of omitting the policy.
    await expect(capture(tableProps(DOC))).rejects.toThrow('not authorized to perform');
  });

  it('a plain drift read takes an undeclared policy at its first answer, and keeps no declaration', async () => {
    // The template declares no policy; one was added outside cdkd.
    primeAws([DOC, 'none']);
    const live = bagOf(await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, tableProps()));
    expect(live['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
    expect(policyReads()).toBe(1);
    // And a declared policy removed outside cdkd stays absent: no declaration is kept.
    mockSend.mockReset();
    primeAws(['none']);
    const gone = bagOf(
      await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, tableProps(DOC))
    );
    expect(gone['ResourcePolicy']).toBeUndefined();
  });

  it('a plain drift read believes a declared policy replaced outside cdkd, after the re-asks', async () => {
    primeAws([OTHER_DOC]);
    const live = bagOf(
      await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE, tableProps(DOC))
    );
    expect(live['ResourcePolicy']).toEqual({ PolicyDocument: OTHER_DOC });
    expect(policyReads()).toBe(4);
  });

  it('a read with no desired bag takes the first answer', async () => {
    primeAws([DOC, 'none']);
    const live = bagOf(await provider.readCurrentState(TABLE_NAME, 'T', RESOURCE_TYPE));
    expect(live['ResourcePolicy']).toEqual({ PolicyDocument: DOC });
    expect(policyReads()).toBe(1);
  });
});

describe('drift heal of a pre-#6604 Table ResourcePolicy baseline', () => {
  const heal = (
    observed: Record<string, unknown>,
    properties: Record<string, unknown>,
    aws: Record<string, unknown>
  ) => preFixBaselineUncomparedDriftKeys(RESOURCE_TYPE, observed, properties, aws);
  const withPolicy = (doc: unknown) => ({ ResourcePolicy: { PolicyDocument: doc } });

  it('skips a recorded policy the template no longer declares and the table no longer holds', () => {
    expect(heal(withPolicy(DOC), tableProps(), {})).toEqual(['ResourcePolicy']);
  });

  it('skips a missing recorded policy while the table holds exactly the declared one', () => {
    // Key order differs from the template's: still the same document.
    const reordered = { Statement: DOC.Statement, Version: DOC.Version };
    expect(heal({}, tableProps(DOC), withPolicy(reordered))).toEqual(['ResourcePolicy']);
  });

  it('skips a REPLACED recorded policy while the table holds exactly the declared one', () => {
    expect(heal(withPolicy(OTHER_DOC), tableProps(DOC), withPolicy(DOC))).toEqual(['ResourcePolicy']);
  });

  it('compares every other combination', () => {
    // A declared policy removed outside cdkd.
    expect(heal(withPolicy(DOC), tableProps(DOC), {})).toEqual([]);
    // An undeclared policy added outside cdkd.
    expect(heal({}, tableProps(), withPolicy(DOC))).toEqual([]);
    // The live policy differs from the declaration, whatever is recorded.
    expect(heal({}, tableProps(DOC), withPolicy(OTHER_DOC))).toEqual([]);
    expect(heal(withPolicy(DOC), tableProps(DOC), withPolicy(OTHER_DOC))).toEqual([]);
    // A recorded undeclared policy the table still holds.
    expect(heal(withPolicy(DOC), tableProps(), withPolicy(DOC))).toEqual([]);
    // Another type is never touched.
    expect(
      preFixBaselineUncomparedDriftKeys('AWS::DynamoDB::GlobalTable', withPolicy(DOC), {}, {})
    ).toEqual([]);
  });
});
