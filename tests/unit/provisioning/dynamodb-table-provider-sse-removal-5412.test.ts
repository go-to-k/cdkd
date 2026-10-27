import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

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

// `CreateTable` goes through a dedicated client built in the shared client's
// region (issue #4639); route it to the shared double so `mockSend` sees it.
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

import {
  DynamoDBTableProvider,
  mapSSESpecification,
  sseSpecificationToSend,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TABLE_NAME = 'my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';
const BASE = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
};
const CMK_BLOCK = { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: KEY_ARN };
const LIVE_CMK = { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: KEY_ARN };

/** `liveSse`: the table's `SSEDescription`; `undefined` = absent (AWS owned key). */
function prime(liveSse?: Record<string, unknown>, liveDeletionProtection?: boolean): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`,
          TableStatus: 'ACTIVE',
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          ...(liveSse !== undefined && { SSEDescription: liveSse }),
          ...(liveDeletionProtection !== undefined && {
            DeletionProtectionEnabled: liveDeletionProtection,
          }),
        },
      });
    }
    return Promise.resolve({});
  });
}

const sseCalls = () =>
  mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter(
      (c): c is UpdateTableCommand =>
        c instanceof UpdateTableCommand && c.input.SSESpecification !== undefined
    );
const warnings = (): string => childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('AWS::DynamoDB::Table SSESpecification removal (go-to-k/cdkd#5412)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new DynamoDBTableProvider();
  });

  const update = (
    desired: unknown,
    previous: unknown,
    context?: { replayingState?: boolean; desiredFromAwsReadback?: boolean }
  ) =>
    provider.update(
      'T',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...BASE, ...(desired !== undefined && { SSESpecification: desired }) },
      { ...BASE, ...(previous !== undefined && { SSESpecification: previous }) },
      context
    );

  it('a removed CMK block sends { Enabled: false } once, then waits for ACTIVE', async () => {
    prime(LIVE_CMK);
    await update(undefined, CMK_BLOCK);
    const calls = sseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ TableName: TABLE_NAME, SSESpecification: { Enabled: false } });
    const names = mockSend.mock.calls.map(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name
    );
    const at = names.indexOf('UpdateTableCommand');
    expect(names[at + 1]).toBe('DescribeTableCommand');
  });

  it('a declared SSEEnabled: false resets an encrypted table', async () => {
    prime(LIVE_CMK);
    await update({ SSEEnabled: false }, CMK_BLOCK);
    const calls = sseCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.SSESpecification).toEqual({ Enabled: false });
  });

  it('no previous SSE sends nothing', async () => {
    prime(undefined);
    await update(undefined, undefined);
    expect(sseCalls()).toHaveLength(0);
  });

  it('a removed SSEEnabled: false block sends nothing', async () => {
    prime({ Status: 'DISABLED' });
    await update(undefined, { SSEEnabled: false });
    expect(sseCalls()).toHaveLength(0);
  });

  it('a removal sends nothing when AWS already reports the AWS owned key', async () => {
    prime(undefined);
    await update(undefined, CMK_BLOCK);
    expect(sseCalls()).toHaveLength(0);
  });

  it('a declared SSEEnabled: false sends nothing when AWS already reports the AWS owned key', async () => {
    prime({ Status: 'DISABLED' });
    await update({ SSEEnabled: false }, CMK_BLOCK);
    expect(sseCalls()).toHaveLength(0);
  });

  for (const redacted of ['***', '{{resolve:ssm:/sse-flag}}']) {
    it(`a previous SSEEnabled of ${redacted} is decided by the live table`, async () => {
      prime(LIVE_CMK);
      await update(undefined, { SSEEnabled: redacted, KMSMasterKeyId: KEY_ARN });
      expect(sseCalls().map((c) => c.input.SSESpecification)).toEqual([{ Enabled: false }]);
    });

    it(`a previous SSEEnabled of ${redacted} sends nothing when the live status is unknown`, async () => {
      prime({});
      await update(undefined, { SSEEnabled: redacted, KMSMasterKeyId: KEY_ARN });
      expect(sseCalls()).toHaveLength(0);
    });

    it(`a desired SSEEnabled of ${redacted} is refused on the template path`, async () => {
      prime(LIVE_CMK);
      const err = await update({ SSEEnabled: redacted }, CMK_BLOCK).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain('SSESpecification.SSEEnabled must be a boolean');
      expect(
        mockSend.mock.calls.filter((c) => c[0] instanceof UpdateTableCommand)
      ).toHaveLength(0);
    });

    for (const ctx of [{ replayingState: true }, { desiredFromAwsReadback: true }]) {
      it(`a desired SSEEnabled of ${redacted} warns and sends nothing (${Object.keys(ctx)[0]})`, async () => {
        prime(LIVE_CMK);
        await update({ SSEEnabled: redacted }, CMK_BLOCK, ctx);
        expect(sseCalls()).toHaveLength(0);
        expect(warnings()).toContain('SSESpecification.SSEEnabled must be a boolean');
        expect(warnings()).toContain("so the table's encryption was left as it is");
      });
    }
  }

  it('a non-object desired block is refused on the template path and skipped on a replay', async () => {
    prime(LIVE_CMK);
    const err = await update('nope', CMK_BLOCK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toContain('SSESpecification must be an object');
    mockSend.mockClear();
    await update('nope', CMK_BLOCK, { replayingState: true });
    expect(sseCalls()).toHaveLength(0);
    expect(warnings()).toContain('SSESpecification must be an object');
  });

  it('a declared null block is refused on the template path and skipped on a replay', async () => {
    prime(LIVE_CMK);
    const err = await update(null, CMK_BLOCK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toContain('SSESpecification must be an object (got null)');
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof UpdateTableCommand)).toHaveLength(0);
    mockSend.mockClear();
    await update(null, CMK_BLOCK, { desiredFromAwsReadback: true });
    expect(sseCalls()).toHaveLength(0);
    expect(warnings()).toContain('SSESpecification must be an object (got null)');
  });

  it('waits for the key switch to settle, not only for ACTIVE, before the next UpdateTable', async () => {
    let afterSse = 0;
    let sseSent = false;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof UpdateTableCommand && cmd.input.SSESpecification !== undefined) {
        sseSent = true;
      }
      if (cmd instanceof DescribeTableCommand) {
        // The first read after the reset reports ACTIVE with the key still
        // switching; the second, settled.
        const switching = sseSent && afterSse++ === 0;
        return Promise.resolve({
          Table: {
            TableName: TABLE_NAME,
            TableArn: `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`,
            TableStatus: 'ACTIVE',
            DeletionProtectionEnabled: true,
            ...(switching
              ? { SSEDescription: { Status: 'UPDATING' } }
              : sseSent
                ? {}
                : { SSEDescription: LIVE_CMK }),
          },
        });
      }
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    try {
      const done = provider.update(
        'T',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...BASE },
        { ...BASE, SSESpecification: CMK_BLOCK, DeletionProtectionEnabled: true }
      );
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    const sequence = mockSend.mock.calls.map((c) => {
      const cmd = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
      if (cmd instanceof UpdateTableCommand) {
        return cmd.input.SSESpecification !== undefined ? 'sse' : 'protection';
      }
      return cmd.constructor.name;
    });
    const sse = sequence.indexOf('sse');
    expect(sequence.slice(sse, sse + 4)).toEqual([
      'sse',
      'DescribeTableCommand',
      'DescribeTableCommand',
      'protection',
    ]);
  });

  it('create refuses an SSEEnabled that is no boolean before CreateTable', async () => {
    prime(undefined);
    await expect(
      provider.create('T', RESOURCE_TYPE, { ...BASE, SSESpecification: { SSEEnabled: '***' } })
    ).rejects.toThrow(/SSESpecification\.SSEEnabled must be a boolean.*Nothing was created/);
    expect(mockSend.mock.calls.some((c) => c[0] instanceof CreateTableCommand)).toBe(false);
  });

  it('create refuses a null SSESpecification before CreateTable', async () => {
    prime(undefined);
    await expect(
      provider.create('T', RESOURCE_TYPE, { ...BASE, SSESpecification: null })
    ).rejects.toThrow(/SSESpecification must be an object \(got null\).*Nothing was created/);
    expect(mockSend.mock.calls.some((c) => c[0] instanceof CreateTableCommand)).toBe(false);
  });

  for (const keyIntent of [{ SSEType: 'KMS' }, { KMSMasterKeyId: KEY_ARN }]) {
    it(`a replayed create whose record names a key (${Object.keys(keyIntent)[0]}) is refused`, async () => {
      prime(undefined);
      await expect(
        provider.create(
          'T',
          RESOURCE_TYPE,
          { ...BASE, SSESpecification: { SSEEnabled: '***', ...keyIntent } },
          { replayingState: true }
        )
      ).rejects.toThrow(/the record names a key.*Nothing was created/);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof CreateTableCommand)).toBe(false);
    });
  }

  it('a table already switching keys is waited out and read again before deciding', async () => {
    let reads = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeTableCommand) {
        reads++;
        return Promise.resolve({
          Table: {
            TableName: TABLE_NAME,
            TableArn: `arn:aws:dynamodb:us-east-1:123:table/${TABLE_NAME}`,
            TableStatus: 'ACTIVE',
            // The update's own read sees the key still switching; the settle
            // wait's read sees it settled on the CMK.
            SSEDescription: reads === 1 ? { Status: 'UPDATING' } : LIVE_CMK,
          },
        });
      }
      return Promise.resolve({});
    });
    await update(undefined, CMK_BLOCK);
    const sequence = mockSend.mock.calls.map((c) => {
      const cmd = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
      return cmd instanceof UpdateTableCommand ? 'sse' : cmd.constructor.name;
    });
    expect(sequence.slice(0, 3)).toEqual(['DescribeTableCommand', 'DescribeTableCommand', 'sse']);
    expect(sseCalls().map((c) => c.input.SSESpecification)).toEqual([{ Enabled: false }]);
  });

  it('a removal sends nothing when the switching table settles on the AWS owned key', async () => {
    let reads = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeTableCommand) {
        reads++;
        return Promise.resolve({
          Table: {
            TableName: TABLE_NAME,
            TableStatus: 'ACTIVE',
            ...(reads === 1 && { SSEDescription: { Status: 'DISABLING' } }),
          },
        });
      }
      return Promise.resolve({});
    });
    await update(undefined, CMK_BLOCK);
    expect(reads).toBe(2);
    expect(sseCalls()).toHaveLength(0);
  });

  it('a replayed create warns and creates the table on the AWS owned key', async () => {
    prime(undefined);
    await provider.create(
      'T',
      RESOURCE_TYPE,
      { ...BASE, SSESpecification: { SSEEnabled: '***' } },
      { replayingState: true }
    );
    const create = mockSend.mock.calls
      .map((c) => c[0] as unknown)
      .find((c): c is CreateTableCommand => c instanceof CreateTableCommand);
    expect(create).toBeDefined();
    expect(create!.input.SSESpecification).toBeUndefined();
    expect(warnings()).toContain('so the table is created on the AWS owned key');
  });

  it('a previous SSEEnabled: true is honoured when the live status is unknown', async () => {
    prime({});
    await update(undefined, CMK_BLOCK);
    expect(sseCalls().map((c) => c.input.SSESpecification)).toEqual([{ Enabled: false }]);
  });

  it('cdkd drift --revert resets a key enabled outside the template', async () => {
    prime(LIVE_CMK);
    await update(undefined, { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: KEY_ARN }, {
      desiredFromAwsReadback: true,
    });
    expect(sseCalls().map((c) => c.input.SSESpecification)).toEqual([{ Enabled: false }]);
  });

  it('a rollback revert to a record without SSE resets the key', async () => {
    prime(LIVE_CMK);
    await update(undefined, CMK_BLOCK, { replayingState: true });
    expect(sseCalls().map((c) => c.input.SSESpecification)).toEqual([{ Enabled: false }]);
  });

  it('the reset waits for ACTIVE before the next UpdateTable', async () => {
    prime(LIVE_CMK, true);
    await provider.update(
      'T',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...BASE },
      { ...BASE, SSESpecification: CMK_BLOCK, DeletionProtectionEnabled: true }
    );
    const sequence = mockSend.mock.calls.map((c) => {
      const cmd = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
      if (cmd instanceof UpdateTableCommand) {
        return cmd.input.SSESpecification !== undefined ? 'sse' : 'protection';
      }
      return cmd.constructor.name;
    });
    const sse = sequence.indexOf('sse');
    expect(sse).toBeGreaterThan(-1);
    expect(sequence[sse + 1]).toBe('DescribeTableCommand');
    expect(sequence.indexOf('protection')).toBeGreaterThan(sse + 1);
  });

  it('mapSSESpecification reads SSEEnabled through coerceCfnBoolean', () => {
    expect(mapSSESpecification({ SSEEnabled: 'TRUE' })).toEqual({ Enabled: true });
    expect(mapSSESpecification({ SSEEnabled: 'False' })).toEqual({ Enabled: false });
  });

  describe('sseSpecificationToSend', () => {
    it.each([
      ['removed, live ENABLED', undefined, CMK_BLOCK, LIVE_CMK, true, { Enabled: false }],
      ['removed, live ENABLING', undefined, CMK_BLOCK, { Status: 'ENABLING' }, true, { Enabled: false }],
      ['removed, live UPDATING', undefined, CMK_BLOCK, { Status: 'UPDATING' }, true, { Enabled: false }],
      ['removed, live absent', undefined, CMK_BLOCK, undefined, true, undefined],
      ['removed, live DISABLING', undefined, CMK_BLOCK, { Status: 'DISABLING' }, true, undefined],
      ['removed, not described, previous on', undefined, CMK_BLOCK, undefined, false, { Enabled: false }],
      ['removed, not described, previous "TRUE"', undefined, { SSEEnabled: 'TRUE' }, undefined, false, { Enabled: false }],
      ['removed, not described, previous off', undefined, { SSEEnabled: false }, undefined, false, undefined],
      ['removed, not described, previous ***', undefined, { SSEEnabled: '***' }, undefined, false, undefined],
      ['declared CMK', CMK_BLOCK, undefined, undefined, true, { Enabled: true, SSEType: 'KMS', KMSMasterKeyId: KEY_ARN }],
      ['declared false, live on', { SSEEnabled: 'false' }, CMK_BLOCK, LIVE_CMK, true, { Enabled: false }],
      ['declared false, live off', { SSEEnabled: false }, CMK_BLOCK, undefined, true, undefined],
      ['declared non-object', 'nope', CMK_BLOCK, LIVE_CMK, true, undefined],
      ['declared null', null, CMK_BLOCK, LIVE_CMK, true, undefined],
      ['declared CMK AWS already holds', CMK_BLOCK, { SSEEnabled: true }, LIVE_CMK, true, undefined],
      [
        'declared key id AWS already holds',
        { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: KEY_ARN.split('/')[1] },
        { SSEEnabled: true },
        LIVE_CMK,
        true,
        undefined,
      ],
      [
        'declared CMK, live on another key',
        CMK_BLOCK,
        { SSEEnabled: true },
        { ...LIVE_CMK, KMSMasterKeyArn: `${KEY_ARN}-other` },
        true,
        { Enabled: true, SSEType: 'KMS', KMSMasterKeyId: KEY_ARN },
      ],
      [
        'declared CMK by alias is sent (only an ARN compares)',
        { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: 'alias/k' },
        { SSEEnabled: true },
        LIVE_CMK,
        true,
        { Enabled: true, SSEType: 'KMS', KMSMasterKeyId: 'alias/k' },
      ],
    ])('%s', (_name, desired, previous, live, described, expected) => {
      expect(
        sseSpecificationToSend(
          desired,
          previous,
          live as Parameters<typeof sseSpecificationToSend>[2],
          described
        )
      ).toEqual(expected);
    });
  });
});
