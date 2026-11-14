import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
const ec2Send = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: ec2Send },
  }),
}));

/**
 * go-to-k/cdkd#6242 slice 3, each measured against CloudFormation
 * (us-east-1): AppSync `ApiKeyId` (cdkd served `<apiId>|<keyId>`),
 * `GraphQLDns` / `RealtimeDns` (the bare api id), S3 Express
 * `AvailabilityZoneName` (the bucket name) and S3 Tables `WarehouseLocation` /
 * `VersionToken` (the composite id) all took the physical-id fallback.
 */
const resolve = (
  type: string,
  physicalId: string,
  attr: string,
  region = 'us-east-1',
  healer?: ResolverContext['attributeHealer']
) =>
  new IntrinsicFunctionResolver(region).resolve({ 'Fn::GetAtt': ['X', attr] }, {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: { X: { physicalId, resourceType: type, properties: {}, attributes: {}, dependencies: [] } },
    ...(healer && { attributeHealer: healer }),
  } as ResolverContext);
const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe('slice 3 attributes (#6242)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
    warnSpy.mockReset();
    ec2Send.mockReset();
  });

  it('AppSync ApiKeyId is the key id out of the <apiId>|<keyId> physical id', async () => {
    await expect(
      resolve('AWS::AppSync::ApiKey', 'fioepra42zb7jj6xb2rugor244|da2-iltmkncgwjfwfjt7vwtf3gu22e', 'ApiKeyId')
    ).resolves.toBe('da2-iltmkncgwjfwfjt7vwtf3gu22e');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('AppSync ApiKeyId reads the key id out of a key ARN an earlier record holds', async () => {
    await expect(
      resolve(
        'AWS::AppSync::ApiKey',
        'arn:aws:appsync:us-east-1:123456789012:apis/fioepra42zb7jj6xb2rugor244/apikeys/da2-iltmkncgwjfwfjt7vwtf3gu22e',
        'ApiKeyId'
      )
    ).resolves.toBe('da2-iltmkncgwjfwfjt7vwtf3gu22e');
  });

  it('AppSync ApiKeyId refuses a physical id that is not that pair', async () => {
    expect(await refusalOf(resolve('AWS::AppSync::ApiKey', 'da2-only', 'ApiKeyId'))).toBeInstanceOf(
      IntrinsicResolutionRefusalError
    );
  });

  // Measured: the host is under an endpoint id of AppSync's own, NOT the api
  // id (api lfmp... was served at z33....appsync-api...), so nothing builds it.
  const API = 'lfmpuytso5futhglj2xn2rdofe';
  const withAttributes = (attributes: Record<string, unknown>, attr: string, healer?: ResolverContext['attributeHealer']) =>
    new IntrinsicFunctionResolver('us-east-1').resolve({ 'Fn::GetAtt': ['X', attr] }, {
      template: { Resources: { X: { Type: 'AWS::AppSync::GraphQLApi', Properties: {} } } },
      resources: {
        X: { physicalId: API, resourceType: 'AWS::AppSync::GraphQLApi', properties: {}, attributes, dependencies: [] },
      },
      ...(healer && { attributeHealer: healer }),
    } as ResolverContext);

  it('AppSync GraphQLDns is the host of the recorded GraphQLUrl, never built from the api id', async () => {
    await expect(
      withAttributes(
        { GraphQLUrl: 'https://z33tzvzuqzhdfgndas2453pnwy.appsync-api.us-east-1.amazonaws.com/graphql' },
        'GraphQLDns'
      )
    ).resolves.toBe('z33tzvzuqzhdfgndas2453pnwy.appsync-api.us-east-1.amazonaws.com');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(['GraphQLDns', 'RealtimeDns'])(
    'AppSync %s is served from the heal read, and refused (never the api id) without one',
    async (attr) => {
      const healer = vi.fn(
        async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes: { [attr]: 'host.example' } })
      );
      await expect(withAttributes({}, attr, healer)).resolves.toBe('host.example');
      const refused = await refusalOf(withAttributes({}, attr));
      expect(refused).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(String((refused as Error).message)).not.toContain(`${API}.appsync`);
    }
  );

  it('S3 Express AvailabilityZoneName is read live from the zone ID in the bucket name', async () => {
    ec2Send.mockResolvedValue({ AvailabilityZones: [{ ZoneName: 'us-east-1c', ZoneId: 'use1-az4' }] });
    await expect(
      resolve('AWS::S3Express::DirectoryBucket', 'mybucket--use1-az4--x-s3', 'AvailabilityZoneName')
    ).resolves.toBe('us-east-1c');
    const cmd = ec2Send.mock.calls[0]![0] as { constructor: { name: string }; input: unknown };
    expect(cmd.constructor.name).toBe('DescribeAvailabilityZonesCommand');
    expect(cmd.input).toStrictEqual({ ZoneIds: ['use1-az4'] });
  });

  it.each([
    ['a base name holding --', 'my--bucket--use1-az4--x-s3', 'use1-az4'],
    ['a Local Zone id', 'mybucket--usw2-lax1-az1--x-s3', 'usw2-lax1-az1'],
  ])('S3 Express AvailabilityZoneName parses the zone id out of %s', async (_label, bucket, zoneId) => {
    ec2Send.mockResolvedValue({ AvailabilityZones: [{ ZoneName: 'zone-name' }] });
    await expect(resolve('AWS::S3Express::DirectoryBucket', bucket, 'AvailabilityZoneName')).resolves.toBe(
      'zone-name'
    );
    expect((ec2Send.mock.calls[0]![0] as { input: unknown }).input).toStrictEqual({ ZoneIds: [zoneId] });
  });

  it('S3 Express AvailabilityZoneName refuses when the read fails or the name carries no zone', async () => {
    ec2Send.mockRejectedValue(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }));
    const failed = await refusalOf(
      resolve('AWS::S3Express::DirectoryBucket', 'mybucket--use1-az4--x-s3', 'AvailabilityZoneName')
    );
    expect(failed).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((failed as Error).message).toContain('DescribeAvailabilityZones');
    const noZone = await refusalOf(
      resolve('AWS::S3Express::DirectoryBucket', 'not-a-directory-bucket', 'AvailabilityZoneName')
    );
    expect((noZone as Error).message).toContain('--<zone-id>--x-s3');
  });

  it.each(['WarehouseLocation', 'VersionToken'])(
    'S3 Tables %s is served from the heal read, and refused without one',
    async (attr) => {
      const id = 'arn:aws:s3tables:us-east-1:123456789012:bucket/tb|ns1|t1';
      const healed = vi.fn(
        async (): Promise<StaleAttributeHealOutcome> => ({
          kind: 'read',
          attributes: { [attr]: 'value-from-gettable' },
        })
      );
      await expect(resolve('AWS::S3Tables::Table', id, attr, 'us-east-1', healed)).resolves.toBe(
        'value-from-gettable'
      );
      const refused = await refusalOf(resolve('AWS::S3Tables::Table', id, attr));
      expect(refused).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(warnSpy).not.toHaveBeenCalled();
    }
  );
});
