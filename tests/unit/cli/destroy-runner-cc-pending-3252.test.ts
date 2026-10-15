import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#3252: `cdkd destroy` settles a Cloud Control CREATE a failed
// deploy stopped waiting for BEFORE it reads the journal for its orphans, so
// a create that made its resource is deleted with the stack instead of
// swept away with the journal, and one still unknown refuses the destroy.

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const resumeSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
const constructedInRegion = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('../../../src/provisioning/cloud-control-provider.js', async () => {
  const { currentStackAwsScope } = await import('../../../src/utils/stack-aws-scope.js');
  return {
  CloudControlProvider: vi.fn(() => (constructedInRegion.push(currentStackAwsScope()?.region), {
    resumeAbandonedRequest: resumeSpy,
    buildResumeCommand: () =>
      Promise.resolve('aws cloudcontrol get-resource-request-status --request-token tok'),
  })),
  };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
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

// The registry schema the settle classifies an identifier by: a VPC id is
// minted (unique), a log group's id is its name.
const SCHEMA: Record<string, { fields: string[]; readOnly: string[] }> = {
  'AWS::EC2::VPC': { fields: ['VpcId'], readOnly: ['VpcId'] },
  'AWS::Logs::LogGroup': { fields: ['LogGroupName'], readOnly: ['Arn'] },
};
vi.mock('../../../src/provisioning/cc-import-identifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/cc-import-identifier.js')>()),
  getPrimaryIdentifierFields: (type: string) => Promise.resolve(SCHEMA[type]?.fields),
}));
vi.mock('../../../src/provisioning/read-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/read-only-properties.js')>()),
  getTopLevelReadOnlyProperties: (type: string) =>
    Promise.resolve(SCHEMA[type] && new Set(SCHEMA[type].readOnly)),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';

const pendingOp = {
  logicalId: 'Group',
  changeType: 'CREATE',
  resourceType: 'AWS::Logs::LogGroup',
  provisionedBy: 'cc-api',
  deletionPolicy: 'Delete',
  attemptedProperties: {},
  pendingCloudControlRequest: { requestToken: 'tok', abandonedAt: 1 },
};

function state(): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: {},
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack: a journaled abandoned Cloud Control CREATE (#3252)', () => {
  let journal: { segments: Array<{ failedOperations?: unknown[] } & Record<string, unknown>> } & Record<
    string,
    unknown
  >;
  const order: string[] = [];
  const mockProviderDelete = vi.fn();
  const mockDeleteState = vi.fn();

  function makeCtx() {
    return {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: mockDeleteState,
        getState: vi.fn().mockResolvedValue({ state: state(), etag: 'e' }),
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        rewriteRollbackJournalFailedOperations: vi.fn(
          async (_s: string, _r: string, rewrite: (op: unknown) => unknown) => {
            order.push('rewrite');
            for (const seg of journal.segments) {
              seg.failedOperations = (seg.failedOperations ?? [])
                .map((op) => rewrite(op))
                .filter((op) => op !== null);
            }
            return 1;
          }
        ),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn(async () => {
          order.push('lock');
          return true;
        }),
        releaseLock: vi.fn(async () => {
          order.push('release');
        }),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete }, provisionedBy: 'cc-api' }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };
  }

  beforeEach(() => {
    order.length = 0;
    journal = {
      journalVersion: 1,
      stackName: 'TestStack',
      region: REGION,
      segments: [
        {
          timestamp: 1,
          reason: 'auto-rollback-clean',
          initialDeploy: false,
          operations: [],
          failedOperations: [structuredClone(pendingOp)],
        },
      ],
    };
    resumeSpy.mockReset();
    mockProviderDelete.mockReset().mockImplementation(async () => {
      order.push('delete');
    });
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  it('a create that made its resource is settled under the lock, then deleted with the stack', async () => {
    // A type whose physical id AWS mints uniquely needs no identity proof.
    journal.segments[0]!.failedOperations = [
      { ...structuredClone(pendingOp), logicalId: 'Vpc', resourceType: 'AWS::EC2::VPC' },
    ];
    resumeSpy.mockResolvedValue({ status: 'succeeded', identifier: 'vpc-0abc' });
    const result = await runDestroyForStack('TestStack', state(), makeCtx());
    expect(resumeSpy).toHaveBeenCalledWith('tok', 'Vpc', 'AWS::EC2::VPC');
    // The settle holds its own lock; the delete comes after it, under the
    // destroy's.
    expect(order.slice(0, 3)).toEqual(['lock', 'rewrite', 'release']);
    expect(mockProviderDelete.mock.calls.map((c) => c[1])).toEqual(['vpc-0abc']);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledOnce();
  });

  it('a name-keyed resource it made is named for the operator, never deleted unproven (#4655)', async () => {
    resumeSpy.mockResolvedValue({ status: 'succeeded', identifier: 'my-group' });
    await runDestroyForStack('TestStack', state(), makeCtx());
    expect(mockProviderDelete).not.toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map(String).join('\n');
    expect(warned).toContain('made my-group');
    expect(warned).toMatch(/Skipping failed CREATE of Group .*my-group/);
  });

  it('a request still unknown refuses the destroy: the journal holding it is not swept', async () => {
    resumeSpy.mockResolvedValue({ status: 'unresolved', error: new Error('IN_PROGRESS') });
    await expect(runDestroyForStack('TestStack', state(), makeCtx())).rejects.toThrow(
      /cdkd destroy of .* refused/
    );
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockProviderDelete).not.toHaveBeenCalled();
    // The settle's lock is released even on the refusal.
    expect(order).toEqual(['lock', 'release']);
  });

  it('a request journaled after the settle, before the destroy lock, refuses the sweep', async () => {
    const ctx = makeCtx();
    const load = ctx.stateBackend.loadRollbackJournal as unknown as ReturnType<typeof vi.fn>;
    // The entry read sees nothing pending; a deploy failing since journaled one.
    load.mockImplementationOnce(async () => null);
    await expect(runDestroyForStack('TestStack', state(), ctx)).rejects.toThrow(
      /now records a Cloud Control CREATE a failed deploy stopped waiting for/
    );
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it("the main destroy's re-read under its lock refuses a request journaled since, deleting nothing", async () => {
    const ctx = makeCtx();
    const load = ctx.stateBackend.loadRollbackJournal as unknown as ReturnType<typeof vi.fn>;
    load.mockImplementationOnce(async () => null);
    const withResource: StackState = {
      ...state(),
      resources: {
        R: {
          physicalId: 'phys-r',
          resourceType: 'AWS::SSM::Parameter',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };
    await expect(runDestroyForStack('TestStack', withResource, ctx)).rejects.toThrow(
      /now records a Cloud Control CREATE a failed deploy stopped waiting for/
    );
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('a record whose body names another region refuses rather than read the request in the wrong one', async () => {
    await expect(
      runDestroyForStack('TestStack', state(), { ...makeCtx(), divergentBodyRegion: 'eu-west-1' })
    ).rejects.toThrow(/cannot tell which region to check it in[\s\S]*--drop-failed Group/);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it("a cross-region stack's request is read with that region's clients", async () => {
    resumeSpy.mockResolvedValue({ status: 'failed' });
    constructedInRegion.length = 0;
    const crossRegion = { ...state(), region: 'eu-west-1' };
    await runDestroyForStack('TestStack', crossRegion, makeCtx()).catch(() => undefined);
    expect(resumeSpy).toHaveBeenCalled();
    expect(constructedInRegion).toEqual(['eu-west-1']);
  });

  it('a create that made nothing leaves an empty stack, cleaned up as before', async () => {
    resumeSpy.mockResolvedValue({ status: 'failed' });
    await runDestroyForStack('TestStack', state(), makeCtx());
    expect(mockProviderDelete).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledOnce();
  });
});
