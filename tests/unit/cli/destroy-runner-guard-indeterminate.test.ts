/**
 * Issue #2301 item 3 -- when a PRE-FLIGHT SAFETY GUARD cannot reach a verdict,
 * cdkd proceeds with the delete and used to say so ONLY through a
 * `logger.warn`. Console output does not survive the run, and the attack the
 * guards exist to catch works by DENYING the probe they depend on (an
 * `s3:GetBucketLocation` `Deny` in a bucket policy, settable by anyone holding
 * `s3:PutBucketPolicy` on the target) -- so afterwards, a destroy that
 * proceeded WITHOUT confirming its target was indistinguishable from one that
 * confirmed it.
 *
 * The fix has two surfaces and BOTH are asserted here: a
 * `RESOURCE_GUARD_INDETERMINATE` event in the durable `deployments/` stream,
 * and a counter on the per-stack destroy summary.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';
const GUARD = {
  guard: 'cc-delete-region-identity',
  reason: 's3:GetBucketLocation on poisoned-bucket could not be answered: AccessDenied',
};

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'poisoned-bucket',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies: [],
    provisionedBy: 'cc-api',
    ...extra,
  };
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 9,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack guard-indeterminate accounting (issue #2301)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const recorded: DeploymentEvent[] = [];

  function makeCtx(withRecorder = true) {
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
      ...(withRecorder && {
        eventRecorder: {
          record: (event: DeploymentEvent) => {
            recorded.push(event);
          },
          finalize: vi.fn(),
        },
      }),
    };
  }

  // Counts in the summary are ANSI-colorized, so every assertion below reads
  // the stripped text -- matching what a user sees in a non-TTY CI log.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = (spy: typeof infoSpy): string[] =>
    spy.mock.calls.flatMap((c) => stripAnsi(String(c[0])).split('\n'));
  const allInfo = (): string => lines(infoSpy).join('\n');
  const allWarn = (): string => lines(warnSpy).join('\n');
  const eventsOfType = (t: string): DeploymentEvent[] => recorded.filter((e) => e.eventType === t);

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    recorded.length = 0;
  });

  it('records RESOURCE_GUARD_INDETERMINATE with the guard id, the reason and the identifiers', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted', indeterminateGuards: [GUARD] });

    await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    const guardEvents = eventsOfType('RESOURCE_GUARD_INDETERMINATE');
    expect(guardEvents).toHaveLength(1);
    expect(guardEvents[0]).toMatchObject({
      stackName: 'TestStack',
      operation: 'DELETE',
      logicalId: 'Bucket',
      resourceType: 'AWS::S3::Bucket',
      provisionedBy: 'cc-api',
      physicalId: 'poisoned-bucket',
      guard: GUARD.guard,
      reason: GUARD.reason,
    });
    // No `error` block: nothing FAILED. A denied probe is the case this event
    // exists for, so dressing it as a failure would misdescribe it.
    expect(guardEvents[0]).not.toHaveProperty('error');
    // ...and no `durationMs` either: the guard ran BEFORE the delete, so the
    // resource's elapsed time is not this row's duration. `toMatchObject` above
    // cannot see an EXTRA field, so the absence needs its own assertion.
    expect(guardEvents[0]).not.toHaveProperty('durationMs');
  });

  it('emits the guard event ALONGSIDE RESOURCE_SUCCEEDED, not instead of it', async () => {
    // The design decision under test. Emitting instead-of would leave the
    // resource's RESOURCE_STARTED with no terminal row, and would contradict
    // the run summary, whose `counts.deleted` is driven by `deletedCount` --
    // which a suppressed guard deliberately does not touch.
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted', indeterminateGuards: [GUARD] });

    const result = await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    expect(eventsOfType('RESOURCE_SUCCEEDED')).toHaveLength(1);
    expect(eventsOfType('RESOURCE_GUARD_INDETERMINATE')).toHaveLength(1);
    expect(result.deletedCount).toBe(1);
    // Ordering is part of the contract a reader of the stream sees: the guard
    // ran BEFORE the delete, so its row precedes the outcome row.
    const types = recorded.map((e) => e.eventType);
    expect(types.indexOf('RESOURCE_GUARD_INDETERMINATE')).toBeLessThan(
      types.indexOf('RESOURCE_SUCCEEDED')
    );
  });

  it('counts the guard WITHOUT touching any outcome counter, and still deletes the state file', async () => {
    // Orthogonality is the whole point: a guard that could not answer says
    // nothing about whether the resource was addressed. If this ever moved
    // `skippedCount`, `cdkd destroy` would exit 2 and preserve state over a
    // destroy that completed -- turning an observability fix into a breakage.
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted', indeterminateGuards: [GUARD] });

    const result = await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    expect(result.guardIndeterminateCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.retainedCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalled();
  });

  it('renders the count on the CLEAN-destroy summary line, which is the arm this case reaches', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted', indeterminateGuards: [GUARD] });

    await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    expect(allInfo()).toContain('Stack TestStack destroyed');
    expect(allInfo()).toContain('1 unverified');
  });

  it('names the resource and points at the durable record in an aggregate warning', async () => {
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted', indeterminateGuards: [GUARD] });

    await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    const warned = allWarn();
    expect(warned).toContain('pre-flight safety check(s) could NOT be completed');
    expect(warned).toContain('Bucket');
    expect(warned).toContain('cdkd events TestStack');
    expect(warned).toContain('RESOURCE_GUARD_INDETERMINATE');
  });

  it('leaves an ordinary destroy byte-identical: no event, no counter, no suffix', async () => {
    // The negative control. A guard arm that fired on everything would satisfy
    // every positive assertion above while making the new row meaningless.
    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    expect(result.guardIndeterminateCount).toBe(0);
    expect(eventsOfType('RESOURCE_GUARD_INDETERMINATE')).toHaveLength(0);
    expect(allInfo()).toContain('Stack TestStack destroyed');
    expect(allInfo()).not.toContain('unverified');
    expect(allWarn()).not.toContain('pre-flight safety check');
  });

  it('records a guard reported ALONGSIDE a skip, and still counts the skip as a skip', async () => {
    mockProviderDelete.mockResolvedValue({
      outcome: 'skipped',
      reason: 'malformed physicalId in state',
      indeterminateGuards: [GUARD],
    });

    const result = await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    expect(result.skippedCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(result.guardIndeterminateCount).toBe(1);
    expect(eventsOfType('RESOURCE_GUARD_INDETERMINATE')).toHaveLength(1);
    expect(eventsOfType('RESOURCE_SKIPPED')).toHaveLength(1);
  });

  it('counts each guard once per resource, across resources', async () => {
    const second = { guard: 'cc-delete-region-identity', reason: 'no region on record' };
    mockProviderDelete.mockImplementation((logicalId: string) =>
      Promise.resolve({
        outcome: 'deleted',
        indeterminateGuards: logicalId === 'Bucket' ? [GUARD] : [second],
      })
    );

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Bucket: res(), Other: res({ physicalId: 'other-bucket' }) }),
      makeCtx()
    );

    expect(result.guardIndeterminateCount).toBe(2);
    expect(eventsOfType('RESOURCE_GUARD_INDETERMINATE')).toHaveLength(2);
    expect(allWarn()).toContain('Bucket');
    expect(allWarn()).toContain('Other');
  });

  it('still counts and warns when NO recorder is supplied (cdkd state destroy)', async () => {
    // `cdkd state destroy` threads no `eventRecorder` at all, so the summary is
    // the ONLY surface it has. Reading the count off the recorder would have
    // left that verb silently unguarded.
    mockProviderDelete.mockResolvedValue({ outcome: 'deleted', indeterminateGuards: [GUARD] });

    const result = await runDestroyForStack(
      'TestStack',
      makeState({ Bucket: res() }),
      makeCtx(false)
    );

    expect(result.guardIndeterminateCount).toBe(1);
    expect(recorded).toHaveLength(0);
    expect(allInfo()).toContain('1 unverified');
  });

  it('DROPS a malformed guard entry rather than counting an unactionable row', async () => {
    mockProviderDelete.mockResolvedValue({
      outcome: 'deleted',
      indeterminateGuards: [{ guard: '', reason: '' }],
    });

    const result = await runDestroyForStack('TestStack', makeState({ Bucket: res() }), makeCtx());

    expect(result.guardIndeterminateCount).toBe(0);
    expect(eventsOfType('RESOURCE_GUARD_INDETERMINATE')).toHaveLength(0);
  });
});
