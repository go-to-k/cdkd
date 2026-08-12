import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// `vi.hoisted` because both spies are referenced from the `vi.mock` factories
// below, which are hoisted above ordinary top-level declarations.
const { mockSend, warnSpy } = vi.hoisted(() => ({ mockSend: vi.fn(), warnSpy: vi.fn() }));

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

// `AppSyncProvider` reconstructs the child types' `Ref` ARNs through the shared
// STS-backed resolver (issue #1681). Mocked so a unit test never reaches STS —
// without this the suite's result depends on the machine's AWS credentials.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import {
  CreateGraphqlApiCommand,
  DeleteGraphqlApiCommand,
  UpdateGraphqlApiCommand,
  PutGraphqlApiEnvironmentVariablesCommand,
} from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

const TYPE = 'AWS::AppSync::GraphQLApi';

/**
 * Issue #609 backfill: the 13 `AWS::AppSync::GraphQLApi` properties cdkd used
 * to silently drop on write.
 *
 * The failure these tests exist for is NOT a crash — the AWS SDK v3
 * serializer drops members it does not know, so a near-miss spelling
 * (`iatTtl` for `iatTTL`, `openIdConnectConfig` for `openIDConnectConfig`)
 * deploys "successfully" with the config missing. Every assertion below
 * therefore pins the EXACT SDK member name rather than "some auth config was
 * sent".
 */
describe('AppSync GraphQLApi config properties (#609)', () => {
  let provider: AppSyncProvider;

  const createResponse = {
    graphqlApi: {
      apiId: 'api-1',
      arn: 'arn:aws:appsync:us-east-1:1:apis/api-1',
      uris: { GRAPHQL: 'https://x.appsync-api.us-east-1.amazonaws.com/graphql' },
    },
  };

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new AppSyncProvider();
  });

  describe('create', () => {
    it('wires every config block onto CreateGraphqlApi with the exact SDK spellings', async () => {
      mockSend.mockResolvedValueOnce(createResponse);

      await provider.create('L', TYPE, {
        Name: 'MyApi',
        AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
        UserPoolConfig: {
          UserPoolId: 'us-east-1_abc',
          AwsRegion: 'us-east-1',
          DefaultAction: 'ALLOW',
          AppIdClientRegex: '^client',
        },
        OpenIDConnectConfig: {
          Issuer: 'https://issuer.example.com',
          ClientId: 'client-1',
          IatTTL: 60000,
          AuthTTL: 120000,
        },
        LambdaAuthorizerConfig: {
          AuthorizerUri: 'arn:aws:lambda:us-east-1:1:function:auth',
          AuthorizerResultTtlInSeconds: 300,
          IdentityValidationExpression: '^Bearer',
        },
        EnhancedMetricsConfig: {
          ResolverLevelMetricsBehavior: 'PER_RESOLVER_METRICS',
          DataSourceLevelMetricsBehavior: 'PER_DATA_SOURCE_METRICS',
          OperationLevelMetricsConfig: 'ENABLED',
        },
        ApiType: 'GRAPHQL',
        Visibility: 'GLOBAL',
        IntrospectionConfig: 'DISABLED',
        QueryDepthLimit: 5,
        ResolverCountLimit: 100,
        OwnerContact: 'team@example.com',
        MergedApiExecutionRoleArn: 'arn:aws:iam::1:role/Merged',
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(CreateGraphqlApiCommand);
      expect(cmd.input).toMatchObject({
        name: 'MyApi',
        authenticationType: 'AMAZON_COGNITO_USER_POOLS',
        userPoolConfig: {
          userPoolId: 'us-east-1_abc',
          awsRegion: 'us-east-1',
          defaultAction: 'ALLOW',
          appIdClientRegex: '^client',
        },
        // `openIDConnectConfig` / `iatTTL` / `authTTL` are the irregular
        // spellings a mechanical first-letter flip gets wrong
        // (`openIdConnectConfig` / `iatTtl` / `authTtl`) — and the serializer
        // would drop all three silently.
        openIDConnectConfig: {
          issuer: 'https://issuer.example.com',
          clientId: 'client-1',
          iatTTL: 60000,
          authTTL: 120000,
        },
        lambdaAuthorizerConfig: {
          authorizerUri: 'arn:aws:lambda:us-east-1:1:function:auth',
          authorizerResultTtlInSeconds: 300,
          identityValidationExpression: '^Bearer',
        },
        enhancedMetricsConfig: {
          resolverLevelMetricsBehavior: 'PER_RESOLVER_METRICS',
          dataSourceLevelMetricsBehavior: 'PER_DATA_SOURCE_METRICS',
          operationLevelMetricsConfig: 'ENABLED',
        },
        apiType: 'GRAPHQL',
        visibility: 'GLOBAL',
        introspectionConfig: 'DISABLED',
        queryDepthLimit: 5,
        resolverCountLimit: 100,
        ownerContact: 'team@example.com',
        mergedApiExecutionRoleArn: 'arn:aws:iam::1:role/Merged',
      });
      // The exact camelCase keys must be present — `toMatchObject` above would
      // pass on a PascalCase sibling key sitting next to a missing one.
      expect(Object.keys(cmd.input)).toEqual(
        expect.arrayContaining([
          'openIDConnectConfig',
          'userPoolConfig',
          'lambdaAuthorizerConfig',
          'enhancedMetricsConfig',
        ])
      );
    });

    it('maps an additional auth provider to the CognitoUserPoolConfig shape (no defaultAction)', async () => {
      mockSend.mockResolvedValueOnce(createResponse);

      await provider.create('L', TYPE, {
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        AdditionalAuthenticationProviders: [
          {
            AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
            // CFn allows DefaultAction here, AWS's CognitoUserPoolConfig has
            // no such member — forwarding it would be dropped by the
            // serializer anyway, so the mapper must not emit it.
            UserPoolConfig: { UserPoolId: 'us-east-1_abc', AwsRegion: 'us-east-1' },
          },
          {
            AuthenticationType: 'OPENID_CONNECT',
            OpenIDConnectConfig: { Issuer: 'https://issuer.example.com', IatTTL: 30 },
          },
        ],
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd.input.additionalAuthenticationProviders).toEqual([
        {
          authenticationType: 'AMAZON_COGNITO_USER_POOLS',
          userPoolConfig: { userPoolId: 'us-east-1_abc', awsRegion: 'us-east-1' },
        },
        {
          authenticationType: 'OPENID_CONNECT',
          openIDConnectConfig: { issuer: 'https://issuer.example.com', iatTTL: 30 },
        },
      ]);
    });

    it('puts EnvironmentVariables through its own API after the API exists', async () => {
      mockSend.mockResolvedValueOnce(createResponse).mockResolvedValueOnce({});

      await provider.create('L', TYPE, {
        Name: 'MyApi',
        AuthenticationType: 'API_KEY',
        EnvironmentVariables: { STAGE: 'prod', REGION: 'us-east-1' },
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      const put = mockSend.mock.calls[1]?.[0];
      expect(put).toBeInstanceOf(PutGraphqlApiEnvironmentVariablesCommand);
      expect(put.input).toEqual({
        apiId: 'api-1',
        environmentVariables: { STAGE: 'prod', REGION: 'us-east-1' },
      });
    });

    it('issues no environment-variable call when the template declares none', async () => {
      mockSend.mockResolvedValueOnce(createResponse);
      await provider.create('L', TYPE, { Name: 'MyApi', AuthenticationType: 'API_KEY' });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    const base = { Name: 'MyApi', AuthenticationType: 'API_KEY' };

    it('fires UpdateGraphqlApi when only a config block diffs', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'api-1',
        TYPE,
        { ...base, QueryDepthLimit: 10 },
        { ...base, QueryDepthLimit: 5 }
      );

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd).toBeInstanceOf(UpdateGraphqlApiCommand);
      expect(cmd.input).toMatchObject({ apiId: 'api-1', queryDepthLimit: 10 });
    });

    it('resets the removable members to their AWS defaults when dropped from the template', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update('L', 'api-1', TYPE, base, {
        ...base,
        IntrospectionConfig: 'DISABLED',
        QueryDepthLimit: 5,
        ResolverCountLimit: 100,
        OwnerContact: 'team@example.com',
        AdditionalAuthenticationProviders: [{ AuthenticationType: 'AWS_IAM' }],
      });

      const cmd = mockSend.mock.calls[0]?.[0];
      // AppSync treats an OMITTED member as "no change", so a removal that
      // merely leaves the member off the input silently keeps the old value —
      // the #1160 absent-field class. Each of these has a documented reset
      // sentinel and must carry it.
      expect(cmd.input).toMatchObject({
        introspectionConfig: 'ENABLED',
        queryDepthLimit: 0,
        resolverCountLimit: 0,
        ownerContact: '',
        additionalAuthenticationProviders: [],
      });
    });

    it.each([
      ['MergedApiExecutionRoleArn', 'arn:aws:iam::1:role/Merged', 'mergedApiExecutionRoleArn'],
      [
        'UserPoolConfig',
        { UserPoolId: 'us-east-1_abc', AwsRegion: 'us-east-1', DefaultAction: 'ALLOW' },
        'userPoolConfig',
      ],
      ['OpenIDConnectConfig', { Issuer: 'https://i.example.com' }, 'openIDConnectConfig'],
      [
        'LambdaAuthorizerConfig',
        { AuthorizerUri: 'arn:aws:lambda:us-east-1:1:function:a' },
        'lambdaAuthorizerConfig',
      ],
      [
        'EnhancedMetricsConfig',
        { ResolverLevelMetricsBehavior: 'PER_RESOLVER_METRICS' },
        'enhancedMetricsConfig',
      ],
    ])('warns instead of silently no-op-ing when %s is removed (no AWS reset sentinel)', async (
      property,
      value,
      sdkMember
    ) => {
      mockSend.mockResolvedValueOnce({});

      await provider.update('L', 'api-1', TYPE, base, { ...base, [property]: value });

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(`cannot clear ${property}`);
      // ...and the input must not carry a half-built block for it.
      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd?.input?.[sdkMember]).toBeUndefined();
    });

    it('skips UpdateGraphqlApi entirely when no config member diffs', async () => {
      const props = { ...base, QueryDepthLimit: 5, OwnerContact: 'team@example.com' };
      await provider.update('L', 'api-1', TYPE, props, { ...props });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(['ApiType', 'Visibility'])(
      'refuses an in-place %s change (create-only on AWS)',
      async (property) => {
        await expect(
          provider.update(
            'L',
            'api-1',
            TYPE,
            { ...base, [property]: 'B' },
            { ...base, [property]: 'A' }
          )
        ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    // One case per member of MUTABLE_GRAPHQL_API_CONFIG_PROPERTIES. Without
    // this, deleting any single entry from that array is invisible: the
    // integ changes every mutable property at once, so the call still fires.
    it.each([
      ['UserPoolConfig', { UserPoolId: 'p', AwsRegion: 'us-east-1', DefaultAction: 'ALLOW' }, 'userPoolConfig'],
      ['OpenIDConnectConfig', { Issuer: 'https://i.example.com' }, 'openIDConnectConfig'],
      [
        'LambdaAuthorizerConfig',
        { AuthorizerUri: 'arn:aws:lambda:us-east-1:1:function:a' },
        'lambdaAuthorizerConfig',
      ],
      [
        'AdditionalAuthenticationProviders',
        [{ AuthenticationType: 'AWS_IAM' }],
        'additionalAuthenticationProviders',
      ],
      [
        'EnhancedMetricsConfig',
        { ResolverLevelMetricsBehavior: 'PER_RESOLVER_METRICS' },
        'enhancedMetricsConfig',
      ],
      ['IntrospectionConfig', 'DISABLED', 'introspectionConfig'],
      ['QueryDepthLimit', 7, 'queryDepthLimit'],
      ['ResolverCountLimit', 42, 'resolverCountLimit'],
      ['OwnerContact', 'someone@example.com', 'ownerContact'],
      ['MergedApiExecutionRoleArn', 'arn:aws:iam::1:role/M', 'mergedApiExecutionRoleArn'],
    ])('fires UpdateGraphqlApi carrying the SDK member when only %s changes', async (
      property,
      value,
      sdkMember
    ) => {
      mockSend.mockResolvedValueOnce({});

      await provider.update('L', 'api-1', TYPE, { ...base, [property]: value }, { ...base });

      const cmd = mockSend.mock.calls[0]?.[0];
      expect(cmd, `${property} did not fire UpdateGraphqlApi`).toBeInstanceOf(
        UpdateGraphqlApiCommand
      );
      expect(cmd.input[sdkMember], `${property} -> ${sdkMember}`).toBeDefined();
    });

    it('leaves attributes ABSENT so the create-time ApiId / Arn / GraphQLUrl survive', async () => {
      // The deploy engine resolves `result.attributes ?? currentResource
      // .attributes`, so a PRESENT-but-empty object is authoritative and
      // wipes the create-time attributes — every later Fn::GetAtt then
      // degrades to the physical-id fallback. This asserts the shape the
      // REGRESSION would emit (`attributes: {}`), not merely that the update
      // succeeded.
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'L',
        'api-1',
        TYPE,
        { ...base, QueryDepthLimit: 10 },
        { ...base, QueryDepthLimit: 5 }
      );
      expect(result.attributes).toBeUndefined();
      expect(Object.hasOwn(result, 'attributes')).toBe(false);
    });

    it('re-puts the whole environment-variable map on a diff and skips it on a match', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        'api-1',
        TYPE,
        { ...base, EnvironmentVariables: { STAGE: 'prod' } },
        { ...base, EnvironmentVariables: { STAGE: 'dev', OLD: 'x' } }
      );
      const put = mockSend.mock.calls[0]?.[0];
      expect(put).toBeInstanceOf(PutGraphqlApiEnvironmentVariablesCommand);
      // Whole-map replace: the dropped `OLD` key is cleared by omission.
      expect(put.input.environmentVariables).toEqual({ STAGE: 'prod' });

      mockSend.mockReset();
      const same = { ...base, EnvironmentVariables: { STAGE: 'prod' } };
      await provider.update('L', 'api-1', TYPE, same, { ...same });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('clears every environment variable when the property is removed', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update('L', 'api-1', TYPE, base, {
        ...base,
        EnvironmentVariables: { STAGE: 'prod' },
      });
      const put = mockSend.mock.calls[0]?.[0];
      expect(put).toBeInstanceOf(PutGraphqlApiEnvironmentVariablesCommand);
      expect(put.input.environmentVariables).toEqual({});
    });
  });

  describe('malformed shapes', () => {
    // The whole point of this batch is that a value cdkd cannot map must not
    // vanish quietly. A present-but-not-an-object config block used to read as
    // "absent" and deploy green with no auth configured.
    it.each([
      'UserPoolConfig',
      'OpenIDConnectConfig',
      'LambdaAuthorizerConfig',
      'EnhancedMetricsConfig',
      'EnvironmentVariables',
    ])('refuses a present-but-non-object %s on create instead of dropping it', async (property) => {
      mockSend.mockResolvedValue(createResponse);
      await expect(
        provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          [property]: 'oops-unresolved-intrinsic',
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('refuses a non-array AdditionalAuthenticationProviders', async () => {
      mockSend.mockResolvedValue(createResponse);
      await expect(
        provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          AdditionalAuthenticationProviders: { AuthenticationType: 'AWS_IAM' },
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('leaves the live environment variables untouched when the UPDATE desired value is malformed', async () => {
      // The PUT is a whole-map replace, so treating a malformed value as
      // "absent" would WIPE every live variable. The update path warns rather
      // than throwing because the rollback executor replays update() with a
      // cdkd STATE record the user cannot edit from their template.
      await provider.update(
        'L',
        'api-1',
        TYPE,
        { Name: 'MyApi', AuthenticationType: 'API_KEY', EnvironmentVariables: 'oops' },
        { Name: 'MyApi', AuthenticationType: 'API_KEY', EnvironmentVariables: { STAGE: 'prod' } }
      );
      expect(
        mockSend.mock.calls.filter(
          (c) => c[0] instanceof PutGraphqlApiEnvironmentVariablesCommand
        )
      ).toHaveLength(0);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'EnvironmentVariables'
      );
    });

    it('reads a malformed PREVIOUS environment-variable value as absent (state is not template-borne)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.update(
        'L',
        'api-1',
        TYPE,
        { Name: 'MyApi', AuthenticationType: 'API_KEY', EnvironmentVariables: { STAGE: 'prod' } },
        { Name: 'MyApi', AuthenticationType: 'API_KEY', EnvironmentVariables: 'junk-in-state' }
      );
      const put = mockSend.mock.calls[0]?.[0];
      expect(put).toBeInstanceOf(PutGraphqlApiEnvironmentVariablesCommand);
      expect(put.input.environmentVariables).toEqual({ STAGE: 'prod' });
    });

    it('refuses a non-string environment-variable value rather than sending "[object Object]"', async () => {
      mockSend.mockResolvedValue(createResponse);
      await expect(
        provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          EnvironmentVariables: { STAGE: { Ref: 'SomeParam' } },
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('refuses a non-object ELEMENT of AdditionalAuthenticationProviders', async () => {
      // requireConfigArray validates the CONTAINER; a list of strings would
      // index to undefined on every key and send an empty provider object.
      mockSend.mockResolvedValue(createResponse);
      await expect(
        provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          AdditionalAuthenticationProviders: ['AWS_IAM'],
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it.each([
      ['number', 3, '3'],
      ['boolean', true, 'true'],
    ])(
      'coerces a %s environment-variable value the way CloudFormation does',
      async (_label, value, expected) => {
        // CFn coerces scalars into its Map<String,String>, so an unquoted YAML
        // `RETRIES: 3` deploys under CFn and must keep working here.
        mockSend.mockResolvedValueOnce(createResponse).mockResolvedValueOnce({});
        await provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          EnvironmentVariables: { RETRIES: value },
        });
        const put = mockSend.mock.calls[1]?.[0];
        expect(put.input.environmentVariables).toEqual({ RETRIES: expected });
      }
    );

    it.each([
      ['UserPoolConfig', 'oops'],
      ['AdditionalAuthenticationProviders', 'oops'],
      ['EnvironmentVariables', 'oops'],
    ])(
      'downgrades the %s refusal to a warning when create() replays a STATE record',
      async (property, value) => {
        // The rollback executor's reverse-replacement arm revives the OLD
        // resource from previousState.properties, which the user cannot edit —
        // a hard refusal there leaves it unrestorable (.claude/rules/providers.md).
        mockSend.mockResolvedValue(createResponse);

        const result = await provider.create(
          'L',
          TYPE,
          { Name: 'MyApi', AuthenticationType: 'API_KEY', [property]: value },
          { replayingState: true }
        );

        expect(result.physicalId).toBe('api-1');
        expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(property);
      }
    );

    it('still refuses on an ordinary template-path create (the replay downgrade is not blanket)', async () => {
      mockSend.mockResolvedValue(createResponse);
      await expect(
        provider.create(
          'L',
          TYPE,
          { Name: 'MyApi', AuthenticationType: 'API_KEY', UserPoolConfig: 'oops' },
          { replayingState: false }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('deletes the just-created API when the post-create env-var PUT fails', async () => {
      // Without the rollback the API exists but create() throws before
      // returning its physicalId — the deploy engine never learns about it, so
      // it orphans AND collides by name on the next attempt.
      mockSend
        .mockResolvedValueOnce(createResponse)
        .mockRejectedValueOnce(new Error('BadRequestException: invalid key'))
        .mockResolvedValueOnce({});

      await expect(
        provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          EnvironmentVariables: { '9bad': 'x' },
        })
      ).rejects.toBeInstanceOf(ProvisioningError);

      const deleted = mockSend.mock.calls.find((c) => c[0] instanceof DeleteGraphqlApiCommand);
      expect(deleted, 'the partially-created API was not rolled back').toBeDefined();
      expect(deleted![0].input).toEqual({ apiId: 'api-1' });
    });
  });

  describe('failure branches', () => {
    it('surfaces the original error when the post-create rollback ALSO fails', async () => {
      mockSend
        .mockResolvedValueOnce(createResponse)
        .mockRejectedValueOnce(new Error('BadRequestException: invalid key'))
        .mockRejectedValueOnce(new Error('AccessDeniedException on delete'));

      await expect(
        provider.create('L', TYPE, {
          Name: 'MyApi',
          AuthenticationType: 'API_KEY',
          EnvironmentVariables: { '9bad': 'x' },
        })
      ).rejects.toThrow(/invalid key/);
      // The rollback failure is reported, not swallowed AND not masking.
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Failed to roll back partially-created GraphQL API'
      );
    });

    it('wraps an environment-variable PUT failure on the UPDATE path', async () => {
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));
      await expect(
        provider.update(
          'L',
          'api-1',
          TYPE,
          { Name: 'MyApi', AuthenticationType: 'API_KEY', EnvironmentVariables: { A: '1' } },
          { Name: 'MyApi', AuthenticationType: 'API_KEY', EnvironmentVariables: { A: '2' } }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('warns rather than failing the drift read when the env-var read is denied', async () => {
      mockSend
        .mockResolvedValueOnce({
          graphqlApi: { name: 'MyApi', authenticationType: 'API_KEY', xrayEnabled: false },
        })
        .mockRejectedValueOnce(new Error('AccessDeniedException'));

      const state = (await provider.readCurrentState!('api-1', 'L', TYPE)) as Record<
        string,
        unknown
      >;

      expect(state['Name']).toBe('MyApi');
      expect(state).not.toHaveProperty('EnvironmentVariables');
      // WARN, not debug: a silenced failure makes this read asymmetric with the
      // recorded baseline and manufactures a phantom removal.
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'environment variables'
      );
    });
  });

  describe('readCurrentState', () => {
    it('maps the config blocks back to their CFn spellings', async () => {
      mockSend
        .mockResolvedValueOnce({
          graphqlApi: {
            name: 'MyApi',
            authenticationType: 'AMAZON_COGNITO_USER_POOLS',
            xrayEnabled: false,
            userPoolConfig: {
              userPoolId: 'us-east-1_abc',
              awsRegion: 'us-east-1',
              defaultAction: 'ALLOW',
            },
            openIDConnectConfig: { issuer: 'https://issuer.example.com', iatTTL: 60 },
            lambdaAuthorizerConfig: { authorizerUri: 'arn:aws:lambda:us-east-1:1:function:auth' },
            additionalAuthenticationProviders: [
              {
                authenticationType: 'AWS_IAM',
              },
            ],
            enhancedMetricsConfig: { resolverLevelMetricsBehavior: 'FULL_REQUEST_RESOLVER_METRICS' },
            apiType: 'GRAPHQL',
            visibility: 'GLOBAL',
            introspectionConfig: 'ENABLED',
            queryDepthLimit: 5,
            resolverCountLimit: 100,
            ownerContact: 'team@example.com',
          },
        })
        .mockResolvedValueOnce({ environmentVariables: { STAGE: 'prod' } });

      const state = await provider.readCurrentState!('api-1', 'L', TYPE);

      expect(state).toMatchObject({
        UserPoolConfig: {
          UserPoolId: 'us-east-1_abc',
          AwsRegion: 'us-east-1',
          DefaultAction: 'ALLOW',
        },
        OpenIDConnectConfig: { Issuer: 'https://issuer.example.com', IatTTL: 60 },
        LambdaAuthorizerConfig: { AuthorizerUri: 'arn:aws:lambda:us-east-1:1:function:auth' },
        AdditionalAuthenticationProviders: [{ AuthenticationType: 'AWS_IAM' }],
        EnhancedMetricsConfig: { ResolverLevelMetricsBehavior: 'FULL_REQUEST_RESOLVER_METRICS' },
        ApiType: 'GRAPHQL',
        Visibility: 'GLOBAL',
        IntrospectionConfig: 'ENABLED',
        QueryDepthLimit: 5,
        ResolverCountLimit: 100,
        OwnerContact: 'team@example.com',
        EnvironmentVariables: { STAGE: 'prod' },
      });
    });

    it('omits a config block AWS did not return, so an unset property cannot drift', async () => {
      // Realistic shape: GetGraphqlApi ALWAYS returns apiType / visibility /
      // introspectionConfig for an API that never set them (service defaults);
      // only the genuinely-unset blocks are absent from the response.
      mockSend
        .mockResolvedValueOnce({
          graphqlApi: {
            name: 'MyApi',
            authenticationType: 'API_KEY',
            xrayEnabled: false,
            apiType: 'GRAPHQL',
            visibility: 'GLOBAL',
            introspectionConfig: 'ENABLED',
          },
        })
        .mockResolvedValueOnce({});

      const state = (await provider.readCurrentState!('api-1', 'L', TYPE)) as Record<
        string,
        unknown
      >;

      for (const key of [
        'UserPoolConfig',
        'OpenIDConnectConfig',
        'LambdaAuthorizerConfig',
        'AdditionalAuthenticationProviders',
        'EnhancedMetricsConfig',
        'QueryDepthLimit',
        'ResolverCountLimit',
        'OwnerContact',
        'MergedApiExecutionRoleArn',
        'EnvironmentVariables',
      ]) {
        expect(state, `${key} must stay absent`).not.toHaveProperty(key);
      }
      // The service-defaulted ones ARE reported, and that is safe: the drift
      // comparator only descends into keys present in the recorded BASELINE
      // (src/analyzer/drift-calculator.ts iterates Object.keys(stateProperties)),
      // so a template that never set them cannot drift on them — including a
      // state file written by a pre-#609 binary.
      expect(state).toMatchObject({ ApiType: 'GRAPHQL', Visibility: 'GLOBAL' });
    });

    it('records MergedApiExecutionRoleArn and every nested additional-provider block', async () => {
      mockSend
        .mockResolvedValueOnce({
          graphqlApi: {
            name: 'MyApi',
            authenticationType: 'API_KEY',
            xrayEnabled: false,
            mergedApiExecutionRoleArn: 'arn:aws:iam::1:role/Merged',
            additionalAuthenticationProviders: [
              {
                authenticationType: 'OPENID_CONNECT',
                openIDConnectConfig: { issuer: 'https://i.example.com', iatTTL: 30, authTTL: 60 },
              },
              {
                authenticationType: 'AMAZON_COGNITO_USER_POOLS',
                userPoolConfig: { userPoolId: 'us-east-1_abc', awsRegion: 'us-east-1' },
              },
              {
                authenticationType: 'AWS_LAMBDA',
                lambdaAuthorizerConfig: {
                  authorizerUri: 'arn:aws:lambda:us-east-1:1:function:a',
                  authorizerResultTtlInSeconds: 30,
                },
              },
            ],
          },
        })
        .mockResolvedValueOnce({});

      const state = (await provider.readCurrentState!('api-1', 'L', TYPE)) as Record<
        string,
        unknown
      >;

      expect(state['MergedApiExecutionRoleArn']).toBe('arn:aws:iam::1:role/Merged');
      expect(state['AdditionalAuthenticationProviders']).toEqual([
        {
          AuthenticationType: 'OPENID_CONNECT',
          OpenIDConnectConfig: { Issuer: 'https://i.example.com', IatTTL: 30, AuthTTL: 60 },
        },
        {
          AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
          UserPoolConfig: { UserPoolId: 'us-east-1_abc', AwsRegion: 'us-east-1' },
        },
        {
          AuthenticationType: 'AWS_LAMBDA',
          LambdaAuthorizerConfig: {
            AuthorizerUri: 'arn:aws:lambda:us-east-1:1:function:a',
            AuthorizerResultTtlInSeconds: 30,
          },
        },
      ]);
    });
  });

  describe('declarations', () => {
    it('reports no silent-drop property left for the type', () => {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(TYPE);
      expect([...(coverage?.silentDrop.keys() ?? [])]).toEqual([]);
      for (const property of [
        'AdditionalAuthenticationProviders',
        'ApiType',
        'EnhancedMetricsConfig',
        'EnvironmentVariables',
        'IntrospectionConfig',
        'LambdaAuthorizerConfig',
        'MergedApiExecutionRoleArn',
        'OpenIDConnectConfig',
        'OwnerContact',
        'QueryDepthLimit',
        'ResolverCountLimit',
        'UserPoolConfig',
        'Visibility',
      ]) {
        expect(coverage?.handled.has(property), property).toBe(true);
      }
    });

    it('classifies ApiType / Visibility as replacement despite the empty createOnly schema', () => {
      // The registry schema for this type ships `createOnlyProperties: []`, so
      // the `create-only-properties.ts` fallback classifies NOTHING — without
      // a hand-authored rule the change would be routed to an in-place UPDATE
      // that cannot carry either member.
      const registry = new ReplacementRulesRegistry();
      expect(registry.requiresReplacement(TYPE, 'ApiType', 'GRAPHQL', 'MERGED')).toBe(true);
      expect(registry.requiresReplacement(TYPE, 'Visibility', 'GLOBAL', 'PRIVATE')).toBe(true);
      expect(registry.requiresReplacement(TYPE, 'QueryDepthLimit', 5, 10)).toBe(false);
      expect(registry.requiresReplacement(TYPE, 'UserPoolConfig', {}, {})).toBe(false);
      // …and CLASSIFIED, so `create-only-properties.ts` never overrides it.
      expect(registry.isClassified(TYPE, 'ApiType')).toBe(true);
      expect(registry.isClassified(TYPE, 'QueryDepthLimit')).toBe(true);
    });
  });
});
