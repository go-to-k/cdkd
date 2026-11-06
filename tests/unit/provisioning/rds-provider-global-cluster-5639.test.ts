import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5639: `AWS::RDS::DBCluster` `GlobalClusterIdentifier` on the SDK
 * route. CreateDBCluster joins the named global cluster. An update follows
 * CloudFormation's handler (`ImmutabilityHelper.isGlobalClusterMutable`): a
 * removal detaches the cluster in place before the ModifyDBCluster, and an add
 * or change is refused before any write unless the live cluster is already a
 * member of the target.
 */

const rdsSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

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
    warn,
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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const ID = 'db-1';
const ARN = `arn:aws:rds:us-east-1:111122223333:cluster:${ID}`;

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

interface Live {
  /** The global cluster the live cluster belongs to (undefined: none). */
  member?: string;
  /** DeletionProtection the describe reports. */
  protection?: boolean;
  /** A DescribeGlobalClusters failure. */
  listError?: Error;
  /** A RemoveFromGlobalCluster failure. */
  removeError?: Error;
  /** A ModifyDBCluster failure. */
  modifyError?: Error;
  /** Answer the listing in two pages, the holder on the second. */
  paged?: boolean;
  /** The cluster is the global cluster's writer (primary). */
  writer?: boolean;
  /** Other members' cluster ARNs (secondaries). */
  others?: string[];
  /** A failure of the by-name DescribeGlobalClusters (the pre-detach read). */
  byNameError?: Error;
}

function names(): string[] {
  return rdsSend.mock.calls.map((c) => String(c[0].constructor.name));
}

function inputOf(command: string): Record<string, unknown> | undefined {
  const call = rdsSend.mock.calls.find((c) => c[0].constructor.name === command);
  return call?.[0].input as Record<string, unknown> | undefined;
}

function arm(live: Live = {}): void {
  let member = live.member;
  let deleted = false;
  rdsSend.mockImplementation((cmd) => {
    const name = cmd.constructor.name as string;
    if (name === 'DeleteDBClusterCommand') {
      deleted = true;
      return Promise.resolve({});
    }
    if (name === 'DescribeDBClustersCommand' && deleted) {
      return Promise.reject(awsError('DBClusterNotFoundFault', 'gone'));
    }
    if (name === 'CreateDBClusterCommand') {
      return Promise.resolve({ DBCluster: { DBClusterIdentifier: ID } });
    }
    if (name === 'DescribeDBClustersCommand') {
      return Promise.resolve({
        DBClusters: [
          {
            DBClusterIdentifier: ID,
            DBClusterArn: ARN,
            Status: 'available',
            DeletionProtection: live.protection ?? false,
            DBClusterMembers: [],
          },
        ],
      });
    }
    if (name === 'DescribeGlobalClustersCommand') {
      if (live.listError) return Promise.reject(live.listError);
      const input = cmd.input as { GlobalClusterIdentifier?: string; Marker?: string };
      const wanted = input.GlobalClusterIdentifier;
      const all =
        member === undefined
          ? [{ GlobalClusterIdentifier: 'other-global', GlobalClusterMembers: [] }]
          : [
              { GlobalClusterIdentifier: 'other-global', GlobalClusterMembers: [] },
              {
                GlobalClusterIdentifier: member,
                GlobalClusterMembers: [
                  { DBClusterArn: ARN, IsWriter: live.writer ?? false },
                  ...(live.others ?? []).map((arn) => ({ DBClusterArn: arn, IsWriter: false })),
                ],
              },
            ];
      if (live.byNameError && wanted !== undefined) return Promise.reject(live.byNameError);
      if (live.paged && wanted === undefined) {
        return Promise.resolve(
          input.Marker === 'page-2'
            ? { GlobalClusters: all.slice(1) }
            : { GlobalClusters: all.slice(0, 1), Marker: 'page-2' }
        );
      }
      return Promise.resolve({
        GlobalClusters:
          wanted === undefined ? all : all.filter((g) => g.GlobalClusterIdentifier === wanted),
      });
    }
    if (name === 'RemoveFromGlobalClusterCommand') {
      if (live.removeError) return Promise.reject(live.removeError);
      member = undefined;
      return Promise.resolve({});
    }
    if (name === 'ModifyDBClusterCommand' && live.modifyError) {
      return Promise.reject(live.modifyError);
    }
    return Promise.resolve({});
  });
}

const BASE = { Engine: 'aurora-postgresql', MasterUsername: 'admin' };

describe('RDSProvider DBCluster GlobalClusterIdentifier (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    rdsSend.mockReset();
    provider = new RDSProvider();
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockResolvedValue(undefined);
  });

  describe('create', () => {
    it('sends the global cluster to join on CreateDBCluster', async () => {
      arm();
      await provider.create('Cluster', CLUSTER, { ...BASE, GlobalClusterIdentifier: 'g-1' });
      expect(inputOf('CreateDBClusterCommand')?.['GlobalClusterIdentifier']).toBe('g-1');
    });

    it('sends none for a blank or absent one', async () => {
      arm();
      await provider.create('Cluster', CLUSTER, { ...BASE, GlobalClusterIdentifier: '' });
      await provider.create('Cluster', CLUSTER, { ...BASE });
      const creates = rdsSend.mock.calls.filter(
        (c) => c[0].constructor.name === 'CreateDBClusterCommand'
      );
      expect(creates).toHaveLength(2);
      for (const c of creates) expect(c[0].input).not.toHaveProperty('GlobalClusterIdentifier');
    });

    it('refuses a non-string before any call', async () => {
      arm();
      const error = await provider
        .create('Cluster', CLUSTER, { ...BASE, GlobalClusterIdentifier: 42 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(/GlobalClusterIdentifier must be a string/);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(rdsSend).not.toHaveBeenCalled();
    });

    it('a rollback re-create leaves a non-string out and drops it from the record', async () => {
      arm();
      const result = await provider.create(
        'Cluster',
        CLUSTER,
        { ...BASE, GlobalClusterIdentifier: 42 },
        { replayingState: true }
      );
      expect(inputOf('CreateDBClusterCommand')).not.toHaveProperty('GlobalClusterIdentifier');
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('GlobalClusterIdentifier');
    });
  });

  describe('update', () => {
    const update = (
      desired: Record<string, unknown>,
      previous: Record<string, unknown>,
      context?: Record<string, unknown>
    ) =>
      provider.update('Cluster', ID, CLUSTER, { ...BASE, ...desired }, { ...BASE, ...previous }, context);

    it('an unchanged membership reads no global cluster and detaches nothing', async () => {
      arm({ member: 'g-1' });
      const result = await update({ GlobalClusterIdentifier: 'g-1' }, { GlobalClusterIdentifier: 'g-1' });
      expect(names()).not.toContain('DescribeGlobalClustersCommand');
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each([
      ['removed', {}],
      ['blank', { GlobalClusterIdentifier: '' }],
    ])('a %s one detaches in place before the ModifyDBCluster', async (_label, desired) => {
      // Deletion protection guards only a delete, so it does not block the detach.
      arm({ member: 'g-1', protection: true });
      const result = await update(desired, { GlobalClusterIdentifier: 'g-1' });
      const order = names();
      const remove = order.indexOf('RemoveFromGlobalClusterCommand');
      expect(remove).toBeGreaterThanOrEqual(0);
      expect(remove).toBeLessThan(order.indexOf('ModifyDBClusterCommand'));
      expect(inputOf('RemoveFromGlobalClusterCommand')).toEqual({
        GlobalClusterIdentifier: 'g-1',
        DbClusterIdentifier: ARN,
      });
      expect(inputOf('ModifyDBClusterCommand')).not.toHaveProperty('GlobalClusterIdentifier');
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each([
      ['an add', {}],
      ['a change', { GlobalClusterIdentifier: 'g-0' }],
    ])(
      'refuses %s the live cluster does not show, before any write',
      async (_label, previous) => {
        arm({ member: (previous as { GlobalClusterIdentifier?: string }).GlobalClusterIdentifier });
        const error = await update({ GlobalClusterIdentifier: 'g-1' }, previous).catch(
          (e: unknown) => e
        );
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toMatch(
          /GlobalClusterIdentifier cannot be added or changed on an existing DB cluster/
        );
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(names()).not.toContain('ModifyDBClusterCommand');
        expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      }
    );

    it('keeps the refusal when the membership cannot be read, and says so', async () => {
      arm({ listError: awsError('AccessDenied') });
      await expect(update({ GlobalClusterIdentifier: 'g-1' }, {})).rejects.toThrow(
        /cannot be added or changed.*could not read the cluster's global cluster membership/
      );
      expect(names()).not.toContain('ModifyDBClusterCommand');
    });

    it('accepts an add naming the global cluster the live cluster is already in', async () => {
      arm({ member: 'g-1' });
      const result = await update({ GlobalClusterIdentifier: 'g-1' }, {});
      expect(names()).toContain('ModifyDBClusterCommand');
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      // The desired bag, key included, is what is recorded.
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('refuses a non-string before any write', async () => {
      arm();
      await expect(update({ GlobalClusterIdentifier: ['g-1'] }, {})).rejects.toThrow(
        /GlobalClusterIdentifier must be a string/
      );
      expect(names()).not.toContain('ModifyDBClusterCommand');
    });

    it('a rollback asking to re-join warns, sends nothing for it and records no membership', async () => {
      arm();
      const result = await update(
        { GlobalClusterIdentifier: 'g-1' },
        {},
        { replayingState: true }
      );
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).toContain('ModifyDBClusterCommand');
      expect(warn.mock.calls.flat().join('\n')).toMatch(/never adds an existing cluster/);
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('GlobalClusterIdentifier');
    });

    it('a rollback removal never detaches, and records the restored bag without the key', async () => {
      arm({ member: 'g-1' });
      const result = await update({}, { GlobalClusterIdentifier: 'g-1' }, { replayingState: true });
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(result.effectiveProperties).toBeUndefined();
      expect(warn.mock.calls.flat().join('\n')).toMatch(
        /never detaches on a restore.*a member of global cluster g-1/
      );
      // Re-deploying the restored template against that record detaches nothing.
      rdsSend.mockClear();
      await update({}, {});
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    });

    it('a rollback removal whose membership cannot be read records none and warns', async () => {
      arm({ member: 'g-1', listError: awsError('AccessDenied') });
      const result = await update({}, { GlobalClusterIdentifier: 'g-1' }, { replayingState: true });
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(result.effectiveProperties).toBeUndefined();
      const warned = warn.mock.calls.flat().join('\n');
      expect(warned).toMatch(/never detaches on a restore/);
      expect(warned).not.toMatch(/a member of global cluster/);
    });

    it('a rollback with a non-string warns and keeps the previous membership', async () => {
      arm({ member: 'g-1' });
      const result = await update(
        { GlobalClusterIdentifier: 7 },
        { GlobalClusterIdentifier: 'g-1' },
        { replayingState: true }
      );
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(result.effectiveProperties?.['GlobalClusterIdentifier']).toBe('g-1');
      expect(warn.mock.calls.flat().join('\n')).toMatch(/restored GlobalClusterIdentifier is not a string/);
    });

    it('a rollback of an unchanged membership the cluster lost drops the key from the record', async () => {
      // A forward update failed after its detach: the record still names g-1.
      arm();
      const result = await update(
        { GlobalClusterIdentifier: 'g-1' },
        { GlobalClusterIdentifier: 'g-1' },
        { replayingState: true }
      );
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('GlobalClusterIdentifier');
      expect(warn.mock.calls.flat().join('\n')).toMatch(/no longer a member of global cluster g-1/);
    });

    it('a rollback of an unchanged membership the cluster still holds records it', async () => {
      arm({ member: 'g-1' });
      const result = await update(
        { GlobalClusterIdentifier: 'g-1' },
        { GlobalClusterIdentifier: 'g-1' },
        { replayingState: true }
      );
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('reads every page of global clusters for the membership', async () => {
      arm({ member: 'g-1', paged: true });
      await update({ GlobalClusterIdentifier: 'g-1' }, {});
      expect(names().filter((n) => n === 'DescribeGlobalClustersCommand')).toHaveLength(2);
      expect(names()).toContain('ModifyDBClusterCommand');
    });

    it('a failure after the detach says the cluster is already standalone', async () => {
      arm({ member: 'g-1', modifyError: awsError('InvalidParameterCombination', 'bad') });
      const error = await update({}, { GlobalClusterIdentifier: 'g-1' }).catch((e: unknown) => e);
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
      expect((error as Error).message).toMatch(
        /already detached from its global cluster, and stays a standalone cluster/
      );
    });

    it('a rollback removal of a membership the live cluster does not show records none', async () => {
      arm();
      const result = await update({}, { GlobalClusterIdentifier: 'g-1' }, { replayingState: true });
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('drift --revert, whose readback never carries the key, keeps the record silently', async () => {
      arm({ member: 'g-1' });
      const result = await update(
        {},
        { GlobalClusterIdentifier: 'g-1' },
        { desiredFromAwsReadback: true }
      );
      expect(names()).not.toContain('DescribeGlobalClustersCommand');
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(result.effectiveProperties?.['GlobalClusterIdentifier']).toBe('g-1');
    });

    it('a failed detach fails the update, non-retryable, before the ModifyDBCluster', async () => {
      arm({ member: 'g-1', removeError: awsError('InvalidParameterValue', 'no') });
      const error = await update({}, { GlobalClusterIdentifier: 'g-1' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(
        /^Failed to update DBCluster Cluster: detaching db-1 from global cluster g-1 failed/
      );
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('ModifyDBClusterCommand');
    });
  });

  describe('the primary of a global cluster with other members (go-to-k/cdkd#5853)', () => {
    const SECONDARY = 'arn:aws:rds:us-west-2:111122223333:cluster:sec-1';

    it('an update removal fails at once, naming them, before any write', async () => {
      arm({ member: 'g-1', writer: true, others: [SECONDARY] });
      const error = await provider
        .update('Cluster', ID, CLUSTER, { ...BASE }, { ...BASE, GlobalClusterIdentifier: 'g-1' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(
        /db-1 is the primary of global cluster g-1, which still has other members \(sec-1\); detach or delete them first/
      );
      expect((error as Error).message).not.toContain('111122223333');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).not.toContain('ModifyDBClusterCommand');
    });

    it('a delete fails at once, naming them, without deleting', async () => {
      arm({ member: 'g-1', writer: true, others: [SECONDARY] });
      const error = await provider
        .delete('Cluster', ID, CLUSTER, { ...BASE, GlobalClusterIdentifier: 'g-1' })
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(
        /^Failed to delete DBCluster Cluster: db-1 is the primary of global cluster g-1, which still has other members \(sec-1\)/
      );
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
      expect(names()).not.toContain('DeleteDBClusterCommand');
    });

    it('a lone primary is detached', async () => {
      arm({ member: 'g-1', writer: true });
      await provider.update('Cluster', ID, CLUSTER, { ...BASE }, { ...BASE, GlobalClusterIdentifier: 'g-1' });
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
    });

    it('a secondary beside other members is detached', async () => {
      arm({ member: 'g-1', writer: false, others: [SECONDARY] });
      await provider.update('Cluster', ID, CLUSTER, { ...BASE }, { ...BASE, GlobalClusterIdentifier: 'g-1' });
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
    });

    it('an unreadable member list fails before the detach, non-retryable', async () => {
      arm({ member: 'g-1', byNameError: awsError('AccessDenied', 'no') });
      const error = await provider
        .update('Cluster', ID, CLUSTER, { ...BASE }, { ...BASE, GlobalClusterIdentifier: 'g-1' })
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/could not read the members of global cluster g-1/);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
    });

    it('a busy member read is waited through, then the detach runs', async () => {
      let first = true;
      arm({ member: 'g-1', writer: true });
      const base = rdsSend.getMockImplementation()!;
      rdsSend.mockImplementation((cmd: { constructor: { name: string }; input: unknown }) => {
        if (cmd.constructor.name === 'DescribeGlobalClustersCommand' && first) {
          first = false;
          return Promise.reject(awsError('InvalidGlobalClusterStateFault'));
        }
        return base(cmd);
      });
      await provider.update('Cluster', ID, CLUSTER, { ...BASE }, { ...BASE, GlobalClusterIdentifier: 'g-1' });
      expect(names()).toContain('RemoveFromGlobalClusterCommand');
    });
  });

  it('is a drift-unknown path: readCurrentState never reads it back', () => {
    expect(provider.getDriftUnknownPaths(CLUSTER, { GlobalClusterIdentifier: 'g-1' })).toContain(
      'GlobalClusterIdentifier'
    );
  });

  it('the delete still refuses a protected member before detaching it (#4029)', async () => {
    arm({ member: 'g-1', protection: true });
    await expect(
      provider.delete('Cluster', ID, CLUSTER, { ...BASE, GlobalClusterIdentifier: 'g-1' })
    ).rejects.toThrow(/deletion protection on/);
    expect(names()).not.toContain('RemoveFromGlobalClusterCommand');
  });
});
