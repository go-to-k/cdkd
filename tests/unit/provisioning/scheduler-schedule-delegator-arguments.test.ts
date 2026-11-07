/**
 * The `SchedulerScheduleProvider` method bodies live in
 * `src/provisioning/providers/scheduler-schedule/*.ts`; the class keeps one
 * `return f.call(this, ...)` delegator per moved method, and each argument a
 * delegator hands on is a hand-off the split introduced.
 *
 * Every companion function is a pass-through spy on the real one. The first
 * block stubs each spy once and pins, for EVERY delegator, that it calls its
 * own function with the provider as `this`, every argument in declared order,
 * and returns that function's result. The second block runs real bodies end to
 * end and pins the SDK command each sends, by class and input.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/provisioning/providers/scheduler-schedule/shared.js', () =>
  spied('../../../src/provisioning/providers/scheduler-schedule/shared.js')
);
vi.mock('../../../src/provisioning/providers/scheduler-schedule/create.js', () =>
  spied('../../../src/provisioning/providers/scheduler-schedule/create.js')
);
vi.mock('../../../src/provisioning/providers/scheduler-schedule/update.js', () =>
  spied('../../../src/provisioning/providers/scheduler-schedule/update.js')
);
vi.mock('../../../src/provisioning/providers/scheduler-schedule/delete.js', () =>
  spied('../../../src/provisioning/providers/scheduler-schedule/delete.js')
);
vi.mock('../../../src/provisioning/providers/scheduler-schedule/read-state.js', () =>
  spied('../../../src/provisioning/providers/scheduler-schedule/read-state.js')
);

import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import {
  RECORDED_CREATION_DATE_KEY,
  SchedulerScheduleProvider,
} from '../../../src/provisioning/providers/scheduler-schedule-provider.js';
import * as shared from '../../../src/provisioning/providers/scheduler-schedule/shared.js';
import * as create from '../../../src/provisioning/providers/scheduler-schedule/create.js';
import * as update from '../../../src/provisioning/providers/scheduler-schedule/update.js';
import * as del from '../../../src/provisioning/providers/scheduler-schedule/delete.js';
import * as readState from '../../../src/provisioning/providers/scheduler-schedule/read-state.js';

const MODULES: Record<string, Record<string, unknown>> = {
  shared,
  create,
  update,
  delete: del,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['wrapCaughtError', 'shared', 'wrapCaughtError', 3],
  ['toSdkFields', 'shared', 'toSdkFields', 1],
  ['toSdkTarget', 'shared', 'toSdkTarget', 1],
  ['toCfnTarget', 'shared', 'toCfnTarget', 1],
  ['renameItemKeys', 'shared', 'renameItemKeys', 3],
  ['readIdentity', 'shared', 'readIdentity', 2],
  ['creationDateBestEffort', 'shared', 'creationDateBestEffort', 3],
  ['create', 'create', 'create', 4],
  ['wrapUnconfirmedGroupError', 'update', 'wrapUnconfirmedGroupError', 5],
  ['refuseUnconfirmed', 'update', 'refuseUnconfirmed', 6],
  ['confirmRecordedSchedule', 'update', 'confirmRecordedSchedule', 6],
  ['referenceRepointed', 'update', 'referenceRepointed', 2],
  ['update', 'update', 'update', 6],
  ['deleteByRecordedIdentity', 'delete', 'deleteByRecordedIdentity', 5],
  ['delete', 'delete', 'deleteImpl', 5],
  ['getAttribute', 'read-state', 'getAttribute', 4],
  ['readCurrentState', 'read-state', 'readCurrentState', 4],
  ['import', 'read-state', 'importImpl', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set(['constructor', 'getClient', 'groupNameOf', 'sleep']);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

describe('SchedulerScheduleProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(SchedulerScheduleProvider.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${fn} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![fn] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${fn} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const provider = new SchedulerScheduleProvider();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (provider as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(provider);
    });
  }
});

describe('SchedulerScheduleProvider moved bodies send the SDK command the delegator names', () => {
  const TYPE = 'AWS::Scheduler::Schedule';
  const DATE = new Date('2026-01-02T03:04:05.000Z');
  const PROPS = {
    Name: 'my-schedule',
    GroupName: 'my-group',
    ScheduleExpression: 'rate(1 hour)',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: { Arn: 'arn:aws:sqs:us-east-1:123456789012:q', RoleArn: 'arn:aws:iam::1:role/r' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  /** The input of every sent command of `cls`, in send order. */
  function sent(cls: abstract new (...a: never[]) => unknown): unknown[] {
    return mockSend.mock.calls
      .map(([c]) => c as { input: unknown })
      .filter((c) => c instanceof cls)
      .map((c) => c.input);
  }

  function provider(): SchedulerScheduleProvider {
    const p = new SchedulerScheduleProvider();
    p.readBackDelaysMs = [0];
    return p;
  }

  it('create sends CreateSchedule in the group, then reads the creation date back', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateScheduleCommand) return { ScheduleArn: 'arn:s' };
      if (command instanceof GetScheduleCommand) return { CreationDate: DATE };
      return {};
    });
    const result = await provider().create('MySchedule', TYPE, PROPS);
    expect(sent(CreateScheduleCommand)).toEqual([
      {
        Name: 'my-schedule',
        GroupName: 'my-group',
        ScheduleExpression: 'rate(1 hour)',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: PROPS.Target,
      },
    ]);
    expect(sent(GetScheduleCommand)).toEqual([{ Name: 'my-schedule', GroupName: 'my-group' }]);
    expect(result).toEqual({
      physicalId: 'my-schedule',
      attributes: { Arn: 'arn:s', [RECORDED_CREATION_DATE_KEY]: DATE.toISOString() },
    });
  });

  it('update sends UpdateSchedule addressed by the physical id and group', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof UpdateScheduleCommand) return { ScheduleArn: 'arn:s' };
      if (command instanceof GetScheduleCommand) return { CreationDate: DATE };
      return {};
    });
    await provider().update('MySchedule', 'my-schedule', TYPE, PROPS, PROPS);
    expect(sent(UpdateScheduleCommand)).toEqual([
      {
        Name: 'my-schedule',
        GroupName: 'my-group',
        ScheduleExpression: 'rate(1 hour)',
        FlexibleTimeWindow: { Mode: 'OFF' },
        Target: PROPS.Target,
      },
    ]);
  });

  it('delete sends DeleteSchedule in the recorded group', async () => {
    mockSend.mockResolvedValue({});
    await provider().delete('MySchedule', 'my-schedule', TYPE, PROPS);
    expect(sent(DeleteScheduleCommand)).toEqual([{ Name: 'my-schedule', GroupName: 'my-group' }]);
  });

  it('a redacted group is found by listing, reading, then deleting in the matching group', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof ListSchedulesCommand) {
        return { Schedules: [{ Name: 'my-schedule', GroupName: 'found-group' }] };
      }
      if (command instanceof GetScheduleCommand) {
        return { CreationDate: DATE, Target: PROPS.Target };
      }
      return {};
    });
    await provider().delete(
      'MySchedule',
      'my-schedule',
      TYPE,
      { ...PROPS, GroupName: '{{resolve:secretsmanager:s:SecretString:g}}' },
      {
        expectedRegion: 'us-east-1',
        recordedAttributes: { [RECORDED_CREATION_DATE_KEY]: DATE.toISOString() },
      }
    );
    expect(sent(ListSchedulesCommand)).toEqual([{ NamePrefix: 'my-schedule' }]);
    expect(sent(GetScheduleCommand)).toEqual([{ Name: 'my-schedule', GroupName: 'found-group' }]);
    expect(sent(DeleteScheduleCommand)).toEqual([
      { Name: 'my-schedule', GroupName: 'found-group' },
    ]);
  });

  it('readCurrentState and import read the schedule in its group', async () => {
    mockSend.mockResolvedValue({ Name: 'my-schedule', GroupName: 'my-group', Arn: 'arn:s' });
    await provider().readCurrentState('my-schedule', 'MySchedule', TYPE, PROPS);
    await provider().import({
      logicalId: 'MySchedule',
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: PROPS,
      knownPhysicalId: 'my-schedule',
    });
    expect(sent(GetScheduleCommand)).toEqual([
      { Name: 'my-schedule', GroupName: 'my-group' },
      { Name: 'my-schedule', GroupName: 'my-group' },
    ]);
  });

  it('getAttribute reads the schedule by bare name', async () => {
    mockSend.mockResolvedValue({ Arn: 'arn:s' });
    expect(await provider().getAttribute('my-schedule', TYPE, 'Arn', 'MySchedule')).toBe('arn:s');
    expect(sent(GetScheduleCommand)).toEqual([{ Name: 'my-schedule' }]);
  });
});
