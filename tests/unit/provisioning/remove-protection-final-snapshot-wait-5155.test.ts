// Issue #5155: `cdkd destroy --remove-protection` turns DeletionProtection off
// and then deletes. When that delete takes a final snapshot (the
// DeletionPolicy default for a DB cluster / standalone DB instance), AWS
// refuses it while the resource is still `modifying` from the flip ("Can't
// create a snapshot because the database cluster ... isn't currently in the
// available state"). The delete now waits for protection OFF and `available`
// first, but ONLY when this run flipped the guard AND a snapshot is requested.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const budget = vi.hoisted(() => ({ remainingMs: Number.POSITIVE_INFINITY }));

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => budget.remainingMs,
}));

function clientMock(name: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [name]: vi.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-rds', clientMock('RDSClient'));
vi.mock('@aws-sdk/client-neptune', clientMock('NeptuneClient'));
vi.mock('@aws-sdk/client-docdb', clientMock('DocDBClient'));

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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';

const SNAP = 'my-res-final-20261022-000000';

interface Scenario {
  /** DeletionProtection before the destroy. */
  protectionOn: boolean;
  /** Statuses the resource reports after the flip, one per describe. */
  afterFlip: string[];
  /** Describes after the flip that still read the guard ON (default 0). */
  protectionLag?: number;
  /** After the delete the resource reads `deleting` instead of gone. */
  deletingAfterDelete?: boolean;
  /**
   * Issue #5184: how many deletes AWS refuses before accepting one, and with
   * which text (default: the final snapshot's "not available" refusal).
   */
  deleteRefusals?: number;
  refusalText?: string;
}

const NOT_AVAILABLE =
  "Can't create a snapshot because the database cluster res isn't currently in the available state.";
const MEMBER_REFUSAL =
  'Cluster cannot be deleted, it still contains DB instances in non-deleting state.';

/**
 * A cluster or instance whose guard the flip turns off; after the flip it
 * reports `afterFlip` statuses in turn (then `available`), and after the
 * delete it is gone. Records the order of every command name.
 */
function route(kind: 'cluster' | 'instance', scenario: Scenario) {
  let protection = scenario.protectionOn;
  let flipped = false;
  let deleted = false;
  let deleting = false;
  const queue = [...scenario.afterFlip];
  let lag = scenario.protectionLag ?? 0;
  let refusals = scenario.deleteRefusals ?? 0;
  const order: string[] = [];
  const reEnables: number[] = [];
  mockSend.mockImplementation(async (command: { constructor: { name: string }; input?: any }) => {
    const name = command.constructor.name;
    order.push(name);
    if (/^ModifyDB(Cluster|Instance)Command$/.test(name) && command.input?.DeletionProtection === true) {
      reEnables.push(order.length - 1);
    }
    if (/^ModifyDB(Cluster|Instance)Command$/.test(name) && command.input?.DeletionProtection === false) {
      protection = false;
      flipped = true;
      return {};
    }
    if (/^ModifyDB(Cluster|Instance)Command$/.test(name)) {
      protection = command.input?.DeletionProtection === true ? true : protection;
      return {};
    }
    if (/^DeleteDB(Cluster|Instance)Command$/.test(name)) {
      if (refusals > 0) {
        refusals -= 1;
        throw Object.assign(new Error(scenario.refusalText ?? NOT_AVAILABLE), {
          name: kind === 'cluster' ? 'InvalidDBClusterStateFault' : 'InvalidDBInstanceStateFault',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        });
      }
      deleted = scenario.deletingAfterDelete !== true;
      deleting = scenario.deletingAfterDelete === true;
      return {};
    }
    if (name === 'DescribeDBClustersCommand' || name === 'DescribeDBInstancesCommand') {
      if (deleted) {
        throw Object.assign(new Error('not found'), {
          name: kind === 'cluster' ? 'DBClusterNotFoundFault' : 'DBInstanceNotFound',
        });
      }
      const status = deleting ? 'deleting' : flipped ? (queue.shift() ?? 'available') : 'available';
      const readsOn = flipped && lag > 0;
      if (readsOn) lag -= 1;
      return kind === 'cluster'
        ? {
            DBClusters: [
              { DBClusterIdentifier: 'res', DeletionProtection: readsOn || protection, Status: status },
            ],
          }
        : {
            DBInstances: [
              {
                DBInstanceIdentifier: 'res',
                DeletionProtection: readsOn || protection,
                DBInstanceStatus: status,
              },
            ],
          };
    }
    return {};
  });
  return Object.assign(order, { reEnables });
}

/** Describes sent after the flip and before the delete. */
function describesBetweenFlipAndDelete(order: string[]): number {
  const flip = order.findIndex((n) => /^ModifyDB(Cluster|Instance)Command$/.test(n));
  const del = order.findIndex((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n));
  if (flip < 0 || del < 0) return 0;
  return order.slice(flip + 1, del).filter((n) => /^DescribeDB(Clusters|Instances)Command$/.test(n))
    .length;
}

function withoutSleep<T extends object>(provider: T): T {
  (provider as unknown as { sleep: () => Promise<void> }).sleep = vi.fn().mockResolvedValue(undefined);
  return provider;
}

const CASES = [
  {
    label: 'RDS DBCluster',
    kind: 'cluster' as const,
    type: 'AWS::RDS::DBCluster',
    make: () => withoutSleep(new RDSProvider()),
    properties: {},
  },
  {
    label: 'RDS DBInstance (standalone)',
    kind: 'instance' as const,
    type: 'AWS::RDS::DBInstance',
    make: () => withoutSleep(new RDSProvider()),
    properties: { Engine: 'postgres' },
  },
  {
    label: 'DocDB DBCluster',
    kind: 'cluster' as const,
    type: 'AWS::DocDB::DBCluster',
    make: () => withoutSleep(new DocDBProvider()),
    properties: {},
  },
  {
    label: 'Neptune DBCluster',
    kind: 'cluster' as const,
    type: 'AWS::Neptune::DBCluster',
    make: () => withoutSleep(new NeptuneProvider()),
    properties: {},
  },
];

describe.each(CASES)('$label: --remove-protection then a final snapshot (#5155)', (c) => {
  beforeEach(() => {
    vi.clearAllMocks();
    budget.remainingMs = Number.POSITIVE_INFINITY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses at once, and puts the guard back, when the resource timeout leaves less than the margin', async () => {
    budget.remainingMs = 30_000;
    const order = route(c.kind, { protectionOn: true, afterFlip: Array(10).fill('modifying') });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    const error = await c
      .make()
      .delete('Res', 'res', c.type, c.properties, context)
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('the resource timeout leaves no time');
    expect(order.some((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toBe(false);
    expect(order.reEnables).toHaveLength(1);
    const flip = order.findIndex((n) => /^ModifyDB(Cluster|Instance)Command$/.test(n));
    expect(
      order.slice(flip + 1, order.reEnables[0]).filter((n) => /^DescribeDB/.test(n))
    ).toHaveLength(0);
  });

  it('bounds the wait by the remaining resource budget, not the 15-minute cap', async () => {
    budget.remainingMs = 60_000 + 3 * 60_000;
    const order = route(c.kind, { protectionOn: true, afterFlip: Array(1000).fill('modifying') });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 20_000));
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    const error = await c
      .make()
      .delete('Res', 'res', c.type, c.properties, context)
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('within 3 minutes');
    expect(order.some((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toBe(false);
    expect(order.reEnables).toHaveLength(1);
  });

  it('waits out any transitional status, not only modifying, before the delete (#5184)', async () => {
    // The live rds-aurora shape: an earlier change left the cluster
    // `configuring-enhanced-monitoring`, which is neither `available` nor
    // `modifying`.
    const transitional =
      c.kind === 'cluster' ? 'configuring-enhanced-monitoring' : 'configuring-log-exports';
    const order = route(c.kind, { protectionOn: true, afterFlip: Array(10).fill(transitional) });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    // Ten transitional reads, then `available`.
    expect(describesBetweenFlipAndDelete(order)).toBe(11);
  });

  it('retries a refusal while the resource is in a transitional status other than modifying (#5184)', async () => {
    // Refused once; the readback then shows configuring-enhanced-monitoring
    // twice before `available`, and the retry is accepted.
    const order = route(c.kind, {
      protectionOn: true,
      afterFlip: ['available', 'available', 'available', 'available', 'available',
        'configuring-enhanced-monitoring', 'configuring-enhanced-monitoring'],
      deleteRefusals: 1,
    });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(order.filter((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toHaveLength(2);
    expect(order.reEnables).toHaveLength(0);
  });

  it('sends at once in storage-optimization, which AWS documents as fully operational (#5184)', async () => {
    const order = route(c.kind, {
      protectionOn: true,
      afterFlip: Array(10).fill('storage-optimization'),
    });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(describesBetweenFlipAndDelete(order)).toBe(1);
  });

  it('leaves a terminal status to AWS at once instead of waiting (#5184)', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: Array(10).fill('stopped') });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(describesBetweenFlipAndDelete(order)).toBe(1);
  });

  it('waits for available after the flip when a final snapshot is requested', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: ['modifying', 'modifying'] });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    // modifying, modifying, then available: three reads before the delete.
    expect(describesBetweenFlipAndDelete(order)).toBe(3);
  });

  it('does not trust a first read of guard OFF and available before modifying shows (#5184)', async () => {
    // The live sequence: AWS reads protection OFF at once while the status has
    // not yet left `available` for `modifying`; a delete then is refused.
    const order = route(c.kind, { protectionOn: true, afterFlip: ['available', 'modifying'] });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    // available, modifying, then available: three reads before the delete.
    expect(describesBetweenFlipAndDelete(order)).toBe(3);
  });

  it('keeps waiting while an available resource still reads the guard ON', async () => {
    // `available` before the flip has even started: status alone would let
    // the delete through and hit the same refusal.
    const order = route(c.kind, {
      protectionOn: true,
      afterFlip: ['available', 'available', 'modifying'],
      protectionLag: 2,
    });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    // ON + available twice, then modifying, then available.
    expect(describesBetweenFlipAndDelete(order)).toBe(4);
  });

  it('keeps waiting while the guard reads ON, then gives the first OFF read its own #5184 grace window', async () => {
    // Seven ON reads span 65s of sleep, past 30s: only the guard readback
    // holds the delete. The grace clock starts at the eighth read, the first
    // OFF one, so three more reads (30s of grace) precede the delete.
    const order = route(c.kind, {
      protectionOn: true,
      afterFlip: Array(10).fill('available'),
      protectionLag: 7,
    });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(describesBetweenFlipAndDelete(order)).toBe(11);
  });

  it('retries a delete AWS refuses as not available once the resource reads available again (#5184)', async () => {
    // The live sequence: the wait saw nothing to hold for, AWS then refused
    // the final-snapshot delete as not `available`.
    const order = route(c.kind, { protectionOn: true, afterFlip: [], deleteRefusals: 1 });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(order.filter((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toHaveLength(2);
    expect(order.reEnables).toHaveLength(0);
  });

  it('fails closed when AWS keeps refusing the delete as not available until the bound (#5184)', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: [], deleteRefusals: 1000 });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 20_000));
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    const error = await c
      .make()
      .delete('Res', 'res', c.type, c.properties, context)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    // AWS's refusal is what surfaces, by its class or its text.
    expect((error as Error).message).toMatch(
      /InvalidDB(Cluster|Instance)StateFault|currently in the available state/
    );
    const deletes = order.filter((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n)).length;
    expect(deletes).toBeGreaterThan(1);
    expect(deletes).toBeLessThan(1000);
    // Never accepted, so the compensation puts the guard back.
    expect(order.reEnables).toHaveLength(1);
  });

  it('does not retry a different refusal of the same class: the member refusal stays terminal (#2204)', async () => {
    const order = route(c.kind, {
      protectionOn: true,
      afterFlip: [],
      deleteRefusals: 1,
      refusalText: MEMBER_REFUSAL,
    });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    const error = await c
      .make()
      .delete('Res', 'res', c.type, c.properties, context)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(order.filter((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toHaveLength(1);
    expect(order.reEnables).toHaveLength(1);
  });

  it('does not wait without a final snapshot', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: ['modifying'] });

    await c.make().delete('Res', 'res', c.type, c.properties, { removeProtection: true });

    expect(describesBetweenFlipAndDelete(order)).toBe(0);
  });

  it('does not wait when this run flipped nothing (the guard was already off)', async () => {
    const order = route(c.kind, { protectionOn: false, afterFlip: ['modifying'] });
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await c.make().delete('Res', 'res', c.type, c.properties, context);

    expect(describesBetweenFlipAndDelete(order)).toBe(0);
  });

  it('fails closed on a timeout: no delete is sent, and the message names the next step', async () => {
    const order = route(c.kind, { protectionOn: true, afterFlip: Array(1000).fill('modifying') });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    const error = await c
      .make()
      .delete('Res', 'res', c.type, c.properties, context)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`the ${c.kind} did not return to 'available'`);
    expect((error as Error).message).toContain('re-run the destroy');
    expect(order.some((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n))).toBe(false);
    // The timeout is terminal, so the compensation puts the guard back, as the
    // message says.
    expect(order.reEnables).toHaveLength(1);
  });

  it('does not wait again on a re-entry after AWS already accepted the delete', async () => {
    // First attempt: the wait passes, the delete is accepted, and the
    // gone-wait then fails retryably. The re-entry must not poll a
    // `deleting` resource for `available`.
    const order = route(c.kind, { protectionOn: true, afterFlip: [], deletingAfterDelete: true });
    const provider = c.make();
    const goneWait = c.kind === 'cluster' ? 'waitForClusterDeleted' : 'waitForInstanceDeleted';
    (provider as unknown as Record<string, unknown>)[goneWait] = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        })
      )
      .mockResolvedValue(undefined);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const context: DeleteContext = { removeProtection: true, finalSnapshotIdentifier: SNAP };

    await expect(provider.delete('Res', 'res', c.type, c.properties, context)).rejects.toThrow();
    const firstLength = order.length;
    await provider.delete('Res', 'res', c.type, c.properties, context);

    const second = order.slice(firstLength);
    const del = second.findIndex((n) => /^DeleteDB(Cluster|Instance)Command$/.test(n));
    expect(del).toBeGreaterThanOrEqual(0);
    // Only the flip's own observe read precedes the second delete.
    expect(
      second.slice(0, del).filter((n) => /^DescribeDB(Clusters|Instances)Command$/.test(n))
    ).toHaveLength(1);
    expect(order.reEnables).toHaveLength(0);
  });
});
