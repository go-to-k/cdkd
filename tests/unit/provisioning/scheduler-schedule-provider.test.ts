import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-scheduler';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-scheduler', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-scheduler')>(
    '@aws-sdk/client-scheduler'
  );
  return {
    ...actual,
    SchedulerClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// Hoisted so the delete-path cases can read the degraded-record WARNING the
// provider emits (issue [#2610] gave its manual-recovery hint the
// sanitize / shell-quote / suppress treatment, and the assertions are on that
// line rather than on "delete did not throw").
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('../../../src/utils/logger.js', () => {
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

import { SchedulerScheduleProvider } from '../../../src/provisioning/providers/scheduler-schedule-provider.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';

const TYPE = 'AWS::Scheduler::Schedule';
const GROUP = 'my-custom-group';
const SCHED_ARN = `arn:aws:scheduler:us-east-1:123456789012:schedule/${GROUP}/my-sched`;

const notFound = () =>
  new ResourceNotFoundException({ message: 'Schedule not found.', Message: 'Schedule not found.', $metadata: {} });

const BASE_PROPS = {
  Name: 'my-sched',
  GroupName: GROUP,
  ScheduleExpression: 'rate(1 hour)',
  FlexibleTimeWindow: { Mode: 'OFF' },
  Target: {
    Arn: 'arn:aws:sqs:us-east-1:123456789012:q',
    RoleArn: 'arn:aws:iam::123456789012:role/r',
    RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
    DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:123456789012:dlq' },
  },
};

function sentInput<T>(command: new (input: T) => unknown): T {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof command);
  expect(call).toBeDefined();
  return (call![0] as { input: T }).input;
}

describe('SchedulerScheduleProvider', () => {
  let provider: SchedulerScheduleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SchedulerScheduleProvider();
  });

  describe('create', () => {
    it('passes GroupName through and returns the schedule name as physicalId with the Arn attribute', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      const result = await provider.create('Sched', TYPE, { ...BASE_PROPS });

      expect(result.physicalId).toBe('my-sched');
      expect(result.attributes).toEqual({ Arn: SCHED_ARN });
      const input = sentInput(CreateScheduleCommand);
      expect(input).toMatchObject({
        Name: 'my-sched',
        GroupName: GROUP,
        ScheduleExpression: 'rate(1 hour)',
        FlexibleTimeWindow: { Mode: 'OFF' },
      });
    });

    it('omits GroupName for default-group schedules', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });
      const { GroupName: _drop, ...props } = BASE_PROPS;

      await provider.create('Sched', TYPE, { ...props });

      const input = sentInput(CreateScheduleCommand) as unknown as Record<string, unknown>;
      expect('GroupName' in input).toBe(false);
    });

    it('generates a stack-scoped name when the template omits Name', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });
      const { Name: _drop, ...props } = BASE_PROPS;

      const result = await withStackName('MyStack', () => provider.create('Sched', TYPE, props));

      expect(result.physicalId).toContain('MyStack');
      expect(result.physicalId.length).toBeLessThanOrEqual(64);
      expect(result.physicalId).toMatch(/^[0-9a-zA-Z\-_.]+$/);
    });

    it('threads every optional field to the SDK input (full-replace API contract)', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      await provider.create('Sched', TYPE, {
        ...BASE_PROPS,
        Description: 'my desc',
        ScheduleExpressionTimezone: 'Asia/Tokyo',
        State: 'DISABLED',
        KmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc',
      });

      const input = sentInput(CreateScheduleCommand);
      expect(input).toMatchObject({
        Description: 'my desc',
        ScheduleExpressionTimezone: 'Asia/Tokyo',
        State: 'DISABLED',
        KmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc',
      });
    });

    it('wraps a create failure in ProvisioningError with the logicalId', async () => {
      mockSend.mockRejectedValueOnce(new Error('quota exceeded'));

      await expect(provider.create('Sched', TYPE, { ...BASE_PROPS })).rejects.toThrow(
        /Failed to create Schedule Sched: quota exceeded/
      );
    });

    it('converts ISO-string StartDate/EndDate to Date for the SDK', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      await provider.create('Sched', TYPE, {
        ...BASE_PROPS,
        StartDate: '2026-08-01T00:00:00Z',
        EndDate: '2026-09-01T00:00:00Z',
      });

      const input = sentInput(CreateScheduleCommand) as { StartDate: Date; EndDate: Date };
      expect(input.StartDate).toBeInstanceOf(Date);
      expect(input.StartDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(input.EndDate).toBeInstanceOf(Date);
    });
  });

  describe('update', () => {
    it('sends the full desired configuration addressed by Name + GroupName', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      const result = await provider.update(
        'Sched',
        'my-sched',
        TYPE,
        { ...BASE_PROPS, ScheduleExpression: 'rate(2 hours)' },
        { ...BASE_PROPS }
      );

      expect(result.physicalId).toBe('my-sched');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({ Arn: SCHED_ARN });
      const input = sentInput(UpdateScheduleCommand);
      expect(input).toMatchObject({
        Name: 'my-sched',
        GroupName: GROUP,
        ScheduleExpression: 'rate(2 hours)',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: BASE_PROPS.Target,
      });
    });

    it('converts ECS target sub-shapes on the update path too (#1382)', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      await provider.update(
        'Sched',
        'my-sched',
        TYPE,
        {
          ...BASE_PROPS,
          Target: {
            Arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
            RoleArn: 'arn:aws:iam::123456789012:role/r',
            EcsParameters: {
              TaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/td:1',
              NetworkConfiguration: { AwsvpcConfiguration: { Subnets: ['subnet-1'] } },
            },
          },
        },
        { ...BASE_PROPS }
      );

      const input = sentInput(UpdateScheduleCommand) as unknown as {
        Target: { EcsParameters: Record<string, unknown> };
      };
      expect(input.Target.EcsParameters['NetworkConfiguration']).toEqual({
        awsvpcConfiguration: { Subnets: ['subnet-1'] },
      });
    });

    it('passes a non-ECS target through unchanged', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      await provider.update('Sched', 'my-sched', TYPE, { ...BASE_PROPS }, { ...BASE_PROPS });

      const input = sentInput(UpdateScheduleCommand);
      expect(input).toMatchObject({ Target: BASE_PROPS.Target });
    });

    it('rejects a GroupName change with the typed ResourceUpdateNotSupportedError before any API call', async () => {
      await expect(
        provider.update(
          'Sched',
          'my-sched',
          TYPE,
          { ...BASE_PROPS, GroupName: 'other-group' },
          { ...BASE_PROPS }
        )
      ).rejects.toMatchObject({
        name: 'ResourceUpdateNotSupportedError',
        resourceType: TYPE,
        logicalId: 'Sched',
      });

      // No API call was attempted — the guard fires before UpdateSchedule.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('treats a custom-group -> default-group move as a GroupName change too', async () => {
      const { GroupName: _drop, ...noGroup } = BASE_PROPS;
      await expect(
        provider.update('Sched', 'my-sched', TYPE, { ...noGroup }, { ...BASE_PROPS })
      ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });
    });
  });

  describe('delete', () => {
    it('addresses the delete with Name + GroupName from the state properties', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('Sched', 'my-sched', TYPE, { ...BASE_PROPS });

      const input = sentInput(DeleteScheduleCommand);
      expect(input).toEqual({ Name: 'my-sched', GroupName: GROUP });
    });

    it('treats NotFound as idempotent success when the region matches', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('Sched', 'my-sched', TYPE, { ...BASE_PROPS }, { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
    });

    it('surfaces NotFound when the client region differs from the state region', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('Sched', 'my-sched', TYPE, { ...BASE_PROPS }, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(/eu-west-1/);
    });

    it('warns and deletes from the default group when the state record has no properties', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('Sched', 'my-sched', TYPE, undefined);

      const input = sentInput(DeleteScheduleCommand) as unknown as Record<string, unknown>;
      expect(input).toEqual({ Name: 'my-sched' });
      // The degraded-record warning names the manual escape hatch — a
      // custom-group schedule cannot be addressed without properties.
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(
        'delete it manually: aws scheduler delete-schedule --name my-sched --group-name <group>'
      );
    });

    /**
     * The manual-recovery hint names a DELETE, so it is the highest-consequence
     * paste in this file, and `physicalId` is a `state.json` value. Issue
     * [#2610]'s review round gave it the same sanitize / shell-quote / suppress
     * treatment the replacement advice gets; these are its both-polarity pins.
     * Before that it was interpolated UNQUOTED, so a name with a space split
     * the arguments and a name with `;` chained a second command.
     */
    it('SHELL-QUOTES a physical id that needs it in the manual delete hint', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', 'my sched; rm -rf /', TYPE, undefined);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("--name 'my sched; rm -rf /' --group-name <group>");
    });

    it('SUPPRESSES the manual delete hint when the id cannot be reproduced safely', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', 'sched\u001b[2K\u000awhoami', TYPE, undefined);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      // No command at all: one naming the sanitized id would delete a
      // DIFFERENT schedule.
      expect(warned).not.toContain('aws scheduler delete-schedule');
      expect(warned).toContain('delete it manually via the console');
      // ...and nothing forging a line survives into the warning either.
      expect(warned).not.toContain('\u001b');
      expect(warned).not.toContain('\u000a');
    });

    it('renders <unrenderable> for an id with NOTHING renderable left', async () => {
      // The `|| UNRENDERABLE` arm, matching `lock-manager.ts` in this same PR.
      // Without it the line reads `deleting '' from the default group`, which
      // says a schedule with an EMPTY name rather than one that cannot be
      // named.
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', '\u0000\u0001', TYPE, undefined);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("deleting '<unrenderable>' from the default group");
      expect(warned).not.toContain("deleting '' from");
    });

    it('wraps a non-NotFound failure in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('throttled'));

      await expect(provider.delete('Sched', 'my-sched', TYPE, { ...BASE_PROPS })).rejects.toThrow(
        /Failed to delete Schedule Sched: throttled/
      );
    });
  });

  describe('getAttribute', () => {
    it('resolves Arn via GetSchedule (default-group fallback)', async () => {
      mockSend.mockResolvedValueOnce({ Arn: SCHED_ARN });

      await expect(provider.getAttribute('my-sched', TYPE, 'Arn')).resolves.toBe(SCHED_ARN);
      const input = sentInput(GetScheduleCommand);
      expect(input).toEqual({ Name: 'my-sched' });
    });

    it('throws an actionable error when the bare-name lookup misses (custom-group schedule)', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(provider.getAttribute('my-sched', TYPE, 'Arn')).rejects.toThrow(
        /custom group/
      );
    });

    it('rejects unknown attributes', async () => {
      await expect(provider.getAttribute('my-sched', TYPE, 'Nope')).rejects.toThrow(
        /Unknown attribute Nope/
      );
    });
  });

  describe('ECS target sub-shape conversion (#1382)', () => {
    const CFN_ECS_TARGET = {
      Arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
      RoleArn: 'arn:aws:iam::123456789012:role/r',
      EcsParameters: {
        TaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/td:1',
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            Subnets: ['subnet-1', 'subnet-2'],
            AssignPublicIp: 'ENABLED',
          },
        },
        PlacementStrategy: [{ Type: 'spread', Field: 'attribute:ecs.availability-zone' }],
        PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:x == y' }],
        CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 2, Base: 1 }],
      },
    };

    it('converts CFn spellings to the SDK shape on CreateSchedule', async () => {
      mockSend.mockResolvedValueOnce({ ScheduleArn: SCHED_ARN });

      await provider.create('Sched', TYPE, { ...BASE_PROPS, Target: CFN_ECS_TARGET });

      const input = sentInput(CreateScheduleCommand) as unknown as {
        Target: { EcsParameters: Record<string, unknown> };
      };
      const ecs = input.Target.EcsParameters;
      expect(ecs['NetworkConfiguration']).toEqual({
        awsvpcConfiguration: { Subnets: ['subnet-1', 'subnet-2'], AssignPublicIp: 'ENABLED' },
      });
      expect(ecs['PlacementStrategy']).toEqual([
        { type: 'spread', field: 'attribute:ecs.availability-zone' },
      ]);
      expect(ecs['PlacementConstraints']).toEqual([
        { type: 'memberOf', expression: 'attribute:x == y' },
      ]);
      expect(ecs['CapacityProviderStrategy']).toEqual([
        { capacityProvider: 'FARGATE_SPOT', weight: 2, base: 1 },
      ]);
      expect(ecs['TaskDefinitionArn']).toBe(
        'arn:aws:ecs:us-east-1:123456789012:task-definition/td:1'
      );
    });

    it('maps the SDK spellings back to CFn shape in readCurrentState (no phantom drift)', async () => {
      mockSend.mockResolvedValueOnce({
        Name: 'my-sched',
        GroupName: GROUP,
        ScheduleExpression: 'rate(1 hour)',
        Target: {
          Arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
          RoleArn: 'arn:aws:iam::123456789012:role/r',
          EcsParameters: {
            TaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/td:1',
            LaunchType: 'FARGATE',
            NetworkConfiguration: {
              awsvpcConfiguration: { Subnets: ['subnet-1', 'subnet-2'], AssignPublicIp: 'ENABLED' },
            },
            PlacementStrategy: [{ type: 'spread', field: 'attribute:ecs.availability-zone' }],
            PlacementConstraints: [{ type: 'memberOf', expression: 'attribute:x == y' }],
            CapacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 2, base: 1 }],
          },
        },
      });

      const state = await provider.readCurrentState('my-sched', 'Sched', TYPE, {
        ...BASE_PROPS,
        Target: CFN_ECS_TARGET,
      });

      expect((state as Record<string, unknown>)['Target']).toMatchObject({
        EcsParameters: {
          NetworkConfiguration: {
            AwsvpcConfiguration: { Subnets: ['subnet-1', 'subnet-2'], AssignPublicIp: 'ENABLED' },
          },
          PlacementStrategy: [{ Type: 'spread', Field: 'attribute:ecs.availability-zone' }],
          PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:x == y' }],
          CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 2, Base: 1 }],
        },
      });
    });
  });

  describe('readCurrentState', () => {
    it('addresses the read with the state-recorded GroupName and maps the response to CFn shape', async () => {
      mockSend.mockResolvedValueOnce({
        Name: 'my-sched',
        GroupName: GROUP,
        ScheduleExpression: 'rate(1 hour)',
        State: 'ENABLED',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: BASE_PROPS.Target,
        StartDate: new Date('2026-08-01T00:00:00Z'),
      });

      const state = await provider.readCurrentState('my-sched', 'Sched', TYPE, {
        ...BASE_PROPS,
      });

      const input = sentInput(GetScheduleCommand);
      expect(input).toEqual({ Name: 'my-sched', GroupName: GROUP });
      expect(state).toMatchObject({
        Name: 'my-sched',
        GroupName: GROUP,
        ScheduleExpression: 'rate(1 hour)',
        StartDate: '2026-08-01T00:00:00.000Z',
      });
    });

    it('KEEPS an explicit default GroupName when the state properties carry it (no phantom drift)', async () => {
      mockSend.mockResolvedValueOnce({
        Name: 'my-sched',
        GroupName: 'default',
        ScheduleExpression: 'rate(1 hour)',
      });

      const state = await provider.readCurrentState('my-sched', 'Sched', TYPE, {
        GroupName: 'default',
        ScheduleExpression: 'rate(1 hour)',
      });

      expect(state).toMatchObject({ GroupName: 'default' });
    });

    it('drops the default GroupName from the read-back (template omission must not drift)', async () => {
      mockSend.mockResolvedValueOnce({
        Name: 'my-sched',
        GroupName: 'default',
        ScheduleExpression: 'rate(1 hour)',
      });

      const state = await provider.readCurrentState('my-sched', 'Sched', TYPE, {});

      expect(state).toBeDefined();
      expect('GroupName' in state!).toBe(false);
    });

    it('returns undefined (drift unknown) when the schedule is gone', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.readCurrentState('my-sched', 'Sched', TYPE, { ...BASE_PROPS })
      ).resolves.toBeUndefined();
    });
  });

  describe('import', () => {
    const baseInput = {
      logicalId: 'Sched',
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { ...BASE_PROPS },
    };

    it('verifies an explicit physical id inside the template GroupName and returns the Arn', async () => {
      mockSend.mockResolvedValueOnce({ Arn: SCHED_ARN });

      const result = await provider.import({ ...baseInput, knownPhysicalId: 'my-sched' });

      expect(result).toEqual({ physicalId: 'my-sched', attributes: { Arn: SCHED_ARN } });
      const input = sentInput(GetScheduleCommand);
      expect(input).toEqual({ Name: 'my-sched', GroupName: GROUP });
    });

    it('falls back to the template Name property when no override is supplied', async () => {
      mockSend.mockResolvedValueOnce({ Arn: SCHED_ARN });

      const result = await provider.import({ ...baseInput });

      expect(result?.physicalId).toBe('my-sched');
    });

    // `cdkd import` now PERSISTS the returned attribute map (issue #1098), so
    // an empty-string placeholder is no longer harmless. The intrinsic
    // resolver treats any non-undefined flat attribute as a hit
    // (resolveGetAtt in src/deployment/intrinsic-function-resolver.ts), so a
    // stored `Arn: ''` would shadow constructAttribute's fallback and make
    // Fn::GetAtt resolve to the empty string. Omit the key instead.
    it('omits Arn entirely when the read-back has no Arn (never stores an empty string)', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.import({ ...baseInput, knownPhysicalId: 'my-sched' });

      expect(result).toEqual({ physicalId: 'my-sched', attributes: {} });
      expect(result?.attributes).not.toHaveProperty('Arn');
    });

    it('returns null when the named schedule does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(provider.import({ ...baseInput, knownPhysicalId: 'my-sched' })).resolves.toBeNull();
    });

    it('returns null when neither an override nor a template Name is available (no tag lookup)', async () => {
      const { Name: _drop, ...props } = BASE_PROPS;

      await expect(provider.import({ ...baseInput, properties: props })).resolves.toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
