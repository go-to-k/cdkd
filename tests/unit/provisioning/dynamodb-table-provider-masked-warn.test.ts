/**
 * Issue #5845 — the runtime twin for the BillingMode-flip warning's
 * per-value mask in `src/provisioning/providers/dynamodb-table/update-billing.ts`
 * (`${unspecified.map((n) => maskSecrets(n)).join(', ')}`).
 *
 * `scripts/check-provider-secret-mask.ts` fences only `${JSON.stringify(...)}`
 * sites, so nothing static notices this wrap being deleted. And the WHOLE
 * message is masked anyway (`warn = (m) => this.logger.warn(maskSecrets(m))`
 * in `update.ts`), so a long secret is removed with or without the wrap.
 *
 * What the per-value wrap buys over that whole-message pass is the SHORT
 * secret: `maskSecretsInText` masks an exact WHOLE-value match at any length,
 * but scans a finished line only for substring needles of >=
 * `BASE_MASKER_SUBSTRING_FLOOR` (4) characters. A DynamoDB index name may be 3
 * characters, so a 3-character resolved name survives the message-level pass
 * and only the per-value call removes it. That is the case pinned here:
 * deleting `maskSecrets(n)` at that site reds this test.
 *
 * The listed names come from the LIVE table (DescribeTable), not from
 * `properties` — a readback that echoes the template's names.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

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

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) =>
      cfg?.region === 'us-east-1' ? getAwsClients().dynamoDB : new actual.DynamoDBClient(cfg ?? {})
    ),
  };
});

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
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { BASE_MASKER_SUBSTRING_FLOOR } from '../../../src/provisioning/masked-retry-logger.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
/** DynamoDB's minimum index-name length, and below the substring floor. */
const SHORT_INDEX = 'q7z';
const LONG_INDEX = 'idx-resolved-from-a-secret';

const LIVE_GSI = (name: string) => ({
  IndexName: name,
  IndexStatus: 'ACTIVE',
  ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
});

/** A GSI whose declared read capacity CloudFormation rejects (` 7 `). */
const unusableGsi = (name: string) => ({
  IndexName: name,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  ProvisionedThroughput: { ReadCapacityUnits: ' 7 ', WriteCapacityUnits: 3 },
});

const usableGsi = (name: string) => ({
  ...unusableGsi(name),
  ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
});

/** The one warning this case is about — every other line is out of scope. */
function flipWarning(): string {
  const lines = childLogger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.includes('no usable ProvisionedThroughput'));
  expect(lines).toHaveLength(1);
  return lines[0] ?? '';
}

describe('DynamoDB table BillingMode-flip warning masks each index name (#5845)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new DynamoDBTableProvider();
  });

  const runFlip = async (indexName: string, bag: RecordedSecretValues): Promise<void> => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeTableCommand) {
        return Promise.resolve({
          Table: {
            TableName: TABLE_NAME,
            TableArn: TABLE_ARN,
            TableStatus: 'ACTIVE',
            BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
            GlobalSecondaryIndexes: [LIVE_GSI(indexName)],
          },
        });
      }
      return Promise.resolve({});
    });
    await provider.update(
      'L',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      {
        TableName: TABLE_NAME,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [unusableGsi(indexName)],
      },
      {
        TableName: TABLE_NAME,
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [usableGsi(indexName)],
      },
      { maskSecrets: createSecretMasker(bag) }
    );
    // The flip went out: the warning is the cdkd-side note, not a refusal.
    expect(
      mockSend.mock.calls.some(
        (c) => c[0] instanceof UpdateTableCommand && c[0].input.BillingMode === 'PROVISIONED'
      )
    ).toBe(true);
  };

  it('masks a SHORT resolved index name, which only the per-value pass can reach', async () => {
    // The premise, asserted rather than assumed: if the floor dropped to 3 the
    // message-level pass would catch this name too and the case would stop
    // distinguishing the per-value call.
    expect(SHORT_INDEX.length).toBeLessThan(BASE_MASKER_SUBSTRING_FLOOR);

    await runFlip(
      SHORT_INDEX,
      new Map([[SHORT_INDEX, '{{resolve:secretsmanager:idx:SecretString:n::}}']])
    );

    const warned = flipWarning();
    // Anchored on the surrounding text so three letters cannot match inside
    // another word, and so a reword is noticed rather than read as a pass.
    expect(warned).toContain(`live index(es) ${SECRET_MASK}. AWS requires`);
    expect(warned).not.toContain(` ${SHORT_INDEX}.`);
  });

  it('control: an UNREGISTERED short name is printed as-is', async () => {
    // Without this, the case above would also pass if the site masked every
    // name unconditionally (or the line never named one at all).
    await runFlip(SHORT_INDEX, new Map());
    expect(flipWarning()).toContain(`live index(es) ${SHORT_INDEX}. AWS requires`);
  });

  it('masks a LONG resolved index name (either pass reaches it)', async () => {
    await runFlip(
      LONG_INDEX,
      new Map([[LONG_INDEX, '{{resolve:secretsmanager:idx:SecretString:n::}}']])
    );
    const warned = flipWarning();
    expect(warned).not.toContain(LONG_INDEX);
    expect(warned).toContain(`live index(es) ${SECRET_MASK}. AWS requires`);
  });
});
