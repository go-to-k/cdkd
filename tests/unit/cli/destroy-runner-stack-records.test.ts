import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
import { getStackRecords, withStackRecords } from '../../../src/deployment/stack-records-scope.js';

/**
 * go-to-k/cdkd#4492: a destroy deletes every record, so only a RETAINED one
 * outlives it — a resource the destroyed records share with it stays.
 */
describe('runDestroyForStack binds the stack records around each delete (#4492)', () => {
  const rule = (deletionPolicy?: ResourceState['deletionPolicy']): ResourceState =>
    ({
      physicalId: 'sg-1|tcp|3306|3306',
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      properties: {},
      attributes: {},
      dependencies: [],
      ...(deletionPolicy && { deletionPolicy }),
    }) as ResourceState;

  it('every delete sees only the retained records as survivors, never an outer binding', async () => {
    const seen: Array<{ live: string[]; survivors: string[] } | undefined> = [];
    const del = vi.fn(async () => {
      const view = getStackRecords();
      seen.push(
        view && {
          live: [...view.live()].map(([id]) => id).sort(),
          survivors: [...view.survivors()].map(([id]) => id).sort(),
        }
      );
    });
    const state: StackState = {
      version: 10,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { A: rule(), B: rule(), Kept: rule('Retain') },
      outputs: {},
      lastModified: 1,
    } as unknown as StackState;
    const ctx = {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: del } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: 'us-east-1',
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };

    // A parent deploy's binding (a nested child destroyed from a deploy) must
    // not reach the child's deletes.
    const outer = { live: () => [['Parent', rule()] as const], survivors: () => [['Parent', rule()] as const] };
    const result = await withStackRecords(outer, () => runDestroyForStack('TestStack', state, ctx));

    expect(result.errorCount).toBe(0);
    expect(del).toHaveBeenCalledTimes(2);
    for (const view of seen) {
      expect(view?.survivors).toEqual(['Kept']);
      expect(view?.live).toContain('Kept');
      expect(view?.live).not.toContain('Parent');
    }
  });
});
