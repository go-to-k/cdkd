import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy, waitForClusterAvailableSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  waitForClusterAvailableSpy: vi.fn(),
}));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';

const RESOURCE_TYPE = 'AWS::RDS::DBCluster';

describe('RDSProvider createDBCluster partial-create cleanup (Issue #376)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    waitForClusterAvailableSpy.mockReset();
    provider = new RDSProvider();
    // Stub the private waitForClusterAvailable so tests don't poll AWS.
    // Per-test mockResolvedValue / mockRejectedValue control behavior.
    (provider as unknown as { waitForClusterAvailable: (id: string) => Promise<void> }).waitForClusterAvailable =
      waitForClusterAvailableSpy;
  });

  it('issues DeleteDBClusterCommand (no wait) when waitForClusterAvailable fails after CreateDBCluster succeeded', async () => {
    mockSend.mockResolvedValueOnce({
      DBCluster: { DBClusterIdentifier: 'my-cluster-xxx', Status: 'creating' },
    }); // CreateDBClusterCommand
    waitForClusterAvailableSpy.mockRejectedValueOnce(
      new Error('Waiter timed out — cluster never reached available state')
    );
    mockSend.mockResolvedValueOnce({}); // DeleteDBClusterCommand cleanup

    await expect(
      provider.create('MyCluster', RESOURCE_TYPE, {
        DBClusterIdentifier: 'my-cluster-xxx',
        Engine: 'aurora-mysql',
        MasterUsername: 'admin',
        MasterUserPassword: 'secret',
      })
    ).rejects.toThrow('Failed to create DBCluster');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['CreateDBClusterCommand', 'DeleteDBClusterCommand']);
    expect(mockSend.mock.calls[1][0].input).toEqual({
      DBClusterIdentifier: 'my-cluster-xxx',
      SkipFinalSnapshot: true,
    });
  });

  it('flips DeletionProtection off BEFORE issuing DeleteDBClusterCommand when template requested protection', async () => {
    mockSend.mockResolvedValueOnce({
      DBCluster: { DBClusterIdentifier: 'my-cluster-xxx' },
    }); // CreateDBClusterCommand
    waitForClusterAvailableSpy.mockRejectedValueOnce(new Error('Waiter failed'));
    mockSend.mockResolvedValueOnce({}); // ModifyDBClusterCommand (disable protection)
    mockSend.mockResolvedValueOnce({}); // DeleteDBClusterCommand

    await expect(
      provider.create('MyCluster', RESOURCE_TYPE, {
        DBClusterIdentifier: 'my-cluster-xxx',
        Engine: 'aurora-mysql',
        DeletionProtection: true,
      })
    ).rejects.toThrow('Failed to create DBCluster');

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual([
      'CreateDBClusterCommand',
      'ModifyDBClusterCommand',
      'DeleteDBClusterCommand',
    ]);
    expect(mockSend.mock.calls[1][0].input).toEqual({
      DBClusterIdentifier: 'my-cluster-xxx',
      DeletionProtection: false,
      ApplyImmediately: true,
    });
  });

  it('does NOT issue cleanup when CreateDBCluster itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('CreateDBCluster boom'));

    await expect(
      provider.create('MyCluster', RESOURCE_TYPE, {
        DBClusterIdentifier: 'my-cluster-xxx',
        Engine: 'aurora-mysql',
      })
    ).rejects.toThrow('Failed to create DBCluster');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateDBClusterCommand');
  });

  it('emits CRITICAL recovery hint (cluster still billing!) when DeleteDBCluster cleanup itself fails', async () => {
    mockSend.mockResolvedValueOnce({
      DBCluster: { DBClusterIdentifier: 'my-cluster-xxx' },
    });
    waitForClusterAvailableSpy.mockRejectedValueOnce(new Error('Waiter timed out (original)'));
    mockSend.mockRejectedValueOnce(new Error('DeleteDBCluster also failed'));

    await expect(
      provider.create('MyCluster', RESOURCE_TYPE, {
        DBClusterIdentifier: 'my-cluster-xxx',
        Engine: 'aurora-mysql',
      })
    ).rejects.toThrow('Waiter timed out (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('THE CLUSTER IS STILL RUNNING AND BILLING');
    expect(warnMsg).toContain('aws rds delete-db-cluster --db-cluster-identifier');
    expect(warnMsg).toContain('my-cluster-xxx');
    expect(warnMsg).toContain('--skip-final-snapshot');
  });

  it('emits ModifyDBCluster recovery command in WARN when template requested DeletionProtection and cleanup failed', async () => {
    mockSend.mockResolvedValueOnce({
      DBCluster: { DBClusterIdentifier: 'my-cluster-xxx' },
    });
    waitForClusterAvailableSpy.mockRejectedValueOnce(new Error('Waiter failed (original)'));
    // Both cleanup sub-calls fail to force the WARN path
    mockSend.mockRejectedValueOnce(new Error('ModifyDB also failed'));
    mockSend.mockRejectedValueOnce(new Error('DeleteDB also failed'));

    await expect(
      provider.create('MyCluster', RESOURCE_TYPE, {
        DBClusterIdentifier: 'my-cluster-xxx',
        Engine: 'aurora-mysql',
        DeletionProtection: true,
      })
    ).rejects.toThrow('Waiter failed (original)');

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0][0]);
    expect(warnMsg).toContain('aws rds modify-db-cluster --db-cluster-identifier');
    expect(warnMsg).toContain('--no-deletion-protection');
    expect(warnMsg).toContain('aws rds delete-db-cluster --db-cluster-identifier');
  });
});
