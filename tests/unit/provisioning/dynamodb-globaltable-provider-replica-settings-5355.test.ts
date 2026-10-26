import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5355: a replica's KMS key and table class are read under the
 * CFn spellings (`Replicas[].SSESpecification.KMSMasterKeyId`,
 * `Replicas[].TableClass`), a cross-region replica's
 * `DeletionProtectionEnabled` is sent to that replica's own table, and a
 * removed top-level `SSESpecification` resets the table to the AWS owned key,
 * as CloudFormation does.
 *
 * The property bags follow `cdk synth` for a `TableV2` with
 * `encryption: TableEncryptionV2.customerManagedKey(...)`, `tableClass` and
 * `deletionProtection`: every one of those renders PER REPLICA.
 */

const { mockSend, regionalSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Every DynamoDB client the provider builds (the `CreateTable` client
// included) is the SOURCE double, except the region-scoped one, which the
// suite routes to `regionalSend` so a call's REGION is what the test reads.
vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: cfg?.region === 'eu-west-1' ? regionalSend : mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  disarmInterruptWatchForTests,
  InterruptedWaitError,
  interruptWatchTestSeam,
  isInterruptedWaitError,
  resetInterruptWatchLatch,
} from '../../../src/provisioning/interrupt-watch.js';
import {
  DELETION_PROTECTION_REFLIP_MS,
  DynamoDBGlobalTableProvider,
  extractAnyDeletionProtection,
  extractLocalTableClass,
  readReplicaKmsMasterKeyId,
  readReplicaTableClass,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-5355';
const LOCAL_KEY = 'arn:aws:kms:us-east-1:123456789012:key/local';
const REMOTE_KEY = 'arn:aws:kms:eu-west-1:123456789012:key/remote';

const base = (
  local: Record<string, unknown> = {},
  remote: Record<string, unknown> | null = {}
): Record<string, unknown> => ({
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  Replicas: [
    { Region: 'us-east-1', ...local },
    ...(remote !== null ? [{ Region: 'eu-west-1', ...remote }] : []),
  ],
});

const activeTable = (
  replicas = ['eu-west-1'],
  live: { table?: Record<string, unknown>; replica?: Record<string, unknown> } = {}
) => ({
  Table: {
    TableName: TABLE,
    TableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${TABLE}`,
    TableStatus: 'ACTIVE',
    StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    ...live.table,
    Replicas: replicas.map((r) => ({ RegionName: r, ReplicaStatus: 'ACTIVE', ...live.replica })),
  },
});

type Sent = { constructor: { name: string }; input: Record<string, any> };
const sent = (fn: ReturnType<typeof vi.fn>, ctor: { name: string }): Array<Record<string, any>> =>
  fn.mock.calls.map((c) => c[0] as Sent).filter((c) => c.constructor.name === ctor.name).map(
    (c) => c.input
  );
const replicaAction = (kind: 'Create' | 'Update'): Record<string, any> | undefined =>
  sent(mockSend, UpdateTableCommand).find((i) => i['ReplicaUpdates']?.[0]?.[kind])?.[
    'ReplicaUpdates'
  ][0][kind];
const flatUpdate = (): Record<string, any> | undefined =>
  sent(mockSend, UpdateTableCommand).find(
    (i) => i['SSESpecification'] !== undefined || i['TableClass'] !== undefined
  );
/** The one call that sets every region's KMS key (`applyReplicaKeys`). */
const keysCall = (): Array<Record<string, any>> | undefined =>
  sent(mockSend, UpdateTableCommand).find((i) =>
    i['ReplicaUpdates']?.some((u: Record<string, any>) => u['Update']?.['KMSMasterKeyId'])
  )?.['ReplicaUpdates'];
const LIVE_LOCAL_KEY = { SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: LOCAL_KEY } };
const regionalDpeWrites = (): unknown[] =>
  sent(regionalSend, UpdateTableCommand).map((i) => i['DeletionProtectionEnabled']);

/**
 * The replica region's table: a protection write lands, and the next
 * describe reads it back ACTIVE, so the settle wait returns at once.
 * `throwOnWrite` lets a case refuse a given write (1-based).
 */
const regionalTable = (
  initialDpe: boolean,
  throwOnWrite: (n: number) => Error | undefined = () => undefined
): void => {
  let dpe = initialDpe;
  let writes = 0;
  regionalSend.mockImplementation(async (command: Sent) => {
    if (command.constructor.name === UpdateTableCommand.name) {
      writes++;
      const refusal = throwOnWrite(writes);
      if (refusal) throw refusal;
      dpe = command.input['DeletionProtectionEnabled'] as boolean;
      return {};
    }
    return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: dpe } };
  });
};

describe('replica CFn spellings read by the helpers (go-to-k/cdkd#5355)', () => {
  it('reads the KMS key from SSESpecification and ignores the old flat spelling', () => {
    expect(readReplicaKmsMasterKeyId({ SSESpecification: { KMSMasterKeyId: 'k' } })).toBe('k');
    expect(readReplicaKmsMasterKeyId({ KMSMasterKeyId: 'k' })).toBeUndefined();
    expect(readReplicaKmsMasterKeyId({ SSESpecification: { KMSMasterKeyId: '' } })).toBeUndefined();
  });

  it('reads TableClass and ignores the SDK member name', () => {
    expect(readReplicaTableClass({ TableClass: 'STANDARD_INFREQUENT_ACCESS' })).toBe(
      'STANDARD_INFREQUENT_ACCESS'
    );
    expect(readReplicaTableClass({ TableClassOverride: 'STANDARD_INFREQUENT_ACCESS' })).toBe(
      undefined
    );
  });

  it('reports the table protected when only a cross-region replica is', () => {
    expect(extractAnyDeletionProtection(base({}, { DeletionProtectionEnabled: true }), 'us-east-1')).toBe(
      true
    );
    expect(extractAnyDeletionProtection(base({ DeletionProtectionEnabled: false }), 'us-east-1')).toBe(
      false
    );
    expect(extractAnyDeletionProtection(base({}), 'us-east-1')).toBeUndefined();
  });

  it('prefers the local replica table class over the legacy top-level one', () => {
    const props = { ...base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }), TableClass: 'STANDARD' };
    expect(extractLocalTableClass(props, 'us-east-1')).toBe('STANDARD_INFREQUENT_ACCESS');
    expect(extractLocalTableClass({ TableClass: 'STANDARD' }, 'us-east-1')).toBe('STANDARD');
  });
});

describe('DynamoDB GlobalTable replica settings (go-to-k/cdkd#5355)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    regionalSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    vi.restoreAllMocks();
    mockSend.mockImplementation(async () => activeTable());
    regionalTable(false);
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('create', () => {
    it('sends the local replica KMS key and table class on CreateTable', async () => {
      const props = {
        ...base(
          {
            SSESpecification: { KMSMasterKeyId: LOCAL_KEY },
            TableClass: 'STANDARD_INFREQUENT_ACCESS',
          },
          null
        ),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      };
      mockSend.mockImplementation(async () => activeTable([]));

      await provider.create('T', RESOURCE_TYPE, props);

      const input = sent(mockSend, CreateTableCommand)[0]!;
      expect(input['SSESpecification']).toEqual({
        Enabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: LOCAL_KEY,
      });
      expect(input['TableClass']).toBe('STANDARD_INFREQUENT_ACCESS');
    });

    it('reads a string "false" SSEEnabled as false', async () => {
      const props = { ...base({}, null), SSESpecification: { SSEEnabled: 'false' } };
      mockSend.mockImplementation(async () => activeTable([]));

      await provider.create('T', RESOURCE_TYPE, props);

      expect(sent(mockSend, CreateTableCommand)[0]!['SSESpecification']).toEqual({
        Enabled: false,
      });
    });

    it('sends a cross-region replica KMS key and table class on the replica Create', async () => {
      const props = {
        ...base(
          {},
          {
            SSESpecification: { KMSMasterKeyId: REMOTE_KEY },
            TableClass: 'STANDARD_INFREQUENT_ACCESS',
          }
        ),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      };

      await provider.create('T', RESOURCE_TYPE, props);

      expect(replicaAction('Create')).toEqual({
        RegionName: 'eu-west-1',
        KMSMasterKeyId: REMOTE_KEY,
        TableClassOverride: 'STANDARD_INFREQUENT_ACCESS',
      });
    });

    it("protects a cross-region replica on the replica's own table, in its region", async () => {
      await provider.create('T', RESOURCE_TYPE, base({}, { DeletionProtectionEnabled: true }));

      expect(sent(regionalSend, UpdateTableCommand)).toEqual([
        { TableName: TABLE, DeletionProtectionEnabled: true },
      ]);
      // Never through the source table, which would protect the LOCAL table.
      expect(
        sent(mockSend, UpdateTableCommand).some((i) => i['DeletionProtectionEnabled'] !== undefined)
      ).toBe(false);
    });

    it('refuses an SSEEnabled that is not a boolean before CreateTable', async () => {
      await expect(
        provider.create('T', RESOURCE_TYPE, { ...base({}, null), SSESpecification: { SSEEnabled: 'yes' } })
      ).rejects.toThrow(/SSEEnabled must be a boolean/);
      expect(sent(mockSend, CreateTableCommand)).toEqual([]);
    });

    it("protects the local table for a template string 'true'", async () => {
      mockSend.mockImplementation(async () => activeTable([]));
      await provider.create('T', RESOURCE_TYPE, base({ DeletionProtectionEnabled: 'true' }, null));

      expect(sent(mockSend, CreateTableCommand)[0]!['DeletionProtectionEnabled']).toBe(true);
    });

    it('does not flip a declared-protected replica AWS never protected in the cleanup', async () => {
      const ttlError = new Error('ttl refused');
      let dropped = false;
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === 'UpdateTimeToLiveCommand') throw ttlError;
        if (command.input['ReplicaUpdates']?.[0]?.Delete) dropped = true;
        return activeTable(dropped ? [] : ['eu-west-1']);
      });
      // The protection write itself is refused, so AWS never holds it.
      regionalTable(false, () => Object.assign(new Error('busy'), { name: 'ResourceInUseException' }));
      const props = {
        ...base({}, { DeletionProtectionEnabled: true }),
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      };

      await expect(provider.create('T', RESOURCE_TYPE, props)).rejects.toThrow();

      // One refused write (addReplica's), no flip-off, and the drop still ran.
      expect(sent(regionalSend, UpdateTableCommand)).toHaveLength(1);
      expect(dropped).toBe(true);
    });

    it('sends nothing for an unprotected cross-region replica', async () => {
      await provider.create('T', RESOURCE_TYPE, base({}, { DeletionProtectionEnabled: false }));

      expect(regionalDpeWrites()).toEqual([]);
    });

    it('unprotects a replica it protected before dropping it in the partial-create cleanup', async () => {
      const ttlError = new Error('ttl refused');
      let dropped = false;
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === 'UpdateTimeToLiveCommand') throw ttlError;
        if (command.input['ReplicaUpdates']?.[0]?.Delete) dropped = true;
        return activeTable(dropped ? [] : ['eu-west-1']);
      });
      const props = {
        ...base({}, { DeletionProtectionEnabled: true }),
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      };

      await expect(provider.create('T', RESOURCE_TYPE, props)).rejects.toThrow();

      expect(regionalDpeWrites()).toEqual([true, false]);
      const dropIndex = mockSend.mock.calls.findIndex(
        (c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete
      );
      expect(dropIndex).toBeGreaterThan(-1);
      // The flip-off precedes the drop.
      expect(regionalSend.mock.invocationCallOrder[1]!).toBeLessThan(
        mockSend.mock.invocationCallOrder[dropIndex]!
      );
    });

    it('stops the partial-create cleanup on a Ctrl-C during the replica unprotect', async () => {
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === 'UpdateTimeToLiveCommand') throw new Error('ttl refused');
        return activeTable();
      });
      // Write 1 is addReplica's protect; the cleanup's flip-off (write 2) is
      // interrupted in its settle wait.
      let writes = 0;
      regionalSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === UpdateTableCommand.name) {
          writes++;
          return {};
        }
        if (writes >= 2) throw new InterruptedWaitError('replica settle');
        return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: true } };
      });
      const props = {
        ...base({}, { DeletionProtectionEnabled: true }),
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      };

      await expect(provider.create('T', RESOURCE_TYPE, props)).rejects.toThrow(/ttl refused/);

      expect(regionalDpeWrites()).toEqual([true, false]);
      // Neither the replica drop nor the DeleteTable after it runs.
      expect(
        mockSend.mock.calls.some((c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete)
      ).toBe(false);
      expect(sent(mockSend, DeleteTableCommand)).toEqual([]);
    });

    it('warns, and keeps encryption on, for a non-boolean SSEEnabled on a state replay', async () => {
      await provider.create(
        'T',
        RESOURCE_TYPE,
        { ...base({}, null), SSESpecification: { SSEEnabled: 'yes', SSEType: 'KMS' } },
        { replayingState: true }
      );

      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("Encryption is enabled, the block's default")
        )
      ).toBe(true);
      expect(sent(mockSend, CreateTableCommand)[0]!['SSESpecification']).toMatchObject({
        Enabled: true,
      });
    });
  });

  describe('update', () => {
    const update = (next: Record<string, unknown>, previous: Record<string, unknown>) =>
      provider.update('T', TABLE, RESOURCE_TYPE, next, previous);

    // A failed case must not leave fake timers or a latched Ctrl-C behind.
    afterEach(() => {
      vi.useRealTimers();
      disarmInterruptWatchForTests();
      resetInterruptWatchLatch();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });

    /** Fire the SIGINT listeners the interrupt watches added (a real Ctrl-C). */
    const ctrlC = (baseline: ReturnType<typeof process.listeners>) => {
      for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
        (l as unknown as () => void)();
      }
    };

    it('changes the local table class read from the local replica', async () => {
      await update(base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }), base({}));

      expect(flatUpdate()?.['TableClass']).toBe('STANDARD_INFREQUENT_ACCESS');
    });

    it('resets a removed local table class to STANDARD, as CloudFormation does', async () => {
      await update(base({}), base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }));

      expect(flatUpdate()?.['TableClass']).toBe('STANDARD');
    });

    it('sends nothing when the removed table class was already STANDARD', async () => {
      await update(base({}), base({ TableClass: 'STANDARD' }));

      expect(flatUpdate()).toBeUndefined();
    });

    it("resets a cross-region replica's removed table class to STANDARD", async () => {
      await update(base({}, {}), base({}, { TableClass: 'STANDARD_INFREQUENT_ACCESS' }));

      expect(replicaAction('Update')).toEqual({
        RegionName: 'eu-west-1',
        TableClassOverride: 'STANDARD',
      });
    });

    it('re-sends SSE with the local key when only the local replica key changed', async () => {
      mockSend.mockImplementation(async () => activeTable([]));
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      await update(
        { ...base({ SSESpecification: { KMSMasterKeyId: LOCAL_KEY } }, null), SSESpecification: sse },
        { ...base({ SSESpecification: { KMSMasterKeyId: 'old' } }, null), SSESpecification: sse }
      );

      expect(flatUpdate()?.['SSESpecification']).toEqual({
        Enabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: LOCAL_KEY,
      });
    });

    it("sets a changed local key on a table with replicas through every region's ReplicaUpdates entry", async () => {
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      const remote = { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } };
      await update(
        { ...base({ SSESpecification: { KMSMasterKeyId: LOCAL_KEY } }, remote), SSESpecification: sse },
        { ...base({ SSESpecification: { KMSMasterKeyId: 'old' } }, remote), SSESpecification: sse }
      );

      // DynamoDB refuses a key through SSESpecification on a table with replicas.
      expect(sent(mockSend, UpdateTableCommand).some((i) => i['SSESpecification'])).toBe(false);
      expect(keysCall()).toEqual([
        { Update: { RegionName: 'us-east-1', KMSMasterKeyId: LOCAL_KEY } },
        { Update: { RegionName: 'eu-west-1', KMSMasterKeyId: REMOTE_KEY } },
      ]);
    });

    it('sends the table class and the encryption change each in a call of its own', async () => {
      await update(base({}, null), {
        ...base({ TableClass: 'STANDARD_INFREQUENT_ACCESS', DeletionProtectionEnabled: true }, null),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      });

      const calls = sent(mockSend, UpdateTableCommand).filter(
        (i) =>
          i['TableClass'] !== undefined ||
          i['SSESpecification'] !== undefined ||
          i['DeletionProtectionEnabled'] !== undefined
      );
      expect(calls.map((i) => Object.keys(i).filter((k) => k !== 'TableName').sort())).toEqual([
        ['DeletionProtectionEnabled'],
        ['TableClass'],
        ['SSESpecification'],
      ]);
    });

    it('fails the update when a template-side key change is refused', async () => {
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['ReplicaUpdates']?.length > 1) {
          throw Object.assign(new Error('key refused'), { name: 'ValidationException' });
        }
        return activeTable(['eu-west-1'], { table: LIVE_LOCAL_KEY });
      });
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      await expect(
        update(
          { ...base({}, { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }), SSESpecification: sse },
          { ...base({}, { SSESpecification: { KMSMasterKeyId: 'old' } }), SSESpecification: sse }
        )
      ).rejects.toThrow(/key refused/);
    });

    it('sends the held-back local key through SSESpecification when the update drops every replica', async () => {
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      let dropped = false;
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['ReplicaUpdates']?.[0]?.Delete) dropped = true;
        return activeTable(dropped ? [] : ['eu-west-1']);
      });
      await update(
        { ...base({ SSESpecification: { KMSMasterKeyId: LOCAL_KEY } }, null), SSESpecification: sse },
        { ...base({ SSESpecification: { KMSMasterKeyId: 'old' } }, {}), SSESpecification: sse }
      );

      expect(flatUpdate()?.['SSESpecification']).toEqual({
        Enabled: true,
        SSEType: 'KMS',
        KMSMasterKeyId: LOCAL_KEY,
      });
      const deleteAt = mockSend.mock.calls.findIndex(
        (c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete
      );
      const sseAt = mockSend.mock.calls.findIndex((c) => (c[0] as Sent).input['SSESpecification']);
      expect(deleteAt).toBeGreaterThan(-1);
      expect(sseAt).toBeGreaterThan(deleteAt);
    });

    it('resets a removed SSESpecification to the AWS owned key, as CloudFormation does', async () => {
      await update(base({}), {
        ...base({ SSESpecification: { KMSMasterKeyId: LOCAL_KEY } }),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      });

      expect(flatUpdate()?.['SSESpecification']).toEqual({ Enabled: false });
    });

    it('sends no reset when the removed block had encryption off', async () => {
      await update(base({}), { ...base({}), SSESpecification: { SSEEnabled: false } });

      expect(flatUpdate()).toBeUndefined();
    });

    it("sends a cross-region replica's changed KMS key and table class", async () => {
      mockSend.mockImplementation(async () => activeTable(['eu-west-1'], { table: LIVE_LOCAL_KEY }));
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      await update(
        {
          ...base(
            {},
            {
              SSESpecification: { KMSMasterKeyId: REMOTE_KEY },
              TableClass: 'STANDARD_INFREQUENT_ACCESS',
            }
          ),
          SSESpecification: sse,
        },
        { ...base({}, { SSESpecification: { KMSMasterKeyId: 'old' } }), SSESpecification: sse }
      );

      expect(replicaAction('Update')).toEqual({
        RegionName: 'eu-west-1',
        TableClassOverride: 'STANDARD_INFREQUENT_ACCESS',
      });
      // The undeclared local key is the one AWS reports.
      expect(keysCall()).toEqual([
        { Update: { RegionName: 'us-east-1', KMSMasterKeyId: LOCAL_KEY } },
        { Update: { RegionName: 'eu-west-1', KMSMasterKeyId: REMOTE_KEY } },
      ]);
    });

    it('does not re-send an unchanged replica key on an unrelated replica edit', async () => {
      mockSend.mockImplementation(async () =>
        activeTable(['eu-west-1'], { replica: { KMSMasterKeyId: REMOTE_KEY } })
      );
      const remote = { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } };
      await update(
        base({}, { ...remote, Tags: [{ Key: 'a', Value: 'b' }] }),
        base({}, remote)
      );

      expect(replicaAction('Update')).toBeUndefined();
    });

    it("converges a replica deployed before the fix: unchanged class and key AWS does not hold", async () => {
      const remote = {
        SSESpecification: { KMSMasterKeyId: REMOTE_KEY },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      };
      mockSend.mockImplementation(async () => activeTable(['eu-west-1'], { table: LIVE_LOCAL_KEY }));
      const props = { ...base({}, remote), SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } };
      await update({ ...props, Replicas: base({}, { ...remote, Tags: [] })['Replicas'] }, props);

      expect(replicaAction('Update')).toEqual({
        RegionName: 'eu-west-1',
        TableClassOverride: 'STANDARD_INFREQUENT_ACCESS',
      });
      expect(keysCall()).toEqual([
        { Update: { RegionName: 'us-east-1', KMSMasterKeyId: LOCAL_KEY } },
        { Update: { RegionName: 'eu-west-1', KMSMasterKeyId: REMOTE_KEY } },
      ]);
    });

    it('leaves the keys alone when every region already holds its declared key ARN', async () => {
      mockSend.mockImplementation(async () =>
        activeTable(['eu-west-1'], {
          table: LIVE_LOCAL_KEY,
          replica: { KMSMasterKeyId: REMOTE_KEY },
        })
      );
      const props = {
        ...base(
          { SSESpecification: { KMSMasterKeyId: LOCAL_KEY } },
          { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }
        ),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      };
      await update({ ...props, TableClass: undefined }, props);

      expect(keysCall()).toBeUndefined();
    });

    it('reports, and does not fail the deploy on, a refused key convergence', async () => {
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['ReplicaUpdates']?.length > 1) {
          throw Object.assign(new Error('nope'), { name: 'ValidationException' });
        }
        return activeTable(['eu-west-1'], { table: LIVE_LOCAL_KEY });
      });
      const props = {
        ...base({}, { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      };
      await expect(update({ ...props, TableClass: undefined }, props)).resolves.toBeDefined();

      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('does not hold its declared KMS keys'))).toBe(
        true
      );
    });

    it('converges the local table class and key AWS does not hold on an unchanged template', async () => {
      const local = {
        SSESpecification: { KMSMasterKeyId: LOCAL_KEY },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      };
      const props = { ...base(local, null), SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } };
      mockSend.mockImplementation(async () => activeTable([]));
      await update({ ...props, Tags: undefined }, props);

      const calls = sent(mockSend, UpdateTableCommand);
      expect(calls).toContainEqual({ TableName: TABLE, TableClass: 'STANDARD_INFREQUENT_ACCESS' });
      expect(calls).toContainEqual({
        TableName: TABLE,
        SSESpecification: { Enabled: true, SSEType: 'KMS', KMSMasterKeyId: LOCAL_KEY },
      });
    });

    it('leaves the local table alone when AWS already holds the declared class and key', async () => {
      const local = {
        SSESpecification: { KMSMasterKeyId: LOCAL_KEY },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      };
      const props = { ...base(local, null), SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } };
      mockSend.mockImplementation(async () =>
        activeTable([], {
          table: {
            TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
            SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: LOCAL_KEY },
          },
        })
      );
      await update(props, props);

      expect(flatUpdate()).toBeUndefined();
    });

    it('moves every region to the AWS managed key through SSESpecification when the keys are removed', async () => {
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      await update(
        { ...base({}, {}), SSESpecification: sse },
        {
          ...base(
            { SSESpecification: { KMSMasterKeyId: LOCAL_KEY } },
            { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }
          ),
          SSESpecification: sse,
        }
      );

      // DynamoDB moves the replicas with the table (measured), and refuses a
      // key change for one replica alone.
      expect(flatUpdate()).toEqual({
        TableName: TABLE,
        SSESpecification: { Enabled: true, SSEType: 'KMS' },
      });
      expect(keysCall()).toBeUndefined();
    });

    it('turns protection off when the template says false and AWS holds true', async () => {
      regionalTable(true);
      const props = base({}, { DeletionProtectionEnabled: false });
      await update(props, props);

      expect(regionalDpeWrites()).toEqual([false]);
    });

    it('leaves a replica whose protection value is not a boolean alone, and says so', async () => {
      await update(
        base({}, { DeletionProtectionEnabled: 'yes' }),
        base({}, { DeletionProtectionEnabled: true })
      );

      expect(regionalDpeWrites()).toEqual([]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('must be a boolean'))).toBe(true);
    });

    it('refuses a changed SSEEnabled that is not a boolean before any write', async () => {
      await expect(
        update({ ...base({}), SSESpecification: { SSEEnabled: 'yes' } }, base({}))
      ).rejects.toThrow(/SSEEnabled must be a boolean/);
      expect(sent(mockSend, UpdateTableCommand)).toEqual([]);
    });

    it('reports, and does not fail the deploy on, a refused convergence', async () => {
      const remote = { TableClass: 'STANDARD_INFREQUENT_ACCESS' };
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['ReplicaUpdates']?.[0]?.Update) {
          throw Object.assign(new Error('nope'), { name: 'ValidationException' });
        }
        return activeTable();
      });
      const props = base({}, remote);
      await expect(update({ ...props, TableClass: undefined }, props)).resolves.toBeDefined();

      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('that updates this table tries again'))).toBe(
        true
      );
    });

    it("does not converge a replica key on a table that is not on KMS", async () => {
      const props = base({}, { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } });
      await update(props, props);

      expect(replicaAction('Update')).toBeUndefined();
    });

    it("reads a replica without its own class summary as the source table's class", async () => {
      mockSend.mockImplementation(async () =>
        activeTable(['eu-west-1'], {
          table: { TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' } },
        })
      );
      const props = base(
        { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
        { TableClass: 'STANDARD_INFREQUENT_ACCESS' }
      );
      await update(props, props);

      expect(replicaAction('Update')).toBeUndefined();
      expect(flatUpdate()).toBeUndefined();
    });

    it('names a protected cross-region replica in the immutable-property refusal', async () => {
      const previous = base({}, { DeletionProtectionEnabled: true });
      const next = { ...previous, KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }] };

      await expect(update(next, previous)).rejects.toThrow(
        /DeletionProtectionEnabled: true for the eu-west-1 replica/
      );
    });

    it('protects a cross-region replica whose template turned protection on', async () => {
      await update(base({}, { DeletionProtectionEnabled: true }), base({}));

      expect(regionalDpeWrites()).toEqual([true]);
    });

    it('turns protection off, with a warning, when the replica member is removed', async () => {
      await update(base({}), base({}, { DeletionProtectionEnabled: true }));

      expect(regionalDpeWrites()).toEqual([false]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('eu-west-1 replica'))).toBe(true);
    });

    it('turns protection off without a warning when the template says false', async () => {
      await update(
        base({}, { DeletionProtectionEnabled: false }),
        base({}, { DeletionProtectionEnabled: true })
      );

      expect(regionalDpeWrites()).toEqual([false]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('eu-west-1 replica'))).toBe(
        false
      );
    });

    it('converges an unchanged true that AWS does not hold (a replica deployed before the fix)', async () => {
      const props = base({}, { DeletionProtectionEnabled: true });
      await update({ ...props, TableClass: undefined, BillingMode: 'PAY_PER_REQUEST' }, props);

      // Read first: the template did not change, so only AWS can say it is off.
      expect((regionalSend.mock.calls[0]![0] as Sent).constructor.name).toBe(
        DescribeTableCommand.name
      );
      expect(regionalDpeWrites()).toEqual([true]);
    });

    it('leaves an unchanged true alone when AWS already holds it', async () => {
      regionalTable(true);
      const props = base({}, { DeletionProtectionEnabled: true });
      await update(props, props);

      expect(regionalDpeWrites()).toEqual([]);
    });

    it('protects a replica the update adds', async () => {
      mockSend.mockImplementation(async () => activeTable());
      await update(base({}, { DeletionProtectionEnabled: true }), base({}, null));

      expect(replicaAction('Create')).toEqual({ RegionName: 'eu-west-1' });
      expect(regionalDpeWrites()).toEqual([true]);
    });

    describe('protection writes wait for the global table to settle', () => {
      const inUse = () =>
        Object.assign(new Error('The resource which you are attempting to change is in use.'), {
          name: 'ResourceInUseException',
        });

      it('waits out a replica class change before turning the replica guard off', async () => {
        vi.useFakeTimers();
        // After the class change the source reads UPDATING (its replica
        // already ACTIVE) for two polls; a protection write meanwhile is refused.
        let busy = 0;
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['ReplicaUpdates']?.[0]?.Update?.TableClassOverride) {
            busy = 2;
            return {};
          }
          if (command.constructor.name === DescribeTableCommand.name && busy > 0) {
            busy--;
            return { Table: { ...activeTable().Table, TableStatus: 'UPDATING' } };
          }
          return activeTable();
        });
        let dpe = true;
        regionalSend.mockImplementation(async (command: Sent) => {
          if (command.constructor.name === UpdateTableCommand.name) {
            if (busy > 0) throw inUse();
            dpe = command.input['DeletionProtectionEnabled'] as boolean;
            return {};
          }
          return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: dpe } };
        });
        const done = update(
          base({}, { TableClass: 'STANDARD_INFREQUENT_ACCESS', DeletionProtectionEnabled: false }),
          base({}, { DeletionProtectionEnabled: true })
        );
        await vi.runAllTimersAsync();
        await done;

        expect(regionalDpeWrites()).toEqual([false]);
      });

      it("waits for the replica's own table to read ACTIVE before writing its guard", async () => {
        vi.useFakeTimers();
        // The replica table is UPDATING until it has been read once.
        let regionalBusy = 1;
        regionalSend.mockImplementation(async (command: Sent) => {
          if (command.constructor.name === UpdateTableCommand.name) {
            if (regionalBusy > 0) throw inUse();
            return {};
          }
          const status = regionalBusy > 0 ? 'UPDATING' : 'ACTIVE';
          if (regionalBusy > 0) regionalBusy--;
          return { Table: { TableName: TABLE, TableStatus: status, DeletionProtectionEnabled: false } };
        });
        const done = update(
          base({}, { DeletionProtectionEnabled: false }),
          base({}, { DeletionProtectionEnabled: true })
        );
        await vi.runAllTimersAsync();
        await done;

        expect(regionalDpeWrites()).toEqual([false]);
      });
    });

    it('leaves a replica alone, without failing the deploy, when its protection cannot be read', async () => {
      regionalSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === DescribeTableCommand.name) {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return {};
      });
      const props = base({}, { DeletionProtectionEnabled: true });

      await expect(update({ ...props, TableClass: undefined }, props)).resolves.toBeDefined();
      expect(sent(regionalSend, DescribeTableCommand)).not.toEqual([]);
      expect(regionalDpeWrites()).toEqual([]);
    });

    it('stops on a Ctrl-C during the convergence wait instead of reporting it', async () => {
      vi.useFakeTimers();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      const baseline = process.listeners('SIGINT');
      let converging = false;
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['ReplicaUpdates']?.[0]?.Update) {
          converging = true;
          return {};
        }
        if (converging && command.constructor.name === DescribeTableCommand.name) {
          // A real Ctrl-C while the table is still settling.
          ctrlC(baseline);
          return activeTable(['eu-west-1'], { replica: { ReplicaStatus: 'UPDATING' } });
        }
        return activeTable();
      });
      const props = base({}, { TableClass: 'STANDARD_INFREQUENT_ACCESS' });

      const settled = update({ ...props, TableClass: undefined }, props).then(
        () => undefined,
        (e: unknown) => e
      );
      await vi.runAllTimersAsync();
      const error = await settled;

      expect(isInterruptedWaitError(error)).toBe(true);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('does not hold its declared'))).toBe(
        false
      );
    });

    it('refuses a non-boolean SSEEnabled when only the local replica key changed', async () => {
      const sse = { SSEEnabled: 'yes', SSEType: 'KMS' };
      await expect(
        update(
          { ...base({ SSESpecification: { KMSMasterKeyId: LOCAL_KEY } }), SSESpecification: sse },
          { ...base({}), SSESpecification: sse }
        )
      ).rejects.toThrow(/SSEEnabled must be a boolean/);
      expect(sent(mockSend, UpdateTableCommand)).toEqual([]);
    });

    it('warns, and does not refuse, a non-boolean SSEEnabled on a state replay', async () => {
      await provider.update(
        'T',
        TABLE,
        RESOURCE_TYPE,
        { ...base({}), SSESpecification: { SSEEnabled: 'yes', SSEType: 'KMS' } },
        base({}),
        { replayingState: true }
      );

      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('Encryption is treated as enabled'))
      ).toBe(true);
    });

    describe('every-region key pass (applyReplicaKeys)', () => {
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      const remote = (key: string) => ({ SSESpecification: { KMSMasterKeyId: key } });
      // The key pass's own read, refused.
      const failKeyRead = () =>
        vi
          .spyOn(provider as unknown as Record<string, () => Promise<unknown>>, 'readLiveKeys')
          .mockRejectedValue(Object.assign(new Error('read denied'), { name: 'AccessDeniedException' }));
      const liveBoth = (local = LOCAL_KEY, replica = REMOTE_KEY) =>
        activeTable(['eu-west-1'], {
          table: { SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: local } },
          replica: { KMSMasterKeyId: replica },
        });

      it('fails the update when a template-side key change leaves a region with no key', async () => {
        // Neither the template nor AWS names the local key.
        mockSend.mockImplementation(async () => activeTable(['eu-west-1']));
        await expect(
          update(
            { ...base({}, remote(REMOTE_KEY)), SSESpecification: sse },
            { ...base({}, remote('old')), SSESpecification: sse }
          )
        ).rejects.toThrow(/no key is declared or reported for us-east-1/);
        expect(keysCall()).toBeUndefined();
      });

      it('warns, and does not fail, when a correction-only pass finds a region with no key', async () => {
        mockSend.mockImplementation(async () => activeTable(['eu-west-1']));
        const props = { ...base({}, remote(REMOTE_KEY)), SSESpecification: sse };
        await expect(update({ ...props, TableClass: undefined }, props)).resolves.toBeDefined();
        expect(keysCall()).toBeUndefined();
        expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('were not changed'))).toBe(true);
      });

      it('fails the update when the keys cannot be read for a template-side change', async () => {
        mockSend.mockImplementation(async () => liveBoth());
        failKeyRead();
        await expect(
          update(
            { ...base({}, remote(REMOTE_KEY)), SSESpecification: sse },
            { ...base({}, remote('old')), SSESpecification: sse }
          )
        ).rejects.toThrow(/read denied/);
      });

      it('skips the pass, without failing, when the keys cannot be read for a correction', async () => {
        mockSend.mockImplementation(async () => liveBoth(LOCAL_KEY, 'arn:aws:kms:eu-west-1:123456789012:key/other'));
        failKeyRead();
        const props = { ...base({}, remote(REMOTE_KEY)), SSESpecification: sse };
        await expect(update({ ...props, TableClass: undefined }, props)).resolves.toBeDefined();
        expect(keysCall()).toBeUndefined();
      });

      it('does not re-send the key of a replica the update adds', async () => {
        mockSend.mockImplementation(async () => liveBoth());
        await update(
          { ...base(remote(LOCAL_KEY), remote(REMOTE_KEY)), SSESpecification: sse },
          { ...base(remote(LOCAL_KEY), null), SSESpecification: sse }
        );
        expect(replicaAction('Create')).toMatchObject({ KMSMasterKeyId: REMOTE_KEY });
        expect(keysCall()).toBeUndefined();
      });

      it('does not re-send the local key when the table had no replica to defer it for', async () => {
        let created = false;
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['ReplicaUpdates']?.[0]?.Create) created = true;
          return created ? liveBoth() : activeTable([]);
        });
        await update(
          { ...base(remote(LOCAL_KEY), remote(REMOTE_KEY)), SSESpecification: sse },
          { ...base(remote('old'), null), SSESpecification: sse }
        );
        expect(flatUpdate()?.['SSESpecification']).toMatchObject({ KMSMasterKeyId: LOCAL_KEY });
        expect(keysCall()).toBeUndefined();
      });

      it('sends nothing when only the SSE block spelling changed and AWS holds the keys', async () => {
        mockSend.mockImplementation(async () => liveBoth());
        await update(
          { ...base(remote(LOCAL_KEY), remote(REMOTE_KEY)), SSESpecification: sse },
          { ...base(remote(LOCAL_KEY), remote(REMOTE_KEY)), SSESpecification: { SSEEnabled: true } }
        );
        expect(sent(mockSend, UpdateTableCommand).some((i) => i['SSESpecification'])).toBe(false);
        expect(keysCall()).toBeUndefined();
      });

      it('treats a local key AWS alone disagrees with as a best-effort correction', async () => {
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['ReplicaUpdates']?.length > 1) {
            throw Object.assign(new Error('nope'), { name: 'ValidationException' });
          }
          return liveBoth('arn:aws:kms:us-east-1:123456789012:key/managed');
        });
        const props = { ...base(remote(LOCAL_KEY), remote(REMOTE_KEY)), SSESpecification: sse };
        await expect(update({ ...props, TableClass: undefined }, props)).resolves.toBeDefined();
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('does not hold its declared KMS keys'))
        ).toBe(true);
      });

      it("reads the local key from SSEDescription even when Replicas lists the table's own region", async () => {
        mockSend.mockImplementation(async () => ({
          Table: {
            ...liveBoth().Table,
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE', KMSMasterKeyId: 'bogus' },
              { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE', KMSMasterKeyId: 'old' },
            ],
          },
        }));
        await update(
          { ...base({}, remote(REMOTE_KEY)), SSESpecification: sse },
          { ...base({}, remote('old')), SSESpecification: sse }
        );
        expect(keysCall()).toEqual([
          { Update: { RegionName: 'us-east-1', KMSMasterKeyId: LOCAL_KEY } },
          { Update: { RegionName: 'eu-west-1', KMSMasterKeyId: REMOTE_KEY } },
        ]);
      });
    });

    it('gives up, naming the table, when the global table never settles', async () => {
      vi.useFakeTimers();
      let classSent = false;
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['TableClass']) classSent = true;
        return classSent
          ? activeTable(['eu-west-1'], { replica: { ReplicaStatus: 'UPDATING' } })
          : activeTable(['eu-west-1']);
      });
      const settled = update(base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }), base({})).then(
        () => undefined,
        (e: unknown) => e
      );
      await vi.runAllTimersAsync();
      const error = await settled;
      vi.useRealTimers();

      expect(String(error)).toMatch(/and its replicas did not settle within \d+ polls/);
    });

    describe('local table corrections', () => {
      const throttled = () =>
        Object.assign(new Error('encryption changes are limited'), {
          name: 'LimitExceededException',
        });

      it('reports, and does not fail the deploy on, a refused class correction', async () => {
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['TableClass']) throw throttled();
          return activeTable([]);
        });
        const props = base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }, null);
        await expect(update({ ...props, Tags: undefined }, props)).resolves.toBeDefined();
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('does not hold its declared TableClass'))
        ).toBe(true);
      });

      it('stops on a Ctrl-C while a class correction settles, instead of reporting it', async () => {
        vi.useFakeTimers();
        interruptWatchTestSeam.commandOwnsInterrupts = () => true;
        const baseline = process.listeners('SIGINT');
        let classSent = false;
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['TableClass']) {
            classSent = true;
            return {};
          }
          if (classSent && command.constructor.name === DescribeTableCommand.name) {
            ctrlC(baseline);
            return { Table: { ...activeTable([]).Table, TableStatus: 'UPDATING' } };
          }
          return activeTable([]);
        });
        const props = base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }, null);
        const settled = update({ ...props, Tags: undefined }, props).then(
          () => undefined,
          (e: unknown) => e
        );
        await vi.runAllTimersAsync();

        expect(isInterruptedWaitError(await settled)).toBe(true);
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('does not hold its declared TableClass'))
        ).toBe(false);
      });

      it('fails the update on a refused template-side class change', async () => {
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['TableClass']) throw throttled();
          return activeTable([]);
        });
        await expect(
          update(base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }, null), base({}, null))
        ).rejects.toThrow(/encryption changes are limited/);
      });

      it('reports, and does not fail the deploy on, a refused key correction', async () => {
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['SSESpecification']) throw throttled();
          return activeTable([]);
        });
        const props = {
          ...base({ SSESpecification: { KMSMasterKeyId: LOCAL_KEY } }, null),
          SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
        };
        await expect(update({ ...props, Tags: undefined }, props)).resolves.toBeDefined();
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('does not hold its declared encryption'))
        ).toBe(true);
      });

      it('fails the update on a refused template-side encryption change', async () => {
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['SSESpecification']) throw throttled();
          return activeTable([]);
        });
        await expect(
          update(base({}, null), {
            ...base({}, null),
            SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
          })
        ).rejects.toThrow(/encryption changes are limited/);
      });
    });

    describe('local key dropped while a replica keeps its customer managed key', () => {
      const MANAGED_EAST = 'arn:aws:kms:us-east-1:123456789012:key/managed';
      const MANAGED_WEST = 'arn:aws:kms:eu-west-1:123456789012:key/managed';
      const sse = { SSEEnabled: true, SSEType: 'KMS' };
      const next = { ...base({}, { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }), SSESpecification: sse };
      const previous = {
        ...base(
          { SSESpecification: { KMSMasterKeyId: LOCAL_KEY } },
          { SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }
        ),
        SSESpecification: sse,
      };
      // After the keyless SSESpecification, every region reads the AWS managed key.
      const movedToManaged = () =>
        activeTable(['eu-west-1'], {
          table: { SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: MANAGED_EAST } },
          replica: { KMSMasterKeyId: MANAGED_WEST },
        });

      it('puts the replica back on its declared key in the every-region call', async () => {
        mockSend.mockImplementation(async () => movedToManaged());
        await update(next, previous);

        expect(flatUpdate()).toEqual({
          TableName: TABLE,
          SSESpecification: { Enabled: true, SSEType: 'KMS' },
        });
        expect(keysCall()).toEqual([
          { Update: { RegionName: 'us-east-1', KMSMasterKeyId: MANAGED_EAST } },
          { Update: { RegionName: 'eu-west-1', KMSMasterKeyId: REMOTE_KEY } },
        ]);
      });

      it('fails the update, not just warns, when that call is refused', async () => {
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['ReplicaUpdates']?.length > 1) {
            throw Object.assign(new Error('mixed keys refused'), { name: 'ValidationException' });
          }
          return movedToManaged();
        });
        await expect(update(next, previous)).rejects.toThrow(/mixed keys refused/);
      });

      it('fails the update when the keys cannot be read after that move', async () => {
        mockSend.mockImplementation(async () => movedToManaged());
        vi.spyOn(provider as unknown as Record<string, () => Promise<unknown>>, 'readLiveKeys').mockRejectedValue(
          Object.assign(new Error('read denied'), { name: 'AccessDeniedException' })
        );
        await expect(update(next, previous)).rejects.toThrow(/read denied/);
      });
    });

    it('runs the key pass only once the whole table has settled after a class correction', async () => {
      vi.useFakeTimers();
      let classSent = false;
      let pollsAfterClass = 0;
      let pollsAtKeys: number | undefined;
      const live = (table: Record<string, unknown> = {}) =>
        activeTable(['eu-west-1'], {
          table: { ...LIVE_LOCAL_KEY, ...table },
          replica: { KMSMasterKeyId: 'arn:aws:kms:eu-west-1:123456789012:key/other' },
        });
      mockSend.mockImplementation(async (command: Sent) => {
        if (command.input['ReplicaUpdates']?.[0]?.Update?.TableClassOverride) {
          classSent = true;
          return {};
        }
        if (command.input['ReplicaUpdates']?.length > 1) {
          pollsAtKeys = pollsAfterClass;
          return {};
        }
        if (classSent && command.constructor.name === DescribeTableCommand.name) {
          // The replica reads ACTIVE at once; the table's encryption does not.
          if (++pollsAfterClass === 1) return live({ SSEDescription: { Status: 'UPDATING' } });
        }
        return live();
      });
      const props = {
        ...base({}, { TableClass: 'STANDARD_INFREQUENT_ACCESS', SSESpecification: { KMSMasterKeyId: REMOTE_KEY } }),
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
      };
      const done = update({ ...props, TableClass: undefined }, props);
      await vi.runAllTimersAsync();
      await done;
      vi.useRealTimers();

      // Poll 1 is UPDATING, poll 2 settles, poll 3 is the key pass's own read.
      expect(pollsAtKeys).toBe(3);
    });

    it.each([
      ['its encryption', { SSEDescription: { Status: 'UPDATING' } }, {}],
      ['a replica', {}, { ReplicaStatus: 'UPDATING' }],
      ['the table', { TableStatus: 'UPDATING' }, {}],
    ])(
      'sends the encryption change only once %s has settled after the class change',
      async (_what, tableLive, replicaLive) => {
        vi.useFakeTimers();
        let classSent = false;
        let pollsAfterClass = 0;
        let pollsAtSse: number | undefined;
        mockSend.mockImplementation(async (command: Sent) => {
          if (command.input['TableClass']) {
            classSent = true;
            return {};
          }
          if (command.input['SSESpecification']) {
            pollsAtSse = pollsAfterClass;
            return {};
          }
          if (classSent && command.constructor.name === DescribeTableCommand.name) {
            pollsAfterClass++;
            if (pollsAfterClass === 1) {
              return activeTable(['eu-west-1'], { table: tableLive, replica: replicaLive });
            }
          }
          return activeTable(['eu-west-1']);
        });
        const done = update(base({}), {
          ...base({ TableClass: 'STANDARD_INFREQUENT_ACCESS' }),
          SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
        });
        await vi.runAllTimersAsync();
        await done;
        vi.useRealTimers();

        // The UPDATING poll is not taken as settled; the next one is.
        expect(pollsAtSse).toBe(2);
      }
    );
  });

  describe('delete', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Source double: the replica goes on its Delete, the table on DeleteTable. */
    const sourceTable = (opts: { refuseDrop?: Error } = {}) => {
      let replicaGone = false;
      let tableGone = false;
      mockSend.mockImplementation(async (command: Sent) => {
        const name = command.constructor.name;
        if (name === 'UpdateTableCommand' && command.input['ReplicaUpdates']?.[0]?.Delete) {
          if (opts.refuseDrop) throw opts.refuseDrop;
          replicaGone = true;
          return {};
        }
        if (name === DeleteTableCommand.name) {
          tableGone = true;
          return {};
        }
        if (name === DescribeTableCommand.name && tableGone) {
          throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
        }
        return activeTable(replicaGone ? [] : ['eu-west-1']);
      });
    };

    it('turns a protected replica off before dropping it under --remove-protection', async () => {
      sourceTable();
      regionalTable(true);

      await provider.delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true });

      expect(regionalDpeWrites()).toEqual([false]);
      const dropIndex = mockSend.mock.calls.findIndex(
        (c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete
      );
      const flipIndex = regionalSend.mock.calls.findIndex(
        (c) => (c[0] as Sent).constructor.name === UpdateTableCommand.name
      );
      expect(regionalSend.mock.invocationCallOrder[flipIndex]!).toBeLessThan(
        mockSend.mock.invocationCallOrder[dropIndex]!
      );
    });

    it('stops the destroy on a Ctrl-C in the wait before the flip, with nothing turned off', async () => {
      vi.useFakeTimers();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      const baseline = process.listeners('SIGINT');
      try {
        let readReplica = false;
        mockSend.mockImplementation(async (command: Sent) => {
          if (readReplica && command.constructor.name === DescribeTableCommand.name) {
            // Ctrl-C while the table is still settling, before the flip.
            for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
              (l as unknown as () => void)();
            }
            return { Table: { ...activeTable().Table, TableStatus: 'UPDATING' } };
          }
          return activeTable();
        });
        regionalSend.mockImplementation(async (command: Sent) => {
          if (command.constructor.name === UpdateTableCommand.name) return {};
          readReplica = true;
          return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: true } };
        });

        const settled = provider
          .delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true })
          .then(
            () => undefined,
            (e: unknown) => e
          );
        await vi.runAllTimersAsync();

        expect(isInterruptedWaitError(await settled)).toBe(true);
        expect(regionalDpeWrites()).toEqual([]);
        expect(
          mockSend.mock.calls.some((c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete)
        ).toBe(false);
      } finally {
        disarmInterruptWatchForTests();
        resetInterruptWatchLatch();
        delete interruptWatchTestSeam.commandOwnsInterrupts;
      }
    });

    it('does not flip a replica the user left unprotected', async () => {
      sourceTable();

      await provider.delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true });

      expect(regionalDpeWrites()).toEqual([]);
    });

    it('never touches replica protection without --remove-protection', async () => {
      sourceTable();
      regionalTable(true);

      await provider.delete('T', TABLE, RESOURCE_TYPE);

      expect(sent(regionalSend, UpdateTableCommand)).toEqual([]);
    });

    it('stops before the drop, guard restored, when the flip never settles', async () => {
      vi.useFakeTimers();
      sourceTable();
      // The flip is accepted but the replica keeps reading back protected,
      // UPDATING, from then on.
      let flipped = false;
      regionalSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === UpdateTableCommand.name) {
          flipped = true;
          return {};
        }
        return {
          Table: {
            TableName: TABLE,
            TableStatus: flipped ? 'UPDATING' : 'ACTIVE',
            DeletionProtectionEnabled: true,
          },
        };
      });

      const settled = provider
        .delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      await vi.runAllTimersAsync();

      expect(String(await settled)).toContain('did not settle');
      expect(regionalDpeWrites()).toEqual([false, true]);
      expect(
        mockSend.mock.calls.some((c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete)
      ).toBe(false);
    });

    it('says why the replica was not deleted when the guard cannot be put back', async () => {
      vi.useFakeTimers();
      const refusal = Object.assign(new Error('refused'), { name: 'ValidationException' });
      sourceTable({ refuseDrop: refusal });
      regionalTable(true, (n) =>
        n >= 2 ? Object.assign(new Error('denied'), { name: 'AccessDeniedException' }) : undefined
      );

      const settled = provider
        .delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      await vi.runAllTimersAsync();
      await settled;

      const warning = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('LEFT UNPROTECTED'));
      expect(warning).toContain('was not deleted (it could not be dropped)');
      expect(warning).toContain('--deletion-protection-enabled');
    });

    it('puts the guard back, past the re-flip throttle, when the drop is refused', async () => {
      vi.useFakeTimers();
      const refusal = Object.assign(new Error('refused'), { name: 'ValidationException' });
      sourceTable({ refuseDrop: refusal });
      const throttle = Object.assign(new Error('modified within the previous 15000 ms'), {
        name: 'ThrottlingException',
      });
      regionalTable(true, (n) => (n === 2 ? throttle : undefined));

      const settled = provider
        .delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      await vi.advanceTimersByTimeAsync(DELETION_PROTECTION_REFLIP_MS + 1000);
      await vi.runAllTimersAsync();

      // `delete()` wraps the refusal; the point is that it is the drop's.
      expect(String(await settled)).toContain('refused');
      expect(regionalDpeWrites()).toEqual([false, true, true]);
    });

    it('retries the restore only once the full re-flip window has passed', async () => {
      vi.useFakeTimers();
      const refusal = Object.assign(new Error('refused'), { name: 'ValidationException' });
      sourceTable({ refuseDrop: refusal });
      const throttle = Object.assign(new Error('modified within the previous 15000 ms'), {
        name: 'ThrottlingException',
      });
      regionalTable(true, (n) => (n === 2 ? throttle : undefined));

      const settled = provider
        .delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      await vi.advanceTimersByTimeAsync(DELETION_PROTECTION_REFLIP_MS - 1);
      expect(regionalDpeWrites()).toEqual([false, true]);
      await vi.advanceTimersByTimeAsync(1);
      expect(regionalDpeWrites()).toEqual([false, true, true]);
      await vi.runAllTimersAsync();
      await settled;
    });

    it('drops the replica only once the replica AND the source table read ACTIVE again', async () => {
      vi.useFakeTimers();
      const seen: string[] = [];
      let seenAtDrop: string[] | undefined;
      let flipped = false;
      let replicaGone = false;
      let tableGone = false;
      let sourcePolls = 0;
      mockSend.mockImplementation(async (command: Sent) => {
        const name = command.constructor.name;
        if (command.input['ReplicaUpdates']?.[0]?.Delete) {
          seenAtDrop = [...seen];
          replicaGone = true;
          return {};
        }
        if (name === DeleteTableCommand.name) {
          tableGone = true;
          return {};
        }
        if (name === DescribeTableCommand.name && tableGone) {
          throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
        }
        if (name === DescribeTableCommand.name && flipped && seenAtDrop === undefined) {
          // The source is still UPDATING on the first poll after the flip.
          const status = ++sourcePolls === 1 ? 'UPDATING' : 'ACTIVE';
          seen.push(`source:${status}`);
          return { Table: { ...activeTable().Table, TableStatus: status } };
        }
        return activeTable(replicaGone ? [] : ['eu-west-1']);
      });
      let replicaPolls = 0;
      regionalSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === UpdateTableCommand.name) {
          flipped = true;
          return {};
        }
        if (!flipped) {
          return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: true } };
        }
        // The new value already reads back while the replica is UPDATING.
        const status = ++replicaPolls === 1 ? 'UPDATING' : 'ACTIVE';
        seen.push(`replica:${status}`);
        return { Table: { TableName: TABLE, TableStatus: status, DeletionProtectionEnabled: false } };
      });

      const done = provider.delete('T', TABLE, RESOURCE_TYPE, undefined, {
        removeProtection: true,
      });
      await vi.runAllTimersAsync();
      await done;

      expect(seenAtDrop).toEqual([
        'replica:UPDATING',
        'replica:ACTIVE',
        'source:UPDATING',
        'replica:ACTIVE',
        'source:ACTIVE',
      ]);
    });

    it('puts the guard back and stops, saying the destroy was interrupted, on a Ctrl-C in the settle wait', async () => {
      sourceTable();
      let writes = 0;
      regionalSend.mockImplementation(async (command: Sent) => {
        if (command.constructor.name === UpdateTableCommand.name) {
          writes++;
          // The restore is refused, so the warning carries the reason.
          if (writes >= 2) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
          return {};
        }
        if (writes >= 1) throw new InterruptedWaitError('replica settle');
        return { Table: { TableName: TABLE, TableStatus: 'ACTIVE', DeletionProtectionEnabled: true } };
      });

      const error = await provider
        .delete('T', TABLE, RESOURCE_TYPE, undefined, { removeProtection: true })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(isInterruptedWaitError(error)).toBe(true);
      expect(regionalDpeWrites()).toEqual([false, true]);
      const warning = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('LEFT UNPROTECTED'));
      expect(warning).toContain('was not deleted (the destroy was interrupted)');
      expect(
        mockSend.mock.calls.some((c) => (c[0] as Sent).input['ReplicaUpdates']?.[0]?.Delete)
      ).toBe(false);
    });
  });
});
