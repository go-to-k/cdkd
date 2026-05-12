import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetGraphqlApiCommand,
  GetDataSourceCommand,
  GetIntrospectionSchemaCommand,
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
    const encode = (sdl: string): Uint8Array => new TextEncoder().encode(sdl);

    it('canonicalizes whitespace/comment-only differences to a no-drift result', async () => {
      // State holds the user-authored SDL with comments + extra whitespace.
      const stateSdl = `# This is a comment
type Query {
  # field doc
  hello: String


  world: Int
}
`;
      // AWS returns the canonical (introspection) form: comments stripped,
      // whitespace normalized.
      const awsSdl = `type Query {
  hello: String
  world: Int
}`;

      mockSend.mockResolvedValueOnce({ schema: encode(awsSdl) });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', Definition: stateSdl }
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetIntrospectionSchemaCommand);
      // Critical assertion: returned Definition is byte-equal to state's
      // recorded Definition because the canonical forms match. The
      // comparator will see state === aws and report 0 drifts.
      expect(result).toEqual({
        ApiId: 'api-1',
        Definition: stateSdl,
      });
    });

    it('document graphql-js print field-order behavior (preserves source AST order)', async () => {
      // graphql-js print() preserves the document AST source order;
      // it does NOT reorder fields. So a state with fields in one order
      // and AWS with fields in a different order will surface as drift.
      // This test documents that limitation: the canonical forms differ
      // when field orders differ.
      const stateSdl = `type Query {
  alpha: String
  beta: String
}`;
      const awsSdl = `type Query {
  beta: String
  alpha: String
}`;

      mockSend.mockResolvedValueOnce({ schema: encode(awsSdl) });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', Definition: stateSdl }
      );

      // Canonical forms differ → AWS canonical SDL is returned as-is so
      // the drift surfaces. This is the documented behavior — graphql-js
      // does not normalize field order, so a user who reorders fields
      // in their CDK source will see drift until cdkd state refresh-observed.
      expect(result?.Definition).not.toBe(stateSdl);
      expect(typeof result?.Definition).toBe('string');
      // Returned form is the graphql-js canonical print of awsSdl.
      // print() preserves AWS's order: beta, then alpha.
      expect(result?.Definition).toContain('beta');
      expect(result?.Definition).toContain('alpha');
    });

    it('genuinely-different SDL surfaces as drift (added field)', async () => {
      const stateSdl = `type Query {
  hello: String
}`;
      // AWS-current adds an extra field — semantic drift.
      const awsSdl = `type Query {
  hello: String
  goodbye: String
}`;

      mockSend.mockResolvedValueOnce({ schema: encode(awsSdl) });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', Definition: stateSdl }
      );

      // Canonical forms differ → AWS canonical form is returned. The
      // comparator will surface this as a Definition drift.
      expect(result?.ApiId).toBe('api-1');
      expect(result?.Definition).not.toBe(stateSdl);
      expect(result?.Definition as string).toContain('goodbye');
    });

    it('AWS-side parse failure: falls back to raw AWS string (graceful degrade)', async () => {
      const stateSdl = `type Query { hello: String }`;
      // graphql-js will reject this (unterminated brace).
      const awsSdl = `type Query { hello: String`;

      mockSend.mockResolvedValueOnce({ schema: encode(awsSdl) });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', Definition: stateSdl }
      );

      // Graceful fallback: returns the raw AWS SDL. Comparator may fire
      // whitespace drift, but the command does not crash.
      expect(result?.ApiId).toBe('api-1');
      expect(result?.Definition).toBe(awsSdl);
    });

    it('state-side parse failure: still returns canonical AWS SDL', async () => {
      // State holds invalid SDL (could happen if a prior cdkd version
      // saved input that the current graphql-js rejects).
      const stateSdl = `not valid sdl at all !!!`;
      const awsSdl = `type Query {
  hello: String
}`;

      mockSend.mockResolvedValueOnce({ schema: encode(awsSdl) });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema',
        { ApiId: 'api-1', Definition: stateSdl }
      );

      // Canonical forms differ → AWS canonical form is returned.
      // Drift surfaces; user can resolve via cdkd state refresh-observed.
      expect(result?.ApiId).toBe('api-1');
      expect(result?.Definition).not.toBe(stateSdl);
    });

    it('returns undefined when API is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new AppSyncNotFoundException({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema'
      );
      expect(result).toBeUndefined();
    });

    it('returns canonical SDL when state has no Definition (initial baseline)', async () => {
      const awsSdl = `type Query {
  # comment will be stripped
  hello: String
}`;

      mockSend.mockResolvedValueOnce({ schema: encode(awsSdl) });

      const result = await provider.readCurrentState(
        'api-1',
        'L',
        'AWS::AppSync::GraphQLSchema'
      );

      // No state.Definition to compare against → emit canonical AWS SDL.
      // Comments stripped, whitespace normalized.
      expect(result?.ApiId).toBe('api-1');
      expect(result?.Definition).not.toContain('comment will be stripped');
      expect(result?.Definition).toContain('hello: String');
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('declares DefinitionS3Location for GraphQLSchema (write-only S3 input)', () => {
      expect(provider.getDriftUnknownPaths('AWS::AppSync::GraphQLSchema')).toEqual([
        'DefinitionS3Location',
      ]);
    });

    it('returns empty for other AppSync types', () => {
      expect(provider.getDriftUnknownPaths('AWS::AppSync::GraphQLApi')).toEqual([]);
      expect(provider.getDriftUnknownPaths('AWS::AppSync::DataSource')).toEqual([]);
      expect(provider.getDriftUnknownPaths('AWS::AppSync::Resolver')).toEqual([]);
      expect(provider.getDriftUnknownPaths('AWS::AppSync::ApiKey')).toEqual([]);
    });
  });
});
