import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: when the create-time wiring fails AFTER
// CreateAutoScalingGroup returned and the retire could not remove the group,
// the thrown error names the group so `cdkd rollback --revert-failed` can
// delete it. A finished retire, the create call's own failure and a pre-flight
// refusal name nothing.

const mockSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
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
    AutoScalingClient: vi.fn().mockImplementation(() => ({
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

import {
  CreateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  EnableMetricsCollectionCommand,
} from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const PROPS = {
  AutoScalingGroupName: 'my-asg',
  MinSize: 0,
  MaxSize: 1,
  MetricsCollection: [{ Granularity: '1Minute' }],
};

function respond(overrides: { create?: Error; wiring?: Error; delete?: Error }): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof CreateAutoScalingGroupCommand && overrides.create) {
      return Promise.reject(overrides.create);
    }
    if (command instanceof EnableMetricsCollectionCommand && overrides.wiring) {
      return Promise.reject(overrides.wiring);
    }
    if (command instanceof DeleteAutoScalingGroupCommand && overrides.delete) {
      return Promise.reject(overrides.delete);
    }
    if (command instanceof DescribeAutoScalingGroupsCommand) {
      return Promise.resolve({ AutoScalingGroups: [] });
    }
    return Promise.resolve({});
  });
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

const validation = (message: string) => Object.assign(new Error(message), { name: 'ValidationError' });

describe('ASGProvider.create marks a group its retire left behind (go-to-k/cdkd#4583)', () => {
  let provider: ASGProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEc2Send.mockResolvedValue({ Reservations: [] });
    provider = new ASGProvider();
  });

  it('names the group when the wiring fails and the retire cannot delete it', async () => {
    respond({
      wiring: validation('wiring boom'),
      delete: Object.assign(new Error('delete refused'), { name: 'AccessDenied' }),
    });

    const error = await failure(() => provider.create('MyAsg', TYPE, PROPS));

    expect((error as Error).message).toContain('wiring boom');
    expect(createdBeforeFailure(error, 'MyAsg', TYPE)).toBe('my-asg');
  });

  it('names nothing when the retire removed the group', async () => {
    respond({ wiring: validation('wiring boom') });

    const error = await failure(() => provider.create('MyAsg', TYPE, PROPS));

    expect((error as Error).message).toContain('wiring boom');
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteAutoScalingGroupCommand)).toBe(
      true
    );
    expect(createdBeforeFailure(error, 'MyAsg', TYPE)).toBeUndefined();
  });

  it("names nothing when CreateAutoScalingGroup's own failure is thrown", async () => {
    respond({ create: Object.assign(new Error('already exists'), { name: 'AlreadyExists' }) });

    const error = await failure(() => provider.create('MyAsg', TYPE, PROPS));

    expect((error as Error).message).toContain('already exists');
    expect(createdBeforeFailure(error, 'MyAsg', TYPE)).toBeUndefined();
  });

  it('names nothing for a pre-flight refusal', async () => {
    respond({});

    const error = await failure(() =>
      provider.create('MyAsg', TYPE, { ...PROPS, MetricsCollection: 'not-a-list' })
    );

    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyAsg', TYPE)).toBeUndefined();
  });
});
