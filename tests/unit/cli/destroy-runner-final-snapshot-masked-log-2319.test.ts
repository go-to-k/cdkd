import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * go-to-k/cdkd#2319: `cdkd destroy` hands the pre-delete final snapshot a
 * logger routed through the delete's masker (its printing bag), so the
 * helper's debug line -- which quotes a withheld AWS failure's text -- masks a
 * name derived from a secret like the delete's own lines do.
 */

const { runnerDebug, runnerInfo, snapshot } = vi.hoisted(() => ({
  runnerDebug: vi.fn(),
  runnerInfo: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: runnerDebug,
    info: runnerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPreDeleteFinalSnapshot: snapshot,
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
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
const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER_ID = 'team-secret-user';
let lastMadeState: StackState | undefined;

function makeState(userName: string): StackState {
  const user: ResourceState = {
    physicalId: USER_ID,
    resourceType: 'AWS::IAM::User',
    properties: { UserName: userName },
    attributes: {},
    dependencies: [],
  };
  const vol: ResourceState = {
    physicalId: 'vol-1',
    resourceType: 'AWS::EC2::Volume',
    properties: { Tags: [{ Key: 'owner', Value: USER_ID }] },
    attributes: {},
    dependencies: ['User'],
    deletionPolicy: 'Snapshot',
  };
  const state: StackState = {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { User: user, Vol: vol },
    outputs: {},
    lastModified: 1,
  };
  lastMadeState = state;
  return state;
}

function makeCtx(providerDelete: ReturnType<typeof vi.fn>) {
  return {
    stateBackend: {
      saveState: vi.fn().mockResolvedValue('"etag"'),
      deleteState: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn(async () =>
        lastMadeState ? { state: lastMadeState, etag: 'e' } : null
      ),
      listStacks: vi.fn().mockResolvedValue([]),
    } as unknown as S3StateBackend,
    lockManager: {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
    } as unknown as LockManager,
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: providerDelete } }),
    } as unknown as ProviderRegistry,
    baseAwsClients: {} as AwsClients,
    baseRegion: REGION,
    stateBucket: 'test-bucket',
    skipConfirmation: true,
  };
}

async function snapshotLines(userName: string): Promise<string[]> {
  runnerDebug.mockReset();
  runnerInfo.mockReset();
  snapshot.mockReset();
  snapshot.mockImplementation(
    async (
      _t: string,
      _p: string,
      _l: string,
      _c: unknown,
      log: { debug(m: string): void; info(m: string): void }
    ) => {
      log.debug(`Failed to create the final snapshot for Vol (vol-1): AccessDenied on ${USER_ID}`);
      log.info(`Final snapshot snap-1 completed for Vol (vol-1) of ${USER_ID}`);
      return 'snap-1';
    }
  );
  const result = await runDestroyForStack(
    'TestStack',
    makeState(userName),
    makeCtx(vi.fn().mockResolvedValue(undefined))
  );
  expect(result.errorCount).toBe(0);
  expect(snapshot).toHaveBeenCalledTimes(1);
  return [...runnerDebug.mock.calls, ...runnerInfo.mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.includes('final snapshot') || l.includes('Final snapshot'));
}

describe("cdkd destroy masks the final snapshot's debug line (go-to-k/cdkd#2319)", () => {
  it('masks a name derived from a secret through the delete masker', async () => {
    expect(await snapshotLines(REF)).toEqual([
      'Failed to create the final snapshot for Vol (vol-1): AccessDenied on ***',
      'Final snapshot snap-1 completed for Vol (vol-1) of ***',
    ]);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    expect(await snapshotLines('plain-user')).toEqual([
      `Failed to create the final snapshot for Vol (vol-1): AccessDenied on ${USER_ID}`,
      `Final snapshot snap-1 completed for Vol (vol-1) of ${USER_ID}`,
    ]);
  });
});
