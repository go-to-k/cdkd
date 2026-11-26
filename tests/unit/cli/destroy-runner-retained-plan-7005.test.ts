import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#7005: `cdkd destroy`'s plan listed a record its
// `DeletionPolicy` keeps under "Resources to be deleted", although the delete
// loop retains it. It is now listed apart, with its policy.

const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
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

const readlineQuestion = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: readlineQuestion, close: vi.fn() }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';

const res = (deletionPolicy?: ResourceState['deletionPolicy']): ResourceState => ({
  physicalId: 'phys-id',
  resourceType: 'AWS::SQS::Queue',
  properties: {},
  attributes: {},
  dependencies: [],
  ...(deletionPolicy !== undefined && { deletionPolicy }),
});

describe('cdkd destroy plan: retained records are listed apart (#7005)', () => {
  const providerDelete = vi.fn();
  let state: StackState;

  function ctx() {
    return {
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
        getProviderFor: () => ({ provider: { delete: providerDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      eventRecorder: { record: vi.fn(), finalize: vi.fn() },
    };
  }

  // eslint-disable-next-line no-control-regex
  const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = (): string[] =>
    infoSpy.mock.calls.flatMap((c) => strip(String(c[0])).split('\n'));

  beforeEach(() => {
    infoSpy.mockReset();
    providerDelete.mockReset().mockResolvedValue(undefined);
    state = {
      version: 8,
      stackName: 'TestStack',
      region: REGION,
      resources: {
        QDel: res('Delete'),
        QNone: res(),
        QRet: res('Retain'),
        QRou: res('RetainExceptOnCreate'),
      },
      outputs: {},
      lastModified: 1,
    };
  });

  it('counts only the deleted records under "to be deleted" and names the kept ones', async () => {
    const result = await runDestroyForStack('TestStack', state, ctx());
    const out = lines();
    const del = out.indexOf('Resources to be deleted (2):');
    const keep = out.indexOf('Resources kept in AWS by their DeletionPolicy (2):');
    expect(del).toBeGreaterThanOrEqual(0);
    expect(keep).toBeGreaterThan(del);
    expect(out.slice(del + 1, del + 3)).toEqual([
      '  - QDel (AWS::SQS::Queue)',
      '  - QNone (AWS::SQS::Queue)',
    ]);
    expect(out.slice(keep + 1, keep + 3)).toEqual([
      '  - QRet (AWS::SQS::Queue), DeletionPolicy: Retain',
      '  - QRou (AWS::SQS::Queue), DeletionPolicy: RetainExceptOnCreate',
    ]);
    // The plan matches what the loop then does.
    expect(result.deletedCount).toBe(2);
    expect(result.retainedCount).toBe(2);
  });

  it('counts only the deleted records in the confirmation prompt', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    readlineQuestion.mockReset().mockResolvedValue('y');
    try {
      await runDestroyForStack('TestStack', state, { ...ctx(), skipConfirmation: false });
      expect(String(readlineQuestion.mock.calls[0]![0])).toContain(
        'destroy stack TestStack and delete all 2 resources (2 kept in AWS by their DeletionPolicy)?'
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('prints no kept section when nothing is retained', async () => {
    state.resources = { QDel: res('Delete') };
    await runDestroyForStack('TestStack', state, ctx());
    const out = lines();
    expect(out).toContain('Resources to be deleted (1):');
    expect(out.some((l) => l.startsWith('Resources kept in AWS'))).toBe(false);
  });
});
