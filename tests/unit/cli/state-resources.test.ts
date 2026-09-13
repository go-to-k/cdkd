import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  // Issue #2280: the commands under test call this under --json; the mock
  // must export it or the import is `undefined` and the call throws.
  reserveStdoutForPayload: vi.fn(),
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
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
  };
}

/**
 * Default `listStacks` response used by every `state resources` test.
 *
 * The new flow disambiguates the stack name via `listStacks` before reading
 * state, so every test needs the stack to appear at least once. Tests that
 * exercise the missing-state path mock `listStacks` to return an empty list
 * explicitly.
 */
function defaultListResponse(stackName = 'TestStack', region = 'us-east-1') {
  return [{ stackName, region }];
}

describe('cdkd state resources', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
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

  it('reports a clear error message when the stack has no state', async () => {
    // listStacks: stack does not appear → resolveSingleRegion throws with the
    // "No state found" error before we even get to getState.
    mockListStacks.mockResolvedValue([]);
    mockGetState.mockResolvedValue(null);

    await expect(runStateResources(['resources', 'Missing'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack 'Missing'/);
  });

  it('errors when the stack has multiple regions and --stack-region is missing', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-west-2' },
      { stackName: 'MyStack', region: 'us-east-1' },
    ]);

    await expect(runStateResources(['resources', 'MyStack'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/multiple regions: us-west-2, us-east-1/);
    // The error must direct users to --stack-region, NOT the deprecated
    // top-level --region (which is ignored on this command and would emit
    // its own deprecation warning, causing the very confusion this regex
    // guards against).
    expect(message).toMatch(/--stack-region/);
    expect(message).not.toMatch(/--region\b(?!-)/);
  });

  it('disambiguates with --stack-region when a stack has multiple regions', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-west-2' },
      { stackName: 'MyStack', region: 'us-east-1' },
    ]);
    mockGetState.mockResolvedValue(makeState({}));
    await runStateResources(['resources', 'MyStack', '--stack-region', 'us-east-1']);
    expect(mockGetState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('emits nothing when the stack has zero resources (default)', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('Empty'));
    mockGetState.mockResolvedValue(makeState({}));
    const out = await runStateResources(['resources', 'Empty']);
    expect(out).toBe('');
  });

  it('emits an empty JSON array when --json is set on a zero-resource stack', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('Empty'));
    mockGetState.mockResolvedValue(makeState({}));
    const out = await runStateResources(['resources', 'Empty', '--json']);
    expect(JSON.parse(out)).toEqual([]);
  });

  it('prints aligned columns sorted by logical id by default', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
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

  it('STRIPS control characters in the DEFAULT columns and still aligns them', async () => {
    // The default branch measures its own column widths, so stripping has to
    // happen before the measurement: pad the stripped value to a width counted
    // from the raw one and every column after it shifts by the characters that
    // were removed.
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        'Evil\u001b[31mId': makeResource({
          // The longer of the two types, and control-bearing: measuring the raw
          // type width, or dropping this column's guard, changes this row.
          resourceType: 'AWS::S3::Buck\u001bet',
          physicalId: 'evil\u001b[1mbucket',
        }),
        Plain: makeResource({ resourceType: 'AWS::IAM::Role', physicalId: 'plain-role' }),
      })
    );

    const out = await runStateResources(['resources', 'StackA']);
    const lines = out.trimEnd().split('\n');

    // The ESC byte goes; the `[31m` it introduced is ordinary text and stays.
    // Breaking the sequence is the point, not sanitising the name.
    expect(out).not.toContain('\u001b');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Evil[31mId  AWS::S3::Bucket  evil[1mbucket');
    expect(lines[1]).toBe('Plain       AWS::IAM::Role   plain-role');
    // Measuring the RAW ids instead keeps the rows ALIGNED — both pad to the
    // same width — and widens every column by the difference between the two
    // MAXIMA, which is the byte removed from the longest id here. The
    // exact-equality assertions above catch that; this one cannot.
    expect(lines[0]!.indexOf('AWS::S3::Bucket')).toBe(lines[1]!.indexOf('AWS::IAM::Role'));
  });

  it('renders a non-string physicalId and resourceType in the DEFAULT columns', async () => {
    // Raw, `.padEnd` on a non-string type throws and empties the whole listing.
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        Odd: makeResource({
          resourceType: 4242 as unknown as string,
          // Not `null`: `makeResource` coalesces that to its default.
          physicalId: 0 as unknown as string,
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA']);

    expect(out.trimEnd()).toBe('Odd  4242  0');
  });

  it('emits a long human-readable block per resource with --long', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
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
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        Bare: makeResource({ resourceType: 'AWS::S3::Bucket', physicalId: 'bare-bucket' }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('  Dependencies: (none)');
    expect(out).toContain('  Attributes: (none)');
  });

  it('renders a non-string physicalId under --long instead of dying', async () => {
    // `stripControlChars` threw on a hand-edited number, and because the rows
    // are built before anything is written the whole listing was lost.
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        R1: makeResource({
          resourceType: 'AWS::SNS::Topic',
          physicalId: 4242 as unknown as string,
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('  PhysicalID: 4242');
    expect(out).toContain('R1');
  });

  it('renders a bare-string `dependencies` under --long rather than dying', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        Odd: makeResource({
          physicalId: 'p-1',
          dependencies: 'A\nFake: 1' as unknown as string[],
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('  Dependencies: AFake: 1');
    expect(out.split('\n').filter((l) => l.startsWith('Fake: 1'))).toEqual([]);
  });

  it('renders a `dependencies` ELEMENT that throws on coercion under --long', async () => {
    // The elements are rendered one at a time, so this never reaches `join` —
    // joining first and guarding the result cannot catch it.
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        Odd: makeResource({
          physicalId: 'p-1',
          dependencies: [{ toString: null }] as unknown as string[],
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('  Dependencies: {"toString":null}');
  });

  it('renders a non-string resourceType under --long instead of dying', async () => {
    // The bare strip throws on it and the listing comes out empty.
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        Odd: makeResource({ resourceType: 4242 as unknown as string, physicalId: 'p-1' }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).toContain('  Type: 4242');
    expect(out).toContain('  PhysicalID: p-1');
  });

  it('STRIPS control characters from every row it renders under --long', async () => {
    // These lines are joined with a newline, and the strip removes newline
    // too, so an unstripped field forges rows rather than only colouring them.
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
    mockGetState.mockResolvedValue(
      makeState({
        'My\u001bTable': makeResource({
          resourceType: 'AWS::Dynamo\u001bDB::Table',
          physicalId: 'tbl\u001b-1',
          dependencies: ['Dep\u001bOne', 'Dep\nTwo'],
          attributes: { 'Arn\u001bKey': 'arn\u001bvalue' },
        }),
      })
    );

    const out = await runStateResources(['resources', 'StackA', '--long']);

    expect(out).not.toContain('\u001b');
    expect(out.split('\n')).toContain('MyTable');
    expect(out).toContain('  Type: AWS::DynamoDB::Table');
    expect(out).toContain('  PhysicalID: tbl-1');
    // The newline inside a dependency must NOT have produced an extra row.
    expect(out).toContain('  Dependencies: DepOne, DepTwo');
    // Key and value take different guards, so the row needs both to be right.
    expect(out).toContain('    ArnKey: arnvalue');
  });

  it('renders structured attribute values as inline JSON under --long', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
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

  it('sanitizes its OWN no-state refusal, a separate template from state show\'s (issue #3003)', async () => {
    // `stateResourcesCommand` carries its own copies of the two refusals
    // `stateShowCommand` has. Driving only the `show` copies left these
    // untested -- the "N of N+1 sites" shape issue #3003 exists to close,
    // reappearing inside its own fix.
    const hostile = 'us-east-1\n  PhysicalID: arn:forged';
    mockListStacks.mockResolvedValue([{ stackName: 'GhostStack', region: hostile }]);
    mockGetState.mockResolvedValue(null);

    await runStateResources(['resources', 'GhostStack']).catch(() => undefined);
    const message = errorSpy.mock.calls.map(String).join('\n');

    expect(message).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(message.split('\n').some((l) => l.startsWith('  PhysicalID:'))).toBe(false);
    expect(message).toContain('PhysicalID: arn:forged');
  });

  it('sanitizes its OWN legacy-record refusal (issue #3003)', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'Ghost\n  PhysicalID: arn:forged', region: undefined },
    ]);

    await runStateResources(['resources', 'Ghost\n  PhysicalID: arn:forged']).catch(
      () => undefined
    );
    const message = errorSpy.mock.calls.map(String).join('\n');

    expect(message).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(message.split('\n').some((l) => l.startsWith('  PhysicalID:'))).toBe(false);
    expect(message).toContain('only a legacy state record');
    expect(message).toContain('PhysicalID: arn:forged');
  });

  it('emits a JSON array of full resource details with --json', async () => {
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
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
    mockListStacks.mockResolvedValue(defaultListResponse('StackA'));
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
