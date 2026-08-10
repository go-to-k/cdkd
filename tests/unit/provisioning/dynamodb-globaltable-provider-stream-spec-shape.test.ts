import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';

/**
 * The `??`-shaped sibling of the #1471 / #1490 `||` defaulting class
 * (issue #1493).
 *
 * `StreamSpecification` is entered through a TRUTHINESS gate and then
 * INDEXED, so a string / array / unresolved intrinsic passed the gate,
 * indexed to `undefined`, and the fallback silently enabled a
 * `NEW_AND_OLD_IMAGES` stream — a stream shape the template never declared,
 * on a table whose replicas then consume it.
 */
describe('DynamoDBGlobalTableProvider malformed StreamSpecification (issue #1493)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new DynamoDBGlobalTableProvider();
  });

  const baseProps = {
    TableName: 'my-test-table-xxx',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
    Replicas: [{ Region: 'us-east-1' }],
  };

  it('refuses a string container instead of inventing a NEW_AND_OLD_IMAGES stream', async () => {
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        StreamSpecification: 'NEW_IMAGE',
      })
    ).rejects.toThrow(
      /AWS::DynamoDB::GlobalTable StreamSpecification must be an object \(got a string\)/
    );

    // The refusal must land BEFORE CreateTable, not after a half-created table.
    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).not.toContain('CreateTableCommand');
  });

  // The guard sat behind `if (streamSpecInput)`, so a FALSY malformed container
  // skipped it entirely and fell through to the auto-enable arm. `!= null` is
  // what .claude/rules/providers.md requires ("cover the CREATE path").
  it('refuses a BLANK-STRING container, which the truthiness gate would have skipped', async () => {
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, StreamSpecification: '' })
    ).rejects.toThrow(
      /AWS::DynamoDB::GlobalTable StreamSpecification must be an object \(got a blank string\)/
    );
    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).not.toContain('CreateTableCommand');
  });

  it('surfaces the refusal as a ProvisioningError, not a bare Error', async () => {
    // `create()` has no wrapping catch at this point, so an unwrapped throw
    // would escape untyped into the deploy engine's retry loop.
    const err = await provider
      .create('MyTable', RESOURCE_TYPE, { ...baseProps, StreamSpecification: 'NEW_IMAGE' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err).toMatchObject({ resourceType: RESOURCE_TYPE, logicalId: 'MyTable' });
  });

  it('refuses a blank StreamViewType rather than defaulting it away', async () => {
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        StreamSpecification: { StreamViewType: '' },
      })
    ).rejects.toThrow(
      /AWS::DynamoDB::GlobalTable StreamSpecification.StreamViewType must be a non-empty string/
    );
  });

  it('still defaults the view type when the KEY is absent (an empty block means defaulted)', async () => {
    mockSend.mockResolvedValue({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'ACTIVE' },
    });

    await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      StreamSpecification: {},
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
  });

  it('passes a well-formed view type through unchanged', async () => {
    mockSend.mockResolvedValue({
      Table: { TableName: 'my-test-table-xxx', TableStatus: 'ACTIVE' },
    });

    await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
    });

    const createCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'CreateTableCommand'
    );
    expect(createCall?.[0].input.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: 'KEYS_ONLY',
    });
  });
});
