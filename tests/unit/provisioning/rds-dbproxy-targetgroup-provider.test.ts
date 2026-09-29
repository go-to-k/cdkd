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

import {
  MALFORMED_TARGETS_SKIP_REASON,
  NON_DEFAULT_GROUP_SKIP_REASON,
  RDSDBProxyTargetGroupProvider,
} from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import { getLogger } from '../../../src/utils/logger.js';
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
      ['a non-list', 'team=db', /Tags of AWS::RDS::DBProxyTargetGroup TG is not a list of tags/],
      ['an entry without Key', [{ Value: 'x' }], /is not a list of tags/],
      ['a null Value', [{ Key: 'n', Value: null }], /is not a list of tags/],
      [
        'a secret-derived Key',
        [{ Key: '{{resolve:secretsmanager:k}}', Value: 'x' }],
        /holds a dynamic reference or its mask where a tag key belongs/,
      ],
    ])('create refuses %s before any call (issue #4122)', async (_label, tags, message) => {
      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['my-cluster'],
          Tags: tags,
        })
      ).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('create sends a scalar Value as a string, as CloudFormation coerces it (issue #4122)', async () => {
      mockSend.mockResolvedValueOnce(describeOk).mockResolvedValueOnce({});
      await provider.create('TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        Tags: [
          { Key: 'n', Value: 7 },
          { Key: 'b', Value: true },
        ],
      });
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([
        { Key: 'n', Value: '7' },
        { Key: 'b', Value: 'true' },
      ]);
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

    it.each([
      ['a failed Describe', () => mockSend.mockRejectedValueOnce(new Error('Throttling'))],
      ['a Describe with no ARN', () => mockSend.mockResolvedValueOnce({ TargetGroups: [] })],
    ])('%s after registering retires the registration', async (_label, primeDescribe) => {
      mockSend.mockResolvedValueOnce({ DBProxyTargets: [] }); // Register
      primeDescribe();
      mockSend.mockResolvedValueOnce({}); // Deregister (cleanup)
      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: 'AuroraProxy',
          DBClusterIdentifiers: ['my-cluster'],
        })
      ).rejects.toThrow(ProvisioningError);
      expect(names()).toEqual([
        'RegisterDBProxyTargetsCommand',
        'DescribeDBProxyTargetGroupsCommand',
        'DeregisterDBProxyTargetsCommand',
      ]);
    });

    it('update never untags a recorded secret-derived key, and says so without naming it (issue #4122)', async () => {
      const { getLogger } = await import('../../../src/utils/logger.js');
      const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
      warn.mockClear();
      mockSend.mockResolvedValueOnce({}); // RemoveTags (the plain key only)
      await provider.update(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy' },
        {
          DBProxyName: 'AuroraProxy',
          Tags: [
            { Key: '{{resolve:ssm:SECRETKEY}}', Value: 'v' },
            { Key: 'plain', Value: 'v' },
          ],
        }
      );
      expect(names()).toEqual(['RemoveTagsFromResourceCommand']);
      expect(mockSend.mock.calls[0]![0].input.TagKeys).toEqual(['plain']);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('cannot name');
      expect(lines[0]).not.toContain('SECRETKEY');
    });

    it('the replay warning names no tag content', async () => {
      const { getLogger } = await import('../../../src/utils/logger.js');
      const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
      warn.mockClear();
      mockSend.mockResolvedValueOnce(describeOk);
      await provider.create(
        'TG',
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy', Tags: [{ Key: 'SECRETKEY', Value: null }] },
        { replayingState: true }
      );
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('SECRETKEY');
      expect(lines[0]).toContain('is not a list of tags');
    });

    it('the replay warning gives the secret-derived-key reason without the key', async () => {
      const { getLogger } = await import('../../../src/utils/logger.js');
      const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
      warn.mockClear();
      mockSend.mockResolvedValueOnce(describeOk);
      await provider.create(
        'TG',
        RESOURCE_TYPE,
        { DBProxyName: 'AuroraProxy', Tags: [{ Key: '{{resolve:ssm:SECRETKEY}}', Value: 'v' }] },
        { replayingState: true }
      );
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('holds a dynamic reference or its mask');
      expect(lines[0]).not.toContain('SECRETKEY');
    });

    it('update refuses a wrong-region client before any call', async () => {
      await expect(
        provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy' },
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['c-gone'] },
          { expectedRegion: 'us-west-2' }
        )
      ).rejects.toThrow(/Refusing to update TG .*does not match stack state region/);
      expect(mockSend).not.toHaveBeenCalled();
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
      ).rejects.toThrow(/desired Tags of AWS::RDS::DBProxyTargetGroup TG is not a list of tags/);
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

    it.each([
      ['an object', { Ref: 'Proxy' }],
      ['a number', 7],
      ['an empty string', ''],
    ])('reads a DBProxyName holding %s as missing, before any call', async (_label, name) => {
      await expect(
        provider.create('TG', RESOURCE_TYPE, {
          DBProxyName: name,
          DBClusterIdentifiers: ['my-cluster'],
        })
      ).rejects.toThrow(/DBProxyName is required/);
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

    it.each([
      ['an object', { Ref: 'Proxy' }],
      ['a number', 7],
    ])('reads a desired DBProxyName holding %s as missing, before any call', async (_label, name) => {
      await expect(
        provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: name, DBClusterIdentifiers: ['c1'] },
          { DBProxyName: name, DBClusterIdentifiers: ['c2'] }
        )
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

    it('reads a non-string DBProxyName as missing', async () => {
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: { Ref: 'x' },
      });
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('reports a live id in its recorded spelling when they differ only in case (no phantom drift)', async () => {
      mockSend.mockResolvedValueOnce({ TargetGroups: [{}] }).mockResolvedValueOnce({
        Targets: [
          { Type: 'TRACKED_CLUSTER', RdsResourceId: 'mycluster' },
          { Type: 'TRACKED_CLUSTER', RdsResourceId: 'othercluster' },
        ],
      });
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        DBClusterIdentifiers: ['MyCluster'],
      });
      // A real extra target keeps AWS's spelling, so real drift still shows.
      expect(result?.['DBClusterIdentifiers']).toEqual(['MyCluster', 'othercluster']);
    });

    it('applies the recorded spelling to DBInstanceIdentifiers too', async () => {
      mockSend.mockResolvedValueOnce({ TargetGroups: [{}] }).mockResolvedValueOnce({
        Targets: [{ Type: 'RDS_INSTANCE', RdsResourceId: 'mydb' }],
      });
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        DBInstanceIdentifiers: ['MyDb'],
      });
      expect(result?.['DBInstanceIdentifiers']).toEqual(['MyDb']);
    });

    it('keeps the live spelling when the recorded list is malformed', async () => {
      mockSend.mockResolvedValueOnce({ TargetGroups: [{}] }).mockResolvedValueOnce({
        Targets: [{ Type: 'TRACKED_CLUSTER', RdsResourceId: 'mycluster' }],
      });
      // A string recorded list is malformed, so it offers no spelling to adopt:
      // walking it would compare against its characters.
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        DBClusterIdentifiers: 'MyCluster',
      });
      expect(result?.['DBClusterIdentifiers']).toEqual(['mycluster']);
    });

    it('reads every page of targets and leaves a tracked cluster member out of the instance list', async () => {
      mockSend
        .mockResolvedValueOnce({ TargetGroups: [{ ConnectionPoolConfig: {} }] })
        .mockResolvedValueOnce({
          Targets: [
            { Type: 'TRACKED_CLUSTER', RdsResourceId: 'my-cluster' },
            { Type: 'RDS_INSTANCE', RdsResourceId: 'my-cluster-w1', TrackedClusterId: 'my-cluster' },
          ],
          Marker: 'page-2',
        })
        .mockResolvedValueOnce({
          Targets: [{ Type: 'RDS_INSTANCE', RdsResourceId: 'standalone-db' }],
        });
      const result = await provider.readCurrentState(TARGET_GROUP_ARN, 'TG', RESOURCE_TYPE, {
        DBProxyName: 'AuroraProxy',
        TargetGroupName: { Ref: 'x' },
      });
      expect(mockSend.mock.calls[2]![0].input).toEqual({
        DBProxyName: 'AuroraProxy',
        TargetGroupName: 'default',
        Marker: 'page-2',
      });
      expect(result).toMatchObject({
        TargetGroupName: 'default',
        DBClusterIdentifiers: ['my-cluster'],
        DBInstanceIdentifiers: ['standalone-db'],
      });
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

  // go-to-k/cdkd#3945: a target list that is not a list of RDS identifiers used
  // to be cast to `string[]`, so `update()` walked a string by character.
  describe('target lists that are not lists of RDS identifiers', () => {
    const MALFORMED: Array<[string, unknown]> = [
      ['a string', 'prod-cluster'],
      ['an object', { 0: 'prod-cluster' }],
      ['a non-identifier entry', ['prod-cluster', 'bad id']],
      ['a non-string entry', ['prod-cluster', 7]],
      ['an empty-string entry', ['']],
      ['an entry past the 63-character cap', ['a'.repeat(64)]],
      ['an entry starting with a digit', ['1cluster']],
    ];

    describe('update', () => {
      it.each(MALFORMED)(
        'refuses %s on the DESIRED side before any call (the rollback-desired case)',
        async (_label, value) => {
          await expect(
            provider.update(
              'TG',
              TARGET_GROUP_ARN,
              RESOURCE_TYPE,
              // A pool change too: the refusal must precede ModifyDBProxyTargetGroup.
              {
                DBProxyName: 'AuroraProxy',
                DBClusterIdentifiers: value,
                ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80 },
              },
              { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['prod-cluster'] }
            )
          ).rejects.toThrow(
            /desired DBClusterIdentifiers of AWS::RDS::DBProxyTargetGroup TG is not a list of RDS DB identifiers — no target registered or deregistered, and the connection pool left unchanged$/
          );
          expect(mockSend).not.toHaveBeenCalled();
        }
      );

      it('accepts an identifier at the 63-character cap', async () => {
        const longest = `a${'b'.repeat(62)}`;
        mockSend.mockResolvedValueOnce({ DBProxyTargets: [] });
        await provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: [longest] },
          { DBProxyName: 'AuroraProxy' }
        );
        expect(mockSend.mock.calls[0]![0].input.DBClusterIdentifiers).toEqual([longest]);
      });

      it('compares identifiers case-insensitively (RDS stores them lowercased)', async () => {
        await provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['MyCluster'] },
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['mycluster'] }
        );
        expect(mockSend).not.toHaveBeenCalled();
      });

      it.each(MALFORMED)(
        'refuses %s on the RECORDED side before any call, naming the state repair',
        async (_label, value) => {
          const error = await provider
            .update(
              'TG',
              TARGET_GROUP_ARN,
              RESOURCE_TYPE,
              { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: ['prod-db'] },
              { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: value }
            )
            .catch((e: unknown) => e);
          expect(error).toBeInstanceOf(ProvisioningError);
          expect((error as Error).message).toContain(
            'recorded DBInstanceIdentifiers of AWS::RDS::DBProxyTargetGroup TG is not a list'
          );
          expect((error as Error).message).toContain(
            'repair the recorded DBInstanceIdentifiers in state.json'
          );
          expect(mockSend).not.toHaveBeenCalled();
        }
      );

      it('names every malformed side in one refusal', async () => {
        await expect(
          provider.update(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: 'a' },
            { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: 'b' }
          )
        ).rejects.toThrow(/desired DBClusterIdentifiers \/ recorded DBInstanceIdentifiers of/);
        expect(mockSend).not.toHaveBeenCalled();
      });

      const SECRET_DERIVED: Array<[string, unknown]> = [
        ['a dynamic reference', ['{{resolve:secretsmanager:cluster-id}}']],
        ["cdkd's mask", ['***']],
        ['a non-array dynamic reference', '{{resolve:ssm:cluster-id}}'],
      ];

      it.each(SECRET_DERIVED)(
        'reads a recorded list holding %s from the proxy, add-only',
        async (_label, recorded) => {
          const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
          warn.mockClear();
          mockSend
            // DescribeDBProxyTargets: the proxy holds the desired target plus
            // one the template does not declare.
            .mockResolvedValueOnce({
              Targets: [
                { Type: 'TRACKED_CLUSTER', RdsResourceId: 'prod-cluster' },
                { Type: 'TRACKED_CLUSTER', RdsResourceId: 'elsewhere-cluster' },
                {
                  Type: 'RDS_INSTANCE',
                  RdsResourceId: 'prod-cluster-w1',
                  TrackedClusterId: 'prod-cluster',
                },
              ],
            })
            .mockResolvedValueOnce({}) // ModifyDBProxyTargetGroup
            .mockResolvedValueOnce({ DBProxyTargets: [] }); // Register
          await provider.update(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            {
              DBProxyName: 'AuroraProxy',
              // Mixed case: the proxy reports `prod-cluster` lowercased, and
              // the pair must read as one target (no Register for it).
              DBClusterIdentifiers: ['Prod-Cluster', 'added-cluster'],
              ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 90 },
            },
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: recorded }
          );
          const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
          expect(names).toEqual([
            'DescribeDBProxyTargetsCommand',
            'ModifyDBProxyTargetGroupCommand',
            'RegisterDBProxyTargetsCommand',
          ]);
          expect(mockSend.mock.calls[0]![0].input).toEqual({
            DBProxyName: 'AuroraProxy',
            TargetGroupName: 'default',
          });
          // Nothing is deregistered on the live list's evidence, and only the
          // target the proxy lacks is registered.
          expect(mockSend.mock.calls[2]![0].input.DBClusterIdentifiers).toEqual(['added-cluster']);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0]![0])).toContain(
            'the proxy also holds 1 target(s) the template does not declare'
          );
          expect(String(warn.mock.calls[0]![0])).not.toContain('elsewhere-cluster');
        }
      );

      it('refuses, with no live read, a recorded bag where only ONE malformed list is secret-derived', async () => {
        const error = await provider
          .update(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            {
              DBProxyName: 'AuroraProxy',
              DBClusterIdentifiers: ['prod-cluster'],
              DBInstanceIdentifiers: ['prod-db'],
            },
            {
              DBProxyName: 'AuroraProxy',
              DBClusterIdentifiers: ['***'],
              DBInstanceIdentifiers: 'prod-db',
            }
          )
          .catch((e: unknown) => e);
        const message = (error as Error).message;
        expect(message).toContain(
          'recorded DBClusterIdentifiers / recorded DBInstanceIdentifiers of AWS::RDS::DBProxyTargetGroup TG'
        );
        expect(message).toContain('repair the recorded DBInstanceIdentifiers in state.json');
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('does not count a tracked cluster member as an undeclared target when reading a secret-derived instance list', async () => {
        const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
        warn.mockClear();
        mockSend.mockResolvedValueOnce({
          Targets: [
            { Type: 'TRACKED_CLUSTER', RdsResourceId: 'prod-cluster' },
            { Type: 'RDS_INSTANCE', RdsResourceId: 'prod-cluster-w1', TrackedClusterId: 'prod-cluster' },
          ],
        });
        await provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: [] },
          { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: ['***'] }
        );
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
      });

      it('refuses a secret-derived recorded list the proxy cannot be read for', async () => {
        mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
        await expect(
          provider.update(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['prod-cluster'] },
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['***'] }
          )
        ).rejects.toThrow(
          /recorded DBClusterIdentifiers of AWS::RDS::DBProxyTargetGroup TG is secret-derived and could not be read from the proxy/
        );
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('refuses a secret-derived recorded list while the desired side is malformed, without the state-edit repair', async () => {
        const error = await provider
          .update(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: 'prod-cluster' },
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['***'] }
          )
          .catch((e: unknown) => e);
        const message = (error as Error).message;
        expect(message).toContain('recorded DBClusterIdentifiers is secret-derived');
        expect(message).toContain('cdkd reads it from the proxy instead');
        expect(message).not.toContain('repair the recorded');
        expect(mockSend).not.toHaveBeenCalled();
      });

      it.each([
        ['recorded', { DBClusterIdentifiers: ['prod-cluster'] }, { DBClusterIdentifiers: null }],
        ['desired', { DBClusterIdentifiers: null }, { DBClusterIdentifiers: ['prod-cluster'] }],
      ])('reads null on the %s side as an absent list', async (side, desired, recorded) => {
        mockSend.mockResolvedValueOnce({});
        await provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', ...desired },
          { DBProxyName: 'AuroraProxy', ...recorded }
        );
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0]![0].constructor.name).toBe(
          side === 'recorded' ? 'RegisterDBProxyTargetsCommand' : 'DeregisterDBProxyTargetsCommand'
        );
        expect(mockSend.mock.calls[0]![0].input.DBClusterIdentifiers).toEqual(['prod-cluster']);
      });

      it('sends exactly the diff for a well-formed rollback-desired list', async () => {
        mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({ DBProxyTargets: [] });
        await provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          // Desired = the recorded bag a rollback revert replays.
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['prod-cluster'],
            DBInstanceIdentifiers: ['a'],
          },
          {
            DBProxyName: 'AuroraProxy',
            DBClusterIdentifiers: ['prod-cluster', 'new-cluster'],
            DBInstanceIdentifiers: ['b'],
          }
        );
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0]![0].constructor.name).toBe(
          'DeregisterDBProxyTargetsCommand'
        );
        expect(mockSend.mock.calls[0]![0].input).toEqual({
          DBProxyName: 'AuroraProxy',
          TargetGroupName: 'default',
          DBClusterIdentifiers: ['new-cluster'],
          DBInstanceIdentifiers: ['b'],
        });
        expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RegisterDBProxyTargetsCommand');
        expect(mockSend.mock.calls[1]![0].input).toEqual({
          DBProxyName: 'AuroraProxy',
          TargetGroupName: 'default',
          DBClusterIdentifiers: undefined,
          DBInstanceIdentifiers: ['a'],
        });
      });

      it('routes the identifiers in its debug lines through the masker', async () => {
        const debug = getLogger().child('x').debug as ReturnType<typeof vi.fn>;
        debug.mockClear();
        mockSend
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ DBProxyTargets: [] });
        await provider.update(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'secproxy',
            DBClusterIdentifiers: ['sec'],
            ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 90 },
          },
          { DBProxyName: 'secproxy', DBClusterIdentifiers: ['old-sec'] },
          { maskSecrets: (t: string) => t.replace(/sec/g, '***') }
        );
        const lines = debug.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.startsWith('Updating connection pool config'))).toBe(true);
        expect(lines.some((l) => l.startsWith('Deregistering targets'))).toBe(true);
        expect(lines.some((l) => l.startsWith('Registering targets'))).toBe(true);
        expect(lines.join('\n')).not.toContain('sec');
      });
    });

    describe('create', () => {
      it.each(MALFORMED)('refuses %s before any call', async (_label, value) => {
        await expect(
          provider.create('TG', RESOURCE_TYPE, {
            DBProxyName: 'AuroraProxy',
            DBInstanceIdentifiers: value,
            ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 80 },
          })
        ).rejects.toThrow(
          /DBInstanceIdentifiers of AWS::RDS::DBProxyTargetGroup TG is not a list of RDS DB identifiers/
        );
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('masks the identifiers in its register debug line', async () => {
        const debug = getLogger().child('x').debug as ReturnType<typeof vi.fn>;
        debug.mockClear();
        mockSend.mockResolvedValueOnce({ DBProxyTargets: [] }).mockResolvedValueOnce({
          TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN }],
        });
        await provider.create(
          'TG',
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: ['sec'] },
          { maskSecrets: (t: string) => t.replace(/sec/g, '***') }
        );
        const lines = debug.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.startsWith('Registering targets'))).toBe(true);
        expect(lines.join('\n')).not.toContain('sec');
      });
    });

    describe('delete', () => {
      it.each(MALFORMED)(
        'skips %s with no deregistration when the group still exists, keeping the record',
        async (_label, value) => {
          const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
          warn.mockClear();
          mockSend.mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TARGET_GROUP_ARN }] });
          const result = await provider.delete(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: value },
            { expectedRegion: 'us-east-1' }
          );
          expect(result).toEqual({ outcome: 'skipped', reason: MALFORMED_TARGETS_SKIP_REASON });
          expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toEqual([
            'DescribeDBProxyTargetGroupsCommand',
          ]);
          expect(mockSend.mock.calls[0]![0].input).toEqual({
            DBProxyName: 'AuroraProxy',
            TargetGroupName: 'default',
          });
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0]![0])).toContain(
            'holds a DBClusterIdentifiers that is not a list of RDS DB identifiers'
          );
        }
      );

      it('keeps the skip when the existence probe fails for another reason', async () => {
        mockSend.mockRejectedValueOnce(new Error('Throttling'));
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: 'prod-cluster' },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toEqual({ outcome: 'skipped', reason: MALFORMED_TARGETS_SKIP_REASON });
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['proxy', () => new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })],
        [
          'target group',
          () => new DBProxyTargetGroupNotFoundFault({ message: 'gone', $metadata: {} }),
        ],
      ])('finishes the delete when the %s is already gone', async (_label, fault) => {
        mockSend.mockRejectedValueOnce(fault());
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: 'prod-cluster' },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toBeUndefined();
        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('does not read a gone proxy as success in the wrong region', async () => {
        mockSend.mockRejectedValueOnce(
          new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
        );
        await expect(
          provider.delete(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: 'prod-cluster' },
            { expectedRegion: 'eu-west-1' }
          )
        ).rejects.toThrow(ProvisioningError);
      });

      it.each([
        ['an object', { Ref: 'Proxy' }],
        ['a number', 7],
      ])('reads a DBProxyName holding %s as missing', async (_label, name) => {
        await expect(
          provider.delete(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: name, DBClusterIdentifiers: ['prod-cluster'] },
            { expectedRegion: 'us-east-1' }
          )
        ).rejects.toThrow(/DBProxyName missing from state.properties/);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it.each([
        // The well-formed row is the hazard itself: a Deregister against the
        // bogus group answers NotFound, which the catch reads as "gone".
        ['a well-formed', ['prod-cluster']],
        ['a malformed', 'prod-cluster'],
      ])(
        'skips a recorded TargetGroupName other than default while the proxy exists, with %s list, never deregistering',
        async (_label, clusters) => {
          const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
          warn.mockClear();
          mockSend.mockResolvedValueOnce({ TargetGroups: [] });
          const result = await provider.delete(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            {
              DBProxyName: 'AuroraProxy',
              TargetGroupName: 'foo',
              DBClusterIdentifiers: clusters,
            },
            { expectedRegion: 'us-east-1' }
          );
          expect(result).toEqual({ outcome: 'skipped', reason: NON_DEFAULT_GROUP_SKIP_REASON });
          // Only the proxy-existence probe, naming the PROXY alone — never the
          // bogus group, whose NotFound would prove nothing.
          expect(mockSend).toHaveBeenCalledTimes(1);
          expect(mockSend.mock.calls[0]![0].constructor.name).toBe(
            'DescribeDBProxyTargetGroupsCommand'
          );
          expect(mockSend.mock.calls[0]![0].input).toEqual({ DBProxyName: 'AuroraProxy' });
          expect(warn).toHaveBeenCalledTimes(1);
          expect(String(warn.mock.calls[0]![0])).toContain(
            "holds a TargetGroupName other than 'default'"
          );
        }
      );

      it.each([
        ['a missing', undefined],
        ['a non-string', { Ref: 'Proxy' }],
      ])(
        'finishes a default-group record naming no target, with %s DBProxyName, with no call',
        async (_label, name) => {
          const result = await provider.delete(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: name, DBClusterIdentifiers: [] },
            { expectedRegion: 'us-east-1' }
          );
          expect(result).toBeUndefined();
          expect(mockSend).not.toHaveBeenCalled();
        }
      );

      it('finishes a non-default record that names no target, with no call (pre-PR behaviour)', async () => {
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', TargetGroupName: 'foo' },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toBeUndefined();
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('finishes a non-default record once its proxy is gone (region-gated)', async () => {
        mockSend.mockRejectedValueOnce(new DBProxyNotFoundFault({ message: 'gone', $metadata: {} }));
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', TargetGroupName: 'foo', DBClusterIdentifiers: ['c1'] },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toBeUndefined();
        mockSend.mockRejectedValueOnce(new DBProxyNotFoundFault({ message: 'gone', $metadata: {} }));
        await expect(
          provider.delete(
            'TG',
            TARGET_GROUP_ARN,
            RESOURCE_TYPE,
            { DBProxyName: 'AuroraProxy', TargetGroupName: 'foo', DBClusterIdentifiers: ['c1'] },
            { expectedRegion: 'eu-west-1' }
          )
        ).rejects.toThrow(ProvisioningError);
      });

      it('keeps skipping a non-default record on a target-group NotFound, which proves nothing', async () => {
        mockSend.mockRejectedValueOnce(
          new DBProxyTargetGroupNotFoundFault({ message: 'gone', $metadata: {} })
        );
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', TargetGroupName: 'foo', DBClusterIdentifiers: ['c1'] },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toEqual({ outcome: 'skipped', reason: NON_DEFAULT_GROUP_SKIP_REASON });
      });

      it('logs, at debug, why a failed existence probe keeps the skip', async () => {
        const debug = getLogger().child('x').debug as ReturnType<typeof vi.fn>;
        debug.mockClear();
        const throttled = new Error('Rate exceeded');
        throttled.name = 'ThrottlingException';
        mockSend.mockRejectedValueOnce(throttled);
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBClusterIdentifiers: 'prod-cluster' },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toEqual({ outcome: 'skipped', reason: MALFORMED_TARGETS_SKIP_REASON });
        const lines = debug.mock.calls.map((c) => String(c[0]));
        expect(
          lines.some(
            (l) =>
              l.includes('Could not confirm whether the proxy') &&
              l.includes('ThrottlingException')
          )
        ).toBe(true);
      });

      it('addresses the default group, not a stringified object, for a non-string TargetGroupName', async () => {
        mockSend.mockResolvedValueOnce({});
        await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          {
            DBProxyName: 'AuroraProxy',
            TargetGroupName: { Ref: 'x' },
            DBClusterIdentifiers: ['prod-cluster'],
          },
          { expectedRegion: 'us-east-1' }
        );
        expect(mockSend.mock.calls[0]![0].input.TargetGroupName).toBe('default');
      });

      it('reads a null list as no targets', async () => {
        const result = await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: null },
          { expectedRegion: 'us-east-1' }
        );
        expect(result).toBeUndefined();
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('deregisters exactly a well-formed instance list', async () => {
        mockSend.mockResolvedValueOnce({});
        await provider.delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { DBProxyName: 'AuroraProxy', DBInstanceIdentifiers: ['a', 'prod-db'] },
          { expectedRegion: 'us-east-1' }
        );
        expect(mockSend.mock.calls[0]![0].input).toEqual({
          DBProxyName: 'AuroraProxy',
          TargetGroupName: 'default',
          DBClusterIdentifiers: undefined,
          DBInstanceIdentifiers: ['a', 'prod-db'],
        });
      });
    });
  });

  // go-to-k/cdkd#3136: the missing-DBProxyName remedy names the recorded
  // TargetGroupName in a command the operator is told to run.
  describe('missing-DBProxyName remedy command', () => {
    const remedyFor = async (targetGroupName: unknown): Promise<string> => {
      const error = await provider
        .delete(
          'TG',
          TARGET_GROUP_ARN,
          RESOURCE_TYPE,
          { TargetGroupName: targetGroupName, DBClusterIdentifiers: ['my-cluster'] },
          { expectedRegion: 'us-east-1' }
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
      return (error as Error).message;
    };

    it('prints a plain name bare and quotes the proxy-name hole', async () => {
      const message = await remedyFor('default');
      expect(message).toContain(
        "aws rds deregister-db-proxy-targets --db-proxy-name '<proxy-name>' --target-group-name default"
      );
    });

    it('names the default group for a non-string TargetGroupName', async () => {
      const message = await remedyFor({ Ref: 'x' });
      expect(message).toContain('--target-group-name default');
    });

    // A record-chosen group name never reaches the pasted command: any name
    // other than `default` takes the non-default skip first, so a name built to
    // break out of quoting, forge a line or pass as an option pastes nothing.
    it.each([
      ['a quote', "x'; rm -rf ~ #"],
      ['a line break', 'a\nb'],
      ['an ESC byte', 'a\u001b[31mb'],
      ['a non-ASCII character', 'café'],
      ['a leading -, which the CLI would read as an option', '--debug'],
    ])('pastes no command for a group name holding %s', async (_label, name) => {
      const warn = getLogger().child('x').warn as ReturnType<typeof vi.fn>;
      warn.mockClear();
      const result = await provider.delete(
        'TG',
        TARGET_GROUP_ARN,
        RESOURCE_TYPE,
        { TargetGroupName: name, DBClusterIdentifiers: ['my-cluster'] },
        { expectedRegion: 'us-east-1' }
      );
      expect(result).toEqual({ outcome: 'skipped', reason: NON_DEFAULT_GROUP_SKIP_REASON });
      expect(mockSend).not.toHaveBeenCalled();
      // The one message is the non-default skip, which pastes no command; the
      // remedy that would have pasted one never ran.
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0]![0]);
      expect(said).toContain("holds a TargetGroupName other than 'default'");
      expect(said).not.toContain('aws rds');
    });
  });
});
