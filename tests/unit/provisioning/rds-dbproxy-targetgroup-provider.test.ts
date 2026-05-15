import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
  DBProxyTargetNotFoundFault,
} from '@aws-sdk/client-rds';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::RDS::DBProxyTargetGroup';
const TARGET_GROUP_ARN =
  'arn:aws:rds:us-east-1:123456789012:target-group:prx-tg-09349c65b2d618cdf';

describe('RDSDBProxyTargetGroupProvider', () => {
  let provider: RDSDBProxyTargetGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSDBProxyTargetGroupProvider();
  });

  describe('handledProperties', () => {
    it('declares the user-controllable property set', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled).toBeDefined();
      expect(Array.from(handled!).sort()).toEqual([
        'ConnectionPoolConfigurationInfo',
        'DBClusterIdentifiers',
        'DBInstanceIdentifiers',
        'DBProxyName',
        'TargetGroupName',
      ]);
    });
  });

  describe('create', () => {
    it('registers cluster targets and recovers TargetGroupArn from Describe', async () => {
      mockSend
        // RegisterDBProxyTargets
        .mockResolvedValueOnce({ DBProxyTargets: [{ Type: 'TRACKED_CLUSTER' }] })
        // DescribeDBProxyTargetGroups
        .mockResolvedValueOnce({
          TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN, TargetGroupName: 'default' }],
        });

      const result = await provider.create('TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['my-cluster'],
      });

      expect(result.physicalId).toBe(TARGET_GROUP_ARN);
      expect(result.attributes).toEqual({
        TargetGroupArn: TARGET_GROUP_ARN,
        TargetGroupName: 'default',
      });
      // First call: RegisterDBProxyTargets
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('RegisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[0]![0].input).toEqual({
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['my-cluster'],
        DBInstanceIdentifiers: undefined,
      });
      // Second call: DescribeDBProxyTargetGroups
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe(
        'DescribeDBProxyTargetGroupsCommand'
      );
    });

    it('applies ConnectionPoolConfigurationInfo before registering targets', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyTargetGroup: {} }) // ModifyDBProxyTargetGroup
        .mockResolvedValueOnce({ DBProxyTargets: [] }) // RegisterDBProxyTargets
        .mockResolvedValueOnce({
          TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN, TargetGroupName: 'default' }],
        });

      await provider.create('TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 100 },
        DBInstanceIdentifiers: ['my-instance'],
      });

      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyTargetGroupCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RegisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[2]![0].constructor.name).toBe(
        'DescribeDBProxyTargetGroupsCommand'
      );
    });

    it('rejects when DBProxyName is missing', async () => {
      await expect(
        provider.create('TG', RESOURCE_TYPE, { DBClusterIdentifiers: ['my-cluster'] })
      ).rejects.toThrow(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when Describe returns no TargetGroup', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyTargets: [] })
        .mockResolvedValueOnce({ TargetGroups: [] });

      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['my-cluster'],
        })
      ).rejects.toThrow(/Failed to recover TargetGroupArn/);
    });

    it('skips RegisterDBProxyTargets when no targets supplied', async () => {
      mockSend.mockResolvedValueOnce({
        TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN, TargetGroupName: 'default' }],
      });

      const result = await provider.create('TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
      });

      expect(result.physicalId).toBe(TARGET_GROUP_ARN);
      // Only Describe is called — no Register / Modify.
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe(
        'DescribeDBProxyTargetGroupsCommand'
      );
    });
  });

  describe('update', () => {
    it('throws ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {}, {})
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('issues DeregisterDBProxyTargets with cluster identifiers', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        {
          DBProxyName: 'AuroraProxy',
          TargetGroupName: 'default',
          DBClusterIdentifiers: ['my-cluster'],
        },
        { expectedRegion: 'us-east-1' }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe(
        'DeregisterDBProxyTargetsCommand'
      );
      expect(mockSend.mock.calls[0]![0].input).toEqual({
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['my-cluster'],
        DBInstanceIdentifiers: undefined,
      });
    });

    it('treats DBProxyNotFoundFault as idempotent success (region matches)', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'DBProxy not found', $metadata: {} })
      );

      await expect(
        provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['my-cluster'],
          },
          { expectedRegion: 'us-east-1' }
        )
      ).resolves.not.toThrow();
    });

    it('treats DBProxyTargetGroupNotFoundFault as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyTargetGroupNotFoundFault({
          message: 'TargetGroup not found',
          $metadata: {},
        })
      );

      await expect(
        provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['my-cluster'],
          },
          { expectedRegion: 'us-east-1' }
        )
      ).resolves.not.toThrow();
    });

    it('treats DBProxyTargetNotFoundFault as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyTargetNotFoundFault({ message: 'Target not found', $metadata: {} })
      );

      await expect(
        provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['my-cluster'],
          },
          { expectedRegion: 'us-east-1' }
        )
      ).resolves.not.toThrow();
    });

    it('no-ops cleanly when no targets are registered (nothing to deregister)', async () => {
      await provider.delete(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy' },
        { expectedRegion: 'us-east-1' }
      );

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when DBProxyName is missing from state properties', async () => {
      await expect(
        provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBClusterIdentifiers: ['my-cluster'] },
          { expectedRegion: 'us-east-1' }
        )
      ).rejects.toThrow(/DBProxyName missing from state.properties/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('region mismatch surfaces as ProvisioningError even on NotFound', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'DBProxy not found', $metadata: {} })
      );

      await expect(
        provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['my-cluster'],
          },
          { expectedRegion: 'us-west-2' } // client is us-east-1; mismatch
        )
      ).rejects.toThrow(/does not match stack state region/);
    });

    it('non-NotFound errors propagate as ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('Throttling: rate exceeded'));

      await expect(
        provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['my-cluster'],
          },
          { expectedRegion: 'us-east-1' }
        )
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe('getAttribute', () => {
    it('returns physicalId for TargetGroupArn', async () => {
      const result = await provider.getAttribute(
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        'TargetGroupArn'
      );
      expect(result).toBe(TARGET_GROUP_ARN);
    });

    it('returns "default" for TargetGroupName', async () => {
      const result = await provider.getAttribute(
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        'TargetGroupName'
      );
      expect(result).toBe('default');
    });

    it('returns undefined for unknown attribute', async () => {
      const result = await provider.getAttribute(
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        'Unknown'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('import (explicit-override only)', () => {
    it('returns the override when knownPhysicalId is supplied', async () => {
      const result = await provider.import({
        logicalId: 'TG',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'MyStack/TG',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: TARGET_GROUP_ARN,
      });

      expect(result).toEqual({
        physicalId: TARGET_GROUP_ARN,
        attributes: { TargetGroupArn: TARGET_GROUP_ARN, TargetGroupName: 'default' },
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is missing (no auto-lookup)', async () => {
      const result = await provider.import({
        logicalId: 'TG',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'MyStack/TG',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
