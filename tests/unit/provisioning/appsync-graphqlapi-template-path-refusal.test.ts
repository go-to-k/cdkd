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
  UpdateGraphqlApiCommand,
  PutGraphqlApiEnvironmentVariablesCommand,
} from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::AppSync::GraphQLApi';
const BASE = { Name: 'MyApi', AuthenticationType: 'API_KEY' };

const warnText = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
const sent = (ctor: new (...args: never[]) => unknown): unknown[] =>
  mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd instanceof ctor);

/**
 * Issue #3740 (the #3728 shape): `updateGraphQLApi` warn-and-drops a malformed
 * nested block on every caller — the five shape-guarded config blocks through
 * `applyGraphQLApiConfig`'s `shapeGuard.onUnusable`, and the
 * `EnvironmentVariables` container, whose arm runs AFTER `UpdateGraphqlApi`. A
 * template-path update now REFUSES a CHANGED malformed block before any call;
 * the rollback revert arms (`replayingState`) and `cdkd drift --revert`
 * (`desiredFromAwsReadback`) keep the warning.
 */
describe('AppSync GraphQLApi malformed nested block on update: template refuses, replay warns', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    mockSend.mockResolvedValue({
      graphqlApi: { apiId: 'api-1', arn: 'arn:aws:appsync:us-east-1:123456789012:apis/api-1' },
    });
    provider = new AppSyncProvider();
  });

  // One row per arm: the key, a malformed desired value, a usable previous
  // value, and the refusal text the create path throws for it.
  const arms: Array<[string, unknown, unknown, RegExp]> = [
    [
      'UserPoolConfig',
      'oops',
      { UserPoolId: 'us-east-1_abc', AwsRegion: 'us-east-1', DefaultAction: 'ALLOW' },
      /AWS::AppSync::GraphQLApi UserPoolConfig must be an object, got string/,
    ],
    [
      'OpenIDConnectConfig',
      ['https://issuer'],
      { Issuer: 'https://issuer' },
      /AWS::AppSync::GraphQLApi OpenIDConnectConfig must be an object, got array/,
    ],
    [
      'LambdaAuthorizerConfig',
      7,
      { AuthorizerUri: 'arn:aws:lambda:us-east-1:123456789012:function:auth' },
      /AWS::AppSync::GraphQLApi LambdaAuthorizerConfig must be an object, got number/,
    ],
    [
      'AdditionalAuthenticationProviders',
      { AuthenticationType: 'AWS_IAM' },
      [{ AuthenticationType: 'AWS_IAM' }],
      /AdditionalAuthenticationProviders must be an array/,
    ],
    [
      'AdditionalAuthenticationProviders',
      ['AWS_IAM'],
      [{ AuthenticationType: 'AWS_IAM' }],
      /AdditionalAuthenticationProviders\[0\] must be an object, got string/,
    ],
    [
      'EnhancedMetricsConfig',
      'oops',
      { ResolverLevelMetricsBehavior: 'FULL_REQUEST_RESOLVER_METRICS' },
      /AWS::AppSync::GraphQLApi EnhancedMetricsConfig must be an object, got string/,
    ],
    [
      'EnvironmentVariables',
      'oops',
      { STAGE: 'prod' },
      /AWS::AppSync::GraphQLApi EnvironmentVariables must be an object, got string/,
    ],
  ];

  const edit = (key: string, desired: unknown, previous: unknown, context?: Record<string, unknown>) =>
    provider.update(
      'L',
      'api-1',
      TYPE,
      // An XrayEnabled flip rides along, so UpdateGraphqlApi WOULD go out.
      { ...BASE, XrayEnabled: true, [key]: desired },
      { ...BASE, XrayEnabled: false, [key]: previous },
      context
    );

  describe.each(arms)('%s = %j', (key, malformed, previous, refusal) => {
    it.each([
      ['no context', undefined],
      ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
    ])('REFUSES on a template-path update (%s), before any AWS call', async (_label, context) => {
      const error = await edit(key, malformed, previous, context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(refusal);
      expect((error as Error).message).toMatch(
        /Nothing was applied to GraphQL API L; fix the template value$/
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback revert arm (replayingState)', { replayingState: true }],
      ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
    ])('keeps the warning on %s, and the rest of the update proceeds', async (_label, context) => {
      await expect(edit(key, malformed, previous, context)).resolves.toBeDefined();

      expect(warnText()).toMatch(refusal);
      expect(sent(UpdateGraphqlApiCommand)).toHaveLength(1);
      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
    });

    it('does NOT refuse the block on the template path when it is UNCHANGED from the record', async () => {
      await expect(edit(key, malformed, malformed)).resolves.toBeDefined();

      // The arm still drops it with a warning; the Xray flip still goes out.
      expect(warnText()).toMatch(refusal);
      expect(sent(UpdateGraphqlApiCommand)).toHaveLength(1);
    });
  });

  it('does not refuse a REMOVED block (the absent desired side is a removal, not a malformed value)', async () => {
    await expect(
      provider.update('L', 'api-1', TYPE, { ...BASE }, { ...BASE, EnvironmentVariables: 'oops' })
    ).resolves.toBeDefined();
  });
});
