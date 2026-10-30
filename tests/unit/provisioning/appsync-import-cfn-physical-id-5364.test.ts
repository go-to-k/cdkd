import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetGraphqlApiCommand,
  GetIntrospectionSchemaCommand,
  NotFoundException,
  StartSchemaCreationCommand,
} from '@aws-sdk/client-appsync';
import { RESOURCE_NOT_FOUND, type ResourceImportInput } from '../../../src/types/resource.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: vi.fn().mockResolvedValue({
    partition: 'aws',
    region: 'us-east-1',
    accountId: '123456789012',
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import {
  AppSyncProvider,
  appSyncPhysicalIdFromCfn,
} from '../../../src/provisioning/providers/appsync-provider.js';

/**
 * Issue #5364 — `cdkd import --migrate-from-cloudformation` hands `import()` the
 * physical id `DescribeStackResources` reports. Measured on a live stack
 * (2026-10-30): the API and its three ARN-identified children report ARNs, the
 * schema `<apiId>GraphQLSchema`. cdkd records the bare API id and `|`-joined
 * child ids, so a verbatim CloudFormation id addressed an API that does not
 * exist.
 */
const API = '627snwwdmzgabjos5zwo76psmy';
const ARN = `arn:aws:appsync:us-east-1:123456789012:apis/${API}`;

const importInput = (resourceType: string, knownPhysicalId: string): ResourceImportInput => ({
  logicalId: 'L',
  resourceType,
  stackName: 'S',
  region: 'us-east-1',
  properties: {},
  knownPhysicalId,
});

describe('appSyncPhysicalIdFromCfn (issue #5364)', () => {
  it.each([
    ['AWS::AppSync::GraphQLApi', ARN, API],
    ['AWS::AppSync::GraphQLSchema', `${API}GraphQLSchema`, API],
    ['AWS::AppSync::DataSource', `${ARN}/datasources/NoneDs`, `${API}|NoneDs`],
    ['AWS::AppSync::Resolver', `${ARN}/types/Query/resolvers/hello`, `${API}|Query|hello`],
    // CloudFormation's spelling, then the documented one.
    ['AWS::AppSync::ApiKey', `${ARN}/apikeys/da2-abc`, `${API}|da2-abc`],
    ['AWS::AppSync::ApiKey', `${ARN}/apikey/da2-abc`, `${API}|da2-abc`],
  ])('%s %s -> %s', (type, cfnId, expected) => {
    expect(appSyncPhysicalIdFromCfn(type, 'L', cfnId, 'us-east-1')).toBe(expected);
  });

  it.each([
    ['aws-cn', 'cn-north-1'],
    ['aws-us-gov', 'us-gov-west-1'],
  ])('reads the %s partition', (partition, region) => {
    const arn = `arn:${partition}:appsync:${region}:123456789012:apis/${API}/datasources/NoneDs`;
    expect(appSyncPhysicalIdFromCfn('AWS::AppSync::DataSource', 'L', arn, region)).toBe(
      `${API}|NoneDs`
    );
  });

  it('compares regions case-insensitively', () => {
    expect(appSyncPhysicalIdFromCfn('AWS::AppSync::GraphQLApi', 'L', ARN, 'US-EAST-1')).toBe(API);
  });

  it.each([
    // cdkd's own shapes pass through.
    ['AWS::AppSync::GraphQLApi', API],
    ['AWS::AppSync::GraphQLSchema', API],
    ['AWS::AppSync::DataSource', `${API}|NoneDs`],
    ['AWS::AppSync::Resolver', `${API}|Query|hello`],
    ['AWS::AppSync::ApiKey', `${API}|da2-abc`],
    // Another type's ARN shape is not this type's id.
    ['AWS::AppSync::GraphQLApi', `${ARN}/datasources/NoneDs`],
    ['AWS::AppSync::DataSource', ARN],
    // A segment that would break the `|`-joined id.
    ['AWS::AppSync::DataSource', `${ARN}/datasources/a|b`],
    // The suffix needs an API id in front of it, and API ids are lowercase.
    ['AWS::AppSync::GraphQLSchema', 'GraphQLSchema'],
    ['AWS::AppSync::GraphQLSchema', 'Abc1GraphQLSchema'],
  ])('%s %s is left unchanged', (type, id) => {
    expect(appSyncPhysicalIdFromCfn(type, 'L', id, 'us-east-1')).toBe(id);
  });

  it('refuses an ARN in another region rather than addressing the import region', () => {
    expect(() =>
      appSyncPhysicalIdFromCfn(
        'AWS::AppSync::DataSource',
        'L',
        `arn:aws:appsync:eu-west-1:123456789012:apis/${API}/datasources/NoneDs`,
        'us-east-1'
      )
    ).toThrow(/region eu-west-1, not the import region us-east-1/);
  });
});

describe('AppSyncProvider.import records cdkd ids for CloudFormation ids (issue #5364)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    provider = new AppSyncProvider();
    mockSend.mockReset();
  });

  it('GraphQLApi: verifies and records the API id behind the ARN', async () => {
    mockSend.mockResolvedValueOnce({
      graphqlApi: { apiId: API, arn: ARN, uris: { GRAPHQL: 'https://x/graphql' } },
    });

    const result = await provider.import(importInput('AWS::AppSync::GraphQLApi', ARN));

    const sent = mockSend.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(GetGraphqlApiCommand);
    expect(sent.input).toEqual({ apiId: API });
    expect(result).toEqual({
      physicalId: API,
      attributes: { ApiId: API, Arn: ARN, GraphQLUrl: 'https://x/graphql' },
    });
  });

  it('GraphQLApi: refuses another region before any AppSync call', async () => {
    await expect(
      provider.import({
        ...importInput('AWS::AppSync::GraphQLApi', ARN),
        region: 'eu-west-1',
      })
    ).rejects.toThrow(/region us-east-1, not the import region eu-west-1/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('GraphQLSchema: records the bare API id', async () => {
    const result = await provider.import(
      importInput('AWS::AppSync::GraphQLSchema', `${API}GraphQLSchema`)
    );
    expect(result).toEqual({ physicalId: API, attributes: {} });
  });

  it.each([
    [
      'AWS::AppSync::DataSource',
      `${ARN}/datasources/NoneDs`,
      `${API}|NoneDs`,
      { DataSourceArn: `${ARN}/datasources/NoneDs`, Name: 'NoneDs' },
    ],
    [
      'AWS::AppSync::Resolver',
      `${ARN}/types/Query/resolvers/hello`,
      `${API}|Query|hello`,
      { ResolverArn: `${ARN}/types/Query/resolvers/hello` },
    ],
    [
      'AWS::AppSync::ApiKey',
      `${ARN}/apikeys/da2-abc`,
      `${API}|da2-abc`,
      { ApiKey: 'da2-abc', Arn: `${ARN}/apikey/da2-abc` },
    ],
  ])('%s: records the composite id and its attributes', async (type, cfnId, id, attributes) => {
    const result = await provider.import(importInput(type, cfnId));
    expect(result).toEqual({ physicalId: id, attributes });
  });
});

describe('AppSyncProvider reads a schema record migrated before the fix (issue #5364)', () => {
  it('addresses GetIntrospectionSchema with the API id and reports it as ApiId', async () => {
    const provider = new AppSyncProvider();
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ schema: new TextEncoder().encode('type Query { a: Int }') });

    const result = await provider.readCurrentState(
      `${API}GraphQLSchema`,
      'L',
      'AWS::AppSync::GraphQLSchema',
      { ApiId: API, Definition: 'type Query { a: Int }' }
    );

    const sent = mockSend.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(GetIntrospectionSchemaCommand);
    expect(sent.input).toEqual({ apiId: API, format: 'SDL' });
    expect(result).toEqual({ ApiId: API, Definition: 'type Query { a: Int }' });
  });

  it('still reports a schema whose API is gone as not found', async () => {
    const provider = new AppSyncProvider();
    mockSend.mockReset();
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    await expect(
      provider.readCurrentState(`${API}GraphQLSchema`, 'L', 'AWS::AppSync::GraphQLSchema', {})
    ).resolves.toBe(RESOURCE_NOT_FOUND);
    expect(mockSend.mock.calls[0]?.[0].input.apiId).toBe(API);
  });

  it('uploads an update to the API id when the desired bag names no ApiId', async () => {
    const provider = new AppSyncProvider();
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'L',
      `${API}GraphQLSchema`,
      'AWS::AppSync::GraphQLSchema',
      { Definition: 'type Query { b: Int }' },
      { Definition: 'type Query { a: Int }' }
    );

    const sent = mockSend.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(StartSchemaCreationCommand);
    expect(sent.input.apiId).toBe(API);
  });
});
