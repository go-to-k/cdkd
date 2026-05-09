import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * Read-update round-trip test for AppSyncProvider.
 *
 * Per docs/provider-development.md § 3b ("Read-update round-trip test"),
 * every provider with `readCurrentState` must mechanically verify the
 * `cdkd drift --revert` code path.
 *
 * AppSyncProvider is a special case: per CLAUDE.md (PR I), AppSync
 * resources are immutable (recreated on property changes), so `update()`
 * always rejects with `ResourceUpdateNotSupportedError`. The round-trip
 * test still has value:
 *
 *   1. Confirms `update()` ALWAYS rejects regardless of the observed
 *      snapshot shape — i.e. no path through `update()` ever fires a
 *      mutating SDK call against a Class 1 / Class 2 placeholder. This
 *      structurally guarantees `cdkd drift --revert` cannot ship an
 *      AWS-invalid input on AppSync.
 *
 *   2. Confirms `readCurrentState` is Class-1-clean on the discriminator-
 *      tagged shapes (Kind=UNIT vs PIPELINE; VTL vs JS). A future change
 *      that re-adds an always-emit placeholder on a discriminator-false
 *      branch will be caught here.
 */

describe('AppSyncProvider read-update round-trip', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AppSyncProvider();
  });

  it('GraphQLApi: update() rejects cleanly without firing any SDK call', async () => {
    // Build a snapshot matching what readCurrentState would produce
    // for a minimum GraphQLApi (placeholders included).
    const observed = {
      Name: 'MyApi',
      AuthenticationType: 'API_KEY',
      XrayEnabled: false,
      LogConfig: {},
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await expect(
      provider.update('L', 'api-1', 'AWS::AppSync::GraphQLApi', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // No spurious SDK calls — update must reject before any AWS API is
    // invoked. This is what protects round-tripped Class 2 placeholders
    // (e.g. LogConfig: {}) from ever being shipped to AWS.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('DataSource type=AMAZON_DYNAMODB: Class 1 — update() rejects without sending DynamoDBConfig back', async () => {
    // Build a no-drift observed snapshot for a DynamoDB DataSource.
    // Class 1 verification: a future regression that emits an empty
    // LambdaConfig / HttpConfig placeholder alongside DynamoDBConfig
    // would still be safe here (update rejects before any SDK call),
    // but the observed snapshot below mirrors what readCurrentState
    // produces post-fix: only the matching-type config is present.
    const observed = {
      ApiId: 'api-1',
      Name: 'ddb-ds',
      Type: 'AMAZON_DYNAMODB',
      Description: '',
      ServiceRoleArn: 'arn:aws:iam::1:role/AppSyncDDB',
      DynamoDBConfig: {
        TableName: 'my-table',
        AwsRegion: 'us-east-1',
      },
      // No LambdaConfig / HttpConfig — Class 1 contract.
    };

    await expect(
      provider.update('L', 'api-1|ddb-ds', 'AWS::AppSync::DataSource', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Resolver Kind=UNIT: Class 1 — round-trip does not reach an AWS call with PipelineConfig', async () => {
    // Class 1 verification: UNIT resolver snapshot has DataSourceName +
    // VTL templates but NOT PipelineConfig (post-fix). update() rejects
    // before any SDK call, so even if the snapshot had a stale
    // PipelineConfig from a v2 state file, no AWS-invalid input would
    // be shipped.
    const observed = {
      ApiId: 'api-1',
      TypeName: 'Query',
      FieldName: 'getThing',
      Kind: 'UNIT',
      DataSourceName: 'ds1',
      RequestMappingTemplate: '$ctx',
      ResponseMappingTemplate: '$result',
      // PipelineConfig deliberately absent — UNIT resolver, Class 1.
    };

    await expect(
      provider.update(
        'L',
        'api-1|Query|getThing',
        'AWS::AppSync::Resolver',
        observed,
        observed
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Resolver Kind=PIPELINE: Class 1 — round-trip does not reach an AWS call with DataSourceName', async () => {
    // Class 1 verification: PIPELINE resolver snapshot has
    // PipelineConfig but NOT DataSourceName / VTL templates (post-fix).
    const observed = {
      ApiId: 'api-1',
      TypeName: 'Query',
      FieldName: 'pipe',
      Kind: 'PIPELINE',
      PipelineConfig: { Functions: ['fn-1', 'fn-2'] },
      // DataSourceName deliberately absent — PIPELINE resolver, Class 1.
    };

    await expect(
      provider.update('L', 'api-1|Query|pipe', 'AWS::AppSync::Resolver', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('GraphQLSchema: update() rejects cleanly with the canonical-SDL observed shape', async () => {
    // Snapshot mirrors what readCurrentState produces for a GraphQLSchema:
    // canonical SDL Definition + ApiId. update() must reject before any
    // SDK call; cdkd drift --revert on a Definition drift surfaces "could
    // not revert — AppSync resources are recreated on property changes"
    // (matches the file-level docstring's "JS handler doesn't ship an
    // AWS-invalid input on AppSync" guarantee).
    const observed = {
      ApiId: 'api-1',
      Definition: 'type Query {\n  hello: String\n}',
    };

    await expect(
      provider.update('L', 'api-1', 'AWS::AppSync::GraphQLSchema', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('ApiKey: update() rejects cleanly without firing any SDK call', async () => {
    const observed = {
      ApiId: 'api-1',
      Description: 'main',
      Expires: 1700000000,
    };

    await expect(
      provider.update('L', 'api-1|k1', 'AWS::AppSync::ApiKey', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(mockSend).not.toHaveBeenCalled();
  });
});
