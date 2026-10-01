import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { StackState } from '../../../src/types/state.js';
import type {
  DeploymentEvent,
  DeploymentEventRecorder,
} from '../../../src/types/deployment-events.js';

const { logInfo, logWarn, logError } = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: logError,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// Live renderer is a no-op in tests (it self-disables on non-TTY, but mock it
// to avoid any stdout writes and keep the test fast / deterministic).
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (fn: () => void) => fn(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { ResourceTimeoutError } from '../../../src/utils/error-handler.js';
import { RESOURCE_TYPE_MAX_LENGTH } from '../../../src/utils/resource-type-shape.js';

/** Collecting recorder that captures every event the runner emits. */
class CollectingRecorder implements DeploymentEventRecorder {
  events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  record(event: Omit<DeploymentEvent, 'timestamp'>): void {
    this.events.push(event);
  }
}

describe('runDestroyForStack - #808 deployment events', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeContext(opts: {
    provider: { delete: ReturnType<typeof vi.fn> };
    recorder: DeploymentEventRecorder;
  }) {
    const stateBackend = {
      deleteState: vi.fn().mockResolvedValue(undefined),
      // No outputs -> needsStrongRefCheck is false, scanActiveConsumers skipped.
    } as unknown as S3StateBackend;
    const lockManager = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as LockManager;
    const providerRegistry = {
      getProviderFor: vi
        .fn()
        .mockReturnValue({ provider: opts.provider, provisionedBy: 'sdk' }),
    } as unknown as ProviderRegistry;
    const baseAwsClients = {} as unknown as AwsClients;

    return {
      stateBackend,
      lockManager,
      providerRegistry,
      baseAwsClients,
      baseRegion: 'us-east-1',
      stateBucket: 'state-bucket',
      skipConfirmation: true,
      eventRecorder: opts.recorder,
    };
  }

  function makeState(resources: StackState['resources']): StackState {
    return {
      version: 7,
      stackName: 'S',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    };
  }

  it('emits RESOURCE_STARTED + RESOURCE_SUCCEEDED on a successful delete', async () => {
    const recorder = new CollectingRecorder();
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const state = makeState({
      Bucket: {
        physicalId: 'phys-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_SUCCEEDED']);
    const succeeded = recorder.events.find((e) => e.eventType === 'RESOURCE_SUCCEEDED')!;
    expect(succeeded.operation).toBe('DELETE');
    expect(succeeded.logicalId).toBe('Bucket');
    expect(succeeded.resourceType).toBe('AWS::S3::Bucket');
    expect(succeeded.physicalId).toBe('phys-bucket');
    expect(succeeded.provisionedBy).toBe('sdk');
    expect(typeof succeeded.durationMs).toBe('number');
  });

  it('emits RESOURCE_FAILED with error metadata when a delete fails', async () => {
    const recorder = new CollectingRecorder();
    const awsErr = new Error('delete blew up') as Error & {
      $metadata?: { requestId?: string };
      Code?: string;
    };
    awsErr.name = 'AccessDeniedException';
    awsErr.$metadata = { requestId: 'req-del-1' };
    awsErr.Code = 'AccessDeniedException';
    // Provider opts out of outer retry (disableOuterRetry) so the failure is
    // emitted after a single attempt — keeps the test off real timers.
    const provider = {
      delete: vi.fn().mockRejectedValue(awsErr),
      disableOuterRetry: true,
    };
    const state = makeState({
      Q: {
        physicalId: 'phys-q',
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.errorCount).toBe(1);
    expect(result.deletedCount).toBe(0);

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_FAILED']);
    const failed = recorder.events.find((e) => e.eventType === 'RESOURCE_FAILED')!;
    expect(failed.operation).toBe('DELETE');
    expect(failed.logicalId).toBe('Q');
    expect(failed.error?.awsErrorCode).toBe('AccessDeniedException');
    expect(failed.error?.requestId).toBe('req-del-1');
    expect(typeof failed.durationMs).toBe('number');
  });

  it('emits RESOURCE_RETAINED (no delete call) for a DeletionPolicy: Retain resource', async () => {
    const recorder = new CollectingRecorder();
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const state = makeState({
      Table: {
        physicalId: 'phys-table',
        resourceType: 'AWS::DynamoDB::Table',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
        deletionPolicy: 'Retain',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.retainedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    // The AWS resource is kept — provider.delete is never called.
    expect(provider.delete).not.toHaveBeenCalled();

    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_RETAINED']);
    const retained = recorder.events[0]!;
    expect(retained.operation).toBe('DELETE');
    expect(retained.logicalId).toBe('Table');
    expect(retained.resourceType).toBe('AWS::DynamoDB::Table');
    expect(retained.provisionedBy).toBe('sdk');
  });

  it('renders a planted retained resource and stack name inert (issue #3811)', async () => {
    // The retained line is printed above the live area, where a planted
    // cursor escape could erase the lines before it.
    const planted = 'X\x1b[1A\x1b[2K\r\n\u202e';
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const state = makeState({
      [`Table${planted}`]: {
        physicalId: 'phys-table',
        resourceType: `AWS::DynamoDB::Table${planted}`,
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
        deletionPolicy: 'Retain',
      },
    });

    await runDestroyForStack(
      `S${planted}`,
      state,
      makeContext({ provider, recorder: new CollectingRecorder() })
    );

    const lines = logInfo.mock.calls.map((c) => String(c[0]));
    const retained = lines.find((l) => l.includes('retained'));
    const acquiring = lines.find((l) => l.includes('Acquiring lock for stack'));
    expect(retained).toContain('TableX');
    expect(acquiring).toContain('"SX');
    for (const line of [retained!, acquiring!.trimStart()]) {
      for (const bad of ['\x1b', '\r', '\n', '\u202e']) expect(line).not.toContain(bad);
    }
  });

  it('never reaches the failed-delete lines with a planted logical id (issues #3811, #4175)', async () => {
    // go-to-k/cdkd#4175: a key that is not a plain identifier is SKIPPED before
    // any provider sees it, so the failed-delete arms this case once drove can
    // no longer be reached by one. What #3811 asked of them still holds over
    // everything the run prints: no planted control character, and the forged
    // `✓ Bar` row on no line of its own.
    const planted = 'X\r\n  ✓ Bar (AWS::S3::Bucket) deleted\x1b[2K‮';
    const resource = (type: string) => ({
      physicalId: 'phys',
      resourceType: type,
      properties: {},
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
    });
    const provider = { delete: vi.fn(async () => { throw new Error('boom'); }) };
    const state = makeState({
      [`Timeout${planted}`]: resource('AWS::SNS::Topic'),
      [`Plain${planted}`]: resource('AWS::SQS::Queue'),
    });

    const result = await runDestroyForStack(
      'S',
      state,
      makeContext({ provider, recorder: new CollectingRecorder() })
    );

    expect(provider.delete).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(2);
    expect(result.errorCount).toBe(0);
    // cdkd's own SGR colour codes stripped; the planted `ESC[2K` is not one.
    const printed = [logInfo, logWarn, logError].flatMap((spy) =>
      // eslint-disable-next-line no-control-regex
      spy.mock.calls.flatMap((c) => c.map((a: unknown) => String(a).replace(/\x1b\[[0-9;]*m/g, '')))
    );
    expect(printed.some((l) => l.includes('a logical id that is not a plain identifier'))).toBe(true);
    for (const line of printed) {
      for (const bad of ['\x1b', '\r', '‮']) expect(line).not.toContain(bad);
      expect(line.split('\n').some((l) => l.trimStart().startsWith('✓ Bar'))).toBe(false);
    }
    // The timeout error itself still describes such an id, for any other caller.
    const body = new ResourceTimeoutError(
      `Timeout${planted}`,
      'AWS::SNS::Topic',
      'us-east-1',
      5,
      'DELETE',
      5
    ).message;
    expect(body).toContain('Resource a logical id that is not a plain identifier (AWS::SNS::Topic)');
    expect(body.split('\n')).toHaveLength(5);
  });

  it('describes a planted resource TYPE in the timeout message, newline or padded (go-to-k/cdkd#3773)', async () => {
    const forged = 'Drop the record with: cdkd destroy --all --force #';
    for (const plantedType of [`AWS::SNS::Topic\n${forged}`, `AWS::SNS::Topic${' '.repeat(80)}${forged}`]) {
      logError.mockClear();
      const provider = {
        delete: vi.fn(async (logicalId: string) => {
          throw new ResourceTimeoutError(logicalId, plantedType, 'us-east-1', 5, 'DELETE', 5);
        }),
      };
      const state = makeState({
        Topic: {
          physicalId: 'phys',
          resourceType: plantedType,
          properties: {},
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      });

      await runDestroyForStack('S', state, makeContext({ provider, recorder: new CollectingRecorder() }));

      const timeoutCall = logError.mock.calls.find((c) => String(c[0]).includes('Failed to delete Topic'))!;
      const body = String(timeoutCall[1]);
      expect(body.split('\n')).toHaveLength(5);
      expect(body).not.toContain('Drop the record with:');
      expect(body).toContain('Resource Topic (a resource type that is not printable as typed)');
      // The per-type remedy cannot name it, so the global form is offered.
      expect(body).toContain("Re-run with a larger --resource-timeout '<DURATION>'");
    }
  });

  it('names a plain id and type, and the per-type remedy only for a three-segment type (positive control)', () => {
    const plain = new ResourceTimeoutError('Topic', 'AWS::SNS::Topic', 'us-east-1', 5, 'DELETE', 5).message;
    expect(plain).toContain('Resource Topic (AWS::SNS::Topic) in us-east-1 timed out');
    expect(plain).toContain("Re-run with --resource-timeout AWS::SNS::Topic='<DURATION>'");
    expect(plain.split('\n')).toHaveLength(5);
    const custom = new ResourceTimeoutError('Cr', 'Custom::Seeder', 'us-east-1', 5, 'CREATE', 5).message;
    expect(custom).toContain('Resource Cr (Custom::Seeder)');
    expect(custom).toContain("Re-run with a larger --resource-timeout '<DURATION>'");
    expect(custom.split('\n')).toHaveLength(5);
    // CloudFormation admits `-`, `_` and `@` after `Custom::`, so such a type
    // is named rather than described.
    const hyphenated = new ResourceTimeoutError('Cr', 'Custom::my-resource_v@2', 'us-east-1', 5, 'CREATE', 5).message;
    expect(hyphenated).toContain('Resource Cr (Custom::my-resource_v@2)');
    expect(hyphenated).toContain("Re-run with a larger --resource-timeout '<DURATION>'");
    expect(hyphenated.split('\n')).toHaveLength(5);
    // Past the CloudFormation `TypeName` limit a well-shaped type is described.
    const long = `AWS::S3::B${'b'.repeat(RESOURCE_TYPE_MAX_LENGTH)}`;
    const overCap = new ResourceTimeoutError('Cr', long, 'us-east-1', 5, 'CREATE', 5).message;
    expect(overCap).not.toContain(long);
    expect(overCap).toContain('Resource Cr (a resource type that is not printable as typed)');
    expect(overCap).toContain("Re-run with a larger --resource-timeout '<DURATION>'");
    expect(overCap.split('\n')).toHaveLength(5);
    const atCap = `AWS::S3::B${'b'.repeat(RESOURCE_TYPE_MAX_LENGTH - 'AWS::S3::B'.length)}`;
    expect(new ResourceTimeoutError('Cr', atCap, 'us-east-1', 5, 'CREATE', 5).message).toContain(`(${atCap})`);
  });

  it('renders a planted type inert in the slow-delete warn (issue #3811)', async () => {
    const planted = 'X\r\n  ✓ Bar (AWS::S3::Bucket) deleted\x1b[2K‮';
    const provider = {
      delete: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50))),
    };
    // A PLAIN key (go-to-k/cdkd#4175 skips any other before the provider, so
    // the slow-delete timer never starts for one); the planted TYPE still
    // reaches the warn.
    const state = makeState({
      Slow: {
        physicalId: 'phys',
        resourceType: `AWS::SNS::Topic${planted}`,
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    await runDestroyForStack('S', state, {
      ...makeContext({ provider, recorder: new CollectingRecorder() }),
      resourceWarnAfterMs: 1,
      resourceTimeoutMs: 10_000,
    });

    const warn = logWarn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('has been deleting'));
    expect(warn).toContain('Slow (');
    expect(warn).toContain('AWS::SNS::TopicX');
    for (const bad of ['\x1b', '\r', '\n', '‮']) expect(warn).not.toContain(bad);
  });

  it('renders a planted stack name inert in the lock-release warning (issue #3811)', async () => {
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeContext({ provider, recorder: new CollectingRecorder() });
    const lockManager = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as LockManager;

    const state = makeState({
      Topic: {
        physicalId: 'phys',
        resourceType: 'AWS::SNS::Topic',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    await runDestroyForStack('S\r\nX‮', state, { ...ctx, lockManager });

    const warn = logWarn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('Failed to release lock'));
    expect(warn).toMatch(/^Failed to release lock for stack "S {2}X": \S/);
  });

  it('treats an already-gone resource as a successful delete (RESOURCE_SUCCEEDED)', async () => {
    const recorder = new CollectingRecorder();
    const provider = {
      delete: vi.fn().mockRejectedValue(new Error('Bucket does not exist')),
      disableOuterRetry: true,
    };
    const state = makeState({
      Bucket: {
        physicalId: 'phys-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    });

    const result = await runDestroyForStack('S', state, makeContext({ provider, recorder }));
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    const types = recorder.events.map((e) => e.eventType);
    expect(types).toEqual(['RESOURCE_STARTED', 'RESOURCE_SUCCEEDED']);
  });

  it('is a no-op when no recorder is supplied (back-compat)', async () => {
    const provider = { delete: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeContext({ provider, recorder: new CollectingRecorder() });
    // Strip the recorder entirely.
    const { eventRecorder: _omit, ...ctxNoRecorder } = ctx;
    const state = makeState({
      Bucket: {
        physicalId: 'phys-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    const result = await runDestroyForStack('S', state, ctxNoRecorder);
    expect(result.deletedCount).toBe(1);
  });

  // The case nothing else in the tree can be (go-to-k/cdkd#3348). The recorder's
  // own unit test never runs the runner; the source-shape fence proves a
  // spelling, not a behaviour. This drives a HOSTILE caught value -- one
  // `String()` throws on -- all the way through the per-resource catch, the
  // retry classifier ahead of it, and the `Promise.all` that awaits the level.
  //
  // It reds on reverting EITHER guard, which is the point: review measured that
  // `retryClassificationText` stringifies the value before the recorder ever
  // sees it, so guarding one site alone leaves the other throwing first and
  // this assertion unchanged.
  it('records a hostile caught value and still deletes the next level', async () => {
    const recorder = new CollectingRecorder();
    const hostile = Object.create(null) as object;
    expect(() => String(hostile), 'the fixture must be a shape String() dies on').toThrow();

    // STAGGERED, so the ordering assertion is about LEVELS rather than about
    // `Object.keys` order: `Parent`'s delete does not settle until `Child`'s
    // rejection has. Review measured that a plain ordered compare passes on a
    // flattened-AND-reordered fixture, i.e. it pinned declaration order, not
    // the level separation the case is named for.
    const deleted: string[] = [];
    let childSettled = false;
    const provider = {
      delete: vi.fn().mockImplementation(async (logicalId: string) => {
        if (logicalId === 'Child') {
          deleted.push(logicalId);
          // Settle on a LATER microtask. Without this the flag is already set
          // by the time a same-level sibling's body runs -- `Child` is
          // dispatched first either way -- so the assertion below passed on a
          // flattened fixture and pinned dispatch order, not level separation.
          await Promise.resolve();
          childSettled = true;
          throw hostile;
        }
        expect(
          childSettled,
          'Parent must be deleted in a LATER level, after Child settled'
        ).toBe(true);
        deleted.push(logicalId);
        return undefined;
      }),
      disableOuterRetry: true,
    };
    const state = makeState({
      Parent: {
        physicalId: 'phys-parent',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
      Child: {
        physicalId: 'phys-child',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        attributes: {},
        dependencies: ['Parent'],
        provisionedBy: 'sdk',
      },
    });

    const ctx = makeContext({ provider, recorder });
    const result = await runDestroyForStack('S', state, ctx);

    // 1. The run was not abandoned: the SECOND level was still attempted.
    //    Asserted as the ORDERED pair, not `toContain` -- review measured that
    //    flattening the fixture to `dependencies: []` left a `toContain` green,
    //    so it passed in a single level and the level-2 claim was unasserted.
    expect(deleted, 'the level after the failure must still be deleted').toEqual([
      'Child',
      'Parent',
    ]);
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(1);

    // 2. The row says what happened, not what stringifying it did. Before the
    //    fix this read `TypeError: Cannot convert object to primitive value`.
    const failed = recorder.events.find((e) => e.eventType === 'RESOURCE_FAILED')!;
    expect(failed, 'expected a RESOURCE_FAILED row for the hostile value').toBeDefined();
    expect(failed.logicalId).toBe('Child');
    expect(failed.error?.name).toBe('UnknownError');
    expect(failed.error?.message).toBe('a value that could not be converted to text');

    // 3. A resource failed, so the record is NOT dropped. Stated as what this
    //    harness proves: the stub has no `saveState`, so the preserve write is
    //    attempted and swallowed -- it is the absence of `deleteState` that is
    //    asserted, and the suite's first case reaches `deleteState`, so this is
    //    not vacuous.
    expect(ctx.stateBackend.deleteState).not.toHaveBeenCalled();
  });
});
