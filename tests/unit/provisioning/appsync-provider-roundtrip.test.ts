import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import {
  UpdateGraphqlApiCommand,
  UpdateDataSourceCommand,
  UpdateResolverCommand,
  UpdateApiKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  GetGraphqlApiCommand,
  StartSchemaCreationCommand,
} from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * Update-path tests for AppSyncProvider.
 *
 * Verifies `cdkd drift --revert` round-trip behavior for the five AppSync
 * resource types — every Update* SDK call is issued with the right
 * camelCase / PascalCase shape, no-op diffs skip the call entirely, and
 * immutable identity-field changes reject with
 * `ResourceUpdateNotSupportedError`.
 */
describe('AppSyncProvider.update', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new AppSyncProvider();
  });

  // ─── GraphQLApi ──────────────────────────────────────────────────────

  describe('GraphQLApi', () => {
    it('issues UpdateGraphqlApi when AuthenticationType / XrayEnabled / LogConfig diff', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateGraphqlApi
      // Tags diff would issue GetGraphqlApi+Tag*; no Tags here so skip.

      const newProps = {
        Name: 'MyApi',
        AuthenticationType: 'AWS_IAM',
        XrayEnabled: true,
        LogConfig: {
          CloudWatchLogsRoleArn: 'arn:aws:iam::1:role/AppSyncLog',
          FieldLogLevel: 'ALL',
          ExcludeVerboseContent: false,
        },
        Tags: [] as Array<{ Key: string; Value: string }>,
      };
      const oldProps = {
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        XrayEnabled: false,
        LogConfig: {},
        Tags: [] as Array<{ Key: string; Value: string }>,
      };

      const result = await provider.update(
        'L',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        newProps,
        oldProps
      );

      expect(result.physicalId).toBe('api-1');
      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateGraphqlApiCommand);
      expect(cmd.input).toMatchObject({
        apiId: 'api-1',
        name: 'MyApi',
        authenticationType: 'AWS_IAM',
        xrayEnabled: true,
        logConfig: {
          cloudWatchLogsRoleArn: 'arn:aws:iam::1:role/AppSyncLog',
          fieldLogLevel: 'ALL',
          excludeVerboseContent: false,
        },
      });
    });

    it('no-op when no mutable field diffs (no SDK call)', async () => {
      const same = {
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        XrayEnabled: false,
        LogConfig: {},
        Tags: [] as Array<{ Key: string; Value: string }>,
      };
      const result = await provider.update(
        'L',
        'api-1',
        'AWS::AppSync::GraphQLApi',
        same,
        same
      );
      expect(result.physicalId).toBe('api-1');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when Name changes (immutable identity)', async () => {
      const newProps = { Name: 'NewName', AuthenticationType: 'API_KEY' };
      const oldProps = { Name: 'OldName', AuthenticationType: 'API_KEY' };
      await expect(
        provider.update('L', 'api-1', 'AWS::AppSync::GraphQLApi', newProps, oldProps)
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('issues TagResource for new tags + UntagResource for removed tags', async () => {
      // Tags-only diff: skip UpdateGraphqlApi; only TagResource / UntagResource
      // (preceded by GetGraphqlApi to recover the ARN).
      mockSend.mockResolvedValueOnce({
        graphqlApi: { arn: 'arn:aws:appsync:us-east-1:1:apis/api-1' },
      }); // GetGraphqlApi
      mockSend.mockResolvedValueOnce({}); // UntagResource
      mockSend.mockResolvedValueOnce({}); // TagResource

      const newProps = {
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        Tags: [
          { Key: 'Env', Value: 'prod' },
          { Key: 'Owner', Value: 'team' },
        ],
      };
      const oldProps = {
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        Tags: [
          { Key: 'Env', Value: 'dev' },
          { Key: 'Legacy', Value: 'remove-me' },
        ],
      };

      await provider.update('L', 'api-1', 'AWS::AppSync::GraphQLApi', newProps, oldProps);

      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetGraphqlApiCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(UntagResourceCommand);
      expect(mockSend.mock.calls[1]?.[0].input).toMatchObject({
        resourceArn: 'arn:aws:appsync:us-east-1:1:apis/api-1',
        tagKeys: ['Legacy'],
      });
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(TagResourceCommand);
      expect(mockSend.mock.calls[2]?.[0].input).toMatchObject({
        resourceArn: 'arn:aws:appsync:us-east-1:1:apis/api-1',
        tags: { Env: 'prod', Owner: 'team' },
      });
    });
  });

  // ─── GraphQLSchema ───────────────────────────────────────────────────

  describe('GraphQLSchema', () => {
    it('issues StartSchemaCreation when Definition diffs', async () => {
      mockSend.mockResolvedValueOnce({});

      const newProps = {
        ApiId: 'api-1',
        Definition: 'type Query { hello: String, world: String }',
      };
      const oldProps = {
        ApiId: 'api-1',
        Definition: 'type Query { hello: String }',
      };

      await provider.update('L', 'api-1', 'AWS::AppSync::GraphQLSchema', newProps, oldProps);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(StartSchemaCreationCommand);
      expect(cmd.input.apiId).toBe('api-1');
      // definition is a Uint8Array / Buffer of the SDL bytes
      expect(Buffer.from(cmd.input.definition).toString('utf-8')).toBe(
        'type Query { hello: String, world: String }'
      );
    });

    it('no-op when Definition unchanged', async () => {
      const same = { ApiId: 'api-1', Definition: 'type Query { hello: String }' };
      await provider.update('L', 'api-1', 'AWS::AppSync::GraphQLSchema', same, same);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ─── DataSource ──────────────────────────────────────────────────────

  describe('DataSource', () => {
    it('issues UpdateDataSource with Description / ServiceRoleArn / DynamoDBConfig diff', async () => {
      mockSend.mockResolvedValueOnce({});

      const newProps = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AMAZON_DYNAMODB',
        Description: 'updated',
        ServiceRoleArn: 'arn:aws:iam::1:role/AppSyncDDB',
        DynamoDBConfig: {
          TableName: 'my-table-v2',
          AwsRegion: 'us-east-1',
        },
      };
      const oldProps = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AMAZON_DYNAMODB',
        Description: '',
        ServiceRoleArn: 'arn:aws:iam::1:role/AppSyncDDB',
        DynamoDBConfig: {
          TableName: 'my-table-v1',
          AwsRegion: 'us-east-1',
        },
      };

      await provider.update(
        'L',
        'api-1|ddb-ds',
        'AWS::AppSync::DataSource',
        newProps,
        oldProps
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateDataSourceCommand);
      expect(cmd.input).toMatchObject({
        apiId: 'api-1',
        name: 'ddb-ds',
        type: 'AMAZON_DYNAMODB',
        description: 'updated',
        serviceRoleArn: 'arn:aws:iam::1:role/AppSyncDDB',
        dynamodbConfig: {
          tableName: 'my-table-v2',
          awsRegion: 'us-east-1',
        },
      });
    });

    it('issues UpdateDataSource clearing description via empty string', async () => {
      // !== undefined gate must allow '' (memory rule
      // feedback_update_optional_field_undefined_check).
      mockSend.mockResolvedValueOnce({});

      const newProps = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AMAZON_DYNAMODB',
        Description: '',
      };
      const oldProps = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AMAZON_DYNAMODB',
        Description: 'old-description',
      };

      await provider.update(
        'L',
        'api-1|ddb-ds',
        'AWS::AppSync::DataSource',
        newProps,
        oldProps
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd.input.description).toBe('');
    });

    it('no-op when nothing mutable diffs', async () => {
      const same = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AMAZON_DYNAMODB',
        Description: '',
        DynamoDBConfig: { TableName: 'my-table', AwsRegion: 'us-east-1' },
      };
      await provider.update(
        'L',
        'api-1|ddb-ds',
        'AWS::AppSync::DataSource',
        same,
        same
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when Type changes (immutable identity field)', async () => {
      const newProps = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AWS_LAMBDA',
      };
      const oldProps = {
        ApiId: 'api-1',
        Name: 'ddb-ds',
        Type: 'AMAZON_DYNAMODB',
      };
      await expect(
        provider.update('L', 'api-1|ddb-ds', 'AWS::AppSync::DataSource', newProps, oldProps)
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ─── Resolver ────────────────────────────────────────────────────────

  describe('Resolver', () => {
    it('issues UpdateResolver with VTL template + data source changes (UNIT)', async () => {
      mockSend.mockResolvedValueOnce({});

      const newProps = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        Kind: 'UNIT',
        DataSourceName: 'ds1',
        RequestMappingTemplate: '$newCtx',
        ResponseMappingTemplate: '$newResult',
      };
      const oldProps = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        Kind: 'UNIT',
        DataSourceName: 'ds1',
        RequestMappingTemplate: '$ctx',
        ResponseMappingTemplate: '$result',
      };

      await provider.update(
        'L',
        'api-1|Query|getThing',
        'AWS::AppSync::Resolver',
        newProps,
        oldProps
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateResolverCommand);
      expect(cmd.input).toMatchObject({
        apiId: 'api-1',
        typeName: 'Query',
        fieldName: 'getThing',
        kind: 'UNIT',
        dataSourceName: 'ds1',
        requestMappingTemplate: '$newCtx',
        responseMappingTemplate: '$newResult',
      });
    });

    it('issues UpdateResolver for PIPELINE Functions change', async () => {
      mockSend.mockResolvedValueOnce({});

      const newProps = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'pipe',
        Kind: 'PIPELINE',
        PipelineConfig: { Functions: ['fn-1', 'fn-2', 'fn-3'] },
      };
      const oldProps = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'pipe',
        Kind: 'PIPELINE',
        PipelineConfig: { Functions: ['fn-1', 'fn-2'] },
      };

      await provider.update(
        'L',
        'api-1|Query|pipe',
        'AWS::AppSync::Resolver',
        newProps,
        oldProps
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd.input.pipelineConfig).toEqual({ functions: ['fn-1', 'fn-2', 'fn-3'] });
    });

    it('no-op when nothing mutable diffs', async () => {
      const same = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        Kind: 'UNIT',
        DataSourceName: 'ds1',
        RequestMappingTemplate: '$ctx',
        ResponseMappingTemplate: '$result',
      };
      await provider.update(
        'L',
        'api-1|Query|getThing',
        'AWS::AppSync::Resolver',
        same,
        same
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when TypeName changes (immutable identity field)', async () => {
      const newProps = {
        ApiId: 'api-1',
        TypeName: 'Mutation',
        FieldName: 'getThing',
      };
      const oldProps = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
      };
      await expect(
        provider.update(
          'L',
          'api-1|Query|getThing',
          'AWS::AppSync::Resolver',
          newProps,
          oldProps
        )
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ─── ApiKey ──────────────────────────────────────────────────────────

  describe('ApiKey', () => {
    it('issues UpdateApiKey when Description or Expires diff', async () => {
      mockSend.mockResolvedValueOnce({});

      const newProps = {
        ApiId: 'api-1',
        Description: 'new',
        Expires: 1800000000,
      };
      const oldProps = {
        ApiId: 'api-1',
        Description: 'old',
        Expires: 1700000000,
      };

      await provider.update('L', 'api-1|k1', 'AWS::AppSync::ApiKey', newProps, oldProps);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateApiKeyCommand);
      expect(cmd.input).toMatchObject({
        apiId: 'api-1',
        id: 'k1',
        description: 'new',
        expires: 1800000000,
      });
    });

    it('no-op when Description and Expires unchanged', async () => {
      const same = {
        ApiId: 'api-1',
        Description: 'main',
        Expires: 1700000000,
      };
      await provider.update('L', 'api-1|k1', 'AWS::AppSync::ApiKey', same, same);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when ApiId changes (immutable identity)', async () => {
      const newProps = { ApiId: 'api-2', Description: 'x' };
      const oldProps = { ApiId: 'api-1', Description: 'x' };
      await expect(
        provider.update('L', 'api-1|k1', 'AWS::AppSync::ApiKey', newProps, oldProps)
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ─── Dispatch ────────────────────────────────────────────────────────

  it('rejects unknown AppSync resource type', async () => {
    await expect(
      provider.update('L', 'p', 'AWS::AppSync::Bogus', {}, {})
    ).rejects.toThrow(/Unsupported resource type/);
  });
});
