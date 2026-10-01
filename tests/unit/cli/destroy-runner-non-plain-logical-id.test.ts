import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

// go-to-k/cdkd#4175: a `state.resources` key is state-sourced and validated
// nowhere, and every provider prints it raw on its delete path. The destroy
// runner is one of the two delete callers that gate it: a non-plain key is
// SKIPPED before any provider sees it, the record is KEPT, and the recovery
// command (`cdkd state orphan`, which calls no provider) is still printed.

const debugSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());
const addTaskSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: debugSpy, info: infoSpy, warn: warnSpy, error: errorSpy }),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: addTaskSpy,
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { NON_PLAIN_LOGICAL_ID_SKIP_REASON } from '../../../src/deployment/deploy-engine-delete.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

const REGION = 'us-east-1';
const HOSTILE = 'X$(touch OWNED)';

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    ...extra,
  };
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack refuses a non-plain logical id before any provider (#4175)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const recorded: DeploymentEvent[] = [];

  function makeCtx() {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      eventRecorder: {
        record: (event: DeploymentEvent) => {
          recorded.push(event);
        },
        finalize: vi.fn(),
      },
    };
  }

  /**
   * Every line printed at default verbosity, plus the live label. `debug` is
   * left out: `DagBuilder`'s `--verbose` lines render the key through
   * `displayIdent`, whose JSON quotes still run `$( )` when pasted — a
   * residual outside the delete path, tracked on go-to-k/cdkd#4317.
   */
  function everything(): string {
    return [infoSpy, warnSpy, errorSpy, addTaskSpy]
      .flatMap((spy) => spy.mock.calls.flatMap((c) => c.map((a: unknown) => String(a))))
      .join('\n');
  }
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset().mockResolvedValue(undefined);
    for (const spy of [debugSpy, infoSpy, warnSpy, errorSpy, addTaskSpy]) spy.mockReset();
    recorded.length = 0;
  });

  it('never hands the key to a provider, keeps the record, and still deletes a plain sibling', async () => {
    const result = await runDestroyForStack(
      'TestStack',
      makeState({ [HOSTILE]: res({ physicalId: 'hostile-bucket' }), Bucket: res() }),
      makeCtx()
    );

    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(mockProviderDelete.mock.calls[0]![0]).toBe('Bucket');
    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.errorCount).toBe(0);

    // The record survives the run: the final preserve-write holds it.
    expect(mockDeleteState).not.toHaveBeenCalled();
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(Object.keys(saved.resources)).toEqual([HOSTILE]);
  });

  it('prints the key on no line, and prints the skip and its reason described', async () => {
    await runDestroyForStack(
      'TestStack',
      makeState({ [HOSTILE]: res({ physicalId: 'hostile-bucket' }) }),
      makeCtx()
    );

    const out = stripAnsi(everything());
    // The skip row and its warning were printed, so the absence below is not
    // an absence of output.
    expect(out).toContain(
      `⚠ a logical id that is not a plain identifier (AWS::S3::Bucket) skipped (${NON_PLAIN_LOGICAL_ID_SKIP_REASON})`
    );
    expect(out).toContain('cdkd did not confirm a logical id that is not a plain identifier');
    expect(out).not.toContain('$(');
    expect(out).not.toContain('touch OWNED');
  });

  it('names the recovery command for THIS stack, which removes the record without a provider', async () => {
    await runDestroyForStack(
      'TestStack',
      makeState({ [HOSTILE]: res({ resourceType: 'AWS::CloudFormation::Stack' }) }),
      makeCtx()
    );

    const warned = stripAnsi(warnSpy.mock.calls.map((c) => String(c[0])).join('\n'));
    expect(warned).toContain('Drop the record with: cdkd state orphan TestStack --stack-region us-east-1');
    // A nested-stack row's skip normally names the CHILD's record; a refused
    // key never reached the child, so the target is the parent's own record.
    expect(warned).not.toContain('TestStack~');
  });

  it.each([...PASTE_PAYLOADS.map((p) => p.value), "x';touch OWNED;'"])(
    'a key %s runs nothing when the printed lines are pasted',
    async (value) => {
      await runDestroyForStack('TestStack', makeState({ [value]: res() }), makeCtx());

      expect(mockProviderDelete).not.toHaveBeenCalled();
      const out = stripAnsi(everything());
      expect(out).toContain('a logical id that is not a plain identifier');
      withPasteDir((dir) => {
        expect(spansThatRun(out, dir), value).toEqual([]);
      });
    },
    60_000
  );

  it('records RESOURCE_SKIPPED with the fixed reason', async () => {
    await runDestroyForStack('TestStack', makeState({ [HOSTILE]: res() }), makeCtx());

    const skipped = recorded.filter((e) => e.eventType === 'RESOURCE_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      logicalId: HOSTILE,
      operation: 'DELETE',
      reason: NON_PLAIN_LOGICAL_ID_SKIP_REASON,
    });
    expect(recorded.some((e) => e.eventType === 'RESOURCE_SUCCEEDED')).toBe(false);
  });

  it('still retains a Retain-policy record, describing its key', async () => {
    const result = await runDestroyForStack(
      'TestStack',
      makeState({ [HOSTILE]: res({ deletionPolicy: 'Retain' }) }),
      makeCtx()
    );

    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(result.retainedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    const out = stripAnsi(everything());
    expect(out).toContain('⊘ a logical id that is not a plain identifier (AWS::S3::Bucket) retained');
    expect(out).not.toContain('$(');
  });

  it('describes the key in the rollback-orphan listing, keeping the physical id', async () => {
    const state = makeState({ Bucket: res() });
    state.orphans = [
      { logicalId: HOSTILE, orphanedAt: 1, state: res({ physicalId: 'orphan-bucket-1' }) },
    ];

    await runDestroyForStack('TestStack', state, makeCtx());

    const out = stripAnsi(everything());
    expect(out).toContain(
      '  - a logical id that is not a plain identifier (AWS::S3::Bucket)  orphan-bucket-1'
    );
    expect(out).not.toContain('$(');
  });

  it("describes the key in the destroy's own implicit-dependency debug lines", async () => {
    await runDestroyForStack(
      'TestStack',
      makeState({
        [HOSTILE]: res({ resourceType: 'AWS::EC2::InternetGateway' }),
        Attach: res({ resourceType: 'AWS::EC2::VPCGatewayAttachment' }),
      }),
      makeCtx()
    );

    const implicit = debugSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('Implicit delete dependency'));
    expect(implicit).toEqual([
      'Implicit delete dependency: Attach (AWS::EC2::VPCGatewayAttachment) must be deleted ' +
        'before a logical id that is not a plain identifier (AWS::EC2::InternetGateway)',
    ]);
  });

  it('describes the key in the per-resource (composite-alarm) implicit-dependency debug line', async () => {
    await runDestroyForStack(
      'TestStack',
      makeState({
        Composite: res({
          resourceType: 'AWS::CloudWatch::CompositeAlarm',
          physicalId: 'composite',
          properties: { AlarmRule: 'ALARM("metric-alarm")' },
        }),
        [HOSTILE]: res({ resourceType: 'AWS::CloudWatch::Alarm', physicalId: 'metric-alarm' }),
      }),
      makeCtx()
    );

    const implicit = debugSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('Implicit delete dependency'));
    expect(implicit).toEqual([
      'Implicit delete dependency: Composite (AWS::CloudWatch::CompositeAlarm) must be deleted ' +
        'before a logical id that is not a plain identifier (AWS::CloudWatch::Alarm)',
    ]);
  });

  it('lets a plain id carrying medial `-` / `_` / `.` through to the provider', async () => {
    const result = await runDestroyForStack(
      'TestStack',
      makeState({ 'My-Table': res(), My_Queue: res(), 'My.Topic': res() }),
      makeCtx()
    );

    expect(result.skippedCount).toBe(0);
    expect(result.deletedCount).toBe(3);
    expect(mockProviderDelete.mock.calls.map((c) => c[0]).sort()).toEqual([
      'My-Table',
      'My.Topic',
      'My_Queue',
    ]);
  });
});
