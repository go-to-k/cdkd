import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// `vi.hoisted` because the spies are referenced from the `vi.mock` factories
// below, which are hoisted above ordinary top-level declarations.
const { mockSend, mockS3Send, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockS3Send: vi.fn(),
  warnSpy: vi.fn(),
}));

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

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockS3Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  CreateDataSourceCommand,
  CreateResolverCommand,
  StartSchemaCreationCommand,
  UpdateDataSourceCommand,
  UpdateResolverCommand,
} from '@aws-sdk/client-appsync';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

const RESOLVER_TYPE = 'AWS::AppSync::Resolver';
const DATASOURCE_TYPE = 'AWS::AppSync::DataSource';
const SCHEMA_TYPE = 'AWS::AppSync::GraphQLSchema';

/** Minimal shape of a GetObject response body the provider consumes. */
function s3Body(text: string): { Body: { transformToString: () => Promise<string> } } {
  return { Body: { transformToString: () => Promise.resolve(text) } };
}

/**
 * Issue #609 backfill: the 12 `AWS::AppSync::Resolver` /
 * `AWS::AppSync::DataSource` properties cdkd used to silently drop on write,
 * plus the `GraphQLSchema.DefinitionS3Location` warn-and-drop sibling.
 *
 * The failure these tests exist for is NOT a crash — the AWS SDK v3
 * serializer drops members it does not know, so a near-miss spelling
 * (`dbClusterIdentifer`, `opensearchServiceConfig`,
 * `lambdaConflictHandlerCfg`) deploys "successfully" with the config
 * missing. Every assertion below therefore pins the EXACT SDK member name
 * rather than "some config was sent". The three `*S3Location` properties
 * have NO SDK member at all — CloudFormation fetches the S3 object body and
 * passes it inline, and the S3 tests pin that fetch-and-inline path.
 */
describe('AppSync Resolver + DataSource properties (#609)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    provider = new AppSyncProvider();
  });

  describe('Resolver create', () => {
    it('wires CachingConfig / SyncConfig / MaxBatchSize / MetricsConfig with the exact SDK spellings', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', RESOLVER_TYPE, {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        DataSourceName: 'ds1',
        RequestMappingTemplate: '$ctx',
        ResponseMappingTemplate: '$result',
        CachingConfig: { Ttl: 120, CachingKeys: ['$context.identity.sub'] },
        SyncConfig: {
          ConflictDetection: 'VERSION',
          ConflictHandler: 'LAMBDA',
          LambdaConflictHandlerConfig: {
            LambdaConflictHandlerArn: 'arn:aws:lambda:us-east-1:1:function:conflict',
          },
        },
        MaxBatchSize: 10,
        MetricsConfig: 'ENABLED',
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateResolverCommand);
      expect(cmd.input).toMatchObject({
        apiId: 'api-1',
        typeName: 'Query',
        fieldName: 'getThing',
        dataSourceName: 'ds1',
        cachingConfig: { ttl: 120, cachingKeys: ['$context.identity.sub'] },
        syncConfig: {
          conflictDetection: 'VERSION',
          conflictHandler: 'LAMBDA',
          lambdaConflictHandlerConfig: {
            lambdaConflictHandlerArn: 'arn:aws:lambda:us-east-1:1:function:conflict',
          },
        },
        maxBatchSize: 10,
        // Scalar enum — NOT a block.
        metricsConfig: 'ENABLED',
      });
      // The exact camelCase keys must be present — `toMatchObject` above
      // would pass on a PascalCase sibling key sitting next to a missing one.
      expect(Object.keys(cmd.input)).toEqual(
        expect.arrayContaining(['cachingConfig', 'syncConfig', 'maxBatchSize', 'metricsConfig'])
      );
    });

    it('fetches Request/ResponseMappingTemplateS3Location bodies and inlines them (no URL member exists)', async () => {
      mockS3Send
        .mockResolvedValueOnce(s3Body('## request template'))
        .mockResolvedValueOnce(s3Body('## response template'));
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', RESOLVER_TYPE, {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        DataSourceName: 'ds1',
        RequestMappingTemplateS3Location: 's3://asset-bucket/assets/req.vtl',
        ResponseMappingTemplateS3Location: 's3://asset-bucket/deeper/path/res.vtl',
      });

      // Bucket / key parsed off the s3:// URL — the key keeps its slashes.
      expect(mockS3Send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
      expect(mockS3Send.mock.calls[0]?.[0].input).toEqual({
        Bucket: 'asset-bucket',
        Key: 'assets/req.vtl',
      });
      expect(mockS3Send.mock.calls[1]?.[0].input).toEqual({
        Bucket: 'asset-bucket',
        Key: 'deeper/path/res.vtl',
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateResolverCommand);
      expect(cmd.input.requestMappingTemplate).toBe('## request template');
      expect(cmd.input.responseMappingTemplate).toBe('## response template');
    });

    it('fetches CodeS3Location for a JS resolver and passes the body as code', async () => {
      mockS3Send.mockResolvedValueOnce(s3Body('export function request() {}'));
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', RESOLVER_TYPE, {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        DataSourceName: 'ds1',
        Runtime: { Name: 'APPSYNC_JS', RuntimeVersion: '1.0.0' },
        CodeS3Location: 's3://asset-bucket/code.js',
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd.input.code).toBe('export function request() {}');
      expect(cmd.input.runtime).toEqual({ name: 'APPSYNC_JS', runtimeVersion: '1.0.0' });
    });

    it('inline template wins over its S3Location sibling (warn, no S3 call)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', RESOLVER_TYPE, {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        DataSourceName: 'ds1',
        RequestMappingTemplate: '$inline',
        RequestMappingTemplateS3Location: 's3://asset-bucket/req.vtl',
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd.input.requestMappingTemplate).toBe('$inline');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('both RequestMappingTemplate and RequestMappingTemplateS3Location')
      );
    });

    it('refuses a malformed *S3Location URL with a clear error naming the property', async () => {
      await expect(
        provider.create('L', RESOLVER_TYPE, {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          CodeS3Location: 'https://asset-bucket.s3.amazonaws.com/code.js',
        })
      ).rejects.toThrow(ProvisioningError);
      await expect(
        provider.create('L', RESOLVER_TYPE, {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          CodeS3Location: 'https://asset-bucket.s3.amazonaws.com/code.js',
        })
      ).rejects.toThrow(/CodeS3Location must be an s3:\/\/bucket\/key URL/);
      // An unresolved intrinsic (object where a string belongs) is refused
      // too, never coerced or silently dropped.
      await expect(
        provider.create('L', RESOLVER_TYPE, {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          RequestMappingTemplateS3Location: { Ref: 'SomeBucket' },
        })
      ).rejects.toThrow(/RequestMappingTemplateS3Location must be a string s3:\/\/bucket\/key URL/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses an empty S3 object body instead of sending "" to AppSync', async () => {
      mockS3Send.mockResolvedValueOnce(s3Body(''));

      await expect(
        provider.create('L', RESOLVER_TYPE, {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          RequestMappingTemplateS3Location: 's3://asset-bucket/empty.vtl',
        })
      ).rejects.toThrow(/returned an empty body/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a malformed CachingConfig container (never silently drops it)', async () => {
      await expect(
        provider.create('L', RESOLVER_TYPE, {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          CachingConfig: 'ttl=120',
        })
      ).rejects.toThrow(/AWS::AppSync::Resolver CachingConfig must be an object/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('Kind discriminator, both polarities: UNIT forwards dataSourceName, PIPELINE drops it', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.create('L', RESOLVER_TYPE, {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'unitThing',
        Kind: 'UNIT',
        DataSourceName: 'ds1',
      });
      expect(mockSend.mock.calls[0]?.[0].input.dataSourceName).toBe('ds1');

      mockSend.mockResolvedValueOnce({});
      await provider.create('L', RESOLVER_TYPE, {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'pipeThing',
        Kind: 'PIPELINE',
        DataSourceName: 'ds1', // AWS rejects this on a PIPELINE resolver
        PipelineConfig: { Functions: ['fn-1'] },
      });
      const pipeline = mockSend.mock.calls[1]?.[0];
      expect(pipeline.input).not.toHaveProperty('dataSourceName');
      expect(pipeline.input.pipelineConfig).toEqual({ functions: ['fn-1'] });
    });
  });

  describe('Resolver update (full-replace removal semantics)', () => {
    it('fires on a CachingConfig-only change and re-sends the full desired config', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|Query|getThing',
        RESOLVER_TYPE,
        {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          DataSourceName: 'ds1',
          RequestMappingTemplate: '$ctx',
          CachingConfig: { Ttl: 300 },
        },
        {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          DataSourceName: 'ds1',
          RequestMappingTemplate: '$ctx',
          CachingConfig: { Ttl: 120 },
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateResolverCommand);
      expect(cmd.input.cachingConfig).toEqual({ ttl: 300 });
      // Full-replace: the unchanged members ride along on every update.
      expect(cmd.input.requestMappingTemplate).toBe('$ctx');
      expect(cmd.input.dataSourceName).toBe('ds1');
    });

    it('removal: MetricsConfig dropped from the template fires the update and OMITS metricsConfig (AppSync clears it)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|Query|getThing',
        RESOLVER_TYPE,
        {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          DataSourceName: 'ds1',
          RequestMappingTemplate: '$ctx',
        },
        {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          DataSourceName: 'ds1',
          RequestMappingTemplate: '$ctx',
          MetricsConfig: 'ENABLED',
        }
      );

      // The removal MUST fire the call (an omitted member only clears when
      // the update is actually issued)...
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateResolverCommand);
      // ...and the input must NOT carry the member: UpdateResolver is a
      // full-replace write, so omission IS the clearing mechanism.
      expect(cmd.input).not.toHaveProperty('metricsConfig');
      // The retained sibling still rides along.
      expect(cmd.input.requestMappingTemplate).toBe('$ctx');
    });

    it('re-fetches a changed RequestMappingTemplateS3Location and sends the new body', async () => {
      mockS3Send.mockResolvedValueOnce(s3Body('## v2 template'));
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|Query|getThing',
        RESOLVER_TYPE,
        {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          DataSourceName: 'ds1',
          RequestMappingTemplateS3Location: 's3://asset-bucket/req-v2.vtl',
        },
        {
          ApiId: 'api-1',
          TypeName: 'Query',
          FieldName: 'getThing',
          DataSourceName: 'ds1',
          RequestMappingTemplateS3Location: 's3://asset-bucket/req-v1.vtl',
        }
      );

      expect(mockS3Send.mock.calls[0]?.[0].input).toEqual({
        Bucket: 'asset-bucket',
        Key: 'req-v2.vtl',
      });
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateResolverCommand);
      expect(cmd.input.requestMappingTemplate).toBe('## v2 template');
    });

    it('no-op when the *S3Location URL and every other mutable member are unchanged', async () => {
      const bag = {
        ApiId: 'api-1',
        TypeName: 'Query',
        FieldName: 'getThing',
        DataSourceName: 'ds1',
        RequestMappingTemplateS3Location: 's3://asset-bucket/req-v1.vtl',
      };
      const result = await provider.update(
        'L',
        'api-1|Query|getThing',
        RESOLVER_TYPE,
        { ...bag },
        { ...bag }
      );
      expect(result).toEqual({ physicalId: 'api-1|Query|getThing', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  describe('DataSource create', () => {
    it('wires EventBridgeConfig + MetricsConfig with the exact SDK spellings', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'busDs',
        Type: 'AMAZON_EVENTBRIDGE',
        ServiceRoleArn: 'arn:aws:iam::1:role/appsync-events',
        EventBridgeConfig: { EventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus' },
        MetricsConfig: 'ENABLED',
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateDataSourceCommand);
      expect(cmd.input).toMatchObject({
        apiId: 'api-1',
        name: 'busDs',
        type: 'AMAZON_EVENTBRIDGE',
        serviceRoleArn: 'arn:aws:iam::1:role/appsync-events',
        eventBridgeConfig: { eventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus' },
        metricsConfig: 'ENABLED',
      });
      expect(Object.keys(cmd.input)).toEqual(
        expect.arrayContaining(['eventBridgeConfig', 'metricsConfig'])
      );
    });

    it('wires OpenSearchServiceConfig and the legacy ElasticsearchConfig alias', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'osDs',
        Type: 'AMAZON_OPENSEARCH_SERVICE',
        ServiceRoleArn: 'arn:aws:iam::1:role/appsync-os',
        OpenSearchServiceConfig: { Endpoint: 'https://os.example.com', AwsRegion: 'us-east-1' },
      });
      // `openSearchServiceConfig` — interior capitals pinned; a near-miss is
      // serializer-dropped.
      expect(mockSend.mock.calls[0]?.[0].input.openSearchServiceConfig).toEqual({
        endpoint: 'https://os.example.com',
        awsRegion: 'us-east-1',
      });

      mockSend.mockResolvedValueOnce({});
      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'esDs',
        Type: 'AMAZON_ELASTICSEARCH',
        ServiceRoleArn: 'arn:aws:iam::1:role/appsync-es',
        ElasticsearchConfig: { Endpoint: 'https://es.example.com', AwsRegion: 'us-east-1' },
      });
      expect(mockSend.mock.calls[1]?.[0].input.elasticsearchConfig).toEqual({
        endpoint: 'https://es.example.com',
        awsRegion: 'us-east-1',
      });
    });

    it('wires RelationalDatabaseConfig incl. the DbClusterIdentifier casing trap', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'rdsDs',
        Type: 'RELATIONAL_DATABASE',
        ServiceRoleArn: 'arn:aws:iam::1:role/appsync-rds',
        RelationalDatabaseConfig: {
          RelationalDatabaseSourceType: 'RDS_HTTP_ENDPOINT',
          RdsHttpEndpointConfig: {
            AwsRegion: 'us-east-1',
            // CFn spells it `DbClusterIdentifier`; the SDK member is
            // `dbClusterIdentifier` — a `dbClusterIdentifer` /
            // `DBClusterIdentifier` near-miss is serializer-dropped.
            DbClusterIdentifier: 'arn:aws:rds:us-east-1:1:cluster:c1',
            DatabaseName: 'db',
            Schema: 'public',
            AwsSecretStoreArn: 'arn:aws:secretsmanager:us-east-1:1:secret:s1',
          },
        },
      });

      expect(mockSend.mock.calls[0]?.[0].input.relationalDatabaseConfig).toEqual({
        relationalDatabaseSourceType: 'RDS_HTTP_ENDPOINT',
        rdsHttpEndpointConfig: {
          awsRegion: 'us-east-1',
          dbClusterIdentifier: 'arn:aws:rds:us-east-1:1:cluster:c1',
          databaseName: 'db',
          schema: 'public',
          awsSecretStoreArn: 'arn:aws:secretsmanager:us-east-1:1:secret:s1',
        },
      });
    });

    it('refuses a malformed config container instead of dropping it', async () => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'busDs',
          Type: 'AMAZON_EVENTBRIDGE',
          EventBridgeConfig: 'arn:aws:events:us-east-1:1:event-bus/bus',
        })
      ).rejects.toThrow(/AWS::AppSync::DataSource EventBridgeConfig must be an object/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('DataSource update (full-replace removal semantics)', () => {
    it('removal: MetricsConfig dropped from the template fires the update and OMITS metricsConfig', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|busDs',
        DATASOURCE_TYPE,
        {
          ApiId: 'api-1',
          Name: 'busDs',
          Type: 'AMAZON_EVENTBRIDGE',
          ServiceRoleArn: 'arn:aws:iam::1:role/appsync-events',
          EventBridgeConfig: { EventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus' },
        },
        {
          ApiId: 'api-1',
          Name: 'busDs',
          Type: 'AMAZON_EVENTBRIDGE',
          ServiceRoleArn: 'arn:aws:iam::1:role/appsync-events',
          EventBridgeConfig: { EventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus' },
          MetricsConfig: 'ENABLED',
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateDataSourceCommand);
      expect(cmd.input).not.toHaveProperty('metricsConfig');
      // The retained sibling config still rides along (full-replace).
      expect(cmd.input.eventBridgeConfig).toEqual({
        eventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus',
      });
    });

    it('fires on a MetricsConfig-only change (ENABLED -> DISABLED)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|busDs',
        DATASOURCE_TYPE,
        {
          ApiId: 'api-1',
          Name: 'busDs',
          Type: 'AMAZON_EVENTBRIDGE',
          EventBridgeConfig: { EventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus' },
          MetricsConfig: 'DISABLED',
        },
        {
          ApiId: 'api-1',
          Name: 'busDs',
          Type: 'AMAZON_EVENTBRIDGE',
          EventBridgeConfig: { EventBusArn: 'arn:aws:events:us-east-1:1:event-bus/bus' },
          MetricsConfig: 'ENABLED',
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateDataSourceCommand);
      expect(cmd.input.metricsConfig).toBe('DISABLED');
    });
  });

  describe('GraphQLSchema DefinitionS3Location (fetch-and-inline sibling)', () => {
    it('create fetches the S3 body and submits it via StartSchemaCreation', async () => {
      mockS3Send.mockResolvedValueOnce(s3Body('type Query { hello: String }'));
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', SCHEMA_TYPE, {
        ApiId: 'api-1',
        DefinitionS3Location: 's3://asset-bucket/schema.graphql',
      });

      expect(mockS3Send.mock.calls[0]?.[0].input).toEqual({
        Bucket: 'asset-bucket',
        Key: 'schema.graphql',
      });
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(StartSchemaCreationCommand);
      expect(new TextDecoder().decode(cmd.input.definition)).toBe('type Query { hello: String }');
    });

    it('create prefers the inline Definition over DefinitionS3Location (warn, no S3 call)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', SCHEMA_TYPE, {
        ApiId: 'api-1',
        Definition: 'type Query { inline: String }',
        DefinitionS3Location: 's3://asset-bucket/schema.graphql',
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(new TextDecoder().decode(cmd.input.definition)).toBe(
        'type Query { inline: String }'
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('both Definition and DefinitionS3Location')
      );
    });

    it('update re-fetches when the DefinitionS3Location URL changed, no-ops when unchanged', async () => {
      // Unchanged URL — no fetch, no upload (CFn parity: the template did
      // not change; CDK assets bake the content hash into the key).
      const unchanged = await provider.update(
        'L',
        'api-1',
        SCHEMA_TYPE,
        { ApiId: 'api-1', DefinitionS3Location: 's3://asset-bucket/schema-v1.graphql' },
        { ApiId: 'api-1', DefinitionS3Location: 's3://asset-bucket/schema-v1.graphql' }
      );
      expect(unchanged).toEqual({ physicalId: 'api-1', wasReplaced: false });
      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();

      // Changed URL — fetch + StartSchemaCreation with the new body.
      mockS3Send.mockResolvedValueOnce(s3Body('type Query { v2: String }'));
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        'api-1',
        SCHEMA_TYPE,
        { ApiId: 'api-1', DefinitionS3Location: 's3://asset-bucket/schema-v2.graphql' },
        { ApiId: 'api-1', DefinitionS3Location: 's3://asset-bucket/schema-v1.graphql' }
      );
      expect(mockS3Send.mock.calls[0]?.[0].input).toEqual({
        Bucket: 'asset-bucket',
        Key: 'schema-v2.graphql',
      });
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(StartSchemaCreationCommand);
      expect(new TextDecoder().decode(cmd.input.definition)).toBe('type Query { v2: String }');
    });
  });

  describe('generated property coverage agreement', () => {
    it('declares zero silent-drop properties for Resolver + DataSource (types CLOSED)', () => {
      const resolver = PROPERTY_COVERAGE_BY_TYPE.get(RESOLVER_TYPE);
      const dataSource = PROPERTY_COVERAGE_BY_TYPE.get(DATASOURCE_TYPE);
      expect(resolver).toBeDefined();
      expect(dataSource).toBeDefined();
      expect([...(resolver?.silentDrop.keys() ?? ['<missing>'])]).toEqual([]);
      expect([...(dataSource?.silentDrop.keys() ?? ['<missing>'])]).toEqual([]);

      for (const prop of [
        'CachingConfig',
        'CodeS3Location',
        'MaxBatchSize',
        'MetricsConfig',
        'RequestMappingTemplateS3Location',
        'ResponseMappingTemplateS3Location',
        'SyncConfig',
      ]) {
        expect(resolver?.handled.has(prop), `Resolver.${prop} handled`).toBe(true);
      }
      for (const prop of [
        'ElasticsearchConfig',
        'EventBridgeConfig',
        'MetricsConfig',
        'OpenSearchServiceConfig',
        'RelationalDatabaseConfig',
      ]) {
        expect(dataSource?.handled.has(prop), `DataSource.${prop} handled`).toBe(true);
      }
    });
  });
});
