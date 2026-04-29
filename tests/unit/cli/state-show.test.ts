import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LockInfo, ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => {
  return {
    AwsClients: vi.fn().mockImplementation(() => ({
      get s3() {
        return {};
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    getAwsClients: vi.fn(),
  };
});

const mockGetState = vi.fn<(stackName: string) => Promise<{ state: StackState } | null>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockGetLockInfo = vi.fn<(stackName: string) => Promise<LockInfo | null>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    getLockInfo: mockGetLockInfo,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runStateShow(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: overrides.physicalId ?? 'phys-id',
    resourceType: overrides.resourceType ?? 'AWS::S3::Bucket',
    properties: overrides.properties ?? {},
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
  };
}

function makeState(overrides: Partial<StackState> = {}): { state: StackState } {
  return {
    state: {
      version: overrides.version ?? 1,
      stackName: overrides.stackName ?? 'TestStack',
      ...(overrides.region !== undefined && { region: overrides.region }),
      resources: overrides.resources ?? {},
      outputs: overrides.outputs ?? {},
      lastModified: overrides.lastModified ?? Date.UTC(2026, 3, 29, 10, 23, 45),
    },
  };
}

describe('cdkd state show', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockGetLockInfo.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    errorSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('reports a clear error when the stack has no state', async () => {
    mockGetState.mockResolvedValue(null);
    mockGetLockInfo.mockResolvedValue(null);

    await expect(runStateShow(['show', 'Missing'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack 'Missing'/);
  });

  it('renders stack header, lock status, outputs, and resources', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        stackName: 'MyStack',
        region: 'us-east-1',
        outputs: { ApiUrl: 'https://api.example.com' },
        resources: {
          MyBucket: makeResource({
            resourceType: 'AWS::S3::Bucket',
            physicalId: 'my-bucket-abc',
            properties: { BucketName: 'my-bucket-abc' },
            attributes: { Arn: 'arn:aws:s3:::my-bucket-abc' },
          }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'MyStack']);

    expect(out).toContain('Stack: MyStack');
    expect(out).toContain('  Region: us-east-1');
    expect(out).toContain('  Version: 1');
    expect(out).toContain('  Last Modified: 2026-04-29T10:23:45.000Z');
    expect(out).toContain('  Lock: unlocked');
    expect(out).toContain('Outputs:');
    expect(out).toContain('  ApiUrl: https://api.example.com');
    expect(out).toContain('Resources (1):');
    expect(out).toContain('MyBucket');
    expect(out).toContain('  Type: AWS::S3::Bucket');
    expect(out).toContain('  PhysicalID: my-bucket-abc');
    expect(out).toContain('  Properties:');
    expect(out).toContain('    BucketName: my-bucket-abc');
    expect(out).toContain('  Attributes:');
    expect(out).toContain('    Arn: arn:aws:s3:::my-bucket-abc');
  });

  it('renders a locked stack with owner / operation / expiry detail', async () => {
    mockGetState.mockResolvedValue(makeState({ stackName: 'MyStack' }));
    mockGetLockInfo.mockResolvedValue({
      owner: 'alice@workstation:1234',
      operation: 'deploy',
      timestamp: Date.now() - 60_000,
      expiresAt: Date.now() + 600_000, // 10 minutes from now
    });

    const out = await runStateShow(['show', 'MyStack']);

    expect(out).toMatch(/Lock: locked by alice@workstation:1234 \(operation: deploy\), expires in /);
  });

  it('renders an expired lock when expiresAt is in the past', async () => {
    mockGetState.mockResolvedValue(makeState({ stackName: 'MyStack' }));
    mockGetLockInfo.mockResolvedValue({
      owner: 'bob@host:5678',
      timestamp: Date.now() - 7_200_000,
      expiresAt: Date.now() - 30_000, // 30 seconds ago
    });

    const out = await runStateShow(['show', 'MyStack']);

    expect(out).toMatch(/Lock: locked by bob@host:5678, expired \d+s ago/);
  });

  it('reports `(none)` for resources with no attributes / no properties', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        resources: {
          Bare: makeResource({ resourceType: 'AWS::SQS::Queue', physicalId: 'q-1' }),
        },
      })
    );
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'AnyStack']);

    expect(out).toContain('  Properties: (none)');
    expect(out).toContain('  Attributes: (none)');
    expect(out).toContain('  Dependencies: (none)');
  });

  it('omits the Outputs section when outputs are empty', async () => {
    mockGetState.mockResolvedValue(makeState({ outputs: {} }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'AnyStack']);

    expect(out).not.toContain('Outputs:');
  });

  it('emits a `{state, lock}` JSON object with --json', async () => {
    const stateRecord = makeState({
      stackName: 'JsonStack',
      region: 'us-west-2',
      outputs: { Endpoint: 'http://x' },
      resources: {
        R1: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'r-1' }),
      },
    });
    const lockRecord: LockInfo = {
      owner: 'ci@runner:9999',
      operation: 'destroy',
      timestamp: 100,
      expiresAt: 200,
    };
    mockGetState.mockResolvedValue(stateRecord);
    mockGetLockInfo.mockResolvedValue(lockRecord);

    const out = await runStateShow(['show', 'JsonStack', '--json']);
    const parsed = JSON.parse(out);

    expect(parsed.state.stackName).toBe('JsonStack');
    expect(parsed.state.region).toBe('us-west-2');
    expect(parsed.state.outputs).toEqual({ Endpoint: 'http://x' });
    expect(parsed.state.resources.R1.physicalId).toBe('r-1');
    expect(parsed.lock).toEqual(lockRecord);
  });

  it('emits `lock: null` in JSON when the stack is unlocked', async () => {
    mockGetState.mockResolvedValue(makeState({ stackName: 'UnlockedStack' }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'UnlockedStack', '--json']);
    const parsed = JSON.parse(out);

    expect(parsed.lock).toBeNull();
  });
});
