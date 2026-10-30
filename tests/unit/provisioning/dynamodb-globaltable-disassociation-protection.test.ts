import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

// go-to-k/cdkd#5570: `Replicas[].DisassociationProtectionEnabled` reaches
// DynamoDB only as an `UpdateTable` of the replica's own table, in its own
// region, that carries nothing else (`@aws-sdk/client-dynamodb` 3.1159.0
// `UpdateTableInput`: "You can't combine this change with any other change").
// The provider sends it per replica — the local table included — once the
// rest of the create or update settled, reads it back, and leaves a replica
// that already holds the declared value alone (the protection is on by
// default). A removed value sends nothing: an omitted member is unchanged.

const { mockSend, regionalSend, mockAutoScalingSend, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  regionalSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// The deploy region's clients are the SOURCE double; the eu-west-1 one is
// `regionalSend`, so a call's REGION is what a case reads.
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
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'gt-5570';
const KEY = 'DisassociationProtectionEnabled';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
type Region = 'us-east-1' | 'eu-west-1';

/** A two-replica bag; `undefined` leaves the member out of that replica. */
function bag(local: unknown, eu: unknown, withEu = true): Record<string, unknown> {
  const entry = (Region: string, value: unknown) =>
    value === undefined ? { Region } : { Region, [KEY]: value };
  return {
    TableName: TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    Replicas: [entry('us-east-1', local), ...(withEu ? [entry('eu-west-1', eu)] : [])],
  };
}

/**
 * The live tables: each region's protection (`undefined` = DescribeTable
 * reports none), what each describe after a write answers, and every write.
 */
let live: Record<Region, boolean | undefined>;
let replicas: string[];
/** Region -> the number of describes after its write still reading UPDATING. */
let lag: Partial<Record<Region, number>>;
let failRead: Partial<Record<Region, boolean>>;
/** Source describes still listing the replicas UPDATING (a cross-region change in flight). */
let replicaLag: number;
/** Every send, in order, by region and command — the cross-client order. */
let log: string[];

function answer(region: Region, command: Sent): unknown {
  const name = command.constructor.name;
  log.push(`${region} ${name}${KEY in command.input ? `:${String(command.input[KEY])}` : ''}`);
  if (name === UpdateTableCommand.name) {
    if (KEY in command.input) {
      live[region] = command.input[KEY] as boolean;
    }
    const updates = command.input['ReplicaUpdates'] as Array<Record<string, any>> | undefined;
    for (const u of updates ?? []) {
      if (u['Create']) replicas.push(u['Create']['RegionName']);
      if (u['Delete']) replicas = replicas.filter((r) => r !== u['Delete']['RegionName']);
    }
    return {};
  }
  if (name === DescribeTableCommand.name && failRead[region] === true) {
    throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
  }
  const pending = lag[region] ?? 0;
  if (name === DescribeTableCommand.name && pending > 0) lag[region] = pending - 1;
  return {
    Table: {
      TableName: TABLE,
      TableArn: `arn:aws:dynamodb:${region}:123456789012:table/${TABLE}`,
      TableStatus: pending > 0 ? 'UPDATING' : 'ACTIVE',
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
      ...(live[region] !== undefined && { [KEY]: live[region] }),
      ...(region === 'us-east-1' && {
        Replicas: replicas.map((r) => ({
          RegionName: r,
          ReplicaStatus: name === DescribeTableCommand.name && replicaLag-- > 0 ? 'UPDATING' : 'ACTIVE',
        })),
      }),
    },
  };
}

/** Every disassociation-protection write, in order, by region. */
const writes = (): Array<[Region, Record<string, unknown>]> => [
  ...(
    [
      ['us-east-1', mockSend],
      ['eu-west-1', regionalSend],
    ] as const
  ).flatMap(([region, fn]) =>
    fn.mock.calls
      .map((c) => c[0] as Sent)
      .filter((c) => c.constructor.name === UpdateTableCommand.name && KEY in c.input)
      .map((c): [Region, Record<string, unknown>] => [region, c.input])
  ),
];

beforeEach(() => {
  mockSend.mockReset();
  regionalSend.mockReset();
  mockAutoScalingSend.mockReset();
  warn.mockReset();
  // AWS's default for every replica (DynamoDB Developer Guide).
  live = { 'us-east-1': true, 'eu-west-1': true };
  replicas = ['eu-west-1'];
  lag = {};
  failRead = {};
  replicaLag = 0;
  log = [];
  mockSend.mockImplementation(async (c: Sent) => answer('us-east-1', c));
  regionalSend.mockImplementation(async (c: Sent) => answer('eu-west-1', c));
  mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GlobalTable Replicas[].DisassociationProtectionEnabled (go-to-k/cdkd#5570)', () => {
  const provider = new DynamoDBGlobalTableProvider();
  const update = (
    next: Record<string, unknown>,
    prev: Record<string, unknown>,
    context?: Record<string, unknown>
  ) => provider.update('Gt', TABLE, TYPE, next, prev, context);

  describe('create', () => {
    it("disables it on a cross-region replica through that replica's own region, alone", async () => {
      await provider.create('Gt', TYPE, bag(undefined, false));

      // A solo UpdateTable: the member and the table name, nothing else.
      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
      expect(live['eu-west-1']).toBe(false);
    });

    it('disables it on the local table through the deploy-region client', async () => {
      // A provider of its own: its region-scoped client cache starts empty.
      const fresh = new DynamoDBGlobalTableProvider();
      await fresh.create('Gt', TYPE, bag(false, undefined));

      expect(writes()).toEqual([['us-east-1', { TableName: TABLE, [KEY]: false }]]);
      // The provider's own client, not a region-scoped one built for the
      // deploy region (the mock answers both through the same double).
      const cache = (fresh as unknown as { regionalClientCache: Map<string, unknown> })
        .regionalClientCache;
      expect(cache.has('us-east-1')).toBe(false);
    });

    it('sends a declared value whose pre-read failed, then reads it back', async () => {
      live['eu-west-1'] = false;
      let reads = 0;
      regionalSend.mockImplementation(async (c: Sent) => {
        if (c.constructor.name === DescribeTableCommand.name && ++reads === 1) {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return answer('eu-west-1', c);
      });
      // A changed value on create: the only read that could skip it failed.
      await provider.create('Gt', TYPE, bag(undefined, false));

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('reads a CFn string as the boolean', async () => {
      await provider.create('Gt', TYPE, bag('false', undefined));

      expect(writes()).toEqual([['us-east-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('sends nothing for a declared true the new replicas already hold', async () => {
      await provider.create('Gt', TYPE, bag(true, true));

      expect(writes()).toEqual([]);
    });

    it('sends a declared value when the read reports none', async () => {
      live['eu-west-1'] = undefined;
      // The write lands, and the settle wait then reads it back.
      await provider.create('Gt', TYPE, bag(undefined, true));

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: true }]]);
    });

    it('waits until the replica reads ACTIVE with the new value', async () => {
      vi.useFakeTimers();
      regionalSend.mockImplementation(async (c: Sent) => {
        const out = answer('eu-west-1', c);
        // The first two describes after the write still lag behind it.
        if (c.constructor.name === UpdateTableCommand.name && KEY in c.input) lag['eu-west-1'] = 2;
        return out;
      });
      const done = provider.create('Gt', TYPE, bag(undefined, false));
      await vi.runAllTimersAsync();
      await done;

      expect(writes()).toHaveLength(1);
      const names = regionalSend.mock.calls.map((c) => (c[0] as Sent).constructor.name);
      const afterWrite = names.slice(names.indexOf(UpdateTableCommand.name) + 1);
      // Two lagging reads, then the one that returned.
      expect(afterWrite.filter((n) => n === DescribeTableCommand.name)).toHaveLength(3);
    });

    it('writes each declared replica once, in its own region, in template order', async () => {
      await provider.create('Gt', TYPE, bag(false, false));

      expect(writes()).toEqual([
        ['us-east-1', { TableName: TABLE, [KEY]: false }],
        ['eu-west-1', { TableName: TABLE, [KEY]: false }],
      ]);
      expect(log.filter((l) => l.includes(`:${'false'}`))).toEqual([
        'us-east-1 UpdateTableCommand:false',
        'eu-west-1 UpdateTableCommand:false',
      ]);
    });

    it('waits for the replica region to settle before the write', async () => {
      vi.useFakeTimers();
      // The pass's own read and the first pre-write read find it UPDATING.
      lag['eu-west-1'] = 2;
      const done = provider.create('Gt', TYPE, bag(undefined, false));
      await vi.runAllTimersAsync();
      await done;

      const euLog = log.filter((l) => l.startsWith('eu-west-1'));
      const write = euLog.indexOf('eu-west-1 UpdateTableCommand:false');
      expect(write).toBeGreaterThan(0);
      // The UPDATING answers were consumed, and one more read found it ACTIVE.
      expect(euLog.slice(0, write).filter((l) => l.endsWith('DescribeTableCommand'))).toHaveLength(3);
    });

    it('settles every replica after its last write, before TTL', async () => {
      vi.useFakeTimers();
      const props = { ...bag(undefined, false), TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } };
      regionalSend.mockImplementation(async (c: Sent) => {
        const out = answer('eu-west-1', c);
        // The source keeps listing the replica UPDATING for three reads.
        if (c.constructor.name === UpdateTableCommand.name && KEY in c.input) replicaLag = 3;
        return out;
      });
      let lagAtTtl: number | undefined;
      mockSend.mockImplementation(async (c: Sent) => {
        if (c.constructor.name === 'UpdateTimeToLiveCommand') lagAtTtl = replicaLag;
        return answer('us-east-1', c);
      });
      const done = provider.create('Gt', TYPE, props);
      await vi.runAllTimersAsync();
      await done;

      expect(log.indexOf('us-east-1 UpdateTimeToLiveCommand')).toBeGreaterThan(
        log.indexOf('eu-west-1 UpdateTableCommand:false')
      );
      // Every UPDATING read was spent before TTL went out.
      expect(lagAtTtl).toBeLessThanOrEqual(0);
    });

    it('fails the create, naming the member and region, when the value never reads back', async () => {
      vi.useFakeTimers();
      regionalSend.mockImplementation(async (c: Sent) => {
        const out = answer('eu-west-1', c);
        if (c.constructor.name === UpdateTableCommand.name && KEY in c.input) lag['eu-west-1'] = 1e6;
        return out;
      });
      const done = provider.create('Gt', TYPE, bag(undefined, false)).then(
        () => new Error('not thrown'),
        (e: unknown) => e as Error
      );
      await vi.runAllTimersAsync();
      const err = await done;

      expect(err.message).toMatch(
        new RegExp(`${KEY}=false on the eu-west-1 replica of ${TABLE} did not settle`)
      );
    });

    it('refuses a value on a single-replica table before any call', async () => {
      // DynamoDB answered the solo UpdateTable with InternalFailure (500) on
      // every retry there (integ, 2026-10-30).
      replicas = [];
      const err = (await provider.create('Gt', TYPE, bag(false, undefined, false)).then(
        () => new Error('not refused'),
        (e: unknown) => e as Error
      )) as Error;

      expect(err.message).toContain(
        'Replicas[0].DisassociationProtectionEnabled is applied by DynamoDB only to a replica of a multi-Region (MREC) global table'
      );
      expect(err.message).toContain('add a replica in another Region');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('warns and sends nothing for a single-replica value on a state replay', async () => {
      replicas = [];
      await provider.create('Gt', TYPE, bag(false, undefined, false), { replayingState: true });

      expect(writes()).toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('multi-Region (MREC)'))).toBe(true);
    });

    it('refuses a value that is not a boolean before any call', async () => {
      await expect(provider.create('Gt', TYPE, bag(undefined, 'yes'))).rejects.toThrow(
        /Replicas\[1\]\.DisassociationProtectionEnabled must be a boolean/
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(regionalSend).not.toHaveBeenCalled();
    });

    it('warns on a state replay of a value that is not a boolean, and leaves it alone', async () => {
      await provider.create('Gt', TYPE, bag(undefined, 'yes'), { replayingState: true });

      expect(writes()).toEqual([]);
      expect(warn.mock.calls.some((c) => /must be a boolean/.test(String(c[0])))).toBe(true);
    });
  });

  describe('update', () => {
    it('sends a changed value to the kept replica', async () => {
      live['eu-west-1'] = false;
      await update(bag(undefined, true), bag(undefined, false));

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: true }]]);
    });

    it('sends a changed value the read could not report', async () => {
      // AWS already holds it, so only a failed read can send it. Only the
      // pass's own read fails (the first regional one): the waits read after.
      live['eu-west-1'] = false;
      let reads = 0;
      regionalSend.mockImplementation(async (c: Sent) => {
        if (c.constructor.name === DescribeTableCommand.name && ++reads === 1) {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return answer('eu-west-1', c);
      });
      await update(bag(undefined, false), bag(undefined, undefined));

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('converges an unchanged value AWS no longer holds (a console change)', async () => {
      await update(bag(false, undefined), bag(false, undefined));

      expect(writes()).toEqual([['us-east-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('leaves an unchanged value alone when AWS holds it, or when it cannot be read', async () => {
      live['eu-west-1'] = false;
      await update(bag(undefined, false), bag(undefined, false));
      failRead['eu-west-1'] = true;
      await update(bag(undefined, true), bag(undefined, true));

      expect(writes()).toEqual([]);
    });

    it('sends nothing for a removed value, and says the replica keeps it', async () => {
      live['eu-west-1'] = false;
      await update(bag(undefined, undefined), bag(undefined, false));

      expect(writes()).toEqual([]);
      expect(live['eu-west-1']).toBe(false);
      const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(KEY));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('removed from the eu-west-1 replica');
      expect(warned[0]).toContain('keeps');
    });

    it('does not warn about an absence on a state replay or a drift revert', async () => {
      for (const context of [{ replayingState: true }, { desiredFromAwsReadback: true }]) {
        await update(bag(undefined, undefined), bag(undefined, false), context);
      }

      expect(writes()).toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(KEY))).toBe(false);
    });

    it("puts a rolled-back deploy's false back to the default on a state replay", async () => {
      // The rolled-back deploy declared false and sent it; the record it
      // restores has no member, which stands for the AWS default (on).
      live['eu-west-1'] = false;
      await update(bag(undefined, undefined), bag(undefined, false), { replayingState: true });

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: true }]]);
      expect(live['eu-west-1']).toBe(true);
    });

    it('leaves the replica alone on a replay when AWS does not read false', async () => {
      for (const value of [true, undefined]) {
        live['eu-west-1'] = value;
        await update(bag(undefined, undefined), bag(undefined, false), { replayingState: true });
      }
      // A drift revert never restores on an absence.
      live['eu-west-1'] = false;
      await update(bag(undefined, undefined), bag(undefined, false), {
        desiredFromAwsReadback: true,
      });

      expect(writes()).toEqual([]);
    });

    it('applies a recorded value on a state replay', async () => {
      await update(bag(undefined, false), bag(undefined, undefined), { replayingState: true });

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('sets it on a replica the update adds, after the replica exists', async () => {
      replicas = [];
      await update(bag(undefined, false), bag(undefined, undefined, false));

      const created = mockSend.mock.calls.findIndex(
        (c) =>
          (c[0] as Sent).constructor.name === UpdateTableCommand.name &&
          JSON.stringify((c[0] as Sent).input).includes('"Create"')
      );
      expect(created).toBeGreaterThanOrEqual(0);
      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('re-sends an unchanged value an earlier failed update left unsettled', async () => {
      // AWS holds the old value, but this deploy cannot read it.
      live['eu-west-1'] = true;
      let reads = 0;
      regionalSend.mockImplementation(async (c: Sent) => {
        if (c.constructor.name === DescribeTableCommand.name && ++reads === 1) {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return answer('eu-west-1', c);
      });
      await update(bag(undefined, false), bag(undefined, false), {
        unsettledProperties: new Set(['Replicas']),
      });

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('fails a partial update with the masked AWS class, after the first replica was written', async () => {
      const ARN = 'arn:aws:sts::123456789012:assumed-role/Deployer/session';
      regionalSend.mockImplementation(async (c: Sent) => {
        if (c.constructor.name === UpdateTableCommand.name && KEY in c.input) {
          throw Object.assign(new Error(`User: ${ARN} is not authorized to perform dynamodb:UpdateTable`), {
            name: 'AccessDeniedException',
            $fault: 'client',
          });
        }
        return answer('eu-west-1', c);
      });
      const err = (await update(bag(false, false), bag(undefined, undefined)).then(
        () => new Error('not thrown'),
        (e: unknown) => e as Error
      )) as Error;

      expect(err.message).toContain('AccessDeniedException');
      expect(err.message).not.toContain(ARN);
      // The local replica was written first, then the refused one was tried.
      expect(writes()).toEqual([
        ['us-east-1', { TableName: TABLE, [KEY]: false }],
        ['eu-west-1', { TableName: TABLE, [KEY]: false }],
      ]);
      expect(live).toEqual({ 'us-east-1': false, 'eu-west-1': true });
    });

    it('does not restore on a replay whose rolled-back deploy declared true', async () => {
      live['eu-west-1'] = false;
      await update(bag(undefined, undefined), bag(undefined, true), { replayingState: true });

      expect(writes()).toEqual([]);
    });

    it('sends a drift revert\'s read-back value that AWS no longer holds', async () => {
      live['eu-west-1'] = true;
      await update(bag(undefined, false), bag(undefined, true), { desiredFromAwsReadback: true });

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('warns and leaves the replica alone for a non-boolean under a replay or a revert', async () => {
      for (const context of [{ replayingState: true }, { desiredFromAwsReadback: true }]) {
        await update(bag(undefined, 'yes'), bag(undefined, false), context);
      }

      expect(writes()).toEqual([]);
      const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => /must be a boolean/.test(m));
      expect(warned).toHaveLength(2);
    });

    it('sets the local value in the update that adds the second replica', async () => {
      replicas = [];
      await update(bag(false, undefined), bag(undefined, undefined, false));

      const created = log.indexOf('us-east-1 UpdateTableCommand');
      expect(created).toBeGreaterThanOrEqual(0);
      expect(log.indexOf('us-east-1 UpdateTableCommand:false')).toBeGreaterThan(created);
      expect(writes()).toEqual([['us-east-1', { TableName: TABLE, [KEY]: false }]]);
    });

    it('skips, with a warning, an unchanged value on a table dropping to one replica', async () => {
      await update(bag(false, undefined, false), bag(false, undefined));

      expect(writes()).toEqual([]);
      const skipped = (): number =>
        warn.mock.calls.filter((c) =>
          String(c[0]).includes("this table's Replicas name a single Region")
        ).length;
      expect(skipped()).toBe(1);
      // The next deploy of the now single-Region table says nothing at warn.
      replicas = [];
      await update(bag(false, undefined, false), bag(false, undefined, false));
      expect(skipped()).toBe(1);
      expect(writes()).toEqual([]);
    });

    it('sends nothing and refuses nothing for a true on a single-Region table', async () => {
      replicas = [];
      await provider.create('Gt', TYPE, bag(true, undefined, false));
      await update(bag(true, undefined, false), bag(undefined, undefined, false));
      // Dropping to one Region with a changed true.
      replicas = ['eu-west-1'];
      await update(bag(true, undefined, false), bag(false, undefined));

      expect(writes()).toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('MREC'))).toBe(false);
      // Each of those declared or changed the value, so each said once that it
      // is not sent; an unchanged redeploy of the one-Region table says nothing.
      const notSent = (): number =>
        warn.mock.calls.filter((c) => String(c[0]).includes('=true on the us-east-1 replica')).length;
      expect(notSent()).toBe(3);
      replicas = [];
      await update(bag(true, undefined, false), bag(true, undefined, false));
      expect(notSent()).toBe(3);
    });

    it('says what the replica keeps when its value is removed as the table drops to one Region', async () => {
      for (const context of [undefined, { replayingState: true }]) {
        warn.mockReset();
        replicas = ['eu-west-1'];
        live['us-east-1'] = false;
        await update(bag(undefined, undefined, false), bag(false, undefined), context);

        const kept = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('now name a single Region'));
        expect(kept).toHaveLength(1);
        expect(kept[0]).toContain('keeps its current setting (false when last deployed)');
      }
      expect(writes()).toEqual([]);
      // A drift revert's absence is an unread member, not a removal: no word.
      warn.mockReset();
      replicas = ['eu-west-1'];
      await update(bag(undefined, undefined, false), bag(false, undefined), {
        desiredFromAwsReadback: true,
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('now name a single Region'))).toBe(
        false
      );
    });

    it('refuses a value on Replicas that repeat one Region', async () => {
      const props = bag(undefined, undefined);
      props['Replicas'] = [{ Region: 'us-east-1' }, { Region: 'us-east-1', [KEY]: false }];

      await expect(provider.create('Gt', TYPE, props)).rejects.toThrow(
        /Replicas name a single Region/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("settles every replica after a replay's restore, before TTL", async () => {
      vi.useFakeTimers();
      live['eu-west-1'] = false;
      regionalSend.mockImplementation(async (c: Sent) => {
        const out = answer('eu-west-1', c);
        if (c.constructor.name === UpdateTableCommand.name && KEY in c.input) replicaLag = 3;
        return out;
      });
      let lagAtTtl: number | undefined;
      mockSend.mockImplementation(async (c: Sent) => {
        if (c.constructor.name === 'UpdateTimeToLiveCommand') lagAtTtl = replicaLag;
        return answer('us-east-1', c);
      });
      const ttl = { TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } };
      const done = update({ ...bag(undefined, undefined), ...ttl }, bag(undefined, false), {
        replayingState: true,
      });
      await vi.runAllTimersAsync();
      await done;

      expect(writes()).toEqual([['eu-west-1', { TableName: TABLE, [KEY]: true }]]);
      expect(lagAtTtl).toBeLessThanOrEqual(0);
    });

    it('refuses a changed false on a table dropping to one replica before any call', async () => {
      await expect(update(bag(false, undefined, false), bag(true, undefined))).rejects.toThrow(
        /only to a replica of a multi-Region \(MREC\) global table/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('warns and sends nothing for a changed single-replica value under a replay or a revert', async () => {
      replicas = [];
      for (const context of [{ replayingState: true }, { desiredFromAwsReadback: true }]) {
        await update(bag(false, undefined, false), bag(undefined, undefined, false), context);
      }

      expect(writes()).toEqual([]);
      const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('MREC'));
      expect(warned).toHaveLength(2);
      // A new true there is skipped at debug, never at warn, off the template path.
      for (const context of [{ replayingState: true }, { desiredFromAwsReadback: true }]) {
        await update(bag(true, undefined, false), bag(undefined, undefined, false), context);
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes('=true on the us-east-1 replica'))).toBe(
        false
      );
      expect(writes()).toEqual([]);
    });

    it('refuses a changed value that is not a boolean before any call', async () => {
      await expect(update(bag(undefined, 1), bag(undefined, false))).rejects.toThrow(
        /DisassociationProtectionEnabled must be a boolean/
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(regionalSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState', () => {
    it('reports each declared value, read in its own region, and nothing undeclared', async () => {
      live['eu-west-1'] = false;
      const state = (await provider.readCurrentState(
        TABLE,
        'Gt',
        TYPE,
        bag(undefined, false)
      )) as Record<string, unknown>;
      const byRegion = Object.fromEntries(
        (state['Replicas'] as Array<Record<string, unknown>>).map((r) => [r['Region'], r])
      );

      expect(byRegion['eu-west-1']![KEY]).toBe(false);
      expect(byRegion['us-east-1']).not.toHaveProperty(KEY);
    });

    it('omits a declared value whose regional read failed', async () => {
      failRead['eu-west-1'] = true;
      const state = (await provider.readCurrentState(
        TABLE,
        'Gt',
        TYPE,
        bag(true, false)
      )) as Record<string, unknown>;
      const byRegion = Object.fromEntries(
        (state['Replicas'] as Array<Record<string, unknown>>).map((r) => [r['Region'], r])
      );

      expect(byRegion['us-east-1']![KEY]).toBe(true);
      expect(byRegion['eu-west-1']).not.toHaveProperty(KEY);
    });
  });
});
