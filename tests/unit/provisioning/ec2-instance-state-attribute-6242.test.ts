import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  RunInstancesCommand,
  type Instance,
  type InstanceStateName,
} from '@aws-sdk/client-ec2';

const { mockSend, waitUntilInstanceRunningMock, warnMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilInstanceRunningMock: vi.fn(() => Promise.resolve({})),
  warnMock: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    waitUntilInstanceRunning: waitUntilInstanceRunningMock,
  };
});

import {
  EC2Provider,
  describedInstanceAttributes,
} from '../../../src/provisioning/providers/ec2-provider.js';

const PROPS = { ImageId: 'ami-12345678', InstanceType: 't3.micro', SubnetId: 'subnet-1' };
const ID = 'i-1234567890abcdef0';

function mockInstance(state: { Code?: number; Name: string }) {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: ID }] });
    }
    return Promise.resolve({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: ID,
              State: state,
              PrivateIpAddress: '10.0.0.5',
              PrivateDnsName: 'ip-10-0-0-5.ec2.internal',
              Placement: { AvailabilityZone: 'us-east-1a' },
              PublicDnsName: '',
            },
          ],
        },
      ],
    });
  });
}

// go-to-k/cdkd#6242: `Fn::GetAtt [Instance, State]` was refused. CloudFormation
// passes `{"Code": "16", "Name": "running"}` (measured us-east-1, 2026-11-14,
// `Code` a STRING). The state is recorded as the operation observed it after
// it waited -- never from a create that skipped the wait, never a transition.
describe('EC2 Instance State attribute (go-to-k/cdkd#6242)', () => {
  let originalNoWait: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });
  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('create records State with a string Code after waiting for running', async () => {
    mockInstance({ Code: 16, Name: 'running' });
    const result = await new EC2Provider().create('I', 'AWS::EC2::Instance', PROPS);
    expect(waitUntilInstanceRunningMock).toHaveBeenCalledTimes(1);
    expect(result.attributes?.['State']).toStrictEqual({ Code: '16', Name: 'running' });
  });

  it('create under --no-wait records no State, even when the describe already says running', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockInstance({ Code: 16, Name: 'running' });
    const result = await new EC2Provider().create('I', 'AWS::EC2::Instance', PROPS);
    expect(waitUntilInstanceRunningMock).not.toHaveBeenCalled();
    expect(Object.hasOwn(result.attributes!, 'State')).toBe(false);
    // The rest of the map is unchanged by the gate.
    expect(result.attributes?.['PrivateIp']).toBe('10.0.0.5');
  });

  it('update records the State the read-back reports (the map replaces the record)', async () => {
    mockInstance({ Code: 80, Name: 'stopped' });
    const result = await new EC2Provider().update('I', ID, 'AWS::EC2::Instance', PROPS, PROPS);
    expect(result.attributes?.['State']).toStrictEqual({ Code: '80', Name: 'stopped' });
  });

  it('import records the State as create does', async () => {
    mockInstance({ Code: 16, Name: 'running' });
    const result = await new EC2Provider().import({
      logicalId: 'I',
      resourceType: 'AWS::EC2::Instance',
      stackName: 'S',
      region: 'us-east-1',
      properties: PROPS,
      knownPhysicalId: ID,
    });
    expect(result?.attributes?.['State']).toStrictEqual({ Code: '16', Name: 'running' });
  });

  it.each([
    [{ Code: 0, Name: 'pending' }],
    [{ Code: 64, Name: 'stopping' }],
    [{ Name: 'running' }],
  ])('records no State for %j (a transition, or no Code)', (state) => {
    const out = describedInstanceAttributes(ID, {
      State: state as Instance['State'],
      PrivateIpAddress: '10.0.0.5',
    });
    expect(Object.hasOwn(out, 'State')).toBe(false);
  });

  it('records State for a settled read when the caller waited or did not say', () => {
    const instance: Instance = { State: { Code: 16, Name: 'running' as InstanceStateName } };
    expect(describedInstanceAttributes(ID, instance)['State']).toStrictEqual({
      Code: '16',
      Name: 'running',
    });
    expect(Object.hasOwn(describedInstanceAttributes(ID, instance, { waited: false }), 'State')).toBe(
      false
    );
  });
});
