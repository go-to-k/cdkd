/**
 * go-to-k/cdkd#6705: the deploy engine's wiring of the CloudFormation signal
 * receiver. The receiver class is a controllable fake (its own behaviour is
 * pinned in the receiver's tests); the REAL engine, DAG and resolver run.
 *
 * - an armed CREATE completes only after its signals: dependents wait;
 * - a failed wait fails the deploy and the rollback deletes the resource;
 * - the stop callback follows sibling failure; settle runs exactly once;
 * - UPDATE arming (replacing only) and the physical-id-unchanged no-wait;
 * - `--dry-run` and a nested-child-shaped name never build a receiver;
 * - `AWS::StackId` resolves to the receiver's id;
 * - metadata resolution refuses NoEcho and keeps secret tokens verbatim;
 * - an unserved Handle-less WaitCondition is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import {
  refuseUnservedSignalWait,
  resolveTemplateMetadata,
} from '../../../src/deployment/deploy-engine/signal-receiver-run.js';

const fake = vi.hoisted(() => ({
  instances: [] as unknown[],
  events: [] as string[],
  ensureResult: 'arn:aws:cloudformation:us-east-1:123456789012:stack/rcv/receiver-id' as
    | string
    | undefined,
  awaitImpl: undefined as
    | undefined
    | ((id: string, startedAt: number, stop: () => boolean) => Promise<void>),
}));

interface FakeReceiverShape {
  ensure: ReturnType<typeof vi.fn>;
  arm: ReturnType<typeof vi.fn>;
  awaitSignals: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  disarm: ReturnType<typeof vi.fn>;
}

vi.mock('../../../src/deployment/deploy-engine/signal-receiver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/deploy-engine/signal-receiver.js')>();
  class FakeSignalReceiver {
    armedSet = new Set<string>();
    constructor(
      readonly stackName: string,
      readonly candidates: ReadonlyMap<string, { count: number }>
    ) {
      fake.instances.push(this);
    }
    ensure = vi.fn(() => Promise.resolve(fake.ensureResult));
    arm = vi.fn((ids: ReadonlySet<string>) => {
      this.armedSet = new Set(ids);
      return Promise.resolve(ids);
    });
    awaitSignals = vi.fn((id: string, startedAt: number, stop: () => boolean) =>
      fake.awaitImpl ? fake.awaitImpl(id, startedAt, stop) : Promise.resolve()
    );
    settle = vi.fn(() => Promise.resolve());
    disarm = vi.fn((id: string) => {
      this.armedSet.delete(id);
    });
    isArmed(id: string): boolean {
      return this.armedSet.has(id);
    }
    candidate(id: string) {
      return this.candidates.get(id);
    }
  }
  return { ...actual, SignalReceiver: FakeSignalReceiver };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: vi.fn(() =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        )
      ),
    },
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'signal-engine-6705';
const REGION = 'us-east-1';
const RECEIVER_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/rcv/receiver-id';
const CREATION_POLICY = { ResourceSignal: { Count: 1, Timeout: 'PT5M' } };

/** User data sending A's signal SIGNED (`--role`): only then is A armed. */
const SIGNED_SIGNAL_A = {
  'Fn::Base64': '#!/bin/bash\n/opt/aws/bin/cfn-signal -e 0 --stack S --resource A --role R\n',
};

const topic = (extra: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  Type: 'AWS::SNS::Topic',
  Properties: {
    DisplayName: 'x',
    ...(extra['CreationPolicy'] !== undefined && { UserData: SIGNED_SIGNAL_A }),
    ...props,
  },
  ...extra,
});

/** A signalling A, with B and C after it / beside it. */
const signalTemplate = (): CloudFormationTemplate =>
  ({
    Resources: {
      A: topic({ CreationPolicy: CREATION_POLICY }),
      B: topic({ DependsOn: ['A'] }),
    },
  }) as unknown as CloudFormationTemplate;

const asReceiver = (): FakeReceiverShape => {
  expect(fake.instances).toHaveLength(1);
  return fake.instances[0] as FakeReceiverShape;
};

describe('DeployEngine and the CloudFormation signal receiver (go-to-k/cdkd#6705)', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let diffCalculator: DiffCalculator;

  beforeEach(() => {
    vi.clearAllMocks();
    fake.instances.length = 0;
    fake.events.length = 0;
    fake.ensureResult = RECEIVER_ID;
    fake.awaitImpl = undefined;
    diffCalculator = new DiffCalculator();
    provider = {
      create: vi.fn((logicalId: string) => {
        fake.events.push(`create ${logicalId}`);
        return Promise.resolve({ physicalId: `phys-${logicalId}` });
      }),
      update: vi.fn((_l: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue(null),
      saveState: vi.fn().mockResolvedValue('"etag-new"'),
      stackInstanceIdForFirstWrite: vi.fn().mockResolvedValue('3d1f2e4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      diffCalculator,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, captureObservedState: false, ...options },
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const savedStates = (): StackState[] =>
    stateBackend['saveState']!.mock.calls.map((c) => c[2] as StackState);

  it('an armed CREATE gates its dependent: B is created only after the signals arrived', async () => {
    fake.awaitImpl = async (id) => {
      fake.events.push(`await start ${id}`);
      await new Promise((r) => setTimeout(r, 20));
      fake.events.push(`await end ${id}`);
    };
    await makeEngine().deploy(STACK, signalTemplate());
    expect(fake.events).toEqual(['create A', 'await start A', 'await end A', 'create B']);
    const receiver = asReceiver();
    expect(receiver.arm.mock.calls[0]![0]).toEqual(new Set(['A']));
    expect(receiver.awaitSignals).toHaveBeenCalledTimes(1);
    expect(receiver.awaitSignals.mock.calls[0]![0]).toBe('A');
  });

  it('a failed wait fails the deploy; the rollback deletes A and B is never created', async () => {
    fake.awaitImpl = () => Promise.reject(new Error('signals never arrived'));
    await expect(makeEngine().deploy(STACK, signalTemplate())).rejects.toThrow();
    expect(provider['create']).toHaveBeenCalledTimes(1);
    expect(fake.events).toEqual(['create A']);
    expect(provider['delete']).toHaveBeenCalledTimes(1);
    expect(provider['delete']!.mock.calls[0]![0]).toBe('A');
    expect(provider['delete']!.mock.calls[0]![1]).toBe('phys-A');
    expect(asReceiver().settle).toHaveBeenCalledTimes(1);
  });

  it('a sibling failure turns the stop callback true; settle runs once on failure and on success', async () => {
    const t = {
      Resources: { A: topic({ CreationPolicy: CREATION_POLICY }), C: topic() },
    } as unknown as CloudFormationTemplate;
    let stopSeen = false;
    fake.awaitImpl = async (_id, _start, stop) => {
      expect(stop()).toBe(false);
      const deadline = Date.now() + 3000;
      while (!stop() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      stopSeen = stop();
    };
    provider['create']!.mockImplementation((logicalId: string) =>
      logicalId === 'C'
        ? new Promise((_, reject) => setTimeout(() => reject(new Error('C failed')), 40))
        : Promise.resolve({ physicalId: `phys-${logicalId}` })
    );
    await expect(makeEngine().deploy(STACK, t)).rejects.toThrow();
    expect(stopSeen).toBe(true);
    expect(asReceiver().settle).toHaveBeenCalledTimes(1);

    // Success path.
    fake.instances.length = 0;
    fake.awaitImpl = undefined;
    provider['create']!.mockImplementation((logicalId: string) =>
      Promise.resolve({ physicalId: `phys-${logicalId}` })
    );
    await makeEngine().deploy(STACK, signalTemplate());
    expect(asReceiver().settle).toHaveBeenCalledTimes(1);
  });

  it('AWS::StackId resolves to the id ensure() returned on a first deploy, and it is recorded', async () => {
    const t = {
      Resources: {
        A: topic({ CreationPolicy: CREATION_POLICY }, { Tag: { Ref: 'AWS::StackId' } }),
      },
    } as unknown as CloudFormationTemplate;
    await makeEngine().deploy(STACK, t);
    expect(provider['create']!.mock.calls[0]![2]).toMatchObject({ Tag: RECEIVER_ID });
    expect(asReceiver().ensure).toHaveBeenCalledWith(undefined);
    const saves = savedStates();
    expect(saves.length).toBeGreaterThan(0);
    for (const s of saves) expect(s.signalReceiverStackId).toBe(RECEIVER_ID);
  });

  describe('UPDATE arming', () => {
    const existing = (): StackState =>
      ({
        version: 16,
        region: REGION,
        stackName: STACK,
        resources: {
          A: {
            physicalId: 'phys-A-old',
            resourceType: 'AWS::SNS::Topic',
            properties: { DisplayName: 'old' },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        stackInstanceId: '3d1f2e4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
        lastModified: 0,
      }) as StackState;

    const updateTemplate = (): CloudFormationTemplate =>
      ({
        Resources: { A: topic({ CreationPolicy: CREATION_POLICY }, { DisplayName: 'new' }) },
      }) as unknown as CloudFormationTemplate;

    const stubDiff = (requiresReplacement: boolean): void => {
      vi.spyOn(diffCalculator, 'calculateDiff').mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'A',
            {
              logicalId: 'A',
              changeType: 'UPDATE',
              resourceType: 'AWS::SNS::Topic',
              currentProperties: { DisplayName: 'old' },
              desiredProperties: { DisplayName: 'new' },
              propertyChanges: [
                {
                  path: 'DisplayName',
                  oldValue: 'old',
                  newValue: 'new',
                  requiresReplacement,
                },
              ],
            } as unknown as ResourceChange,
          ],
        ])
      );
    };

    it('a replacing UPDATE is armed and waits once the physical id changed', async () => {
      stateBackend['getState']!.mockResolvedValue({ state: existing(), etag: '"e0"' });
      stubDiff(true);
      await makeEngine().deploy(STACK, updateTemplate());
      const receiver = asReceiver();
      expect(receiver.arm.mock.calls[0]![0]).toEqual(new Set(['A']));
      expect(receiver.awaitSignals).toHaveBeenCalledTimes(1);
    });

    it('a non-replacing UPDATE is not armed and does not wait', async () => {
      stateBackend['getState']!.mockResolvedValue({ state: existing(), etag: '"e0"' });
      stubDiff(false);
      await makeEngine().deploy(STACK, updateTemplate());
      const receiver = asReceiver();
      expect(receiver.arm.mock.calls[0]![0]).toEqual(new Set());
      expect(receiver.awaitSignals).not.toHaveBeenCalled();
    });

    it('an armed UPDATE whose physical id did not change does not wait and is disarmed', async () => {
      stateBackend['getState']!.mockResolvedValue({ state: existing(), etag: '"e0"' });
      stubDiff(true);
      // `--replace` deletes first, then the create returns the same id: the
      // record's physical id did not change, so no new resource will signal.
      provider['create']!.mockResolvedValue({ physicalId: 'phys-A-old' });
      await makeEngine({ replace: true }).deploy(STACK, updateTemplate());
      const receiver = asReceiver();
      expect(receiver.arm.mock.calls[0]![0]).toEqual(new Set(['A']));
      expect(receiver.awaitSignals).not.toHaveBeenCalled();
      expect(receiver.disarm).toHaveBeenCalledWith('A');
    });
  });

  it('--dry-run builds no receiver', async () => {
    await makeEngine({ dryRun: true }).deploy(STACK, signalTemplate());
    expect(fake.instances).toHaveLength(0);
  });

  it('a nested-child-shaped stack name (contains ~) builds no receiver', async () => {
    await makeEngine().deploy('Parent~Child', signalTemplate());
    expect(fake.instances).toHaveLength(0);
    expect(provider['create']).toHaveBeenCalledTimes(2);
  });

  describe('resolveTemplateMetadata', () => {
    const run = (template: CloudFormationTemplate) =>
      resolveTemplateMetadata(makeEngine(), 'A', {}, STACK, template, undefined, undefined);

    it('throws when the Metadata reads a NoEcho parameter', async () => {
      const t = {
        Parameters: { Secret: { Type: 'String', NoEcho: true } },
        Resources: {
          A: topic({ Metadata: { 'AWS::CloudFormation::Init': { v: { Ref: 'Secret' } } } }),
        },
      } as unknown as CloudFormationTemplate;
      await expect(run(t)).rejects.toThrow('NoEcho');
    });

    it('keeps a {{resolve:secretsmanager:...}} string verbatim (no AWS call)', async () => {
      const token = '{{resolve:secretsmanager:x}}';
      const t = {
        Resources: { A: topic({ Metadata: { 'AWS::CloudFormation::Init': { v: token } } }) },
      } as unknown as CloudFormationTemplate;
      await expect(run(t)).resolves.toEqual({ 'AWS::CloudFormation::Init': { v: token } });
    });
  });

  describe('refuseUnservedSignalWait', () => {
    const waitTemplate = (properties?: Record<string, unknown>): CloudFormationTemplate =>
      ({
        Resources: {
          W: {
            Type: 'AWS::CloudFormation::WaitCondition',
            CreationPolicy: CREATION_POLICY,
            ...(properties && { Properties: properties }),
          },
        },
      }) as unknown as CloudFormationTemplate;
    const create = {
      logicalId: 'W',
      changeType: 'CREATE',
      resourceType: 'AWS::CloudFormation::WaitCondition',
    } as unknown as ResourceChange;
    const engineWith = (armed: boolean) =>
      ({ signalReceiver: { isArmed: () => armed } }) as unknown as DeployEngine;

    it('refuses a Handle-less WaitCondition CREATE the receiver does not wait on', () => {
      expect(() => refuseUnservedSignalWait(engineWith(false), 'W', create, waitTemplate())).toThrow(
        /no CloudFormation signal receiver waits/
      );
      expect(() =>
        refuseUnservedSignalWait({ signalReceiver: undefined } as unknown as DeployEngine, 'W', create, waitTemplate())
      ).toThrow();
    });

    it('passes when armed', () => {
      expect(() =>
        refuseUnservedSignalWait(engineWith(true), 'W', create, waitTemplate())
      ).not.toThrow();
    });

    it('passes a WaitCondition that has a Handle', () => {
      expect(() =>
        refuseUnservedSignalWait(engineWith(false), 'W', create, waitTemplate({ Handle: 'h' }))
      ).not.toThrow();
    });
  });
});
