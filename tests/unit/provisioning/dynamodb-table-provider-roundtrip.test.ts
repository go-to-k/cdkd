import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';

/**
 * Mechanical guard against Class 1 / Class 2 placeholder regressions on
 * `cdkd drift --revert`'s readCurrentState → update round-trip. See
 * `docs/provider-development.md` § 3b "Read-update round-trip test" and
 * `tests/unit/provisioning/sns-topic-provider-roundtrip.test.ts` for the
 * shape this mirrors.
 *
 * The DynamoDB provider's `update()` currently only mutates Tags via
 * TagResource / UntagResource (other property changes flow through
 * replacement = DELETE + CREATE). The round-trip guarantee we want here
 * is therefore:
 *
 *  1. State == AWS-current (zero drift) → zero mutating SDK calls
 *     (DescribeTable + ListTagsOfResource are reads; TagResource /
 *     UntagResource are mutations and must NOT fire).
 *  2. The readCurrentState shape never carries a Class 1 / Class 2
 *     placeholder that would push an AWS-rejecting payload through any
 *     future update() that learns to handle the field (GSI / LSI / SSE /
 *     Stream — see `dynamodb-table-provider.ts` readCurrentState
 *     comments for the per-field rationale).
 */
describe('DynamoDBTableProvider read-update round-trip', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  function mockDescribeTable(tableExtras: Record<string, unknown> = {}): void {
    mockSend.mockImplementationOnce(async (cmd: unknown) => {
      if (cmd instanceof DescribeTableCommand) {
        return {
          Table: {
            TableName: TABLE_NAME,
            TableArn: TABLE_ARN,
            ...tableExtras,
          },
        };
      }
      throw new Error(`unexpected command: ${cmd?.constructor.name}`);
    });
  }

  it('round-trip on no-drift snapshot is a logical no-op (no TagResource / UntagResource)', async () => {
    // Stronger assertion for diff-based providers: state == AWS implies
    // update() must make no AWS-side mutations.
    mockDescribeTable();

    const observed = {
      TableName: TABLE_NAME,
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    await provider.update('L', TABLE_NAME, 'AWS::DynamoDB::Table', observed, observed);

    const tagMutations = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagMutations).toHaveLength(0);
  });

  it('Class 2 — table without GSI / LSI: readCurrentState omits empty-array placeholders', async () => {
    // Round-trip safety: AWS rejects an empty-list "remove all GSIs"
    // request on a table that has none, and LSIs are immutable
    // post-create so even a stable "[]" placeholder is wrong shape for
    // any future update() that learns to handle the field. The
    // readCurrentState fix is to omit the keys entirely when AWS
    // reports no indexes.
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        // GSI / LSI absent in this DescribeTable response.
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('GlobalSecondaryIndexes');
    expect(result).not.toHaveProperty('LocalSecondaryIndexes');
  });

  it('Class 1 — table without SSE: readCurrentState omits SSESpecification placeholder', async () => {
    // SSEDescription absent (or Status !== 'ENABLED') → SSESpecification
    // must NOT be emitted. The previous always-emit `{ SSEEnabled: false }`
    // placeholder was a CFn-invalid shape the moment a future update()
    // started consuming SSESpecification (KMSMasterKeyId / SSEType are
    // only valid when SSEEnabled=true).
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        // SSEDescription absent.
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('SSESpecification');
  });

  it('Class 1 — table with SSEDescription.Status=DISABLED also omits SSESpecification', async () => {
    // AWS sometimes returns SSEDescription with Status=DISABLED on
    // tables that previously had SSE; that block carries no
    // KMSMasterKeyArn / SSEType and would only round-trip safely when
    // gated to Status==='ENABLED'.
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        SSEDescription: { Status: 'DISABLED' },
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('SSESpecification');
  });

  it('Class 1 — table without streams: readCurrentState omits StreamSpecification placeholder', async () => {
    // AWS may return StreamSpecification with StreamEnabled=false on
    // tables that previously had a stream. CFn's StreamSpecification
    // requires StreamViewType, so emitting the disabled block round-
    // trips as a CFn-invalid shape. Gate emit on StreamEnabled=true +
    // StreamViewType present.
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        StreamSpecification: { StreamEnabled: false },
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('StreamSpecification');
  });

  it('Class 1 — enabled stream is still surfaced (positive control)', async () => {
    // Complement of the disabled-stream test: a real enabled stream
    // SHOULD be emitted, with the CFn-shape StreamViewType.
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result?.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
  });

  it('Class 1 — enabled SSE is still surfaced (positive control)', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        SSEDescription: {
          Status: 'ENABLED',
          KMSMasterKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
          SSEType: 'KMS',
        },
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result?.SSESpecification).toEqual({
      SSEEnabled: true,
      KMSMasterKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
      SSEType: 'KMS',
    });
  });

  it('Class 2 — populated GSI is still surfaced (positive control)', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');

    expect(result?.GlobalSecondaryIndexes).toEqual([{ IndexName: 'gsi1' }]);
    expect(result).not.toHaveProperty('LocalSecondaryIndexes');
  });

  it('round-trip on a tableless-of-everything observed (GSI/SSE/Stream all absent) is a no-op', async () => {
    // End-to-end Class-1/Class-2 guard composed: read AWS, push the
    // result straight back through update(). Even though update() only
    // diffs Tags today, the round-trip must not surface any of the
    // omitted placeholder keys to update() (and update() must not fire
    // a TagResource / UntagResource call when tags also haven't
    // changed).
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const observed = await provider.readCurrentState(TABLE_NAME, 'L', 'AWS::DynamoDB::Table');
    expect(observed).toBeDefined();

    // Reset the mock and prime DescribeTable for the update() flow.
    vi.clearAllMocks();
    mockDescribeTable();

    await provider.update(
      'L',
      TABLE_NAME,
      'AWS::DynamoDB::Table',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const tagMutations = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagMutations).toHaveLength(0);

    // Sanity: we DID hit DescribeTable in update()'s tag-arn lookup but
    // never ListTagsOfResource (update() doesn't read AWS-side tags).
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
    expect(
      mockSend.mock.calls.some((c) => c[0] instanceof ListTagsOfResourceCommand)
    ).toBe(false);
  });
});
