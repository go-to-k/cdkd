import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const ARN = 'arn:aws:rds:us-east-1:111122223333:cluster:db-1';
const GLOBAL = 'my-global';

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * Answer a cluster delete: the cluster is `available` without deletion
 * protection, a detach lands and the member list is empty on the first poll,
 * and `DeleteDBCluster` is refused with AccessDenied.
 */
function script(): void {
  rdsSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DescribeDBClustersCommand') {
      return Promise.resolve({
        DBClusters: [{ DBClusterArn: ARN, Status: 'available', DeletionProtection: false }],
      });
    }
    if (name === 'RemoveFromGlobalClusterCommand') return Promise.resolve({});
    if (name === 'DescribeGlobalClustersCommand') {
      return Promise.resolve({ GlobalClusters: [{ GlobalClusterMembers: [] }] });
    }
    if (name === 'DeleteDBClusterCommand') {
      return Promise.reject(
        awsError('AccessDenied', 'User is not authorized to perform: rds:DeleteDBCluster')
      );
    }
    return Promise.reject(new Error(`unexpected command ${name}`));
  });
}

function sent(name: string): number {
  return rdsSend.mock.calls.filter((c) => String(c[0].constructor.name) === name).length;
}

describe('RDSProvider DBCluster delete marks a refusal after a global-cluster detach (go-to-k/cdkd#4946)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    rdsSend.mockReset();
    provider = new RDSProvider();
    // The detach wait polls with real delays; make them instant.
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
    script();
  });

  async function deleteError(properties: Record<string, unknown>): Promise<unknown> {
    return provider.delete('Db', 'db-1', CLUSTER, properties).then(
      () => {
        throw new Error('delete resolved');
      },
      (error: unknown) => error
    );
  }

  it('marks a refused DeleteDBCluster once the cluster was detached from its global cluster', async () => {
    const err = await deleteError({ GlobalClusterIdentifier: GLOBAL });

    expect(sent('RemoveFromGlobalClusterCommand')).toBe(1);
    expect(sent('DeleteDBClusterCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('marks the failure of the wait that confirms an accepted detach', async () => {
    const base = rdsSend.getMockImplementation()!;
    rdsSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DescribeGlobalClustersCommand'
        ? Promise.reject(awsError('AccessDenied', 'not authorized: rds:DescribeGlobalClusters'))
        : base(cmd)
    );
    const err = await deleteError({ GlobalClusterIdentifier: GLOBAL });

    expect(sent('RemoveFromGlobalClusterCommand')).toBe(1);
    expect(sent('DeleteDBClusterCommand')).toBe(0);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves a detach answered DBClusterNotFoundFault unmarked: nothing was detached (kept)', async () => {
    const base = rdsSend.getMockImplementation()!;
    rdsSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'RemoveFromGlobalClusterCommand'
        ? Promise.reject(awsError('DBClusterNotFoundFault', 'not a member'))
        : base(cmd)
    );
    const err = await deleteError({ GlobalClusterIdentifier: GLOBAL });

    expect(sent('DeleteDBClusterCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('leaves a refused DeleteDBCluster of a cluster in no global cluster unmarked (kept)', async () => {
    const err = await deleteError({});

    expect(sent('RemoveFromGlobalClusterCommand')).toBe(0);
    expect(sent('DeleteDBClusterCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });
});
