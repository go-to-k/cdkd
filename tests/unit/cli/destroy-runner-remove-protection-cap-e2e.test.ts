import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issue #4318, end to end: the REAL destroy loop driving the REAL
 * `AWS::Logs::LogGroup` provider. Every `DeleteLogGroup` is refused with an
 * IAM deny worded `not authorized to perform`, which the classifier calls
 * retryable, so only the loop's attempt cap ends the sequence. The guard
 * `--remove-protection` turned off must be written back ON exactly once, and
 * only after the LAST attempt's delete.
 */

const logsSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    cloudWatchLogs: { send: logsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => make(),
  });
  return { getLogger: () => make() };
});

// The runner only builds its own registry on the cross-region path, which
// this case never takes.
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
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
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const REGION = 'us-east-1';
const LG = '/aws/lambda/lg-4318';

function makeState(): StackState {
  const resource: ResourceState = {
    physicalId: LG,
    resourceType: 'AWS::Logs::LogGroup',
    properties: { LogGroupName: LG },
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { LogGroup: resource },
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack + LogsLogGroupProvider: compensation at the attempt cap (issue #4318)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the guard back ON exactly once, after the LAST of the 4 refused deletes', async () => {
    // The fake service's guard: ON until a landed flip-off turns it off.
    let guardOn = true;
    // One entry per command, in order, so "after the last delete" is checkable.
    const timeline: string[] = [];
    logsSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeLogGroupsCommand') {
        timeline.push('describe');
        return { logGroups: [{ logGroupName: LG, deletionProtectionEnabled: guardOn }] };
      }
      if (name === 'PutLogGroupDeletionProtectionCommand') {
        const on = cmd.input['deletionProtectionEnabled'] === true;
        timeline.push(on ? 'protect-on' : 'protect-off');
        guardOn = on;
        return {};
      }
      if (name === 'DeleteLogGroupCommand') {
        timeline.push('delete');
        throw Object.assign(
          new Error(
            'User: arn:aws:iam::123456789012:user/ci is not authorized to perform: logs:DeleteLogGroup with an explicit deny'
          ),
          { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } }
        );
      }
      throw new Error(`unexpected command ${name}`);
    });

    const provider = new LogsLogGroupProvider();
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
        getProviderFor: () => ({ provider }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      removeProtection: true,
    };

    vi.useFakeTimers();
    const pending = runDestroyForStack('TestStack', makeState(), ctx);
    for (const delay of [5_000, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    const result = await pending;

    expect(result.errorCount).toBe(1);
    const deletes = timeline.filter((e) => e === 'delete');
    expect(deletes).toHaveLength(4);
    // Exactly one protection-on write, and it follows the FOURTH delete: none
    // after attempts 1-3, where a retry is still coming.
    expect(timeline.filter((e) => e === 'protect-on')).toHaveLength(1);
    expect(timeline.lastIndexOf('protect-on')).toBeGreaterThan(timeline.lastIndexOf('delete'));
    expect(timeline.at(-1)).toBe('protect-on');
    expect(guardOn).toBe(true);
  });
});
