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
  GetGraphqlApiEnvironmentVariablesCommand,
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
      'AdditionalAuthenticationProviders',
      [{ AuthenticationType: 'AMAZON_COGNITO_USER_POOLS', UserPoolConfig: 'oops' }],
      [
        {
          AuthenticationType: 'AMAZON_COGNITO_USER_POOLS',
          UserPoolConfig: { UserPoolId: 'us-east-1_abc', AwsRegion: 'us-east-1' },
        },
      ],
      /AdditionalAuthenticationProviders\[0\]\.UserPoolConfig must be an object, got string/,
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

  describe('a malformed nested member drops the WHOLE AdditionalAuthenticationProviders list', () => {
    // `UpdateGraphqlApi` replaces the list, so sending the other entries (or the
    // entry minus its malformed member) would rewrite the live providers the
    // warning promises to leave untouched.
    const list = [
      { AuthenticationType: 'AWS_IAM' },
      { AuthenticationType: 'AMAZON_COGNITO_USER_POOLS', UserPoolConfig: 'oops' },
    ];
    const aapOf = (): unknown =>
      (sent(UpdateGraphqlApiCommand)[0] as UpdateGraphqlApiCommand).input
        .additionalAuthenticationProviders;

    it.each([
      ['a rollback revert arm (replayingState)', { replayingState: true }, [{ AuthenticationType: 'AWS_IAM' }]],
      ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }, [{ AuthenticationType: 'AWS_IAM' }]],
      ['the template path, list UNCHANGED', undefined, list],
    ])('on %s the list is omitted, so AppSync keeps the live one', async (_label, context, previous) => {
      await provider.update(
        'L',
        'api-1',
        TYPE,
        { ...BASE, XrayEnabled: true, AdditionalAuthenticationProviders: list },
        { ...BASE, XrayEnabled: false, AdditionalAuthenticationProviders: previous },
        context
      );

      expect(sent(UpdateGraphqlApiCommand)).toHaveLength(1);
      expect(aapOf()).toBeUndefined();
      expect(warnText()).toMatch(/AdditionalAuthenticationProviders\[1\]\.UserPoolConfig must be an object/);
    });

    it('a usable list is still sent whole', async () => {
      const good = [{ AuthenticationType: 'AWS_IAM' }, { AuthenticationType: 'API_KEY' }];
      await provider.update(
        'L',
        'api-1',
        TYPE,
        { ...BASE, AdditionalAuthenticationProviders: good },
        { ...BASE, AdditionalAuthenticationProviders: [{ AuthenticationType: 'AWS_IAM' }] }
      );
      expect(aapOf()).toEqual([{ authenticationType: 'AWS_IAM' }, { authenticationType: 'API_KEY' }]);
    });
  });

  it('does not refuse a REMOVED block (the absent desired side is a removal, not a malformed value)', async () => {
    await expect(
      provider.update('L', 'api-1', TYPE, { ...BASE }, { ...BASE, EnvironmentVariables: 'oops' })
    ).resolves.toBeDefined();
  });
});

/**
 * Issue #3781: a per-KEY `EnvironmentVariables` value the PUT cannot carry (an
 * object, array or null under CFn's Map<String,String>) used to throw on every
 * caller, from inside `applyEnvironmentVariables` — after `UpdateGraphqlApi` had
 * landed on a template-path update, and unconditionally on the three
 * state-borne paths. Now: the template path refuses before any call; a
 * state-borne UPDATE warns and sends no PUT (it replaces the whole map, so
 * sending the usable keys would delete the skipped one), recording the map AWS
 * still holds; a replay-CREATE warns and puts every usable key.
 */
describe('AppSync GraphQLApi per-key EnvironmentVariables value: template refuses, replay warns', () => {
  let provider: AppSyncProvider;
  // A variable can hold a secret: no message may quote a VALUE.
  const SECRET = 'sup3r-s3cret-plaintext';

  const PREVIOUS = { STAGE: 'prod', TOKEN: SECRET };
  // What `GetGraphqlApiEnvironmentVariables` answers: a map, or a failure.
  let liveEnv: Record<string, string> | undefined | Error;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    liveEnv = { ...PREVIOUS };
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetGraphqlApiEnvironmentVariablesCommand) {
        return liveEnv instanceof Error
          ? Promise.reject(liveEnv)
          : Promise.resolve({ environmentVariables: liveEnv });
      }
      return Promise.resolve({
        graphqlApi: {
          apiId: 'api-1',
          arn: 'arn:aws:appsync:us-east-1:123456789012:apis/api-1',
          uris: { GRAPHQL: 'https://x/graphql' },
        },
      });
    });
    provider = new AppSyncProvider();
  });
  const edit = (desired: unknown, previous: unknown, context?: Record<string, unknown>) =>
    provider.update(
      'L',
      'api-1',
      TYPE,
      // An XrayEnabled flip rides along, so UpdateGraphqlApi WOULD go out
      // before the env-var arm (the "stranded" reach condition in #3781).
      { ...BASE, XrayEnabled: true, EnvironmentVariables: desired },
      { ...BASE, XrayEnabled: false, EnvironmentVariables: previous },
      context
    );

  describe.each([
    ['object', { STAGE: 'prod', TOKEN: { nested: SECRET } }, /EnvironmentVariables\.TOKEN must be a string, got object/],
    ['array', { STAGE: 'prod', TOKEN: [SECRET] }, /EnvironmentVariables\.TOKEN must be a string, got array/],
    ['null', { STAGE: 'prod', TOKEN: null }, /EnvironmentVariables\.TOKEN must be a string, got null/],
  ])('a %s value', (_label, malformed, refusal) => {
    it.each([
      ['no context', undefined],
      ['both flags false', { replayingState: false, desiredFromAwsReadback: false }],
    ])('REFUSES on a template-path update (%s), before any AWS call', async (_l, context) => {
      const error = await edit(malformed, PREVIOUS, context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(refusal);
      expect((error as Error).message).toMatch(
        /Nothing was applied to GraphQL API L; fix the template value$/
      );
      expect((error as Error).message).not.toContain(SECRET);
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback revert arm (replayingState)', { replayingState: true }],
      ['cdkd drift --revert (desiredFromAwsReadback)', { desiredFromAwsReadback: true }],
    ])(
      'on %s: warns, sends NO env-var PUT, and records the map AWS still holds',
      async (_l, context) => {
        const result = await edit(malformed, PREVIOUS, context);

        expect(warnText()).toMatch(refusal);
        expect(warnText()).toMatch(/leaving the live environment variables untouched/);
        expect(warnText()).not.toContain(SECRET);
        expect(sent(UpdateGraphqlApiCommand)).toHaveLength(1);
        expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
        expect(result.effectiveProperties).toEqual({
          ...BASE,
          XrayEnabled: true,
          EnvironmentVariables: PREVIOUS,
        });
      }
    );

    it('does NOT refuse on the template path when the map is UNCHANGED from the record', async () => {
      const result = await edit(malformed, malformed);

      expect(sent(UpdateGraphqlApiCommand)).toHaveLength(1);
      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
      expect(result.effectiveProperties).toBeUndefined();
    });
  });

  it('REFUSES an env-only change too (no UpdateGraphqlApi pending), before any call', async () => {
    const error = await provider
      .update(
        'L',
        'api-1',
        TYPE,
        { ...BASE, EnvironmentVariables: { TOKEN: { nested: SECRET } } },
        { ...BASE, EnvironmentVariables: PREVIOUS }
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/EnvironmentVariables\.TOKEN must be a string, got object\. Nothing was applied/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed map', { TOKEN: { nested: SECRET } }],
    ['a malformed container', 'junk'],
  ])(
    'on a replay whose PREVIOUS map is also unusable (%s) and the live read fails, drops the key',
    async (_l, previous) => {
      liveEnv = new Error('AccessDeniedException');
      const result = await edit({ STAGE: 'prod', TOKEN: { other: 1 } }, previous, {
        replayingState: true,
      });

      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
      expect(result.effectiveProperties).toEqual({ ...BASE, XrayEnabled: true });
      expect(result.effectiveProperties).not.toHaveProperty('EnvironmentVariables');
    }
  );

  describe('the record is the LIVE map, not the previous side', () => {
    const replay = (previous: unknown) =>
      edit({ STAGE: 'prod', TOKEN: { nested: SECRET } }, previous, { replayingState: true });

    it('records the live map when the previous side was never applied (rollback --revert-failed)', async () => {
      // `--revert-failed` passes the FAILED update's attempted bag as previous.
      const result = await replay({ STAGE: 'attempted', NEW: 'never-put' });

      expect(sent(GetGraphqlApiEnvironmentVariablesCommand)).toHaveLength(1);
      expect(result.effectiveProperties).toMatchObject({ EnvironmentVariables: PREVIOUS });
    });

    it('keeps the declared value of a key whose live string it produces', async () => {
      liveEnv = { RETRIES: '3', FLAG: 'true', STAGE: 'live' };
      const result = await replay({ RETRIES: 3, FLAG: true, STAGE: 'prod' });

      expect(result.effectiveProperties).toMatchObject({
        EnvironmentVariables: { RETRIES: 3, FLAG: true, STAGE: 'live' },
      });
    });

    it.each([
      ['an empty map', {}],
      ['an absent member', undefined],
    ])('drops the key when AWS reports %s', async (_l, live) => {
      liveEnv = live;
      const result = await replay(PREVIOUS);

      expect(result.effectiveProperties).not.toHaveProperty('EnvironmentVariables');
    });

    it('records the live map when the recorded previous is ABSENT', async () => {
      const result = await replay(undefined);

      expect(result.effectiveProperties).toMatchObject({ EnvironmentVariables: PREVIOUS });
    });

    it('drops the key when the previous is ABSENT and the live read fails', async () => {
      liveEnv = new Error('AccessDeniedException');
      const result = await replay(undefined);

      expect(result.effectiveProperties).not.toHaveProperty('EnvironmentVariables');
    });

    it('falls back to a usable previous map when the live read fails', async () => {
      liveEnv = new Error('AccessDeniedException');
      const result = await replay({ STAGE: 'recorded' });

      expect(result.effectiveProperties).toMatchObject({
        EnvironmentVariables: { STAGE: 'recorded' },
      });
      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
    });

    it('reads nothing when the map is unchanged', async () => {
      await edit({ STAGE: 'prod', TOKEN: { nested: SECRET } }, { STAGE: 'prod', TOKEN: { nested: SECRET } });
      expect(sent(GetGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
    });
  });

  it('the malformed-CONTAINER replay warning records the retained previous map too', async () => {
    const result = await edit('oops', PREVIOUS, { replayingState: true });

    expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
    expect(result.effectiveProperties).toEqual({
      ...BASE,
      XrayEnabled: true,
      EnvironmentVariables: PREVIOUS,
    });
  });

  it('an UNCHANGED malformed container on the template path records no narrowing', async () => {
    const result = await edit('oops', 'oops');

    expect(warnText()).toMatch(/EnvironmentVariables must be an object/);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('routes the malformed-container replay warning through the caller masker', async () => {
    await edit('oops', PREVIOUS, {
      replayingState: true,
      maskSecrets: (t: string) => t.replaceAll('EnvironmentVariables', '***'),
    });

    expect(warnText()).toMatch(/\*\*\* must be an object/);
    expect(warnText()).not.toContain('EnvironmentVariables');
  });

  it('routes the replay warning through the caller masker', async () => {
    await edit({ STAGE: 'prod', TOKEN: { nested: SECRET } }, PREVIOUS, {
      replayingState: true,
      maskSecrets: (t: string) => t.replaceAll('TOKEN', '***'),
    });

    expect(warnText()).toMatch(/EnvironmentVariables\.\*\*\* must be a string/);
    expect(warnText()).not.toContain('TOKEN');
  });

  it('a usable change still PUTs the whole map and records no narrowing', async () => {
    const result = await edit({ STAGE: 'dev', RETRIES: 3 }, PREVIOUS);

    const put = sent(PutGraphqlApiEnvironmentVariablesCommand) as PutGraphqlApiEnvironmentVariablesCommand[];
    expect(put).toHaveLength(1);
    expect(put[0]!.input.environmentVariables).toEqual({ STAGE: 'dev', RETRIES: '3' });
    expect(result.effectiveProperties).toBeUndefined();
  });

  describe('replay-CREATE (reverse replacement)', () => {
    const create = (env: unknown, context?: Record<string, unknown>) =>
      provider.create('L', TYPE, { ...BASE, EnvironmentVariables: env }, context);

    it('warns per unusable key, PUTs every usable one, and records what it put', async () => {
      const result = await create(
        { STAGE: 'prod', RETRIES: 3, TOKEN: { nested: SECRET }, LIST: [SECRET] },
        { replayingState: true }
      );

      expect(result.physicalId).toBe('api-1');
      const put = sent(PutGraphqlApiEnvironmentVariablesCommand) as PutGraphqlApiEnvironmentVariablesCommand[];
      expect(put).toHaveLength(1);
      expect(put[0]!.input.environmentVariables).toEqual({ STAGE: 'prod', RETRIES: '3' });
      expect(warnText()).toMatch(/EnvironmentVariables\.TOKEN must be a string, got object \(state replay — proceeding without it\)/);
      expect(warnText()).toMatch(/EnvironmentVariables\.LIST must be a string, got array \(state replay — proceeding without it\)/);
      expect(warnText()).not.toContain(SECRET);
      expect(result.effectiveProperties).toEqual({
        ...BASE,
        EnvironmentVariables: { STAGE: 'prod', RETRIES: 3 },
      });
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain(
        'DeleteGraphqlApiCommand'
      );
    });

    it.each([
      ['every key unusable', { TOKEN: { nested: SECRET } }],
      ['a malformed container', 'oops'],
    ])('with %s, sends no PUT and drops the key from the record', async (_l, env) => {
      const result = await create(env, { replayingState: true });

      expect(result.physicalId).toBe('api-1');
      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
      expect(result.effectiveProperties).toEqual({ ...BASE });
      expect(result.effectiveProperties).not.toHaveProperty('EnvironmentVariables');
    });

    it('routes the replay-create warning through the caller masker', async () => {
      await create(
        { STAGE: 'prod', TOKEN: { nested: SECRET } },
        { replayingState: true, maskSecrets: (t: string) => t.replaceAll('TOKEN', '***') }
      );

      expect(warnText()).toMatch(/EnvironmentVariables\.\*\*\* must be a string/);
      expect(warnText()).not.toContain('TOKEN');
    });

    it('a usable replayed map records no narrowing', async () => {
      const result = await create({ STAGE: 'prod' }, { replayingState: true });
      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(1);
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each([
      ['no context', undefined],
      ['replayingState false', { replayingState: false }],
    ])('still REFUSES on a template-path create (%s) and rolls the API back', async (_l, context) => {
      const error = await create({ STAGE: 'prod', TOKEN: { nested: SECRET } }, context).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(/EnvironmentVariables\.TOKEN must be a string, got object/);
      expect((error as Error).message).not.toContain(SECRET);
      expect(sent(PutGraphqlApiEnvironmentVariablesCommand)).toHaveLength(0);
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain(
        'DeleteGraphqlApiCommand'
      );
    });
  });
});
