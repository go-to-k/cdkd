import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => childLogger),
  };
  return { mockSend: vi.fn(), childLogger };
});

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
    DynamoDBClient: vi.fn((cfg: { region?: string } | undefined) =>
      cfg?.region === 'us-east-1' ? getAwsClients().dynamoDB : new actual.DynamoDBClient(cfg ?? {})
    ),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { injectiveKey } from '../../../src/state/record-keys.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'stream-view-type-table';

const props = (viewType: string): Record<string, unknown> => ({
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  StreamSpecification: { StreamViewType: viewType },
  Replicas: [{ Region: 'us-east-1' }],
});

const describeResponse = (liveViewType: string | undefined): Record<string, unknown> => ({
  Table: {
    TableName: TABLE_NAME,
    TableStatus: 'ACTIVE',
    TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
    BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
    Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
    LatestStreamArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}/stream/2026-11-25T19:31:17.198`,
    ...(liveViewType !== undefined && {
      StreamSpecification: { StreamEnabled: true, StreamViewType: liveViewType },
    }),
  },
});

/**
 * go-to-k/cdkd#7000: DynamoDB refuses a new view type on an enabled stream
 * ("Table already has an enabled stream"), so a `TableV2` `dynamoStream`
 * change failed every deploy. The live stream is now disabled first, the
 * table waited back to ACTIVE, and the new one enabled, as CloudFormation and
 * the `AWS::DynamoDB::Table` provider do.
 */
describe('DynamoDBGlobalTableProvider StreamViewType change (#7000)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    provider = new DynamoDBGlobalTableProvider();
  });

  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  it('disables the live stream, waits, then enables the new view type', async () => {
    mockSend.mockResolvedValue(describeResponse('NEW_IMAGE'));

    await provider.update(
      'Table',
      TABLE_NAME,
      RESOURCE_TYPE,
      props('NEW_AND_OLD_IMAGES'),
      props('NEW_IMAGE')
    );

    const streamCalls = updateInputs().filter((i) => 'StreamSpecification' in i);
    expect(streamCalls.map((i) => i['StreamSpecification'])).toEqual([
      { StreamEnabled: false },
      { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    ]);
    // The enable waits for the disable to settle: a DescribeTable lies between them.
    const kinds = mockSend.mock.calls.map((c) => c[0].constructor.name);
    const disableAt = mockSend.mock.calls.findIndex(
      (c) =>
        c[0].constructor.name === 'UpdateTableCommand' &&
        (c[0].input as Record<string, unknown>)['StreamSpecification'] !== undefined
    );
    const enableAt = kinds.indexOf('UpdateTableCommand', disableAt + 1);
    expect(kinds.slice(disableAt + 1, enableAt)).toContain('DescribeTableCommand');
  });

  it('drops a cached StreamArn once the new stream is enabled', async () => {
    mockSend.mockResolvedValue(describeResponse('NEW_IMAGE'));
    const key = injectiveKey(TABLE_NAME, 'StreamArn');
    provider.attributeCache.set(key, 'arn:old-stream');
    provider.attributeCache.set(injectiveKey(TABLE_NAME, 'Arn'), 'arn:table');

    await provider.update(
      'Table',
      TABLE_NAME,
      RESOURCE_TYPE,
      props('NEW_AND_OLD_IMAGES'),
      props('NEW_IMAGE')
    );

    expect(provider.attributeCache.has(key)).toBe(false);
    expect(provider.attributeCache.get(injectiveKey(TABLE_NAME, 'Arn'))).toBe('arn:table');
  });

  it('a rollback after a failed enable sends only the enable', async () => {
    // The forward deploy disabled the stream and its enable failed: the replay
    // asks for the old view type over a live, disabled stream.
    mockSend.mockResolvedValue({
      Table: {
        ...(describeResponse(undefined)['Table'] as Record<string, unknown>),
        StreamSpecification: { StreamEnabled: false, StreamViewType: 'NEW_IMAGE' },
      },
    });

    await provider.update(
      'Table',
      TABLE_NAME,
      RESOURCE_TYPE,
      props('NEW_IMAGE'),
      props('NEW_AND_OLD_IMAGES')
    );

    const streamCalls = updateInputs().filter((i) => 'StreamSpecification' in i);
    expect(streamCalls.map((i) => i['StreamSpecification'])).toEqual([
      { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
    ]);
  });

  it('never disables the stream of a table replicated to another region', async () => {
    const base = describeResponse('NEW_IMAGE')['Table'] as Record<string, unknown>;
    mockSend.mockResolvedValue({
      Table: {
        ...base,
        Replicas: [
          { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
          { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
        ],
      },
    });
    const replicated = (viewType: string): Record<string, unknown> => ({
      ...props(viewType),
      Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
    });

    await provider
      .update('Table', TABLE_NAME, RESOURCE_TYPE, replicated('NEW_AND_OLD_IMAGES'), replicated('NEW_IMAGE'))
      .catch(() => undefined);

    const streamCalls = updateInputs().filter((i) => 'StreamSpecification' in i);
    expect(streamCalls.some((i) => (i['StreamSpecification'] as Record<string, unknown>)['StreamEnabled'] === false)).toBe(false);
  });

  it('enables a stream the table does not have without a disable first', async () => {
    mockSend.mockResolvedValue(describeResponse(undefined));
    const previous = { ...props('NEW_IMAGE') };
    delete previous['StreamSpecification'];

    await provider.update('Table', TABLE_NAME, RESOURCE_TYPE, props('NEW_IMAGE'), previous);

    const streamCalls = updateInputs().filter((i) => 'StreamSpecification' in i);
    expect(streamCalls.map((i) => i['StreamSpecification'])).toEqual([
      { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
    ]);
  });
});
