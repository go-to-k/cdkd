import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vite-plus/test';

/**
 * The EMR, FSx and EFS wraps must not write the CALLER'S IDENTITY into a
 * persisted store (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and these services word an access denial as
 * `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
 * to perform: ...`. Each AWS fixture here carries that wording and the smithy
 * service markers `describeAwsFailure` keys on. Both polarities: an
 * AWS-authored failure is named by its class with `cause` kept (so the retry
 * classifiers still read it), and a cdkd-authored or transport failure keeps
 * its own text.
 */

const { mockSend, debugSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debugSpy: vi.fn(),
    fakeClient: () => ({
      send: (command: unknown) => send(command),
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: () => Promise.resolve(undefined),
      },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
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
vi.mock('@aws-sdk/client-efs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-efs')>();
  return { ...actual, EFSClient: vi.fn().mockImplementation(fakeClient) };
});
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

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
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import {
  allowUnscopedCreateTokensForTests,
  resetIdempotencyTokensForTests,
} from '../../../src/provisioning/providers/idempotency-token.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

// The FSx and EFS creates run outside a withStackName scope, so the
// stack-scoped create token (go-to-k/cdkd#4428) is opted out of its guard.
beforeAll(() => allowUnscopedCreateTokensForTests(true));
afterAll(() => allowUnscopedCreateTokensForTests(false));

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** An access denial as these services word it, AWS-authored. */
function accessDenied(name: string, action: string): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:${action.split(':')[0]}:us-east-1:${CALLER_ACCOUNT}:x because no ` +
        `identity-based policy allows the ${action} action`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

function awsError(name: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/**
 * Fail the `nth` (1-based) send of `failing` with `error`; every other send
 * answers `answers[name]` (a function is called per send) or `{}`.
 */
function failOn(
  failing: string,
  error: unknown,
  answers: Record<string, unknown> = {},
  nth = 1
): void {
  let seen = 0;
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === failing && ++seen === nth) throw error;
    const answer = answers[name];
    return typeof answer === 'function' ? (answer as () => unknown)() : (answer ?? {});
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');

const MASK = (text: string): string => text.split('emr-fsx-efs-secret').join('***');

const CLUSTER = 'AWS::EMR::Cluster';
const CLUSTER_ID = 'j-1A2B3C4D5E6F7';
const CLUSTER_PROPS = {
  Name: 'my-emr-cluster',
  ReleaseLabel: 'emr-7.2.0',
  ServiceRole: 'EMR_DefaultRole',
  JobFlowRole: 'EMR_EC2_DefaultRole',
  Instances: {
    Ec2SubnetId: 'subnet-abc',
    MasterInstanceGroup: { InstanceCount: 1, InstanceType: 'm5.xlarge', Name: 'Master' },
  },
};
const RUNNING_CLUSTER = {
  Cluster: { Id: CLUSTER_ID, Name: 'my-emr-cluster', Status: { State: 'RUNNING' } },
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

const FSX = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';
const FSX_PROPS = {
  FileSystemType: 'LUSTRE',
  StorageCapacity: 1200,
  SubnetIds: ['subnet-111'],
  LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
};
const AVAILABLE_FS = {
  FileSystems: [
    { FileSystemId: FS_ID, Lifecycle: 'AVAILABLE', FileSystemType: 'LUSTRE', StorageCapacity: 1200 },
  ],
};

type Site = {
  site: string;
  command: string;
  /** The error class the denial carries, the service's own. */
  name: string;
  /** The IAM action the denial names, the site's own. */
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  /** Which send of `command` fails (default: the first). */
  nth?: number;
  /** `ctx` is the operation's context, threaded as its last argument. */
  run: (ctx?: { maskSecrets: (text: string) => string }) => Promise<unknown>;
};

function sites(): Site[] {
  const poll = { pollIntervalMs: 0, maxWaitMs: 5000 };
  const cluster = new EMRClusterProvider(poll);
  const group = new EMRInstanceGroupConfigProvider(poll);
  const fleet = new EMRInstanceFleetConfigProvider(poll);
  const fsx = new FSxFileSystemProvider(poll);
  const efs = new EFSProvider();
  return [
    {
      site: 'EMR create Cluster',
      command: 'RunJobFlowCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:RunJobFlow',
      prefix: 'Failed to create EMR Cluster Res: ',
      run: (ctx) => cluster.create('Res', CLUSTER, { ...CLUSTER_PROPS }, ctx),
    },
    {
      site: 'EMR update Cluster',
      command: 'ModifyClusterCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:ModifyCluster',
      prefix: 'Failed to update EMR Cluster Res: ',
      run: (ctx) =>
        cluster.update(
          'Res',
          CLUSTER_ID,
          CLUSTER,
          { ...CLUSTER_PROPS, StepConcurrencyLevel: 2 },
          { ...CLUSTER_PROPS, StepConcurrencyLevel: 1 }, ctx),
    },
    {
      site: 'EMR delete Cluster describe',
      command: 'DescribeClusterCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:DescribeCluster',
      prefix: 'Failed to describe EMR Cluster Res before deletion: ',
      run: (ctx) => cluster.delete('Res', CLUSTER_ID, CLUSTER, undefined, ctx),
    },
    {
      site: 'EMR delete Cluster terminate',
      command: 'TerminateJobFlowsCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:TerminateJobFlows',
      prefix: 'Failed to terminate EMR Cluster Res: ',
      answers: { DescribeClusterCommand: RUNNING_CLUSTER },
      run: (ctx) => cluster.delete('Res', CLUSTER_ID, CLUSTER, undefined, ctx),
    },
    {
      site: 'EMR delete Cluster termination poll',
      command: 'DescribeClusterCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:DescribeCluster',
      prefix: `Failed to poll EMR Cluster ${CLUSTER_ID} termination: `,
      answers: { DescribeClusterCommand: RUNNING_CLUSTER },
      nth: 2,
      run: (ctx) => cluster.delete('Res', CLUSTER_ID, CLUSTER, undefined, ctx),
    },
    {
      site: 'EMR create InstanceGroupConfig',
      command: 'AddInstanceGroupsCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:AddInstanceGroups',
      prefix: 'Failed to add EMR instance group Res: ',
      run: (ctx) => group.create('Res', GROUP, { ...GROUP_PROPS }, ctx),
    },
    {
      site: 'EMR update InstanceGroupConfig',
      command: 'ModifyInstanceGroupsCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:ModifyInstanceGroups',
      prefix: 'Failed to update EMR instance group Res: ',
      run: (ctx) =>
        group.update('Res', 'ig-ABC123', GROUP, { ...GROUP_PROPS, InstanceCount: 2 }, GROUP_PROPS, ctx),
    },
    {
      site: 'EMR create InstanceFleetConfig',
      command: 'AddInstanceFleetCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:AddInstanceFleet',
      prefix: 'Failed to add EMR instance fleet Res: ',
      run: (ctx) => fleet.create('Res', FLEET, { ...FLEET_PROPS }, ctx),
    },
    {
      site: 'EMR update InstanceFleetConfig',
      command: 'ModifyInstanceFleetCommand',
      name: 'AccessDeniedException',
      action: 'elasticmapreduce:ModifyInstanceFleet',
      prefix: 'Failed to update EMR instance fleet Res: ',
      run: (ctx) =>
        fleet.update(
          'Res',
          'if-ABC123',
          FLEET,
          { ...FLEET_PROPS, TargetOnDemandCapacity: 2 },
          FLEET_PROPS, ctx),
    },
    {
      site: 'FSx create FileSystem',
      command: 'CreateFileSystemCommand',
      name: 'AccessDenied',
      action: 'fsx:CreateFileSystem',
      prefix: 'Failed to create FSx FileSystem Res: ',
      run: (ctx) => fsx.create('Res', FSX, { ...FSX_PROPS }, ctx),
    },
    {
      site: 'FSx update FileSystem',
      command: 'UpdateFileSystemCommand',
      name: 'AccessDenied',
      action: 'fsx:UpdateFileSystem',
      prefix: 'Failed to update FSx FileSystem Res: ',
      answers: { DescribeFileSystemsCommand: AVAILABLE_FS },
      run: (ctx) =>
        fsx.update('Res', FS_ID, FSX, { ...FSX_PROPS, StorageCapacity: 2400 }, { ...FSX_PROPS }, ctx),
    },
    {
      site: 'FSx delete FileSystem',
      command: 'DeleteFileSystemCommand',
      name: 'AccessDenied',
      action: 'fsx:DeleteFileSystem',
      prefix: 'Failed to delete FSx FileSystem Res: ',
      answers: { DescribeFileSystemsCommand: AVAILABLE_FS },
      run: (ctx) => fsx.delete('Res', FS_ID, FSX, undefined, ctx),
    },
    {
      site: 'FSx delete FileSystem deletion poll',
      command: 'DescribeFileSystemsCommand',
      name: 'AccessDenied',
      action: 'fsx:DescribeFileSystems',
      prefix: `Failed to poll FSx FileSystem ${FS_ID} deletion: `,
      answers: { DescribeFileSystemsCommand: AVAILABLE_FS },
      run: (ctx) => fsx.delete('Res', FS_ID, FSX, undefined, ctx),
    },
    {
      site: 'EFS create FileSystem',
      command: 'CreateFileSystemCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:CreateFileSystem',
      prefix: 'Failed to create EFS FileSystem Res: ',
      run: (ctx) => efs.create('Res', 'AWS::EFS::FileSystem', {}, ctx),
    },
    {
      site: 'EFS update FileSystem',
      command: 'UpdateFileSystemCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:UpdateFileSystem',
      prefix: 'Failed to update EFS FileSystem Res: ',
      run: (ctx) =>
        efs.update(
          'Res',
          FS_ID,
          'AWS::EFS::FileSystem',
          { ThroughputMode: 'elastic' },
          { ThroughputMode: 'bursting' }, ctx),
    },
    {
      site: 'EFS delete FileSystem',
      command: 'DeleteFileSystemCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:DeleteFileSystem',
      prefix: 'Failed to delete EFS FileSystem Res: ',
      run: (ctx) => efs.delete('Res', FS_ID, 'AWS::EFS::FileSystem', undefined, ctx),
    },
    {
      site: 'EFS create MountTarget',
      command: 'CreateMountTargetCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:CreateMountTarget',
      prefix: 'Failed to create EFS MountTarget Res: ',
      run: (ctx) =>
        efs.create('Res', 'AWS::EFS::MountTarget', {
          FileSystemId: FS_ID,
          SubnetId: 'subnet-0123456789abcdef0',
        }, ctx),
    },
    {
      site: 'EFS update MountTarget',
      command: 'ModifyMountTargetSecurityGroupsCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:ModifyMountTargetSecurityGroups',
      prefix: 'Failed to update EFS MountTarget Res: ',
      run: (ctx) =>
        efs.update('Res', 'fsmt-0123456789abcdef0', 'AWS::EFS::MountTarget', {
          SecurityGroups: ['sg-1'],
        }, {}, ctx),
    },
    {
      site: 'EFS delete MountTarget',
      command: 'DeleteMountTargetCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:DeleteMountTarget',
      prefix: 'Failed to delete EFS MountTarget Res: ',
      run: (ctx) => efs.delete('Res', 'fsmt-0123456789abcdef0', 'AWS::EFS::MountTarget', undefined, ctx),
    },
    {
      site: 'EFS create AccessPoint',
      command: 'CreateAccessPointCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:CreateAccessPoint',
      prefix: 'Failed to create EFS AccessPoint Res: ',
      run: (ctx) => efs.create('Res', 'AWS::EFS::AccessPoint', { FileSystemId: FS_ID }, ctx),
    },
    {
      site: 'EFS delete AccessPoint',
      command: 'DeleteAccessPointCommand',
      name: 'AccessDeniedException',
      action: 'elasticfilesystem:DeleteAccessPoint',
      prefix: 'Failed to delete EFS AccessPoint Res: ',
      run: (ctx) => efs.delete('Res', 'fsap-0123456789abcdef0', 'AWS::EFS::AccessPoint', undefined, ctx),
    },
  ];
}

describe('EMR / FSx / EFS thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    resetEMRClusterCreateRetryStateForTests();
    resetEMRInstanceGroupCreateRetryStateForTests();
    resetEMRInstanceFleetCreateRetryStateForTests();
    resetIdempotencyTokensForTests();
  });

  describe.each(sites())('$site', ({ command, name, action, prefix, answers, nth, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, and stays retryable', async () => {
      const original = accessDenied(name, action);
      failOn(command, original, answers, nth);
      const failure = await thrown(run());

      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.filter(([c]) => commandName(c) === command).length).toBe(
        nth ?? 1
      );
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toContain(`${prefix}${name}. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.message).not.toContain(CALLER_ROLE);
      expect(failure.message).not.toContain(CALLER_SESSION);
      expect(failure.cause).toBe(original);

      // The withheld `not authorized to perform` still reaches the classifier.
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);

      // AWS's own text is logged at debug, never only dropped.
      expect(debugged()).toContain(`${prefix}User: ${CALLER_ARN} is not authorized`);
    });

    it("masks AWS's text on the debug line through the operation's own maskSecrets", async () => {
      const original = awsError(
        'ValidationException',
        "Value 'emr-fsx-efs-secret' at 'request' failed to satisfy constraint"
      );
      failOn(command, original, answers, nth);
      const failure = await thrown(run({ maskSecrets: MASK }));

      expect(failure.message).toContain(`${prefix}ValidationException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain('emr-fsx-efs-secret');
      expect(debugged()).toContain("Value '***' at 'request' failed to satisfy constraint");
      expect(debugged()).not.toContain('emr-fsx-efs-secret');
    });

    it('restates an "already exists" so a name collision is still recognised', async () => {
      const original = awsError(
        'ValidationException',
        `A resource named Res already exists in account ${CALLER_ACCOUNT}`
      );
      failOn(command, original, answers, nth);
      const failure = await thrown(run());

      expect(failure.message).toContain(
        `${prefix}ValidationException. ${VERBOSE_POINTER} AWS reports that it already exists.`
      );
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    });

    it('keeps a cdkd-authored or transport failure verbatim, unstamped', async () => {
      const original = new Error('connect ECONNREFUSED 10.0.0.1:443');
      failOn(command, original, answers, nth);
      const failure = await thrown(run());

      expect(mockSend.mock.calls.filter(([c]) => commandName(c) === command).length).toBe(
        nth ?? 1
      );
      expect(failure.message).toContain(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
      expect(failure.cause).toBe(original);
    });

    it('keeps a non-Error throw as text, unstamped', async () => {
      // Not `socket hang up`: the two termination polls absorb that as transient.
      failOn(command, 'unexpected reply', answers, nth);
      const failure = await thrown(run());

      expect(failure.message).toContain(`${prefix}unexpected reply`);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });
  });

  describe.each(sites().filter(({ site }) => site.startsWith('EFS delete')))(
    '$site',
    ({ command, prefix, run }) => {
      it("masks a non-AWS error's text in the message through DeleteContext.maskSecrets", async () => {
        failOn(command, new Error("socket to 'emr-fsx-efs-secret' closed"));
        const failure = await thrown(run({ maskSecrets: MASK }));

        expect(failure.message).toContain(`${prefix}socket to '***' closed`);
        expect(failure.message).not.toContain('emr-fsx-efs-secret');
        expect(failure.message).not.toContain(VERBOSE_POINTER);
        // The mask changed the text, so the wrap is stamped (#4244).
        expect(hasRedactedCause(failure)).toBe(true);
      });
    }
  );

  it('restates an "already exists" so a name collision is still recognised', async () => {
    const original = awsError(
      'ValidationException',
      `Instance group already exists for cluster j-CLUSTER owned by ${CALLER_ACCOUNT}`
    );
    failOn('AddInstanceGroupsCommand', original);
    const failure = await thrown(
      new EMRInstanceGroupConfigProvider().create('Res', GROUP, { ...GROUP_PROPS })
    );
    expect(failure.message).toContain(
      `ValidationException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
  });

  it('masks the debug line through the create context, both raw and finished', async () => {
    const original = awsError(
      'ValidationException',
      "Subnet 'emr-fsx-efs-secret' is not in the cluster's VPC"
    );
    failOn('RunJobFlowCommand', original);
    const failure = await thrown(
      new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: 5000 }).create(
        'Res',
        CLUSTER,
        { ...CLUSTER_PROPS },
        { maskSecrets: MASK }
      )
    );
    expect(failure.message).toContain(`ValidationException. ${VERBOSE_POINTER}`);
    expect(debugged()).toContain("Subnet '***' is not in the cluster's VPC");
    expect(debugged()).not.toContain('emr-fsx-efs-secret');
  });

  it('keeps the #4945 terminal mark and the #4583 survivor on a redacted EMR create wrap', async () => {
    // RunJobFlow returns, the readiness wait fails, and the rollback terminate
    // fails too: the wrap must still be the class + pointer, marked terminal,
    // and name the surviving cluster for the failed-CREATE journal.
    const original = accessDenied('AccessDeniedException', 'elasticmapreduce:DescribeCluster');
    mockSend.mockImplementation(async (command: unknown) => {
      const n = commandName(command);
      if (n === 'RunJobFlowCommand') return { JobFlowId: CLUSTER_ID };
      if (n === 'DescribeClusterCommand') throw original;
      if (n === 'TerminateJobFlowsCommand') throw new Error('terminate refused');
      return {};
    });
    const failure = await thrown(
      new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs: 5000 }).create('Res', CLUSTER, {
        ...CLUSTER_PROPS,
      })
    );
    expect(failure.message).toContain(
      `Failed to create EMR Cluster Res: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain(CALLER_ACCOUNT);
    expect(isMarkedNonRetryable(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Res', CLUSTER)).toBe(CLUSTER_ID);
  });
});
