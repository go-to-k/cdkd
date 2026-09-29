import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #4029: `RDSProvider` deletes a global-cluster member by first detaching
 * it (`RemoveFromGlobalCluster`) and waiting until it has left the member list
 * and is `available` again, as the CloudFormation handler does. Without it a
 * Cloud Control-routed member either stayed on the snapshotting handler or had
 * `DeleteDBCluster` refused.
 */

const rdsSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: rdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const ARN = 'arn:aws:rds:us-east-1:111122223333:cluster:db-1';
const GLOBAL = 'my-global';

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

interface Script {
  /** Results of RemoveFromGlobalCluster, one per call: undefined = success. */
  remove?: Error | Array<Error | undefined>;
  /** DeletionProtection the describe reports (default false). */
  protection?: boolean[];
  /** Member-list answers, one per DescribeGlobalClusters poll. */
  memberPolls?: Array<string[] | Error>;
  /** Cluster status after the detach (default `available`). */
  statusAfter?: string;
}

function names(): string[] {
  return rdsSend.mock.calls.map((c) => String(c[0].constructor.name));
}

function script(s: Script): void {
  const polls = [...(s.memberPolls ?? [[]])];
  const removes = Array.isArray(s.remove) ? [...s.remove] : [s.remove];
  const protection = [...(s.protection ?? [false])];
  let deleted = false;
  rdsSend.mockImplementation((cmd) => {
    const name = cmd.constructor.name as string;
    if (name === 'DescribeDBClustersCommand') {
      if (deleted) return Promise.reject(awsError('DBClusterNotFoundFault', 'gone'));
      const guard = protection.length > 1 ? protection.shift()! : protection[0]!;
      return Promise.resolve({
        DBClusters: [
          { DBClusterArn: ARN, Status: s.statusAfter ?? 'available', DeletionProtection: guard },
        ],
      });
    }
    if (name === 'RemoveFromGlobalClusterCommand') {
      const next = removes.length > 1 ? removes.shift() : removes[0];
      return next ? Promise.reject(next) : Promise.resolve({});
    }
    if (name === 'DescribeGlobalClustersCommand') {
      const next = polls.length > 1 ? polls.shift()! : polls[0]!;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({
        GlobalClusters: [{ GlobalClusterMembers: next.map((a) => ({ DBClusterArn: a })) }],
      });
    }
    if (name === 'DeleteDBClusterCommand') {
      deleted = true;
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

describe('RDSProvider cluster delete detaches a global-cluster member first (issue #4029)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    rdsSend.mockReset();
    provider = new RDSProvider();
    // The detach wait polls with real delays; make them instant.
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
  });

  it('detaches by ARN, waits until it left the member list, then deletes without a snapshot', async () => {
    script({ memberPolls: [[ARN], [ARN], []] });

    await provider.delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL });

    const remove = rdsSend.mock.calls.find((c) => c[0].constructor.name === 'RemoveFromGlobalClusterCommand');
    expect(remove?.[0].input).toEqual({ GlobalClusterIdentifier: GLOBAL, DbClusterIdentifier: ARN });
    const order = names();
    expect(order.indexOf('RemoveFromGlobalClusterCommand')).toBeLessThan(
      order.indexOf('DeleteDBClusterCommand')
    );
    // Three member polls: the delete waited for the detach to land.
    expect(order.filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(3);
    const del = rdsSend.mock.calls.find((c) => c[0].constructor.name === 'DeleteDBClusterCommand');
    expect(del?.[0].input).toEqual(expect.objectContaining({ SkipFinalSnapshot: true }));
  });

  it('waits for the cluster to be available again before the delete', async () => {
    let statusCalls = 0;
    script({ memberPolls: [[]] });
    const base = rdsSend.getMockImplementation()!;
    rdsSend.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'DescribeDBClustersCommand' && statusCalls++ < 3) {
        return Promise.resolve({ DBClusters: [{ DBClusterArn: ARN, Status: 'modifying' }] });
      }
      return base(cmd);
    });

    await provider.delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL });

    expect(names().filter((n) => n === 'DescribeGlobalClustersCommand').length).toBeGreaterThan(1);
    expect(names()).toContain('DeleteDBClusterCommand');
  });

  it.each(['GlobalClusterNotFoundFault', 'DBClusterNotFoundFault'])(
    'a %s from the detach means nothing to detach: the delete still runs',
    async (fault) => {
      script({ remove: awsError(fault, 'x not found'), memberPolls: [[]] });

      await provider.delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL });

      expect(names()).toContain('DeleteDBClusterCommand');
    }
  );

  it('a global cluster that vanished during the wait ends the wait', async () => {
    script({ memberPolls: [awsError('GlobalClusterNotFoundFault')] });

    await provider.delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL });

    expect(names()).toContain('DeleteDBClusterCommand');
  });

  it('any other detach failure fails the delete, NON-RETRYABLE, even when AWS says "not found"', async () => {
    // The message deliberately carries "not found": the destroy runner's
    // already-deleted classifier matches that substring unless the error is
    // marked, and would drop the state of a live cluster.
    script({ remove: awsError('InvalidParameterValue', 'member not found in a ready state') });

    const error = await provider
      .delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL })
      .then(() => undefined, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('detaching db-1 from global cluster my-global failed');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(names()).not.toContain('DeleteDBClusterCommand');
  });

  it('an unreadable member list fails the delete, NON-RETRYABLE', async () => {
    script({ memberPolls: [awsError('AccessDenied', 'not authorized')] });

    const error = await provider
      .delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL })
      .then(() => undefined, (e: unknown) => e as Error);

    expect(error!.message).toContain('could not confirm db-1 left global cluster my-global');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(names()).not.toContain('DeleteDBClusterCommand');
  });

  it('a busy or throttled detach is waited through, then the delete runs', async () => {
    script({
      remove: [
        awsError('InvalidDBClusterStateFault'),
        awsError('InvalidGlobalClusterStateFault'),
        undefined,
      ],
      memberPolls: [awsError('ThrottlingException', 'Rate exceeded'), [ARN], []],
    });

    await provider.delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL });

    expect(names().filter((n) => n === 'RemoveFromGlobalClusterCommand')).toHaveLength(3);
    expect(names()).toContain('DeleteDBClusterCommand');
  });

  it('a protected cluster is NOT detached: the detach is irreversible and the delete would fail', async () => {
    script({ protection: [true] });

    const error = await provider
      .delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL })
      .then(() => undefined, (e: unknown) => e as Error);

    expect(error!.message).toContain('deletion protection on');
    expect(error!.message).toContain('turn it off');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    expect(names()).not.toContain('DeleteDBClusterCommand');
  });

  it('under --remove-protection the flip gets a grace to show before the detach', async () => {
    // Reads: the flip's observe (true), then the detach's reads: true, false.
    script({ protection: [true, true, false] });

    await provider.delete(
      'Db',
      'db-1',
      CLUSTER,
      { GlobalClusterIdentifier: GLOBAL },
      { removeProtection: true }
    );

    expect(names()).toContain('RemoveFromGlobalClusterCommand');
    expect(names()).toContain('DeleteDBClusterCommand');
  });

  it('a delete failing after the detach says the cluster is already standalone', async () => {
    script({ memberPolls: [[]] });
    const base = rdsSend.getMockImplementation()!;
    rdsSend.mockImplementation((cmd) =>
      cmd.constructor.name === 'DeleteDBClusterCommand'
        ? Promise.reject(awsError('InvalidDBClusterStateFault', 'cluster busy'))
        : base(cmd)
    );

    const error = await provider
      .delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL })
      .then(() => undefined, (e: unknown) => e as Error);

    expect(error!.message).toContain('already detached from its global cluster');
  });

  it.each([
    ['absent', {}],
    ['null', { GlobalClusterIdentifier: null }],
    ['blank', { GlobalClusterIdentifier: '  ' }],
    ['non-string', { GlobalClusterIdentifier: { Ref: 'Global' } }],
  ])('%s GlobalClusterIdentifier: no detach, a plain delete', async (_label, properties) => {
    script({});

    await provider.delete('Db', 'db-1', CLUSTER, properties as Record<string, unknown>);

    expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    expect(names()).not.toContain('DescribeGlobalClustersCommand');
    expect(names()).toContain('DeleteDBClusterCommand');
  });

  it('a cluster already gone: the region-checked not-found arm, no detach, no delete', async () => {
    rdsSend.mockImplementation((cmd) =>
      cmd.constructor.name === 'DescribeDBClustersCommand'
        ? Promise.reject(awsError('DBClusterNotFoundFault', 'DBCluster db-1 not found'))
        : Promise.resolve({})
    );

    await expect(
      provider.delete('Db', 'db-1', CLUSTER, { GlobalClusterIdentifier: GLOBAL })
    ).resolves.toBeUndefined();
    expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    expect(names()).not.toContain('DeleteDBClusterCommand');
  });
});
