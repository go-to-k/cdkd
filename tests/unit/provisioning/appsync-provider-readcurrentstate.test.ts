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

    // Structural regression test for the always-emit-placeholder convention
    // (docs/provider-development.md § 3b). Ensures every user-controllable
    // top-level CFn key is present in the result even when AWS returns
    // the resource with all optional fields undefined / empty. A future
    // refactor that drops a placeholder for any of these keys must update
    // this test consciously — silent regression is structurally prevented.
    it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
      mockSend.mockResolvedValueOnce({
        graphqlApi: {
          name: 'api',
          authenticationType: 'API_KEY',
          // xrayEnabled / logConfig / tags deliberately undefined.
        },
      });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLApi'
      );

      expect(Object.keys(result ?? {}).sort()).toEqual(
        ['AuthenticationType', 'LogConfig', 'Name', 'Tags', 'XrayEnabled'].sort()
      );
      expect(result?.Name).toBe('api');
      expect(result?.AuthenticationType).toBe('API_KEY');
      expect(result?.XrayEnabled).toBe(false);
      expect(result?.LogConfig).toEqual({});
      expect(result?.Tags).toEqual([]);
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

    it('Class 2: omits ServiceRoleArn when AWS does not return one', async () => {
      // ServiceRoleArn must be a valid IAM ARN — '' placeholder would
      // fail ARN validation if pushed back to AWS. NONE / HTTP type
      // data sources legitimately have no service role.
      mockSend.mockResolvedValueOnce({
        dataSource: {
          name: 'ds1',
          type: 'NONE',
          // serviceRoleArn deliberately undefined.
        },
      });

      const result = await provider.readCurrentState(
        'api-1|ds1',
        'L',
        'AWS::AppSync::DataSource'
      );

      expect(result).not.toHaveProperty('ServiceRoleArn');
    });
  });

  describe('AWS::AppSync::Resolver', () => {
    it('Kind=UNIT VTL: emits DataSourceName + VTL templates, omits PIPELINE/JS shapes', async () => {
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
      // Class 1: PipelineConfig + Code + Runtime are NOT emitted on a
      // UNIT VTL resolver (they'd be rejected by CreateResolver /
      // UpdateResolver if pushed back).
      expect(result).toEqual({
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        Kind: 'UNIT',
        DataSourceName: 'ds1',
        RequestMappingTemplate: '$ctx',
        ResponseMappingTemplate: '$result',
      });
    });

    it('Class 1: Kind=PIPELINE omits DataSourceName + VTL templates', async () => {
      mockSend.mockResolvedValueOnce({
        resolver: {
          typeName: 'Query',
          fieldName: 'pipe',
          kind: 'PIPELINE',
          pipelineConfig: { functions: ['fn-1', 'fn-2'] },
          requestMappingTemplate: '$ctx',
          responseMappingTemplate: '$result',
        },
      });

      const result = await provider.readCurrentState(
        'api-1|Query|pipe',
        'L',
        'AWS::AppSync::Resolver'
      );

      // PipelineConfig is the discriminator-tagged required shape;
      // DataSourceName is N/A on a PIPELINE resolver.
      expect(result).toMatchObject({
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'pipe',
        Kind: 'PIPELINE',
        PipelineConfig: { Functions: ['fn-1', 'fn-2'] },
      });
      expect(result).not.toHaveProperty('DataSourceName');
    });

    it('Class 1: JS resolver emits Code + Runtime, omits VTL templates', async () => {
      mockSend.mockResolvedValueOnce({
        resolver: {
          typeName: 'Query',
          fieldName: 'jsThing',
          dataSourceName: 'ds1',
          kind: 'UNIT',
          code: 'export function request() {}',
          runtime: { name: 'APPSYNC_JS', runtimeVersion: '1.0.0' },
        },
      });

      const result = await provider.readCurrentState(
        'api-1|Query|jsThing',
        'L',
        'AWS::AppSync::Resolver'
      );

      // VTL templates are NOT emitted on a JS resolver (AWS rejects
      // mixing Code/Runtime with Request/ResponseMappingTemplate).
      expect(result).toEqual({
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'jsThing',
        Kind: 'UNIT',
        DataSourceName: 'ds1',
        Code: 'export function request() {}',
        Runtime: { Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' },
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
