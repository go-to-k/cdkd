/**
 * Issue #3979, the deploy arm: `cdkd deploy --replace` deletes the OLD
 * resource first when the replacement's create-first attempt collides. The
 * #3808 check refuses only a KNOWN different explicit name, so a template that
 * names NO name — or one a rewriting provider sends under another spelling —
 * used to delete the old resource on the classifier's word alone, though an
 * orphan of an earlier attempt, a replayed create or a squatter collides
 * identically. The delete-first now runs only once the old resource is proven
 * to hold the name the create SENT.
 *
 * Driven through the REAL `DeployEngine.provisionResource` and the REAL
 * providers; only the SDK clients' `send` is stubbed (and the provider's
 * `delete` spied, to observe it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// `vi.mock` factories are hoisted above the constants they could close over.
const SECRET_EXPR_FOR_MOCK = vi.hoisted(
  () => '{{resolve:secretsmanager:app/role:SecretString:name::}}'
);

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/** A resolved secret, recorded the way the real resolver records one. */
const SECRET = 'tok"en-SECRETVALUE';

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation(
        (value: unknown, ctx?: { recordedSecretValues?: Map<string, string> }) => {
          if (JSON.stringify(value ?? null).includes('SECRETVALUE')) {
            ctx?.recordedSecretValues?.set('tok"en-SECRETVALUE', SECRET_EXPR_FOR_MOCK);
          }
          return Promise.resolve(value);
        }
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

const iamSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: { send: iamSend } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import { KinesisClient } from '@aws-sdk/client-kinesis';

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

type Inner = Error & { code?: string; cause?: unknown };

const STACK = 'MyStack';

function makeEngine(
  provider: ResourceProvider,
  provisionedBy: 'sdk' | 'cc-api' = 'sdk',
  replace = true
): InstanceType<typeof DeployEngine> {
  return new DeployEngine(
    { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') } as unknown as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as unknown as never,
    // A Kinesis stream is stateful: the data-loss consent is not what is
    // under test, so give it.
    { replace, forceStatefulRecreation: true },
    'us-east-1'
  );
}

/**
 * Runs one property-driven replacement of `logicalId` inside the stack scope
 * the deploy command binds, and returns the failure's inner error (or null).
 */
async function replaceOnce(opts: {
  provider: ResourceProvider;
  logicalId: string;
  type: string;
  physicalId: string;
  oldProps: Record<string, unknown>;
  newProps: Record<string, unknown>;
  changedPath: string;
  provisionedBy?: 'sdk' | 'cc-api';
  /** The old record's `provisionedBy`, when it differs from the create's route. */
  holderProvisionedBy?: 'sdk' | 'cc-api' | null;
  replace?: boolean;
  retain?: boolean;
  /** The state record's type, for a Type-change replacement. */
  oldType?: string;
  observed?: Record<string, unknown>;
}): Promise<Inner | null> {
  const change: ResourceChange = {
    logicalId: opts.logicalId,
    changeType: 'UPDATE',
    resourceType: opts.type,
    currentProperties: opts.oldProps,
    desiredProperties: opts.newProps,
    propertyChanges: [
      {
        path: opts.changedPath,
        oldValue: opts.oldProps[opts.changedPath],
        newValue: opts.newProps[opts.changedPath],
        requiresReplacement: true,
      },
    ],
  };
  const stateResources = {
    [opts.logicalId]: {
      physicalId: opts.physicalId,
      resourceType: opts.oldType ?? opts.type,
      properties: opts.oldProps,
      ...(opts.observed !== undefined && { observedProperties: opts.observed }),
      attributes: {},
      dependencies: [],
      ...(opts.holderProvisionedBy !== null && {
        provisionedBy: opts.holderProvisionedBy ?? opts.provisionedBy ?? 'sdk',
      }),
    },
  };
  const template: CloudFormationTemplate = {
    Resources: {
      [opts.logicalId]: {
        Type: opts.type,
        Properties: opts.newProps,
        ...(opts.retain === true && { UpdateReplacePolicy: 'Retain' }),
      },
    },
  };
  const engine = makeEngine(opts.provider, opts.provisionedBy, opts.replace ?? true);
  const run = (
    engine as unknown as {
      provisionResource: (
        logicalId: string,
        change: ResourceChange,
        stateResources: Record<string, unknown>,
        stackName: string,
        template: CloudFormationTemplate
      ) => Promise<void>;
    }
  ).provisionResource.bind(engine);
  return withStackName(STACK, () =>
    run(opts.logicalId, change, stateResources, STACK, template).then(
      () => null,
      (e) => (e as { cause?: unknown }).cause as Inner
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  iamSend.mockReset();
  vi.stubEnv('AWS_REGION', 'us-east-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ─── Kinesis: a nameless template, and a squatter on the generated name ──

const KINESIS = 'AWS::Kinesis::Stream';
/** What the real provider generates for the nameless `Stream` in `MyStack`. */
const GENERATED = `${STACK}-Stream`;

/** The first `CreateStream` collides; later ones succeed. Returns the names sent. */
function stubKinesis(): string[] {
  const sent: string[] = [];
  vi.spyOn(
    KinesisClient.prototype as unknown as { send: (c: unknown) => Promise<unknown> },
    'send'
  ).mockImplementation(async (command: unknown) => {
    const c = command as { constructor: { name: string }; input?: { StreamName?: string } };
    if (c.constructor.name === 'CreateStreamCommand') {
      sent.push(String(c.input?.StreamName));
      if (sent.length === 1) {
        throw awsSdkError(
          `Stream ${String(c.input?.StreamName)} under account 123456789012 already exists.`,
          'ResourceInUseException'
        );
      }
      return {};
    }
    if (c.constructor.name === 'DescribeStreamCommand') {
      return {
        StreamDescription: {
          StreamStatus: 'ACTIVE',
          StreamARN: `arn:aws:kinesis:us-east-1:123456789012:stream/${GENERATED}`,
        },
      };
    }
    return {};
  });
  return sent;
}

describe('deploy --replace proves the old resource holds the SENT name before deleting it (#3979)', () => {
  it('Kinesis: a template that DROPPED its explicit name collides with a squatter — the old stream survives', async () => {
    // The old stream is `app-stream` (an explicit name the template has since
    // dropped). The create sends cdkd's generated `MyStack-Stream`, which an
    // orphan of an earlier attempt holds. `app-stream` never held it.
    const sent = stubKinesis();
    const provider = new KinesisStreamProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'Stream',
      type: KINESIS,
      physicalId: 'app-stream',
      oldProps: { Name: 'app-stream', ShardCount: 1, RetentionPeriodHours: 24 },
      newProps: { ShardCount: 1, RetentionPeriodHours: 48 },
      changedPath: 'RetentionPeriodHours',
    });

    // THE DISCRIMINATOR, first: before #3979's deploy arm, --replace deleted it.
    expect(del).not.toHaveBeenCalled();
    // The scope is the one described above: the provider really sent this.
    expect(sent).toEqual([GENERATED]);
    expect(err).not.toBeNull();
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(err!.message).toContain(`cdkd's rule generates Name "${GENERATED}"`);
    expect(err!.message).toContain('the resource being replaced (app-stream)');
    // The UNDECIDED arm: the diagnosis cannot name another holder, and says
    // so once.
    expect(err!.message).toContain(
      'cdkd cannot show that the resource being replaced (app-stream) holds that name — so if ' +
        'another resource holds it'
    );
    expect(err!.message.split('cdkd cannot show').length - 1).toBe(1);
    expect(err!.message).toContain('--replace was NOT applied and nothing was deleted');
    expect(err!.message).toContain(`Stream ${GENERATED} under account`);
    // Chained, so the persisted event names the AWS rejection.
    expect((err!.cause as Error).message).toContain('already exists');
  });

  it('NEGATIVE CONTROL: the old stream holds the generated name, so it is deleted first and re-created', async () => {
    const sent = stubKinesis();
    const provider = new KinesisStreamProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'Stream',
      type: KINESIS,
      physicalId: GENERATED,
      oldProps: { ShardCount: 1, RetentionPeriodHours: 24 },
      newProps: { ShardCount: 1, RetentionPeriodHours: 48 },
      changedPath: 'RetentionPeriodHours',
    });

    expect(err).toBeNull();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[1]).toBe(GENERATED);
    expect(sent).toEqual([GENERATED, GENERATED]);
  });
});

// ─── IAM: an explicit name the provider REWRITES under this deploy's scope ─

const ROLE = 'AWS::IAM::Role';
const TRUST = { Version: '2012-10-17', Statement: [] };

/** The first `CreateRole` collides; later ones succeed. Returns the names sent. */
function stubIam(): string[] {
  const sent: string[] = [];
  iamSend.mockImplementation(async (command: unknown) => {
    const c = command as { constructor: { name: string }; input?: { RoleName?: string } };
    if (c.constructor.name === 'CreateRoleCommand') {
      sent.push(String(c.input?.RoleName));
      if (sent.length === 1) {
        throw awsSdkError(
          `Role with name ${String(c.input?.RoleName)} already exists.`,
          'EntityAlreadyExistsException'
        );
      }
      return {
        Role: { Arn: `arn:aws:iam::123456789012:role/${c.input?.RoleName}`, RoleId: 'AROAX' },
      };
    }
    return {};
  });
  return sent;
}

describe('a rewriting provider: the recorded name is no proof (#3979)', () => {
  it('IAM: the old role `my-role` (made under --no-prefix) survives a squatter on the prefixed name', async () => {
    // This deploy keeps the prefix (no `withSkipPrefix` scope), so the real
    // IAMRoleProvider sends `MyStack-my-role`. The template's RoleName and the
    // record agree (`my-role`), so the #3808 check stays silent — yet the old
    // role never held the name the create collided on.
    const sent = stubIam();
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'MyRole',
      type: ROLE,
      physicalId: 'my-role',
      oldProps: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/a/' },
      newProps: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/b/' },
      changedPath: 'Path',
    });

    expect(del).not.toHaveBeenCalled();
    expect(sent).toEqual([`${STACK}-my-role`]);
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain(`sends as "${STACK}-my-role"`);
    expect(err!.message).toContain('a recorded name is no proof');
    expect(err!.message).toContain('if that is the resource being replaced itself, delete it by hand');
  });

  it('NEGATIVE CONTROL: the old role holds the prefixed name, so it is deleted first', async () => {
    const sent = stubIam();
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'MyRole',
      type: ROLE,
      physicalId: `${STACK}-my-role`,
      oldProps: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/a/' },
      newProps: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/b/' },
      changedPath: 'Path',
    });

    expect(err).toBeNull();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[1]).toBe(`${STACK}-my-role`);
    expect(sent).toEqual([`${STACK}-my-role`, `${STACK}-my-role`]);
  });
});

describe('the proof reads what THIS create sent (#3979)', () => {
  it('a NAMELESS role: the provider derives the name from the logical id, and the old role holding it is deleted first', async () => {
    const sent = stubIam();
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'MyRole',
      type: ROLE,
      physicalId: `${STACK}-MyRole`,
      oldProps: { AssumeRolePolicyDocument: TRUST, Path: '/a/' },
      newProps: { AssumeRolePolicyDocument: TRUST, Path: '/b/' },
      changedPath: 'Path',
    });

    expect(err).toBeNull();
    expect(sent).toEqual([`${STACK}-MyRole`, `${STACK}-MyRole`]);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[1]).toBe(`${STACK}-MyRole`);
  });

  it('on the Cloud Control route the bag IS the sent name, so the old role holding it is deleted first', async () => {
    // Were the route not passed, the SDK rewrite would derive `MyStack-my-role`
    // and refuse a genuine holder.
    const calls: string[] = [];
    let creates = 0;
    const provider = {
      create: vi.fn(async () => {
        calls.push('create');
        if (creates++ === 0) {
          throw awsSdkError('Role with name my-role already exists.', 'EntityAlreadyExistsException');
        }
        return { physicalId: 'my-role', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(async () => {
        calls.push('delete');
      }),
      getAttribute: vi.fn(),
    } as unknown as ResourceProvider;

    const err = await replaceOnce({
      provider,
      logicalId: 'MyRole',
      type: ROLE,
      physicalId: 'my-role',
      oldProps: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/a/' },
      newProps: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/b/' },
      changedPath: 'Path',
      provisionedBy: 'cc-api',
    });

    expect(err).toBeNull();
    expect(calls).toEqual(['create', 'delete', 'create']);
  });

  it('reads the old resource OBSERVED bag where its record is silent (a stage placed by its API)', async () => {
    // The record lacks the RestApiId that places the stage; the observed bag
    // has it. Without that read the scope is unproven and nothing is deleted.
    const calls: string[] = [];
    let creates = 0;
    const provider = {
      create: vi.fn(async () => {
        calls.push('create');
        if (creates++ === 0) throw awsSdkError('Stage already exists', 'ConflictException');
        return { physicalId: 'prod', attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn(async () => {
        calls.push('delete');
      }),
      getAttribute: vi.fn(),
    } as unknown as ResourceProvider;
    const STAGE = 'AWS::ApiGateway::Stage';
    const change: ResourceChange = {
      logicalId: 'Stage',
      changeType: 'UPDATE',
      resourceType: STAGE,
      currentProperties: { StageName: 'prod', Description: 'a' },
      desiredProperties: { StageName: 'prod', RestApiId: 'api1', Description: 'b' },
      propertyChanges: [
        { path: 'Description', oldValue: 'a', newValue: 'b', requiresReplacement: true },
      ],
    };
    const stateResources = {
      Stage: {
        physicalId: 'prod',
        resourceType: STAGE,
        properties: { StageName: 'prod', Description: 'a' },
        observedProperties: { RestApiId: 'api1' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };
    const engine = makeEngine(provider);
    const err = await withStackName(STACK, () =>
      (
        engine as unknown as {
          provisionResource: (...a: unknown[]) => Promise<void>;
        }
      )
        .provisionResource('Stage', change, stateResources, STACK, {
          Resources: { Stage: { Type: STAGE, Properties: change.desiredProperties } },
        })
        .then(
          () => null,
          (e: unknown) => e
        )
    );

    expect(err).toBeNull();
    expect(calls).toEqual(['create', 'delete', 'create']);
  });

  it('masks a secret-derived name BEFORE rendering it, where the message mask cannot reach it', async () => {
    // `displayIdent` escapes the `"`, so the escaped spelling no longer
    // contains the plaintext the whole-message mask looks for.
    iamSend.mockImplementation(async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === 'CreateRoleCommand') {
        throw awsSdkError('Role already exists.', 'EntityAlreadyExistsException');
      }
      return {};
    });
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'MyRole',
      type: ROLE,
      physicalId: SECRET,
      oldProps: { RoleName: SECRET, AssumeRolePolicyDocument: TRUST, Path: '/a/' },
      newProps: { RoleName: SECRET, AssumeRolePolicyDocument: TRUST, Path: '/b/' },
      changedPath: 'Path',
    });

    expect(del).not.toHaveBeenCalled();
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('which its provider rewrites before sending it');
    expect(err!.message).not.toContain('SECRETVALUE');
  });
});

/** A provider double: records the calls and the bag each create was sent. */
function recordingProvider(firstCreateError: Error, physicalId: string) {
  const calls: string[] = [];
  const sentBags: Array<Record<string, unknown>> = [];
  let creates = 0;
  const provider = {
    create: vi.fn(async (_id: string, _type: string, props: Record<string, unknown>) => {
      calls.push('create');
      sentBags.push({ ...props });
      if (creates++ === 0) throw firstCreateError;
      return { physicalId, attributes: {} };
    }),
    update: vi.fn(),
    delete: vi.fn(async () => {
      calls.push('delete');
    }),
    getAttribute: vi.fn(),
  } as unknown as ResourceProvider;
  return { provider, calls, sentBags };
}

describe('the review round of #3979', () => {
  it('a nameless Cloud Control create is proven by the name the CC bag CARRIES, not the resolved bag', async () => {
    // `preparePropertiesForCcApi` injects the generated RoleName into the bag
    // it SENDS; the resolved bag has none. Proving from the resolved bag would
    // refuse this genuine holder.
    const { provider, calls, sentBags } = recordingProvider(
      awsSdkError(`Role with name ${STACK}-MyRole already exists.`, 'EntityAlreadyExistsException'),
      `${STACK}-MyRole`
    );

    const err = await replaceOnce({
      provider,
      logicalId: 'MyRole',
      type: ROLE,
      physicalId: `${STACK}-MyRole`,
      oldProps: { AssumeRolePolicyDocument: TRUST, Path: '/a/' },
      newProps: { AssumeRolePolicyDocument: TRUST, Path: '/b/' },
      changedPath: 'Path',
      provisionedBy: 'cc-api',
    });

    expect(sentBags[0]?.['RoleName']).toBe(`${STACK}-MyRole`);
    expect(err).toBeNull();
    expect(calls).toEqual(['create', 'delete', 'create']);
  });

  it('a stage moved to another API is KNOWN to collide with someone else, and nothing is deleted', async () => {
    const { provider, calls } = recordingProvider(
      awsSdkError('Stage already exists', 'ConflictException'),
      'prod'
    );
    const STAGE = 'AWS::ApiGateway::Stage';

    const err = await replaceOnce({
      provider,
      logicalId: 'Stage',
      type: STAGE,
      physicalId: 'prod',
      oldProps: { StageName: 'prod', RestApiId: 'api1' },
      newProps: { StageName: 'prod', RestApiId: 'api2' },
      changedPath: 'RestApiId',
    });

    expect(calls).toEqual(['create']);
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('is under RestApiId "api1", not "api2"');
    expect(err!.message).toContain('so another resource holds the colliding name');
    // The KNOWN arm names no "if that is the resource being replaced" remedy.
    expect(err!.message).not.toContain('if that is the resource being replaced itself');
  });

  it('a nameless log group is proven through the name its provider wraps (/cdkd/...), and deleted first', async () => {
    const LG = 'AWS::Logs::LogGroup';
    const { provider, calls } = recordingProvider(
      awsSdkError('The specified log group already exists', 'ResourceAlreadyExistsException'),
      `/cdkd/${STACK}-Lg`
    );

    const err = await replaceOnce({
      provider,
      logicalId: 'Lg',
      type: LG,
      physicalId: `/cdkd/${STACK}-Lg`,
      oldProps: { LogGroupClass: 'STANDARD' },
      newProps: { LogGroupClass: 'INFREQUENT_ACCESS' },
      changedPath: 'LogGroupClass',
    });

    expect(err).toBeNull();
    expect(calls).toEqual(['create', 'delete', 'create']);
  });

  it('WITHOUT --replace, an unproven holder is refused without advising --replace', async () => {
    stubKinesis();
    const provider = new KinesisStreamProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'Stream',
      type: KINESIS,
      physicalId: 'app-stream',
      oldProps: { Name: 'app-stream', ShardCount: 1, RetentionPeriodHours: 24 },
      newProps: { ShardCount: 1, RetentionPeriodHours: 48 },
      changedPath: 'RetentionPeriodHours',
      replace: false,
    });

    expect(del).not.toHaveBeenCalled();
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain(
      '`cdkd deploy --replace` would refuse the same way rather than delete it'
    );
    expect(err!.message).not.toContain('to delete the old resource FIRST');
    expect(err!.message).not.toContain('--replace was NOT applied');
  });
});

describe('under UpdateReplacePolicy: Retain, an unproven holder is refused on its own terms (#3979)', () => {
  it('says nothing was deleted, and neither claims the old resource holds the name nor offers --replace', async () => {
    stubKinesis();
    const provider = new KinesisStreamProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const err = await replaceOnce({
      provider,
      logicalId: 'Stream',
      type: KINESIS,
      physicalId: 'app-stream',
      oldProps: { Name: 'app-stream', ShardCount: 1, RetentionPeriodHours: 24 },
      newProps: { ShardCount: 1, RetentionPeriodHours: 48 },
      changedPath: 'RetentionPeriodHours',
      replace: false,
      retain: true,
    });

    expect(del).not.toHaveBeenCalled();
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('cdkd cannot show that the resource being replaced (app-stream)');
    expect(err!.message).toContain(' Nothing was deleted. UpdateReplacePolicy: Retain keeps the resource');
    expect(err!.message).toContain('removing it and re-running with `cdkd deploy --replace` would refuse');
    expect(err!.message).not.toContain('still held by the existing resource');
  });
});

describe('the parent review round of #3979', () => {
  it('a nameless DynamoDB Table replacing a GlobalTable of the generated name is proven through the TABLE rule', async () => {
    // Shared name space, Type change: the generated name must be the NEW
    // type's, which is what the create sends.
    const { provider, calls } = recordingProvider(
      awsSdkError(`Table already exists: ${STACK}-Tbl`, 'ResourceInUseException'),
      `${STACK}-Tbl`
    );
    const err = await replaceOnce({
      provider,
      logicalId: 'Tbl',
      type: 'AWS::DynamoDB::Table',
      oldType: 'AWS::DynamoDB::GlobalTable',
      physicalId: `${STACK}-Tbl`,
      oldProps: { BillingMode: 'PAY_PER_REQUEST' },
      newProps: { BillingMode: 'PAY_PER_REQUEST' },
      changedPath: 'Type',
    });
    expect(err?.message ?? null).toBeNull();
    expect(calls).toEqual(['create', 'delete', 'create']);
  });

  it('an SDK-made record does not let a Cloud Control create prove an unkeyed type by its identifier', async () => {
    const { provider, calls } = recordingProvider(
      awsSdkError('Pipe my-pipe already exists.', 'AlreadyExistsException'),
      'my-pipe'
    );
    const err = await replaceOnce({
      provider,
      logicalId: 'Pipe',
      type: 'AWS::Pipes::Pipe',
      physicalId: 'my-pipe',
      oldProps: { Name: 'my-pipe', Source: 'arn:a' },
      newProps: { Name: 'my-pipe', Source: 'arn:b' },
      changedPath: 'Source',
      provisionedBy: 'cc-api',
      holderProvisionedBy: 'sdk',
    });
    expect(calls).toEqual(['create']);
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).not.toContain('written by an older cdkd');
  });

  it('a record from an older cdkd (no provisionedBy) is refused with that reason', async () => {
    const { provider, calls } = recordingProvider(
      awsSdkError('Pipe my-pipe already exists.', 'AlreadyExistsException'),
      'my-pipe'
    );
    const err = await replaceOnce({
      provider,
      logicalId: 'Pipe',
      type: 'AWS::Pipes::Pipe',
      physicalId: 'my-pipe',
      oldProps: { Name: 'my-pipe', Source: 'arn:a' },
      newProps: { Name: 'my-pipe', Source: 'arn:b' },
      changedPath: 'Source',
      provisionedBy: 'cc-api',
      holderProvisionedBy: null,
    });
    expect(calls).toEqual(['create']);
    expect(err!.message).toContain('written by an older cdkd, does not say it was created through Cloud Control');
  });

  it('an old resource renamed out of band (read-back disagrees with the record) is not deleted for a squatter on the recorded name', async () => {
    const { provider, calls } = recordingProvider(
      awsSdkError('Function already exist: my-fn', 'ResourceConflictException'),
      'my-fn'
    );
    const err = await replaceOnce({
      provider,
      logicalId: 'Fn',
      type: 'AWS::Lambda::Function',
      physicalId: 'my-fn',
      oldProps: { FunctionName: 'my-fn', Runtime: 'nodejs20.x' },
      newProps: { FunctionName: 'my-fn', Runtime: 'nodejs22.x' },
      observed: { FunctionName: 'renamed-fn' },
      changedPath: 'Runtime',
    });
    expect(calls).toEqual(['create']);
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('disagree on its FunctionName');
  });

  it('renders the AWS collision text display-safe: a line break in it cannot start a line', async () => {
    const { provider } = recordingProvider(
      awsSdkError('Stream x already exists.\nTo orphan it: forged', 'ResourceInUseException'),
      'x'
    );
    const err = await replaceOnce({
      provider,
      logicalId: 'Stream',
      type: KINESIS,
      physicalId: 'app-stream',
      oldProps: { Name: 'app-stream', ShardCount: 1, RetentionPeriodHours: 24 },
      newProps: { ShardCount: 1, RetentionPeriodHours: 48 },
      changedPath: 'RetentionPeriodHours',
    });
    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).not.toContain('\n');
  });
});
