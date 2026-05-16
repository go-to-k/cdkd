import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DBProxyEndpointNotFoundFault, DBProxyNotFoundFault } from '@aws-sdk/client-rds';

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

import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::RDS::DBProxyEndpoint';
const EP_NAME = 'MyEndpoint';
const EP_ARN = 'arn:aws:rds:us-east-1:123456789012:db-proxy-endpoint:prx-EP-aaa';
const EP_HOST = 'myendpoint.endpoint.proxy-abc.us-east-1.rds.amazonaws.com';

describe('RDSDBProxyEndpointProvider', () => {
  let provider: RDSDBProxyEndpointProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSDBProxyEndpointProvider();
  });

  describe('handledProperties', () => {
    it('declares the user-controllable property set', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(Array.from(handled!).sort()).toEqual([
        'DBProxyEndpointName',
        'DBProxyName',
        'Tags',
        'TargetRole',
        'VpcSecurityGroupIds',
        'VpcSubnetIds',
      ]);
    });
  });

  describe('create', () => {
    const validProps = {
      DBProxyEndpointName: EP_NAME,
      DBProxyName: 'MyProxy',
      VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
    };

    it('creates and polls until available', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyEndpoint: { DBProxyEndpointName: EP_NAME } })
        .mockResolvedValueOnce({
          DBProxyEndpoints: [
            {
              DBProxyEndpointName: EP_NAME,
              DBProxyEndpointArn: EP_ARN,
              Endpoint: EP_HOST,
              IsDefault: false,
              VpcId: 'vpc-xxx',
              Status: 'available',
            },
          ],
        });
      const result = await provider.create('EP', RESOURCE_TYPE, validProps);
      expect(result.physicalId).toBe(EP_NAME);
      expect(result.attributes).toEqual({
        Endpoint: EP_HOST,
        DBProxyEndpointArn: EP_ARN,
        IsDefault: false,
        VpcId: 'vpc-xxx',
      });
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('CreateDBProxyEndpointCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('DescribeDBProxyEndpointsCommand');
    });

    it('rejects when DBProxyName is missing', async () => {
      await expect(
        provider.create('EP', RESOURCE_TYPE, { ...validProps, DBProxyName: undefined })
      ).rejects.toThrow(/DBProxyName is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when VpcSubnetIds is empty', async () => {
      await expect(
        provider.create('EP', RESOURCE_TYPE, { ...validProps, VpcSubnetIds: [] })
      ).rejects.toThrow(/VpcSubnetIds/);
    });

    it('throws terminal failure on incompatible-network', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyEndpoint: {} })
        .mockResolvedValueOnce({
          DBProxyEndpoints: [{ Status: 'incompatible-network' }],
        });
      await expect(provider.create('EP', RESOURCE_TYPE, validProps)).rejects.toThrow(
        /terminal failure state: incompatible-network/
      );
    });
  });

  describe('update', () => {
    it('is a no-op when nothing changed', async () => {
      const props = {
        VpcSecurityGroupIds: ['sg-aaa'],
        Tags: [{ Key: 'env', Value: 'dev' }],
      };
      const result = await provider.update('EP', EP_NAME, RESOURCE_TYPE, props, props);
      expect(result.wasReplaced).toBe(false);
      // No SDK calls — same tag set, same SG IDs, the tag-diff helper now
      // short-circuits on identical tag maps without calling Describe for
      // the ARN cache.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when TargetRole differs (immutable)', async () => {
      await expect(
        provider.update(
          'EP',
          EP_NAME,
          RESOURCE_TYPE,
          { TargetRole: 'READ_ONLY' },
          { TargetRole: 'READ_WRITE' }
        )
      ).rejects.toThrow(/TargetRole is immutable/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when VpcSubnetIds differs (immutable)', async () => {
      await expect(
        provider.update(
          'EP',
          EP_NAME,
          RESOURCE_TYPE,
          { VpcSubnetIds: ['subnet-new'] },
          { VpcSubnetIds: ['subnet-old'] }
        )
      ).rejects.toThrow(/VpcSubnetIds is immutable/);
    });

    it('rejects when DBProxyName differs (immutable)', async () => {
      await expect(
        provider.update(
          'EP',
          EP_NAME,
          RESOURCE_TYPE,
          { DBProxyName: 'NewProxy' },
          { DBProxyName: 'OldProxy' }
        )
      ).rejects.toThrow(/DBProxyName is immutable/);
    });

    it('issues ModifyDBProxyEndpoint when VpcSecurityGroupIds change', async () => {
      mockSend.mockResolvedValueOnce({ DBProxyEndpoint: {} });
      await provider.update(
        'EP',
        EP_NAME,
        RESOURCE_TYPE,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyEndpointCommand');
      expect(mockSend.mock.calls[0]![0].input.VpcSecurityGroupIds).toEqual(['sg-new']);
    });

    it('diffs Tags via Add/Remove', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxyEndpoints: [{ DBProxyEndpointArn: EP_ARN }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await provider.update(
        'EP',
        EP_NAME,
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
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DescribeDBProxyEndpointsCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RemoveTagsFromResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.TagKeys).toEqual(['removed']);
      expect(mockSend.mock.calls[2]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[2]![0].input.Tags).toEqual([{ Key: 'new', Value: 'v' }]);
    });

    // PR #400 review M2: tag-diff edge case tests.
    it('Tags diff: value change with same key issues Add (not Remove)', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyEndpoints: [{ DBProxyEndpointArn: EP_ARN }] })
        .mockResolvedValueOnce({}); // AddTags only
      await provider.update(
        'EP',
        EP_NAME,
        RESOURCE_TYPE,
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }] }
      );
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    });

    it('Tags diff: asymmetric sizes (old=1, new=2) issues Add only', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxyEndpoints: [{ DBProxyEndpointArn: EP_ARN }] })
        .mockResolvedValueOnce({});
      await provider.update(
        'EP',
        EP_NAME,
        RESOURCE_TYPE,
        {
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ],
        },
        { Tags: [{ Key: 'a', Value: '1' }] }
      );
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'b', Value: '2' }]);
    });

    it('Tags diff: undefined-to-[] is no-op (both treated as empty)', async () => {
      await provider.update(
        'EP',
        EP_NAME,
        RESOURCE_TYPE,
        { Tags: [] },
        { Tags: undefined }
      );
      // Tag diff short-circuit fires: no Describe, no Modify.
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('drift --revert round-trip', () => {
    it('identical readCurrentState shape on both sides → no SDK call', async () => {
      const observed = {
        DBProxyEndpointName: EP_NAME,
        DBProxyName: 'MyProxy',
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        VpcSecurityGroupIds: ['sg-aaa'],
        TargetRole: 'READ_ONLY',
        Tags: [{ Key: 'env', Value: 'prod' }],
      };
      const result = await provider.update('EP', EP_NAME, RESOURCE_TYPE, observed, observed);
      expect(result.physicalId).toBe(EP_NAME);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('drift on VpcSecurityGroupIds round-trips: ModifyDBProxyEndpoint', async () => {
      const observed = {
        DBProxyName: 'MyProxy',
        VpcSubnetIds: ['subnet-aaa'],
        VpcSecurityGroupIds: ['sg-aaa'],
        TargetRole: 'READ_ONLY',
      };
      const awsCurrent = { ...observed, VpcSecurityGroupIds: ['sg-hijacked'] };
      mockSend.mockResolvedValueOnce({});
      await provider.update('EP', EP_NAME, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyEndpointCommand');
      expect(mockSend.mock.calls[0]![0].input.VpcSecurityGroupIds).toEqual(['sg-aaa']);
    });

    it('drift on Tags round-trips: AddTags with desired tag', async () => {
      const observed = {
        DBProxyName: 'MyProxy',
        VpcSubnetIds: ['subnet-aaa'],
        VpcSecurityGroupIds: ['sg-aaa'],
        TargetRole: 'READ_ONLY',
        Tags: [{ Key: 'env', Value: 'prod' }],
      };
      const awsCurrent = { ...observed, Tags: [{ Key: 'env', Value: 'hijacked' }] };
      mockSend
        .mockResolvedValueOnce({ DBProxyEndpoints: [{ DBProxyEndpointArn: EP_ARN }] })
        .mockResolvedValueOnce({});
      await provider.update('EP', EP_NAME, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    });
  });

  describe('delete', () => {
    it('issues DeleteDBProxyEndpoint + polls until NotFound', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(
          new DBProxyEndpointNotFoundFault({ message: 'gone', $metadata: {} })
        );
      await provider.delete('EP', EP_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DeleteDBProxyEndpointCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('DescribeDBProxyEndpointsCommand');
    });

    it('treats DBProxyEndpointNotFoundFault on delete as idempotent', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyEndpointNotFoundFault({ message: 'gone', $metadata: {} })
      );
      await expect(
        provider.delete('EP', EP_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.not.toThrow();
    });

    it('treats DBProxyNotFoundFault (parent gone via CASCADE) as idempotent', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'parent gone', $metadata: {} })
      );
      await expect(
        provider.delete('EP', EP_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.not.toThrow();
    });

    it('rejects DELETE on region mismatch', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyEndpointNotFoundFault({ message: 'gone', $metadata: {} })
      );
      await expect(
        provider.delete('EP', EP_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-west-2',
        })
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe('getAttribute', () => {
    it('returns Endpoint from DescribeDBProxyEndpoints', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxyEndpoints: [{ Endpoint: EP_HOST, DBProxyEndpointArn: EP_ARN, IsDefault: false }],
      });
      const result = await provider.getAttribute(EP_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBe(EP_HOST);
    });

    it('caches per (physicalId, attribute)', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxyEndpoints: [{ Endpoint: EP_HOST, DBProxyEndpointArn: EP_ARN }],
      });
      await provider.getAttribute(EP_NAME, RESOURCE_TYPE, 'Endpoint');
      const result = await provider.getAttribute(EP_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBe(EP_HOST);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns IsDefault as false when missing', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxyEndpoints: [{ Endpoint: EP_HOST, DBProxyEndpointArn: EP_ARN }],
      });
      const result = await provider.getAttribute(EP_NAME, RESOURCE_TYPE, 'IsDefault');
      expect(result).toBe(false);
    });

    it('returns undefined for unknown attribute', async () => {
      const result = await provider.getAttribute(EP_NAME, RESOURCE_TYPE, 'Unknown');
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined when endpoint is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyEndpointNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.getAttribute(EP_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    it('reverse-maps DescribeDBProxyEndpoints + tags to CFn shape', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxyEndpoints: [
            {
              DBProxyEndpointName: EP_NAME,
              DBProxyEndpointArn: EP_ARN,
              DBProxyName: 'MyProxy',
              VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
              VpcSecurityGroupIds: ['sg-aaa'],
              TargetRole: 'READ_ONLY',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [{ Key: 'env', Value: 'prod' }] });
      const result = await provider.readCurrentState(EP_NAME);
      expect(result).toEqual({
        DBProxyEndpointName: EP_NAME,
        DBProxyName: 'MyProxy',
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        VpcSecurityGroupIds: ['sg-aaa'],
        TargetRole: 'READ_ONLY',
        Tags: [{ Key: 'env', Value: 'prod' }],
      });
    });

    it('emits TargetRole=READ_WRITE default when AWS omits the field', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxyEndpoints: [
            {
              DBProxyEndpointName: EP_NAME,
              DBProxyEndpointArn: EP_ARN,
              DBProxyName: 'MyProxy',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });
      const result = await provider.readCurrentState(EP_NAME);
      expect(result?.['TargetRole']).toBe('READ_WRITE');
    });

    it('returns undefined when the endpoint is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyEndpointNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(EP_NAME);
      expect(result).toBeUndefined();
    });
  });

  describe('import', () => {
    it('returns explicit override when DBProxyEndpointName supplied via knownPhysicalId', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxyEndpoints: [{ Endpoint: EP_HOST, DBProxyEndpointArn: EP_ARN, IsDefault: false }],
      });
      const result = await provider.import({
        logicalId: 'EP',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'MyStack/EP',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: EP_NAME,
      });
      expect(result).toMatchObject({ physicalId: EP_NAME });
    });

    it('auto-lookup matches via aws:cdk:path tag', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxyEndpoints: [{ DBProxyEndpointName: EP_NAME, DBProxyEndpointArn: EP_ARN }],
          Marker: undefined,
        })
        .mockResolvedValueOnce({
          TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/EP/Resource' }],
        })
        .mockResolvedValueOnce({
          DBProxyEndpoints: [{ Endpoint: EP_HOST, DBProxyEndpointArn: EP_ARN, IsDefault: false }],
        });
      const result = await provider.import({
        logicalId: 'EP',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'MyStack/EP/Resource',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      });
      expect(result).toMatchObject({ physicalId: EP_NAME });
    });

    it('returns null when no match', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxyEndpoints: [{ DBProxyEndpointName: 'OtherEP', DBProxyEndpointArn: EP_ARN }],
          Marker: undefined,
        })
        .mockResolvedValueOnce({
          TagList: [{ Key: 'aws:cdk:path', Value: 'OtherStack/OtherEP' }],
        });
      const result = await provider.import({
        logicalId: 'EP',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'MyStack/EP/Resource',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      });
      expect(result).toBeNull();
    });
  });
});
