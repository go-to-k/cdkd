import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  ModifyDBSubnetGroupCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-rds';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
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

/**
 * Round-trip tests for `cdkd drift --revert` against the RDS provider.
 *
 * `drift --revert` round-trips `observedProperties` (= a previous
 * `readCurrentState` snapshot) back through `provider.update`. The risks
 * documented in docs/provider-development.md § 3b ("Read-update round-trip
 * test") are:
 *
 * - **Class 1**: a placeholder always emitted by readCurrentState that AWS
 *   only accepts conditionally on a sibling discriminator. RDS specimen:
 *   `ServerlessV2ScalingConfiguration` (Aurora-Serverless-v2 only).
 * - **Class 2**: a placeholder that's structurally invalid as AWS input
 *   regardless of context. RDS specimens: `VpcSecurityGroupIds: []` (would
 *   CLEAR cluster SGs), `SubnetIds: []` (rejected by ModifyDBSubnetGroup).
 * - **Truthy gate**: an `if (props['X'])` in update() that silently drops
 *   `false` / `0` / `''`. RDS update methods use direct `as ... | undefined`
 *   casts so falsy values do reach AWS — guarded here for regression.
 */
describe('RDSProvider read-update round-trip', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new RDSProvider();
  });

  // ─── DBInstance ───────────────────────────────────────────────────

  it('DBInstance no-drift round-trip is a logical no-op (no AWS-rejection inputs)', async () => {
    // ModifyDBInstance + DescribeDBInstance follow-up (for ARN). Tag diff
    // is empty (state == AWS) so no Add/Remove call fires.
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBInstance
      .mockResolvedValueOnce({
        DBInstances: [{ DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance' }],
      });

    const observed = {
      DBInstanceIdentifier: 'my-instance',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'aurora-postgresql',
      DBClusterIdentifier: 'my-cluster',
      DBSubnetGroupName: 'my-sg',
      PubliclyAccessible: false,
      Tags: [{ Key: 'Foo', Value: 'Bar' }],
    };

    await provider.update(
      'L',
      'my-instance',
      'AWS::RDS::DBInstance',
      observed,
      observed
    );

    // No Add/Remove tag calls (state == AWS).
    const tagAddCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof AddTagsToResourceCommand
    );
    const tagRemoveCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof RemoveTagsFromResourceCommand
    );
    expect(tagAddCalls).toHaveLength(0);
    expect(tagRemoveCalls).toHaveLength(0);
  });

  it('DBInstance round-trip: PubliclyAccessible=false reaches AWS (truthy-gate guard)', async () => {
    // Truthy-gate regression guard: if someone refactors updateDBInstance
    // to `if (props['PubliclyAccessible'])`, false would silently be
    // dropped and `cdkd drift --revert` would report success while AWS
    // stays unchanged. Verify the false value reaches the SDK call.
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBInstances: [{ DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance' }],
      });

    const observed = {
      DBInstanceClass: 'db.t3.micro',
      PubliclyAccessible: false,
    };

    await provider.update(
      'L',
      'my-instance',
      'AWS::RDS::DBInstance',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBInstanceCommand
    );
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as { PubliclyAccessible?: boolean };
    expect(input.PubliclyAccessible).toBe(false);
  });

  // ─── DBCluster ────────────────────────────────────────────────────

  it('Class 1 — DBCluster Aurora-Serverless-v2 round-trip preserves ServerlessV2ScalingConfiguration', async () => {
    // The complement of the next test: a real Aurora Serverless v2
    // cluster legitimately has ServerlessV2ScalingConfiguration, and the
    // round-trip must ship it back to ModifyDBCluster intact.
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBCluster
      .mockResolvedValueOnce({
        DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
      });

    const observed = {
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      EngineVersion: '15.3',
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
      Tags: [{ Key: 'Owner', Value: 'team-a' }],
    };

    await provider.update(
      'L',
      'my-cluster',
      'AWS::RDS::DBCluster',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBClusterCommand
    );
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as {
      ServerlessV2ScalingConfiguration?: { MinCapacity?: number; MaxCapacity?: number };
    };
    expect(input.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 4,
    });
  });

  it('Class 1 — DBCluster (provisioned) round-trip does NOT ship ServerlessV2ScalingConfiguration to AWS', async () => {
    // readCurrentState is now gated to NOT emit ServerlessV2ScalingConfiguration
    // for a provisioned-mode cluster (no Min/Max present in AWS response).
    // Even if a stale state file from before the fix carries the `{}` placeholder,
    // updateDBCluster's defence-in-depth guard must drop it before ModifyDBCluster.
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
      });

    // Stale-state shape: empty placeholder (what the pre-fix readCurrentState
    // would have emitted on a provisioned cluster).
    const observed = {
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      EngineVersion: '15.3',
      ServerlessV2ScalingConfiguration: {} as Record<string, unknown>,
    };

    await provider.update(
      'L',
      'my-cluster',
      'AWS::RDS::DBCluster',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBClusterCommand
    );
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as {
      ServerlessV2ScalingConfiguration?: unknown;
    };
    // AWS rejects ServerlessV2ScalingConfiguration on a provisioned cluster.
    // The guard must skip the field entirely.
    expect(input.ServerlessV2ScalingConfiguration).toBeUndefined();
  });

  it('Class 2 — DBCluster round-trip with empty VpcSecurityGroupIds does NOT ship the field (would clear SGs)', async () => {
    // `ModifyDBClusterCommand({ VpcSecurityGroupIds: [] })` would CLEAR
    // every SG attached to the cluster. readCurrentState always emits
    // `[]` when AWS reports no SGs (cluster on default VPC etc.) — the
    // round-trip must NOT translate that placeholder into a destructive
    // SDK call.
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
      });

    const observed = {
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      VpcSecurityGroupIds: [] as string[],
    };

    await provider.update(
      'L',
      'my-cluster',
      'AWS::RDS::DBCluster',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBClusterCommand
    );
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as { VpcSecurityGroupIds?: string[] };
    expect(input.VpcSecurityGroupIds).toBeUndefined();
  });

  it('DBCluster non-empty VpcSecurityGroupIds DO reach AWS (positive control)', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
      });

    const observed = {
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      VpcSecurityGroupIds: ['sg-1', 'sg-2'],
    };

    await provider.update(
      'L',
      'my-cluster',
      'AWS::RDS::DBCluster',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBClusterCommand
    );
    const input = modifyCall![0].input as { VpcSecurityGroupIds?: string[] };
    expect(input.VpcSecurityGroupIds).toEqual(['sg-1', 'sg-2']);
  });

  it('DBCluster round-trip: BackupRetentionPeriod=0 reaches AWS (truthy-gate guard)', async () => {
    // BackupRetentionPeriod=0 means "no backups" — semantically meaningful.
    // A truthy gate would silently drop it. The current code uses `!= null`
    // which correctly admits 0; this test guards that contract.
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
      });

    const observed = {
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      BackupRetentionPeriod: 0,
    };

    await provider.update(
      'L',
      'my-cluster',
      'AWS::RDS::DBCluster',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBClusterCommand
    );
    const input = modifyCall![0].input as { BackupRetentionPeriod?: number };
    expect(input.BackupRetentionPeriod).toBe(0);
  });

  it('DBCluster round-trip: DeletionProtection=false reaches AWS (truthy-gate guard)', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
      });

    const observed = {
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      DeletionProtection: false,
    };

    await provider.update(
      'L',
      'my-cluster',
      'AWS::RDS::DBCluster',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBClusterCommand
    );
    const input = modifyCall![0].input as { DeletionProtection?: boolean };
    expect(input.DeletionProtection).toBe(false);
  });

  // ─── DBSubnetGroup ────────────────────────────────────────────────

  it('Class 2 — DBSubnetGroup round-trip with empty SubnetIds does NOT ship the field', async () => {
    // ModifyDBSubnetGroup with `SubnetIds: []` is rejected by AWS
    // (DBSubnetGroup requires ≥ 2 subnets in distinct AZs).
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBSubnetGroup
      .mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:aws:rds:us-east-1:123:subgrp:my-sg' }],
      });

    const observed = {
      DBSubnetGroupName: 'my-sg',
      DBSubnetGroupDescription: 'desc',
      SubnetIds: [] as string[],
    };

    await provider.update(
      'L',
      'my-sg',
      'AWS::RDS::DBSubnetGroup',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBSubnetGroupCommand
    );
    expect(modifyCall).toBeDefined();
    const input = modifyCall![0].input as { SubnetIds?: string[] };
    expect(input.SubnetIds).toBeUndefined();
  });

  it('DBSubnetGroup non-empty SubnetIds DO reach AWS (positive control)', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:aws:rds:us-east-1:123:subgrp:my-sg' }],
      });

    const observed = {
      DBSubnetGroupName: 'my-sg',
      DBSubnetGroupDescription: 'desc',
      SubnetIds: ['subnet-1', 'subnet-2'],
    };

    await provider.update(
      'L',
      'my-sg',
      'AWS::RDS::DBSubnetGroup',
      observed,
      observed
    );

    const modifyCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyDBSubnetGroupCommand
    );
    const input = modifyCall![0].input as { SubnetIds?: string[] };
    expect(input.SubnetIds).toEqual(['subnet-1', 'subnet-2']);
  });

  it('DBSubnetGroup no-drift round-trip produces zero tag mutations', async () => {
    mockSend
      .mockResolvedValueOnce({}) // ModifyDBSubnetGroup
      .mockResolvedValueOnce({
        DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:aws:rds:us-east-1:123:subgrp:my-sg' }],
      });

    const observed = {
      DBSubnetGroupName: 'my-sg',
      DBSubnetGroupDescription: 'desc',
      SubnetIds: ['subnet-1', 'subnet-2'],
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    await provider.update(
      'L',
      'my-sg',
      'AWS::RDS::DBSubnetGroup',
      observed,
      observed
    );

    const tagAddCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof AddTagsToResourceCommand
    );
    const tagRemoveCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof RemoveTagsFromResourceCommand
    );
    expect(tagAddCalls).toHaveLength(0);
    expect(tagRemoveCalls).toHaveLength(0);
  });

  // ─── readCurrentState gating (Class 1) ─────────────────────────────

  it('readCurrentState — DBCluster (provisioned mode) does NOT emit ServerlessV2ScalingConfiguration', async () => {
    // When AWS returns no ServerlessV2ScalingConfiguration (provisioned
    // cluster), readCurrentState must NOT emit the `{}` placeholder.
    // Otherwise drift fires false-positive on every provisioned cluster
    // (state has no key) and revert sends an AWS-rejection-shape input.
    mockSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          EngineVersion: '15.3',
          // ServerlessV2ScalingConfiguration intentionally absent.
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'L',
      'AWS::RDS::DBCluster'
    );

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('ServerlessV2ScalingConfiguration');
  });

  it('readCurrentState — DBCluster (Aurora-Serverless-v2) DOES emit ServerlessV2ScalingConfiguration', async () => {
    mockSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'L',
      'AWS::RDS::DBCluster'
    );

    expect(result?.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 4,
    });
  });
});
