import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const RESOURCE_TYPE = 'AWS::EC2::Instance';
const INSTANCE_ID = 'i-0123456789abcdef0';
// The CFn AWS::EC2::Instance.IamInstanceProfile property is the instance
// profile NAME (a plain string) — what `instanceProfile.ref` resolves to in
// CDK. The previous test mistakenly used the `{Arn}` object shape (the
// LaunchTemplate / RunInstances-SDK shape), which masked the real bug: a string
// cast to a record yields undefined Arn/Name, so the associate helper returned
// early and the instance launched with no profile.
const PROFILE_NAME = 'MyStack-InstanceProfile';
const PROFILE_ARN = 'arn:aws:iam::123456789012:instance-profile/MyStack-InstanceProfile';

// cdkd's fast SDK path creates the AWS::IAM::InstanceProfile only ~1s before
// RunInstances. The profile + its role membership takes a few seconds to
// propagate to EC2's view, and RunInstances does NOT synchronously validate
// the supplied IamInstanceProfile — it can launch the instance WITHOUT the
// profile and return success with no error. createInstance closes this race
// by ALWAYS describing the association post-launch and, when no `associated`
// association exists, AssociateIamInstanceProfile (retrying through the
// propagation window) then polling until the association reaches `associated`.
// These tests pin that behavior.
describe('EC2Provider createInstance fresh-instance-profile bind', () => {
  let provider: EC2Provider;

  const installFastSleep = (p: EC2Provider): void => {
    (p as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
      Promise.resolve()
    );
  };

  const callCount = (commandName: string): number =>
    mockSend.mock.calls.filter((c) => c[0]?.constructor?.name === commandName).length;

  const propagationError = (): Error =>
    new Error(`Invalid IAM Instance Profile name ${PROFILE_NAME}`);

  // Wire the mock by command class name.
  //  - describeStates: consumed one entry per DescribeIamInstanceProfileAssociations
  //    call. Each entry is the array of association `State` strings that call
  //    reports ([] = no association). The last entry is reused once exhausted,
  //    so a single ['associated'] entry models "already bound from the start".
  //  - associateBehavior: consumed one entry per AssociateIamInstanceProfile
  //    call ('propagating' = throw the Invalid-IAM-Instance-Profile error,
  //    'ok' = resolve).
  const wire = (
    describeStates: string[][],
    associateBehavior: Array<'propagating' | 'ok'> = []
  ): void => {
    let describeCall = 0;
    let associateCall = 0;
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'RunInstancesCommand') {
        return Promise.resolve({ Instances: [{ InstanceId: INSTANCE_ID }] });
      }
      if (name === 'CreateTagsCommand') return Promise.resolve({});
      // waitUntilInstanceRunning polls DescribeInstancesCommand; report running.
      if (name === 'DescribeInstancesCommand') {
        return Promise.resolve({
          Reservations: [{ Instances: [{ InstanceId: INSTANCE_ID, State: { Name: 'running' } }] }],
        });
      }
      if (name === 'DescribeIamInstanceProfileAssociationsCommand') {
        const states = describeStates[Math.min(describeCall, describeStates.length - 1)] ?? [];
        describeCall++;
        return Promise.resolve({
          IamInstanceProfileAssociations: states.map((State) => ({ State })),
        });
      }
      if (name === 'AssociateIamInstanceProfileCommand') {
        const behavior = associateBehavior[associateCall] ?? 'ok';
        associateCall++;
        if (behavior === 'propagating') return Promise.reject(propagationError());
        return Promise.resolve({ IamInstanceProfileAssociation: { State: 'associating' } });
      }
      return Promise.resolve({});
    });
  };

  // The canonical CFn shape: IamInstanceProfile is the profile NAME string.
  const props = (): Record<string, unknown> => ({
    ImageId: 'ami-123',
    InstanceType: 't3.micro',
    IamInstanceProfile: PROFILE_NAME,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
    installFastSleep(provider);
  });

  it('does NOT re-associate when RunInstances already bound the profile (associated)', async () => {
    wire([['associated']]);

    const result = await provider.create('Instance', RESOURCE_TYPE, props());

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callCount('DescribeIamInstanceProfileAssociationsCommand')).toBe(1);
    expect(callCount('AssociateIamInstanceProfileCommand')).toBe(0);
  });

  it('passes the profile NAME (CFn string shape) to RunInstances, not an empty spec', async () => {
    wire([['associated']]);

    await provider.create('Instance', RESOURCE_TYPE, props());

    const runCall = mockSend.mock.calls.find(
      (c) => c[0]?.constructor?.name === 'RunInstancesCommand'
    );
    expect(runCall?.[0]?.input?.IamInstanceProfile).toEqual({
      Arn: undefined,
      Name: PROFILE_NAME,
    });
  });

  it('classifies an arn: string as Arn and a bare name as Name', async () => {
    wire([['associated']]);

    await provider.create('Instance', RESOURCE_TYPE, {
      ImageId: 'ami-123',
      InstanceType: 't3.micro',
      IamInstanceProfile: PROFILE_ARN,
    });

    const runCall = mockSend.mock.calls.find(
      (c) => c[0]?.constructor?.name === 'RunInstancesCommand'
    );
    expect(runCall?.[0]?.input?.IamInstanceProfile).toEqual({
      Arn: PROFILE_ARN,
      Name: undefined,
    });
  });

  it('associates the profile post-launch when RunInstances did not bind it, then polls until associated', async () => {
    // RunInstances did NOT bind (first describe: none). After associating,
    // the association is still `associating` on the next poll, then flips to
    // `associated`.
    wire([[], ['associating'], ['associated']], ['ok']);

    const result = await provider.create('Instance', RESOURCE_TYPE, props());

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callCount('AssociateIamInstanceProfileCommand')).toBe(1);
    // 1 pre-associate describe + at least 2 post-associate polls (associating -> associated).
    expect(callCount('DescribeIamInstanceProfileAssociationsCommand')).toBeGreaterThanOrEqual(3);
  });

  it('does NOT treat an `associating` launch association as bound — it polls to associated', async () => {
    // RunInstances left the association stuck in `associating` (it may never
    // complete). The provider must NOT early-return on `associating`: it
    // associates explicitly, then the association reaches `associated`.
    wire([['associating'], ['associated']], ['ok']);

    const result = await provider.create('Instance', RESOURCE_TYPE, props());

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callCount('AssociateIamInstanceProfileCommand')).toBe(1);
  });

  it('retries AssociateIamInstanceProfile through the propagation window, then succeeds', async () => {
    // Profile not bound by RunInstances; associate fails twice (still
    // propagating), succeeds on the 3rd; then the poll sees `associated`.
    wire([[], ['associated']], ['propagating', 'propagating', 'ok']);

    const result = await provider.create('Instance', RESOURCE_TYPE, props());

    expect(result.physicalId).toBe(INSTANCE_ID);
    expect(callCount('AssociateIamInstanceProfileCommand')).toBe(3);
  });

  it('skips the association step entirely when no IamInstanceProfile is requested', async () => {
    wire([[]]);

    await provider.create('Instance', RESOURCE_TYPE, {
      ImageId: 'ami-123',
      InstanceType: 't3.micro',
    });

    expect(callCount('DescribeIamInstanceProfileAssociationsCommand')).toBe(0);
    expect(callCount('AssociateIamInstanceProfileCommand')).toBe(0);
  });
});
