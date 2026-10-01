/**
 * go-to-k/cdkd#4175, the deploy-side twin of
 * `tests/unit/cli/destroy-runner-non-plain-logical-id.test.ts`: a template
 * removal's DELETE takes its logical id from a `state.resources` key, which
 * the state-bucket writer chooses, and every provider prints that id raw on its
 * delete path. `provisionDelete` skips a non-plain key before any provider sees
 * it and keeps the record.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { NON_PLAIN_LOGICAL_ID_SKIP_REASON } from '../../../src/deployment/deploy-engine-delete.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));
vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
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

const TYPE = 'AWS::SQS::Queue';
const HOSTILE = 'X$(touch OWNED)';

type Counts = {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  deleteSkipped: number;
  updatePartial: number;
};

describe('DeployEngine template-removal DELETE of a non-plain logical id (#4175)', () => {
  let provider: ResourceProvider;
  let events: DeploymentEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as unknown as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        eventRecorder: {
          runId: 'run-1',
          record: (event: Omit<DeploymentEvent, 'timestamp'>) =>
            events.push(event as DeploymentEvent),
        },
      },
      'us-east-1'
    );
  }

  async function templateDelete(
    logicalId: string,
    record: { deletionPolicy?: 'Retain' } = {},
    type: string = TYPE,
    onEngine?: (engine: InstanceType<typeof DeployEngine>) => void
  ): Promise<{ stateResources: Record<string, unknown>; counts: Counts }> {
    const engine = makeEngine();
    onEngine?.(engine);
    const counts: Counts = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      deleteSkipped: 0,
      updatePartial: 0,
    };
    const stateResources: Record<string, unknown> = {
      [logicalId]: {
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
        resourceType: type,
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
        ...record,
      },
    };
    const change: ResourceChange = { logicalId, changeType: 'DELETE', resourceType: type };
    await (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate,
          parameterValues?: Record<string, unknown>,
          conditions?: Record<string, boolean>,
          counts?: Counts
        ) => Promise<unknown>;
      }
    ).provisionResource(
      logicalId,
      change,
      stateResources,
      'MyStack',
      { Resources: {} },
      undefined,
      undefined,
      counts
    );
    return { stateResources, counts };
  }

  /** What the deploy printed at default verbosity, as a non-TTY log shows it. */
  function printed(): string {
    return (
      [infoSpy, warnSpy, errorSpy]
        .flatMap((spy) => spy.mock.calls.map((c) => c.map((a: unknown) => String(a)).join(' ')))
        .join('\n')
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, '')
    );
  }

  it('skips before any provider, keeps the record, and counts it as delete-skipped', async () => {
    const { stateResources, counts } = await templateDelete(HOSTILE);

    expect(provider.delete).not.toHaveBeenCalled();
    expect(Object.keys(stateResources)).toEqual([HOSTILE]);
    expect(counts.deleteSkipped).toBe(1);
    expect(counts.deleted).toBe(0);
    const skipped = events.filter((e) => e.eventType === 'RESOURCE_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ logicalId: HOSTILE, reason: NON_PLAIN_LOGICAL_ID_SKIP_REASON });
  });

  it('prints the skip described, with the recovery command, and never the key', async () => {
    await templateDelete(HOSTILE);

    const out = printed();
    expect(out).toContain(
      `a logical id that is not a plain identifier (${TYPE}) skipped (${NON_PLAIN_LOGICAL_ID_SKIP_REASON})`
    );
    // The stack is LIVE: no re-run helps, and `state orphan` would drop every
    // record of it, so neither is offered as this record's remedy.
    expect(out).toContain("every 'cdkd deploy' refuses it again");
    expect(out).toContain("'cdkd state orphan' drops EVERY record of the stack");
    expect(out).toContain('Inspect it with: cdkd state show MyStack --stack-region us-east-1');
    expect(out).not.toContain('re-attempts');
    expect(out).not.toContain('Drop the record with:');
    expect(out).not.toContain('touch OWNED');
  });

  it('runs no final-snapshot step for an RDS instance, whose absent policy means Snapshot', async () => {
    let snapshotSpy: ReturnType<typeof vi.fn> | undefined;
    const { counts } = await templateDelete(HOSTILE, {}, 'AWS::RDS::DBInstance', (engine) => {
      snapshotSpy = vi.fn().mockResolvedValue(undefined);
      (engine as unknown as { prepareFinalSnapshotForDelete: unknown }).prepareFinalSnapshotForDelete =
        snapshotSpy;
    });

    expect(counts.deleteSkipped).toBe(1);
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('keeps the plain-key provider-skip remedy (positive control for the split)', async () => {
    (provider.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      outcome: 'skipped',
      reason: 'bad id',
    });
    await templateDelete('MyQueue');

    const out = printed();
    expect(out).toContain("the next 'cdkd deploy' re-attempts the delete");
    expect(out).toContain('Drop the record with: cdkd state orphan MyStack --stack-region us-east-1');
  });

  it.each([...PASTE_PAYLOADS.map((p) => p.value), "x';touch OWNED;'"])(
    'a key %s runs nothing when the printed lines are pasted',
    async (value) => {
      await templateDelete(value);

      expect(provider.delete).not.toHaveBeenCalled();
      const out = printed();
      expect(out).toContain('a logical id that is not a plain identifier');
      withPasteDir((dir) => {
        expect(spansThatRun(out, dir), value).toEqual([]);
      });
    },
    60_000
  );

  it('still drops a Retain-policy record without a provider, describing its key', async () => {
    const { stateResources, counts } = await templateDelete(HOSTILE, { deletionPolicy: 'Retain' });

    expect(provider.delete).not.toHaveBeenCalled();
    expect(stateResources).toEqual({});
    expect(counts.deleteSkipped).toBe(0);
    const out = printed();
    expect(out).toContain('Retaining a logical id that is not a plain identifier');
    expect(out).not.toContain('touch OWNED');
  });

  it('lets a plain id with medial `-` / `_` / `.` through to the provider', async () => {
    for (const id of ['My-Queue', 'My_Queue', 'My.Queue']) {
      const { stateResources, counts } = await templateDelete(id);
      expect(counts.deleted, id).toBe(1);
      expect(stateResources, id).toEqual({});
    }
    expect((provider.delete as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'My-Queue',
      'My_Queue',
      'My.Queue',
    ]);
  });
});
