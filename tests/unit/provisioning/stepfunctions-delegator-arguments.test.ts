/**
 * The moved `StepFunctionsProvider` method bodies live in
 * `src/provisioning/providers/stepfunctions/*.ts`; the class keeps one
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

vi.mock('@aws-sdk/client-sfn', async () => {
  const actual = await vi.importActual('@aws-sdk/client-sfn');
  return {
    ...actual,
    SFNClient: vi.fn().mockImplementation(() => ({
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

vi.mock('../../../src/provisioning/providers/stepfunctions/update.js', () =>
  spied('../../../src/provisioning/providers/stepfunctions/update.js')
);
vi.mock('../../../src/provisioning/providers/stepfunctions/read-state.js', () =>
  spied('../../../src/provisioning/providers/stepfunctions/read-state.js')
);

import {
  DescribeStateMachineCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import * as update from '../../../src/provisioning/providers/stepfunctions/update.js';
import * as readState from '../../../src/provisioning/providers/stepfunctions/read-state.js';

const MODULES: Record<string, Record<string, unknown>> = {
  update,
  'read-state': readState,
};

/** [class method, companion module, companion function, declared parameter count] */
const DELEGATORS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['update', 'update', 'update', 6],
  ['applyTagDiff', 'update', 'applyTagDiff', 5],
  ['readCurrentState', 'read-state', 'readCurrentState', 3],
  ['import', 'read-state', 'importImpl', 1],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set([
  'constructor',
  'getClient',
  'getS3Client',
  'create',
  'wrapCaughtError',
  'delete',
  'canonicalizeDriftProperties',
  'canonicalizeDriftPair',
  'getDriftSecretPathAliases',
  'generatedCreateName',
  'holderCreatedAt',
  'buildDefinitionString',
  'fetchDefinitionFromS3',
]);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const SM_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:Sm';

describe('StepFunctionsProvider delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(StepFunctionsProvider.prototype).filter(
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
      const provider = new StepFunctionsProvider();
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

describe('StepFunctionsProvider moved bodies send the SDK command the delegator names', () => {
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

  it('update updates the state machine the physical id names, then diffs its tags', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeStateMachineCommand) return { name: 'Sm', revisionId: 'r1' };
      return {};
    });
    const result = await new StepFunctionsProvider().update(
      'Sm',
      SM_ARN,
      'AWS::StepFunctions::StateMachine',
      { RoleArn: 'arn:aws:iam::123456789012:role/r', DefinitionString: '{"a":1}', Tags: [] },
      { RoleArn: 'arn:aws:iam::123456789012:role/r', Tags: [{ Key: 'gone', Value: 'x' }] }
    );
    expect(sent(UpdateStateMachineCommand)).toEqual([
      {
        stateMachineArn: SM_ARN,
        definition: '{"a":1}',
        roleArn: 'arn:aws:iam::123456789012:role/r',
        loggingConfiguration: undefined,
        tracingConfiguration: undefined,
        encryptionConfiguration: undefined,
      },
    ]);
    expect(sent(UntagResourceCommand)).toEqual([{ resourceArn: SM_ARN, tagKeys: ['gone'] }]);
    expect(sent(DescribeStateMachineCommand)).toEqual([{ stateMachineArn: SM_ARN }]);
    expect(result.attributes).toEqual({ Arn: SM_ARN, Name: 'Sm', StateMachineRevisionId: 'r1' });
  });

  it('applyTagDiff untags the removed keys and tags the set ones', async () => {
    mockSend.mockResolvedValue({});
    await new StepFunctionsProvider().applyTagDiff(
      SM_ARN,
      'AWS::StepFunctions::StateMachine',
      'Sm',
      [
        { Key: 'keep', Value: 'old' },
        { Key: 'gone', Value: 'x' },
      ],
      [{ Key: 'keep', Value: 'new' }]
    );
    expect(sent(UntagResourceCommand)).toEqual([{ resourceArn: SM_ARN, tagKeys: ['gone'] }]);
    expect(sent(TagResourceCommand)).toEqual([
      { resourceArn: SM_ARN, tags: [{ key: 'keep', value: 'new' }] },
    ]);
  });

  it('readCurrentState describes the state machine and lists its tags by the physical id', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeStateMachineCommand) return { name: 'Sm', definition: '{}' };
      return { tags: [] };
    });
    await new StepFunctionsProvider().readCurrentState(
      SM_ARN,
      'Sm',
      'AWS::StepFunctions::StateMachine'
    );
    expect(sent(DescribeStateMachineCommand)).toEqual([{ stateMachineArn: SM_ARN }]);
    expect(sent(ListTagsForResourceCommand)).toEqual([{ resourceArn: SM_ARN }]);
  });

  it('import describes the state machine the known physical id names', async () => {
    mockSend.mockResolvedValue({ name: 'Sm', status: 'ACTIVE' });
    const result = await new StepFunctionsProvider().import({
      knownPhysicalId: SM_ARN,
    } as Parameters<StepFunctionsProvider['import']>[0]);
    expect(sent(DescribeStateMachineCommand)).toEqual([{ stateMachineArn: SM_ARN }]);
    expect(result).toEqual({
      physicalId: SM_ARN,
      attributes: { Arn: SM_ARN, Name: 'Sm', StateMachineRevisionId: 'INITIAL' },
    });
  });
});
