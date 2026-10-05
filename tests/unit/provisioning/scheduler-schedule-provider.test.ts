import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
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

import {
  AMBIGUOUS_SCHEDULE_SKIP_REASON,
  NO_REGION_FOR_SCHEDULE_SEARCH_SKIP_REASON,
  RECORDED_CREATION_DATE_KEY,
  SchedulerScheduleProvider,
} from '../../../src/provisioning/providers/scheduler-schedule-provider.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../src/types/resource.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/** Narrow a `readCurrentState` result to its property bag; fails on `RESOURCE_NOT_FOUND`. */
function bagOf(
  r: Record<string, unknown> | ResourceNotFound | undefined
): Record<string, unknown> | undefined {
  expect(r).not.toBe(RESOURCE_NOT_FOUND);
  return r as Record<string, unknown> | undefined;
}
import { withStackName } from '../../../src/provisioning/resource-name.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/** Every family, the opt-in clause break included (go-to-k/cdkd#3950). */
const PAYLOADS = [...PASTE_PAYLOADS, CLAUSE_BREAK_PAYLOAD];
import { hasClauseBreak, isInertUnquoted, shellQuote } from '../../../src/utils/pasteable-command.js';
import { setPasteableAwsProfile } from '../../../src/utils/pasteable-aws-profile.js';

const TYPE = 'AWS::Scheduler::Schedule';
const GROUP = 'my-custom-group';
const SCHED_ARN = `arn:aws:scheduler:us-east-1:123456789012:schedule/${GROUP}/my-sched`;
const CREATED = '2026-10-05T12:34:56.789Z';

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

    it('a pasted GroupName refusal, or the group pair dragged from its brackets, redirects nothing (go-to-k/cdkd#4239)', async () => {
      // Both groups are template-chosen and printed bare; each names a paste
      // harness decoy, so the pre-fix ` -> ` spelling truncated `bucket`.
      const error = await provider
        .update('Sched', 'my-sched', TYPE, { ...BASE_PROPS, GroupName: 'bucket' }, {
          ...BASE_PROPS,
          GroupName: 'name',
        })
        .catch((e: unknown) => e);
      const message = error instanceof Error ? error.message : String(error);
      const pair = /\(([^()]* to [^()]*)\)/.exec(message)?.[1];
      expect(pair).toBe('from name to bucket');
      withPasteDir((dir) => {
        expect(spansThatRun(message, dir)).toEqual([]);
        expect(spansThatRun(pair!, dir)).toEqual([]);
        // CONTROL: the pre-fix spelling of the same pair truncates the decoy.
        expect(spansThatRun('name -> bucket', dir)).not.toEqual([]);
      });
    }, 60_000);

    it('a payload group name is described, not printed, beside cdkd deploy --replace (go-to-k/cdkd#4239)', async () => {
      const messages: Array<{ value: string; message: string }> = [];
      for (const { value } of PAYLOADS) {
        const error = await provider
          .update('Sched', 'my-sched', TYPE, { ...BASE_PROPS, GroupName: value }, { ...BASE_PROPS })
          .catch((e: unknown) => e);
        messages.push({ value, message: error instanceof Error ? error.message : String(error) });
      }
      withPasteDir((dir) => {
        for (const { value, message } of messages) {
          expect(message, value).toContain(
            `(from ${GROUP} to a group name that is not a plain identifier); re-run with`
          );
          expect(message, value).not.toContain(value);
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
    }, 120_000);

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
        "delete it manually: aws scheduler delete-schedule --name my-sched --group-name '<group>'"
      );
    });

    it("carries the run's explicit --profile in the manual delete hint (go-to-k/cdkd#3959)", async () => {
      setPasteableAwsProfile('prod');
      try {
        mockSend.mockResolvedValueOnce({});
        await provider.delete('Sched', 'my-sched', TYPE, undefined);
        const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain(
          "delete it manually: aws --profile prod scheduler delete-schedule --name my-sched --group-name '<group>'"
        );
      } finally {
        setPasteableAwsProfile(undefined);
      }
    });

    /**
     * The manual-recovery hint names a DELETE, so it is the highest-consequence
     * paste in this file, and `physicalId` is a `state.json` value. Issue
     * [#2610]'s review round gave it the same sanitize / shell-quote / suppress
     * treatment the replacement advice gets; these are its both-polarity pins.
     * Before that it was interpolated UNQUOTED, so a name with a space split
     * the arguments and a name with `;` chained a second command.
     */
    it('SHELL-QUOTES an inert id that needs it, and SUPPRESSES one that is not inert (go-to-k/cdkd#4205)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', 'my#sched', TYPE, undefined);
      let warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("--name 'my#sched' --group-name '<group>'");
      // Issue #3136: a bare `<group>` is two shell redirections.
      expect(warned).not.toContain('--group-name <group>');
      // A name that would change the command once unquoted is not named: the
      // quoting held only while the quote parity before it was even.
      childLogger.warn.mockClear();
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', 'my sched; rm -rf /', TYPE, undefined);
      warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toContain('aws scheduler delete-schedule');
      expect(warned).toContain('delete it manually via the console');
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

    it('describes an id with NOTHING renderable left rather than printing it empty', async () => {
      // Without a description the line would read `deleting '' from the
      // default group`, which says a schedule with an EMPTY name rather than
      // one that cannot be named.
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', '\u0000\u0001', TYPE, undefined);
      const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(
        'deleting a schedule whose recorded name is not a plain identifier from the default group'
      );
      expect(warned).not.toContain("deleting '' from");
    });

    /**
     * go-to-k/cdkd#3950: the name used to print as `'${safeId}'`, and
     * `displaySafe` keeps `'`, `;` and `$( )`, so a `'` in a `state.json` name
     * closed cdkd's quote. Now a plain name keeps its quotes, a name the
     * manual hint can print is shown through `shellQuote` exactly as the hint
     * prints it, and any other is described; a non-plain logical id (a
     * `state.json` key) is described. The warning is fed WHOLE to the paste
     * harness, command line included.
     */
    it('never puts a recorded name or logical id inside cdkd quotes (go-to-k/cdkd#3950)', async () => {
      const warnings: Array<{ value: string; message: string }> = [];
      for (const { value } of PAYLOADS) {
        for (const [logicalId, physicalId] of [
          ['Sched', value],
          [value, 'my-sched'],
        ] as const) {
          childLogger.warn.mockClear();
          mockSend.mockResolvedValueOnce({});
          await provider.delete(logicalId, physicalId, TYPE, undefined);
          const message = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
          // Never inside a bare hand-written quote: the name, when shown, is
          // the hint's own `shellQuote` spelling, and the logical id is
          // described.
          // For a value carrying `'`, the bare hand-quoted spelling differs
          // from `shellQuote`'s and must be gone.
          if (value.includes("'")) expect(message, value).not.toContain(`'${value}'`);
          // A name holding a clause break is never printed, in the prose or
          // in the hint's command: a selection could start inside its quotes.
          // Nor is one that is not inert unquoted (go-to-k/cdkd#4205), which
          // every payload family is.
          const breaks = hasClauseBreak(value) || !isInertUnquoted(value);
          expect(message, value).toContain(
            logicalId === value
              ? 'The state record of a Schedule whose logical id is not a plain identifier carries'
              : breaks
                ? 'deleting a schedule whose recorded name is not a plain identifier from the default group.'
                : `deleting ${shellQuote(value)} from the default group.`
          );
          if (physicalId === value) {
            if (breaks) {
              expect(message, value).not.toContain('aws scheduler delete-schedule');
              expect(message, value).not.toContain('touch OWNED');
            } else {
              expect(message, value).toContain(`--name ${shellQuote(value)} --group-name`);
            }
          }
          warnings.push({ value, message });
        }
      }
      expect(warnings).toHaveLength(PAYLOADS.length * 2);
      withPasteDir((dir) => {
        for (const { value, message } of warnings) {
          expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
        }
      });
      // The plain control is byte-identical to before.
      childLogger.warn.mockClear();
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Sched', 'my-sched', TYPE, undefined);
      expect(String(childLogger.warn.mock.calls[0]?.[0])).toContain(
        "State record for Schedule Sched carries no properties — deleting 'my-sched' from the default group."
      );
    }, 60_000);

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

      await expect(provider.getAttribute('my-sched', TYPE, 'Arn', 'MySchedule')).resolves.toBe(
        SCHED_ARN
      );
      const input = sentInput(GetScheduleCommand);
      expect(input).toEqual({ Name: 'my-sched' });
    });

    it('throws an actionable error when the bare-name lookup misses (custom-group schedule)', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(provider.getAttribute('my-sched', TYPE, 'Arn', 'MySchedule')).rejects.toThrow(
        /custom group/
      );
    });

    it('names the LOGICAL id in the lookup failure, the schedule name as its physical id (#4222)', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.getAttribute('my-sched', TYPE, 'Arn', 'MySchedule')
      ).rejects.toMatchObject({ logicalId: 'MySchedule', physicalId: 'my-sched' });
    });

    it('rejects unknown attributes', async () => {
      await expect(provider.getAttribute('my-sched', TYPE, 'Nope', 'MySchedule')).rejects.toThrow(
        /Unknown attribute Nope/
      );
      // The LOGICAL id in the logical-id slot (#4222).
      await expect(
        provider.getAttribute('my-sched', TYPE, 'Nope', 'MySchedule')
      ).rejects.toMatchObject({ logicalId: 'MySchedule', physicalId: 'my-sched' });
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

      const state = bagOf(await provider.readCurrentState('my-sched', 'Sched', TYPE, {}));

      expect(state).toBeDefined();
      expect('GroupName' in state!).toBe(false);
    });

    it('returns RESOURCE_NOT_FOUND when the schedule is gone', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.readCurrentState('my-sched', 'Sched', TYPE, { ...BASE_PROPS })
      ).resolves.toBe(RESOURCE_NOT_FOUND);
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
    // (resolveGetAtt in src/deployment/intrinsic-resolver/getatt.ts), so a
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

    it('records the creation date too, as create() does (go-to-k/cdkd#4275)', async () => {
      mockSend.mockResolvedValueOnce({ Arn: SCHED_ARN, CreationDate: new Date(CREATED) });

      const result = await provider.import({ ...baseInput, knownPhysicalId: 'my-sched' });

      expect(result?.attributes).toEqual({ Arn: SCHED_ARN, [RECORDED_CREATION_DATE_KEY]: CREATED });
    });
  });

  // go-to-k/cdkd#4275: the creation date (with the target ARN) is the
  // schedule's non-secret identity, which update() and delete() confirm a
  // secret-derived GroupName against.
  describe('recorded creation date', () => {
    const TARGET = BASE_PROPS.Target.Arn;
    const ROLE = BASE_PROPS.Target.RoleArn;
    const answer = (handlers: Record<string, (input: Record<string, unknown>) => unknown>) =>
      mockSend.mockImplementation(async (command: unknown) => {
        const { constructor, input } = command as {
          constructor: { name: string };
          input: Record<string, unknown>;
        };
        const handler = handlers[constructor.name];
        if (!handler) throw new Error('unexpected command');
        return handler(input);
      });
    const sentNames = () =>
      mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
    const throttle = () =>
      Object.assign(new Error(`group ${GROUP} is busy`), { name: 'ThrottlingException' });

    beforeEach(() => {
      provider.readBackDelaysMs = [0, 0];
    });

    it('create reads it back from the group it created the schedule in and records it', async () => {
      answer({
        CreateScheduleCommand: () => ({ ScheduleArn: SCHED_ARN }),
        GetScheduleCommand: () => ({ CreationDate: new Date(CREATED) }),
      });

      const result = await provider.create('Sched', TYPE, { ...BASE_PROPS });

      expect(result.attributes).toEqual({ Arn: SCHED_ARN, [RECORDED_CREATION_DATE_KEY]: CREATED });
      expect(sentInput(GetScheduleCommand)).toEqual({ Name: 'my-sched', GroupName: GROUP });
    });

    it('create retries a read-back that lags (NotFound) or is throttled, then records the date (CODE-M3)', async () => {
      let reads = 0;
      answer({
        CreateScheduleCommand: () => ({ ScheduleArn: SCHED_ARN }),
        GetScheduleCommand: () => {
          reads++;
          if (reads === 1) throw notFound();
          if (reads === 2) throw throttle();
          return { CreationDate: new Date(CREATED) };
        },
      });

      const result = await provider.create('Sched', TYPE, { ...BASE_PROPS });

      expect(reads).toBe(3);
      expect(result.attributes).toEqual({ Arn: SCHED_ARN, [RECORDED_CREATION_DATE_KEY]: CREATED });
    });

    it('a read-back that keeps failing does not fail the create; nothing is recorded and the AWS text is not logged', async () => {
      answer({
        CreateScheduleCommand: () => ({ ScheduleArn: SCHED_ARN }),
        GetScheduleCommand: () => {
          throw throttle();
        },
      });
      provider.readBackDelaysMs = [3, 5];
      const sleep = vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep');

      const result = await provider.create('Sched', TYPE, { ...BASE_PROPS });

      expect(result.attributes).toEqual({ Arn: SCHED_ARN });
      // The first read plus one retry per configured delay, each waited first.
      expect(sentNames().filter((n) => n === 'GetScheduleCommand')).toHaveLength(3);
      expect(sleep.mock.calls).toEqual([[3], [5]]);
      const debug = childLogger.debug.mock.calls.map((a) => String(a[0])).join('\n');
      expect(debug).toContain('Could not read the creation date of Schedule Sched (ThrottlingException)');
      expect(debug).not.toContain('is busy');
    });

    it('a read-back failure that is not transient is not retried', async () => {
      answer({
        CreateScheduleCommand: () => ({ ScheduleArn: SCHED_ARN }),
        GetScheduleCommand: () => {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        },
      });

      const result = await provider.create('Sched', TYPE, { ...BASE_PROPS });

      expect(result.attributes).toEqual({ Arn: SCHED_ARN });
      expect(sentNames().filter((n) => n === 'GetScheduleCommand')).toHaveLength(1);
    });

    it('update of a literal group reads the date again from the schedule it just wrote', async () => {
      answer({
        UpdateScheduleCommand: () => ({ ScheduleArn: SCHED_ARN }),
        GetScheduleCommand: () => ({ CreationDate: new Date(CREATED) }),
      });

      const result = await provider.update('Sched', 'my-sched', TYPE, { ...BASE_PROPS }, { ...BASE_PROPS }, {
        recordedAttributes: { Arn: SCHED_ARN },
      });

      expect(result.attributes).toEqual({ Arn: SCHED_ARN, [RECORDED_CREATION_DATE_KEY]: CREATED });
      expect(sentNames()).toEqual(['UpdateScheduleCommand', 'GetScheduleCommand']);
    });

    it('update of a literal group carries the recorded date when the read-back fails', async () => {
      answer({
        UpdateScheduleCommand: () => ({ ScheduleArn: SCHED_ARN }),
        GetScheduleCommand: () => {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        },
      });

      const result = await provider.update('Sched', 'my-sched', TYPE, { ...BASE_PROPS }, { ...BASE_PROPS }, {
        recordedAttributes: { Arn: SCHED_ARN, [RECORDED_CREATION_DATE_KEY]: CREATED },
      });

      expect(result.attributes).toEqual({ Arn: SCHED_ARN, [RECORDED_CREATION_DATE_KEY]: CREATED });
    });

    describe('delete with a redacted GroupName', () => {
      const REF = '{{resolve:secretsmanager:s:SecretString:group}}';
      const ctx = {
        expectedRegion: 'us-east-1',
        recordedAttributes: { [RECORDED_CREATION_DATE_KEY]: CREATED },
      };
      const listed = (...groups: string[]) => ({
        Schedules: [
          ...groups.map((g) => ({ Name: 'my-sched', GroupName: g })),
          // A longer name sharing the prefix is never a candidate.
          { Name: 'my-sched-2', GroupName: 'g-other' },
        ],
      });
      /** Each group's schedule: [creation date, target ARN]. */
      const identities =
        (byGroup: Record<string, [string, string?, string?]>) => (input: Record<string, unknown>) => {
          const entry = byGroup[input['GroupName'] as string];
          if (entry === undefined) throw notFound();
          return {
            CreationDate: new Date(entry[0]),
            Target: { Arn: entry[1] ?? TARGET, RoleArn: entry[2] ?? ROLE },
          };
        };
      const deletes = () =>
        mockSend.mock.calls
          .filter((c) => c[0] instanceof DeleteScheduleCommand)
          .map((c) => (c[0] as { input: unknown }).input);
      const del = (props: Record<string, unknown> = { ...BASE_PROPS, GroupName: REF }, context: object = ctx) =>
        provider.delete('Sched', 'my-sched', TYPE, props, context);
      const caughtDelete = (p: Promise<unknown>) =>
        p.then(
          () => undefined,
          (e: unknown) => e as Error
        );

      for (const recorded of [REF, '***']) {
        it(`finds the schedule by its recorded identity across groups and deletes it there (${recorded})`, async () => {
          answer({
            ListSchedulesCommand: () => listed('g-foreign', 'g-ours'),
            GetScheduleCommand: identities({
              'g-foreign': ['2026-10-05T12:34:57.000Z'],
              'g-ours': [CREATED],
            }),
            DeleteScheduleCommand: () => ({}),
          });

          const result = await del({ ...BASE_PROPS, GroupName: recorded });

          expect(result).toBeUndefined();
          const list = mockSend.mock.calls.find((c) => c[0] instanceof ListSchedulesCommand);
          expect((list![0] as { input: unknown }).input).toEqual({ NamePrefix: 'my-sched' });
          expect(deletes()).toEqual([{ Name: 'my-sched', GroupName: 'g-ours' }]);
        });
      }

      for (const [label, foreign] of [
        ['another target', [CREATED, 'arn:aws:sqs:us-east-1:123456789012:other']],
        // A shared or universal target: only the role tells them apart (SEC-R1).
        ['the same target but another role', [CREATED, TARGET, 'arn:aws:iam::123456789012:role/other']],
      ] as const) {
        it(`the same creation date with ${label} is not ours (SEC-M1, SEC-R1)`, async () => {
          answer({
            ListSchedulesCommand: () => listed('g-foreign', 'g-ours'),
            GetScheduleCommand: identities({ 'g-foreign': [...foreign], 'g-ours': [CREATED] }),
            DeleteScheduleCommand: () => ({}),
          });

          await del();

          expect(deletes()).toEqual([{ Name: 'my-sched', GroupName: 'g-ours' }]);
        });
      }

      it('only a schedule with the recorded date but another target or role: skipped, record KEPT (SEC-R2)', async () => {
        // Possibly ours with its target edited outside cdkd: dropping the record
        // would orphan it, deleting it could delete another environment's.
        answer({
          ListSchedulesCommand: () => listed('g-x'),
          GetScheduleCommand: identities({ 'g-x': [CREATED, TARGET, 'arn:aws:iam::123456789012:role/edited'] }),
        });

        const result = await del();

        expect(result).toEqual({ outcome: 'skipped', reason: AMBIGUOUS_SCHEDULE_SKIP_REASON });
        expect(deletes()).toEqual([]);
        const warn = childLogger.warn.mock.calls.map((a) => String(a[0])).join('\n');
        expect(warn).toContain('carries the recorded creation date but not the recorded target or role');
        expect(warn).not.toContain('g-x');
      });

      it('a recorded target and role that are themselves redacted leave the date to decide', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-ours'),
          GetScheduleCommand: identities({
            'g-ours': [CREATED, 'arn:aws:sqs:us-east-1:123456789012:x', 'arn:aws:iam::123456789012:role/x'],
          }),
          DeleteScheduleCommand: () => ({}),
        });

        await del({
          ...BASE_PROPS,
          GroupName: REF,
          Target: { ...BASE_PROPS.Target, Arn: '***', RoleArn: '{{resolve:secretsmanager:s:SecretString:role}}' },
        });

        expect(deletes()).toEqual([{ Name: 'my-sched', GroupName: 'g-ours' }]);
      });

      it('reads every page of the listing', async () => {
        let page = 0;
        answer({
          ListSchedulesCommand: () =>
            page++ === 0 ? { Schedules: [], NextToken: 't1' } : listed('g-ours'),
          GetScheduleCommand: identities({ 'g-ours': [CREATED] }),
          DeleteScheduleCommand: () => ({}),
        });

        await del();

        const tokens = mockSend.mock.calls
          .filter((c) => c[0] instanceof ListSchedulesCommand)
          .map((c) => (c[0] as { input: { NextToken?: string } }).input.NextToken);
        expect(tokens).toEqual([undefined, 't1']);
        expect(deletes()).toEqual([{ Name: 'my-sched', GroupName: 'g-ours' }]);
      });

      it('no match: listed once more, then gone with a WARNING naming no group, nothing deleted (CODE-M2)', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-foreign'),
          GetScheduleCommand: identities({ 'g-foreign': ['2026-10-05T12:34:57.000Z'] }),
        });

        const result = await del();

        expect(result).toBeUndefined();
        expect(deletes()).toEqual([]);
        expect(sentNames().filter((n) => n === 'ListSchedulesCommand')).toHaveLength(2);
        const warn = childLogger.warn.mock.calls.map((a) => String(a[0])).join('\n');
        expect(warn).toContain('Schedule Sched: no schedule of its name carries the creation date cdkd recorded');
        expect(warn).not.toContain('g-foreign');
      });

      it('no match on the first listing, a match on the second: deleted (CODE-M2)', async () => {
        let lists = 0;
        answer({
          ListSchedulesCommand: () => (lists++ === 0 ? { Schedules: [] } : listed('g-ours')),
          GetScheduleCommand: identities({ 'g-ours': [CREATED] }),
          DeleteScheduleCommand: () => ({}),
        });
        // The re-list waits the first read-back delay, so it can outlast a lag.
        provider.readBackDelaysMs = [7, 0];
        const sleep = vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep');

        await del();

        expect(sleep.mock.calls).toEqual([[7]]);
        expect(deletes()).toEqual([{ Name: 'my-sched', GroupName: 'g-ours' }]);
      });

      it('a record with no stack region: skipped, record kept, nothing listed (CODE-M2)', async () => {
        const result = await del(undefined, { recordedAttributes: ctx.recordedAttributes });

        expect(result).toEqual({ outcome: 'skipped', reason: NO_REGION_FOR_SCHEDULE_SEARCH_SKIP_REASON });
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('two schedules matching the recorded identity: refused, nothing deleted', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-a', 'g-b'),
          GetScheduleCommand: identities({ 'g-a': [CREATED], 'g-b': [CREATED] }),
        });

        await expect(del()).rejects.toThrow('2 schedules of its name match the one cdkd recorded');
        expect(deletes()).toEqual([]);
      });

      it('a failed listing fails the delete naming its class only, nothing deleted', async () => {
        answer({
          ListSchedulesCommand: () => {
            throw Object.assign(new Error('group g-secret is busy'), { name: 'ThrottlingException' });
          },
        });

        const error = await caughtDelete(del());

        expect(error).toBeInstanceOf(ProvisioningError);
        expect(error!.message).toContain('listing the schedules of its name failed (ThrottlingException)');
        expect(error!.message).not.toContain('g-secret');
        expect(deletes()).toEqual([]);
      });

      it('a schedule gone between the listing and its read is skipped (TEST-2)', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-gone', 'g-ours'),
          GetScheduleCommand: identities({ 'g-ours': [CREATED] }),
          DeleteScheduleCommand: () => ({}),
        });

        await del();

        expect(deletes()).toEqual([{ Name: 'my-sched', GroupName: 'g-ours' }]);
      });

      it('a read that fails otherwise fails the delete naming its class only (TEST-2)', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-secret'),
          GetScheduleCommand: () => {
            throw Object.assign(new Error('group g-secret denied'), { name: 'AccessDeniedException' });
          },
        });

        const error = await caughtDelete(del());

        expect(error).toBeInstanceOf(ProvisioningError);
        expect(error!.message).toContain('reading a schedule of its name failed (AccessDeniedException)');
        expect(error!.message).not.toContain('g-secret');
        expect(deletes()).toEqual([]);
      });

      it('a delete answered NotFound is success (TEST-2)', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-ours'),
          GetScheduleCommand: identities({ 'g-ours': [CREATED] }),
          DeleteScheduleCommand: () => {
            throw notFound();
          },
        });

        await expect(del()).resolves.toBeUndefined();
      });

      it('a delete failing otherwise fails naming its class only (TEST-2)', async () => {
        answer({
          ListSchedulesCommand: () => listed('g-secret'),
          GetScheduleCommand: identities({ 'g-secret': [CREATED] }),
          DeleteScheduleCommand: () => {
            throw Object.assign(new Error('group g-secret conflict'), { name: 'ConflictException' });
          },
        });

        const error = await caughtDelete(del());

        expect(error).toBeInstanceOf(ProvisioningError);
        expect(error!.message).toContain('the delete failed (ConflictException)');
        expect(error!.message).not.toContain('g-secret');
      });

      it('a wrong-region client is refused before anything is listed', async () => {
        answer({ ListSchedulesCommand: () => listed('g-ours') });

        await expect(del(undefined, { ...ctx, expectedRegion: 'eu-west-1' })).rejects.toThrow();
        expect(sentNames()).not.toContain('ListSchedulesCommand');
      });

      it('a date state redaction rewrote keeps the redacted-address skip, with no AWS call', async () => {
        // Read as "no date": it would match no schedule, and the delete would
        // then drop the record over the live schedule as "already gone".
        const result = await del(undefined, {
          expectedRegion: 'us-east-1',
          recordedAttributes: { [RECORDED_CREATION_DATE_KEY]: '***-10-05T12:34:56.789Z' },
        });

        expect(result).toMatchObject({ outcome: 'skipped' });
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('a record without the date keeps the redacted-address skip, with no AWS call', async () => {
        const result = await del(undefined, { expectedRegion: 'us-east-1' });

        expect(result).toMatchObject({ outcome: 'skipped' });
        expect(mockSend).not.toHaveBeenCalled();
      });
    });
  });
});
