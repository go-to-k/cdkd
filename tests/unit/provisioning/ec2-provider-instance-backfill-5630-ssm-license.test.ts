import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeInstancesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  AssociateIamInstanceProfileCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';
import {
  CreateAssociationCommand,
  DeleteAssociationCommand,
  DescribeAssociationCommand,
  ListAssociationsCommand,
} from '@aws-sdk/client-ssm';

// go-to-k/cdkd#5630 (fifth slice): AWS::EC2::Instance LicenseSpecifications and
// SsmAssociations. CloudFormation measured (us-east-1, CloudTrail-verified):
//  - LicenseSpecifications rides on RunInstances; adding, changing or removing
//    one replaces the instance (schema create-only too). DescribeInstances
//    reports no `Licenses` for a licensed instance, so drift cannot read it.
//  - SsmAssociations: RunInstances, then the instance-id form of
//    CreateAssociation { Name, InstanceId, Parameters }; read back through
//    ListAssociations(InstanceId) + DescribeAssociation. Two or more entries,
//    or an entry without an IamInstanceProfile, fail before RunInstances.
//    Only "absent -> one entry" updates in place (cdkd also applies the rest
//    in place: delete, then create), and a delete leaves the association on
//    the terminated instance (cdkd deletes it, best effort).

const { mockSend, ssmSend, warn, debug, cfnSend, deadlineRemaining } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  ssmSend: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  deadlineRemaining: vi.fn(() => Number.POSITIVE_INFINITY),
  cfnSend: vi.fn(() => Promise.reject(new Error('DescribeType is not reachable here'))),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: cfnSend },
    ssm: { send: ssmSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug,
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, enclosingDeadlineRemainingMs: deadlineRemaining };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: vi.fn(() => Promise.resolve({})),
    waitUntilInstanceTerminated: vi.fn(() => Promise.resolve({})),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
} from '../../../src/deployment/retryable-errors/marks.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::EC2::Instance';
const SECRET = 'hunter2-param-secret';
const BASE = {
  ImageId: 'ami-1',
  InstanceType: 't3.nano',
  SubnetId: 'subnet-1',
  IamInstanceProfile: 'profile-1',
};
const LICENSE_ARN = 'arn:aws:license-manager:us-east-1:123456789012:license-configuration:lic-1';
const SHELL = {
  DocumentName: 'AWS-RunShellScript',
  AssociationParameters: [
    { Key: 'commands', Value: ['echo one', 'echo two'] },
    { Key: 'workingDirectory', Value: ['/tmp'] },
  ],
};
const SHELL_SECRET = {
  DocumentName: 'AWS-RunShellScript',
  AssociationParameters: [{ Key: 'commands', Value: [`echo ${SECRET}`] }],
};
const mask = (t: string): string => t.split(SECRET).join('***');

/** One association the mocked Systems Manager holds. */
interface Held {
  AssociationId: string;
  InstanceId?: string;
  Name: string;
  Parameters?: Record<string, string[]>;
}
let held: Held[];
let nextAssociation: number;
/** Errors the next CreateAssociation calls answer, in order. */
let createFailures: Error[];
/** When set, every CreateAssociation fails with it. */
let createAlwaysFails: Error | undefined;
let failDelete: Error | undefined;
let failList: Error | undefined;
/** Associations ListAssociations still names but that are already gone. */
let ghosts: Held[];
/** When set, ListAssociations answers pages of this many entries. */
let pageSize: number | undefined;
/** When set, the post-association DescribeInstances fails (a wiring failure after the association). */
let failDescribeAfterAssociation: Error | undefined;
/** When set, TerminateInstances fails with it. */
let failTerminate: Error | undefined;

function ec2Sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}
function ssmSent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return ssmSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}
/** The SSM writes, in order, as `<Create|Delete> <document|id>`. */
function ssmWrites(): string[] {
  return ssmSend.mock.calls
    .map((c) => c[0] as object)
    .filter((cmd) => cmd instanceof CreateAssociationCommand || cmd instanceof DeleteAssociationCommand)
    .map((cmd) => {
      const input = (cmd as unknown as { input: Record<string, string> }).input;
      return cmd instanceof CreateAssociationCommand
        ? `Create ${input['Name']}`
        : `Delete ${input['AssociationId']}`;
    });
}
const awsError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
const roleNotSeen = (): Error =>
  awsError(
    'InvalidInstanceId',
    'Before you can associate a document with the instance, you must associate an IAM role'
  );

beforeEach(() => {
  mockSend.mockReset();
  ssmSend.mockReset();
  warn.mockReset();
  debug.mockReset();
  vi.mocked(waitUntilInstanceRunning).mockClear();
  deadlineRemaining.mockReset();
  deadlineRemaining.mockReturnValue(Number.POSITIVE_INFINITY);
  held = [];
  nextAssociation = 1;
  createFailures = [];
  createAlwaysFails = undefined;
  failDelete = undefined;
  failList = undefined;
  ghosts = [];
  pageSize = undefined;
  failDescribeAfterAssociation = undefined;
  failTerminate = undefined;
  vi.spyOn(
    EC2Provider.prototype as unknown as { sleep: () => Promise<void> },
    'sleep'
  ).mockResolvedValue(undefined);
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
    }
    if (cmd instanceof TerminateInstancesCommand) {
      return failTerminate ? Promise.reject(failTerminate) : Promise.resolve({});
    }
    if (cmd instanceof DescribeIamInstanceProfileAssociationsCommand) {
      return Promise.resolve({
        IamInstanceProfileAssociations: [{ AssociationId: 'iip-1', State: 'associated' }],
      });
    }
    if (cmd instanceof DescribeInstancesCommand) {
      if (failDescribeAfterAssociation && held.length > 0) {
        return Promise.reject(failDescribeAfterAssociation);
      }
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-new',
                State: { Name: 'running' },
                RootDeviceType: 'ebs',
                ImageId: 'ami-1',
                InstanceType: 't3.nano',
              },
            ],
          },
        ],
      });
    }
    return Promise.resolve({});
  });
  ssmSend.mockImplementation((cmd: unknown) => {
    const input = (cmd as { input: Record<string, unknown> }).input;
    if (cmd instanceof CreateAssociationCommand) {
      if (createAlwaysFails) return Promise.reject(createAlwaysFails);
      const failure = createFailures.shift();
      if (failure) return Promise.reject(failure);
      const id = `assoc-${nextAssociation++}`;
      held.push({
        AssociationId: id,
        InstanceId: input['InstanceId'] as string,
        Name: input['Name'] as string,
        Parameters: input['Parameters'] as Record<string, string[]> | undefined,
      });
      return Promise.resolve({ AssociationDescription: { AssociationId: id } });
    }
    if (cmd instanceof DeleteAssociationCommand) {
      if (failDelete) return Promise.reject(failDelete);
      const before = held.length;
      held = held.filter((a) => a.AssociationId !== input['AssociationId']);
      return held.length === before
        ? Promise.reject(awsError('AssociationDoesNotExist', 'The association does not exist'))
        : Promise.resolve({});
    }
    if (cmd instanceof ListAssociationsCommand) {
      if (failList) return Promise.reject(failList);
      // Every association, unfiltered: the provider's own InstanceId and
      // document filters are what the cases exercise.
      const all = [...held, ...ghosts].map(({ AssociationId, InstanceId, Name }) => ({
        AssociationId,
        InstanceId,
        Name,
      }));
      if (pageSize === undefined) return Promise.resolve({ Associations: all });
      const start = Number(input['NextToken'] ?? 0);
      const end = start + pageSize;
      return Promise.resolve({
        Associations: all.slice(start, end),
        ...(end < all.length && { NextToken: String(end) }),
      });
    }
    if (cmd instanceof DescribeAssociationCommand) {
      const a = held.find((x) => x.AssociationId === input['AssociationId']);
      if (a === undefined) {
        return Promise.reject(awsError('AssociationDoesNotExist', 'The association does not exist'));
      }
      return Promise.resolve({
        AssociationDescription: { Name: a?.Name, Parameters: a?.Parameters },
      });
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('AWS::EC2::Instance LicenseSpecifications (#5630)', () => {
  it('sends the license configurations on RunInstances', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      LicenseSpecifications: [{ LicenseConfigurationArn: LICENSE_ARN }],
    });
    expect(ec2Sent(RunInstancesCommand)[0]!['LicenseSpecifications']).toEqual([
      { LicenseConfigurationArn: LICENSE_ARN },
    ]);
    // No License Manager or SSM call: CloudFormation makes none either.
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'arn:x', /LicenseSpecifications must be a list/],
    ['an entry without its ARN', [{}], /LicenseSpecifications\[0\]\.LicenseConfigurationArn is required/],
    ['a null entry', [null], /LicenseSpecifications\[0\] must be an object/],
  ])('refuses %s before any call, a rollback replay too', async (_name, value, says) => {
    for (const context of [undefined, { replayingState: true }]) {
      mockSend.mockClear();
      const error = await new EC2Provider()
        .create('Inst', TYPE, { ...BASE, LicenseSpecifications: value }, context)
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(says);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    }
  });

  it('a drift --revert that changes it is refused before any call (a launch-only input)', async () => {
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, LicenseSpecifications: [{ LicenseConfigurationArn: `${LICENSE_ARN}-2` }] },
        { ...BASE, LicenseSpecifications: [{ LicenseConfigurationArn: LICENSE_ARN }] }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toMatch(/LicenseSpecifications can be set only when the instance is launched/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is drift-unknown (DescribeInstances reports no Licenses)', () => {
    expect(new EC2Provider().getDriftUnknownPaths(TYPE)).toContain('LicenseSpecifications');
  });
});

describe('AWS::EC2::Instance SsmAssociations create (#5630)', () => {
  it('associates the document after the running wait and the profile check', async () => {
    const result = await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      SsmAssociations: [SHELL],
    });
    expect(result.physicalId).toBe('i-new');
    expect(result.effectiveProperties).toBeUndefined();
    expect(ssmSent(CreateAssociationCommand)).toEqual([
      {
        Name: 'AWS-RunShellScript',
        InstanceId: 'i-new',
        Parameters: { commands: ['echo one', 'echo two'], workingDirectory: ['/tmp'] },
      },
    ]);
    // After the instance runs and its profile is bound.
    const order = mockSend.mock.invocationCallOrder;
    const profileCheck = mockSend.mock.calls.findIndex(
      (c) => c[0] instanceof DescribeIamInstanceProfileAssociationsCommand
    );
    expect(profileCheck).toBeGreaterThanOrEqual(0);
    expect(ssmSend.mock.invocationCallOrder[0]!).toBeGreaterThan(order[profileCheck]!);
    expect(vi.mocked(waitUntilInstanceRunning)).toHaveBeenCalledTimes(1);
  });

  it('sends no Parameters for an entry declaring none', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      SsmAssociations: [{ DocumentName: 'AWS-RunShellScript' }],
    });
    expect(ssmSent(CreateAssociationCommand)[0]).toEqual({
      Name: 'AWS-RunShellScript',
      InstanceId: 'i-new',
    });
  });

  it('waits for running under --no-wait when SsmAssociations is declared, and not otherwise', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await new EC2Provider().create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] });
    expect(vi.mocked(waitUntilInstanceRunning)).toHaveBeenCalledTimes(1);
    vi.mocked(waitUntilInstanceRunning).mockClear();
    await new EC2Provider().create('Inst', TYPE, { ...BASE });
    expect(vi.mocked(waitUntilInstanceRunning)).not.toHaveBeenCalled();
  });

  it.each([
    [
      'two entries',
      { ...BASE, SsmAssociations: [SHELL, { DocumentName: 'AWS-UpdateSSMAgent' }] },
      /declares 2 documents, and an instance takes at most one \("Currently, multiple documents cannot be associated with one instance"/,
    ],
    [
      'an entry with no IamInstanceProfile',
      { ImageId: 'ami-1', InstanceType: 't3.nano', SsmAssociations: [SHELL] },
      /SsmAssociations needs an IamInstanceProfile: .*you must associate an IAM role/,
    ],
    [
      'an entry with no DocumentName',
      { ...BASE, SsmAssociations: [{ AssociationParameters: [] }] },
      /SsmAssociations\[0\]\.DocumentName is required/,
    ],
    [
      'a parameter Value that is not a list',
      { ...BASE, SsmAssociations: [{ DocumentName: 'd', AssociationParameters: [{ Key: 'k', Value: SECRET }] }] },
      /AssociationParameters\[0\]\.Value must be a list of strings \(got a string\)/,
    ],
    [
      'a parameter declared twice',
      {
        ...BASE,
        SsmAssociations: [
          {
            DocumentName: 'd',
            AssociationParameters: [
              { Key: 'k', Value: ['a'] },
              { Key: 'k', Value: ['b'] },
            ],
          },
        ],
      },
      /AssociationParameters\[1\] declares the Key k a second time/,
    ],
  ])('refuses %s before RunInstances, a rollback replay too', async (_name, props, says) => {
    for (const context of [undefined, { replayingState: true }]) {
      mockSend.mockClear();
      const error = await new EC2Provider()
        .create('Inst', TYPE, props as Record<string, unknown>, context)
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(says);
      // A refusal names a shape, never a parameter value.
      expect(String(error)).not.toContain(SECRET);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
      expect(ssmSend).not.toHaveBeenCalled();
    }
  });

  it('retries CreateAssociation while Systems Manager does not see the IAM role yet', async () => {
    createFailures = [roleNotSeen(), roleNotSeen()];
    await new EC2Provider().create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] });
    expect(ssmSent(CreateAssociationCommand)).toHaveLength(3);
    expect(held.map((a) => a.AssociationId)).toEqual(['assoc-1']);
    expect(ec2Sent(TerminateInstancesCommand)).toHaveLength(0);
  });

  it('gives up at the resource deadline, fails the create and terminates the instance', async () => {
    createAlwaysFails = roleNotSeen();
    let reads = 0;
    deadlineRemaining.mockImplementation(() => (++reads > 3 ? 0 : 60_000));
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/Failed to create EC2 Instance Inst/);
    expect(ssmSent(CreateAssociationCommand).length).toBeGreaterThan(1);
    expect(ec2Sent(TerminateInstancesCommand)).toEqual([{ InstanceIds: ['i-new'] }]);
  });

  it('gives up after the 5-minute cap when there is no resource deadline (T5)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let sleeps = 0;
    try {
      vi.mocked(
        (EC2Provider.prototype as unknown as { sleep: (ms: number) => Promise<void> }).sleep
      ).mockImplementation((ms: number) => {
        // A fence, not the subject: with the cap gone the retry would spin
        // forever, so the sleep gives up well past it and the count below
        // reports the failure.
        if (++sleeps > 150) return Promise.reject(new Error('retry outlived the cap'));
        vi.setSystemTime(Date.now() + ms);
        return Promise.resolve();
      });
      createAlwaysFails = roleNotSeen();
      const error = await new EC2Provider()
        .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] })
        .catch((e: unknown) => e);
      expect(String(error)).not.toMatch(/retry outlived the cap/);
      expect(String(error)).toMatch(/Failed to create EC2 Instance Inst/);
      // 5 min of 3 s polls: about 100 attempts, then the create fails.
      const attempts = ssmSent(CreateAssociationCommand).length;
      expect(attempts).toBeGreaterThan(90);
      expect(attempts).toBeLessThan(110);
      expect(ec2Sent(TerminateInstancesCommand)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refuse a missing IamInstanceProfile beside a LaunchTemplate (the template can carry one) (C1)', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      LaunchTemplate: { LaunchTemplateId: 'lt-1', Version: '1' },
      SubnetId: 'subnet-1',
      SsmAssociations: [SHELL],
    });
    expect(ec2Sent(RunInstancesCommand)).toHaveLength(1);
    expect(ssmSent(CreateAssociationCommand)).toHaveLength(1);
  });

  it('masks a secret in the create-cleanup association warning (T6)', async () => {
    failDescribeAfterAssociation = new Error('socket hang up');
    failDelete = new Error(`denied while deleting echo ${SECRET}`);
    await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL_SECRET] }, { maskSecrets: mask })
      .catch(() => undefined);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/Could not delete the SSM association assoc-1 of the partially-created/);
    expect(warned).not.toContain(SECRET);
  });

  it('does not retry another CreateAssociation failure', async () => {
    createFailures = [awsError('InvalidDocument', 'Document schema version, 2.2, is not supported')];
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(ssmSent(CreateAssociationCommand)).toHaveLength(1);
    expect(ec2Sent(TerminateInstancesCommand)).toEqual([{ InstanceIds: ['i-new'] }]);
  });

  it('ends the retry on Ctrl-C with an interrupted wait, terminating the instance', async () => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    const baseline = process.listeners('SIGINT');
    try {
      createAlwaysFails = roleNotSeen();
      const base = ssmSend.getMockImplementation()!;
      ssmSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateAssociationCommand) {
          for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
            (l as unknown as () => void)();
          }
        }
        return base(cmd);
      });
      const error = await new EC2Provider()
        .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] })
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(ssmSent(CreateAssociationCommand)).toHaveLength(1);
      expect(ec2Sent(TerminateInstancesCommand)).toHaveLength(1);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    }
  });

  it('masks a parameter value AWS echoes in a failure, in the error and every log line', async () => {
    createFailures = [new Error(`parameter commands=echo ${SECRET} is invalid`)];
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL_SECRET] }, { maskSecrets: mask })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/is invalid/);
    expect(String(error)).not.toContain(SECRET);
    const logged = [...warn.mock.calls, ...debug.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain(SECRET);
  });

  it('masks a parameter value in the role-retry debug line', async () => {
    createFailures = [
      awsError(
        'InvalidInstanceId',
        `Before you can associate a document with the instance, you must associate an IAM role (echo ${SECRET})`
      ),
    ];
    await new EC2Provider().create(
      'Inst',
      TYPE,
      { ...BASE, SsmAssociations: [SHELL_SECRET] },
      { maskSecrets: mask }
    );
    const logged = debug.mock.calls.flat().map(String).join('\n');
    expect(logged).toMatch(/does not see the IAM role of instance i-new/);
    expect(logged).not.toContain(SECRET);
  });

  it('deletes the association it made when a later wiring step fails', async () => {
    failDescribeAfterAssociation = new Error('socket hang up');
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, SsmAssociations: [SHELL] })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/socket hang up/);
    expect(ssmWrites()).toEqual(['Create AWS-RunShellScript', 'Delete assoc-1']);
    expect(ec2Sent(TerminateInstancesCommand)).toHaveLength(1);
  });

  it('refuses a stand-in parameter on a template create, before any call', async () => {
    const error = await new EC2Provider()
      .create('Inst', TYPE, {
        ...BASE,
        SsmAssociations: [
          { DocumentName: 'd', AssociationParameters: [{ Key: 'k', Value: ['{{resolve:secretsmanager:s}}'] }] },
        ],
      })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/SsmAssociations holds a recorded stand-in/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a rollback replay with a stand-in parameter launches without the association and records none', async () => {
    const props = {
      ...BASE,
      SsmAssociations: [{ DocumentName: 'd', AssociationParameters: [{ Key: 'k', Value: ['***'] }] }],
    };
    const result = await new EC2Provider().create('Inst', TYPE, props, { replayingState: true });
    expect(ssmSend).not.toHaveBeenCalled();
    expect(result.effectiveProperties).toEqual(BASE);
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /launched without its SSM association; deploy from the template to create it/
    );
  });
});

describe('AWS::EC2::Instance SsmAssociations update (#5630)', () => {
  const seed = (name = 'AWS-RunShellScript', instance = 'i-new'): void => {
    held.push({
      AssociationId: 'assoc-old',
      InstanceId: instance,
      Name: name,
      Parameters: { commands: ['echo one', 'echo two'], workingDirectory: ['/tmp'] },
    });
  };

  it('absent -> one entry creates the association, deleting nothing', async () => {
    await new EC2Provider().update('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] }, {
      ...BASE,
    });
    expect(ssmWrites()).toEqual(['Create AWS-RunShellScript']);
    expect(ssmSent(ListAssociationsCommand)).toHaveLength(0);
    expect(ssmSent(CreateAssociationCommand)[0]!['InstanceId']).toBe('i-new');
  });

  it('a parameter change deletes the recorded association by id, then creates the new one', async () => {
    seed();
    const next = {
      ...SHELL,
      AssociationParameters: [{ Key: 'commands', Value: ['echo three'] }],
    };
    const result = await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [next] },
      { ...BASE, SsmAssociations: [SHELL] }
    );
    expect(result.wasReplaced).toBe(false);
    expect(result.physicalId).toBe('i-new');
    expect(ssmWrites()).toEqual(['Delete assoc-old', 'Create AWS-RunShellScript']);
    expect(ssmSent(CreateAssociationCommand)[0]!['Parameters']).toEqual({ commands: ['echo three'] });
    expect(ssmSent(ListAssociationsCommand)[0]).toEqual({
      AssociationFilterList: [{ key: 'InstanceId', value: 'i-new' }],
    });
  });

  it('a document change deletes the recorded document and creates the new one', async () => {
    seed();
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [{ DocumentName: 'Custom-Doc' }] },
      { ...BASE, SsmAssociations: [SHELL] }
    );
    expect(ssmWrites()).toEqual(['Delete assoc-old', 'Create Custom-Doc']);
  });

  it('a removal deletes the association and creates none', async () => {
    seed();
    await new EC2Provider().update('Inst', 'i-new', TYPE, { ...BASE }, {
      ...BASE,
      SsmAssociations: [SHELL],
    });
    expect(ssmWrites()).toEqual(['Delete assoc-old']);
  });

  it('leaves an association of another document, or of another instance, alone', async () => {
    seed('Other-Doc');
    held.push({ AssociationId: 'assoc-target', Name: 'AWS-RunShellScript' }); // Targets-based: no InstanceId
    await new EC2Provider().update('Inst', 'i-new', TYPE, { ...BASE }, {
      ...BASE,
      SsmAssociations: [SHELL],
    });
    expect(ssmWrites()).toEqual([]);
    expect(held.map((a) => a.AssociationId)).toEqual(['assoc-old', 'assoc-target']);
  });

  it('an unchanged association (parameter order aside) sends nothing to Systems Manager', async () => {
    const reordered = {
      ...SHELL,
      AssociationParameters: [...SHELL.AssociationParameters].reverse(),
    };
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [reordered] },
      { ...BASE, SsmAssociations: [SHELL] }
    );
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it('says plainly that the instance has NO association when the create after the delete fails', async () => {
    seed();
    createFailures = [new Error(`throttled while sending echo ${SECRET}`)];
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, SsmAssociations: [SHELL_SECRET] },
        { ...BASE, SsmAssociations: [SHELL] },
        { maskSecrets: mask }
      )
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(
      /cdkd deleted its SSM association \(document AWS-RunShellScript\) and then could not create the new one, so the instance i-new now has NO SSM association/
    );
    expect(String(error)).toMatch(/throttled while sending/);
    expect(String(error)).not.toContain(SECRET);
    expect(held).toEqual([]);
  });

  it('a create failure with nothing deleted is the plain failure', async () => {
    createFailures = [new Error('throttled')];
    const error = await new EC2Provider()
      .update('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] }, { ...BASE })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/Failed to update EC2 Instance Inst: throttled/);
    expect(String(error)).not.toMatch(/NO SSM association/);
  });

  it('an unreadable previous record deletes no association (none is known to be this one), with a warning', async () => {
    seed('Whatever-Doc');
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [SHELL] },
      { ...BASE, SsmAssociations: 'garbage' }
    );
    expect(ssmWrites()).toEqual(['Create AWS-RunShellScript']);
    expect(ssmSent(ListAssociationsCommand)).toHaveLength(0);
    expect(held.map((a) => a.AssociationId)).toEqual(['assoc-old', 'assoc-1']);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(
      /previous record's SsmAssociations is unreadable, so cdkd cannot tell which SSM association of i-new is this resource's; it deletes none/
    );
    // No recorded region: the client's own, never the operator's default.
    expect(warned).toContain(
      'aws ssm list-associations --association-filter-list key=InstanceId,value=i-new --region us-east-1'
    );
    expect(warned).toContain('aws ssm delete-association --association-id <id> --region us-east-1');
  });

  it('warns with the remedy when an unreadable record meets a template declaring no association (R2-3)', async () => {
    seed();
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE },
      { ...BASE, SsmAssociations: 'garbage' },
      { expectedRegion: 'eu-west-3' }
    );
    expect(ssmSend).not.toHaveBeenCalled();
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/SsmAssociations is unreadable, .* of i-new is this resource's and deletes none/);
    // The recorded region, not the client's.
    expect(warned).toContain(
      'aws ssm list-associations --association-filter-list key=InstanceId,value=i-new --region eu-west-3'
    );
    expect(warned).toContain('aws ssm delete-association --association-id <id> --region eu-west-3');
  });

  it('points a create failure after an unreadable record back to the association it did not remove (R2-1)', async () => {
    seed('Whatever-Doc');
    createFailures = [new Error('Currently, multiple documents cannot be associated with one instance')];
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, SsmAssociations: [SHELL] },
        { ...BASE, SsmAssociations: 'garbage' },
        { expectedRegion: 'eu-west-3' }
      )
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(
      /the previous record's SsmAssociations was unreadable, so cdkd did not remove the old SSM association of i-new/
    );
    expect(String(error)).toContain(
      'aws ssm list-associations --association-filter-list key=InstanceId,value=i-new --region eu-west-3'
    );
    expect(String(error)).toContain('aws ssm delete-association --association-id <id> --region eu-west-3');
    expect(String(error)).toMatch(/multiple documents cannot be associated/);
  });

  it('applies an IamInstanceProfile change before the association it needs (T2)', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, IamInstanceProfile: 'profile-2', SsmAssociations: [SHELL] },
      { ...BASE }
    );
    const profileCall = mockSend.mock.calls.findIndex(
      (c) =>
        c[0] instanceof ReplaceIamInstanceProfileAssociationCommand ||
        c[0] instanceof AssociateIamInstanceProfileCommand
    );
    expect(profileCall).toBeGreaterThanOrEqual(0);
    const create = ssmSend.mock.calls.findIndex((c) => c[0] instanceof CreateAssociationCommand);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(ssmSend.mock.invocationCallOrder[create]!).toBeGreaterThan(
      mockSend.mock.invocationCallOrder[profileCall]!
    );
  });

  it('follows ListAssociations pages to find the recorded association (T3)', async () => {
    pageSize = 1;
    held.push({ AssociationId: 'assoc-other-instance', InstanceId: 'i-other', Name: 'AWS-RunShellScript' });
    held.push({ AssociationId: 'assoc-target', Name: 'AWS-RunShellScript' });
    seed();
    await new EC2Provider().update('Inst', 'i-new', TYPE, { ...BASE }, {
      ...BASE,
      SsmAssociations: [SHELL],
    });
    expect(ssmWrites()).toEqual(['Delete assoc-old']);
    expect(ssmSent(ListAssociationsCommand).map((i) => i['NextToken'])).toEqual([undefined, '1', '2']);
  });

  it('treats an association gone between the list and the delete as deleted (T7)', async () => {
    ghosts.push({ AssociationId: 'assoc-ghost', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [{ DocumentName: 'Custom-Doc' }] },
      { ...BASE, SsmAssociations: [SHELL] }
    );
    expect(ssmWrites()).toEqual(['Delete assoc-ghost', 'Create Custom-Doc']);
  });

  it('matches an ARN-declared document to the listed name (T4)', async () => {
    const ARN_DOC = { DocumentName: 'arn:aws:ssm:us-east-1:123456789012:document/Custom-Doc' };
    held.push({ AssociationId: 'assoc-custom', InstanceId: 'i-new', Name: 'Custom-Doc' });
    held.push({ AssociationId: 'assoc-shell', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    // The same document by name and by ARN is no change.
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [ARN_DOC] },
      { ...BASE, SsmAssociations: [{ DocumentName: 'Custom-Doc' }] }
    );
    expect(ssmSend).not.toHaveBeenCalled();
    // The readback keeps the declared ARN spelling, so it compares equal.
    const read = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [ARN_DOC],
    })) as Record<string, unknown>;
    expect(read['SsmAssociations']).toEqual([ARN_DOC]);
    // A removal deletes only that document's association.
    await new EC2Provider().update('Inst', 'i-new', TYPE, { ...BASE }, {
      ...BASE,
      SsmAssociations: [ARN_DOC],
    });
    expect(ssmWrites()).toEqual(['Delete assoc-custom']);
  });

  it('marks the no-association error so the retry classifiers read the withheld AWS text (S1)', async () => {
    seed();
    createFailures = [awsError('ThrottlingException', 'Rate exceeded')];
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, SsmAssociations: [{ DocumentName: 'Custom-Doc' }] },
        { ...BASE, SsmAssociations: [SHELL] }
      )
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/now has NO SSM association/);
    expect(hasRedactedCause(error)).toBe(true);
  });

  it.each([
    [
      'two entries',
      { ...BASE, SsmAssociations: [SHELL, { DocumentName: 'Other' }] },
      /multiple documents cannot be associated/,
    ],
    [
      'an entry without an IamInstanceProfile',
      { ImageId: 'ami-1', InstanceType: 't3.nano', SubnetId: 'subnet-1', SsmAssociations: [SHELL] },
      /SsmAssociations needs an IamInstanceProfile/,
    ],
    ['a malformed list', { ...BASE, SsmAssociations: { DocumentName: 'd' } }, /SsmAssociations must be a list/],
  ])('refuses %s before any call, a rollback revert too', async (_name, props, says) => {
    for (const context of [undefined, { replayingState: true }]) {
      mockSend.mockClear();
      ssmSend.mockClear();
      const error = await new EC2Provider()
        .update('Inst', 'i-new', TYPE, props as Record<string, unknown>, { ...BASE }, context)
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(says);
      expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
      expect(ssmSend).not.toHaveBeenCalled();
    }
  });

  it('a stand-in parameter is refused forward and keeps the live association on a rollback revert', async () => {
    seed();
    const standIn = {
      ...BASE,
      SsmAssociations: [{ DocumentName: 'd', AssociationParameters: [{ Key: 'k', Value: ['***'] }] }],
    };
    const error = await new EC2Provider()
      .update('Inst', 'i-new', TYPE, standIn, { ...BASE, SsmAssociations: [SHELL] })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/SsmAssociations holds a recorded stand-in/);
    expect(ssmSend).not.toHaveBeenCalled();

    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      standIn,
      { ...BASE, SsmAssociations: [SHELL] },
      { replayingState: true }
    );
    expect(ssmWrites()).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/leaves SsmAssociations at its current AWS value/);
  });
});

describe('AWS::EC2::Instance SsmAssociations delete (#5630)', () => {
  it('deletes the association once the terminate is accepted', async () => {
    held.push({ AssociationId: 'assoc-1', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    await new EC2Provider().delete('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] });
    expect(ssmWrites()).toEqual(['Delete assoc-1']);
    const terminate = mockSend.mock.calls.findIndex((c) => c[0] instanceof TerminateInstancesCommand);
    expect(ssmSend.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockSend.mock.invocationCallOrder[terminate]!
    );
  });

  it('warns, and still deletes the instance, when the association cannot be deleted', async () => {
    held.push({ AssociationId: 'assoc-1', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    failDelete = new Error('connect ETIMEDOUT');
    await expect(
      new EC2Provider().delete('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] })
    ).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /Could not delete the SSM association of EC2 Instance Inst \(i-new\): connect ETIMEDOUT/
    );
  });

  it('warns, and still deletes the instance, when the associations cannot be listed', async () => {
    failList = new Error('connect ETIMEDOUT');
    await expect(
      new EC2Provider().delete('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] })
    ).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toMatch(/Could not delete the SSM association/);
  });

  it("deletes only this instance's association of the recorded document, across pages (T1, T3)", async () => {
    pageSize = 1;
    held.push({ AssociationId: 'assoc-target', Name: 'AWS-RunShellScript' }); // Targets-based: no InstanceId
    held.push({ AssociationId: 'assoc-other-doc', InstanceId: 'i-new', Name: 'Other-Doc' });
    held.push({ AssociationId: 'assoc-other-instance', InstanceId: 'i-other', Name: 'AWS-RunShellScript' });
    held.push({ AssociationId: 'assoc-1', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    await new EC2Provider().delete('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] });
    expect(ssmWrites()).toEqual(['Delete assoc-1']);
    expect(held.map((a) => a.AssociationId)).toEqual([
      'assoc-target',
      'assoc-other-doc',
      'assoc-other-instance',
    ]);
  });

  it('masks a secret in the delete warning (T6)', async () => {
    held.push({ AssociationId: 'assoc-1', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    failDelete = new Error(`denied while deleting echo ${SECRET}`);
    await new EC2Provider().delete(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [SHELL_SECRET] },
      { maskSecrets: mask }
    );
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/Could not delete the SSM association of EC2 Instance Inst/);
    expect(warned).not.toContain(SECRET);
  });

  it('warns, with the remedy, and makes no Systems Manager call for an unreadable recorded SsmAssociations (R2-2)', async () => {
    await new EC2Provider().delete(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, SsmAssociations: [null] },
      { expectedRegion: 'eu-west-3' }
    );
    expect(ssmSend).not.toHaveBeenCalled();
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toMatch(/record's SsmAssociations is unreadable, .* skips the association cleanup/);
    expect(warned).toContain(
      'aws ssm list-associations --association-filter-list key=InstanceId,value=i-new --region eu-west-3'
    );
    expect(warned).toContain('aws ssm delete-association --association-id <id> --region eu-west-3');
  });

  it('makes no Systems Manager call for a record without SsmAssociations', async () => {
    await new EC2Provider().delete('Inst', 'i-new', TYPE, { ...BASE });
    await new EC2Provider().delete('Inst', 'i-new', TYPE);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it('keeps the association when the terminate is refused', async () => {
    held.push({ AssociationId: 'assoc-1', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    failTerminate = awsError(
      'OperationNotPermitted',
      "The instance 'i-new' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again."
    );
    await expect(
      new EC2Provider().delete('Inst', 'i-new', TYPE, { ...BASE, SsmAssociations: [SHELL] })
    ).rejects.toThrow();
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

describe('AWS::EC2::Instance SsmAssociations drift readback (#5630)', () => {
  it('reads the association back in the template shape and parameter order', async () => {
    held.push({
      AssociationId: 'assoc-1',
      InstanceId: 'i-new',
      Name: 'AWS-RunShellScript',
      Parameters: { workingDirectory: ['/tmp'], commands: ['echo one', 'echo two'] },
    });
    const read = await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [SHELL],
    });
    expect(read).not.toBe(RESOURCE_NOT_FOUND);
    expect((read as Record<string, unknown>)['SsmAssociations']).toEqual([SHELL]);
    expect(ssmSent(DescribeAssociationCommand)).toEqual([{ AssociationId: 'assoc-1' }]);
  });

  it('reports a changed parameter and an association that is gone', async () => {
    held.push({
      AssociationId: 'assoc-1',
      InstanceId: 'i-new',
      Name: 'AWS-RunShellScript',
      Parameters: { commands: ['echo changed'], workingDirectory: ['/tmp'], extra: ['x'] },
    });
    const provider = new EC2Provider();
    const read = (await provider.readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [SHELL],
    })) as Record<string, unknown>;
    expect(read['SsmAssociations']).toEqual([
      {
        DocumentName: 'AWS-RunShellScript',
        AssociationParameters: [
          { Key: 'commands', Value: ['echo changed'] },
          { Key: 'workingDirectory', Value: ['/tmp'] },
          { Key: 'extra', Value: ['x'] },
        ],
      },
    ]);
    held = [];
    const gone = (await provider.readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [SHELL],
    })) as Record<string, unknown>;
    expect(gone['SsmAssociations']).toEqual([]);
  });

  it("reads only the declared document's association of this instance, across pages, skipping one gone since the list (T1, T3, C4)", async () => {
    pageSize = 1;
    held.push({ AssociationId: 'assoc-target', Name: 'AWS-RunShellScript' });
    held.push({ AssociationId: 'assoc-other-doc', InstanceId: 'i-new', Name: 'Other-Doc' });
    ghosts.push({ AssociationId: 'assoc-ghost', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    held.push({
      AssociationId: 'assoc-1',
      InstanceId: 'i-new',
      Name: 'AWS-RunShellScript',
      Parameters: { commands: ['echo one', 'echo two'], workingDirectory: ['/tmp'] },
    });
    const read = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [SHELL],
    })) as Record<string, unknown>;
    expect(read['SsmAssociations']).toEqual([SHELL]);
  });

  it('reads a declared empty parameter list back as [] (T8)', async () => {
    held.push({ AssociationId: 'assoc-1', InstanceId: 'i-new', Name: 'AWS-RunShellScript' });
    const declared = { DocumentName: 'AWS-RunShellScript', AssociationParameters: [] };
    const read = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [declared],
    })) as Record<string, unknown>;
    expect(read['SsmAssociations']).toEqual([declared]);
    const bare = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [{ DocumentName: 'AWS-RunShellScript' }],
    })) as Record<string, unknown>;
    expect(bare['SsmAssociations']).toEqual([{ DocumentName: 'AWS-RunShellScript' }]);
  });

  it('reads nothing, and does not throw, for a malformed declared bag (T8)', async () => {
    const read = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [null],
    })) as Record<string, unknown>;
    expect('SsmAssociations' in read).toBe(false);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it('omits the key when Systems Manager cannot be read, and reads nothing for a bag without it', async () => {
    failList = new Error('AccessDenied');
    const read = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {
      ...BASE,
      SsmAssociations: [SHELL],
    })) as Record<string, unknown>;
    expect('SsmAssociations' in read).toBe(false);
    ssmSend.mockClear();
    await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, { ...BASE });
    expect(ssmSend).not.toHaveBeenCalled();
  });
});
