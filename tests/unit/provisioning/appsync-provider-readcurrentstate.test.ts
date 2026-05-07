import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetGraphqlApiCommand,
  GetDataSourceCommand,
  GetResolverCommand,
  ListApiKeysCommand,
  NotFoundException as AppSyncNotFoundException,
} from '@aws-sdk/client-appsync';

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

import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';

describe('AppSyncProvider.readCurrentState', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AppSyncProvider();
  });

  describe('AWS::AppSync::GraphQLApi', () => {
    it('returns CFn-shaped properties from GetGraphqlApi (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        graphqlApi: {
          apiId: 'api-1',
          name: 'MyApi',
          authenticationType: 'API_KEY',
          xrayEnabled: true,
          logConfig: {
            cloudWatchLogsRoleArn: 'arn:aws:iam::1:role/r',
            fieldLogLevel: 'ALL',
            excludeVerboseContent: false,
          },
          arn: 'arn:aws:appsync:us-east-1:1:apis/api-1',
        },
      });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLApi'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetGraphqlApiCommand);
      expect(result).toEqual({
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        XrayEnabled: true,
        LogConfig: {
          CloudWatchLogsRoleArn: 'arn:aws:iam::1:role/r',
          FieldLogLevel: 'ALL',
          ExcludeVerboseContent: false,
        },
        Tags: [],
      });
    });

    it('surfaces Tags from GetGraphqlApi with aws:* filtered out', async () => {
      mockSend.mockResolvedValueOnce({
        graphqlApi: {
          apiId: 'api-1',
          name: 'MyApi',
          authenticationType: 'API_KEY',
          tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyApi/Resource' },
        },
      });

      const result = await provider.readCurrentState('api-1', 'L', 'AWS::AppSync::GraphQLApi');
      expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
    });

    it('omits Tags when GetGraphqlApi returns no user tags', async () => {
      mockSend.mockResolvedValueOnce({
        graphqlApi: {
          apiId: 'api-1',
          name: 'MyApi',
          authenticationType: 'API_KEY',
          tags: { 'aws:cdk:path': 'MyStack/MyApi/Resource' },
        },
      });

      const result = await provider.readCurrentState('api-1', 'L', 'AWS::AppSync::GraphQLApi');
      expect(result?.Tags).toEqual([]);
    });

    it('returns undefined when API is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new AppSyncNotFoundException({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLApi'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::AppSync::DataSource', () => {
    it('returns CFn-shaped DataSource properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        dataSource: {
          name: 'ds1',
          type: 'AWS_LAMBDA',
          serviceRoleArn: 'arn:aws:iam::1:role/x',
          lambdaConfig: { lambdaFunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn' },
        },
      });

      const result = await provider.readCurrentState(
        'api-1|ds1',
        'L',
        'AWS::AppSync::DataSource'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetDataSourceCommand);
      expect(result).toEqual({
        ApiId: 'api-1',
        Name: 'ds1',
        Type: 'AWS_LAMBDA',
        Description: '',
        ServiceRoleArn: 'arn:aws:iam::1:role/x',
        LambdaConfig: {
          LambdaFunctionArn: 'arn:aws:lambda:us-east-1:1:function:fn',
        },
      });
    });
  });

  describe('AWS::AppSync::Resolver', () => {
    it('returns CFn-shaped Resolver properties (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        resolver: {
          typeName: 'Query',
          fieldName: 'getThing',
          dataSourceName: 'ds1',
          kind: 'UNIT',
          requestMappingTemplate: '$ctx',
          responseMappingTemplate: '$result',
        },
      });

      const result = await provider.readCurrentState(
        'api-1|Query|getThing',
        'L',
        'AWS::AppSync::Resolver'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetResolverCommand);
      expect(result).toEqual({
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        DataSourceName: 'ds1',
        Kind: 'UNIT',
        RequestMappingTemplate: '$ctx',
        ResponseMappingTemplate: '$result',
        PipelineConfig: { Functions: [] },
        Runtime: {},
        Code: '',
      });
    });
  });

  describe('AWS::AppSync::ApiKey', () => {
    it('returns CFn-shaped ApiKey via ListApiKeys', async () => {
      mockSend.mockResolvedValueOnce({
        apiKeys: [
          { id: 'other', description: 'no' },
          { id: 'k1', description: 'main', expires: 1700000000 },
        ],
      });

      const result = await provider.readCurrentState(
        'api-1|k1',
        'L',
        'AWS::AppSync::ApiKey'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListApiKeysCommand);
      expect(result).toEqual({
        ApiId: 'api-1',
        Description: 'main',
        Expires: 1700000000,
      });
    });

    it('returns undefined when ApiKey not found', async () => {
      mockSend.mockResolvedValueOnce({ apiKeys: [{ id: 'other' }] });
      const result = await provider.readCurrentState(
        'api-1|missing',
        'L',
        'AWS::AppSync::ApiKey'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::AppSync::GraphQLSchema', () => {
    it('returns undefined (drift on schema bodies is out of scope)', async () => {
      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema'
      );
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
