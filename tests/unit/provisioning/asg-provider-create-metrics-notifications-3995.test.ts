import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3995: `CreateAutoScalingGroup` takes neither `MetricsCollection`
// nor `NotificationConfigurations`, and create() never sent the dedicated APIs,
// so a CDK ASG with `groupMetrics` / `notifications` deployed without either on
// its FIRST deploy. create() now sends one `EnableMetricsCollection` /
// `PutNotificationConfiguration` per entry after the group exists, and retires
// the group (CloudFormation's CREATE_FAILED rollback) when one fails.

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

const warned: string[] = [];
const debugged: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn((message: string) => {
      debugged.push(message);
    }),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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
  PutNotificationConfigurationCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import { ModifyInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import { isAuxiliaryFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const TOPIC_A = 'arn:aws:sns:us-east-1:123456789012:issue3995-a';
const TOPIC_B = 'arn:aws:sns:us-east-1:123456789012:issue3995-b';

const BASE = { AutoScalingGroupName: 'my-asg', MinSize: 0, MaxSize: 1 };

function sent<T>(ctor: new (...args: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c instanceof ctor)
    .map((c) => (c as unknown as { input: Record<string, unknown> }).input);
}

function names(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
}

describe('ASGProvider.create — MetricsCollection / NotificationConfigurations (#3995)', () => {
  let provider: ASGProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    debugged.length = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeAutoScalingGroupsCommand) {
        return Promise.resolve({ AutoScalingGroups: [] });
      }
      return Promise.resolve({});
    });
    provider = new ASGProvider();
  });

  it('enables every MetricsCollection entry after the group exists, one call per entry', async () => {
    await provider.create('MyAsg', TYPE, {
      ...BASE,
      // CDK renders one entry per `GroupMetrics`, all at 1Minute.
      MetricsCollection: [
        { Granularity: '1Minute', Metrics: ['GroupMinSize', 'GroupMaxSize'] },
        { Granularity: '1Minute', Metrics: ['GroupInServiceInstances'] },
        { Granularity: '1Minute' },
      ],
    });
    expect(sent(EnableMetricsCollectionCommand)).toEqual([
      { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: ['GroupMinSize', 'GroupMaxSize'] },
      { AutoScalingGroupName: 'my-asg', Granularity: '1Minute', Metrics: ['GroupInServiceInstances'] },
      { AutoScalingGroupName: 'my-asg', Granularity: '1Minute' },
    ]);
    // Ordering: the group exists before its metrics are enabled.
    expect(names().indexOf('CreateAutoScalingGroupCommand')).toBeLessThan(
      names().indexOf('EnableMetricsCollectionCommand')
    );
    // Neither property is a CreateAutoScalingGroup member.
    const [create] = sent(CreateAutoScalingGroupCommand);
    expect(create).not.toHaveProperty('MetricsCollection');
    expect(create).not.toHaveProperty('NotificationConfigurations');
  });

  it('puts every NotificationConfigurations entry after the group exists, one call per topic', async () => {
    await provider.create('MyAsg', TYPE, {
      ...BASE,
      NotificationConfigurations: [
        { TopicARN: TOPIC_A, NotificationTypes: ['autoscaling:EC2_INSTANCE_LAUNCH'] },
        {
          TopicARN: TOPIC_B,
          NotificationTypes: ['autoscaling:EC2_INSTANCE_TERMINATE', 'autoscaling:TEST_NOTIFICATION'],
        },
      ],
    });
    expect(sent(PutNotificationConfigurationCommand)).toEqual([
      {
        AutoScalingGroupName: 'my-asg',
        TopicARN: TOPIC_A,
        NotificationTypes: ['autoscaling:EC2_INSTANCE_LAUNCH'],
      },
      {
        AutoScalingGroupName: 'my-asg',
        TopicARN: TOPIC_B,
        NotificationTypes: ['autoscaling:EC2_INSTANCE_TERMINATE', 'autoscaling:TEST_NOTIFICATION'],
      },
    ]);
    expect(names().indexOf('CreateAutoScalingGroupCommand')).toBeLessThan(
      names().indexOf('PutNotificationConfigurationCommand')
    );
  });

  it.each([
    ['absent', {}],
    ['null', { MetricsCollection: null, NotificationConfigurations: null }],
    ['empty', { MetricsCollection: [], NotificationConfigurations: [] }],
  ])('sends neither call when both properties are %s', async (_label, extra) => {
    await provider.create('MyAsg', TYPE, { ...BASE, ...extra });
    expect(sent(EnableMetricsCollectionCommand)).toHaveLength(0);
    expect(sent(PutNotificationConfigurationCommand)).toHaveLength(0);
    expect(sent(CreateAutoScalingGroupCommand)).toHaveLength(1);
  });

  describe('a failing create-time call', () => {
    function failOn(ctor: new (...args: never[]) => unknown): void {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof ctor) {
          return Promise.reject(
            Object.assign(new Error('issue3995 wiring failed'), { name: 'ValidationError' })
          );
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
    }

    it('retires the group with ForceDelete and re-throws the original error, marked auxiliary', async () => {
      failOn(PutNotificationConfigurationCommand);
      const error = await provider
        .create('MyAsg', TYPE, {
          ...BASE,
          NotificationConfigurations: [{ TopicARN: TOPIC_A, NotificationTypes: ['x'] }],
        })
        .then(
          () => {
            throw new Error('expected create to fail');
          },
          (e: Error) => e
        );
      expect(error.message).toContain('issue3995 wiring failed');
      expect(isAuxiliaryFailure(error)).toBe(true);
      // The group is gone, so a retried create may run: not marked terminal.
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(sent(DeleteAutoScalingGroupCommand)).toEqual([
        { AutoScalingGroupName: 'my-asg', ForceDelete: true },
      ]);
      // The delete runs after the failed call, and is awaited to completion.
      expect(names().indexOf('PutNotificationConfigurationCommand')).toBeLessThan(
        names().indexOf('DeleteAutoScalingGroupCommand')
      );
      expect(names().lastIndexOf('DescribeAutoScalingGroupsCommand')).toBeGreaterThan(
        names().indexOf('DeleteAutoScalingGroupCommand')
      );
      expect(warned).toHaveLength(0);
    });

    it('stops at the first failing metrics call and sends no notification', async () => {
      failOn(EnableMetricsCollectionCommand);
      await expect(
        provider.create('MyAsg', TYPE, {
          ...BASE,
          MetricsCollection: [{ Granularity: '1Minute' }, { Granularity: '1Minute' }],
          NotificationConfigurations: [{ TopicARN: TOPIC_A, NotificationTypes: ['x'] }],
        })
      ).rejects.toThrow('issue3995 wiring failed');
      expect(sent(EnableMetricsCollectionCommand)).toHaveLength(1);
      expect(sent(PutNotificationConfigurationCommand)).toHaveLength(0);
      expect(sent(DeleteAutoScalingGroupCommand)).toHaveLength(1);
    });



    // code-minor-A: the combined scale-down + protection lift can be refused
    // transiently; the protection is then lifted on its own before the delete.
    it('re-sends a protection-only update when the combined scale-down is refused', async () => {
      let updates = 0;
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof UpdateAutoScalingGroupCommand) {
          updates += 1;
          if (updates === 1) {
            return Promise.reject(
              Object.assign(new Error('Scaling activity in progress'), {
                name: 'ScalingActivityInProgress',
              })
            );
          }
          return Promise.resolve({});
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
      const error = await failure(() =>
        provider.create('MyAsg', TYPE, {
          ...BASE,
          DeletionProtection: 'prevent-all-deletion',
          MetricsCollection: [{ Granularity: '1Minute' }],
        })
      );
      expect(sent(UpdateAutoScalingGroupCommand)).toEqual([
        {
          AutoScalingGroupName: 'my-asg',
          MinSize: 0,
          MaxSize: 0,
          DesiredCapacity: 0,
          DeletionProtection: 'none',
        },
        { AutoScalingGroupName: 'my-asg', DeletionProtection: 'none' },
      ]);
      const order = names();
      expect(order.lastIndexOf('UpdateAutoScalingGroupCommand')).toBeLessThan(
        order.indexOf('DeleteAutoScalingGroupCommand')
      );
      expect(sent(DeleteAutoScalingGroupCommand)).toHaveLength(1);
      // The retire finished, so no survivor note and the error stays retryable.
      expect(error.message).not.toContain('The group was created');
    });

    it('sends no protection-only update when the template set no protection', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof UpdateAutoScalingGroupCommand) {
          return Promise.reject(new Error('Scaling activity in progress'));
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
      await expect(
        provider.create('MyAsg', TYPE, { ...BASE, MetricsCollection: [{ Granularity: '1Minute' }] })
      ).rejects.toThrow('issue3995 wiring failed');
      expect(sent(UpdateAutoScalingGroupCommand)).toHaveLength(1);
      expect(sent(DeleteAutoScalingGroupCommand)).toHaveLength(1);
    });

    // code-nit-B: a flip the first pass could not make is retried on the
    // second, and an accepted one is not repeated.
    it('retries a failed termination-protection flip on the second pass', async () => {
      let deleted = false;
      let flipsOfA = 0;
      mockEc2Send.mockImplementation((command: unknown) => {
        const input = (command as { input: Record<string, unknown> }).input;
        if (input['InstanceId'] === 'i-aaa') {
          flipsOfA += 1;
          if (flipsOfA === 1) return Promise.reject(new Error('RequestLimitExceeded'));
        }
        return Promise.resolve({});
      });
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof DeleteAutoScalingGroupCommand) deleted = true;
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({
            AutoScalingGroups: deleted
              ? []
              : [
                  {
                    AutoScalingGroupName: 'my-asg',
                    Instances: [{ InstanceId: 'i-aaa' }, { InstanceId: 'i-bbb' }],
                  },
                ],
          });
        }
        return Promise.resolve({});
      });
      await expect(
        provider.create('MyAsg', TYPE, { ...BASE, MetricsCollection: [{ Granularity: '1Minute' }] })
      ).rejects.toThrow('issue3995 wiring failed');
      const flipped = mockEc2Send.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof ModifyInstanceAttributeCommand)
        .map((c) => (c as unknown as { input: Record<string, unknown> }).input['InstanceId']);
      // i-aaa failed once and was retried; i-bbb succeeded first time and is
      // not flipped again.
      expect(flipped).toEqual(['i-aaa', 'i-bbb', 'i-aaa']);
    });

    // #796's reason, on this path too: a launch template with
    // DisableApiTermination leaves instances ForceDelete cannot terminate.



    async function failure(run: () => Promise<unknown>): Promise<Error> {
      try {
        await run();
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected create to fail');
    }

    // Scale-to-zero FIRST, in one call that also clears a template-set
    // DeletionProtection, so no launch starts after the instances are listed.
    it('scales the group to zero (clearing DeletionProtection) before listing its instances', async () => {
      failOn(EnableMetricsCollectionCommand);
      await expect(
        provider.create('MyAsg', TYPE, {
          ...BASE,
          DeletionProtection: 'prevent-all-deletion',
          MetricsCollection: [{ Granularity: '1Minute' }],
        })
      ).rejects.toThrow('issue3995 wiring failed');
      expect(sent(UpdateAutoScalingGroupCommand)).toEqual([
        {
          AutoScalingGroupName: 'my-asg',
          MinSize: 0,
          MaxSize: 0,
          DesiredCapacity: 0,
          DeletionProtection: 'none',
        },
      ]);
      const order = names();
      const scale = order.indexOf('UpdateAutoScalingGroupCommand');
      expect(scale).toBeLessThan(order.indexOf('DescribeAutoScalingGroupsCommand', scale));
      expect(order.indexOf('DescribeAutoScalingGroupsCommand', scale)).toBeLessThan(
        order.indexOf('DeleteAutoScalingGroupCommand')
      );
    });

    it('scales to zero without touching DeletionProtection when the template sets none', async () => {
      failOn(EnableMetricsCollectionCommand);
      await expect(
        provider.create('MyAsg', TYPE, { ...BASE, MetricsCollection: [{ Granularity: '1Minute' }] })
      ).rejects.toThrow('issue3995 wiring failed');
      expect(sent(UpdateAutoScalingGroupCommand)).toEqual([
        { AutoScalingGroupName: 'my-asg', MinSize: 0, MaxSize: 0, DesiredCapacity: 0 },
      ]);
    });

    // code-nit-1: a failed scale-down / protection lift still attempts the
    // delete, as `delete()` does; the delete reports its own refusal.
    it('still attempts the delete when the scale-down / protection lift fails', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof UpdateAutoScalingGroupCommand) {
          return Promise.reject(new Error('issue3995 update refused'));
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
      await expect(
        provider.create('MyAsg', TYPE, {
          ...BASE,
          DeletionProtection: 'prevent-force-deletion',
          MetricsCollection: [{ Granularity: '1Minute' }],
        })
      ).rejects.toThrow('issue3995 wiring failed');
      expect(sent(DeleteAutoScalingGroupCommand)).toEqual([
        { AutoScalingGroupName: 'my-asg', ForceDelete: true },
      ]);
    });

    // #796's reason, on this path too: a launch template with
    // DisableApiTermination leaves instances ForceDelete cannot terminate. A
    // launch that was in flight at the first read shows up on the second.
    it('flips termination protection on every listed instance, including one that appears only on the second read', async () => {
      let enumerations = 0;
      let deleted = false;
      mockEc2Send.mockResolvedValue({});
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof DeleteAutoScalingGroupCommand) deleted = true;
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          if (deleted) return Promise.resolve({ AutoScalingGroups: [] });
          enumerations += 1;
          const instances =
            enumerations === 1
              ? [{ InstanceId: 'i-aaa' }]
              : [{ InstanceId: 'i-aaa' }, { InstanceId: 'i-late' }];
          return Promise.resolve({
            AutoScalingGroups: [{ AutoScalingGroupName: 'my-asg', Instances: instances }],
          });
        }
        return Promise.resolve({});
      });
      await expect(
        provider.create('MyAsg', TYPE, { ...BASE, MetricsCollection: [{ Granularity: '1Minute' }] })
      ).rejects.toThrow('issue3995 wiring failed');
      const modified = mockEc2Send.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof ModifyInstanceAttributeCommand)
        .map((c) => (c as unknown as { input: Record<string, unknown> }).input);
      // Each instance flipped exactly once, the late one included.
      expect(modified.map((i) => i['InstanceId'])).toEqual(['i-aaa', 'i-late']);
      for (const input of modified) expect(input['DisableApiTermination']).toEqual({ Value: false });
      expect(enumerations).toBe(2);
    });

    // code-nit-2: the survivor note rides the THROWN error, appended to the
    // wiring failure, not a separate warning.
    it('appends the survivor and the manual retire command to the thrown error when the delete fails', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof DeleteAutoScalingGroupCommand) {
          return Promise.reject(
            Object.assign(new Error('issue3995 delete refused'), { name: 'AccessDenied' })
          );
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
      const error = await failure(() =>
        provider.create('MyAsg', TYPE, { ...BASE, MetricsCollection: [{ Granularity: '1Minute' }] })
      );
      expect(error.message).toMatch(/issue3995 wiring failed.*cdkd could not delete it/s);
      expect(error.message).toContain(
        'aws autoscaling delete-auto-scaling-group --auto-scaling-group-name my-asg --force-delete'
      );
      expect(isAuxiliaryFailure(error)).toBe(true);
      // A survivor makes a retried create meet it and throw "already exists",
      // dropping this note: the error is terminal.
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(warned).toHaveLength(0);
    });

    it('says the delete started, not that it failed, when only the wait times out', async () => {
      failOn(EnableMetricsCollectionCommand);
      vi.spyOn(
        provider as unknown as { waitForGroupDeleted: () => Promise<void> },
        'waitForGroupDeleted'
      ).mockRejectedValue(new Error('Timed out waiting for AutoScalingGroup my-asg to be deleted'));
      const error = await failure(() =>
        provider.create('MyAsg', TYPE, { ...BASE, MetricsCollection: [{ Granularity: '1Minute' }] })
      );
      expect(error.message).toContain('cdkd started deleting it but could not confirm it is gone');
      expect(error.message).not.toContain('cdkd could not delete it');
    });

    it('masks a secret group name in the survivor note', async () => {
      const SECRET_NAME = 'issue3995-secret-asg-name';
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof DeleteAutoScalingGroupCommand) {
          return Promise.reject(new Error(`cannot delete ${SECRET_NAME}`));
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.resolve({ AutoScalingGroups: [] });
        }
        return Promise.resolve({});
      });
      const error = await failure(() =>
        provider.create(
          'MyAsg',
          TYPE,
          { ...BASE, AutoScalingGroupName: SECRET_NAME, MetricsCollection: [{ Granularity: '1Minute' }] },
          {
            maskSecrets: createSecretMasker(
              new Map([[SECRET_NAME, '{{resolve:secretsmanager:asg/name:SecretString:v::}}']])
            ),
          }
        )
      );
      // The survivor note itself is masked (the outer wrap's own groupName
      // interpolation is the engine's `maskSecretsInError` to cover).
      const note = error.message.slice(error.message.indexOf('The group was created'));
      expect(note).toContain('could not delete it');
      expect(note).not.toContain(SECRET_NAME);
    });

    // sec-nit: the post-create ARN read's debug line names the group.
    it('masks a secret group name in the ARN-read debug line', async () => {
      const SECRET_NAME = 'issue3995-secret-arn-read';
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.reject(new Error('Throttled'));
        }
        return Promise.resolve({});
      });
      await provider.create(
        'MyAsg',
        TYPE,
        { ...BASE, AutoScalingGroupName: SECRET_NAME },
        {
          maskSecrets: createSecretMasker(
            new Map([[SECRET_NAME, '{{resolve:secretsmanager:asg/name:SecretString:v::}}']])
          ),
        }
      );
      const log = debugged.join('\n');
      expect(log).toContain('DescribeAutoScalingGroups(');
      expect(log).not.toContain(SECRET_NAME);
    });

    it('masks a secret group name AWS echoes in the instance-enumeration debug line', async () => {
      const SECRET_NAME = 'issue3995-secret-asg-echo';
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof EnableMetricsCollectionCommand) {
          return Promise.reject(new Error('issue3995 wiring failed'));
        }
        if (command instanceof DescribeAutoScalingGroupsCommand) {
          return Promise.reject(new Error(`Throttled reading ${SECRET_NAME}`));
        }
        return Promise.resolve({});
      });
      await expect(
        provider.create(
          'MyAsg',
          TYPE,
          { ...BASE, AutoScalingGroupName: SECRET_NAME, MetricsCollection: [{ Granularity: '1Minute' }] },
          {
            maskSecrets: createSecretMasker(
              new Map([[SECRET_NAME, '{{resolve:secretsmanager:asg/name:SecretString:v::}}']])
            ),
          }
        )
      ).rejects.toThrow('issue3995 wiring failed');
      const log = debugged.join('\n');
      // Non-vacuity: the enumeration failure DID log.
      expect(log).toContain('Could not enumerate instances');
      expect(log).not.toContain(SECRET_NAME);
    });

  });
});
