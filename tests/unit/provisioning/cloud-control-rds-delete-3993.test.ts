import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #3993: a Cloud Control-routed `AWS::RDS::DBCluster` /
 * `AWS::RDS::DBInstance` is deleted through the SDK `RDSProvider`, never
 * `DeleteResource`, because the RDS registry handlers take a final snapshot
 * whenever Cloud Control leaves `snapshotRequested` null — which is always.
 *
 * The delegate is MOCKED here so each case can pin WHICH path ran; the wire
 * shape the delegate sends is pinned in
 * `rds-provider-delete-automated-backups-3993.test.ts`.
 */

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockRdsDelete = vi.hoisted(() => vi.fn());
const mockRdsCtor = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

const ccRegion = vi.hoisted(() => ({ value: 'us-east-1' as string | undefined }));

vi.mock('../../../src/provisioning/providers/rds-provider.js', () => ({
  RDSProvider: vi.fn().mockImplementation((options?: { region?: string }) => {
    mockRdsCtor(options);
    return { delete: mockRdsDelete };
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve(ccRegion.value) },
    },
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  CloudControlProvider,
  deletesThroughRdsSdk,
} from '../../../src/provisioning/cloud-control-provider.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';
/** What `cdkd destroy` passes for a resource recorded `DeletionPolicy: Delete`. */
const DELETE_POLICY = { deletionPolicy: 'Delete' } as const;

function ccCommandNames(): string[] {
  return mockCloudControlSend.mock.calls.map((c) => String(c[0]?.constructor?.name));
}

/** Cloud Control answers a DeleteResource with a token, then SUCCESS. */
function ccDeleteSucceeds(): void {
  mockCloudControlSend.mockImplementation((cmd) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-1' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    }
    return Promise.resolve({});
  });
}

describe('CloudControlProvider.delete sends RDS clusters and instances to the SDK RDSProvider (issue #3993)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlSend.mockReset();
    mockRdsDelete.mockReset();
    mockRdsDelete.mockResolvedValue(undefined);
    ccRegion.value = 'us-east-1';
    provider = new CloudControlProvider();
  });

  it.each([CLUSTER, INSTANCE])(
    '%s: delegates with every argument forwarded, and issues NO DeleteResource',
    async (type) => {
      const properties = { Engine: 'aurora-mysql', DeleteAutomatedBackups: false };
      const context = { expectedRegion: 'us-east-1', removeProtection: true, ...DELETE_POLICY };

      const result = await provider.delete('Db', 'db-1', type, properties, context);

      expect(result).toBeUndefined();
      expect(mockRdsDelete).toHaveBeenCalledTimes(1);
      expect(mockRdsDelete).toHaveBeenCalledWith('Db', 'db-1', type, properties, context);
      expect(ccCommandNames()).not.toContain('DeleteResourceCommand');
    }
  );

  it("PROPAGATES the delegate's 'skipped' outcome instead of reporting a delete", async () => {
    mockRdsDelete.mockResolvedValue({ outcome: 'skipped', reason: 'could not address it' });

    const result = await provider.delete('Db', 'db-1', CLUSTER, {}, DELETE_POLICY);

    expect(result).toEqual({ outcome: 'skipped', reason: 'could not address it' });
  });

  it("PROPAGATES the delegate's throw", async () => {
    mockRdsDelete.mockRejectedValue(new Error('InvalidDBClusterStateFault: still has members'));

    await expect(provider.delete('Db', 'db-1', CLUSTER, {}, DELETE_POLICY)).rejects.toThrow(
      'InvalidDBClusterStateFault'
    );
    expect(ccCommandNames()).not.toContain('DeleteResourceCommand');
  });

  it('builds ONE delegate per provider, so its --remove-protection latch survives a re-entered delete', async () => {
    await provider.delete('A', 'a', CLUSTER, {}, DELETE_POLICY);
    await provider.delete('B', 'b', INSTANCE, {}, DELETE_POLICY);

    expect(mockRdsCtor).toHaveBeenCalledTimes(1);
    expect(mockRdsDelete).toHaveBeenCalledTimes(2);
  });

  it("pins the delegate's client to the Cloud Control client's region", async () => {
    ccRegion.value = 'eu-west-1';
    await provider.delete('Db', 'db-1', CLUSTER, {}, DELETE_POLICY);

    expect(mockRdsCtor).toHaveBeenCalledWith({ region: 'eu-west-1' });
  });

  it('refuses, before any delegate, when the Cloud Control client region is unresolvable', async () => {
    ccRegion.value = undefined;

    await expect(provider.delete('Db', 'db-1', CLUSTER, {}, DELETE_POLICY)).rejects.toThrow(
      "could not resolve the Cloud Control client's region"
    );
    expect(mockRdsCtor).not.toHaveBeenCalled();
    expect(mockRdsDelete).not.toHaveBeenCalled();
    expect(ccCommandNames()).not.toContain('DeleteResourceCommand');
  });

  it.each([
    ['absent', {}],
    ['Snapshot with --skip-final-snapshot (no identifier)', { deletionPolicy: 'Snapshot' }],
    ['RetainExceptOnCreate', { deletionPolicy: 'RetainExceptOnCreate' }],
  ])(
    'a policy that is not an explicit Delete (%s) keeps Cloud Control and its snapshot',
    async (_label, context) => {
      ccDeleteSucceeds();

      await provider.delete('Db', 'db-1', CLUSTER, {}, context);

      expect(mockRdsDelete).not.toHaveBeenCalled();
      expect(ccCommandNames()).toContain('DeleteResourceCommand');
      expect(warnSpy).not.toHaveBeenCalled();
    }
  );

  it('DeletionPolicy: Snapshot is still refused BEFORE the delegate runs', async () => {
    await expect(
      provider.delete('Db', 'db-1', CLUSTER, {}, {
        finalSnapshotIdentifier: 'snap-1',
        deletionPolicy: 'Snapshot',
      })
    ).rejects.toThrow('requires a final snapshot');
    expect(mockRdsDelete).not.toHaveBeenCalled();
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it('a recorded region that differs from the client is refused BEFORE the delegate runs', async () => {
    await expect(
      provider.delete('Db', 'db-1', CLUSTER, {}, { expectedRegion: 'eu-west-1', ...DELETE_POLICY })
    ).rejects.toThrow();
    expect(mockRdsDelete).not.toHaveBeenCalled();
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it('a global cluster member stays on Cloud Control, with a warning naming the snapshot it leaves', async () => {
    ccDeleteSucceeds();

    const result = await provider.delete(
      'Db',
      'db-1',
      CLUSTER,
      { GlobalClusterIdentifier: 'my-global' },
      DELETE_POLICY
    );

    expect(result).toBeUndefined();
    expect(mockRdsDelete).not.toHaveBeenCalled();
    expect(ccCommandNames()).toContain('DeleteResourceCommand');
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('GlobalClusterIdentifier') && w.includes('db-1'))).toBe(
      true
    );
  });

  it('INVERTED CONTROL: a delegated delete warns nothing', async () => {
    await provider.delete('Db', 'db-1', CLUSTER, {}, DELETE_POLICY);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a type outside the pair keeps Cloud Control (the Neptune cluster is not delegated)', async () => {
    ccDeleteSucceeds();

    await provider.delete('Db', 'db-1', 'AWS::Neptune::DBCluster', {}, DELETE_POLICY);

    expect(mockRdsDelete).not.toHaveBeenCalled();
    expect(ccCommandNames()).toContain('DeleteResourceCommand');
  });
});

describe('deletesThroughRdsSdk', () => {
  it.each([
    [INSTANCE, undefined, true],
    [INSTANCE, { GlobalClusterIdentifier: 'g' }, true],
    [CLUSTER, undefined, true],
    [CLUSTER, {}, true],
    [CLUSTER, { GlobalClusterIdentifier: null }, true],
    [CLUSTER, { GlobalClusterIdentifier: '' }, true],
    [CLUSTER, { GlobalClusterIdentifier: '   ' }, true],
    [CLUSTER, { GlobalClusterIdentifier: 'my-global' }, false],
    [CLUSTER, { GlobalClusterIdentifier: { Ref: 'Global' } }, false],
    [CLUSTER, { GlobalClusterIdentifier: 7 }, false],
    ['AWS::Neptune::DBCluster', undefined, false],
    ['AWS::DocDB::DBCluster', undefined, false],
    ['AWS::RDS::DBSubnetGroup', undefined, false],
  ] as const)('%s with %j -> %s', (type, properties, expected) => {
    expect(
      deletesThroughRdsSdk(type, properties as Record<string, unknown> | undefined)
    ).toBe(expected);
  });
});
