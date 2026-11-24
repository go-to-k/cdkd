import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
      '@aws-sdk/client-auto-scaling'
    );
  return {
    ...actual,
    AutoScalingClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import {
  UpdateAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';

const RESOURCE_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG_NAME = 'my-asg';

type CommandInput = Record<string, unknown>;

function installUpdateHappyPath(): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof UpdateAutoScalingGroupCommand) return Promise.resolve({});
    if (command instanceof DescribeAutoScalingGroupsCommand) {
      return Promise.resolve({
        AutoScalingGroups: [
          {
            AutoScalingGroupName: ASG_NAME,
            AutoScalingGroupARN: `arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:abc:autoScalingGroupName/${ASG_NAME}`,
            MinSize: 0,
            MaxSize: 0,
          },
        ],
      });
    }
    return Promise.resolve({});
  });
}

function updateCallInput(): CommandInput {
  const call = mockSend.mock.calls.find(
    (c: unknown[]) => c[0] instanceof UpdateAutoScalingGroupCommand
  ) as [UpdateAutoScalingGroupCommand] | undefined;
  expect(call).toBeDefined();
  return (call as [UpdateAutoScalingGroupCommand])[0].input as unknown as CommandInput;
}

beforeEach(() => {
  mockSend.mockReset();
  mockEc2Send.mockReset();
  mockEc2Send.mockResolvedValue({});
  installUpdateHappyPath();
});

describe('ASGProvider update — UpdatePolicy.AutoScalingScheduledAction (go-to-k/cdkd#6437)', () => {
  const previous = {
    AutoScalingGroupName: ASG_NAME,
    MinSize: '1',
    MaxSize: '4',
    DesiredCapacity: '2',
    Cooldown: '60',
  };
  const scheduled = (flag: unknown) => ({
    AutoScalingScheduledAction: { IgnoreUnmodifiedGroupSizeProperties: flag },
  });
  const update = async (desired: Record<string, unknown>, updatePolicy?: Record<string, unknown>) =>
    new ASGProvider().update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      desired,
      previous,
      updatePolicy ? { updatePolicy } : undefined
    );

  it('omits the unchanged size properties and sends the changed one', async () => {
    await update({ ...previous, DesiredCapacity: 3, Cooldown: '90' }, scheduled(true));
    const input = updateCallInput();
    expect(input).not.toHaveProperty('MinSize');
    expect(input).not.toHaveProperty('MaxSize');
    expect(input['DesiredCapacity']).toBe(3);
  });

  it("reads the string 'true' as true", async () => {
    await update({ ...previous, Cooldown: '90' }, scheduled('true'));
    const input = updateCallInput();
    expect(input).not.toHaveProperty('MinSize');
    expect(input).not.toHaveProperty('MaxSize');
    expect(input).not.toHaveProperty('DesiredCapacity');
  });

  it('sends every size property without an updatePolicy (the default, --no-update-policy)', async () => {
    await update({ ...previous, Cooldown: '90' });
    const input = updateCallInput();
    expect(input['MinSize']).toBe(1);
    expect(input['MaxSize']).toBe(4);
    expect(input['DesiredCapacity']).toBe(2);
  });

  it.each([false, 'false', { 'Fn::If': ['C', true, false] }])(
    'sends every size property when the flag is %j',
    async (flag) => {
      await update({ ...previous, Cooldown: '90' }, scheduled(flag));
      const input = updateCallInput();
      expect(input['MinSize']).toBe(1);
      expect(input['MaxSize']).toBe(4);
      expect(input['DesiredCapacity']).toBe(2);
    }
  );

  it.each([null, 'yes', true])(
    'sends every size property when AutoScalingScheduledAction is %j',
    async (scheduledAction) => {
      await update(
        { ...previous, Cooldown: '90' },
        { AutoScalingScheduledAction: scheduledAction }
      );
      const input = updateCallInput();
      expect(input['MinSize']).toBe(1);
      expect(input['MaxSize']).toBe(4);
      expect(input['DesiredCapacity']).toBe(2);
    }
  );

  it('re-sends a size whose previous value is a dynamic reference', async () => {
    await new ASGProvider().update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { ...previous, Cooldown: '90' },
      { ...previous, DesiredCapacity: '{{resolve:ssm:/asg/desired}}' },
      { updatePolicy: scheduled(true) }
    );
    const input = updateCallInput();
    expect(input).not.toHaveProperty('MinSize');
    expect(input['DesiredCapacity']).toBe(2);
  });

  it('sends a size property the previous record did not hold', async () => {
    const { DesiredCapacity: _omit, ...prevNoDesired } = previous;
    await new ASGProvider().update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { ...previous, Cooldown: '90' },
      prevNoDesired,
      { updatePolicy: scheduled(true) }
    );
    const input = updateCallInput();
    expect(input).not.toHaveProperty('MinSize');
    expect(input['DesiredCapacity']).toBe(2);
  });

  it('sends a zero size whose previous value was null (null is not 0)', async () => {
    await new ASGProvider().update(
      'MyAsg',
      ASG_NAME,
      RESOURCE_TYPE,
      { ...previous, DesiredCapacity: 0, Cooldown: '90' },
      { ...previous, DesiredCapacity: null },
      { updatePolicy: scheduled(true) }
    );
    expect(updateCallInput()['DesiredCapacity']).toBe(0);
  });
});
