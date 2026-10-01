/**
 * go-to-k/cdkd#4275, the rows `secret-reference-immutable-sites.test.ts` does
 * not cover: the AppSync, Auto Scaling, ELBv2 LoadBalancer and IAM
 * ManagedPolicy immutable-property guards, driven through each provider's real
 * `update()`.
 *
 * The deploy engine hands `update()` the RESOLVED plaintext as the desired side
 * and the state record (which keeps a secret leaf as its `{{resolve:...}}`
 * reference) as the previous side. Before the fix the refusal sites refused
 * every in-place update of a resource whose identity came from a secret, and
 * the IAM ManagedPolicy site silently REPLACED the policy.
 *
 * Each refusal site is driven the same ways as the sibling file: UNCHANGED (a
 * passing guard surfaces the fake AWS's sentinel from its first post-guard
 * call), RENAMED, PLAIN, and the `***` / no-masker arms.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, debugSpy, warnSpy, mockGetAccountInfo } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
  mockGetAccountInfo: vi.fn(),
}));

function sdkClientMock(clientName: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [clientName]: vi.fn().mockImplementation(() => ({
        send: mockSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-appsync', sdkClientMock('AppSyncClient'));
vi.mock('@aws-sdk/client-auto-scaling', sdkClientMock('AutoScalingClient'));
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', sdkClientMock('ElasticLoadBalancingV2Client'));

// The AppSync child-ARN rebuild after a successful child update.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: mockGetAccountInfo,
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// The masker arm's create-only gate reads the engine's lookup; answered from
// the committed snapshot so no case reaches DescribeType.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: debugSpy, info: vi.fn(), warn: warnSpy, error: vi.fn(), child: vi.fn() };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import type { ResourceProvider, UpdateContext } from '../../../src/types/resource.js';

/** What the secret resolves to this deploy, and what state recorded instead. */
const NAME = 'resolved-secret-name';
const PATH = '/resolved-secret-path/';
const REF = '{{resolve:secretsmanager:name-secret:SecretString:name}}';
const OTHER = 'some-other-name';
const OTHER_PATH = '/some-other-path/';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

/** The deploy's own masker: it knows every value this deploy resolved. */
const context: UpdateContext = {
  maskSecrets: createSecretMasker(bagOf(NAME, OTHER, PATH, OTHER_PATH)),
};

const SENTINEL = 'SENTINEL-first-post-guard-aws-call';

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

const sentCommands = (): string[] => mockSend.mock.calls.map((call) => commandName(call[0]));

/**
 * The fake AWS. `answers` names commands that SUCCEED (the pre-update reads a
 * site needs); every other command rejects with the sentinel.
 */
function fakeAws(answers: Record<string, (input: Record<string, unknown>) => unknown> = {}): void {
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const answer = answers[commandName(command)];
    if (answer) return answer(command.input);
    throw new Error(SENTINEL);
  });
}

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'resolved';
}

interface Site {
  label: string;
  type: string;
  provider: () => ResourceProvider;
  key: string;
  /** The physical id when the resource's identity is `NAME`. */
  physicalId: string;
  desiredRest: Record<string, unknown>;
  previousRest: Record<string, unknown>;
  refusal: string;
  /** Does the physical id (or, for the GraphqlApi, AWS) carry the value? */
  physicalCarriesName: boolean;
  answers?: Record<string, (input: Record<string, unknown>) => unknown>;
}

const LB_ARN = `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/${NAME}/50dc6c495c0c9188`;
const LB_REFUSAL = 'ELBv2 LoadBalancer Name / Type / Scheme are immutable';
/** The live GraphqlApi, answered with `name`. */
const graphqlApiNamed = (name: string) => ({
  GetGraphqlApiCommand: () => ({ graphqlApi: { apiId: 'api-id-1', name } }),
});

const SITES: Site[] = [
  {
    label: 'AutoScaling AutoScalingGroup AutoScalingGroupName',
    type: 'AWS::AutoScaling::AutoScalingGroup',
    provider: () => new ASGProvider(),
    key: 'AutoScalingGroupName',
    physicalId: NAME,
    desiredRest: { MinSize: '0', MaxSize: '2' },
    previousRest: { MinSize: '0', MaxSize: '1' },
    refusal: 'AutoScalingGroupName is immutable',
    physicalCarriesName: true,
  },
  {
    label: 'ELBv2 LoadBalancer Name',
    type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    provider: () => new ELBv2Provider(),
    key: 'Name',
    physicalId: LB_ARN,
    desiredRest: { Type: 'application', SecurityGroups: ['sg-2'] },
    previousRest: { Type: 'application', SecurityGroups: ['sg-1'] },
    refusal: LB_REFUSAL,
    physicalCarriesName: true,
  },
  {
    label: 'ELBv2 LoadBalancer Scheme (masker arm: create-only key)',
    type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    provider: () => new ELBv2Provider(),
    key: 'Scheme',
    physicalId: LB_ARN,
    desiredRest: { Name: NAME, SecurityGroups: ['sg-2'] },
    previousRest: { Name: NAME, SecurityGroups: ['sg-1'] },
    refusal: LB_REFUSAL,
    physicalCarriesName: false,
  },
  {
    label: 'AppSync GraphQLApi Name (the live name decides)',
    type: 'AWS::AppSync::GraphQLApi',
    provider: () => new AppSyncProvider(),
    key: 'Name',
    physicalId: 'api-id-1',
    desiredRest: { AuthenticationType: 'API_KEY', XrayEnabled: true },
    previousRest: { AuthenticationType: 'API_KEY', XrayEnabled: false },
    refusal: 'GraphqlApi.Name is immutable',
    physicalCarriesName: true,
    answers: graphqlApiNamed(NAME),
  },
  {
    label: 'AppSync DataSource Name',
    type: 'AWS::AppSync::DataSource',
    provider: () => new AppSyncProvider(),
    key: 'Name',
    physicalId: `api-id-1|${NAME}`,
    desiredRest: { ApiId: 'api-id-1', Type: 'NONE', Description: 'new' },
    previousRest: { ApiId: 'api-id-1', Type: 'NONE', Description: 'old' },
    refusal: 'DataSource.Name is immutable',
    physicalCarriesName: true,
  },
  {
    label: 'AppSync DataSource ApiId',
    type: 'AWS::AppSync::DataSource',
    provider: () => new AppSyncProvider(),
    key: 'ApiId',
    physicalId: `${NAME}|ds`,
    desiredRest: { Name: 'ds', Type: 'NONE', Description: 'new' },
    previousRest: { Name: 'ds', Type: 'NONE', Description: 'old' },
    refusal: 'DataSource.ApiId is immutable',
    physicalCarriesName: true,
  },
  ...(['ApiId', 'TypeName', 'FieldName'] as const).map(
    (key): Site => ({
      label: `AppSync Resolver ${key}`,
      type: 'AWS::AppSync::Resolver',
      provider: () => new AppSyncProvider(),
      key,
      physicalId: [
        key === 'ApiId' ? NAME : 'api-id-1',
        key === 'TypeName' ? NAME : 'Query',
        key === 'FieldName' ? NAME : 'getItem',
      ].join('|'),
      desiredRest: {
        ApiId: 'api-id-1',
        TypeName: 'Query',
        FieldName: 'getItem',
        RequestMappingTemplate: 'new',
      },
      previousRest: {
        ApiId: 'api-id-1',
        TypeName: 'Query',
        FieldName: 'getItem',
        RequestMappingTemplate: 'old',
      },
      refusal: `Resolver.${key} is immutable`,
      physicalCarriesName: true,
    })
  ),
  {
    label: 'AppSync ApiKey ApiId',
    type: 'AWS::AppSync::ApiKey',
    provider: () => new AppSyncProvider(),
    key: 'ApiId',
    physicalId: `${NAME}|da2-key`,
    desiredRest: { Description: 'new' },
    previousRest: { Description: 'old' },
    refusal: 'ApiKey.ApiId is immutable',
    physicalCarriesName: true,
  },
];

function run(
  site: Site,
  desired: unknown,
  previous: unknown,
  ctx: UpdateContext = context
): Promise<string> {
  return outcome(
    site.provider().update(
      'Resource',
      site.physicalId,
      site.type,
      { ...site.desiredRest, [site.key]: desired },
      { ...site.previousRest, [site.key]: previous },
      ctx
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // A reset, not only a clear: a clear keeps a `mockRejectedValueOnce` queue a
  // case left unconsumed, which would leak into the next case. Only the
  // per-case fakes: a global reset would also wipe the mocked SDK client
  // constructors' implementations.
  mockSend.mockReset();
  mockGetAccountInfo.mockReset();
  fakeAws();
});

describe('a secret-derived immutable identity (go-to-k/cdkd#4275)', () => {
  for (const site of SITES) {
    describe(site.label, () => {
      it('UNCHANGED: a recorded reference resolving to the current value lets the update through', async () => {
        fakeAws(site.answers);
        const result = await run(site, NAME, REF);
        expect(result).not.toContain(site.refusal);
        expect(result).toContain(SENTINEL);
      });

      it('RENAMED: a desired value naming another resource is still refused', async () => {
        fakeAws(site.answers);
        const result = site.physicalCarriesName
          ? await run(site, OTHER, REF)
          : await run(site, 'a-literal-value', REF);
        expect(result).toContain(site.refusal);
        expect(result).not.toContain(SENTINEL);
      });

      it('PLAIN: an ordinary recorded value that differs is still refused, with no lookup', async () => {
        fakeAws(site.answers);
        const result = await run(site, NAME, 'recorded-plain-name');
        expect(result).toContain(site.refusal);
        expect(result).not.toContain(SENTINEL);
        expect(mockSend).not.toHaveBeenCalled();
      });

      if (site.physicalCarriesName) {
        it('a recorded *** is decided by the physical id', async () => {
          fakeAws(site.answers);
          expect(await run(site, NAME, SECRET_MASK)).toContain(SENTINEL);
        });
      } else {
        it('a recorded *** is still refused: a mask says nothing about the value', async () => {
          const result = await run(site, NAME, SECRET_MASK);
          expect(result).toContain(site.refusal);
          expect(result).not.toContain(SENTINEL);
        });

        it('no masker: the desired value cannot be shown secret-derived, so it is refused', async () => {
          // `{}`, not `undefined`: an explicit `undefined` takes the default.
          const result = await run(site, NAME, REF, {});
          expect(result).toContain(site.refusal);
          expect(result).not.toContain(SENTINEL);
        });
      }
    });
  }
});

describe('ELBv2 LoadBalancer: only a create-only key takes the masker arm', () => {
  it('a secret-derived value on a key the engine does not replace on is still refused', async () => {
    const result = await outcome(
      new ELBv2Provider().update(
        'Lb',
        LB_ARN,
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: NAME, NotACreateOnlyKey: NAME, SecurityGroups: ['sg-2'] },
        { Name: NAME, NotACreateOnlyKey: REF, SecurityGroups: ['sg-1'] },
        context
      )
    );
    expect(result).toContain(LB_REFUSAL);
    expect(result).not.toContain(SENTINEL);
  });

  it('Type (masker arm: create-only key): an unchanged secret reference lets the update through', async () => {
    const update = (desired: string, ctx: UpdateContext) =>
      outcome(
        new ELBv2Provider().update(
          'Lb',
          LB_ARN,
          'AWS::ElasticLoadBalancingV2::LoadBalancer',
          { Name: NAME, Type: desired, SecurityGroups: ['sg-2'] },
          { Name: NAME, Type: REF, SecurityGroups: ['sg-1'] },
          ctx
        )
      );
    expect(await update(NAME, context)).toContain(SENTINEL);
    expect(await update('a-literal-type', context)).toContain(LB_REFUSAL);
    expect(await update(NAME, {})).toContain(LB_REFUSAL);
  });
});

describe('AppSync GraphQLApi Name: the lookup', () => {
  const update = (desired: string, previous: string) =>
    new AppSyncProvider().update(
      'Api',
      'api-id-1',
      'AWS::AppSync::GraphQLApi',
      { AuthenticationType: 'API_KEY', XrayEnabled: true, Name: desired },
      { AuthenticationType: 'API_KEY', XrayEnabled: false, Name: previous },
      context
    );

  it('asks AWS by the physical id, and writes the resolved name it confirmed', async () => {
    fakeAws(graphqlApiNamed(NAME));
    expect(await outcome(update(NAME, REF))).toContain(SENTINEL);
    expect(sentCommands()).toEqual(['GetGraphqlApiCommand', 'UpdateGraphqlApiCommand']);
    expect(mockSend.mock.calls[0][0].input).toEqual({ apiId: 'api-id-1' });
    expect(mockSend.mock.calls[1][0].input).toMatchObject({ apiId: 'api-id-1', name: NAME });
  });

  it('a secret rotated under an unchanged reference (live name differs) is refused', async () => {
    fakeAws(graphqlApiNamed(OTHER));
    const result = await outcome(update(NAME, REF));
    expect(result).toContain('GraphqlApi.Name is immutable');
    expect(sentCommands()).toEqual(['GetGraphqlApiCommand']);
  });

  /** The error `update()` threw, or `undefined`. */
  async function thrown(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('an answer with no name is no evidence: refused as a ProvisioningError, not a typed refusal', async () => {
    fakeAws({ GetGraphqlApiCommand: () => ({ graphqlApi: { apiId: 'api-id-1' } }) });
    const error = await thrown(update(NAME, REF));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).toContain('an answer with no name');
    expect(sentCommands()).toEqual(['GetGraphqlApiCommand']);
  });

  it('a NotFound answer says the API is gone rather than asking for a re-run', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('GraphQL API api-id-1 not found.'), { name: 'NotFoundException' })
    );
    const message = (await thrown(update(NAME, REF)) as Error).message;
    expect(message).toContain('no longer exists');
    expect(message).not.toContain('re-run once the lookup can succeed');
  });

  for (const [label, rejection] of [
    ['a non-Error rejection', 'not an error object'],
    ['an Error with an empty name', Object.assign(new Error('x'), { name: '' })],
  ] as const) {
    it(`${label} is refused as an unreadable failure`, async () => {
      mockSend.mockRejectedValueOnce(rejection);
      const error = await thrown(update(NAME, REF));
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toContain('(an unreadable failure)');
      expect((error as Error).message).toContain('re-run once the lookup can succeed');
    });
  }

  it('a failure class carrying the secret is masked in the refusal', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('x'), { name: `Odd${NAME}Fault` }));
    const message = (await thrown(update(NAME, REF)) as Error).message;
    expect(message).toContain('could not be confirmed');
    expect(message).not.toContain(NAME);
  });

  it('a lookup failure is a retryable ProvisioningError naming its class, not a typed refusal', async () => {
    const throttle = Object.assign(new Error(`Rate exceeded for ${NAME}`), {
      name: 'ThrottlingException',
    });
    mockSend.mockRejectedValueOnce(throttle);
    let caught: unknown;
    try {
      await update(NAME, REF);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProvisioningError);
    expect(caught).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
    const error = caught as ProvisioningError;
    expect(error.message).toContain('ThrottlingException');
    expect(error.message).not.toContain(NAME);
    expect(error.cause).toBe(throttle);
    expect(hasRedactedCause(error)).toBe(true);
    expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
    expect(sentCommands()).toEqual(['GetGraphqlApiCommand']);
  });
});

describe('IAM ManagedPolicy: a secret-derived Path / Description no longer REPLACES the policy', () => {
  const POLICY_DOC = { Version: '2012-10-17', Statement: [] };
  const arnWithPath = (path: string) => `arn:aws:iam::123456789012:policy${path}Pol`;

  function update(
    key: 'Path' | 'Description',
    desired: unknown,
    previous: unknown,
    physicalId: string,
    ctx: UpdateContext = context
  ): Promise<string> {
    return outcome(
      new IAMManagedPolicyProvider().update(
        'Policy',
        physicalId,
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: 'Pol', PolicyDocument: { ...POLICY_DOC, v: 2 }, [key]: desired },
        { ManagedPolicyName: 'Pol', PolicyDocument: POLICY_DOC, [key]: previous },
        ctx
      )
    );
  }

  const replaced = (): boolean => sentCommands().includes('CreatePolicyCommand');

  describe('Path (the ARN carries it)', () => {
    it('UNCHANGED: updated in place, never replaced', async () => {
      expect(await update('Path', PATH, REF, arnWithPath(PATH))).toContain(SENTINEL);
      expect(sentCommands().length).toBeGreaterThan(0);
      expect(replaced()).toBe(false);
    });

    it('UNCHANGED under a multi-segment path', async () => {
      expect(await update('Path', '/a/b/', REF, arnWithPath('/a/b/'))).toContain(SENTINEL);
      expect(replaced()).toBe(false);
    });

    it('UNCHANGED at the root path', async () => {
      expect(await update('Path', '/', REF, arnWithPath('/'))).toContain(SENTINEL);
      expect(replaced()).toBe(false);
    });

    it('RENAMED: a resolved path the ARN does not carry still replaces', async () => {
      await update('Path', OTHER_PATH, REF, arnWithPath(PATH));
      expect(replaced()).toBe(true);
    });

    it('PLAIN: an ordinary recorded path that differs still replaces', async () => {
      await update('Path', PATH, '/recorded-plain/', arnWithPath(PATH));
      expect(replaced()).toBe(true);
    });

    it('a recorded *** is decided by the ARN', async () => {
      await update('Path', PATH, SECRET_MASK, arnWithPath(PATH));
      expect(replaced()).toBe(false);
    });
  });

  describe('Description (the masker arm: create-only key)', () => {
    it('UNCHANGED: updated in place, never replaced', async () => {
      expect(await update('Description', NAME, REF, arnWithPath('/'))).toContain(SENTINEL);
      expect(sentCommands().length).toBeGreaterThan(0);
      expect(replaced()).toBe(false);
    });

    it('RENAMED: a literal the masker never resolved still replaces', async () => {
      await update('Description', 'a-literal-description', REF, arnWithPath('/'));
      expect(replaced()).toBe(true);
    });

    it('PLAIN: an ordinary recorded description that differs still replaces', async () => {
      await update('Description', NAME, 'recorded plain', arnWithPath('/'));
      expect(replaced()).toBe(true);
    });

    it('a recorded *** still replaces: a mask says nothing about the value', async () => {
      await update('Description', NAME, SECRET_MASK, arnWithPath('/'));
      expect(replaced()).toBe(true);
    });

    it('no masker: still replaces', async () => {
      await update('Description', NAME, REF, arnWithPath('/'), {});
      expect(replaced()).toBe(true);
    });
  });
});

describe('AutoScalingGroup: the updating line masks a secret-derived group name', () => {
  it('names the group masked', async () => {
    await run(SITES[0]!, NAME, REF);
    const lines = debugSpy.mock.calls.map((call) => String(call[0]));
    const updating = lines.find((line) => line.startsWith('Updating AutoScalingGroup'));
    expect(updating).toBeDefined();
    expect(updating).not.toContain(NAME);
  });
});

describe('AppSync child updates: the ARN-rebuild warning masks the composite physical id', () => {
  for (const [type, physicalId, key, rest, updateCommand] of [
    [
      'AWS::AppSync::DataSource',
      `api-id-1|${NAME}`,
      'Name',
      { ApiId: 'api-id-1', Type: 'NONE' },
      'UpdateDataSourceCommand',
    ],
    [
      'AWS::AppSync::Resolver',
      `${NAME}|Query|getItem`,
      'ApiId',
      { TypeName: 'Query', FieldName: 'getItem' },
      'UpdateResolverCommand',
    ],
    ['AWS::AppSync::ApiKey', `${NAME}|da2-key`, 'ApiId', {}, 'UpdateApiKeyCommand'],
  ] as const) {
    it(`${type}: names the resource masked when the rebuild fails`, async () => {
      fakeAws({ [updateCommand]: () => ({}) });
      mockGetAccountInfo.mockRejectedValue(new Error('sts unavailable'));
      const result = await outcome(
        new AppSyncProvider().update(
          'Child',
          physicalId,
          type,
          { ...rest, [key]: NAME, Description: 'new', RequestMappingTemplate: 'new' },
          { ...rest, [key]: REF, Description: 'old', RequestMappingTemplate: 'old' },
          context
        )
      );
      expect(result).toBe('resolved');
      const lines = warnSpy.mock.calls.map((call) => String(call[0]));
      const rebuild = lines.find((line) => line.includes('could not rebuild its ARN attribute'));
      expect(rebuild).toBeDefined();
      expect(rebuild).not.toContain(NAME);
    });
  }
});

describe('AppSync child updates with no mutable change: the ARN-rebuild warning is masked too', () => {
  for (const [type, physicalId, key, rest, updateCommand] of [
    [
      'AWS::AppSync::DataSource',
      `api-id-1|${NAME}`,
      'Name',
      { ApiId: 'api-id-1', Type: 'NONE', Description: 'same' },
      'UpdateDataSourceCommand',
    ],
    [
      'AWS::AppSync::Resolver',
      `${NAME}|Query|getItem`,
      'ApiId',
      { TypeName: 'Query', FieldName: 'getItem', RequestMappingTemplate: 'same' },
      'UpdateResolverCommand',
    ],
    ['AWS::AppSync::ApiKey', `${NAME}|da2-key`, 'ApiId', { Description: 'same' }, 'UpdateApiKeyCommand'],
  ] as const) {
    it(`${type}: no update call, and the resource named masked`, async () => {
      fakeAws();
      mockGetAccountInfo.mockRejectedValue(new Error('sts unavailable'));
      const result = await outcome(
        new AppSyncProvider().update(
          'Child',
          physicalId,
          type,
          { ...rest, [key]: NAME },
          { ...rest, [key]: REF },
          context
        )
      );
      expect(result).toBe('resolved');
      expect(sentCommands()).not.toContain(updateCommand);
      const lines = warnSpy.mock.calls.map((call) => String(call[0]));
      const rebuild = lines.find((line) => line.includes('could not rebuild its ARN attribute'));
      expect(rebuild).toBeDefined();
      expect(rebuild).not.toContain(NAME);
    });
  }

  for (const [label, type, physicalId, key, rest, answers] of [
    [
      'GraphqlApi',
      'AWS::AppSync::GraphQLApi',
      'api-id-1',
      'Name',
      { AuthenticationType: 'API_KEY', XrayEnabled: true },
      graphqlApiNamed(NAME),
    ],
    [
      'DataSource',
      'AWS::AppSync::DataSource',
      `api-id-1|${NAME}`,
      'Name',
      { ApiId: 'api-id-1', Type: 'NONE', Description: 'new' },
      {},
    ],
    [
      'Resolver',
      'AWS::AppSync::Resolver',
      `${NAME}|Query|getItem`,
      'ApiId',
      { TypeName: 'Query', FieldName: 'getItem', RequestMappingTemplate: 'new' },
      {},
    ],
    ['ApiKey', 'AWS::AppSync::ApiKey', `${NAME}|da2-key`, 'ApiId', { Description: 'new' }, {}],
  ] as const) {
    it(`${label}: an AWS failure quoting the name is masked, and stamped for the retry classifiers`, async () => {
      const awsFailure = new Error(`Resource ${NAME} rejected the update`);
      mockSend.mockImplementation(async (command: unknown) => {
        const answer = (answers as Record<string, () => unknown>)[commandName(command)];
        if (answer) return answer();
        throw awsFailure;
      });
      const previousRest =
        label === 'GraphqlApi'
          ? { ...rest, XrayEnabled: false }
          : label === 'Resolver'
            ? { ...rest, RequestMappingTemplate: 'old' }
            : { ...rest, Description: 'old' };
      let caught: unknown;
      try {
        await new AppSyncProvider().update(
          'Child',
          physicalId,
          type,
          { ...rest, [key]: NAME },
          { ...previousRest, [key]: REF },
          context
        );
      } catch (error) {
        caught = error;
      }
      const error = caught as ProvisioningError;
      expect(error.message).toContain(`Failed to update AppSync ${label}`);
      expect(error.message).not.toContain(NAME);
      expect(error.cause).toBe(awsFailure);
      expect(hasRedactedCause(error)).toBe(true);
    });
  }

  it('an AWS failure with nothing to mask is not stamped', async () => {
    mockSend.mockRejectedValue(new Error('ConcurrentModificationException: busy'));
    let caught: unknown;
    try {
      await new AppSyncProvider().update(
        'Ds',
        `api-id-1|${NAME}`,
        'AWS::AppSync::DataSource',
        { ApiId: 'api-id-1', Type: 'NONE', Name: NAME, Description: 'new' },
        { ApiId: 'api-id-1', Type: 'NONE', Name: REF, Description: 'old' },
        context
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('Failed to update AppSync DataSource');
    expect(hasRedactedCause(caught)).toBe(false);
  });
});

describe('AppSync composite ids that carry no witness', () => {
  it('DataSource with no `|` in its id: the masker arm (Name is create-only) decides', async () => {
    const run = (ctx: UpdateContext) =>
      outcome(
        new AppSyncProvider().update(
          'Ds',
          'no-separator',
          'AWS::AppSync::DataSource',
          { ApiId: 'api-id-1', Type: 'NONE', Name: NAME, Description: 'new' },
          { ApiId: 'api-id-1', Type: 'NONE', Name: REF, Description: 'old' },
          ctx
        )
      );
    // Past the guard, the composite-id check refuses the malformed id.
    const passed = await run(context);
    expect(passed).not.toContain('DataSource.Name is immutable');
    expect(passed).toContain('no-separator');
    expect(mockSend).not.toHaveBeenCalled();
    expect(await run({})).toContain('DataSource.Name is immutable');
  });

  it('Resolver with a two-part id: no witness, so a resolved ApiId is still refused', async () => {
    const result = await outcome(
      new AppSyncProvider().update(
        'Resolver',
        `${NAME}|Query`,
        'AWS::AppSync::Resolver',
        { ApiId: NAME, TypeName: 'Query', FieldName: 'getItem', RequestMappingTemplate: 'new' },
        { ApiId: REF, TypeName: 'Query', FieldName: 'getItem', RequestMappingTemplate: 'old' },
        context
      )
    );
    expect(result).toContain('Resolver.ApiId is immutable');
  });
});

describe('ELBv2 LoadBalancer: what the ARN parse accepts', () => {
  const update = (physicalId: string, desired: string, previous: string) =>
    outcome(
      new ELBv2Provider().update(
        'Lb',
        physicalId,
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: desired, SecurityGroups: ['sg-2'] },
        { Name: previous, SecurityGroups: ['sg-1'] },
        context
      )
    );

  it('a non-ARN physical id is not taken as the name', async () => {
    expect(await update('not-an-arn', 'not-an-arn', REF)).toContain(LB_REFUSAL);
  });

  it('an ARN missing its id segment gives no witness', async () => {
    const twoSegments = `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/${NAME}`;
    expect(await update(twoSegments, NAME, SECRET_MASK)).toContain(LB_REFUSAL);
  });

  it('a Listener tag line masks its ARN, which carries the load balancer name', async () => {
    const listenerArn = `arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/${NAME}/50dc6c495c0c9188/f2f7dc8efc522ab2`;
    fakeAws({
      AddTagsCommand: () => ({}),
      RemoveTagsCommand: () => ({}),
      ModifyListenerCommand: () => ({ Listeners: [{ ListenerArn: listenerArn }] }),
      ModifyListenerAttributesCommand: () => ({}),
    });
    await outcome(
      new ELBv2Provider().update(
        'Listener',
        listenerArn,
        'AWS::ElasticLoadBalancingV2::Listener',
        { Tags: [{ Key: 'k', Value: '2' }] },
        { Tags: [{ Key: 'k', Value: '1' }] },
        context
      )
    );
    const lines = debugSpy.mock.calls.map((call) => String(call[0]));
    const tagLines = lines.filter((line) => line.includes('tag(s)'));
    expect(tagLines).toHaveLength(1);
    expect(tagLines[0]).not.toContain(NAME);
  });

  it('a TargetGroup tag line masks its ARN', async () => {
    const tgArn = `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${NAME}/73e2d6bc24d8a067`;
    fakeAws({
      AddTagsCommand: () => ({}),
      RemoveTagsCommand: () => ({}),
      DescribeTargetGroupsCommand: () => ({ TargetGroups: [{ TargetGroupArn: tgArn }] }),
      ModifyTargetGroupCommand: () => ({}),
      DescribeTargetGroupAttributesCommand: () => ({ Attributes: [] }),
      DescribeTargetHealthCommand: () => ({ TargetHealthDescriptions: [] }),
    });
    await outcome(
      new ELBv2Provider().update(
        'Tg',
        tgArn,
        'AWS::ElasticLoadBalancingV2::TargetGroup',
        { Tags: [{ Key: 'k', Value: '2' }] },
        { Tags: [{ Key: 'k', Value: '1' }] },
        context
      )
    );
    const lines = debugSpy.mock.calls.map((call) => String(call[0]));
    const tagLines = lines.filter((line) => line.includes('tag(s)'));
    expect(tagLines).toHaveLength(1);
    expect(tagLines[0]).not.toContain(NAME);
  });

  it('the tag lines mask the ARN, which carries a secret-derived name', async () => {
    fakeAws({ AddTagsCommand: () => ({}), RemoveTagsCommand: () => ({}) });
    const result = await outcome(
      new ELBv2Provider().update(
        'Lb',
        LB_ARN,
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        { Name: NAME, Tags: [{ Key: 'k', Value: '2' }, { Key: 'n', Value: 'v' }] },
        { Name: REF, Tags: [{ Key: 'k', Value: '1' }, { Key: 'o', Value: 'v' }] },
        context
      )
    );
    expect(result).toBe('resolved');
    const lines = debugSpy.mock.calls.map((call) => String(call[0]));
    const tagLines = lines.filter((line) => line.includes('tag(s)'));
    expect(tagLines).toHaveLength(2);
    for (const line of tagLines) expect(line).not.toContain(NAME);
  });
});

describe('IAM ManagedPolicy: a drift revert with a secret-derived Path', () => {
  const PATH_ARN = `arn:aws:iam::123456789012:policy${PATH}Pol`;
  const revert: UpdateContext = { ...context, desiredFromAwsReadback: true };
  const update = (props: Record<string, unknown>, prev: Record<string, unknown>) =>
    outcome(
      new IAMManagedPolicyProvider().update(
        'Policy',
        PATH_ARN,
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: 'Pol', PolicyDocument: { v: 2 }, ...props },
        { ManagedPolicyName: 'Pol', PolicyDocument: { v: 1 }, ...prev },
        revert
      )
    );

  it('the live path the readback brings is no change: the revert goes ahead in place', async () => {
    const result = await update({ Path: PATH }, { Path: REF });
    expect(result).not.toContain('cannot be reverted');
    expect(result).toContain(SENTINEL);
  });

  it('a refusal names the key that really changed', async () => {
    const result = await update(
      { Path: PATH, Description: 'live' },
      { Path: REF, Description: 'recorded' }
    );
    expect(result).toContain('Description cannot be reverted');
  });
});

describe('AutoScalingGroup: an AWS failure quoting the group name', () => {
  it('is masked, and stamped for the retry classifiers', async () => {
    const awsFailure = new Error(`AutoScalingGroup ${NAME} is busy`);
    mockSend.mockRejectedValue(awsFailure);
    let caught: unknown;
    try {
      await new ASGProvider().update(
        'Asg',
        NAME,
        'AWS::AutoScaling::AutoScalingGroup',
        { AutoScalingGroupName: NAME, MinSize: '0', MaxSize: '2' },
        { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '1' },
        context
      );
    } catch (error) {
      caught = error;
    }
    const error = caught as ProvisioningError;
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message).toContain('Failed to update AutoScalingGroup Asg');
    expect(error.message).not.toContain(NAME);
    expect(error.cause).toBe(awsFailure);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('an AWS failure with nothing to mask is not stamped', async () => {
    const awsFailure = new Error('ScalingActivityInProgress: busy');
    mockSend.mockRejectedValue(awsFailure);
    let caught: unknown;
    try {
      await new ASGProvider().update(
        'Asg',
        NAME,
        'AWS::AutoScaling::AutoScalingGroup',
        { AutoScalingGroupName: NAME, MinSize: '0', MaxSize: '2' },
        { AutoScalingGroupName: REF, MinSize: '0', MaxSize: '1' },
        context
      );
    } catch (error) {
      caught = error;
    }
    const error = caught as ProvisioningError;
    expect(error.message).toContain('Failed to update AutoScalingGroup Asg');
    expect(error.cause).toBe(awsFailure);
    expect(hasRedactedCause(error)).toBe(false);
  });
});
