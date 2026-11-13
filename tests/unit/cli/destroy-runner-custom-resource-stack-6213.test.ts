import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#6213: a destroy binds no naming scope, so the `--aws-emulator`
// custom-resource runtime reads the stack being destroyed from
// `withCustomResourceStack`. Without it, a custom resource whose logical id and
// code also exist in another stack resolved that other stack's template entry.

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
import { customResourceStackName } from '../../../src/local/custom-resource-runtime-gate.js';

describe('runDestroyForStack binds the stack for the custom-resource runtime (#6213)', () => {
  it("a provider's delete sees the stack being destroyed", async () => {
    const seen: Array<string | undefined> = [];
    const state: StackState = {
      version: 15,
      stackName: 'MineStack',
      region: 'us-east-1',
      resources: {
        Cr: {
          physicalId: 'phys',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 1,
    };
    const result = await runDestroyForStack('MineStack', state, {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn(async () => ({ state, etag: 'e' })),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({
          provider: {
            delete: vi.fn(async () => {
              seen.push(customResourceStackName());
              return undefined;
            }),
          },
        }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: 'us-east-1',
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as never);

    expect(result.deletedCount).toBe(1);
    expect(seen).toEqual(['MineStack']);
    // Bound for the destroy only.
    expect(customResourceStackName()).toBeUndefined();
  });
});
