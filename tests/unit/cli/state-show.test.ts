import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState } | null>>();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockGetLockInfo =
  vi.fn<(stackName: string, region?: string) => Promise<LockInfo | null>>();
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
      version: overrides.version ?? 2,
      stackName: overrides.stackName ?? 'TestStack',
      region: overrides.region ?? 'us-east-1',
      resources: overrides.resources ?? {},
      outputs: overrides.outputs ?? {},
      lastModified: overrides.lastModified ?? Date.UTC(2026, 3, 29, 10, 23, 45),
      ...(overrides.parentStack !== undefined && { parentStack: overrides.parentStack }),
      ...(overrides.parentLogicalId !== undefined && {
        parentLogicalId: overrides.parentLogicalId,
      }),
      ...(overrides.parentRegion !== undefined && { parentRegion: overrides.parentRegion }),
    },
  };
}

function defaultListResponse(stackName = 'TestStack', region = 'us-east-1') {
  return [{ stackName, region }];
}

describe('cdkd state show', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockGetLockInfo.mockReset();
    mockListStacks.mockReset();
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
    mockListStacks.mockResolvedValue([]);
    mockGetState.mockResolvedValue(null);
    mockGetLockInfo.mockResolvedValue(null);

    await expect(runStateShow(['show', 'Missing'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack 'Missing'/);
  });

  it('errors when the stack has multiple regions and --stack-region is missing', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-west-2' },
      { stackName: 'MyStack', region: 'us-east-1' },
    ]);

    await expect(runStateShow(['show', 'MyStack'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/multiple regions/);
    // Direct users to --stack-region, not the deprecated top-level
    // --region (which would emit a deprecation warning and be ignored).
    expect(message).toMatch(/--stack-region/);
    expect(message).not.toMatch(/--region\b(?!-)/);
  });

  it('renders stack header, lock status, outputs, and resources', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
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
    expect(out).toContain('  Version: 2');
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
    mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
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
    mockListStacks.mockResolvedValue(defaultListResponse('MyStack'));
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
    mockListStacks.mockResolvedValue(defaultListResponse('AnyStack'));
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
    mockListStacks.mockResolvedValue(defaultListResponse('AnyStack'));
    mockGetState.mockResolvedValue(makeState({ outputs: {} }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'AnyStack']);

    expect(out).not.toContain('Outputs:');
  });

  it('emits a `{state, lock}` JSON object with --json', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('JsonStack', 'us-west-2'));
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
    mockListStacks.mockResolvedValue(defaultListResponse('UnlockedStack'));
    mockGetState.mockResolvedValue(makeState({ stackName: 'UnlockedStack' }));
    mockGetLockInfo.mockResolvedValue(null);

    const out = await runStateShow(['show', 'UnlockedStack', '--json']);
    const parsed = JSON.parse(out);

    expect(parsed.lock).toBeNull();
  });

  // #555 A4: recursive child stack rendering.
  describe('--show-nested', () => {
    it('appends a Nested stack block per child in DFS order (3-level deep)', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'NestedStackDeep', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'NestedStackDeep') {
          return makeState({
            stackName: 'NestedStackDeep',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::NestedStackDeep~Child',
              }),
            },
          });
        }
        if (name === 'NestedStackDeep~Child') {
          return makeState({
            stackName: 'NestedStackDeep~Child',
            parentStack: 'NestedStackDeep',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
            resources: {
              Grandchild: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::NestedStackDeep~Child~Grandchild',
              }),
            },
          });
        }
        return makeState({
          stackName: 'NestedStackDeep~Child~Grandchild',
          parentStack: 'NestedStackDeep~Child',
          parentLogicalId: 'Grandchild',
          parentRegion: 'us-east-1',
          resources: {
            Leaf: makeResource({ resourceType: 'AWS::S3::Bucket', physicalId: 'leaf-bkt' }),
          },
        });
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'NestedStackDeep', '--show-nested']);

      // Parent block first.
      expect(out).toContain('Stack: NestedStackDeep');
      // Then each child as its own `Nested stack: <name>` block in DFS order.
      const childIdx = out.indexOf('Nested stack: NestedStackDeep~Child');
      const grandchildIdx = out.indexOf('Nested stack: NestedStackDeep~Child~Grandchild');
      expect(childIdx).toBeGreaterThan(-1);
      expect(grandchildIdx).toBeGreaterThan(childIdx);
      // Each child block carries the v6 parent link.
      expect(out).toContain('  Parent: NestedStackDeep (us-east-1), logical id: Child');
      expect(out).toContain(
        '  Parent: NestedStackDeep~Child (us-east-1), logical id: Grandchild'
      );
      // Grandchild's own resource is rendered too.
      expect(out).toContain('Leaf');
      expect(out).toContain('  Type: AWS::S3::Bucket');
    });

    it('is a no-op on a leaf with no nested children (single-stack output)', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Leaf', region: 'us-east-1' }]);
      mockGetState.mockResolvedValue(
        makeState({
          stackName: 'Leaf',
          resources: { Bkt: makeResource({ resourceType: 'AWS::S3::Bucket' }) },
        })
      );
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Leaf', '--show-nested']);

      expect(out).toContain('Stack: Leaf');
      expect(out).not.toContain('Nested stack:');
    });

    it('shows only the child block when invoked against a child directly (no grandchildren)', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent~Child', region: 'us-east-1' },
      ]);
      mockGetState.mockResolvedValue(
        makeState({
          stackName: 'Parent~Child',
          parentStack: 'Parent',
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
          resources: { Q: makeResource({ resourceType: 'AWS::SQS::Queue' }) },
        })
      );
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Parent~Child', '--show-nested']);

      expect(out).toContain('Stack: Parent~Child');
      expect(out).toContain('  Parent: Parent (us-east-1), logical id: Child');
      expect(out).not.toContain('Nested stack:');
    });

    it('emits a nested {state, lock, children} JSON shape', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Parent', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Parent') {
          return makeState({
            stackName: 'Parent',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::Parent~Child',
              }),
            },
          });
        }
        return makeState({
          stackName: 'Parent~Child',
          parentStack: 'Parent',
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
          resources: { R: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'r-1' }) },
        });
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow(['show', 'Parent', '--show-nested', '--json']);
      const parsed = JSON.parse(out);

      expect(parsed.state.stackName).toBe('Parent');
      expect(parsed.lock).toBeNull();
      expect(parsed.children).toHaveLength(1);
      expect(parsed.children[0].state.stackName).toBe('Parent~Child');
      expect(parsed.children[0].state.parentStack).toBe('Parent');
      expect(parsed.children[0].lock).toBeNull();
      // Stable key set: `children: []` on leaves rather than omitted.
      expect(parsed.children[0].children).toEqual([]);
    });

    it('combines with --stack-region to disambiguate when same name lives in two regions', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'Parent', region: 'us-west-2' },
        { stackName: 'Parent', region: 'us-east-1' },
      ]);
      mockGetState.mockImplementation(async (name, region) => {
        if (name === 'Parent' && region === 'us-east-1') {
          return makeState({
            stackName: 'Parent',
            region: 'us-east-1',
            resources: {
              Child: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::Parent~Child',
              }),
            },
          });
        }
        if (name === 'Parent~Child' && region === 'us-east-1') {
          return makeState({
            stackName: 'Parent~Child',
            region: 'us-east-1',
            parentStack: 'Parent',
            parentLogicalId: 'Child',
            parentRegion: 'us-east-1',
          });
        }
        return null;
      });
      mockGetLockInfo.mockResolvedValue(null);

      const out = await runStateShow([
        'show',
        'Parent',
        '--show-nested',
        '--stack-region',
        'us-east-1',
      ]);

      expect(out).toContain('Stack: Parent');
      expect(out).toContain('  Region: us-east-1');
      expect(out).toContain('Nested stack: Parent~Child');
    });

    it('fails fast on a torn tree (parent lists nested-stack row but child state missing)', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'Parent', region: 'us-east-1' }]);
      mockGetState.mockImplementation(async (name) => {
        if (name === 'Parent') {
          return makeState({
            stackName: 'Parent',
            resources: {
              GhostChild: makeResource({
                resourceType: 'AWS::CloudFormation::Stack',
                physicalId: 'cdkd-local::stack::Parent~GhostChild',
              }),
            },
          });
        }
        return null;
      });
      mockGetLockInfo.mockResolvedValue(null);

      await expect(
        runStateShow(['show', 'Parent', '--show-nested'])
      ).rejects.toThrow();

      const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(/missing nested-child 'Parent~GhostChild'/);
    });
  });
});
