import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319, the `tail-g` provider slice: a provider's create / update
 * / delete wrap is persisted to `deployments/{runId}.jsonl`, so an AWS-authored
 * failure is named by its class plus the --verbose pointer; AWS's text (the
 * caller's role ARN and account id) goes to the masked debug line and stays on
 * `cause` for the retry classifiers. A delete wrap naming a foreign `NotFound`
 * class is stamped `markNotGone`; an "already exists" is restated, except from
 * a post-create step. Partial-create cleanup warns name the class at warn and
 * AWS's text at debug.
 */

const { mockSend, debug, warn, error, info, waitStable, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    waitStable: vi.fn(),
    fakeClient: () => ({
      send: (command: unknown) => send(command) as unknown,
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-ecs')>()),
  ECSClient: vi.fn().mockImplementation(() => fakeClient()),
  waitUntilServicesStable: waitStable,
}));
for (const [mod, client] of [
  ['@aws-sdk/client-api-gateway', 'APIGatewayClient'],
  ['@aws-sdk/client-apigatewayv2', 'ApiGatewayV2Client'],
  ['@aws-sdk/client-eventbridge', 'EventBridgeClient'],
  ['@aws-sdk/client-dlm', 'DLMClient'],
  ['@aws-sdk/client-codecommit', 'CodeCommitClient'],
  ['@aws-sdk/client-sts', 'STSClient'],
] as const) {
  vi.doMock(mod, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    [client]: vi.fn().mockImplementation(() => fakeClient()),
  }));
}

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => new Proxy({}, { get: () => fakeClient() }),
}));
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccountInfo: () =>
    Promise.resolve({ accountId: '000000000000', region: 'us-east-1', partition: 'aws' }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { debug, info, warn, error, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

const { ApiGatewayProvider } = await import(
  '../../../src/provisioning/providers/apigateway-provider.js'
);
const { ApiGatewayV2Provider } = await import(
  '../../../src/provisioning/providers/apigatewayv2-provider.js'
);
const { ECSProvider } = await import('../../../src/provisioning/providers/ecs-provider.js');
const { SecretsManagerSecretProvider } = await import(
  '../../../src/provisioning/providers/secretsmanager-secret-provider.js'
);
const { LogsLogGroupProvider } = await import(
  '../../../src/provisioning/providers/logs-loggroup-provider.js'
);
const { IAMRoleProvider } = await import('../../../src/provisioning/providers/iam-role-provider.js');
const { IAMManagedPolicyProvider } = await import(
  '../../../src/provisioning/providers/iam-managed-policy-provider.js'
);
const { IAMInstanceProfileProvider } = await import(
  '../../../src/provisioning/providers/iam-instance-profile-provider.js'
);
const { IAMAccessKeyProvider } = await import(
  '../../../src/provisioning/providers/iam-access-key-provider.js'
);
const { EventBridgeBusProvider } = await import(
  '../../../src/provisioning/providers/eventbridge-bus-provider.js'
);
const { DLMLifecyclePolicyProvider } = await import(
  '../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js'
);
const { CodeCommitRepositoryProvider } = await import(
  '../../../src/provisioning/providers/codecommit-repository-provider.js'
);
const { ACMCertificateProvider } = await import(
  '../../../src/provisioning/providers/acm-certificate-provider.js'
);
const {
  createEbsFinalSnapshot,
  createRedshiftFinalSnapshot,
  createReplicationGroupFinalSnapshot,
  finalSnapshotDelays,
} = await import('../../../src/provisioning/final-snapshot.js');
const { hasRedactedCause, isNameCollisionErrorFrom, retryClassificationText } = await import(
  '../../../src/deployment/retryable-errors.js'
);
const { VERBOSE_POINTER } = await import('../../../src/utils/aws-failure-text.js');
const { isMarkedNotGone } = await import('../../../src/provisioning/not-gone.js');
const { allowUnscopedCreateTokensForTests, resetIdempotencyTokensForTests } = await import(
  '../../../src/provisioning/providers/idempotency-token.js'
);

beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y`;
const MASKED_DENIED = 'assumed-role/deployer/***';
/** An AWS-authored failure (smithy `$fault` + a deserialized status). */
const awsErr = (name: string, message: string): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const denied = (): Error => awsErr('AccessDenied', DENIED);
/** An AWS-authored failure whose CLASS spells the secret: only `mask(summary)` removes it. */
const secretClass = (): Error => awsErr('Denieds3cr3tException', 'denied');
/** Another object's not-found, past the delete's own typed not-found. */
const foreignNotFound = (): Error => awsErr('KMSNotFoundException', `Key in ${ACCOUNT} not found`);
const collision = (): Error => awsErr('ConflictException', 'Resource x already exists.');
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const ctx = { maskSecrets: mask };
const lines = (spy: typeof debug): string[] => spy.mock.calls.map((c) => String(c[0]));
const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;
const SECRET_CLASS_SHOWN = 'Denied***Exception';
const RESTATED = 'AWS reports that it already exists.';

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

/** Fail each named command with a fresh error; answer the rest from `answers`, else `{}`. */
function failOn(failing: Record<string, () => Error>, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    const make = failing[name];
    if (make) throw make();
    return answers[name] ?? {};
  });
}

/** The positive control: the fake error carried the identity the wrap must withhold. */
function expectCarriesIdentity(make: () => Error): void {
  expect(make().message).toContain(ACCOUNT);
  expect(make().message).toContain('s3cr3t');
}

beforeEach(() => {
  mockSend.mockReset();
  debug.mockReset();
  warn.mockReset();
  error.mockReset();
  info.mockReset();
  waitStable.mockReset();
  resetIdempotencyTokensForTests();
  vi.spyOn(finalSnapshotDelays, 'sleep').mockResolvedValue(undefined);
  delete process.env['CDKD_FULL_WAIT'];
});

// ─── Delete wraps ─────────────────────────────────────────────────────

interface DeleteCase {
  site: string;
  prefix: string;
  command: string;
  answers?: Record<string, unknown>;
  run: () => Promise<unknown>;
}

const DELETES: DeleteCase[] = [
  ...(
    [
      ['Authorizer', 'DeleteAuthorizerCommand', 'auth-1', { RestApiId: 'api-1' }],
      ['Resource', 'DeleteResourceCommand', 'res-1', { RestApiId: 'api-1' }],
      ['Deployment', 'DeleteDeploymentCommand', 'dep-1', { RestApiId: 'api-1' }],
      ['Stage', 'DeleteStageCommand', 'prod', { RestApiId: 'api-1' }],
      ['Method', 'DeleteMethodCommand', 'api-1|res-1|GET', {}],
    ] as const
  ).map(([kind, command, physicalId, props]) => ({
    site: `API Gateway ${kind}`,
    prefix: `Failed to delete API Gateway ${kind} Res: `,
    command,
    run: () =>
      new ApiGatewayProvider().delete('Res', physicalId, `AWS::ApiGateway::${kind}`, props, ctx),
  })),
  ...(
    [
      ['Api', 'DeleteApiCommand'],
      ['Stage', 'DeleteStageCommand'],
      ['Integration', 'DeleteIntegrationCommand'],
      ['Route', 'DeleteRouteCommand'],
      ['Authorizer', 'DeleteAuthorizerCommand'],
    ] as const
  ).map(([kind, command]) => ({
    site: `API Gateway V2 ${kind}`,
    prefix: `Failed to delete API Gateway V2 ${kind} Res: `,
    command,
    run: () =>
      new ApiGatewayV2Provider().delete(
        'Res',
        'id-1',
        `AWS::ApiGatewayV2::${kind}`,
        { ApiId: 'api-1' },
        ctx
      ),
  })),
  {
    site: 'Secrets Manager secret',
    prefix: 'Failed to delete secret Res: ',
    command: 'DeleteSecretCommand',
    run: () =>
      new SecretsManagerSecretProvider().delete(
        'Res',
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:s-AbCdEf',
        'AWS::SecretsManager::Secret',
        undefined,
        ctx
      ),
  },
  {
    site: 'log group',
    prefix: 'Failed to delete log group Res: ',
    command: 'DeleteLogGroupCommand',
    run: () => new LogsLogGroupProvider().delete('Res', '/lg', 'AWS::Logs::LogGroup', {}, ctx),
  },
  {
    site: 'IAM role',
    prefix: 'Failed to delete IAM role Res: ',
    command: 'DeleteRoleCommand',
    answers: { GetRoleCommand: { Role: { RoleName: 'role-1', RoleId: 'AROA1' } } },
    run: () => new IAMRoleProvider().delete('Res', 'role-1', 'AWS::IAM::Role', undefined, ctx),
  },
  {
    site: 'IAM managed policy',
    prefix: 'Failed to delete IAM managed policy Res: ',
    command: 'DeletePolicyCommand',
    answers: { GetPolicyCommand: { Policy: { PolicyName: 'p' } } },
    run: () =>
      new IAMManagedPolicyProvider().delete(
        'Res',
        'arn:aws:iam::000000000000:policy/p',
        'AWS::IAM::ManagedPolicy',
        undefined,
        ctx
      ),
  },
  {
    site: 'IAM instance profile',
    prefix: 'Failed to delete IAM instance profile Res: ',
    command: 'DeleteInstanceProfileCommand',
    answers: { GetInstanceProfileCommand: { InstanceProfile: { Roles: [] } } },
    run: () =>
      new IAMInstanceProfileProvider().delete(
        'Res',
        'ip-1',
        'AWS::IAM::InstanceProfile',
        undefined,
        ctx
      ),
  },
  {
    site: 'IAM access key',
    prefix: 'Failed to delete IAM access key Res: ',
    command: 'DeleteAccessKeyCommand',
    run: () =>
      new IAMAccessKeyProvider().delete('Res', 'AKIA1', 'AWS::IAM::AccessKey', { UserName: 'u' }, ctx),
  },
  {
    site: 'EventBridge bus',
    prefix: 'Failed to delete EventBus Res: ',
    command: 'DeleteEventBusCommand',
    run: () =>
      new EventBridgeBusProvider().delete('Res', 'bus-1', 'AWS::Events::EventBus', undefined, ctx),
  },
  {
    site: 'DLM lifecycle policy',
    prefix: 'Failed to delete DLM Lifecycle Policy Res: ',
    command: 'DeleteLifecyclePolicyCommand',
    run: () =>
      new DLMLifecyclePolicyProvider().delete(
        'Res',
        'policy-1',
        'AWS::DLM::LifecyclePolicy',
        undefined,
        ctx
      ),
  },
  {
    site: 'ACM certificate',
    prefix: 'Failed to delete ACM certificate Res: ',
    command: 'DeleteCertificateCommand',
    run: () =>
      new ACMCertificateProvider().delete(
        'Res',
        'arn:aws:acm:us-east-1:000000000000:certificate/c',
        'AWS::CertificateManager::Certificate',
        undefined,
        ctx
      ),
  },
];

describe.each(DELETES)('the $site delete wrap', ({ prefix, command, answers, run }) => {
  it('names an AWS failure by its class, keeps the cause, stamps it, masks the debug line', async () => {
    expectCarriesIdentity(denied);
    failOn({ [command]: denied }, answers);
    const failure = await caught(run());
    expect(failure.message).toContain(`${prefix}AccessDenied. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(failure.message).not.toContain('not authorized');
    expect(String(failure.cause instanceof Error ? failure.cause.message : '')).toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryClassificationText(failure)).toContain('not authorized');
    expect(isMarkedNotGone(failure)).toBe(false);
    expect(lines(debug).some((l) => l.includes(prefix) && l.includes(MASKED_DENIED))).toBe(true);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  it('masks a secret spelled in the class (SECRET-IN-CLASS)', async () => {
    failOn({ [command]: secretClass }, answers);
    const failure = await caught(run());
    expect(failure.message).toContain(`${prefix}${SECRET_CLASS_SHOWN}. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('s3cr3t');
  });

  it("marks a foreign NotFound class not gone: it is not this resource's not-found", async () => {
    failOn({ [command]: foreignNotFound }, answers);
    const failure = await caught(run());
    expect(failure.message).toContain(`${prefix}KMSNotFoundException.`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(isMarkedNotGone(failure)).toBe(true);
  });
});

// ─── Secrets Manager create / update ────────────────────────────────

describe('the Secrets Manager create and update wraps', () => {
  const create = () =>
    new SecretsManagerSecretProvider().create(
      'Sec',
      'AWS::SecretsManager::Secret',
      { Name: 's', SecretString: 'v' },
      ctx
    );
  const update = () =>
    new SecretsManagerSecretProvider().update(
      'Sec',
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:s-AbCdEf',
      'AWS::SecretsManager::Secret',
      { Name: 's', SecretString: 'v', Description: 'new' },
      { Name: 's', SecretString: 'v', Description: 'old' },
      ctx
    );

  it.each([
    ['create', 'CreateSecretCommand', create, 'Failed to create secret Sec: '],
    ['update', 'UpdateSecretCommand', update, 'Failed to update secret Sec: '],
  ] as const)('%s: class only, cause kept and stamped, debug masked', async (_op, command, run, prefix) => {
    failOn({ [command]: denied });
    const failure = await caught(run());
    expect(failure.message).toContain(`${prefix}AccessDenied. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryClassificationText(failure)).toContain('not authorized');
    expect(lines(debug).some((l) => l.includes(prefix) && l.includes(MASKED_DENIED))).toBe(true);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  it.each([
    ['create', 'CreateSecretCommand', create],
    ['update', 'UpdateSecretCommand', update],
  ] as const)('%s: masks a secret spelled in the class (SECRET-IN-CLASS)', async (_op, command, run) => {
    failOn({ [command]: secretClass });
    const failure = await caught(run());
    expect(failure.message).toContain(SECRET_CLASS_SHOWN);
    expect(failure.message).not.toContain('s3cr3t');
  });

  it('create: restates a taken name, which the collision classifier still reads', async () => {
    failOn({
      CreateSecretCommand: () =>
        awsErr(
          'ResourceExistsException',
          'The operation failed because the secret s already exists.'
        ),
    });
    const failure = await caught(create());
    expect(failure.message).toContain('ResourceExistsException.');
    expect(failure.message).toContain(RESTATED);
    expect(isNameCollisionErrorFrom(failure, 'Sec')).toBe(true);
  });

  it('update: an "already exists" is not restated as this secret\'s own collision', async () => {
    failOn({
      UpdateSecretCommand: () => awsErr('ResourceExistsException', 'A version already exists.'),
    });
    const failure = await caught(update());
    expect(failure.message).toContain('ResourceExistsException.');
    expect(failure.message).not.toContain(RESTATED);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (commandName(command) === 'CreateSecretCommand') throw `raw ${DENIED}`;
      return {};
    });
    const failure = await caught(create());
    expect(failure.message).toContain('Failed to create secret Sec: ');
    expect(failure.message).not.toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each([
    [
      'secret',
      'DeleteSecretCommand',
      () =>
        new SecretsManagerSecretProvider().delete(
          'Res',
          'arn:aws:secretsmanager:us-east-1:000000000000:secret:s-AbCdEf',
          'AWS::SecretsManager::Secret',
          undefined,
          ctx
        ),
    ],
    [
      'EventBridge bus',
      'DeleteEventBusCommand',
      () => new EventBridgeBusProvider().delete('Res', 'bus-1', 'AWS::Events::EventBus', undefined, ctx),
    ],
  ] as const)('%s delete: a cdkd-authored error keeps its text, masked', async (_s, command, run) => {
    failOn({ [command]: () => new Error('socket hang up near s3cr3t') });
    const failure = await caught(run());
    expect(failure.message).toContain('socket hang up near ***');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
  });

  it('create: a cdkd-authored error keeps its text, masked', async () => {
    failOn({ CreateSecretCommand: () => new Error('socket hang up near s3cr3t') });
    const failure = await caught(create());
    expect(failure.message).toContain('socket hang up near ***');
  });
});

// ─── The post-create relay gate ─────────────────────────────────────

describe('a post-create step\'s "already exists" is not restated as the resource\'s own', () => {
  const POST_CREATE: {
    site: string;
    command: string;
    answers: Record<string, unknown>;
    run: () => Promise<unknown>;
  }[] = [
    {
      site: 'API Gateway Stage (UpdateStage patch)',
      command: 'UpdateStageCommand',
      answers: {},
      run: () =>
        new ApiGatewayProvider().create(
          'Res',
          'AWS::ApiGateway::Stage',
          { RestApiId: 'api-1', StageName: 'prod', DeploymentId: 'dep-1', ClientCertificateId: 'c' },
          ctx
        ),
    },
    {
      site: 'API Gateway Method (PutIntegration wiring)',
      command: 'PutIntegrationCommand',
      answers: {},
      run: () =>
        new ApiGatewayProvider().create(
          'Res',
          'AWS::ApiGateway::Method',
          { RestApiId: 'api-1', ResourceId: 'res-1', HttpMethod: 'GET', Integration: { Type: 'MOCK' } },
          ctx
        ),
    },
    {
      site: 'IAM role (PutRolePolicy)',
      command: 'PutRolePolicyCommand',
      answers: { CreateRoleCommand: { Role: { Arn: 'arn:aws:iam::000000000000:role/r', RoleId: 'AROA1' } } },
      run: () =>
        new IAMRoleProvider().create(
          'Res',
          'AWS::IAM::Role',
          {
            RoleName: 'r',
            AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
            Policies: [{ PolicyName: 'p', PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
          },
          ctx
        ),
    },
    {
      site: 'IAM managed policy (AttachRolePolicy)',
      command: 'AttachRolePolicyCommand',
      answers: { CreatePolicyCommand: { Policy: { Arn: 'arn:aws:iam::000000000000:policy/p' } } },
      run: () =>
        new IAMManagedPolicyProvider().create(
          'Res',
          'AWS::IAM::ManagedPolicy',
          {
            ManagedPolicyName: 'p',
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
            Roles: ['r'],
          },
          ctx
        ),
    },
    {
      site: 'IAM access key (UpdateAccessKey Inactive)',
      command: 'UpdateAccessKeyCommand',
      answers: { CreateAccessKeyCommand: { AccessKey: { AccessKeyId: 'AKIA1', SecretAccessKey: 'sk' } } },
      run: () =>
        new IAMAccessKeyProvider().create(
          'Res',
          'AWS::IAM::AccessKey',
          { UserName: 'u', Status: 'Inactive' },
          ctx
        ),
    },
    {
      site: 'EventBridge bus (PutPermission)',
      command: 'PutPermissionCommand',
      answers: { CreateEventBusCommand: { EventBusArn: 'arn:aws:events:us-east-1:000000000000:event-bus/b' } },
      run: () =>
        new EventBridgeBusProvider().create(
          'Res',
          'AWS::Events::EventBus',
          { Name: 'b', Policy: { Version: '2012-10-17', Statement: [] } },
          ctx
        ),
    },
  ];

  it.each(POST_CREATE)('$site', async ({ command, answers, run }) => {
    failOn({ [command]: collision }, answers);
    const failure = await caught(run());
    expect(failure.message).toContain(`ConflictException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(RESTATED);
    expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(false);
  });

  it("EventBridge bus: the bus's own taken name IS restated (positive control)", async () => {
    failOn({
      CreateEventBusCommand: () => awsErr('ResourceAlreadyExistsException', 'Event bus b already exists.'),
    });
    const failure = await caught(
      new EventBridgeBusProvider().create('Res', 'AWS::Events::EventBus', { Name: 'b' }, ctx)
    );
    expect(failure.message).toContain(RESTATED);
    expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
  });

  it('EventBridge bus: masks a secret spelled in the create class (SECRET-IN-CLASS)', async () => {
    failOn({ CreateEventBusCommand: secretClass });
    const failure = await caught(
      new EventBridgeBusProvider().create('Res', 'AWS::Events::EventBus', { Name: 'b' }, ctx)
    );
    expect(failure.message).toContain(SECRET_CLASS_SHOWN);
    expect(failure.message).not.toContain('s3cr3t');
  });
});

// ─── Partial-create cleanup warns ───────────────────────────────────

interface CleanupCase {
  site: string;
  head: string;
  /** The post-create step that fails first. */
  trigger: string;
  /** The cleanup call whose failure the warn reports. */
  cleanup: string;
  answers: Record<string, unknown>;
  run: () => Promise<unknown>;
  before?: () => void;
}

const CLEANUPS: CleanupCase[] = [
  {
    site: 'API Gateway Stage',
    head: 'Failed to clean up stage prod after a post-create patch failure: ',
    trigger: 'UpdateStageCommand',
    cleanup: 'DeleteStageCommand',
    answers: {},
    run: () =>
      new ApiGatewayProvider().create(
        'Res',
        'AWS::ApiGateway::Stage',
        { RestApiId: 'api-1', StageName: 'prod', DeploymentId: 'dep-1', ClientCertificateId: 'c' },
        ctx
      ),
  },
  {
    site: 'API Gateway Method',
    head: 'Failed to clean up partially-created API Gateway Method Res (api-1/res-1/GET): ',
    trigger: 'PutIntegrationCommand',
    cleanup: 'DeleteMethodCommand',
    answers: {},
    run: () =>
      new ApiGatewayProvider().create(
        'Res',
        'AWS::ApiGateway::Method',
        { RestApiId: 'api-1', ResourceId: 'res-1', HttpMethod: 'GET', Integration: { Type: 'MOCK' } },
        ctx
      ),
  },
  {
    site: 'ECS service (--full-wait)',
    head: 'Failed to clean up partially-created ECS service Res (arn:aws:ecs:us-east-1:000000000000:service/c/svc): ',
    trigger: 'none',
    cleanup: 'DeleteServiceCommand',
    answers: {
      DescribeServicesCommand: { services: [], failures: [{ reason: 'MISSING' }] },
      CreateServiceCommand: {
        service: { serviceArn: 'arn:aws:ecs:us-east-1:000000000000:service/c/svc', serviceName: 'svc' },
      },
    },
    before: () => {
      process.env['CDKD_FULL_WAIT'] = 'true';
      waitStable.mockRejectedValue(new Error('Waiter has timed out'));
    },
    run: () =>
      new ECSProvider().create(
        'Res',
        'AWS::ECS::Service',
        { Cluster: 'c', ServiceName: 'svc', TaskDefinition: 'td:1' },
        ctx
      ),
  },
  {
    site: 'log group',
    head: 'Failed to clean up partially-created log group Res (/lg): ',
    trigger: 'PutRetentionPolicyCommand',
    cleanup: 'DeleteLogGroupCommand',
    answers: {},
    run: () =>
      new LogsLogGroupProvider().create(
        'Res',
        'AWS::Logs::LogGroup',
        { LogGroupName: '/lg', RetentionInDays: 7 },
        ctx
      ),
  },
  {
    site: 'IAM role',
    head: 'Failed to clean up partially-created IAM role Res (r): ',
    trigger: 'PutRolePolicyCommand',
    cleanup: 'DeleteRoleCommand',
    answers: { CreateRoleCommand: { Role: { Arn: 'arn:aws:iam::000000000000:role/r', RoleId: 'AROA1' } } },
    run: () =>
      new IAMRoleProvider().create(
        'Res',
        'AWS::IAM::Role',
        {
          RoleName: 'r',
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          Policies: [{ PolicyName: 'p', PolicyDocument: { Version: '2012-10-17', Statement: [] } }],
        },
        ctx
      ),
  },
  {
    site: 'IAM managed policy',
    head: 'Failed to clean up partially-created managed policy Res (arn:aws:iam::000000000000:policy/p): ',
    trigger: 'AttachRolePolicyCommand',
    cleanup: 'DeletePolicyCommand',
    answers: { CreatePolicyCommand: { Policy: { Arn: 'arn:aws:iam::000000000000:policy/p' } } },
    run: () =>
      new IAMManagedPolicyProvider().create(
        'Res',
        'AWS::IAM::ManagedPolicy',
        {
          ManagedPolicyName: 'p',
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
          Roles: ['r'],
        },
        ctx
      ),
  },
  {
    site: 'IAM instance profile',
    head: 'Failed to clean up partially-created IAM instance profile Res (ip): ',
    trigger: 'AddRoleToInstanceProfileCommand',
    cleanup: 'DeleteInstanceProfileCommand',
    answers: {
      CreateInstanceProfileCommand: { InstanceProfile: { Arn: 'a', InstanceProfileId: 'AIPA1' } },
    },
    run: () =>
      new IAMInstanceProfileProvider().create(
        'Res',
        'AWS::IAM::InstanceProfile',
        { InstanceProfileName: 'ip', Roles: ['r'] },
        ctx
      ),
  },
  {
    site: 'CodeCommit repository',
    head: 'Failed to clean up CodeCommit Repository repo after a post-create failure: ',
    trigger: 'PutRepositoryTriggersCommand',
    cleanup: 'DeleteRepositoryCommand',
    answers: {
      CreateRepositoryCommand: {
        repositoryMetadata: { repositoryName: 'repo', repositoryId: 'rid', Arn: 'arn' },
      },
    },
    run: () =>
      new CodeCommitRepositoryProvider().create(
        'Res',
        'AWS::CodeCommit::Repository',
        {
          RepositoryName: 'repo',
          Triggers: [{ Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:0:t', Events: ['all'] }],
        },
        ctx
      ),
  },
  {
    site: 'ACM certificate',
    head: 'Could not delete the ACM certificate arn:aws:acm:us-east-1:000000000000:certificate/c that the failed create of Res requested: ',
    trigger: 'DescribeCertificateCommand',
    cleanup: 'DeleteCertificateCommand',
    answers: { RequestCertificateCommand: { CertificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/c' } },
    run: () =>
      new ACMCertificateProvider().create(
        'Res',
        'AWS::CertificateManager::Certificate',
        { DomainName: 'example.com', ValidationMethod: 'DNS' },
        ctx
      ),
  },
];

/** Every warn/error line the run printed. */
const printed = (): string => [...lines(warn), ...lines(error)].join('\n');

describe.each(CLEANUPS)('the $site partial-create cleanup line', (c) => {
  const arm = (cleanupError: () => Error): void => {
    c.before?.();
    failOn(
      {
        ...(c.trigger === 'none'
          ? {}
          : { [c.trigger]: () => awsErr('BadRequestException', 'bad wiring') }),
        [c.cleanup]: cleanupError,
      },
      c.answers
    );
  };

  it("names the class at warn, AWS's text at debug, masked", async () => {
    expectCarriesIdentity(denied);
    arm(denied);
    await caught(c.run());
    expect(printed()).toContain(`${c.head}AccessDenied. ${VERBOSE_POINTER}`);
    expect(printed()).not.toContain(ACCOUNT);
    expect(printed()).not.toContain('not authorized');
    expect(lines(debug).some((l) => l.includes(c.head) && l.includes(MASKED_DENIED))).toBe(true);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  it('masks a secret spelled in the class (SECRET-IN-CLASS)', async () => {
    arm(secretClass);
    await caught(c.run());
    expect(printed()).toContain(`${c.head}${SECRET_CLASS_SHOWN}. ${VERBOSE_POINTER}`);
    expect(printed()).not.toContain('s3cr3t');
  });

  it('keeps a cdkd-authored failure\'s text (polarity)', async () => {
    arm(() => new Error('socket hang up'));
    await caught(c.run());
    expect(printed()).toContain(`${c.head}socket hang up`);
    expect(printed()).not.toContain(VERBOSE_POINTER);
  });
});

// ─── CodeCommit identity reads ──────────────────────────────────────

describe('the CodeCommit identity-read wraps', () => {
  const update = () =>
    new CodeCommitRepositoryProvider().update(
      'Res',
      'repo',
      'AWS::CodeCommit::Repository',
      { RepositoryName: 'repo', RepositoryDescription: 'new' },
      { RepositoryName: 'repo', RepositoryDescription: 'old' },
      { ...ctx, recordedAttributes: { RepositoryId: 'rid' } }
    );
  const del = () =>
    new CodeCommitRepositoryProvider().delete(
      'Res',
      'repo',
      'AWS::CodeCommit::Repository',
      undefined,
      { ...ctx, recordedAttributes: { RepositoryId: 'rid' } }
    );

  it('update: the holder read names the class, its text at debug, masked', async () => {
    failOn({ GetRepositoryCommand: denied });
    const failure = await caught(update());
    expect(failure.message).toBe(
      `Failed to update CodeCommit Repository Res: AccessDenied. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(failure)).toBe(true);
    expect(
      lines(debug).some(
        (l) => l.includes('GetRepository failed while checking the holder') && l.includes(MASKED_DENIED)
      )
    ).toBe(true);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });

  it('update: masks a secret spelled in the class (SECRET-IN-CLASS)', async () => {
    failOn({ GetRepositoryCommand: secretClass });
    const failure = await caught(update());
    expect(failure.message).toContain(SECRET_CLASS_SHOWN);
    expect(failure.message).not.toContain('s3cr3t');
  });

  it('delete: the unconfirmed-identity warn masks a secret spelled in the class (SECRET-IN-CLASS)', async () => {
    failOn({ GetRepositoryCommand: secretClass });
    const result = await del();
    expect(lines(warn).join('\n')).toContain(SECRET_CLASS_SHOWN);
    expect(lines(warn).join('\n')).not.toContain('s3cr3t');
    expect(JSON.stringify(result ?? {})).not.toContain('s3cr3t');
  });

  it("delete: the unconfirmed-identity warn names the class, AWS's text at debug, masked", async () => {
    failOn({ GetRepositoryCommand: denied });
    await del();
    expect(lines(warn).join('\n')).toContain(`AccessDenied. ${VERBOSE_POINTER}`.replace(/\.$/, ''));
    expect(lines(warn).join('\n')).not.toContain(ACCOUNT);
    expect(lines(debug).some((l) => l.includes(MASKED_DENIED))).toBe(true);
    expect(lines(debug).join('\n')).not.toContain('s3cr3t');
  });
});

// ─── DeletionPolicy: Snapshot refusals ──────────────────────────────

describe('the final-snapshot refusals', () => {
  const logger = { info: vi.fn(), debug: vi.fn() };
  const client = (failing: Record<string, () => Error>, answers: Record<string, unknown> = {}) =>
    ({
      send: (command: unknown) => {
        const name = commandName(command);
        const make = failing[name];
        if (make) return Promise.reject(make());
        return Promise.resolve(answers[name] ?? {});
      },
    }) as never;

  const SITES: {
    site: string;
    head: string;
    /** The full head, where `head` cannot spell a generated snapshot id. */
    pattern?: RegExp;
    run: (make: () => Error) => Promise<unknown>;
  }[] = [
    {
      site: 'EBS CreateSnapshot',
      head: 'Failed to create the final snapshot for Vol (vol-1) required by DeletionPolicy: Snapshot: ',
      run: (make) =>
        createEbsFinalSnapshot(client({ CreateSnapshotCommand: make }), 'vol-1', 'Vol', logger),
    },
    {
      site: 'EBS snapshot poll',
      head: 'Failed while waiting for final snapshot snap-1 of Vol (vol-1): ',
      run: (make) =>
        createEbsFinalSnapshot(
          client({ DescribeSnapshotsCommand: make }, { CreateSnapshotCommand: { SnapshotId: 'snap-1' } }),
          'vol-1',
          'Vol',
          logger
        ),
    },
    {
      site: 'Redshift CreateClusterSnapshot',
      head: 'Failed to create the final snapshot for Rs (rs-1) required by DeletionPolicy: Snapshot: ',
      run: (make) =>
        createRedshiftFinalSnapshot(client({ CreateClusterSnapshotCommand: make }), 'rs-1', 'Rs', logger),
    },
    {
      site: 'Redshift snapshot poll',
      head: 'Failed while waiting for final snapshot ',
      pattern: /Failed while waiting for final snapshot \S+ of Rs \(rs-1\): AccessDenied\. /,
      run: (make) =>
        createRedshiftFinalSnapshot(client({ DescribeClusterSnapshotsCommand: make }), 'rs-1', 'Rs', logger),
    },
    {
      site: 'ElastiCache DescribeReplicationGroups',
      head: 'Failed to read replication group rg-1 (Rg) to pick the final snapshot source required by DeletionPolicy: Snapshot: ',
      run: (make) =>
        createReplicationGroupFinalSnapshot(
          client({ DescribeReplicationGroupsCommand: make }),
          'rg-1',
          'Rg',
          logger
        ),
    },
    {
      site: 'ElastiCache CreateSnapshot',
      head: 'Failed to create the final snapshot for Rg (rg-1) required by DeletionPolicy: Snapshot: ',
      run: (make) =>
        createReplicationGroupFinalSnapshot(
          client(
            { CreateSnapshotCommand: make },
            { DescribeReplicationGroupsCommand: { ReplicationGroups: [{ ClusterEnabled: true }] } }
          ),
          'rg-1',
          'Rg',
          logger
        ),
    },
  ];

  beforeEach(() => {
    logger.info.mockReset();
    logger.debug.mockReset();
  });

  it.each(SITES)('$site: class only, cause kept and stamped, AWS text at debug', async ({ head, pattern, run }) => {
    expectCarriesIdentity(denied);
    const failure = await caught(run(denied));
    expect(failure.message).toContain(head);
    if (pattern) expect(failure.message).toMatch(pattern);
    expect(failure.message).toContain(`AccessDenied. ${VERBOSE_POINTER} `);
    expect(failure.message).toMatch(/was NOT deleted/);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(failure.message).not.toContain('not authorized');
    expect((failure as { code?: string }).code).toBe('FINAL_SNAPSHOT_FAILED');
    expect(failure.cause).toBeInstanceOf(Error);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryClassificationText(failure)).toContain('not authorized');
    expect(
      logger.debug.mock.calls.some((c) => String(c[0]).startsWith(head.replace(/: $/, '')) && String(c[0]).includes(ACCOUNT))
    ).toBe(true);
  });

  it.each(SITES)('$site: a cdkd-authored failure keeps its text, unstamped', async ({ run }) => {
    const failure = await caught(run(() => new Error('socket hang up')));
    expect(failure.message).toContain('socket hang up. ');
    expect(hasRedactedCause(failure)).toBe(false);
  });
});
