import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * go-to-k/cdkd#6705: `runDestroyForStack` deletes the stack's CloudFormation
 * signal receiver, only when state records one, only on the path that deletes
 * the state record, and BEFORE `deleteState`.
 */
const logs = vi.hoisted(() => ({
  setLevel: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...logs, child: () => logs }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({ ProviderRegistry: vi.fn() }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../../../src/deployment/deploy-engine/signal-receiver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/deploy-engine/signal-receiver.js')>();
  return {
    ...actual,
    deleteSignalReceiver: vi.fn(() => {
      calls.order.push('deleteSignalReceiver');
      return Promise.resolve();
    }),
  };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { deleteSignalReceiver } from '../../../src/deployment/deploy-engine/signal-receiver.js';

const REGION = 'us-east-1';
const RECEIVER = 'arn:aws:cloudformation:us-east-1:123456789012:stack/rcv/abc';

function makeState(withReceiver: boolean): StackState {
  const resource: ResourceState = {
    physicalId: 'phys-id',
    resourceType: 'AWS::SNS::Topic',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 16,
    stackName: 'TestStack',
    region: REGION,
    resources: { Topic: resource },
    outputs: {},
    lastModified: 1,
    ...(withReceiver && { signalReceiverStackId: RECEIVER }),
  };
}

function makeCtx(state: StackState, providerDelete: ReturnType<typeof vi.fn>) {
  const deleteState = vi.fn(() => {
    calls.order.push('deleteState');
    return Promise.resolve(undefined);
  });
  const cloudFormation = { marker: 'cfn-client' };
  return {
    deleteState,
    cloudFormation,
    ctx: {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState,
        getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: providerDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: { cloudFormation } as unknown as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    },
  };
}

describe('runDestroyForStack and the signal receiver (go-to-k/cdkd#6705)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.order.length = 0;
  });

  it('deletes the recorded receiver BEFORE the state record', async () => {
    const state = makeState(true);
    const { ctx, deleteState, cloudFormation } = makeCtx(state, vi.fn().mockResolvedValue(undefined));
    const result = await runDestroyForStack('TestStack', state, ctx);
    expect(result.errorCount).toBe(0);
    expect(deleteState).toHaveBeenCalledTimes(1);
    expect(deleteSignalReceiver).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteSignalReceiver).mock.calls[0]![0]).toBe(cloudFormation);
    expect(vi.mocked(deleteSignalReceiver).mock.calls[0]![1]).toBe(RECEIVER);
    expect(calls.order).toEqual(['deleteSignalReceiver', 'deleteState']);
  });

  it('a state recording no receiver deletes none', async () => {
    const state = makeState(false);
    const { ctx, deleteState } = makeCtx(state, vi.fn().mockResolvedValue(undefined));
    await runDestroyForStack('TestStack', state, ctx);
    expect(deleteState).toHaveBeenCalledTimes(1);
    expect(deleteSignalReceiver).not.toHaveBeenCalled();
  });

  it('a destroy that preserves the state keeps the receiver', async () => {
    const state = makeState(true);
    const { ctx, deleteState } = makeCtx(state, vi.fn().mockRejectedValue(new Error('delete blew up')));
    const result = await runDestroyForStack('TestStack', state, ctx);
    expect(result.errorCount).toBe(1);
    expect(deleteState).not.toHaveBeenCalled();
    expect(deleteSignalReceiver).not.toHaveBeenCalled();
  });
});
