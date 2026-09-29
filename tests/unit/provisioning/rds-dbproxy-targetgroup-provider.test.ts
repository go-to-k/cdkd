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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

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
        'Tags',
        'TargetGroupName',
      ]);
    });
  });

  describe('Tags (issue #4087)', () => {
    const describeOk = {
      TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN, TargetGroupName: 'default' }],
    };
    const names = () => mockSend.mock.calls.map((c) => c[0].constructor.name);

    it('create tags the recovered TargetGroupArn after registering', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyTargets: [] }) // Register
        .mockResolvedValueOnce(describeOk) // Describe
        .mockResolvedValueOnce({}); // AddTagsToResource

      await provider.create('TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        DBClusterIdentifiers: ['my-cluster'],
        Tags: [{ Key: 'team', Value: 'db' }, { Key: 'flag' }],
      });

      expect(names()).toEqual([
        'RegisterDBProxyTargetsCommand',
        'DescribeDBProxyTargetGroupsCommand',
        'AddTagsToResourceCommand',
      ]);
      expect(mockSend.mock.calls[2]![0].input).toEqual({
        ResourceName: TARGET_GROUP_ARN,
        Tags: [
          { Key: 'team', Value: 'db' },
          { Key: 'flag', Value: '' },
        ],
      });
    });

    it('create sends no tag call when Tags is absent or empty', async () => {
      mockSend.mockResolvedValueOnce(describeOk);
      await provider.create('TG', RESOURCE_TYPE, { DBProxyName: 'AuroraProxy', Tags: [] });
      expect(names()).toEqual(['DescribeDBProxyTargetGroupsCommand']);
    });

    it.each([
      ['a non-list', 'team=db', /must be a list/],
      ['an entry without Key', [{ Value: 'x' }], /entry 0 needs a non-empty string Key/],
      ['a non-string Value', [{ Key: 'n', Value: 7 }], /entry 0 \(n\) has a non-string Value/],
    ])('create refuses %s before any call', async (_label, tags, message) => {
      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['my-cluster'],
          Tags: tags,
        })
      ).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a state replay warns, skips tagging and records the bag without Tags', async () => {
      mockSend.mockResolvedValueOnce(describeOk);
      const result = await provider.create(
        'TG',
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy', Tags: 'team=db' },
        { replayingState: true }
      );
      expect(names()).toEqual(['DescribeDBProxyTargetGroupsCommand']);
      expect(result.effectiveProperties).toEqual({ DBProxyName: 'AuroraProxy' });
    });

    it('a template create records nothing extra', async () => {
      mockSend.mockResolvedValueOnce(describeOk).mockResolvedValueOnce({});
      const result = await provider.create('TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        Tags: [{ Key: 'team', Value: 'db' }],
      });
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('a failed tag call deregisters what the create registered and rethrows it', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyTargets: [] }) // Register
        .mockResolvedValueOnce(describeOk) // Describe
        .mockRejectedValueOnce(new Error('AccessDenied: rds:AddTagsToResource')) // AddTags
        .mockResolvedValueOnce({}); // Deregister (cleanup)

      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['my-cluster'],
          Tags: [{ Key: 'team', Value: 'db' }],
        })
      ).rejects.toThrow(/CREATE \(add tags\) failed for TG: AccessDenied/);
      expect(names()[3]).toBe('DeregisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[3]![0].input).toEqual({
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['my-cluster'],
        DBInstanceIdentifiers: undefined,
      });
    });

    it('a failed cleanup keeps the original error and appends the manual command', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyTargets: [] })
        .mockResolvedValueOnce(describeOk)
        .mockRejectedValueOnce(new Error('AccessDenied: rds:AddTagsToResource'))
        .mockRejectedValueOnce(new Error('Throttling'));

      const error = await provider
        .create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          DBInstanceIdentifiers: ['i-1', 'i-2'],
          Tags: [{ Key: 'team', Value: 'db' }],
        })
        .then(
          () => new Error('create resolved'),
          (e: unknown) => e as Error
        );
      expect(error.message).toMatch(/^CREATE \(add tags\) failed for TG: AccessDenied/);
      expect(error.message).toContain(
        'aws rds deregister-db-proxy-targets --db-proxy-name AuroraProxy ' +
          '--target-group-name default --db-instance-identifiers i-1 i-2'
      );
    });

    it('a failed tag call with no registered targets has nothing to retire', async () => {
      mockSend
        .mockResolvedValueOnce(describeOk)
        .mockRejectedValueOnce(new Error('AccessDenied: rds:AddTagsToResource'));
      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          Tags: [{ Key: 'team', Value: 'db' }],
        })
      ).rejects.toThrow(/AccessDenied/);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('update removes dropped keys and adds new or changed ones on the physicalId', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        {
          DBProxyName: 'AuroraProxy',
          Tags: [
            { Key: 'keep', Value: 'same' },
            { Key: 'change', Value: 'new' },
            { Key: 'add', Value: 'x' },
          ],
        },
        {
          DBProxyName: 'AuroraProxy',
          Tags: [
            { Key: 'keep', Value: 'same' },
            { Key: 'change', Value: 'old' },
            { Key: 'drop', Value: 'y' },
          ],
        }
      );
      expect(names()).toEqual(['RemoveTagsFromResourceCommand', 'AddTagsToResourceCommand']);
      expect(mockSend.mock.calls[0]![0].input).toEqual({
        ResourceName: TARGET_GROUP_ARN,
        TagKeys: ['drop'],
      });
      expect(mockSend.mock.calls[1]![0].input).toEqual({
        ResourceName: TARGET_GROUP_ARN,
        Tags: [
          { Key: 'change', Value: 'new' },
          { Key: 'add', Value: 'x' },
        ],
      });
    });

    it('update removes every tag when the template drops Tags', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy' },
        { DBProxyName: 'AuroraProxy', Tags: [{ Key: 'a', Value: '1' }] }
      );
      expect(names()).toEqual(['RemoveTagsFromResourceCommand']);
      expect(mockSend.mock.calls[0]![0].input.TagKeys).toEqual(['a']);
    });

    it('update sends nothing when the tags are unchanged', async () => {
      const props = { DBProxyName: 'AuroraProxy', Tags: [{ Key: 'a', Value: '1' }] };
      await provider.update('TG', TARGET_GROUP_ARN, RESOURCE_TYPE, props, { ...props });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('update refuses a malformed DESIRED list before any call, pool change included', async () => {
      await expect(
        provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80 },
            Tags: { team: 'db' },
          },
          { DBProxyName: 'AuroraProxy', Tags: [{ Key: 'team', Value: 'db' }] }
        )
      ).rejects.toThrow(/Tags must be a list/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('update answers a malformed RECORDED list with adds alone', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy', Tags: [{ Key: 'a', Value: '1' }] },
        { DBProxyName: 'AuroraProxy', Tags: 'garbage' }
      );
      expect(names()).toEqual(['AddTagsToResourceCommand']);
      expect(mockSend.mock.calls[0]![0].input.Tags).toEqual([{ Key: 'a', Value: '1' }]);
    });

    it('readCurrentState emits the user tags from ListTagsForResource on the physicalId', async () => {
      mockSend
        .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupName: 'default' }] })
        .mockResolvedValueOnce({ Targets: [] })
        .mockResolvedValueOnce({
          TagList: [
            { Key: 'team', Value: 'db' },
            { Key: 'aws:cloudformation:stack-name', Value: 'X' },
          ],
        });
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
      });
      expect(mockSend.mock.calls[2]![0].input).toEqual({ ResourceName: TARGET_GROUP_ARN });
      expect(result?.['Tags']).toEqual([{ Key: 'team', Value: 'db' }]);
    });

    it('readCurrentState OMITS Tags when the tag read fails, rather than reporting none', async () => {
      mockSend
        .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupName: 'default' }] })
        .mockResolvedValueOnce({ Targets: [] })
        .mockRejectedValueOnce(new Error('AccessDenied: rds:ListTagsForResource'));
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
      });
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('Tags');
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
    it('rejects when DBProxyName is missing', async () => {
      await expect(
        provider.update('TG', TARGET_GROUP_ARN, RESOURCE_TYPE, {}, {})
      ).rejects.toThrow(/DBProxyName is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when DBProxyName differs (immutable identity)', async () => {
      await expect(
        provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'NewProxy' },
          { DBProxyName: 'OldProxy' }
        )
      ).rejects.toThrow(/DBProxyName is immutable/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when TargetGroupName differs (immutable identity)', async () => {
      await expect(
        provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', TargetGroupName: 'something-else' },
          { DBProxyName: 'AuroraProxy', TargetGroupName: 'default' }
        )
      ).rejects.toThrow(/TargetGroupName is immutable/);
    });

    it('treats `undefined` TargetGroupName as default (no false-positive)', async () => {
      const oldProps = { DBProxyName: 'AuroraProxy', TargetGroupName: 'default' };
      const newProps = { DBProxyName: 'AuroraProxy' }; // no TargetGroupName
      const result = await provider.update('TG', TARGET_GROUP_ARN, RESOURCE_TYPE, newProps, oldProps);
      expect(result.physicalId).toBe(TARGET_GROUP_ARN);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('is a no-op when nothing changed', async () => {
      const props = {
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['c1'],
      };
      const result = await provider.update('TG', TARGET_GROUP_ARN, RESOURCE_TYPE, props, props);
      expect(result.physicalId).toBe(TARGET_GROUP_ARN);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('issues ModifyDBProxyTargetGroup when ConnectionPoolConfigurationInfo changes', async () => {
      mockSend.mockResolvedValueOnce({ DBProxyTargetGroup: {} });
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        {
          DBProxyName: 'AuroraProxy',
          ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80 },
        },
        {
          DBProxyName: 'AuroraProxy',
          ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 50 },
        }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyTargetGroupCommand');
      expect(mockSend.mock.calls[0]![0].input.ConnectionPoolConfig).toEqual({
        MaxConnectionsPercent: 80,
      });
    });

    it('registers added cluster targets and deregisters removed ones', async () => {
      mockSend
        .mockResolvedValueOnce({}) // Deregister old
        .mockResolvedValueOnce({ DBProxyTargets: [] }); // Register new
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['c-new'],
        },
        {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['c-old'],
        }
      );
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DeregisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[0]![0].input.DBClusterIdentifiers).toEqual(['c-old']);
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RegisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[1]![0].input.DBClusterIdentifiers).toEqual(['c-new']);
    });

    it('handles instance targets independently', async () => {
      mockSend.mockResolvedValueOnce({ DBProxyTargets: [] }); // Register
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        {
          DBProxyName: 'AuroraProxy',
          DBInstanceIdentifiers: ['i-1'],
        },
        {
          DBProxyName: 'AuroraProxy',
        }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('RegisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[0]![0].input.DBInstanceIdentifiers).toEqual(['i-1']);
      expect(mockSend.mock.calls[0]![0].input.DBClusterIdentifiers).toBeUndefined();
    });

    it('treats DBProxyTargetNotFoundFault during deregister as idempotent', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyTargetNotFoundFault({ message: 'Target not found', $metadata: {} })
      );
      await expect(
        provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy' },
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['c-gone'],
          }
        )
      ).resolves.toEqual({ physicalId: TARGET_GROUP_ARN, wasReplaced: false });
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
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState', () => {
    it('reverse-maps DescribeDBProxyTargetGroups + DescribeDBProxyTargets to CFn shape', async () => {
      mockSend
        .mockResolvedValueOnce({
          TargetGroups: [
            {
              DBProxyName: 'AuroraProxy',
              TargetGroupName: 'default',
              ConnectionPoolConfig: { MaxConnectionsPercent: 80, IdleClientTimeout: 1800 },
            },
          ],
        })
        .mockResolvedValueOnce({
          Targets: [
            { Type: 'TRACKED_CLUSTER', RdsResourceId: 'my-cluster' },
            { Type: 'RDS_INSTANCE', RdsResourceId: 'my-instance' },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });
      const result = await provider.readCurrentState(
        TARGET_GROUP_ARN,
        'TG',
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy', TargetGroupName: 'default' }
      );
      expect(result).toEqual({
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['my-cluster'],
        DBInstanceIdentifiers: ['my-instance'],
        ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80, IdleClientTimeout: 1800 },
        Tags: [],
      });
    });

    it('returns undefined when state has no DBProxyName (corrupted state)', async () => {
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {});
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined when AWS reports DBProxyNotFound (parent gone)', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        TARGET_GROUP_ARN,
        'TG',
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy' }
      );
      expect(result).toBeUndefined();
    });

    it('omits ConnectionPoolConfigurationInfo when AWS does not return it', async () => {
      mockSend
        .mockResolvedValueOnce({
          TargetGroups: [{ DBProxyName: 'AuroraProxy', TargetGroupName: 'default' }],
        })
        .mockResolvedValueOnce({ Targets: [] })
        .mockResolvedValueOnce({ TagList: [] });
      const result = await provider.readCurrentState(
        TARGET_GROUP_ARN,
        'TG',
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy' }
      );
      expect(result).not.toHaveProperty('ConnectionPoolConfigurationInfo');
      expect(result?.['DBClusterIdentifiers']).toEqual([]);
      expect(result?.['DBInstanceIdentifiers']).toEqual([]);
    });
  });

  describe('drift --revert round-trip', () => {
    it('identical observed-shape on both sides → no SDK call', async () => {
      const observed = {
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['c1'],
        DBInstanceIdentifiers: [],
        ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80 },
      };
      const result = await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        observed,
        observed
      );
      expect(result.physicalId).toBe(TARGET_GROUP_ARN);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('drift on cluster target round-trips: register desired + deregister AWS-current', async () => {
      const observed = {
        DBProxyName: 'AuroraProxy',
        DBClusterIdentifiers: ['c1'],
      };
      const awsCurrent = {
        DBProxyName: 'AuroraProxy',
        DBClusterIdentifiers: ['c-hijacked'],
      };
      mockSend
        .mockResolvedValueOnce({}) // Deregister
        .mockResolvedValueOnce({}); // Register
      await provider.update('TG', TARGET_GROUP_ARN, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DeregisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[0]![0].input.DBClusterIdentifiers).toEqual(['c-hijacked']);
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RegisterDBProxyTargetsCommand');
      expect(mockSend.mock.calls[1]![0].input.DBClusterIdentifiers).toEqual(['c1']);
    });

    it('drift on ConnectionPoolConfig round-trips: ModifyDBProxyTargetGroup', async () => {
      const observed = {
        DBProxyName: 'AuroraProxy',
        ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80 },
      };
      const awsCurrent = {
        DBProxyName: 'AuroraProxy',
        ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 50 },
      };
      mockSend.mockResolvedValueOnce({});
      await provider.update('TG', TARGET_GROUP_ARN, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyTargetGroupCommand');
      expect(mockSend.mock.calls[0]![0].input.ConnectionPoolConfig).toEqual({
        MaxConnectionsPercent: 80,
      });
    });
  });
});
