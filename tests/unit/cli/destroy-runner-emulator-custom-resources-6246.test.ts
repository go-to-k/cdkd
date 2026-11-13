import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#6246: under `--aws-emulator`, a destroy that read no CDK app
// would run its custom resources' Delete handlers in AWS Emulator's own
// runtime (which fails CDK's providers) and then delete the handler functions,
// so the advised `cdkd destroy` from the app could no longer run them. It is
// refused before the prompt and before anything is deleted.

vi.mock('../../../src/utils/logger.js', () => {
  const leaf = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => leaf,
  };
  return { getLogger: () => leaf };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
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
const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));
const assembly = vi.hoisted(() => ({ stacks: [] as unknown[] }));
vi.mock('../../../src/synthesis/synthesized-stacks.js', () => ({
  synthesizedStacks: () => assembly.stacks,
}));

const { runDestroyForStack } = await import('../../../src/cli/commands/destroy-runner.js');
const { setLocalCustomResourceRuntimeEnabled } =
  await import('../../../src/local/custom-resource-runtime-gate.js');
const { customResourcesWithoutAppMessage } =
  await import('../../../src/cli/commands/destroy-runner/emulator-custom-resources.js');
const { CdkdError } = await import('../../../src/utils/error-handler.js');

const row = (resourceType: string) => ({
  physicalId: 'phys',
  resourceType,
  properties: { ServiceToken: 'arn:aws:lambda:us-east-1:000000000000:function:h' },
  attributes: {},
  dependencies: [],
});

function stateWith(resources: Record<string, ReturnType<typeof row>>): StackState {
  return {
    version: 15,
    stackName: 'MineStack',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 1,
  } as StackState;
}

const deleted: string[] = [];

function run(state: StackState) {
  return runDestroyForStack('MineStack', state, {
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
          delete: vi.fn(async (logicalId: string) => {
            deleted.push(logicalId);
            return undefined;
          }),
        },
      }),
    } as unknown as ProviderRegistry,
    baseAwsClients: {} as AwsClients,
    baseRegion: 'us-east-1',
    stateBucket: 'test-bucket',
    // `--yes`: the refusal does not depend on the prompt.
    skipConfirmation: true,
  } as never);
}

const withCr = () =>
  stateWith({
    PutParam: row('Custom::AWS'),
    MyRes: row('AWS::CloudFormation::CustomResource'),
    Handler: row('AWS::Lambda::Function'),
  });

beforeEach(() => {
  deleted.length = 0;
  wiring.value = { mode: 'emulator' };
  assembly.stacks = [];
  setLocalCustomResourceRuntimeEnabled(true, 'state destroy');
});

describe('destroy under --aws-emulator without the app refuses custom resources up front (#6246)', () => {
  it.each(['state destroy', 'destroy'])('%s: refused before anything is deleted', async (command) => {
    setLocalCustomResourceRuntimeEnabled(true, command);
    const err = await run(withCr()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CdkdError);
    const message = (err as Error).message;
    expect(message).toContain('custom resources (PutParam, MyRes)');
    expect(message).toContain('Nothing was deleted.');
    expect(message).toContain('--no-local-custom-resources');
    expect(message.trimEnd().split('\n').at(-1)).toBe(
      "Run from the app's directory: cdkd destroy MineStack"
    );
    expect(deleted).toEqual([]);
  });

  it('proceeds with --no-local-custom-resources (the emulator runtime accepted)', async () => {
    setLocalCustomResourceRuntimeEnabled(false, 'state destroy');
    const result = await run(withCr());
    expect(result.deletedCount).toBe(3);
  });

  it('proceeds when the app was synthesized (the handlers run locally)', async () => {
    assembly.stacks = [{ stackName: 'MineStack' }];
    const result = await run(withCr());
    expect(result.deletedCount).toBe(3);
  });

  it('proceeds off the emulator', async () => {
    wiring.value = undefined;
    const result = await run(withCr());
    expect(result.deletedCount).toBe(3);
  });

  it('proceeds with no custom resources in the record', async () => {
    const result = await run(stateWith({ Handler: row('AWS::Lambda::Function') }));
    expect(result.deletedCount).toBe(1);
  });

  it("not under rollback (a nested child's removal there has its own remedy)", async () => {
    setLocalCustomResourceRuntimeEnabled(true, 'rollback');
    const result = await run(withCr());
    expect(result.deletedCount).toBe(3);
  });
});

describe('customResourcesWithoutAppMessage', () => {
  it('names five custom resources and counts the rest', () => {
    const message = customResourcesWithoutAppMessage('S', ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(message).toContain('(A, B, C, D, E and 2 more)');
  });

  it('a stack name that is not a plain identifier is a hole, explained', () => {
    const message = customResourcesWithoutAppMessage('$(rm -rf x)', ['A']);
    expect(message).not.toContain('$(rm');
    expect(message).toContain('a stack name that is not a plain identifier');
    expect(message.trimEnd().split('\n').at(-1)).toBe(
      "Run from the app's directory: cdkd destroy '<stack>'"
    );
  });
});
