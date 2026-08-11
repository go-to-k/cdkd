import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// `vi.hoisted` because the spy is referenced from the `vi.mock` factory below,
// which is hoisted above ordinary top-level declarations.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { CreateDataSourceCommand, UpdateDataSourceCommand } from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';

const DATASOURCE_TYPE = 'AWS::AppSync::DataSource';

/**
 * Issue #1597: the two NESTED silent-drop families inside `AWS::AppSync::DataSource`
 * config blobs. Both were invisible to top-level property coverage because their
 * CONTAINERS (`HttpConfig` / `DynamoDBConfig`) have always been handled properties —
 * only the nested-key critic (`scripts/gen-nested-key-coverage.ts`, opted in for this
 * type by the same issue) can see one level down.
 *
 * The failure shape is the usual one: the AWS SDK v3 serializer drops members it does
 * not know, so a dropped nested block deploys "successfully" with the config missing.
 * For `HttpConfig.AuthorizationConfig` that is security-relevant — the data source
 * reaches AWS UNSIGNED and every request to the endpoint goes out without SigV4.
 *
 * Every assertion pins the EXACT SDK member spelling rather than "some config was
 * sent", and the `DeltaSyncConfig` TTL tests pin the CFn-string -> SDK-number
 * conversion in BOTH directions (a verbatim string forward is serializer-dropped;
 * a number on readback would be permanent phantom drift against the template).
 */
describe('AppSync DataSource nested config blobs (#1597)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new AppSyncProvider();
  });

  describe('HttpConfig.AuthorizationConfig (write)', () => {
    it('forwards the full IAM-signing chain with the exact SDK spellings on create', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'httpDs',
        Type: 'HTTP',
        HttpConfig: {
          Endpoint: 'https://states.us-east-1.amazonaws.com',
          AuthorizationConfig: {
            AuthorizationType: 'AWS_IAM',
            AwsIamConfig: {
              SigningRegion: 'us-east-1',
              SigningServiceName: 'states',
            },
          },
        },
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateDataSourceCommand);
      expect(cmd.input.httpConfig).toEqual({
        endpoint: 'https://states.us-east-1.amazonaws.com',
        authorizationConfig: {
          authorizationType: 'AWS_IAM',
          awsIamConfig: {
            signingRegion: 'us-east-1',
            signingServiceName: 'states',
          },
        },
      });
    });

    it('forwards it on UPDATE too (create and update share one mapper)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|httpDs',
        DATASOURCE_TYPE,
        {
          ApiId: 'api-1',
          Name: 'httpDs',
          Type: 'HTTP',
          HttpConfig: {
            Endpoint: 'https://states.us-east-1.amazonaws.com',
            AuthorizationConfig: {
              AuthorizationType: 'AWS_IAM',
              AwsIamConfig: { SigningRegion: 'us-east-1', SigningServiceName: 'states' },
            },
          },
        },
        {
          ApiId: 'api-1',
          Name: 'httpDs',
          Type: 'HTTP',
          HttpConfig: { Endpoint: 'https://states.us-east-1.amazonaws.com' },
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateDataSourceCommand);
      expect(cmd.input.httpConfig.authorizationConfig).toEqual({
        authorizationType: 'AWS_IAM',
        awsIamConfig: { signingRegion: 'us-east-1', signingServiceName: 'states' },
      });
    });

    it('omits authorizationConfig entirely for an unauthenticated endpoint', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'httpDs',
        Type: 'HTTP',
        HttpConfig: { Endpoint: 'https://example.com' },
      });

      const httpConfig = mockSend.mock.calls[0]?.[0].input.httpConfig;
      expect(httpConfig).toEqual({ endpoint: 'https://example.com' });
      expect(httpConfig).not.toHaveProperty('authorizationConfig');
    });

    it('forwards AuthorizationType alone when the template carries no AwsIamConfig', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'httpDs',
        Type: 'HTTP',
        HttpConfig: {
          Endpoint: 'https://example.com',
          AuthorizationConfig: { AuthorizationType: 'AWS_IAM' },
        },
      });

      expect(mockSend.mock.calls[0]?.[0].input.httpConfig.authorizationConfig).toEqual({
        authorizationType: 'AWS_IAM',
      });
    });

    it('refuses a malformed AuthorizationConfig container instead of dropping it', async () => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'httpDs',
          Type: 'HTTP',
          HttpConfig: { Endpoint: 'https://example.com', AuthorizationConfig: 'AWS_IAM' },
        })
      ).rejects.toThrow(
        /AWS::AppSync::DataSource HttpConfig.AuthorizationConfig must be an object/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a malformed AwsIamConfig container instead of dropping it', async () => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'httpDs',
          Type: 'HTTP',
          HttpConfig: {
            Endpoint: 'https://example.com',
            AuthorizationConfig: { AuthorizationType: 'AWS_IAM', AwsIamConfig: 'us-east-1' },
          },
        })
      ).rejects.toThrow(
        /AWS::AppSync::DataSource HttpConfig.AuthorizationConfig.AwsIamConfig must be an object/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('DynamoDBConfig.DeltaSyncConfig / Versioned (write)', () => {
    it('converts the CFn STRING TTLs to the SDK number members', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'ddbDs',
        Type: 'AMAZON_DYNAMODB',
        DynamoDBConfig: {
          TableName: 't',
          AwsRegion: 'us-east-1',
          Versioned: true,
          DeltaSyncConfig: {
            // CFn (and CDK's L1) type both TTLs as STRING; the SDK models them
            // as longs, so a verbatim forward is serializer-dropped.
            BaseTableTTL: '43200',
            DeltaSyncTableName: 'tDelta',
            DeltaSyncTableTTL: '1440',
          },
        },
      });

      expect(mockSend.mock.calls[0]?.[0].input.dynamodbConfig).toEqual({
        tableName: 't',
        awsRegion: 'us-east-1',
        versioned: true,
        deltaSyncConfig: {
          baseTableTTL: 43200,
          deltaSyncTableName: 'tDelta',
          deltaSyncTableTTL: 1440,
        },
      });
    });

    it('accepts a numeric TTL as well (a template that already used a number)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'ddbDs',
        Type: 'AMAZON_DYNAMODB',
        DynamoDBConfig: {
          TableName: 't',
          AwsRegion: 'us-east-1',
          DeltaSyncConfig: { BaseTableTTL: 43200, DeltaSyncTableName: 'tDelta' },
        },
      });

      expect(mockSend.mock.calls[0]?.[0].input.dynamodbConfig.deltaSyncConfig).toEqual({
        baseTableTTL: 43200,
        deltaSyncTableName: 'tDelta',
      });
    });

    it('threads Versioned: false (the falsy polarity survives the !== undefined gate)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'ddbDs',
        Type: 'AMAZON_DYNAMODB',
        DynamoDBConfig: { TableName: 't', AwsRegion: 'us-east-1', Versioned: false },
      });

      expect(mockSend.mock.calls[0]?.[0].input.dynamodbConfig).toEqual({
        tableName: 't',
        awsRegion: 'us-east-1',
        versioned: false,
      });
    });

    it('leaves an un-versioned table free of both members', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'ddbDs',
        Type: 'AMAZON_DYNAMODB',
        DynamoDBConfig: { TableName: 't', AwsRegion: 'us-east-1' },
      });

      const ddb = mockSend.mock.calls[0]?.[0].input.dynamodbConfig;
      expect(ddb).toEqual({ tableName: 't', awsRegion: 'us-east-1' });
      expect(ddb).not.toHaveProperty('versioned');
      expect(ddb).not.toHaveProperty('deltaSyncConfig');
    });

    it('refuses a non-numeric TTL loudly instead of sending NaN', async () => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'ddbDs',
          Type: 'AMAZON_DYNAMODB',
          DynamoDBConfig: {
            TableName: 't',
            AwsRegion: 'us-east-1',
            DeltaSyncConfig: { BaseTableTTL: 'twelve hours', DeltaSyncTableName: 'tDelta' },
          },
        })
      ).rejects.toThrow(
        /DynamoDBConfig.DeltaSyncConfig.BaseTableTTL must be a number of minutes/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    // `Number('')` / `Number(null)` / `Number([])` are all 0 and `Number(true)`
    // is 1 — every one of them FINITE, so a `Number.isFinite` guard alone
    // accepts them and deploys a live data source with a ZERO-minute TTL. An
    // unresolved intrinsic and an empty CFn value both land here, which is why
    // the accepted shapes are enumerated rather than coerced.
    it.each([
      ['', 'empty string'],
      ['   ', 'blank string'],
      [null, 'null'],
      [[], 'empty array'],
      [true, 'boolean true'],
      [false, 'boolean false'],
      [{}, 'object'],
    ])('refuses a %j TTL (%s) instead of coercing it to a number', async (ttl, _label) => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'ddbDs',
          Type: 'AMAZON_DYNAMODB',
          DynamoDBConfig: {
            TableName: 't',
            AwsRegion: 'us-east-1',
            DeltaSyncConfig: { BaseTableTTL: ttl, DeltaSyncTableName: 'tDelta' },
          },
        })
      ).rejects.toThrow(
        /DynamoDBConfig.DeltaSyncConfig.BaseTableTTL must be a number of minutes/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    // The two call sites pass DIFFERENT `path` strings, so a copy-paste of the
    // wrong one is only visible from the second site's own refusal.
    it('refuses a non-numeric DeltaSyncTableTTL, naming ITS path', async () => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'ddbDs',
          Type: 'AMAZON_DYNAMODB',
          DynamoDBConfig: {
            TableName: 't',
            AwsRegion: 'us-east-1',
            DeltaSyncConfig: { BaseTableTTL: '43200', DeltaSyncTableTTL: 'daily' },
          },
        })
      ).rejects.toThrow(
        /DynamoDBConfig.DeltaSyncConfig.DeltaSyncTableTTL must be a number of minutes/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('forwards the DynamoDB block on UPDATE too (create and update share one mapper)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1|ddbDs',
        DATASOURCE_TYPE,
        {
          ApiId: 'api-1',
          Name: 'ddbDs',
          Type: 'AMAZON_DYNAMODB',
          DynamoDBConfig: {
            TableName: 't',
            AwsRegion: 'us-east-1',
            Versioned: true,
            DeltaSyncConfig: { BaseTableTTL: '86400', DeltaSyncTableName: 'tDelta' },
          },
        },
        {
          ApiId: 'api-1',
          Name: 'ddbDs',
          Type: 'AMAZON_DYNAMODB',
          DynamoDBConfig: { TableName: 't', AwsRegion: 'us-east-1' },
        }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateDataSourceCommand);
      expect(cmd.input.dynamodbConfig).toEqual({
        tableName: 't',
        awsRegion: 'us-east-1',
        versioned: true,
        deltaSyncConfig: { baseTableTTL: 86400, deltaSyncTableName: 'tDelta' },
      });
    });

    it('refuses a malformed DeltaSyncConfig container instead of dropping it', async () => {
      await expect(
        provider.create('L', DATASOURCE_TYPE, {
          ApiId: 'api-1',
          Name: 'ddbDs',
          Type: 'AMAZON_DYNAMODB',
          DynamoDBConfig: { TableName: 't', AwsRegion: 'us-east-1', DeltaSyncConfig: '43200' },
        })
      ).rejects.toThrow(
        /AWS::AppSync::DataSource DynamoDBConfig.DeltaSyncConfig must be an object/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('readCurrentState reverse maps', () => {
    it('reverse-maps httpConfig.authorizationConfig to the CFn shape', async () => {
      mockSend.mockResolvedValueOnce({
        dataSource: {
          name: 'httpDs',
          type: 'HTTP',
          httpConfig: {
            endpoint: 'https://states.us-east-1.amazonaws.com',
            authorizationConfig: {
              authorizationType: 'AWS_IAM',
              awsIamConfig: { signingRegion: 'us-east-1', signingServiceName: 'states' },
            },
          },
        },
      });

      const result = await provider.readCurrentState('api-1|httpDs', 'L', DATASOURCE_TYPE);

      expect(result?.['HttpConfig']).toEqual({
        Endpoint: 'https://states.us-east-1.amazonaws.com',
        AuthorizationConfig: {
          AuthorizationType: 'AWS_IAM',
          AwsIamConfig: { SigningRegion: 'us-east-1', SigningServiceName: 'states' },
        },
      });
    });

    it('keeps an unauthenticated HttpConfig free of an empty AuthorizationConfig', async () => {
      mockSend.mockResolvedValueOnce({
        dataSource: { name: 'httpDs', type: 'HTTP', httpConfig: { endpoint: 'https://x.com' } },
      });

      const result = await provider.readCurrentState('api-1|httpDs', 'L', DATASOURCE_TYPE);

      expect(result?.['HttpConfig']).toEqual({ Endpoint: 'https://x.com' });
    });

    it('reverse-maps the deltaSyncConfig TTLs back to STRINGS (phantom-drift pin)', async () => {
      // AWS returns longs. The template — and therefore the drift baseline —
      // carries CFn's declared STRING, and the comparator is stringify-based,
      // so emitting the number here would report drift on every single run.
      mockSend.mockResolvedValueOnce({
        dataSource: {
          name: 'ddbDs',
          type: 'AMAZON_DYNAMODB',
          dynamodbConfig: {
            tableName: 't',
            awsRegion: 'us-east-1',
            versioned: true,
            deltaSyncConfig: {
              baseTableTTL: 43200,
              deltaSyncTableName: 'tDelta',
              deltaSyncTableTTL: 1440,
            },
          },
        },
      });

      const result = await provider.readCurrentState('api-1|ddbDs', 'L', DATASOURCE_TYPE);

      expect(result?.['DynamoDBConfig']).toEqual({
        TableName: 't',
        AwsRegion: 'us-east-1',
        Versioned: true,
        DeltaSyncConfig: {
          BaseTableTTL: '43200',
          DeltaSyncTableName: 'tDelta',
          DeltaSyncTableTTL: '1440',
        },
      });
    });

    it('round-trips a versioned DynamoDB data source template -> SDK -> template', async () => {
      const template = {
        TableName: 't',
        AwsRegion: 'us-east-1',
        Versioned: true,
        DeltaSyncConfig: {
          BaseTableTTL: '43200',
          DeltaSyncTableName: 'tDelta',
          DeltaSyncTableTTL: '1440',
        },
      };

      mockSend.mockResolvedValueOnce({});
      await provider.create('L', DATASOURCE_TYPE, {
        ApiId: 'api-1',
        Name: 'ddbDs',
        Type: 'AMAZON_DYNAMODB',
        DynamoDBConfig: template,
      });
      const sent = mockSend.mock.calls[0]?.[0].input.dynamodbConfig;

      // Feed exactly what the write side produced back as the AWS readback.
      mockSend.mockResolvedValueOnce({
        dataSource: { name: 'ddbDs', type: 'AMAZON_DYNAMODB', dynamodbConfig: sent },
      });
      const result = await provider.readCurrentState('api-1|ddbDs', 'L', DATASOURCE_TYPE);

      expect(result?.['DynamoDBConfig']).toEqual(template);
    });

    // The FALSY polarity of the read side, which the write side pins
    // separately: with a truthiness gate instead of `!== undefined`, a
    // conflict-detection-DISABLED data source would read back with `Versioned`
    // absent, and the drift comparator would report the key as removed on
    // every run. This is the shape AWS actually returns for a plain DynamoDB
    // data source, so it is also the more common one.
    it('reverse-maps versioned: false rather than dropping it', async () => {
      mockSend.mockResolvedValueOnce({
        dataSource: {
          name: 'ddbDs',
          type: 'AMAZON_DYNAMODB',
          dynamodbConfig: {
            tableName: 't',
            awsRegion: 'us-east-1',
            versioned: false,
            useCallerCredentials: false,
          },
        },
      });

      const result = await provider.readCurrentState('api-1|ddbDs', 'L', DATASOURCE_TYPE);

      expect(result?.['DynamoDBConfig']).toEqual({
        TableName: 't',
        AwsRegion: 'us-east-1',
        Versioned: false,
        UseCallerCredentials: false,
      });
    });

    it('omits DynamoDBConfig sub-members AWS did not return', async () => {
      mockSend.mockResolvedValueOnce({
        dataSource: {
          name: 'ddbDs',
          type: 'AMAZON_DYNAMODB',
          dynamodbConfig: { tableName: 't', awsRegion: 'us-east-1' },
        },
      });

      const result = await provider.readCurrentState('api-1|ddbDs', 'L', DATASOURCE_TYPE);

      expect(result?.['DynamoDBConfig']).toEqual({ TableName: 't', AwsRegion: 'us-east-1' });
    });
  });
});
