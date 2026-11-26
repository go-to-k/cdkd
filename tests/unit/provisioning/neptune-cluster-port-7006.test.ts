// go-to-k/cdkd#7006: an in-place AWS::Neptune::DBCluster update changing
// DBPort records `Port` / `Endpoint.Port` once the cluster has moved to the
// new port, as the RDS and DocumentDB providers wait for a changed cluster
// port (issue #1160) and CloudFormation reports the update once it has
// settled. Under `--no-wait` an unapplied port is left absent and the wait is
// handed to the deploy (`deferReadiness`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

// A short resource deadline: a wait that never settles fails its test at once.
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => 300,
}));

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  NeptuneClient: vi.fn(() => ({
    send: (command: unknown) => mockSend(command),
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  childLogger['child'] = () => childLogger;
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  };
});

import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';

type Input = Record<string, unknown>;

const CLUSTER = 'AWS::Neptune::DBCluster';
const BASE: Input = { DBClusterIdentifier: 'graph-1', DBPort: 8182 };
const ENDPOINT = 'graph-1.cluster-abc.us-east-1.neptune.amazonaws.com';

const PENDING: Input = { Status: 'modifying', Port: 8182 };
const MOVING: Input = { Status: 'modifying', Port: 8183 };
const APPLIED: Input = { Status: 'available', Port: 8183 };

let reads: Input[] = [];

/** DescribeDBClusters answers each queued read in turn (the last repeats). */
function arm(queued: Input[]): void {
  reads = [...queued];
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'DescribeDBClustersCommand') {
      const next = reads.length > 1 ? reads.shift()! : reads[0]!;
      return Promise.resolve({
        DBClusters: [
          {
            DBClusterIdentifier: 'graph-1',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:graph-1',
            Endpoint: ENDPOINT,
            Status: 'available',
            Port: 8182,
            ...next,
          },
        ],
      });
    }
    if (command.constructor.name === 'ListTagsForResourceCommand') {
      return Promise.resolve({ TagList: [] });
    }
    return Promise.resolve({});
  });
}

function describes(): number {
  return mockSend.mock.calls.filter(
    ([command]) =>
      (command as { constructor: { name: string } }).constructor.name === 'DescribeDBClustersCommand'
  ).length;
}

function scope(): DeferredReadinessScope {
  return {
    logicalId: 'Graph',
    resourceType: CLUSTER,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  } as DeferredReadinessScope;
}

describe('Neptune DBCluster port change (go-to-k/cdkd#7006)', () => {
  let provider: NeptuneProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new NeptuneProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (next: Input, prev: Input = BASE) =>
    provider.update('Graph', 'graph-1', CLUSTER, { ...next }, { ...prev });

  it('waits for the new port and for the cluster to leave modifying, then records it', async () => {
    arm([PENDING, MOVING, APPLIED]);
    const result = await update({ ...BASE, DBPort: 8183 });
    expect(result.attributes?.['Port']).toBe('8183');
    expect(result.attributes?.['Endpoint.Port']).toBe('8183');
    // Three wait reads, then the attributes read.
    expect(describes()).toBe(4);
  });

  it('reads the legacy Port alias the same way', async () => {
    arm([PENDING, APPLIED]);
    const result = await update({ DBClusterIdentifier: 'graph-1', Port: 8183 }, {
      DBClusterIdentifier: 'graph-1',
      Port: 8182,
    });
    expect(result.attributes?.['Port']).toBe('8183');
  });

  it('fails rather than record the old port when the change never applies', async () => {
    arm([PENDING]);
    await expect(update({ ...BASE, DBPort: 8183 })).rejects.toThrow(
      /Timed out waiting for Neptune DBCluster Graph to apply its new port/
    );
  });

  it('adds no read for an unchanged port, which every update re-sends', async () => {
    arm([{}]);
    const result = await update({ ...BASE, BackupRetentionPeriod: 7 });
    expect(describes()).toBe(1);
    expect(result.attributes?.['Port']).toBe('8182');
  });

  describe('--no-wait', () => {
    beforeEach(() => {
      process.env['CDKD_NO_WAIT'] = 'true';
    });

    it('leaves an unapplied port absent and hands the same wait to the deploy', async () => {
      arm([PENDING, APPLIED]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () =>
        update({ ...BASE, DBPort: 8183 })
      );
      expect(describes()).toBe(1);
      expect(result.attributes).not.toHaveProperty('Port');
      expect(result.attributes).not.toHaveProperty('Endpoint.Port');
      expect(result.attributes?.['Endpoint']).toBe(ENDPOINT);
      expect([...bound.deferred.keys()]).toStrictEqual(['graph-1']);

      await bound.deferred.get('graph-1')!.wait(new AbortController().signal);
      expect(describes()).toBe(2);
    });

    it('stops the deferred wait once the deploy aborts it', async () => {
      arm([PENDING]);
      const bound = scope();
      await withDeferredReadinessScope(bound, () => update({ ...BASE, DBPort: 8183 }));
      const controller = new AbortController();
      controller.abort();
      await expect(bound.deferred.get('graph-1')!.wait(controller.signal)).rejects.toThrow(
        /readiness wait aborted/
      );
    });

    it('records a port the read already reports applied, and defers nothing', async () => {
      arm([APPLIED]);
      const bound = scope();
      const result = await withDeferredReadinessScope(bound, () =>
        update({ ...BASE, DBPort: 8183 })
      );
      expect(result.attributes?.['Port']).toBe('8183');
      expect(bound.deferred.size).toBe(0);
    });
  });
});
