import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTableCommand } from '@aws-sdk/client-dynamodb';

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

const KEY_SCHEMA = [{ AttributeName: 'gsipk', KeyType: 'HASH' }];
const PROJECTION = { ProjectionType: 'ALL' };

function gsi(capacity: Record<string, unknown>, name: unknown = 'gsi1'): Record<string, unknown> {
  return {
    IndexName: name,
    KeySchema: KEY_SCHEMA,
    Projection: PROJECTION,
    ProvisionedThroughput: capacity,
  };
}

const ZERO = { ReadCapacityUnits: 0, WriteCapacityUnits: 0 };
const FIVE = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };

function gsiUpdates(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof UpdateTableCommand)
    .flatMap((c) => (c[0] as UpdateTableCommand).input.GlobalSecondaryIndexUpdates ?? []);
}

function warnText(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

/** A live PROVISIONED table holding `gsi1` at capacity 5. */
function primeLiveTable(): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof UpdateTableCommand) return Promise.resolve({});
    return Promise.resolve({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        ProvisionedThroughput: FIVE,
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi1',
            KeySchema: KEY_SCHEMA,
            Projection: PROJECTION,
            IndexStatus: 'ACTIVE',
            ProvisionedThroughput: { NumberOfDecreasesToday: 0, ...FIVE },
          },
        ],
      },
    });
  });
}

let provider: DynamoDBTableProvider;

beforeEach(() => {
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
  primeLiveTable();
});

/**
 * Issue #3728: the per-index `ProvisionedThroughput: {0, 0}` answer is split on
 * the ORIGIN of the desired bag. A template-path update REFUSES it before any
 * AWS call (as `create()` fails on the same value); the two state-borne
 * callers — the rollback executor's revert arms (`replayingState`) and
 * `cdkd drift --revert` (`desiredFromAwsReadback`) — keep the warn-and-skip.
 */
describe('DynamoDBTableProvider per-index {0, 0} capacity: template refuses, replay warns', () => {
  /** The same-name arm: capacity changes 5 -> 0 on a PROVISIONED table. */
  const edit = (context?: Record<string, unknown>) =>
    provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PROVISIONED', ProvisionedThroughput: FIVE, GlobalSecondaryIndexes: [gsi(ZERO)] },
      { BillingMode: 'PROVISIONED', ProvisionedThroughput: FIVE, GlobalSecondaryIndexes: [gsi(FIVE)] },
      context
    );

  it.each([
    ['no context', undefined],
    ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
  ])('REFUSES on a template-path update (%s), before any AWS call', async (_label, context) => {
    const error = await edit(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toMatch(
      /^AWS::DynamoDB::Table L: GlobalSecondaryIndexes gsi1 declare ProvisionedThroughput \{ReadCapacityUnits: 0, WriteCapacityUnits: 0\}/
    );
    expect((error as Error).message).toContain('Nothing was applied to the table');
    // Pre-flight: not even the DescribeTable read went out.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a rollback revert arm (replayingState)', { replayingState: true }],
    ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
  ])('warn-skips on %s and sends no capacity op', async (_label, context) => {
    await expect(edit(context)).resolves.toBeDefined();

    expect(gsiUpdates()).toEqual([]);
    expect(warnText()).toContain('on-demand placeholder');
  });

  it('REFUSES a brand-new index carrying the placeholder, which used to reach AWS mid-update', async () => {
    // The Create action never consulted the skip, so AWS rejected the {0, 0}
    // AFTER the tag diff had landed. Refusing up front applies nothing.
    const error = await provider
      .update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [gsi(FIVE), gsi(ZERO, 'gsi2')] },
        { GlobalSecondaryIndexes: [gsi(FIVE)] }
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('GlobalSecondaryIndexes gsi2 declare');
    expect((error as Error).message).not.toContain('gsi1');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('names EVERY offending index in one refusal', async () => {
    const error = await provider
      .update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [gsi(ZERO), gsi(ZERO, 'gsi2')] },
        { GlobalSecondaryIndexes: [gsi(FIVE)] }
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('GlobalSecondaryIndexes gsi1, gsi2 declare');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('REFUSES the string-spelled placeholder too, through the SAME predicate as the skip', async () => {
    const error = await provider
      .update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [gsi({ ReadCapacityUnits: '0', WriteCapacityUnits: '0' })] },
        { GlobalSecondaryIndexes: [gsi(FIVE)] }
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
  });

  it('does NOT refuse an UNCHANGED placeholder — the template sends nothing for it', async () => {
    // A steady-state template that has always carried {0, 0} emits no capacity
    // op, so refusing it would fail a deploy with nothing pending for the index.
    await expect(
      provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [gsi(ZERO)], Tags: [{ Key: 'k', Value: 'new' }] },
        { GlobalSecondaryIndexes: [gsi(ZERO)] }
      )
    ).resolves.toBeDefined();
    expect(gsiUpdates()).toEqual([]);
  });

  it('does NOT refuse a half-zero capacity {0, 7}, which still goes to AWS', async () => {
    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: FIVE,
        GlobalSecondaryIndexes: [gsi({ ReadCapacityUnits: 0, WriteCapacityUnits: 7 })],
      },
      { BillingMode: 'PROVISIONED', ProvisionedThroughput: FIVE, GlobalSecondaryIndexes: [gsi(FIVE)] }
    );

    expect(gsiUpdates()).toHaveLength(1);
  });

  it('renders a NUMERIC IndexName as <unnamed> rather than crashing the masker', async () => {
    // A real masker (a `String.replace` call) and a numeric name: a bare
    // `maskSecrets(indexName)` would throw `text.replace is not a function`.
    const error = await provider
      .update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [gsi(ZERO, 2024)] },
        { GlobalSecondaryIndexes: [gsi(FIVE, 2024)] },
        { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('GlobalSecondaryIndexes <unnamed> declare');
  });
});
