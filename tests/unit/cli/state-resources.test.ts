import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResourceState, StackState } from '../../../src/types/state.js';

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

// LockManager is imported by state.ts but unused for `state resources`.
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn(),
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

async function runStateResources(args: string[]): Promise<string> {
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

function makeState(resources: Record<string, ResourceState>): { state: StackState } {
  return {
    state: {
      version: 1,
      stackName: 'TestStack',
      resources,
      outputs: {},
      lastModified: 0,
    },
  };
}

describe('cdkd state resources', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
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

  it('reports a clear error message when the stack has no state', async () => {
    mockGetState.mockResolvedValue(null);

    await expect(runStateResources(['resources', 'Missing'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack 'Missing'/);
  });

  it('emits nothing when the stack has zero resources (default)', async () => {
    mockGetState.mockResolvedValue(makeState({}));
    const out = await runStateResources(['resources', 'Empty']);
    expect(out).toBe('');
  });

  it('emits an empty JSON array when --json is set on a zero-resource stack', async () => {
    mockGetState.mockResolvedValue(makeState({}));
    const out = await runStateResources(['resources', 'Empty', '--json']);
    expect(JSON.parse(out)).toEqual([]);
  });

  it('prints aligned columns sorted by logical id by default', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        ZebraBucket: makeResource({
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'zebra-bucket',
        }),
        Alpha: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'alpha-role' }),
      })
    );

    const out = await runStateResources(['resources', 'StackA']);
    const lines = out.trimEnd().split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Alpha\s+AWS::IAM::Role\s+alpha-role$/);
    expect(lines[1]).toMatch(/^ZebraBucket\s+AWS::S3::Bucket\s+zebra-bucket$/);

    // Columns must align: the type column starts at the same offset on both lines.
    const typeOffset0 = lines[0]!.indexOf('AWS::IAM::Role');
    const typeOffset1 = lines[1]!.indexOf('AWS::S3::Bucket');
    expect(typeOffset0).toBe(typeOffset1);
  });

  it('emits a long human-readable block per resource with --long', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        MyFunction: makeResource({
          resourceType: 'AWS::Lambda::Function',
          physicalId: 'cdkd-MyFunction-XYZ',
          attributes: {
            Arn: 'arn:aws:lambda:us-east-1:123456789012:function:cdkd-MyFunction-XYZ',
          },
          dependencies: ['MyLambdaRole'],
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('MyFunction');
    expect(out).toContain('  Type: AWS::Lambda::Function');
    expect(out).toContain('  PhysicalID: cdkd-MyFunction-XYZ');
    expect(out).toContain('  Dependencies: MyLambdaRole');
    expect(out).toContain('  Attributes:');
    expect(out).toContain('    Arn: arn:aws:lambda:us-east-1:123456789012:function:cdkd-MyFunction-XYZ');
  });

  it('reports `(none)` for resources with no dependencies / no attributes under --long', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Bare: makeResource({ resourceType: 'AWS::S3::Bucket', physicalId: 'bare-bucket' }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('  Dependencies: (none)');
    expect(out).toContain('  Attributes: (none)');
  });

  it('renders structured attribute values as inline JSON under --long', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Table: makeResource({
          resourceType: 'AWS::DynamoDB::Table',
          physicalId: 'my-table',
          attributes: {
            StreamArn: 'arn:aws:dynamodb:::stream/...',
            Tags: [{ Key: 'env', Value: 'dev' }],
          },
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('    StreamArn: arn:aws:dynamodb:::stream/...');
    expect(out).toContain('    Tags: [{"Key":"env","Value":"dev"}]');
  });

  it('emits a JSON array of full resource details with --json', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Beta: makeResource({
          resourceType: 'AWS::Lambda::Function',
          physicalId: 'cdkd-Beta',
          attributes: { Arn: 'arn:beta' },
          dependencies: ['Alpha'],
        }),
        Alpha: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'cdkd-Alpha' }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--json']);
    const parsed = JSON.parse(out);

    expect(parsed).toEqual([
      {
        logicalId: 'Alpha',
        resourceType: 'AWS::IAM::Role',
        physicalId: 'cdkd-Alpha',
        dependencies: [],
        attributes: {},
      },
      {
        logicalId: 'Beta',
        resourceType: 'AWS::Lambda::Function',
        physicalId: 'cdkd-Beta',
        dependencies: ['Alpha'],
        attributes: { Arn: 'arn:beta' },
      },
    ]);
  });

  it('does not leak `properties` into any output mode', async () => {
    mockGetState.mockResolvedValue(
      makeState({
        Hidden: makeResource({
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'hidden-bucket',
          properties: { BucketName: 'hidden-bucket', Tags: [{ Key: 'secret', Value: 'shh' }] },
        }),
      })
    );

    const defaultOut = await runStateResources(['resources', 'StackA']);
    const longOut = await runStateResources(['resources', 'StackA', '--long']);
    const jsonOut = await runStateResources(['resources', 'StackA', '--json']);

    for (const out of [defaultOut, longOut, jsonOut]) {
      expect(out).not.toContain('secret');
      expect(out).not.toContain('shh');
    }
  });
});
