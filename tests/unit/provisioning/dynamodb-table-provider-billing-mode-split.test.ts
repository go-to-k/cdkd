import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTableCommand, TagResourceCommand } from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const FIVE = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };

function warnText(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

function writes(): unknown[] {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((cmd) => cmd instanceof UpdateTableCommand || cmd instanceof TagResourceCommand);
}

let provider: DynamoDBTableProvider;

beforeEach(() => {
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof UpdateTableCommand || cmd instanceof TagResourceCommand) {
      return Promise.resolve({});
    }
    return Promise.resolve({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        ProvisionedThroughput: FIVE,
      },
    });
  });
});

/**
 * Issue #3740 (the #3728 shape): a malformed DESIRED `BillingMode` is split on
 * the ORIGIN of the desired bag. A template-path update REFUSES a changed one
 * before any AWS call — the arm that reads it runs after `DescribeTable` and
 * the tag diff, so it cannot refuse in place. The two state-borne callers keep
 * the warn-and-keep-the-previous-mode arm.
 */
describe('DynamoDBTableProvider malformed BillingMode: template refuses, replay warns', () => {
  const edit = (billingMode: unknown, context?: Record<string, unknown>, previous?: unknown) =>
    provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: billingMode,
        ProvisionedThroughput: FIVE,
        Tags: [{ Key: 'k', Value: 'v2' }],
      },
      {
        BillingMode: previous ?? 'PROVISIONED',
        ProvisionedThroughput: FIVE,
        Tags: [{ Key: 'k', Value: 'v1' }],
      },
      context
    );

  it.each([
    ['no context', undefined],
    ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
  ])('REFUSES a changed malformed value on a template-path update (%s), before any AWS call', async (_label, context) => {
    const error = await edit('   ', context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toMatch(
      /^AWS::DynamoDB::Table L: AWS::DynamoDB::Table BillingMode must be a non-empty string/
    );
    expect((error as Error).message).toContain('Nothing was applied to the table');
    // Pre-flight: not even the DescribeTable read went out, so the tag diff
    // that runs right after it cannot have landed.
    expect(mockSend).not.toHaveBeenCalled();
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it.each([null, 7, ['PAY_PER_REQUEST'], { 'Fn::If': ['C', 'PROVISIONED', 'PAY_PER_REQUEST'] }])(
    'REFUSES the malformed shape %j on the template path',
    async (value) => {
      await expect(edit(value)).rejects.toThrow(/BillingMode must be a non-empty string/);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a rollback revert arm (replayingState)', { replayingState: true }],
    ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
  ])('warns and keeps the previous mode on %s', async (_label, context) => {
    await expect(edit('   ', context)).resolves.toBeDefined();

    expect(warnText()).toMatch(/AWS::DynamoDB::Table L: AWS::DynamoDB::Table BillingMode must be/);
    // The tag diff still ran, and no billing flip went out.
    expect(writes().some((cmd) => cmd instanceof TagResourceCommand)).toBe(true);
    const flips = writes().filter(
      (cmd) =>
        cmd instanceof UpdateTableCommand &&
        (cmd as UpdateTableCommand).input.BillingMode !== undefined
    );
    expect(flips).toEqual([]);
  });

  it('does NOT refuse an UNCHANGED malformed value on the template path (not a pending operation)', async () => {
    await expect(edit('   ', undefined, '   ')).resolves.toBeDefined();

    // The warn arm answers it, and the rest of the update proceeds.
    expect(warnText()).toMatch(/BillingMode must be a non-empty string/);
    expect(writes().some((cmd) => cmd instanceof TagResourceCommand)).toBe(true);
  });

  it('does not refuse a usable CHANGED value, nor an ABSENT one (the documented reset to PROVISIONED)', async () => {
    await expect(edit('PAY_PER_REQUEST')).resolves.toBeDefined();
    await expect(edit(undefined)).resolves.toBeDefined();
    expect(warnText()).not.toMatch(/BillingMode must be/);
  });
});
