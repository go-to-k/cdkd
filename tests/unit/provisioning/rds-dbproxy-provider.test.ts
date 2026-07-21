import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DBProxyNotFoundFault } from '@aws-sdk/client-rds';

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

import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::RDS::DBProxy';
const PROXY_NAME = 'AuroraProxy';
const PROXY_ARN = 'arn:aws:rds:us-east-1:123456789012:db-proxy:prx-aaaa';
const PROXY_ENDPOINT = 'auroraproxy.proxy-abcdef.us-east-1.rds.amazonaws.com';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/AuroraProxyRole';

describe('RDSDBProxyProvider', () => {
  let provider: RDSDBProxyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSDBProxyProvider();
  });

  describe('handledProperties', () => {
    it('declares the user-controllable property set', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled).toBeDefined();
      expect(Array.from(handled!).sort()).toEqual([
        'Auth',
        'DBProxyName',
        'DebugLogging',
        'EngineFamily',
        'IdleClientTimeout',
        'RequireTLS',
        'RoleArn',
        'Tags',
        'VpcSecurityGroupIds',
        'VpcSubnetIds',
      ]);
    });
  });

  describe('create', () => {
    const validProps = {
      DBProxyName: PROXY_NAME,
      EngineFamily: 'MYSQL',
      Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
      RoleArn: ROLE_ARN,
      VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
    };

    it('creates and polls until available', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: { DBProxyName: PROXY_NAME } }) // CreateDBProxy
        .mockResolvedValueOnce({
          DBProxies: [
            {
              DBProxyName: PROXY_NAME,
              DBProxyArn: PROXY_ARN,
              Endpoint: PROXY_ENDPOINT,
              VpcId: 'vpc-xxx',
              Status: 'available',
            },
          ],
        }); // DescribeDBProxies

      const result = await provider.create('Proxy', RESOURCE_TYPE, validProps);

      expect(result.physicalId).toBe(PROXY_NAME);
      expect(result.attributes).toEqual({
        DBProxyArn: PROXY_ARN,
        Endpoint: PROXY_ENDPOINT,
        VpcId: 'vpc-xxx',
      });
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('CreateDBProxyCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('DescribeDBProxiesCommand');
    });

    it('rejects on missing EngineFamily', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, EngineFamily: undefined })
      ).rejects.toThrow(/EngineFamily is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects on missing Auth', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, Auth: [] })
      ).rejects.toThrow(/Auth \(at least one entry\) is required/);
    });

    it('rejects on missing RoleArn', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, RoleArn: undefined })
      ).rejects.toThrow(/RoleArn is required/);
    });

    it('rejects on missing VpcSubnetIds', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, VpcSubnetIds: [] })
      ).rejects.toThrow(/VpcSubnetIds/);
    });

    it('throws terminal failure when DBProxyStatus reports incompatible-network', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: { DBProxyName: PROXY_NAME } })
        .mockResolvedValueOnce({
          DBProxies: [{ Status: 'incompatible-network' }],
        });

      await expect(provider.create('Proxy', RESOURCE_TYPE, validProps)).rejects.toThrow(
        /terminal failure state: incompatible-network/
      );
    });
  });

  describe('update', () => {
    it('is a no-op when nothing changed (tag-diff short-circuits Describe)', async () => {
      const props = {
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
        RoleArn: ROLE_ARN,
        Tags: [{ Key: 'k', Value: 'v' }],
      };
      const result = await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, props, props);
      expect(result.physicalId).toBe(PROXY_NAME);
      expect(result.wasReplaced).toBe(false);
      // PR #400 review M1 fix: tag-map equality short-circuit means
      // no Describe is needed for the ARN cache.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when EngineFamily differs (immutable)', async () => {
      await expect(
        provider.update(
          'Proxy',
          PROXY_NAME,
          RESOURCE_TYPE,
          { EngineFamily: 'POSTGRESQL' },
          { EngineFamily: 'MYSQL' }
        )
      ).rejects.toThrow(/EngineFamily is immutable/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when VpcSubnetIds differs (immutable)', async () => {
      await expect(
        provider.update(
          'Proxy',
          PROXY_NAME,
          RESOURCE_TYPE,
          { VpcSubnetIds: ['subnet-new'] },
          { VpcSubnetIds: ['subnet-old'] }
        )
      ).rejects.toThrow(/VpcSubnetIds is immutable/);
    });

    it('issues ModifyDBProxy when RoleArn changes', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: {} }) // ModifyDBProxy
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] }); // Describe for tag-arn
      const newRole = 'arn:aws:iam::123456789012:role/NewRole';
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { RoleArn: newRole },
        { RoleArn: ROLE_ARN }
      );
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.RoleArn).toBe(newRole);
    });

    it('translates VpcSecurityGroupIds → SecurityGroups in the ModifyDBProxy call', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: {} })
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] });
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.SecurityGroups).toEqual(['sg-new']);
      expect(mockSend.mock.calls[0]![0].input.VpcSecurityGroupIds).toBeUndefined();
    });

    it('diffs Tags via AddTags/RemoveTags', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] }) // Describe for tag-arn lookup
        .mockResolvedValueOnce({}) // RemoveTags
        .mockResolvedValueOnce({}); // AddTags
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        {
          Tags: [
            { Key: 'keep', Value: 'v' },
            { Key: 'new', Value: 'v' },
          ],
        },
        {
          Tags: [
            { Key: 'keep', Value: 'v' },
            { Key: 'removed', Value: 'v' },
          ],
        }
      );
      // Sequence: Describe -> Remove -> Add
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DescribeDBProxiesCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RemoveTagsFromResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.TagKeys).toEqual(['removed']);
      expect(mockSend.mock.calls[2]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[2]![0].input.Tags).toEqual([{ Key: 'new', Value: 'v' }]);
    });

    // PR #400 review M2: tag-diff edge case tests.
    it('Tags diff: value change with same key issues Add only', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] })
        .mockResolvedValueOnce({});
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }] }
      );
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    });

    it('Tags diff: undefined-to-[] is no-op short-circuits Describe', async () => {
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { Tags: [] },
        { Tags: undefined }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('drift --revert round-trip', () => {
    it('identical readCurrentState shape on both sides → no SDK call', async () => {
      const observed = {
        DBProxyName: PROXY_NAME,
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        VpcSecurityGroupIds: ['sg-aaa'],
        RequireTLS: true,
        IdleClientTimeout: 1800,
        DebugLogging: false,
        Auth: [
          {
            Description: undefined,
            UserName: undefined,
            AuthScheme: 'SECRETS',
            SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db',
            IAMAuth: 'DISABLED',
            ClientPasswordAuthType: undefined,
          },
        ],
        Tags: [{ Key: 'env', Value: 'prod' }],
      };
      const result = await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, observed, observed);
      expect(result.physicalId).toBe(PROXY_NAME);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('drift on RoleArn round-trips: ModifyDBProxy with the desired value', async () => {
      const observed = {
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:...' }],
      };
      const awsCurrent = { ...observed, RoleArn: 'arn:aws:iam::123456789012:role/Hijacked' };
      mockSend.mockResolvedValueOnce({ DBProxy: {} });
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.RoleArn).toBe(ROLE_ARN);
    });

    it('drift on Tags round-trips: AddTags with desired tag', async () => {
      const observed = {
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa'],
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:...' }],
        Tags: [{ Key: 'env', Value: 'prod' }],
      };
      const awsCurrent = { ...observed, Tags: [{ Key: 'env', Value: 'hijacked' }] };
      mockSend
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] })
        .mockResolvedValueOnce({});
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    });
  });

  describe('delete', () => {
    it('issues DeleteDBProxy and waits for full removal', async () => {
      mockSend
        .mockResolvedValueOnce({}) // DeleteDBProxy
        .mockRejectedValueOnce(
          new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
        ); // Describe (post-delete poll)

      await provider.delete('Proxy', PROXY_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DeleteDBProxyCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('DescribeDBProxiesCommand');
    });

    it('treats DBProxyNotFoundFault on DeleteDBProxy as idempotent (region matches)', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );

      await expect(
        provider.delete('Proxy', PROXY_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.not.toThrow();
    });

    it('rejects DELETE on region mismatch', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );

      await expect(
        provider.delete('Proxy', PROXY_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-west-2', // client region is us-east-1
        })
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe('getAttribute', () => {
    it('returns Endpoint from DescribeDBProxies', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [
          { DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT, VpcId: 'vpc-xxx' },
        ],
      });

      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBe(PROXY_ENDPOINT);
    });

    it('returns DBProxyArn', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT }],
      });
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'DBProxyArn');
      expect(result).toBe(PROXY_ARN);
    });

    it('caches per (physicalId, attribute)', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT }],
      });
      await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      // Second call: cache hit, no SDK call.
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBe(PROXY_ENDPOINT);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns undefined for unknown attribute', async () => {
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Unknown');
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined when proxy is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    it('reverse-maps DescribeDBProxies to CFn property shape', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxies: [
            {
              DBProxyName: PROXY_NAME,
              DBProxyArn: PROXY_ARN,
              EngineFamily: 'MYSQL',
              RoleArn: ROLE_ARN,
              VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
              VpcSecurityGroupIds: ['sg-aaa'],
              RequireTLS: true,
              IdleClientTimeout: 1800,
              DebugLogging: false,
              Auth: [
                {
                  AuthScheme: 'SECRETS',
                  SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db',
                  IAMAuth: 'DISABLED',
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [{ Key: 'env', Value: 'prod' }] }); // ListTagsForResource

      const result = await provider.readCurrentState(PROXY_NAME);
      expect(result).toMatchObject({
        DBProxyName: PROXY_NAME,
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        VpcSecurityGroupIds: ['sg-aaa'],
        RequireTLS: true,
        IdleClientTimeout: 1800,
        DebugLogging: false,
        Tags: [{ Key: 'env', Value: 'prod' }],
      });
      expect(result?.['Auth']).toEqual([
        {
          Description: undefined,
          UserName: undefined,
          AuthScheme: 'SECRETS',
          SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db',
          IAMAuth: 'DISABLED',
          ClientPasswordAuthType: undefined,
        },
      ]);
    });

    it('returns undefined when proxy is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(PROXY_NAME);
      expect(result).toBeUndefined();
    });
  });

  describe('import (explicit override + auto-lookup)', () => {
    it('returns the override when knownPhysicalId is supplied', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT, VpcId: 'vpc-xxx' }],
      });
      const result = await provider.import({
        logicalId: 'Proxy',
        resourceType: RESOURCE_TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: PROXY_NAME,
      });

      expect(result).toMatchObject({
        physicalId: PROXY_NAME,
        attributes: {
          DBProxyArn: PROXY_ARN,
          Endpoint: PROXY_ENDPOINT,
          VpcId: 'vpc-xxx',
        },
      });
    });

    // Issue #1134: the `aws:cdk:path` tag walk was removed. AWS rejects
    // `aws:`-prefixed tag writes, so that tag never exists on a real proxy
    // and the walk could never match. Without an explicit override or a
    // template `DBProxyName`, import returns null without any AWS call.
    it('returns null without listing when no explicit id or DBProxyName is available', async () => {
      const result = await provider.import({
        logicalId: 'Proxy',
        resourceType: RESOURCE_TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      } as never);

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves from the template DBProxyName property', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT, VpcId: 'vpc-xxx' }],
      });

      const result = await provider.import({
        logicalId: 'Proxy',
        resourceType: RESOURCE_TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { DBProxyName: PROXY_NAME },
      } as never);

      expect(result).toMatchObject({ physicalId: PROXY_NAME });
    });
  });
});
