import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

/**
 * The go-to-k/cdkd#2319 tail-f slice: SSM parameter, Kinesis stream,
 * CloudTrail trail, IAM user / group, FSx file system and the EMR cluster /
 * instance group / instance fleet providers.
 *
 * A thrown wrap is persisted to `deployments/{runId}.jsonl`, and an access
 * denial names the caller's assumed-role ARN and account id. So:
 * - the SSM create / update / delete wraps name an AWS-authored failure by its
 *   class plus the `--verbose` pointer (AWS's text at masked debug, the cause
 *   kept and stamped);
 * - a delete wrap whose class spells `NotFound` is marked not-gone;
 * - an "already exists" from a step after the resource was created is not
 *   restated as this resource's collision (#3826);
 * - a best-effort cleanup / delete `warn` names an AWS failure by its class,
 *   with AWS's text on a masked debug line.
 */

const { mockSend, debug, warn, accountInfo, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  const client = {
    send: (command: unknown) => send(command),
    config: {
      region: () => Promise.resolve('us-east-1'),
      retryStrategy: () => Promise.resolve(undefined),
    },
    middlewareStack: { add: () => undefined, addRelativeTo: () => undefined },
  };
  return {
    mockSend: send,
    debug: vi.fn(),
    warn: vi.fn(),
    accountInfo: vi.fn(),
    fakeClient: () => client,
  };
});

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return { ...actual, EMRClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-fsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-fsx')>();
  return { ...actual, FSxClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ssm')>();
  return { ...actual, SSMClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return { ...actual, KinesisClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>();
  return { ...actual, CloudTrailClient: vi.fn().mockImplementation(fakeClient) };
});
// The shared clients (`getAwsClients().ssm`, `.iam`, ...) route to the same fake.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => new Proxy({}, { get: () => fakeClient() }),
}));
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>();
  return { ...actual, getAccountInfo: accountInfo };
});
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => childLogger, debug, info: vi.fn(), warn, error: vi.fn() }),
  };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import {
  EMRClusterProvider,
  resetEMRClusterCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-cluster-provider.js';
import {
  EMRInstanceGroupConfigProvider,
  resetEMRInstanceGroupCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import {
  EMRInstanceFleetConfigProvider,
  resetEMRInstanceFleetCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import {
  allowUnscopedCreateTokensForTests,
  resetIdempotencyTokensForTests,
} from '../../../src/provisioning/providers/idempotency-token.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';

// The FSx / EMR creates run outside a withStackName scope, so the
// stack-scoped create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => allowUnscopedCreateTokensForTests(true));
afterAll(() => allowUnscopedCreateTokensForTests(false));

const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y`;
/** An AWS-authored access denial (the smithy markers `describeAwsFailure` keys on). */
const awsError = (name: string, message: string): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const denied = (): Error => awsError('AccessDenied', DENIED);
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const ctx = { maskSecrets: mask };
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));
const warnLines = (): string[] => warn.mock.calls.map((c) => String(c[0]));
const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every send of a `failing` command rejects with its value; the rest answer `answers` or `{}`. */
function route(failing: Record<string, unknown>, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name in failing) throw failing[name];
    const answer = answers[name];
    return typeof answer === 'function' ? (answer as () => unknown)() : (answer ?? {});
  });
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const poll = { pollIntervalMs: 0, maxWaitMs: 5000 };

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  accountInfo.mockReset();
  accountInfo.mockResolvedValue({ accountId: ACCOUNT, region: 'us-east-1', partition: 'aws' });
  resetEMRClusterCreateRetryStateForTests();
  resetEMRInstanceGroupCreateRetryStateForTests();
  resetEMRInstanceFleetCreateRetryStateForTests();
  resetIdempotencyTokensForTests();
});

const SSM = 'AWS::SSM::Parameter';
const SSM_PROPS = { Name: '/app/p', Type: 'String', Value: 'v' };

type Case = { wrap: string; logicalId: string; run: () => Promise<unknown> };

const ssmCases: Case[] = [
  {
    wrap: 'Failed to create SSM parameter P',
    logicalId: 'P',
    run: () => new SSMParameterProvider().create('P', SSM, SSM_PROPS, ctx),
  },
  {
    wrap: 'Failed to update SSM parameter P',
    logicalId: 'P',
    run: () =>
      new SSMParameterProvider().update(
        'P',
        '/app/p',
        SSM,
        { ...SSM_PROPS, Value: 'v2' },
        SSM_PROPS,
        ctx
      ),
  },
  {
    wrap: 'Failed to delete SSM parameter P',
    logicalId: 'P',
    run: () => new SSMParameterProvider().delete('P', '/app/p', SSM, SSM_PROPS, ctx),
  },
];

describe('SSM parameter thrown wraps withhold AWS text (#2319)', () => {
  it.each(ssmCases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    const rejection = denied();
    // Positive control: the fake carries the caller's identity.
    expect(rejection.message).toContain(`${ACCOUNT}:assumed-role`);
    mockSend.mockRejectedValue(rejection);

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(failure.message).not.toContain('not authorized');
    expect(failure.cause).toBe(rejection);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  // The class itself is AWS-authored: `mask(failure.summary)` keeps a secret
  // spelled inside it out of the thrown (persisted) message.
  it.each(ssmCases)('$wrap: a secret spelled in the class is masked', async (c) => {
    mockSend.mockRejectedValue(awsError('Denieds3cr3tException', 'denied'));

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: Denied***Exception. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(ssmCases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    mockSend.mockRejectedValue(new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(ssmCases)('$wrap: a cdkd-authored failure the mask leaves alone is not stamped', async (c) => {
    mockSend.mockRejectedValue(new Error('socket hang up'));

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each(ssmCases)('$wrap: a non-Error throw is withheld, unstamped', async (c) => {
    mockSend.mockRejectedValue('raw s3cr3t value');

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: a non-Error value of type string. ${VERBOSE_POINTER}`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // A ConflictException matches no collision pattern by its class, so only the
  // restatement keeps a create-first replacement recognising a taken name.
  it.each(ssmCases)('$wrap: restates an "already exists" the class does not carry', async (c) => {
    mockSend.mockRejectedValue(
      awsError('ConflictException', `Parameter /app/p already exists in ${ACCOUNT}.`)
    );

    const failure = await caught(c.run());

    expect(failure.message).toBe(
      `${c.wrap}: ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain(ACCOUNT);
    expect(isNameCollisionErrorFrom(failure, c.logicalId)).toBe(true);
  });
});

const KINESIS = 'AWS::Kinesis::Stream';
const TRAIL = 'AWS::CloudTrail::Trail';
const TRAIL_ARN = `arn:aws:cloudtrail:us-east-1:${ACCOUNT}:trail/t`;
const FSX = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';

/**
 * A delete wrap naming a FOREIGN NotFound by its class spells `NotFound`, which
 * the delete classifiers read as "already deleted"; the mark keeps the record
 * (only the typed not-found means gone).
 */
const deleteCases: Array<Case & { prime: (rejection: unknown) => void }> = [
  {
    wrap: 'Failed to delete SSM parameter P',
    logicalId: 'P',
    run: () => new SSMParameterProvider().delete('P', '/app/p', SSM, SSM_PROPS, ctx),
    prime: (r) => mockSend.mockRejectedValue(r),
  },
  {
    wrap: 'Failed to delete Kinesis stream S',
    logicalId: 'S',
    run: () => new KinesisStreamProvider().delete('S', 's', KINESIS, undefined, ctx),
    prime: (r) => mockSend.mockRejectedValue(r),
  },
  {
    wrap: 'Failed to delete CloudTrail Trail T',
    logicalId: 'T',
    run: () => new CloudTrailProvider().delete('T', TRAIL_ARN, TRAIL, undefined, ctx),
    // StopLogging's failure is swallowed; DeleteTrail is the wrapped call.
    prime: (r) => route({ DeleteTrailCommand: r }),
  },
  {
    wrap: 'Failed to delete FSx FileSystem F',
    logicalId: 'F',
    run: () => new FSxFileSystemProvider(poll).delete('F', FS_ID, FSX, undefined, ctx),
    prime: (r) => route({ DeleteFileSystemCommand: r }),
  },
  {
    wrap: `Failed to poll FSx FileSystem ${FS_ID} deletion`,
    logicalId: 'F',
    run: () => new FSxFileSystemProvider(poll).delete('F', FS_ID, FSX, undefined, ctx),
    prime: (r) => route({ DescribeFileSystemsCommand: r }),
  },
];

describe('a delete wrap naming a foreign NotFound is marked not gone (#2319)', () => {
  it.each(deleteCases)('$wrap: a foreign NotFound is marked not gone', async (c) => {
    c.prime(awsError('KMSNotFoundException', `Key arn:aws:kms:us-east-1:${ACCOUNT}:key/k`));

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: KMSNotFoundException. ${VERBOSE_POINTER}`);
    expect(isMarkedNotGone(failure)).toBe(true);
  });

  // StopLogging went through first, so the delete is also marked started; the
  // two marks are stamped on the same wrap and both must survive.
  it('CloudTrail: a foreign NotFound after StopLogging keeps both marks', async () => {
    route({
      DeleteTrailCommand: awsError('KMSNotFoundException', `Key arn:aws:kms:us-east-1:${ACCOUNT}:key/k`),
    });

    const failure = await caught(
      new CloudTrailProvider().delete('T', TRAIL_ARN, TRAIL, undefined, ctx)
    );

    expect(failure.message).toBe(
      `Failed to delete CloudTrail Trail T: KMSNotFoundException. ${VERBOSE_POINTER}`
    );
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isDeleteStarted(failure)).toBe(true);
  });

  it.each(deleteCases)('$wrap: a failure that is not a NotFound is not marked', async (c) => {
    c.prime(denied());

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: AccessDenied. ${VERBOSE_POINTER}`);
    expect(isMarkedNotGone(failure)).toBe(false);
  });
});

/**
 * An "already exists" from a step AFTER the resource was created is an
 * auxiliary object's, not this resource's (#3826): the wrap does not restate it
 * ("it" would read as this resource). The same rejection from the create call
 * itself is still restated.
 */
const TAKEN = (): Error =>
  awsError('ConflictException', `A resource named x already exists in ${ACCOUNT}.`);
const auxCases: Array<{
  wrap: string;
  logicalId: string;
  run: () => Promise<unknown>;
  /** The create call itself fails. */
  atCreate: (rejection: unknown) => void;
  /** A wiring step after the create call returned fails. */
  afterCreate: (rejection: unknown) => void;
}> = [
  {
    wrap: 'Failed to create Kinesis stream S',
    logicalId: 'S',
    run: () =>
      new KinesisStreamProvider().create('S', KINESIS, { Name: 's', ShardCount: 1 }, ctx),
    atCreate: (r) => mockSend.mockRejectedValue(r),
    afterCreate: (r) =>
      mockSend.mockImplementation(async (command: unknown) => {
        if (commandName(command) === 'CreateStreamCommand') return {};
        throw r;
      }),
  },
  {
    wrap: 'Failed to create CloudTrail Trail T',
    logicalId: 'T',
    run: () => new CloudTrailProvider().create('T', TRAIL, { TrailName: 't', S3BucketName: 'b' }, ctx),
    atCreate: (r) => mockSend.mockRejectedValue(r),
    afterCreate: (r) =>
      route({ StartLoggingCommand: r }, { CreateTrailCommand: { TrailARN: TRAIL_ARN } }),
  },
  {
    wrap: 'Failed to create IAM user U',
    logicalId: 'U',
    run: () =>
      new IAMUserGroupProvider().create(
        'U',
        'AWS::IAM::User',
        { UserName: 'u', ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
        ctx
      ),
    atCreate: (r) => mockSend.mockRejectedValue(r),
    afterCreate: (r) =>
      route(
        { AttachUserPolicyCommand: r },
        { CreateUserCommand: { User: { Arn: `arn:aws:iam::${ACCOUNT}:user/u`, UserId: 'AIDA1' } } }
      ),
  },
  {
    wrap: 'Failed to create IAM group G',
    logicalId: 'G',
    run: () =>
      new IAMUserGroupProvider().create(
        'G',
        'AWS::IAM::Group',
        { GroupName: 'g', ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
        ctx
      ),
    atCreate: (r) => mockSend.mockRejectedValue(r),
    afterCreate: (r) =>
      route(
        { AttachGroupPolicyCommand: r },
        { CreateGroupCommand: { Group: { Arn: `arn:aws:iam::${ACCOUNT}:group/g`, GroupId: 'AGPA1' } } }
      ),
  },
];

describe('an auxiliary "already exists" is not restated as a collision (#2319, #3826)', () => {
  it.each(auxCases)('$wrap: a wiring step\'s "already exists" is not restated', async (c) => {
    c.afterCreate(TAKEN());

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: ConflictException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isNameCollisionErrorFrom(failure, c.logicalId)).toBe(false);
  });

  it.each(auxCases)('$wrap: the create call\'s own "already exists" is restated', async (c) => {
    c.atCreate(TAKEN());

    const failure = await caught(c.run());

    expect(failure.message).toBe(
      `${c.wrap}: ConflictException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(isNameCollisionErrorFrom(failure, c.logicalId)).toBe(true);
  });
});

const CLUSTER = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const CLUSTER_PROPS = {
  Name: 'c',
  ReleaseLabel: 'emr-7.2.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Instances: {
    Ec2SubnetId: 'subnet-abc',
    MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.xlarge', Name: 'Master' },
  },
};
const GROUP = 'AWS::EMR::InstanceGroupConfig';
const GROUP_PROPS = {
  JobFlowId: 'j-CLUSTER',
  InstanceRole: 'TASK',
  InstanceType: 'm5.xlarge',
  InstanceCount: 1,
};
const FLEET = 'AWS::EMR::InstanceFleetConfig';
const FLEET_PROPS = {
  ClusterId: 'j-CLUSTER',
  InstanceFleetType: 'TASK',
  TargetOnDemandCapacity: 1,
  InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge' }],
};
const FSX_PROPS = {
  FileSystemType: 'LUSTRE',
  StorageCapacity: 1200,
  SubnetIds: ['subnet-111'],
  LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
};

/**
 * A best-effort cleanup / delete warn: `prime` makes the cleanup call reject
 * with `rejection` (and, for a partial create, an earlier step fail first).
 */
const warnCases: Array<{
  head: string;
  run: () => Promise<unknown>;
  prime: (rejection: unknown) => void;
}> = [
  {
    head: 'Could not build the Arn attribute for SSM parameter /app/p: ',
    run: () => new SSMParameterProvider().create('P', SSM, SSM_PROPS, ctx),
    prime: (r) => accountInfo.mockRejectedValue(r),
  },
  {
    head: 'Failed to clean up partially-created IAM user U (u): ',
    run: () =>
      new IAMUserGroupProvider().create(
        'U',
        'AWS::IAM::User',
        { UserName: 'u', ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
        ctx
      ),
    prime: (r) =>
      route(
        { AttachUserPolicyCommand: new Error('attach boom'), ListGroupsForUserCommand: r },
        { CreateUserCommand: { User: { Arn: `arn:aws:iam::${ACCOUNT}:user/u`, UserId: 'AIDA1' } } }
      ),
  },
  {
    head: 'Failed to clean up partially-created IAM group G (g): ',
    run: () =>
      new IAMUserGroupProvider().create(
        'G',
        'AWS::IAM::Group',
        { GroupName: 'g', ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
        ctx
      ),
    prime: (r) =>
      route(
        { AttachGroupPolicyCommand: new Error('attach boom'), ListAttachedGroupPoliciesCommand: r },
        { CreateGroupCommand: { Group: { Arn: `arn:aws:iam::${ACCOUNT}:group/g`, GroupId: 'AGPA1' } } }
      ),
  },
  {
    head: `Failed to roll back partially-created FSx FileSystem ${FS_ID}: `,
    run: () => new FSxFileSystemProvider(poll).create('F', FSX, { ...FSX_PROPS }, ctx),
    prime: (r) =>
      route(
        { DescribeFileSystemsCommand: new Error('poll boom'), DeleteFileSystemCommand: r },
        { CreateFileSystemCommand: { FileSystem: { FileSystemId: FS_ID, CreationTime: new Date() } } }
      ),
  },
  {
    head: `Failed to roll back partially-created EMR Cluster ${CLUSTER_ID}: `,
    run: () => new EMRClusterProvider(poll).create('C', CLUSTER, { ...CLUSTER_PROPS }, ctx),
    prime: (r) =>
      route(
        { DescribeClusterCommand: new Error('poll boom'), SetTerminationProtectionCommand: r },
        { RunJobFlowCommand: { JobFlowId: CLUSTER_ID } }
      ),
  },
  {
    head: 'Failed to scale partially-created EMR TASK instance group G (ig-ABC123) to 0: ',
    run: () => new EMRInstanceGroupConfigProvider(poll).create('G', GROUP, { ...GROUP_PROPS }, ctx),
    prime: (r) =>
      route(
        { ListInstanceGroupsCommand: new Error('poll boom'), ModifyInstanceGroupsCommand: r },
        { AddInstanceGroupsCommand: { InstanceGroupIds: ['ig-ABC123'] } }
      ),
  },
  {
    head: 'Best-effort scale-to-0 of EMR instance group ig-ABC123 failed: ',
    run: () =>
      new EMRInstanceGroupConfigProvider(poll).delete('G', 'ig-ABC123', GROUP, { ...GROUP_PROPS }, ctx),
    prime: (r) => route({ ModifyInstanceGroupsCommand: r }),
  },
  {
    head: 'Best-effort scale-to-0 of EMR instance fleet if-ABC123 failed: ',
    run: () =>
      new EMRInstanceFleetConfigProvider(poll).delete('Fl', 'if-ABC123', FLEET, { ...FLEET_PROPS }, ctx),
    prime: (r) => route({ ModifyInstanceFleetCommand: r }),
  },
];

/** Run a warn case to completion, swallowing the create's own (unrelated) failure. */
async function settle(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // The partial create rethrows its original failure; only the warn is read.
  }
}

describe('a best-effort cleanup warn names an AWS failure by its class (#2319)', () => {
  it.each(warnCases)('$head: the class at warn, the masked text at debug', async (c) => {
    const rejection = denied();
    expect(rejection.message).toContain(`${ACCOUNT}:assumed-role`);
    c.prime(rejection);

    await settle(c.run);

    const line = warnLines().find((l) => l.startsWith(c.head));
    expect(line, warnLines().join('\n')).toBeDefined();
    expect(line!.startsWith(`${c.head}AccessDenied. ${VERBOSE_POINTER}`)).toBe(true);
    expect(warnLines().join('\n')).not.toContain(ACCOUNT);
    expect(warnLines().join('\n')).not.toContain('not authorized');
    expect(debugLines()).toContain(`${c.head}${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(warnCases)('$head: a secret spelled in the class is masked at warn', async (c) => {
    c.prime(awsError('Denieds3cr3tException', 'denied'));

    await settle(c.run);

    const line = warnLines().find((l) => l.startsWith(c.head));
    expect(line!.startsWith(`${c.head}Denied***Exception. ${VERBOSE_POINTER}`)).toBe(true);
    expect(warnLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(warnCases)('$head: a cdkd-authored failure keeps its text, masked', async (c) => {
    c.prime(new Error('socket hang up near s3cr3t'));

    await settle(c.run);

    const line = warnLines().find((l) => l.startsWith(c.head));
    expect(line!.startsWith(`${c.head}socket hang up near ***`)).toBe(true);
    expect(line).not.toContain(VERBOSE_POINTER);
    expect(debugLines().some((l) => l.startsWith(c.head))).toBe(false);
  });

  // The cluster is gone, so the delete succeeds; AWS's state-change reason
  // names the role ARN and account on a validation failure.
  it('a TERMINATED_WITH_ERRORS reason is named by its code at warn', async () => {
    const reasonText = `Service role arn:aws:iam::${ACCOUNT}:role/s3cr3t is invalid`;
    let describes = 0;
    route(
      {},
      {
        DescribeClusterCommand: () =>
          ++describes === 1
            ? { Cluster: { Id: CLUSTER_ID, Status: { State: 'RUNNING' } } }
            : {
                Cluster: {
                  Id: CLUSTER_ID,
                  Status: {
                    State: 'TERMINATED_WITH_ERRORS',
                    StateChangeReason: { Code: 'VALIDATION_ERROR', Message: reasonText },
                  },
                },
              },
      }
    );

    await new EMRClusterProvider(poll).delete('C', CLUSTER_ID, CLUSTER, undefined, ctx);

    const head = `EMR Cluster ${CLUSTER_ID} terminated with errors: `;
    expect(warnLines()).toContain(
      `${head}VALIDATION_ERROR. ${VERBOSE_POINTER} (the cluster is gone and no longer bills)`
    );
    expect(warnLines().join('\n')).not.toContain(ACCOUNT);
    expect(debugLines()).toContain(`${head}${mask(reasonText)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it('a TERMINATED_WITH_ERRORS reason with no code is the pointer alone at warn', async () => {
    const reasonText = `Service role arn:aws:iam::${ACCOUNT}:role/s3cr3t is invalid`;
    let describes = 0;
    route(
      {},
      {
        DescribeClusterCommand: () => ({
          Cluster: {
            Id: CLUSTER_ID,
            Status:
              ++describes === 1
                ? { State: 'RUNNING' }
                : { State: 'TERMINATED_WITH_ERRORS', StateChangeReason: { Message: reasonText } },
          },
        }),
      }
    );

    await new EMRClusterProvider(poll).delete('C', CLUSTER_ID, CLUSTER, undefined, ctx);

    expect(warnLines()).toContain(
      `EMR Cluster ${CLUSTER_ID} terminated with errors: ${VERBOSE_POINTER} (the cluster is gone and no longer bills)`
    );
    expect(warnLines().join('\n')).not.toContain(ACCOUNT);
  });

  it('a TERMINATED_WITH_ERRORS with no reason keeps cdkd\'s fallback', async () => {
    let describes = 0;
    route(
      {},
      {
        DescribeClusterCommand: () => ({
          Cluster: {
            Id: CLUSTER_ID,
            Status: { State: ++describes === 1 ? 'RUNNING' : 'TERMINATED_WITH_ERRORS' },
          },
        }),
      }
    );

    await new EMRClusterProvider(poll).delete('C', CLUSTER_ID, CLUSTER, undefined, ctx);

    expect(warnLines()).toContain(
      `EMR Cluster ${CLUSTER_ID} terminated with errors: no state-change reason reported (the cluster is gone and no longer bills)`
    );
  });
});

/**
 * CloudTrail's EventSelectors reset tolerates AWS's advanced-event-selector
 * rejection, matched on AWS's text. That text is AWS-authored, so it is named
 * by its class at warn; and the trail's own name / ARN is cut out before the
 * match, so a denial quoting a trail NAMED after the phrase still fails.
 */
describe('CloudTrail EventSelectors reset tolerance (#2319)', () => {
  const ADV_ARN = `arn:aws:cloudtrail:us-east-1:${ACCOUNT}:trail/advanced-event-selector-audit`;
  const reset = (arn: string): Promise<unknown> =>
    new CloudTrailProvider().update(
      'T',
      arn,
      TRAIL,
      { S3BucketName: 'b' },
      { S3BucketName: 'b', EventSelectors: [{ ReadWriteType: 'WriteOnly' }] },
      ctx
    );

  it('names an AWS-authored advanced-selector rejection by its class at warn', async () => {
    const text = `This trail uses advanced event selectors (s3cr3t), account ${ACCOUNT}`;
    route({ PutEventSelectorsCommand: awsError('InvalidEventSelectorsException', text) });

    await reset(TRAIL_ARN);

    const head = 'CloudTrail Trail T: skipping the EventSelectors reset';
    const line = warnLines().find((l) => l.startsWith(head));
    expect(line).toBe(
      `${head} — the trail is using AdvancedEventSelectors, which AWS manages through a ` +
        `separate API, so there are no basic event selectors to clear ` +
        `(InvalidEventSelectorsException. ${VERBOSE_POINTER})`
    );
    expect(warnLines().join('\n')).not.toContain(ACCOUNT);
    expect(debugLines().some((l) => l.startsWith(head) && l.includes(mask(text)))).toBe(true);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it('a denial quoting a trail named after the phrase is not swallowed', async () => {
    const text = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s is not authorized to perform: cloudtrail:PutEventSelectors on resource: ${ADV_ARN}`;
    // Positive control: the denial's own text matches the tolerance's wording.
    expect(/advanced[\s-]*event[\s-]*selector/i.test(text)).toBe(true);
    route({ PutEventSelectorsCommand: awsError('AccessDeniedException', text) });

    const failure = await caught(reset(ADV_ARN));

    expect(failure.message).toBe(
      `Failed to update CloudTrail Trail T: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(warnLines().some((l) => l.includes('skipping the EventSelectors reset'))).toBe(false);
  });
});
